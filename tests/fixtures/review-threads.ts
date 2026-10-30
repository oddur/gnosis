import type { GitHubReviewThread, GitHubReviewThreads, ReviewThreadAction } from '../../lib/review-threads';

const comment = {
  id: 'comment-1',
  databaseId: 101,
  body: 'Should cancellation release the queue slot? **Please check the failure path.**',
  createdAt: '2026-10-23T12:00:00Z',
  url: 'https://github.com/klang/engine/pull/121#discussion_r101',
  author: { login: 'maya', avatarUrl: '' },
};
const thread: GitHubReviewThread = {
  id: 'thread-right',
  path: 'src/command-queue.ts',
  line: 4,
  startLine: null,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: [
    comment,
    {
      ...comment,
      id: 'reply-existing',
      databaseId: 102,
      body: 'The finally block should cover it.',
      author: { login: 'alex', avatarUrl: '' },
    },
  ],
};
export function threadMocks() {
  const data: GitHubReviewThreads = {
    headSha: 'head-1',
    baseSha: 'base-1',
    threads: [
      thread,
      {
        ...thread,
        id: 'thread-left',
        line: 2,
        diffSide: 'LEFT',
        comments: [{ ...comment, id: 'left', body: 'This old path could leak a queue slot.' }],
      },
      {
        ...thread,
        id: 'thread-resolved',
        line: 7,
        isResolved: true,
        viewerCanResolve: false,
        viewerCanUnresolve: true,
      },
      { ...thread, id: 'thread-outdated', line: null, isOutdated: true },
      { ...thread, id: 'thread-outside', line: 99 },
      { ...thread, id: 'thread-other-file', path: 'other-file.ts' },
    ],
  };
  return {
    getReviewThreads: (prUrl: string) => {
      const requested = JSON.parse(document.body.dataset.discussionPrs ?? '[]') as string[];
      document.body.dataset.discussionPrs = JSON.stringify([...new Set([...requested, prUrl])]);
      if (document.body.dataset.discussionFail === 'true')
        return Promise.reject(new Error('GitHub requests can resume after the rate limit resets.'));
      return Promise.resolve(
        structuredClone({
          ...data,
          headSha: document.body.dataset.discussionStale === 'true' ? 'new-head' : data.headSha,
        })
      );
    },
    reviewThreadAction: (req: ReviewThreadAction) => {
      document.body.dataset.discussionAction = JSON.stringify(req);
      if (document.body.dataset.replyFail === 'true')
        return Promise.reject(new Error('You do not have permission to reply.'));
      const target = data.threads.find((t) => t.id === req.threadId);
      if (!target) return Promise.reject(new Error('Unknown thread'));
      if (req.action === 'reply')
        target.comments = [
          ...target.comments,
          { ...comment, id: 'new-reply', body: req.body ?? '', author: { login: 'you', avatarUrl: '' } },
        ];
      else {
        target.isResolved = req.action === 'resolve';
        target.viewerCanResolve = !target.isResolved;
        target.viewerCanUnresolve = target.isResolved;
      }
      return Promise.resolve(structuredClone(target));
    },
  };
}
