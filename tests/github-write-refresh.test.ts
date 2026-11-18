import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createGitHubWriteRefresher,
  githubPrUrl,
  GITHUB_WRITE_EFFECTS,
  GITHUB_WRITE_FOLLOW_UP_LIMIT_MS,
  GITHUB_WRITE_FOLLOW_UP_MS,
  type GitHubWriteAction,
  type GitHubWriteEvent,
  type WriteObservation,
} from '../lib/github-write-refresh';
import type { GitHubSyncKind } from '../lib/github-sync';

const URL = 'https://github.com/klang/engine/pull/7';
const head = (c: string) => c.repeat(40);
type Metadata = NonNullable<WriteObservation['metadata']>;
type Signals = NonNullable<WriteObservation['signals']>;
const metadata = (patch: Partial<Metadata> = {}): Metadata => ({
  headSha: head('a'),
  state: 'open',
  merged: false,
  updatedAt: '2026-11-15T10:00:00Z',
  isDraft: false,
  mergeable: true,
  autoMerge: null,
  requestedReviewers: [],
  commentCount: 1,
  reviewCommentCount: 2,
  ...patch,
});
const signals = (patch: Partial<Signals> = {}): Signals => ({
  headSha: head('a'),
  comments: 1,
  checks: { state: 'failure', passed: 1, failed: 1, total: 2 },
  latestReview: null,
  ...patch,
});

/** A GitHub that shows the write after `lag` reads, a manual clock and manual timers. */
function fixture(lag: number, change: { metadata?: Partial<Metadata>; signals?: Partial<Signals> }) {
  let now = 0,
    active = true,
    account: string | null = 'token',
    blocked: number | undefined;
  const timers: { at: number; run: () => void; cleared?: boolean }[] = [];
  const reads: { probe: string; phase: string; at: number }[] = [];
  const invalidated: { urls: string[]; kinds: GitHubSyncKind[]; followUpKinds: GitHubSyncKind[] }[] = [];
  const events: GitHubWriteEvent[] = [];
  let queued = 0;
  const refresher = createGitHubWriteRefresher({
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared?: boolean }).cleared = true;
    },
    active: () => active,
    account: () => account,
    baseline: () => ({ metadata: metadata(), signals: signals() }),
    invalidate: (urls, kinds, followUpKinds) => invalidated.push({ urls, kinds, followUpKinds }),
    read: (probe, _target, phase) => {
      reads.push({ probe, phase, at: now });
      const changed = reads.filter((read) => read.probe === probe).length > lag;
      return Promise.resolve(
        probe === 'metadata'
          ? metadata(changed ? change.metadata : {})
          : signals(changed ? change.signals : {})
      );
    },
    blockedUntil: () => blocked,
    refreshed: (event) => events.push(event),
    queue: () => queued++,
  });
  /** Runs timers due up to `until`, in order, letting each read settle. */
  async function advance(until: number) {
    for (;;) {
      const next = timers.filter((t) => !t.cleared && t.at <= until).sort((a, b) => a.at - b.at).at(0);
      if (!next) break;
      next.cleared = true;
      now = next.at;
      next.run();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = until;
  }
  return {
    refresher,
    reads,
    invalidated,
    events,
    advance,
    queued: () => queued,
    pendingTimers: () => timers.filter((t) => !t.cleared).length,
    set: {
      active: (value: boolean) => (active = value),
      account: (value: string | null) => (account = value),
      blocked: (value: number | undefined) => (blocked = value),
    },
  };
}

void test('every write names what it makes stale and how it is read again', () => {
  const actions = Object.keys(GITHUB_WRITE_EFFECTS) as GitHubWriteAction[];
  assert.ok(actions.length >= 20);
  for (const action of actions) {
    const effect = GITHUB_WRITE_EFFECTS[action];
    assert.ok(effect.kinds.length, `${action} invalidates something`);
    assert.equal(effect.probes[0], 'metadata', `${action} reads the PR first`);
  }
  assert.deepEqual(GITHUB_WRITE_EFFECTS.merge.kinds, ['metadata', 'signals', 'checks', 'discussion']);
  assert.equal(GITHUB_WRITE_EFFECTS.merge.queue, true, 'a merge changes queue membership');
  assert.equal(GITHUB_WRITE_EFFECTS['submit-review'].queue, true, 'a review changes the reviewer’s section');
  assert.deepEqual(GITHUB_WRITE_EFFECTS['rerun-checks'].kinds, ['checks', 'signals']);
  assert.deepEqual(GITHUB_WRITE_EFFECTS['rerun-checks'].followUpKinds, ['checks']);
  assert.deepEqual(GITHUB_WRITE_EFFECTS['update-branch'].followUpKinds, ['signals', 'checks']);
  assert.deepEqual(GITHUB_WRITE_EFFECTS['comment-edit'].kinds, ['discussion']);
  for (const action of ['thread-resolve', 'thread-unresolve', 'comment-edit', 'merge-submitted', 'external'] as const)
    assert.equal(GITHUB_WRITE_EFFECTS[action].seen, undefined, `${action} needs one read only`);
  assert.equal(GITHUB_WRITE_FOLLOW_UP_MS.reduce((a, b) => a + b, 0) <= GITHUB_WRITE_FOLLOW_UP_LIMIT_MS, true);
});

void test('each follow-up condition matches the change it waits for', () => {
  const before = { metadata: metadata(), signals: signals() };
  const seen = (action: GitHubWriteAction, now: WriteObservation, details = {}) =>
    GITHUB_WRITE_EFFECTS[action].seen?.(now, { before, ...details }) ?? true;
  assert.equal(seen('merge', { metadata: metadata() }), false);
  assert.equal(seen('merge', { metadata: metadata({ merged: true, state: 'closed' }) }), true);
  assert.equal(seen('merge-queue', { metadata: metadata(), signals: signals() }), false);
  assert.equal(
    seen('merge-queue', { metadata: metadata(), signals: signals({ readiness: { queueState: 'QUEUED' } as Signals['readiness'] }) }),
    true
  );
  assert.equal(seen('enable-auto-merge', { metadata: metadata({ autoMerge: { method: 'squash' } }) }), true);
  assert.equal(seen('disable-auto-merge', { metadata: metadata({ autoMerge: { method: 'squash' } }) }), false);
  // Update branch: a new head alone is not enough while GitHub computes mergeability.
  assert.equal(seen('update-branch', { metadata: metadata({ headSha: head('b'), mergeable: null }) }), false);
  assert.equal(seen('update-branch', { metadata: metadata({ headSha: head('b'), mergeable: true }) }), true);
  assert.equal(seen('update-branch', { metadata: metadata({ mergeable: true }) }), false);
  assert.equal(seen('mark-ready', { metadata: metadata({ isDraft: true }) }), false);
  assert.equal(seen('convert-draft', { metadata: metadata({ isDraft: true }) }), true);
  const review = { url: 'https://github.com/klang/engine/pull/7#pullrequestreview-9', author: 'oddur', state: 'APPROVED', submittedAt: '2026-11-15T10:01:00Z', headSha: head('a') };
  assert.equal(seen('submit-review', { signals: signals() }, { reviewUrl: review.url }), false);
  assert.equal(seen('submit-review', { signals: signals({ latestReview: review }) }, { reviewUrl: review.url }), true);
  assert.equal(seen('submit-review', { signals: signals({ latestReview: { ...review, url: 'other' } }) }, { reviewUrl: review.url }), false);
  assert.equal(seen('review-comment', { metadata: metadata() }), false);
  assert.equal(seen('thread-reply', { metadata: metadata({ reviewCommentCount: 3 }) }), true);
  assert.equal(seen('comment-delete', { metadata: metadata({ reviewCommentCount: 1 }) }), true);
  assert.equal(seen('feedback-reply', { metadata: metadata({ commentCount: 2 }) }), true);
  assert.equal(seen('request-review', { metadata: metadata() }, { reviewer: 'Ana' }), false);
  assert.equal(seen('request-review', { metadata: metadata({ requestedReviewers: ['ana'] }) }, { reviewer: 'Ana' }), true);
  assert.equal(seen('rerun-checks', { signals: signals() }), false);
  assert.equal(seen('rerun-checks', { signals: signals({ checks: { state: 'pending', passed: 1, running: 1, total: 2 } }) }), true);
  assert.equal(seen('push', { metadata: metadata() }), false);
  assert.equal(seen('push', { metadata: metadata({ headSha: head('c') }) }), true);
  // A failed read never counts as the change.
  assert.equal(seen('merge', {}), false);
  assert.equal(seen('rerun-checks', {}), false);
});

void test('a write is read again at once, then followed up with backoff until the change shows', async () => {
  const f = fixture(3, { metadata: { merged: true, state: 'closed' } });
  await f.refresher.after('merge', [URL]);
  assert.deepEqual(f.invalidated, [{ urls: [URL], kinds: ['metadata', 'signals', 'checks', 'discussion'], followUpKinds: [] }]);
  assert.deepEqual(f.reads.map((r) => [r.phase, r.at]), [['immediate', 0]]);
  assert.deepEqual(f.events.map((e) => e.phase), ['immediate']);
  await f.advance(60_000);
  // 1 s, then 2 s, then 4 s later: the third follow-up is GitHub's fourth read, which shows the merge.
  assert.deepEqual(f.reads.map((r) => r.at), [0, 1_000, 3_000, 7_000]);
  assert.deepEqual(f.events.map((e) => e.phase), ['immediate', 'follow-up', 'follow-up', 'settled']);
  assert.equal(f.queued(), 1, 'discovery comes forward once the merge shows');
  assert.equal(f.invalidated.length, 2, 'watched views read once more when the change shows');
  assert.equal(f.pendingTimers(), 0);
  assert.deepEqual(f.refresher.pending(), []);
});

void test('a change visible at once needs no follow-up', async () => {
  const f = fixture(0, { metadata: { isDraft: true } });
  await f.refresher.after('convert-draft', [URL]);
  await f.advance(60_000);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.events.map((e) => e.phase), ['immediate', 'settled']);
  assert.equal(f.invalidated.length, 1, 'the views read when the write finished already show it');
});

void test('the follow-up gives up quietly after its limit', async () => {
  const f = fixture(1_000, { metadata: { merged: true } });
  await f.refresher.after('merge', [URL]);
  await f.advance(10 * 60_000);
  assert.equal(f.reads.length, 1 + GITHUB_WRITE_FOLLOW_UP_MS.length);
  assert.ok(f.reads.every((r) => r.at <= GITHUB_WRITE_FOLLOW_UP_LIMIT_MS));
  assert.equal(f.events.at(-1)?.phase, 'gave-up');
  assert.equal(f.queued(), 0);
  assert.equal(f.pendingTimers(), 0);
});

void test('a follow-up never reads while nobody uses Gnosis', async () => {
  const f = fixture(5, { metadata: { merged: true } });
  await f.refresher.after('merge', [URL]);
  f.set.active(false);
  await f.advance(10 * 60_000);
  assert.equal(f.reads.length, 1, 'only the read right after the write');
  assert.equal(f.events.at(-1)?.phase, 'gave-up');
  assert.equal(f.pendingTimers(), 0);
});

void test('a follow-up waits for a paused budget without spending attempts, and gives up past its limit', async () => {
  const f = fixture(2, { metadata: { merged: true } });
  await f.refresher.after('merge', [URL]);
  f.set.blocked(5_000);
  await f.advance(4_000);
  assert.equal(f.reads.length, 1, 'no read while GitHub reads are paused');
  f.set.blocked(undefined);
  await f.advance(60_000);
  assert.deepEqual(f.reads.map((r) => r.at), [0, 5_000, 7_000]);
  assert.equal(f.events.at(-1)?.phase, 'settled');

  const late = fixture(2, { metadata: { merged: true } });
  await late.refresher.after('merge', [URL]);
  late.set.blocked(10 * 60_000);
  await late.advance(10 * 60_000);
  assert.equal(late.reads.length, 1);
  assert.equal(late.events.at(-1)?.phase, 'gave-up');
});

void test('signals follow the head metadata reports; reruns wait for running checks', async () => {
  const f = fixture(2, { signals: { checks: { state: 'pending', passed: 1, running: 1, total: 2 } } });
  await f.refresher.after('rerun-checks', [URL]);
  assert.deepEqual(f.invalidated[0].followUpKinds, ['checks']);
  await f.advance(60_000);
  assert.deepEqual(f.reads.map((r) => r.probe), ['metadata', 'signals', 'metadata', 'signals', 'metadata', 'signals']);
  assert.equal(f.events.at(-1)?.phase, 'settled');
});

void test('a newer write to the same PR replaces the older follow-up; an account change stops it', async () => {
  const f = fixture(1_000, { metadata: {} });
  await f.refresher.after('merge', [URL]);
  await f.refresher.after('enable-auto-merge', [URL]);
  assert.deepEqual(f.refresher.pending().map((p) => p.action), ['enable-auto-merge']);
  assert.equal(f.pendingTimers(), 1);
  f.set.account('another');
  await f.advance(60_000);
  assert.equal(f.reads.length, 2, 'no reads for the old account');
  assert.equal(f.pendingTimers(), 0);
});

void test('a failed write reads once without a follow-up; local copies are the baseline', async () => {
  const f = fixture(1_000, { metadata: {} });
  await f.refresher.after('merge', [URL, 'not a PR'], {}, { followUp: false });
  await f.advance(60_000);
  assert.equal(f.reads.length, 1);
  assert.equal(f.events.at(-1)?.phase, 'gave-up');
  assert.deepEqual(f.refresher.capture([URL, 'https://example.com']).get(URL)?.metadata?.headSha, head('a'));
  assert.equal(f.refresher.capture([URL, 'https://example.com']).size, 1);
});

void test('links into a PR on GitHub name that PR', () => {
  assert.equal(githubPrUrl(`${URL}/files#diff-1`), URL);
  assert.equal(githubPrUrl(`${URL}?w=1`), URL);
  assert.equal(githubPrUrl(URL), URL);
  assert.equal(githubPrUrl('https://github.com/klang/engine/pull/7x'), undefined);
  assert.equal(githubPrUrl('https://github.com/klang/engine/tree/main'), undefined);
  assert.equal(githubPrUrl(42), undefined);
});

/**
 * The inventory: every GitHub write call in the app. A new write must be added here and wired through
 * `gitHubWrite` or `githubWrites.after` in src/main.ts.
 */
void test('every GitHub write in the app is in the inventory', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pattern =
    /\bmutation(?=\s*[($A-Z{])|'(?:POST|PUT|PATCH|DELETE) \/repos|\.(?:pulls|issues|reactions|actions|repos|git)\.(?:create|update|delete|remove|add|merge|requestReviewers|reRun|cancel|dismiss|submit)\w*\(|^\s+'push',$/gm;
  const found = new Set<string>();
  for (const dir of ['src', 'lib']) {
    for (const file of fs.readdirSync(path.join(root, dir))) {
      if (!/\.tsx?$/.test(file)) continue;
      const text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      for (const match of text.matchAll(pattern)) found.add(`${dir}/${file}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual([...found].sort(), [
    "src/conflict-resolution-service.ts: 'push',",
    "src/conflict-restack.ts: 'push',",
    "src/pr-actions-service.ts: 'POST /repos",
    "src/pr-actions-service.ts: 'PUT /repos",
    // Close PR (#390): the optional comment, then the closePullRequest mutation.
    'src/pr-actions-service.ts: .issues.createComment(',
    'src/pr-actions-service.ts: mutation',
    'src/pr-checks-service.ts: .actions.reRunWorkflow(',
    'src/pr-checks-service.ts: .actions.reRunWorkflowFailedJobs(',
    'src/review-thread-service.ts: .issues.createComment(',
    'src/review-thread-service.ts: .pulls.requestReviewers(',
    'src/review-thread-service.ts: mutation',
    'src/review-write-service.ts: .pulls.createReview(',
    'src/review-write-service.ts: .pulls.createReviewComment(',
  ].sort());
  const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  for (const handler of ['feedback-action', 'review-thread-action', 'review-comment-action', 'create-review-comment', 'submit-review', 'rerun-checks']) {
    const body = main.slice(main.indexOf(`handleInteractive('${handler}'`), main.indexOf('\n});', main.indexOf(`handleInteractive('${handler}'`)));
    assert.match(body, /gitHubWrite\(/, `${handler} refreshes through gitHubWrite`);
  }
  assert.match(main, /githubWrites\.after\(write\(result\)/, 'PR actions refresh through githubWrites');
  assert.match(main, /githubWrites\.after\('push'/, 'conflict pushes refresh through githubWrites');
  assert.match(main, /githubWrites\.after\('stack-merged'/, 'a completed stack merge refreshes through githubWrites');
});
