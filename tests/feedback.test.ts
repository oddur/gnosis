import {
  hydrateDiscussion,
  readDiscussion,
  peekDiscussion,
  setDiscussionAccount,
} from '../lib/review-discussion-cache';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import { createReviewThreadService } from '../src/review-thread-service';
import {
  feedbackCodeContext,
  feedbackOptionsKey,
  isGitHubActionsFeedback,
  feedbackItems,
  feedbackFingerprint,
  feedbackReadKey,
  feedbackReviewers,
  feedbackActivity,
} from '../lib/feedback';
import type { GitHubReviewThreads } from '../lib/review-threads';
import type { ReviewMember } from '../lib/workbench';
const url = 'https://github.com/o/r/pull/1';
const comment = {
  id: 'C1',
  body: 'Keep the cancellation guard.',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  url: `${url}#issuecomment-1`,
  author: { login: 'maya', avatarUrl: '' },
};
const review = { ...comment, id: 'R1', state: 'CHANGES_REQUESTED', submittedAt: comment.createdAt };
const thread = {
  id: 'T1',
  path: 'src/run.ts',
  line: 2,
  startLine: null,
  diffSide: 'RIGHT' as const,
  isResolved: false,
  isOutdated: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: [{ ...comment, id: 'TC1', diffHunk: '@@ -1 +1 @@\n-old\n+new', pullRequestReview: { id: 'R1' } }],
};
const snapshot: GitHubReviewThreads = {
  headSha: 'head',
  baseSha: 'base',
  threads: [thread],
  feedback: { comments: [comment], reviews: [review], requestedReviewers: [], viewerCanUpdate: true, state: 'OPEN' },
};
const member = { url, number: 1, title: 'Keep pending requests safe' } as ReviewMember;
const page = <T>(nodes: T[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor },
});
function harness({ paginate = false, denied = false, requested = false, approved = false } = {}) {
  const writes: unknown[] = [],
    reads: string[] = [];
  const client = {
    request: async (_route: string, input: { query: string; variables: Record<string, unknown> }) => {
      await Promise.resolve();
      reads.push(input.query);
      const pr = input.query.includes('query FeedbackPage')
        ? { comments: page([{ ...comment, id: 'C2' }]) }
        : {
            headRefOid: 'head',
            baseRefOid: 'base',
            reviewThreads: page([{ ...thread, comments: page(thread.comments) }]),
            comments: page([comment], paginate ? 'more' : null),
            reviews: page([{ ...review, state: approved ? 'APPROVED' : review.state }]),
            reviewRequests: page(requested ? [{ requestedReviewer: { login: 'maya' } }] : []),
            viewerCanUpdate: !denied,
            state: 'OPEN',
          };
      return { data: { data: { repository: { pullRequest: pr } } } };
    },
    issues: {
      createComment: async (input: unknown) => {
        await Promise.resolve();
        writes.push(input);
      },
    },
    pulls: {
      requestReviewers: async (input: unknown) => {
        await Promise.resolve();
        writes.push(input);
      },
    },
  } as unknown as Octokit;
  return { client, reads, writes, service: createReviewThreadService() };
}
void test('feedback loads and paginates reviews/comments in the shared discussion read', async () => {
  const h = harness({ paginate: true });
  const result = await h.service.list(h.client, url);
  assert.equal(result.feedback?.comments.length, 2);
  assert.equal(result.threads[0].comments[0].diffHunk, thread.comments[0].diffHunk);
  assert.equal(h.reads.length, 2);
  await h.service.list(h.client, url);
  assert.equal(h.reads.length, 2, 'Shared cache must avoid another read');
});
void test('general replies validate ownership and link their source without pretending to be a GitHub thread', async () => {
  const h = harness();
  await assert.rejects(
    h.service.feedbackAction(h.client, { prUrl: url, action: 'reply', sourceId: 'foreign', body: 'Done' }),
    /does not belong/
  );
  assert.equal(h.writes.length, 0);
  await h.service.feedbackAction(h.client, { prUrl: url, action: 'reply', sourceId: 'R1', body: 'Guard retained.' });
  assert.deepEqual(h.writes, [
    { owner: 'o', repo: 'r', issue_number: 1, body: `In reply to [this feedback](${review.url}):\n\nGuard retained.` },
  ]);
});
void test('review requests refresh permissions and decisions, target one reviewer, and avoid duplicate requests', async () => {
  for (const config of [{ denied: true }, { approved: true }]) {
    const h = harness(config);
    await assert.rejects(
      h.service.feedbackAction(h.client, { prUrl: url, action: 'request-review', reviewer: 'maya' })
    );
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  await h.service.feedbackAction(h.client, { prUrl: url, action: 'request-review', reviewer: 'maya' });
  assert.deepEqual(h.writes, [{ owner: 'o', repo: 'r', pull_number: 1, reviewers: ['maya'] }]);
  const already = harness({ requested: true });
  await already.service.feedbackAction(already.client, { prUrl: url, action: 'request-review', reviewer: 'maya' });
  assert.equal(already.writes.length, 0);
});
void test('unread is account/source scoped, changes on incoming edits/replies but not own replies', () => {
  const item = feedbackItems(member, snapshot).find((i) => i.kind === 'thread');
  assert.ok(item);
  const first = feedbackFingerprint(item, 'oddur');
  item.comments = [...item.comments, { ...comment, id: 'own', author: { login: 'oddur', avatarUrl: '' } }];
  assert.equal(feedbackFingerprint(item, 'oddur'), first);
  item.comments.push({ ...comment, id: 'new' });
  assert.notEqual(feedbackFingerprint(item, 'oddur'), first);
  assert.notEqual(feedbackReadKey('oddur', item), feedbackReadKey('other', item));
  assert.notEqual(
    feedbackReadKey('oddur', item),
    feedbackReadKey('oddur', { ...item, member: { ...member, url: url + '2' } })
  );
  const summary = feedbackItems(member, snapshot).find((i) => i.kind === 'review');
  assert.ok(summary);
  assert.deepEqual(summary.relatedThreads, ['T1']);
});
void test('later approvals/dismissals supersede change requests without resolving code threads', () => {
  assert.equal(feedbackReviewers(snapshot)[0].unresolved, 1);
  const next = structuredClone(snapshot);
  assert.ok(next.feedback);
  next.feedback.reviews.push({ ...review, id: 'R2', state: 'APPROVED', submittedAt: '2026-11-02T10:00:00Z' });
  assert.equal(feedbackReviewers(next).length, 0);
  assert.equal(next.threads[0].isResolved, false);
});

void test('stack-wide activity ordering includes replies and edits without losing source identity', () => {
  const first = feedbackItems(member, snapshot).find((item) => item.kind === 'thread');
  assert.ok(first);
  const second = {
    ...first,
    member: { ...member, url: url + '2', number: 12 },
    comments: [{ ...comment, id: 'later', updatedAt: '2026-11-04T12:00:00Z' }],
  };
  assert.equal(
    [first, second].sort((a, b) => feedbackActivity(b).localeCompare(feedbackActivity(a)))[0].member.number,
    12
  );
});

void test('disk hydration displays immediately without discarding an in-flight newer refresh', async () => {
  let finish!: (value: GitHubReviewThreads) => void;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        getReviewThreads: () =>
          new Promise<GitHubReviewThreads>((resolve) => {
            finish = resolve;
          }),
      },
    },
  });
  try {
    setDiscussionAccount('hydration-test');
    const request = readDiscussion(url, true);
    hydrateDiscussion(url, { ...snapshot, checkedAt: 10 });
    assert.equal(peekDiscussion(url)?.checkedAt, 10);
    finish({ ...snapshot, checkedAt: 20 });
    assert.equal((await request).checkedAt, 20);
    assert.equal(peekDiscussion(url)?.checkedAt, 20);
  } finally {
    setDiscussionAccount('');
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

void test('GitHub Actions filter hides either login spelling but keeps human and unknown-author replies', () => {
  const item = feedbackItems(member, snapshot)[0];
  for (const login of ['github-actions', 'github-actions[bot]', 'GitHub-Actions[BOT]']) {
    const bot = { ...comment, author: { login, avatarUrl: '' } };
    assert.equal(isGitHubActionsFeedback({ ...item, comments: [bot] }), true);
    assert.equal(isGitHubActionsFeedback({ ...item, comments: [bot, comment] }), false);
    assert.equal(isGitHubActionsFeedback({ ...item, comments: [bot, { ...comment, author: null }] }), false);
  }
  assert.equal(isGitHubActionsFeedback({ ...item, comments: [] }), false);
  assert.equal(isGitHubActionsFeedback({ ...item, comments: [comment] }), false);
  assert.equal(feedbackOptionsKey('ODDUR'), feedbackOptionsKey('oddur'));
  assert.notEqual(feedbackOptionsKey('maya'), feedbackOptionsKey('oddur'));
});

void test('Code feedback uses current coordinates only on the matching revision and side', () => {
  const active = { ...thread, isOutdated: false };
  const displayed = { headSha: 'head', baseSha: 'base' };
  assert.equal(feedbackCodeContext(active, snapshot, displayed), 'current');
  assert.equal(feedbackCodeContext(thread, snapshot, displayed), 'earlier');
  assert.equal(feedbackCodeContext(active, snapshot, { ...displayed, headSha: 'new-head' }), 'earlier');
  assert.equal(
    feedbackCodeContext({ ...active, diffSide: 'LEFT' }, snapshot, { ...displayed, baseSha: 'new-base' }),
    'earlier'
  );
  assert.equal(feedbackCodeContext(active, snapshot, { ...displayed, baseSha: 'new-base' }), 'current');
  assert.equal(feedbackCodeContext({ ...active, line: null }, snapshot, displayed), 'unavailable');
  assert.equal(feedbackCodeContext(active, snapshot, undefined), 'unavailable');
  assert.equal(feedbackCodeContext(active, undefined, displayed), 'unavailable');
});

void test('Feedback carries both revision SHAs for safe links back to Changes', () => {
  const items = feedbackItems(member, { ...snapshot, threads: [{ ...thread, isOutdated: false, diffSide: 'LEFT' }] });
  const item = items.find((item) => item.kind === 'thread');
  assert.ok(item?.thread);
  assert.equal(item.headSha, 'head');
  assert.equal(item.baseSha, 'base');
  assert.equal(
    feedbackCodeContext(
      item.thread,
      { headSha: item.headSha, baseSha: item.baseSha },
      { headSha: 'head', baseSha: 'retargeted-base' }
    ),
    'earlier'
  );
});

void test('response evidence excludes own/resolved/automation-only threads and retains outdated feedback', async () => {
  const { responseNeeded, needsResponse } = await import('../lib/response-needed');
  const own = { ...member, state: 'open', merged: false, author: 'oddur', headSha: 'head' } as ReviewMember;
  const data = structuredClone(snapshot);
  data.feedback!.reviews = [];
  data.threads = [
    { ...thread, id: 'old', isOutdated: true },
    { ...thread, id: 'resolved', isResolved: true },
    { ...thread, id: 'own', comments: [{ ...comment, author: { login: 'ODDUR', avatarUrl: '' } }] },
    { ...thread, id: 'bot', comments: [{ ...comment, author: { login: 'github-actions[bot]', avatarUrl: '' } }] },
  ];
  assert.deepEqual(responseNeeded(own, 'ODDUR', undefined, data), { changesRequested: false, unresolvedThreads: 1, complete: true });
  assert.equal(needsResponse(responseNeeded({ ...own, author: 'someone' }, 'oddur', undefined, data)), false);
  assert.equal(needsResponse(responseNeeded({ ...own, state: 'closed' }, 'oddur', undefined, data)), false);
  assert.equal(responseNeeded(own, 'oddur').complete, false);
  assert.equal(responseNeeded({ ...own, headSha: 'new' }, 'oddur', undefined, data).complete, false);
});

void test('changes requested persists through a comment and clears after approval or dismissal', async () => {
  const { responseNeeded } = await import('../lib/response-needed');
  const own = { ...member, state: 'open', merged: false, author: 'oddur', headSha: 'head' } as ReviewMember;
  const data = structuredClone(snapshot);
  const original = { ...review, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-01T10:00:00Z' };
  data.feedback!.reviews = [original, { ...original, id: 'commented', state: 'COMMENTED', submittedAt: '2026-11-02T10:00:00Z' }];
  assert.equal(responseNeeded(own, 'oddur', undefined, data).changesRequested, true);
  for (const state of ['APPROVED', 'DISMISSED']) {
    data.feedback!.reviews = [original, { ...original, id: 'new', state, submittedAt: '2026-11-03T10:00:00Z' }];
    assert.equal(responseNeeded(own, 'oddur', undefined, data).changesRequested, false);
  }
});

void test('response decisions use current revision signals and newer review evidence', async () => {
  const { responseNeeded } = await import('../lib/response-needed');
  const own = { ...member, state: 'open', merged: false, author: 'oddur', headSha: 'head' } as ReviewMember;
  const signals = { url, headSha: 'head', checkedAt: 20, readiness: { reviewDecision: 'CHANGES_REQUESTED' } } as import('../lib/queue-signals').QueueSignals;
  assert.equal(responseNeeded(own, 'oddur', signals).changesRequested, true);
  assert.equal(responseNeeded({ ...own, headSha: 'new' }, 'oddur', signals).changesRequested, false);
  const data = structuredClone(snapshot);
  data.checkedAt = 30;
  data.feedback!.reviews = [{ ...review, state: 'APPROVED' }];
  assert.equal(responseNeeded(own, 'oddur', signals, data).changesRequested, false, 'A newer approval supersedes old queue signals');
  data.checkedAt = 10;
  assert.equal(responseNeeded(own, 'oddur', signals, data).changesRequested, true, 'Fresh signals supersede old review evidence');
});

void test('response links select the exact kind of outstanding feedback, ignoring own and superseded reviews', async () => {
  const { responseFeedbackTarget } = await import('../lib/feedback');
  const data = structuredClone(snapshot);
  data.threads.unshift({ ...thread, id: 'own', comments: [{ ...comment, author: { login: 'oddur', avatarUrl: '' } }] });
  const items = feedbackItems(member, data);
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response-threads')?.id, 'T1');
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response-review')?.id, 'R1');
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response')?.id, 'R1');
  data.feedback!.reviews.push({ ...review, id: 'new-comment', state: 'COMMENTED', submittedAt: '2026-11-02T10:00:00Z' });
  assert.equal(feedbackReviewers(data).length, 1, 'A comment does not withdraw changes requested');
  data.feedback!.reviews.push({ ...review, id: 'approved', state: 'APPROVED', submittedAt: '2026-11-03T10:00:00Z' });
  assert.equal(responseFeedbackTarget(feedbackItems(member, data), 'oddur', 'response-review'), undefined);
  assert.equal(responseFeedbackTarget(feedbackItems(member, data), 'oddur', 'response')?.id, 'T1');
  data.threads = data.threads.map(thread => ({ ...thread, isResolved: true }));
  assert.equal(responseFeedbackTarget(feedbackItems(member, data), 'oddur', 'response'), undefined);
});
