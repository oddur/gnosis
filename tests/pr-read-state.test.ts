import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrReadStore } from '../src/pr-read-store';
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
  const store = createPrReadStore(
    () => dir,
    () => time
  );
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
    assert.deepEqual(h.state().unread, ['commits', 'comments', 'state']);
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
  try {
    h.store.observe('Alice', [member(), member(2)], true);
    const receipt = h.store.snapshot('alice')[member(2).url];
    h.store.mark('ALICE', { account: 'alice', read: false, receipts: [receipt] });
    requestGitHubCacheClear(h.dir);
    await applyPendingGitHubCacheClear(h.dir, () => Promise.resolve());
    const restarted = createPrReadStore(() => h.dir);
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
void test('late signal hydration does not repeat comments already seen through metadata', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    const current = member(1, { commentCount: 1, updatedAt: '2026-10-26T10:01:00Z' });
    h.store.observe('me', [current]);
    h.mark();
    h.store.signals('me', [
      h.signal({ comments: 1, activity: { comment: { id: 'comment', at: current.updatedAt, author: 'alice' } } }),
    ]);
    h.store.observe('me', [current]);
    assert.deepEqual(h.state().unread, []);
    h.store.signals('me', [h.signal({ comments: 2 })]);
    h.mark();
    h.store.observe('me', [current]);
    h.store.signals('me', [h.signal({ comments: 2 })]);
    assert.deepEqual(h.state().unread, []);
  } finally {
    h.cleanup();
  }
});
void test('successful own actions do not generate unread but preserve already unseen work', () => {
  const h = harness();
  try {
    h.store.observe('me', [member()], true);
    h.store.ownReview('me', member().url, 2, Date.parse('2026-10-26T10:02:00Z'));
    h.store.observe('me', [member(1, { reviewCommentCount: 3, updatedAt: '2026-10-26T10:02:00Z' })]);
    assert.deepEqual(h.state().unread, ['comments'], 'one other comment remains unread');
    h.store.signals('me', [
      h.signal({ activity: { review: { id: 'own', at: '2026-10-26T10:01:00Z', author: 'ME' } } }),
    ]);
    assert.deepEqual(h.state().unread, ['comments']);
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
  const filters = { ...DEFAULT_QUEUE_FILTERS, unreadOnly: true };
  assert.equal(matchesQueueFilters(item, filters), true);
  assert.equal(matchesQueueFilters(item, { ...filters, author: 'alice' }), false);
  assert.equal(matchesQueueFilters(item, { ...filters, author: 'bob' }), true);
  assert.equal(normalizeQueueFilters(filters).unreadOnly, true);
  assert.equal(normalizeQueueFilters({}).unreadOnly, false);
  assert.equal(unreadDescription(['commits', 'comments']), 'New commits and new comments since your last visit');
});
void test('failed writes preserve prior read progress in memory and on disk', () => {
  const h = harness();
  try {
    let directory = h.dir;
    const store = createPrReadStore(() => directory);
    store.observe('me', [member()], true);
    const receipts = [store.snapshot('me')[member().url]];
    directory = path.join(h.dir, 'file');
    fs.writeFileSync(directory, 'blocked');
    assert.throws(() => store.mark('me', { account: 'me', read: false, receipts }));
    assert.deepEqual(store.snapshot('me')[member().url].unread, []);
    assert.deepEqual(createPrReadStore(() => h.dir).snapshot('me')[member().url].unread, []);
  } finally {
    h.cleanup();
  }
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
