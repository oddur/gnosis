import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyToActionState,
  createOptimisticLayer,
  OPTIMISTIC_CONFIRMED_TTL_MS,
  prActionChange,
} from '../lib/optimistic-patches';
import { createOptimisticService } from '../src/optimistic-service';
import type { GitHubReviewComment, GitHubReviewThread, GitHubReviewThreads } from '../lib/review-threads';
import type { QueueSignals } from '../lib/queue-signals';
import type { QueueItem, ReviewMember } from '../lib/workbench';
import { attentionItems } from '../lib/attention';
import { responseNeeded } from '../lib/response-needed';

const url = 'https://github.com/o/r/pull/1';
const viewer = { login: 'oddur', avatarUrl: 'https://github.com/oddur.png' };
const T0 = Date.parse('2026-11-15T09:00:00Z');
function harness() {
  let now = T0;
  let id = 0;
  const layer = createOptimisticLayer({ now: () => now, id: () => `p${++id}` });
  return { layer, tick: (ms: number) => (now += ms), now: () => now };
}
const comment = (id: string, body: string, login = 'reviewer', at = T0 - 3_600_000): GitHubReviewComment => ({
  id,
  body,
  createdAt: new Date(at).toISOString(),
  url: `${url}#discussion_${id}`,
  author: { login, avatarUrl: '' },
  viewerCanUpdate: login === 'oddur',
  viewerCanDelete: login === 'oddur',
});
const thread = (
  id: string,
  comments: GitHubReviewComment[],
  patch: Partial<GitHubReviewThread> = {}
): GitHubReviewThread => ({
  id,
  path: 'src/a.ts',
  line: 4,
  startLine: null,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments,
  ...patch,
});
const discussion = (
  threads: GitHubReviewThread[],
  feedback: Partial<NonNullable<GitHubReviewThreads['feedback']>> = {}
): GitHubReviewThreads => ({
  headSha: 'head',
  baseSha: 'base',
  threads,
  feedback: { comments: [], reviews: [], requestedReviewers: [], viewerCanUpdate: true, state: 'OPEN', ...feedback },
});
const member = (patch: Partial<ReviewMember> = {}): ReviewMember =>
  ({
    url,
    number: 1,
    repo: 'o/r',
    headRepo: 'o/r',
    baseRepo: 'o/r',
    role: 'review-requested',
    title: 'Fix',
    description: '',
    author: 'author',
    baseBranch: 'main',
    headBranch: 'fix',
    baseSha: 'base',
    headSha: 'head',
    merged: false,
    state: 'open',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    labels: [],
    mergeable: true,
    isDraft: false,
    commitCount: 1,
    requestedReviewers: ['oddur'],
    requestedTeams: [],
    mergeableState: 'clean',
    autoMerge: null,
    milestone: null,
    commentCount: 2,
    reviewCommentCount: 3,
    ...patch,
  }) as ReviewMember;
const signals = (patch: Partial<QueueSignals> = {}): QueueSignals => ({
  url,
  headSha: 'head',
  checkedAt: T0,
  comments: 5,
  latestReview: null,
  checks: { state: 'success', passed: 1, total: 1 },
  readiness: {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    baseBranch: 'main',
    baseSha: 'base',
    behindBy: 0,
    mergeQueue: false,
    queueState: null,
  },
  ...patch,
});

void test('a reply shows at once as sending, with the counts that follow it', () => {
  const { layer } = harness();
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  layer.begin({
    url,
    viewer,
    change: { action: 'thread-reply', threadId: 't1', body: 'Because.' },
    before: { reviewCommentCount: 3, comments: 5 },
  });
  const shown = layer.discussion(url, base);
  assert.deepEqual(
    shown.threads[0].comments.map((c) => [c.body, !!c.sending, c.url]),
    [
      ['Why?', false, `${url}#discussion_c1`],
      ['Because.', true, ''],
    ]
  );
  assert.equal(shown.threads[0].comments[1].author?.login, 'oddur');
  assert.equal(base.threads[0].comments.length, 1, 'the fetched copy is never changed');
  assert.equal(layer.metadata(member()).reviewCommentCount, 4);
  assert.equal(layer.signals(signals()).comments, 6, 'the badge shows GitHub’s total, inline comments included');
  assert.equal(
    layer.metadata(member({ url: 'https://github.com/o/r/pull/2' })).reviewCommentCount,
    3,
    'other PRs are untouched'
  );
});

void test('confirm swaps in the real comment; a fresh read with it clears the patch without a duplicate', () => {
  const { layer } = harness();
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  const patch = layer.begin({
    url,
    viewer,
    change: { action: 'thread-reply', threadId: 't1', body: 'Because.' },
    before: { reviewCommentCount: 3, comments: 5 },
  });
  const real = comment('c2', 'Because.', 'oddur', T0 + 500);
  layer.confirm(patch.id, { thread: thread('t1', [comment('c1', 'Why?'), real]) });
  const confirmed = layer.discussion(url, base);
  assert.deepEqual(
    confirmed.threads[0].comments.map((c) => [c.id, !!c.sending]),
    [
      ['c1', false],
      ['c2', false],
    ],
    'the real id and URL'
  );
  assert.equal(confirmed.threads[0].comments[1].url, real.url);

  // A lagging read without the reply keeps showing it.
  assert.equal(layer.observe(url, 'discussion', base), false);
  assert.equal(layer.discussion(url, base).threads[0].comments.length, 2);

  // GitHub shows it: exactly one copy, and the patch is done with discussions.
  const fresh = discussion([thread('t1', [comment('c1', 'Why?'), real])]);
  assert.equal(layer.observe(url, 'discussion', fresh), true);
  assert.deepEqual(
    layer.discussion(url, fresh).threads[0].comments.map((c) => c.id),
    ['c1', 'c2']
  );
  // Counts settle through their own reads, then the patch is cleared.
  layer.observe(url, 'metadata', member({ reviewCommentCount: 4 }));
  layer.observe(url, 'signals', signals({ comments: 6 }));
  assert.deepEqual(layer.list(), []);
  assert.equal(layer.signals(signals({ comments: 6 })).comments, 6, 'no double count');
  assert.equal(layer.metadata(member({ reviewCommentCount: 4 })).reviewCommentCount, 4, 'no double count');
});

void test('a pending reply that a fresh read already shows is never shown twice', () => {
  const { layer } = harness();
  layer.begin({ url, viewer, change: { action: 'thread-reply', threadId: 't1', body: 'Because.\n' } });
  const fresh = discussion([thread('t1', [comment('c1', 'Why?'), comment('c2', 'Because.', 'Oddur', T0 + 200)])]);
  assert.deepEqual(
    layer.discussion(url, fresh).threads[0].comments.map((c) => c.id),
    ['c1', 'c2']
  );
  // Still pending: the write may fail, so a pending patch is never settled by a read.
  assert.equal(layer.observe(url, 'discussion', fresh), false);
  assert.equal(layer.list().length, 1);
});

void test('a failed write rolls back every copy', () => {
  const { layer } = harness();
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  const reply = layer.begin({
    url,
    viewer,
    change: { action: 'thread-reply', threadId: 't1', body: 'Because.' },
    before: { reviewCommentCount: 3, comments: 5 },
  });
  const resolve = layer.begin({ url, viewer, change: { action: 'thread-resolve', threadId: 't1' } });
  const draft = layer.begin({ url, viewer, change: { action: 'convert-draft' } });
  assert.equal(layer.discussion(url, base).threads[0].isResolved, true);
  assert.equal(layer.discussion(url, base).threads[0].sending, 'resolving');
  assert.equal(layer.metadata(member()).isDraft, true);
  assert.equal(layer.signals(signals()).readiness?.isDraft, true);
  for (const patch of [reply, resolve, draft]) assert.equal(layer.fail(patch.id)?.id, patch.id);
  assert.deepEqual(layer.discussion(url, base), base);
  assert.deepEqual(layer.metadata(member()), member());
  assert.deepEqual(layer.signals(signals()), signals());
  assert.equal(layer.fail(reply.id), undefined, 'a second failure is a no-op');
});

void test('a newer write to the same target replaces the older one', () => {
  const { layer } = harness();
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  const resolve = layer.begin({ url, viewer, change: { action: 'thread-resolve', threadId: 't1' } });
  layer.begin({ url, viewer, change: { action: 'thread-unresolve', threadId: 't1' } });
  assert.equal(layer.list().length, 1);
  assert.equal(layer.discussion(url, base).threads[0].isResolved, false);
  assert.equal(layer.confirm(resolve.id), undefined, 'the replaced write no longer confirms anything');
});

void test('a new inline comment shows as a sending thread and becomes the real one', () => {
  const { layer } = harness();
  const base = discussion([]);
  const patch = layer.begin({
    url,
    viewer,
    change: { action: 'review-comment', path: 'src/b.ts', line: 9, side: 'RIGHT', body: 'Rename this.' },
    before: { reviewCommentCount: 3 },
  });
  const pending = layer.discussion(url, base);
  assert.equal(pending.threads.length, 1);
  assert.equal(pending.threads[0].sending, 'comment');
  assert.deepEqual(
    [pending.threads[0].path, pending.threads[0].line, pending.threads[0].diffSide],
    ['src/b.ts', 9, 'RIGHT']
  );
  layer.confirm(patch.id, { comment: { id: 'PRRC_1', url: `${url}#discussion_r1` } });
  const confirmed = layer.discussion(url, base).threads[0];
  assert.equal(confirmed.sending, undefined);
  assert.deepEqual(
    [confirmed.comments[0].id, confirmed.comments[0].url, !!confirmed.comments[0].sending],
    ['PRRC_1', `${url}#discussion_r1`, false]
  );
  const fresh = discussion([
    thread('PRRT_1', [{ ...comment('PRRC_1', 'Rename this.', 'oddur', T0 + 400), url: `${url}#discussion_r1` }], {
      path: 'src/b.ts',
      line: 9,
    }),
  ]);
  assert.deepEqual(
    layer.discussion(url, fresh).threads.map((t) => t.id),
    ['PRRT_1'],
    'one thread, not two'
  );
});

void test('edits, deletes and conversation replies apply and settle', () => {
  const { layer } = harness();
  const mine = comment('c2', 'Old text', 'oddur');
  const base = discussion(
    [thread('t1', [comment('c1', 'Why?'), mine]), thread('t2', [comment('c3', 'Solo', 'oddur')])],
    {
      comments: [comment('i1', 'Looks risky')],
    }
  );
  const edit = layer.begin({
    url,
    viewer,
    change: { action: 'comment-edit', threadId: 't1', commentId: 'c2', body: 'New text' },
  });
  const remove = layer.begin({
    url,
    viewer,
    change: { action: 'comment-delete', threadId: 't2', commentId: 'c3' },
    before: { reviewCommentCount: 3 },
  });
  const reply = layer.begin({
    url,
    viewer,
    change: { action: 'feedback-reply', body: 'In reply to [this feedback](x):\n\nOn it.' },
    before: { commentCount: 2, comments: 5 },
  });
  const shown = layer.discussion(url, base);
  assert.deepEqual([shown.threads[0].comments[1].body, shown.threads[0].comments[1].sending], ['New text', true]);
  assert.deepEqual(
    shown.threads.map((t) => t.id),
    ['t1'],
    'an emptied thread leaves'
  );
  assert.deepEqual(
    shown.feedback?.comments.map((c) => [c.body.slice(-6), !!c.sending]),
    [
      ['Looks risky'.slice(-6), false],
      ['On it.', true],
    ]
  );
  assert.equal(layer.metadata(member()).reviewCommentCount, 2);
  assert.equal(layer.metadata(member()).commentCount, 3);
  assert.equal(layer.signals(signals()).comments, 6, 'a conversation reply counts in the queue row');
  for (const patch of [edit, remove, reply]) layer.confirm(patch.id);
  const fresh = discussion([thread('t1', [comment('c1', 'Why?'), { ...mine, body: 'New text' }])], {
    comments: [
      comment('i1', 'Looks risky'),
      comment('i2', 'In reply to [this feedback](x):\n\nOn it.', 'oddur', T0 + 100),
    ],
  });
  layer.observe(url, 'discussion', fresh);
  const settled = layer.discussion(url, fresh);
  assert.equal(settled.feedback?.comments.length, 2, 'the real reply replaces the optimistic one');
  assert.equal(settled.threads[0].comments[1].sending, undefined);
});

void test('a review shows the decision, the reviewer list, the queue role and its comments at once', () => {
  const { layer } = harness();
  const patch = layer.begin({
    url,
    viewer,
    change: {
      action: 'submit-review',
      event: 'APPROVE',
      body: 'Ship it',
      headSha: 'head',
      comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'nit' }],
    },
    before: { reviewCommentCount: 3, comments: 5 },
  });
  const shownMember = layer.metadata(member());
  assert.deepEqual(shownMember.requestedReviewers, []);
  assert.equal(shownMember.role, 'watched', 'the PR leaves Review requested');
  assert.equal(layer.metadata(member({ author: 'oddur' })).role, 'author');
  assert.equal(shownMember.reviewCommentCount, 4);
  const shownSignals = layer.signals(signals());
  assert.equal(shownSignals.readiness?.reviewDecision, 'APPROVED');
  assert.deepEqual([shownSignals.latestReview?.author, shownSignals.latestReview?.state], ['oddur', 'APPROVED']);
  // Your own latest review, at the head you approved: the PR is no longer "updated since your review".
  assert.deepEqual([shownSignals.mine?.author, shownSignals.mine?.state, shownSignals.mine?.headSha], ['oddur', 'APPROVED', 'head']);
  const shown = layer.discussion(url, discussion([], { requestedReviewers: ['oddur'] }));
  assert.deepEqual(
    shown.feedback?.reviews.map((r) => [r.state, !!r.sending]),
    [['APPROVED', true]]
  );
  assert.deepEqual(shown.feedback.requestedReviewers, []);
  assert.deepEqual(
    shown.threads.map((t) => [t.path, t.line, t.sending]),
    [['src/a.ts', 2, 'comment']]
  );

  layer.confirm(patch.id, { reviewUrl: `${url}#pullrequestreview-9` });
  // Another reviewer's newer review does not count as this one.
  assert.equal(
    layer.observe(
      url,
      'signals',
      signals({
        latestReview: {
          url: `${url}#pullrequestreview-8`,
          author: 'someone',
          state: 'COMMENTED',
          submittedAt: new Date(T0 + 1).toISOString(),
          headSha: 'head',
        },
      })
    ),
    false
  );
  const freshSignals = signals({
    latestReview: {
      url: `${url}#pullrequestreview-9`,
      author: 'oddur',
      state: 'APPROVED',
      submittedAt: new Date(T0 + 1).toISOString(),
      headSha: 'head',
    },
    readiness: {
      ...(signals().readiness as NonNullable<QueueSignals['readiness']>),
      reviewDecision: 'REVIEW_REQUIRED',
    },
  });
  assert.equal(layer.observe(url, 'signals', freshSignals), true);
  // GitHub's decision wins once the review shows: two approvals may be required.
  assert.equal(layer.signals(freshSignals).readiness?.reviewDecision, 'REVIEW_REQUIRED');
});

void test('attention and the menu bar follow a review and a draft change at once', () => {
  const { layer } = harness();
  const item = (m: ReviewMember) =>
    ({
      subject: { id: 's1', kind: 'pr', title: m.title, members: [m] },
      attention: 'requested',
      briefing: { status: 'paused' },
    }) as unknown as QueueItem;
  const rows = (m: ReviewMember) =>
    attentionItems({ items: [item(m)], signals: () => undefined, login: 'oddur', enabled: () => true, now: T0 }).map(
      (row) => row.kinds.join()
    );
  assert.deepEqual(rows(member()), ['review-requested']);
  const review = layer.begin({
    url,
    viewer,
    change: { action: 'submit-review', event: 'COMMENT', body: 'Looks fine', comments: [] },
  });
  // Main builds the queue, attention and the menu bar from overlaid members, so the request leaves at once.
  assert.deepEqual(rows(layer.metadata(member())), []);
  layer.fail(review.id);
  assert.deepEqual(rows(layer.metadata(member())), ['review-requested'], 'and comes back when the review fails');
  layer.begin({ url, viewer, change: { action: 'convert-draft' } });
  assert.deepEqual(rows(layer.metadata(member())), [], 'a draft asks nobody for review');
});

void test('draft state and auto-merge apply to metadata and the PR action state', () => {
  const { layer } = harness();
  layer.begin({ url, viewer, change: { action: 'mark-ready' } });
  layer.begin({ url, viewer, change: { action: 'enable-auto-merge', method: 'SQUASH' } });
  const shown = layer.metadata(member({ isDraft: true }));
  assert.deepEqual([shown.isDraft, shown.autoMerge], [false, { method: 'SQUASH' }]);
  const state = { isDraft: true, autoMerge: null as string | null, canEnableAuto: true, canDisableAuto: false };
  const actions = layer.list(url).reduce((value, patch) => applyToActionState(value, patch.change), state);
  assert.deepEqual(actions, { isDraft: false, autoMerge: 'SQUASH', canEnableAuto: false, canDisableAuto: true });
  assert.equal(prActionChange('merge'), undefined, 'merges wait for GitHub');
  assert.deepEqual(prActionChange('disable-auto'), { action: 'disable-auto-merge' });
});

void test('a re-requested reviewer shows at once and settles once GitHub lists them', () => {
  const { layer } = harness();
  const patch = layer.begin({ url, viewer, change: { action: 'request-review', reviewer: 'Alice' } });
  assert.deepEqual(layer.metadata(member({ requestedReviewers: [] })).requestedReviewers, ['Alice']);
  assert.deepEqual(layer.discussion(url, discussion([])).feedback?.requestedReviewers, ['Alice']);
  layer.confirm(patch.id);
  layer.observe(url, 'metadata', member({ requestedReviewers: ['alice'] }));
  layer.observe(url, 'discussion', discussion([], { requestedReviewers: ['alice'] }));
  assert.deepEqual(layer.list(), []);
});

void test('a confirmed patch GitHub never shows expires; a pending one waits for its write', () => {
  const { layer, tick } = harness();
  const confirmed = layer.begin({ url, viewer, change: { action: 'convert-draft' } });
  layer.confirm(confirmed.id);
  layer.begin({ url: 'https://github.com/o/r/pull/2', viewer, change: { action: 'mark-ready' } });
  tick(OPTIMISTIC_CONFIRMED_TTL_MS + 1);
  assert.deepEqual(layer.expire(), [url]);
  assert.equal(layer.metadata(member()).isDraft, false);
  assert.equal(layer.list().length, 1, 'the pending write stays');
});

void test('the main service shows a write at once, then confirms it or rolls it back', async () => {
  const published: string[] = [];
  const service = createOptimisticService({
    viewer: () => viewer,
    before: () => ({ reviewCommentCount: 3, comments: 5 }),
    changed: (target, kinds) => published.push(`${target.slice(-1)}:${kinds.join('+')}`),
  });
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  let finish: (value: GitHubReviewThread) => void = () => {};
  const write = service.run(
    url,
    { action: 'thread-reply', threadId: 't1', body: 'Because.' },
    () => new Promise<GitHubReviewThread>((resolve) => (finish = resolve)),
    (value) => ({ thread: value })
  );
  // Before the write answers.
  assert.equal(service.discussion(url, base).threads[0].comments[1].sending, true);
  assert.equal(published.length, 1);
  finish(thread('t1', [comment('c1', 'Why?'), comment('c2', 'Because.', 'oddur', Date.now())]));
  await write;
  assert.equal(service.discussion(url, base).threads[0].comments[1].id, 'c2');
  assert.equal(published.length, 2, 'confirmation republishes');

  const failing = service.run(url, { action: 'convert-draft' }, () =>
    Promise.reject(Error('Resource not accessible by integration'))
  );
  assert.equal(service.metadata(member()).isDraft, true);
  await assert.rejects(failing, /Resource not accessible/);
  assert.equal(service.metadata(member()).isDraft, false, 'rolled back');
  assert.deepEqual(published.slice(2), ['1:metadata+signals', '1:metadata+signals']);
  service.clear();
  assert.deepEqual(service.layer.list(), []);
});

void test('resolving and new threads follow the unresolved thread ids in the queue signals', () => {
  const { layer } = harness();
  const base = signals({ threads: { unresolved: ['t1', 't2'], complete: true } });
  const resolve = layer.begin({ url, viewer, change: { action: 'thread-resolve', threadId: 't1' } });
  layer.begin({ url, viewer, change: { action: 'review-comment', path: 'a.ts', line: 1, side: 'RIGHT', body: 'New' }, before: { comments: 5 } });
  const shown = layer.signals(base);
  assert.deepEqual(shown.threads?.unresolved, ['t2', 'optimistic:p2']);
  assert.equal(shown.comments, 6);
  layer.confirm(resolve.id);
  // GitHub's signals no longer list t1: resolved there, the patch is done with signals.
  assert.equal(layer.observe(url, 'signals', signals({ threads: { unresolved: ['t2'], complete: true } })), true);
  layer.fail('p2');
  assert.deepEqual(layer.signals(base).threads?.unresolved, ['t1', 't2'], 'a confirmed resolve no longer patches a copy GitHub settled');
});

void test('an optimistic reply or thread by the reader never awaits the reader’s reply', () => {
  const { layer } = harness();
  const base = discussion([thread('t1', [comment('c1', 'Why?')])]);
  layer.begin({ url, viewer, change: { action: 'thread-reply', threadId: 't1', body: 'Because.' } });
  layer.begin({ url, viewer, change: { action: 'review-comment', path: 'a.ts', line: 1, side: 'RIGHT', body: 'Rename.' } });
  const shown = layer.discussion(url, base);
  const own = member({ author: 'oddur', role: 'author', requestedReviewers: [] });
  const needed = responseNeeded(own, 'oddur', undefined, shown);
  assert.equal(needed.awaitingReply, 0, 'the reader answered t1 and started the new thread');
  assert.equal(needed.unresolvedThreads, 2, 'both threads count as unresolved, as on GitHub');
  assert.equal(responseNeeded(own, 'oddur', undefined, base).awaitingReply, 1);
});

void test('a comment count from the other API neither confirms nor drops an optimistic comment', () => {
  const { layer } = harness();
  const metadata = (reviewCommentCount: number, source: 'graphql' | 'rest') =>
    ({ url, isDraft: false, autoMerge: null, requestedReviewers: [], reviewCommentCount, source }) as unknown as Parameters<
      typeof layer.metadata
    >[0];
  // The count before the reply came from GraphQL: 7.
  const patch = layer.begin({
    url,
    viewer,
    change: { action: 'thread-reply', threadId: 'T1', body: 'Done.' },
    before: { reviewCommentCount: 7, source: 'graphql' },
  });
  layer.confirm(patch.id, { comment: { id: 'C9', url: `${url}#discussion_r9` } });
  // A REST copy whose counter already reads 8 (or more) is not proof: the patch keeps applying.
  assert.equal(layer.observe(url, 'metadata', metadata(9, 'rest')), false);
  assert.equal(layer.metadata(metadata(6, 'rest')).reviewCommentCount, 8, 'a lagging REST copy still shows the reply');
  assert.ok(layer.list(url).length, 'not dropped');
  // A GraphQL copy that shows the reply settles the metadata.
  assert.equal(layer.observe(url, 'metadata', metadata(8, 'graphql')), true);
  // The same rule for a delete: GraphQL 8 before; a lagging REST 7 is not proof, GraphQL 7 is.
  const removal = layer.begin({
    url,
    viewer,
    change: { action: 'comment-delete', threadId: 'T1', commentId: 'C1' },
    before: { reviewCommentCount: 8, source: 'graphql' },
  });
  layer.confirm(removal.id);
  assert.equal(layer.observe(url, 'metadata', metadata(7, 'rest')), false);
  assert.equal(layer.metadata(metadata(8, 'rest')).reviewCommentCount, 7);
  assert.equal(layer.observe(url, 'metadata', metadata(7, 'graphql')), true);
});
