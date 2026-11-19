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
  // GitHub counts every unresolved conversation, automation and your own included. Only Maya's waits for you.
  assert.deepEqual(responseNeeded(own, 'ODDUR', undefined, data), {
    changesRequested: false,
    unresolvedThreads: 3,
    awaitingReply: 1,
    complete: true,
  });
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
  const own = { ...member, author: 'oddur' } as ReviewMember;
  const items = feedbackItems(own, data);
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response-threads')?.id, 'T1');
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response-review')?.id, 'R1');
  assert.equal(responseFeedbackTarget(items, 'oddur', 'response')?.id, 'R1');
  data.feedback!.reviews.push({ ...review, id: 'new-comment', state: 'COMMENTED', submittedAt: '2026-11-02T10:00:00Z' });
  assert.equal(feedbackReviewers(data).length, 1, 'A comment does not withdraw changes requested');
  data.feedback!.reviews.push({ ...review, id: 'approved', state: 'APPROVED', submittedAt: '2026-11-03T10:00:00Z' });
  assert.equal(responseFeedbackTarget(feedbackItems(own, data), 'oddur', 'response-review'), undefined);
  assert.equal(responseFeedbackTarget(feedbackItems(own, data), 'oddur', 'response')?.id, 'T1');
  data.threads = data.threads.map(thread => ({ ...thread, isResolved: true }));
  assert.equal(responseFeedbackTarget(feedbackItems(own, data), 'oddur', 'response'), undefined);
});

// Real GitHub shapes, with synthetic people. A comment's author, its review state and whether it is hidden.
const by = (login: string, id: string, extra: Record<string, unknown> = {}) => ({
  ...comment,
  id,
  author: { login, avatarUrl: '' } as { login: string; avatarUrl: string; __typename?: string },
  pullRequestReview: { id: `review-${id}`, state: 'COMMENTED' },
  ...extra,
});
const conversation = (id: string, ...comments: ReturnType<typeof by>[]) => ({ ...thread, id, isOutdated: false, comments });
const own = { ...member, state: 'open', merged: false, author: 'oddur', headSha: 'head' } as ReviewMember;

void test('a thread waits for you when its last human comment is from someone else, whoever started it', async () => {
  const { isResponseThread, isUnresolvedThread } = await import('../lib/response-needed');
  const started = conversation('started', by('oddur', 'a'), by('jan', 'b'));
  const answered = conversation('answered', by('jan', 'a'), by('oddur', 'b'));
  assert.equal(isResponseThread(started, 'oddur', 'oddur'), true, 'You asked, a reviewer answered');
  assert.equal(isUnresolvedThread(answered), true);
  assert.equal(isResponseThread(answered, 'oddur', 'oddur'), false, 'You replied last');
  // Bots neither ask for nor give a reply; hidden comments do not either.
  const botLast = conversation('bot', by('jan', 'a'), by('oddur', 'b'), by('github-actions', 'c'));
  assert.equal(isResponseThread(botLast, 'oddur', 'oddur'), false);
  assert.equal(isResponseThread(conversation('app', by('copilot-pull-request-reviewer', 'a', { author: { login: 'copilot-pull-request-reviewer', avatarUrl: '', __typename: 'Bot' } })), 'oddur', 'oddur'), false);
  const hiddenLast = conversation('hidden', by('oddur', 'a'), by('jan', 'b', { isMinimized: true, minimizedReason: 'outdated' }));
  assert.equal(isResponseThread(hiddenLast, 'oddur', 'oddur'), false);
  // Someone else's PR: only threads you joined wait for you.
  assert.equal(isResponseThread(conversation('theirs', by('jan', 'a')), 'oddur', 'maya'), false);
  assert.equal(isResponseThread(started, 'oddur', 'maya'), true);
});

void test('the unresolved count matches GitHub; "needs your response" counts only threads waiting for you', async () => {
  const { responseNeeded } = await import('../lib/response-needed');
  const data = structuredClone(snapshot);
  data.feedback!.reviews = [];
  // klanggames/service-wallet#68: six unresolved, one of them outdated and started by the PR author.
  data.threads = [
    conversation('w1', by('alim', 'a'), by('jan', 'b')),
    conversation('w2', by('alim', 'a')),
    conversation('w3', by('alim', 'a')),
    conversation('w4', by('alim', 'a')),
    conversation('w5', by('jan', 'a')),
    { ...conversation('w6', by('oddur', 'a'), by('jan', 'b')), isOutdated: true },
  ];
  assert.deepEqual(responseNeeded(own, 'oddur', undefined, data), {
    changesRequested: false,
    unresolvedThreads: 6,
    awaitingReply: 6,
    complete: true,
  });
  // klanggames/seed#25117: seven unresolved, you wrote the last comment in five of them.
  data.threads = [
    conversation('s1', by('marijnz', 'a'), by('oddur', 'b')),
    conversation('s2', by('marijnz', 'a'), by('oddur', 'b')),
    conversation('s3', by('marijnz', 'a'), by('ivan', 'b'), by('oddur', 'c')),
    conversation('s4', by('ivan', 'a'), by('ivan', 'b'), by('oddur', 'c'), by('ivan', 'd')),
    conversation('s5', by('ivan', 'a'), by('oddur', 'b')),
    conversation('s6', by('ivan', 'a'), by('oddur', 'b'), by('ivan', 'c')),
    { ...conversation('s7', by('ivan', 'a'), by('oddur', 'b')), isOutdated: true },
  ];
  const result = responseNeeded(own, 'oddur', undefined, data);
  assert.equal(result.unresolvedThreads, 7);
  assert.equal(result.awaitingReply, 2);
});

void test('your pending review comments are marked, never counted and never unread', async () => {
  const { responseNeeded, isUnresolvedThread, isResponseThread } = await import('../lib/response-needed');
  const { isPendingComment } = await import('../lib/review-threads');
  const pending = { pullRequestReview: { id: 'draft-review', state: 'PENDING' } };
  // klanggames/seed#9413 shape: a reviewer's thread with your unsubmitted reply.
  const draftReply = conversation('draft-reply', by('mike', 'a'), by('oddur', 'b', pending));
  const draftOnly = conversation('draft-only', by('oddur', 'a', pending));
  assert.equal(isPendingComment(draftReply.comments[1]), true);
  assert.equal(isResponseThread(draftReply, 'oddur', 'oddur'), true, 'An unsubmitted reply answers nobody yet');
  assert.equal(isUnresolvedThread(draftOnly), false, 'GitHub shows nobody else this thread');
  const data = structuredClone(snapshot);
  data.feedback!.reviews = [];
  data.threads = [draftReply, draftOnly];
  assert.deepEqual(responseNeeded(own, 'oddur', undefined, data), {
    changesRequested: false,
    unresolvedThreads: 1,
    awaitingReply: 1,
    complete: true,
  });
  const [item] = feedbackItems(member, { ...data, threads: [draftOnly] });
  assert.equal(feedbackFingerprint(item, 'someone-else'), '', 'Pending comments never make feedback unread');
});

void test('an inline comment appears once in Feedback, not also as its empty comment review', () => {
  const data = structuredClone(snapshot);
  const inline = { ...comment, id: 'TC9', pullRequestReview: { id: 'R9', state: 'COMMENTED' } };
  data.threads = [{ ...thread, id: 'T9', comments: [inline] }];
  data.feedback!.comments = [];
  data.feedback!.reviews = [
    // GitHub's wrapper for the inline comment: COMMENTED, no body.
    { ...review, id: 'R9', state: 'COMMENTED', body: '' },
    // A comment review with a summary is its own feedback.
    { ...review, id: 'R10', state: 'COMMENTED', body: 'Two small things inline.' },
    // An empty comment review whose thread is gone stays as an event.
    { ...review, id: 'R11', state: 'COMMENTED', body: '' },
  ];
  data.threads[0].comments.push({ ...inline, id: 'TC10', pullRequestReview: { id: 'R10', state: 'COMMENTED' } });
  assert.deepEqual(
    feedbackItems(member, data).map((item) => item.id).sort(),
    ['R10', 'R11', 'T9']
  );
});

void test('hidden comments never make feedback unread', () => {
  const data = structuredClone(snapshot);
  data.feedback!.reviews = [];
  data.threads = [];
  data.feedback!.comments = [{ ...comment, isMinimized: true, minimizedReason: 'outdated' }];
  const [item] = feedbackItems(member, data);
  assert.equal(feedbackFingerprint(item, 'oddur'), '');
});

void test('newer signals carry resolutions made on github.com; a stale discussion keeps its last count', async () => {
  const { responseNeeded } = await import('../lib/response-needed');
  const data = structuredClone(snapshot);
  data.feedback!.reviews = [];
  data.checkedAt = 10;
  data.threads = [conversation('a', by('jan', 'a')), conversation('b', by('jan', 'b'))];
  const signals = (unresolved: string[], checkedAt = 20, complete = true) =>
    ({ url, headSha: 'head', checkedAt, comments: 2, checks: { state: 'success', passed: 0, total: 0 }, threads: { unresolved, complete } }) as import('../lib/queue-signals').QueueSignals;
  assert.equal(responseNeeded(own, 'oddur', undefined, data).awaitingReply, 2);
  const resolved = responseNeeded(own, 'oddur', signals(['a']), data);
  assert.equal(resolved.unresolvedThreads, 1, 'Thread b was resolved on github.com');
  assert.equal(resolved.awaitingReply, 1);
  assert.equal(responseNeeded(own, 'oddur', signals(['a'], 5), data).unresolvedThreads, 2, 'Older signals lose to the discussion');
  assert.equal(responseNeeded(own, 'oddur', signals(['a'], 20, false), data).unresolvedThreads, 2, 'Past 100 threads, absence proves nothing');
  // A thread started after the discussion was read: counted, but its author is unknown until it is read again.
  const started = responseNeeded(own, 'oddur', signals(['a', 'b', 'new']), data);
  assert.equal(started.unresolvedThreads, 3);
  assert.equal(started.awaitingReply, 2);
  assert.equal(started.complete, false);
  // New activity marked the discussion stale: the count stays, flagged incomplete, instead of dropping to 0.
  const stale = responseNeeded(own, 'oddur', undefined, { ...data, stale: true });
  assert.equal(stale.awaitingReply, 2);
  assert.equal(stale.complete, false);
});

void test('the Changes file tree counts conversations open on the current diff', async () => {
  const { isOpenOnCurrentDiff, openDiffComments } = await import('../lib/response-needed');
  // klanggames/seed#27707 shape: half of the unresolved threads are outdated.
  assert.equal(
    openDiffComments([
      conversation('open', by('jan', 'a'), by('oddur', 'b'), by('oddur', 'c', { pullRequestReview: { id: 'p', state: 'PENDING' } })),
      { ...conversation('old', by('jan', 'a')), isOutdated: true },
      { ...conversation('done', by('jan', 'a')), isResolved: true },
    ]),
    2
  );
  assert.equal(isOpenOnCurrentDiff(conversation('open', by('jan', 'a'))), true);
  assert.equal(isOpenOnCurrentDiff({ ...conversation('old', by('jan', 'a')), isOutdated: true }), false);
  assert.equal(isOpenOnCurrentDiff({ ...conversation('done', by('jan', 'a')), isResolved: true }), false);
  assert.equal(isOpenOnCurrentDiff(conversation('draft', by('oddur', 'a', { pullRequestReview: { id: 'p', state: 'PENDING' } }))), false);
});

void test('the Feedback timeline reads oldest first, groups pushes and repeated bots, and maps GitHub events', async () => {
  const { buildTimeline, botSummary } = await import('../lib/feedback-timeline');
  const { feedbackEvents } = await import('../src/review-thread-service');
  type Item = ReturnType<typeof feedbackItems>[number];
  const owner = { ...member, description: 'Keep uploads ordered.', createdAt: '2026-11-01T08:00:00Z', author: 'oddur' } as ReviewMember;
  const say = (id: string, login: string, at: string, bot = false) =>
    ({ id, member: owner, kind: 'comment', relatedThreads: [], comments: [{ ...comment, id, createdAt: at, updatedAt: at, author: { login, avatarUrl: '', ...(bot ? { __typename: 'Bot' } : {}) } }] }) as Item;
  const events = feedbackEvents([
    { __typename: 'PullRequestCommit', id: 'k1', commit: { oid: 'a'.repeat(40), messageHeadline: 'One', committedDate: '2026-11-01T09:00:00Z', author: { name: 'Oddur', user: { login: 'oddur' } } } },
    { __typename: 'PullRequestCommit', id: 'k2', commit: { oid: 'b'.repeat(40), messageHeadline: 'Two', committedDate: '2026-11-01T09:01:00Z', author: { name: 'Oddur', user: { login: 'oddur' } } } },
    { __typename: 'HeadRefForcePushedEvent', id: 'f1', createdAt: '2026-11-01T11:00:00Z', actor: { login: 'oddur' }, beforeCommit: { oid: 'b'.repeat(40) }, afterCommit: { oid: 'c'.repeat(40) } },
    { __typename: 'ReviewRequestedEvent', id: 'q1', createdAt: '2026-11-01T12:00:00Z', actor: { login: 'oddur' }, requestedReviewer: { name: 'core-team' } },
    { __typename: 'ReviewRequestedEvent', id: 'q2', createdAt: '2026-11-01T12:00:00Z', actor: null, requestedReviewer: null },
    { __typename: 'MergedEvent', id: 'm1', createdAt: '2026-11-02T08:00:00Z', actor: { login: 'maya' } },
  ]);
  assert.deepEqual(events.map((e) => e.kind), ['commit', 'commit', 'force-push', 'review-requested', 'merged'], 'Requests with no reviewer are skipped');
  const timeline = buildTimeline(
    [owner],
    [
      say('ci-1', 'github-actions[bot]', '2026-11-01T10:00:00Z', true),
      say('ci-2', 'github-actions[bot]', '2026-11-01T10:01:00Z', true),
      say('ci-3', 'github-actions[bot]', '2026-11-01T10:02:00Z', true),
      say('human', 'maya', '2026-11-01T10:30:00Z'),
      say('lone', 'linear[bot]', '2026-11-01T13:00:00Z'),
    ],
    new Map([[owner.url, { events }]])
  );
  assert.deepEqual(
    timeline.map((e) => e.type),
    ['description', 'commits', 'bots', 'item', 'event', 'event', 'item', 'event'],
    'Description, one push, one bot row, a person, a force-push, a request, a lone bot, the merge'
  );
  assert.equal(timeline[1].type === 'commits' && timeline[1].commits.length, 2);
  assert.equal(timeline[2].type === 'bots' && timeline[2].items.length, 3);
  assert.equal(timeline[6].type === 'item' && timeline[6].bot, true, 'A [bot] login is quiet even without its type');
  assert.deepEqual(
    buildTimeline([owner], [say('human', 'maya', '2026-11-01T10:30:00Z')], new Map([[owner.url, { events }]]), { conversationOnly: true }).map((e) => e.type),
    ['item'],
    'Filtered views show conversations only'
  );
  assert.equal(botSummary(['A', 'B', 'C', 'D']), 'A, B, C, …');
});

void test('Feedback previews read bot HTML as text, and find mentions, anchors and order', async () => {
  const { plainCommentText, mentionsAccount, diffHunkAnchor, sortFeedback, chronologicalThread } = await import('../lib/feedback');
  // klanggames/seed#36138: Linear's link-back comment showed its raw tags in the list.
  assert.equal(
    plainCommentText('<!-- linear-linkback -->\n<details>\n<summary><a href="https://linear.app/x">SEED-412 Confirm uploads</a></summary>\n<p>Linked &amp; tracked.</p>\n</details>'),
    'SEED-412 Confirm uploads Linked & tracked.'
  );
  assert.equal(plainCommentText('## Keep [the guard](https://x) on **`retries`**'), 'Keep the guard on retries');
  type Item = Parameters<typeof mentionsAccount>[0];
  const item = (body: string, login = 'sam') =>
    ({ id: 'i', member, kind: 'comment', comments: [{ ...comment, body, author: { login, avatarUrl: '' } }], relatedThreads: [] }) as Item;
  assert.equal(mentionsAccount(item('@Oddur can you check?'), 'oddur'), true);
  assert.equal(mentionsAccount(item('cc @oddur-bot'), 'oddur'), false);
  assert.equal(mentionsAccount(item('see org/@oddur'), 'oddur'), false);
  assert.equal(mentionsAccount(item('@oddur note to self', 'oddur'), 'oddur'), false, 'Your own comments do not mention you');
  // GitHub's hunk ends on the commented line, on either side.
  assert.deepEqual(diffHunkAnchor('@@ -33,7 +33,7 @@\n a\n b\n-c\n+d'), { line: 35, side: 'RIGHT' });
  assert.deepEqual(diffHunkAnchor('@@ -10,3 +10,2 @@ fn()\n a\n-b'), { line: 11, side: 'LEFT' });
  assert.equal(diffHunkAnchor('not a hunk'), undefined);
  const thread = (id: string, path: string, line: number | null, at: string) =>
    ({
      id,
      member,
      kind: 'thread',
      comments: [{ ...comment, createdAt: at, updatedAt: at, diffHunk: '@@ -1,1 +1,2 @@\n a\n+b' }],
      relatedThreads: [],
      thread: { id, path, line, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: line === null, viewerCanResolve: true, viewerCanUnresolve: false, comments: [] },
    }) as Item;
  const general = { ...item('Looks good'), id: 'g', comments: [{ ...comment, createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z' }] };
  const items = [thread('b20', 'b.ts', 20, '2026-11-05T00:00:00Z'), thread('a9', 'a.ts', 9, '2026-11-02T00:00:00Z'), general, thread('b-old', 'b.ts', null, '2026-11-04T00:00:00Z')];
  assert.deepEqual(sortFeedback(items, 'file').map((i) => i.id), ['g', 'a9', 'b-old', 'b20'], 'PR conversation first, then path and line');
  assert.deepEqual(sortFeedback(items, 'activity').map((i) => i.id), ['b20', 'b-old', 'a9', 'g']);
  const out = chronologicalThread({ comments: [{ createdAt: '2026-11-02' }, { createdAt: '2026-11-01' }] });
  assert.deepEqual(out.comments.map((c) => c.createdAt), ['2026-11-01', '2026-11-02']);
});
