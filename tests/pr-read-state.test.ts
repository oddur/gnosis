import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrReadStore } from '../src/pr-read-store';
import { createAppDataStore, createMemoryStorage, type StateStorage } from '../src/app-data-store';
import { applyPendingGitHubCacheClear, requestGitHubCacheClear } from '../src/github-cache-reset';
import { DEFAULT_QUEUE_FILTERS, matchesQueueFilters, normalizeQueueFilters } from '../lib/queue-filters';
import { groupSubjects, type ReviewMember } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import { unreadDescription } from '../lib/pr-read-state';

function member(n = 1, overrides: Partial<ReviewMember> = {}): ReviewMember {
  return {
    url: `https://github.com/o/r/pull/${n}`,
    number: n,
    repo: 'o/r',
    baseRepo: 'o/r',
    headRepo: 'o/r',
    role: 'watched',
    title: `PR ${n}`,
    description: '',
    author: 'alice',
    baseBranch: 'main',
    headBranch: `feature-${n}`,
    baseSha: 'base',
    headSha: `head-${n}`,
    merged: false,
    state: 'open',
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
    labels: [],
    isDraft: false,
    mergeable: null,
    commitCount: 1,
    requestedReviewers: [],
    requestedTeams: [],
    mergeableState: null,
    autoMerge: null,
    milestone: null,
    commentCount: 0,
    reviewCommentCount: 0,
    ...overrides,
  };
}
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-read-'));
  let time = Date.parse('2026-10-26T10:00:00Z');
  const saved = new Map<string, string>();
  const store = createPrReadStore(createMemoryStorage(saved), () => time);
  const state = (n = 1) => store.snapshot('me')[member(n).url];
  const mark = (read = true, receipts = [state()]) => store.mark('me', { account: 'me', read, receipts });
  const signal = (patch: Partial<QueueSignals> = {}): QueueSignals => ({
    url: member().url,
    headSha: 'head-1',
    checkedAt: ++time,
    comments: 0,
    checks: { state: 'success', passed: 1, total: 1 },
    ...patch,
  });
  return {
    dir,
    store,
    /** The same saved progress, read by a new store as after a restart. */
    restart: () => createPrReadStore(createMemoryStorage(saved)),
    state,
    mark,
    signal,
    next: () => ++time,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
void test('existing queue initializes quietly; later discoveries and meaningful metadata become unread', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()]);
    h.store.observe('me', [member(2)], true);
    assert.deepEqual(h.state().unread, []);
    assert.deepEqual(h.state(2).unread, []);
    h.store.observe('me', [member(3)]);
    assert.deepEqual(h.state(3).unread, ['new']);
    h.store.observe('me', [member(1, { labels: ['bug'], updatedAt: '2026-10-26T10:01:00Z' })]);
    assert.deepEqual(h.state().unread, []);
    h.store.observe('me', [
      member(1, { headSha: 'new', isDraft: true, reviewCommentCount: 2, updatedAt: '2026-10-26T10:02:00Z' }),
    ]);
    assert.deepEqual(h.state().unread, ['commits', 'state'], 'A comment count names no author, so signals decide');
    h.mark();
    assert.deepEqual(h.state().unread, []);
  } finally {
    h.cleanup();
  }
});
void test('acknowledgments are pinned to observed versions, including manual unread races and old diffs', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    const opened = h.state();
    h.store.observe('me', [member(1, { headSha: 'new' })]);
    h.mark(true, [opened]);
    assert.deepEqual(h.state().unread, ['commits']);
    h.mark(true, [{ ...h.state(), headSha: 'head-1' }]);
    assert.deepEqual(h.state().unread, ['commits']);
    const delayedRead = h.state();
    h.mark(false);
    h.mark(true, [delayedRead]);
    assert.deepEqual(h.state().unread, ['manual']);
    h.mark();
    assert.deepEqual(h.state().unread, []);
  } finally {
    h.cleanup();
  }
});
void test('read progress persists per account, survives cache clearing, and is keyed by PR rather than stack', async () => {
  const h = harness();
  let data = createAppDataStore();
  try {
    await data.open(h.dir);
    const store = createPrReadStore(data);
    store.observe('Alice', [member(), member(2)], true);
    const receipt = store.snapshot('alice')[member(2).url];
    store.mark('ALICE', { account: 'alice', read: false, receipts: [receipt] });
    await data.close();
    requestGitHubCacheClear(h.dir);
    data = createAppDataStore();
    await data.open(h.dir);
    await applyPendingGitHubCacheClear(h.dir, () => Promise.resolve(), () => data.clearGitHub());
    const restarted = createPrReadStore(data);
    assert.deepEqual(restarted.snapshot('alice')[member(2).url].unread, ['manual']);
    assert.deepEqual(restarted.snapshot('bob'), {});
    assert.throws(() => restarted.mark('bob', { account: 'alice', read: true, receipts: [receipt] }));
    const stack = groupSubjects([member(), member(2, { baseBranch: 'feature-1' })])[0];
    assert.equal(stack.members.length, 2);
    assert.deepEqual(
      stack.members.filter((m) => restarted.snapshot('alice')[m.url].unread.length).map((m) => m.number),
      [2]
    );
  } finally {
    await data.close();
    h.cleanup();
  }
});
void test('repeated reviews trigger unread, CI does not, stale signals cannot roll state back', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    const old = h.signal({ activity: { review: { id: 'old', at: '2026-10-25T00:00:00Z', author: 'alice' } } });
    h.store.signals('me', [old]);
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [h.signal({ checks: { state: 'failure', passed: 0, total: 1 } })]);
    assert.deepEqual(h.state().unread, []);
    const fresh = h.signal({ activity: { review: { id: 'new', at: '2026-10-26T10:01:00Z', author: 'alice' } } });
    h.store.signals('me', [fresh]);
    assert.deepEqual(h.state().unread, ['reviews']);
    h.mark();
    h.store.signals('me', [old, fresh]);
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [h.signal({ headSha: 'different', comments: 8 })]);
    assert.deepEqual(h.state().unread, []);
  } finally {
    h.cleanup();
  }
});
const event = (
  kind: 'comment' | 'review',
  id: string,
  author: string,
  at: string,
  extra: { automated?: boolean; minimized?: boolean; state?: string } = {}
) => ({ kind, id, author, at, automated: false, ...extra });
void test('comment counts alone never mark unread; each new comment is judged by its author', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    h.store.observe('me', [member(1, { commentCount: 4, reviewCommentCount: 6, updatedAt: '2026-10-26T10:01:00Z' })]);
    assert.deepEqual(h.state().unread, [], 'Counts rose, but whose comments they are is unknown');
    // Bob comments, then you reply from github.com before the next poll: Bob's comment is still news.
    h.store.signals('me', [
      h.signal({
        comments: 10,
        activity: {
          recent: [
            event('comment', 'c1', 'bob', '2026-10-26T10:00:30Z'),
            event('comment', 'c2', 'me', '2026-10-26T10:00:40Z'),
          ],
        },
      }),
    ]);
    assert.deepEqual(h.state().unread, ['comments']);
    h.mark();
    h.store.signals('me', [
      h.signal({
        comments: 11,
        activity: {
          recent: [
            event('comment', 'c1', 'bob', '2026-10-26T10:00:30Z'),
            event('comment', 'c2', 'me', '2026-10-26T10:00:40Z'),
            event('comment', 'c3', 'ME', '2026-10-26T10:00:50Z'),
          ],
        },
      }),
    ]);
    assert.deepEqual(h.state().unread, [], 'Your own comment from any client is not news');
  } finally {
    h.cleanup();
  }
});
void test('bot comments, GitHub Apps and hidden comments do not mark a PR unread', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    // The klanggames/seed#35389 shape: seven `github-actions` comments within 81 minutes. GraphQL names the
    // App `github-actions` with type Bot; REST names it `github-actions[bot]`.
    const ci = Array.from({ length: 7 }, (_, i) =>
      event('comment', `ci-${i}`, 'github-actions', `2026-10-26T10:0${i}:30Z`, { automated: true })
    );
    h.store.signals('me', [h.signal({ comments: 7, activity: { recent: ci } })]);
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [
      h.signal({
        comments: 9,
        activity: {
          recent: [
            ...ci,
            event('comment', 'hidden', 'carol', '2026-10-26T10:08:00Z', { minimized: true }),
            event('review', 'copilot', 'copilot-pull-request-reviewer', '2026-10-26T10:09:00Z', {
              automated: true,
              state: 'COMMENTED',
            }),
          ],
        },
      }),
    ]);
    assert.deepEqual(h.state().unread, []);
    // Signals saved before `recent` existed carry only the newest event. A `[bot]` login is still a bot.
    h.store.signals('me', [
      h.signal({ activity: { comment: { id: 'legacy', at: '2026-10-26T10:10:00Z', author: 'renovate[bot]' } } }),
    ]);
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [
      h.signal({
        activity: {
          recent: [
            event('comment', 'legacy', 'renovate[bot]', '2026-10-26T10:10:00Z', { automated: true }),
            event('comment', 'human', 'carol', '2026-10-26T10:11:00Z'),
          ],
        },
      }),
    ]);
    assert.deepEqual(h.state().unread, ['comments']);
  } finally {
    h.cleanup();
  }
});
void test('reviews: inline replies read as comments, decisions as reviews, your own never', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    const own = event('review', 'r-own', 'me', '2026-10-26T10:01:00Z', { state: 'COMMENTED' });
    const reply = event('review', 'r-bob', 'bob', '2026-10-26T10:02:00Z', { state: 'COMMENTED' });
    h.store.signals('me', [h.signal({ activity: { recent: [own] } })]);
    assert.deepEqual(h.state().unread, [], 'Your reply on github.com');
    h.store.signals('me', [h.signal({ activity: { recent: [own, reply] } })]);
    assert.deepEqual(h.state().unread, ['comments'], "Bob's inline reply");
    h.mark();
    const decision = (state: string) => event('review', 'r-bob-2', 'bob', '2026-10-26T10:03:00Z', { state });
    h.store.signals('me', [h.signal({ activity: { recent: [own, reply, decision('CHANGES_REQUESTED')] } })]);
    assert.deepEqual(h.state().unread, ['reviews']);
    h.mark();
    // A dismissal changes the state of a review already seen.
    h.store.signals('me', [h.signal({ activity: { recent: [own, reply, decision('DISMISSED')] } })]);
    assert.deepEqual(h.state().unread, ['reviews']);
  } finally {
    h.cleanup();
  }
});
void test('your own pushes do not mark a PR unread; pushes by others do', () => {
  const h = harness();
  try {
    const mine = (patch: Partial<ReviewMember> = {}) => member(1, { author: 'me', ...patch });
    h.store.observe('me', [mine(), member(2)], true);
    const push = (n: number, headSha: string, author: string | null, committer: string | null, at: string) => {
      h.store.observe('me', [n === 1 ? mine({ headSha, updatedAt: at }) : member(2, { headSha, updatedAt: at })]);
      return h.signal({ url: member(n).url, headSha, activity: { head: { author, committer } } });
    };
    // Your PR, pushed from a terminal: nothing shows before or after the author is known.
    const terminal = push(1, 'head-mine', 'me', 'me', '2026-10-26T10:01:00Z');
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [terminal]);
    assert.deepEqual(h.state().unread, []);
    // "Update branch" on github.com: you are the author and GitHub's web-flow commits.
    h.store.signals('me', [push(1, 'head-web', 'ME', 'web-flow', '2026-10-26T10:02:00Z')]);
    assert.deepEqual(h.state().unread, []);
    // A colleague pushes to your PR.
    h.store.signals('me', [push(1, 'head-bob', 'bob', 'bob', '2026-10-26T10:03:00Z')]);
    assert.deepEqual(h.state().unread, ['commits']);
    // Someone else's PR: unread at once, and undone when the head turns out to be your push.
    const other = push(2, 'head-2-mine', 'me', 'me', '2026-10-26T10:04:00Z');
    assert.deepEqual(h.state(2).unread, ['commits']);
    h.store.signals('me', [other]);
    assert.deepEqual(h.state(2).unread, []);
    h.store.signals('me', [push(2, 'head-2-bob', 'bob', 'me', '2026-10-26T10:05:00Z')]);
    assert.deepEqual(h.state(2).unread, ['commits'], "You rebased Bob's commit: still his change");
    // A PR you opened yourself is not "New PR".
    h.store.observe('me', [member(3, { author: 'ME' }), member(4)]);
    assert.deepEqual(h.state(3).unread, []);
    assert.deepEqual(h.state(4).unread, ['new']);
  } finally {
    h.cleanup();
  }
});
void test('successful own actions do not generate unread but preserve already unseen work', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    const posted = 'https://github.com/o/r/pull/1#pullrequestreview-9';
    h.store.ownReview('me', member().url, posted);
    h.store.signals('me', [
      h.signal({
        activity: {
          recent: [
            event('review', 'other', 'bob', '2026-10-26T10:00:30Z', { state: 'APPROVED' }),
            // A review posted through Gnosis, reported under a login that differs from the account.
            event('review', posted, 'renamed', '2026-10-26T10:01:00Z', { state: 'COMMENTED' }),
          ],
        },
      }),
    ]);
    assert.deepEqual(h.state().unread, ['reviews'], "Bob's approval remains unread");
    h.mark();
    h.store.observe(
      'me',
      [member(1, { headSha: 'own-rebase', updatedAt: '2026-10-26T10:03:00Z', reviewCommentCount: 3 })],
      false,
      true
    );
    assert.deepEqual(h.state().unread, []);
  } finally {
    h.cleanup();
  }
});
void test('unread filter combines all member conditions and is normalized for saved views', () => {
  const subject = groupSubjects([member(), member(2, { baseBranch: 'feature-1', author: 'bob' })])[0];
  const item = { subject, attention: 'other' as const, unreadUrls: [member(2).url] };
  const filters = { ...DEFAULT_QUEUE_FILTERS, readStatus: 'unread' as const };
  assert.equal(matchesQueueFilters(item, filters), true);
  assert.equal(matchesQueueFilters(item, { ...filters, author: 'alice' }), false);
  assert.equal(matchesQueueFilters(item, { ...filters, author: 'bob' }), true);
  assert.equal(normalizeQueueFilters(filters).readStatus, 'unread');
  assert.equal(normalizeQueueFilters({ unreadOnly: true }).readStatus, 'unread');
  assert.equal(normalizeQueueFilters({}).readStatus, 'all');
  assert.equal(unreadDescription(['commits', 'comments']), 'New commits and new comments since your last visit');
});
void test('a rejected change preserves prior read progress in memory and in saved data', () => {
  const saved = new Map<string, string>();
  let blocked = false;
  const memory = createMemoryStorage(saved);
  const storage: StateStorage = {
    ...memory,
    patch: (name, change) => {
      if (blocked) throw new Error('Saved work is still loading');
      memory.patch(name, change);
    },
  };
  const store = createPrReadStore(storage);
  store.observe('me', [member()], true);
  const receipts = [store.snapshot('me')[member().url]];
  blocked = true;
  assert.throws(() => store.mark('me', { account: 'me', read: false, receipts }));
  assert.deepEqual(store.snapshot('me')[member().url].unread, []);
  assert.deepEqual(createPrReadStore(createMemoryStorage(saved)).snapshot('me')[member().url].unread, []);
});

void test('observing unchanged metadata does not clone the complete unread state on every queue poll', (t) => {
  const h = harness();
  try {
    const members = Array.from({ length: 100 }, (_, i) => member(i + 1));
    h.store.observe('me', members, true);
    const clone = t.mock.method(globalThis, 'structuredClone');
    assert.equal(h.store.observe('me', members, true), false);
    assert.equal(clone.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); h.cleanup(); }
});
void test('a no-op signal does not write', (t) => {
  const h = harness();
  try {
    const members = Array.from({ length: 50 }, (_, i) => member(i + 1));
    h.store.observe('me', members, true);
    const seen = h.signal({ comments: 2 });
    assert.equal(h.store.signals('me', [seen]), true);
    const before = h.store.snapshot('me');
    const write = t.mock.method(fs, 'writeFileSync');
    const clone = t.mock.method(globalThis, 'structuredClone');
    assert.equal(h.store.signals('me', [seen]), false, 'A repeated signal changes nothing');
    assert.equal(h.store.signals('me', [h.signal({ headSha: 'another-head', comments: 9 })]), false);
    assert.equal(write.mock.callCount(), 0);
    assert.equal(clone.mock.callCount(), 0, 'Unchanged entries are never copied');
    assert.equal(h.store.snapshot('me'), before, 'The snapshot is shared until a change is saved');
    assert.ok(Object.isFrozen(before) && Object.isFrozen(before[member().url]));
    t.mock.restoreAll();
    assert.equal(
      h.store.signals('me', [
        h.signal({ comments: 3, activity: { recent: [event('comment', 'c', 'bob', '2026-10-26T10:05:00Z')] } }),
      ]),
      true
    );
    assert.notEqual(h.store.snapshot('me'), before);
    assert.deepEqual(h.state().unread, ['comments']);
    assert.deepEqual(h.state(2).unread, [], 'Untouched entries keep their state');
  } finally {
    t.mock.restoreAll();
    h.cleanup();
  }
});
