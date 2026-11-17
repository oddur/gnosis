import { createOptimisticService } from '../../src/optimistic-service';
import { prActionChange, type OptimisticChange, type OptimisticResult } from '../../lib/optimistic-patches';
import type { GitHubSyncInterest, GitHubSyncUpdate } from '../../lib/github-sync';
import type { QueueSignalRequest, QueueSignals } from '../../lib/queue-signals';
import {
  feedbackReplyBody,
  type CreateReviewCommentRequest,
  type FeedbackAction,
  type GitHubReviewComment,
  type GitHubReviewThreads,
  type ReviewCommentAction,
  type ReviewThreadAction,
} from '../../lib/review-threads';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../../lib/workbench';

/**
 * Main's optimistic layer, with a synthetic GitHub whose writes wait until the test settles them. The real
 * `createOptimisticService` stands in for main: it patches every copy the page reads and pushes changes like main
 * does. GitHub's own copies change only when a write succeeds, and the page sees them only on `refresh`, like the
 * follow-up reads after a write. Nothing here reaches GitHub.
 */
export function installOptimisticActionsFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const sync = (
    window as unknown as {
      syncFixture: {
        emit: (update: GitHubSyncUpdate) => void;
        changed: () => void;
        subscriptions: Map<string, GitHubSyncInterest>;
      };
    }
  ).syncFixture;
  const members = () => items.flatMap((item) => item.subject.members);
  const member = (url: string) => {
    const found = members().find((m) => m.url === url);
    if (!found) throw Error(`Unknown fixture PR ${url}`);
    return found;
  };
  const target = members().find((m) => m.title.includes('Fix reconnect'));
  if (!target) throw Error('The optimistic fixture needs the Fix reconnect PR');
  const url = target.url;
  const stamp = '2026-11-14T10:00:00Z';
  const by = (login: string) => ({ login, avatarUrl: '' });
  const comment = (id: string, body: string, login = 'maya'): GitHubReviewComment => ({
    id,
    body,
    createdAt: stamp,
    updatedAt: stamp,
    url: `${url}#${id}`,
    author: by(login),
    viewerCanUpdate: login === 'oddur',
    viewerCanDelete: login === 'oddur',
  });
  /** GitHub's copy. Writes change it only when they succeed. */
  const github = new Map<string, GitHubReviewThreads>([
    [
      url,
      {
        headSha: target.headSha,
        baseSha: target.baseSha,
        checkedAt: Date.now(),
        threads: [
          {
            id: 't1',
            path: 'src/transport.ts',
            line: 12,
            startLine: null,
            diffSide: 'RIGHT',
            isResolved: false,
            isOutdated: false,
            viewerCanResolve: true,
            viewerCanUnresolve: false,
            comments: [
              {
                ...comment('tc1', 'Shutdown can race the reconnect timer. Can the timer check the closed flag first?'),
                diffHunk: '@@ -10,3 +10,4 @@\n const timer = setTimeout(reconnect, delay);\n+if (closed) return;',
                pullRequestReview: { id: 'r1' },
              },
            ],
          },
        ],
        feedback: {
          comments: [comment('c1', 'Can you add the shutdown order to the description?')],
          reviews: [
            { ...comment('r1', 'One race remains in shutdown.'), state: 'CHANGES_REQUESTED', submittedAt: stamp },
          ],
          requestedReviewers: [],
          viewerCanUpdate: true,
          state: 'OPEN',
        },
      },
    ],
  ]);
  target.commentCount = 3;
  target.reviewCommentCount = 1;
  /** GitHub's counts and flags, shown on the next `refresh`. */
  const githubMember = new Map<string, Partial<ReviewMember>>();
  const githubComments = new Map<string, number>([[url, 4]]);
  const shownSignals = new Map<string, QueueSignals>();
  const listeners = new Set<(event: { url: string; discussion: GitHubReviewThreads }) => void>();
  const held: { action: string; settle: (outcome: string) => void }[] = [];
  const record = { writes: [] as string[], settled: [] as string[] };
  let ids = 0;
  const clone = <T>(value: T): T => structuredClone(value);

  const service = createOptimisticService({
    viewer: () => ({ login: 'oddur', avatarUrl: '' }),
    before: (prUrl) => ({
      commentCount: member(prUrl).commentCount,
      reviewCommentCount: member(prUrl).reviewCommentCount,
      comments: shownSignals.get(prUrl)?.comments,
    }),
    changed: (prUrl, kinds) => publish(prUrl, kinds),
  });
  /** What main does when a patch begins, confirms or rolls back: push every copy with every patch applied. */
  function publish(prUrl: string, kinds: string[]) {
    const data = github.get(prUrl);
    if (data && kinds.includes('discussion')) {
      const discussion = service.discussion(prUrl, clone(data));
      listeners.forEach((listener) => listener({ url: prUrl, discussion }));
    }
    if (kinds.includes('metadata')) sync.emit({ kind: 'metadata', url: prUrl, value: service.metadata(member(prUrl)) });
    const signals = shownSignals.get(prUrl);
    if (signals && kinds.includes('signals')) {
      const value = { ...signals, checkedAt: Date.now() };
      shownSignals.set(prUrl, value);
      sync.emit({ kind: 'signals', url: prUrl, value: service.signals(value) });
    }
    // The queue rows, attention and the menu bar read the queue again.
    sync.changed();
  }
  /** A write to GitHub that waits for the test. `onGitHub` runs only when it succeeds. */
  function write<T>(
    action: string,
    prUrl: string,
    change: OptimisticChange | undefined,
    onGitHub: () => T,
    result?: (value: T) => OptimisticResult
  ): Promise<T> {
    record.writes.push(action);
    const run = () =>
      new Promise<T>((resolve, reject) => {
        held.push({
          action,
          settle: (outcome) => {
            record.settled.push(`${action}:${outcome === 'ok' ? 'ok' : 'failed'}`);
            if (outcome === 'ok') resolve(onGitHub());
            else reject(Error(outcome));
          },
        });
      });
    return change ? service.run(prUrl, change, run, result) : run();
  }
  /** GitHub counts inline comments in the PR total the queue badge shows, and in the review comment count. */
  const inlineCommentAdded = (prUrl: string) => {
    githubComments.set(prUrl, (githubComments.get(prUrl) ?? 0) + 1);
    githubMember.set(prUrl, {
      ...githubMember.get(prUrl),
      reviewCommentCount: (githubMember.get(prUrl)?.reviewCommentCount ?? member(prUrl).reviewCommentCount ?? 0) + 1,
    });
  };
  const thread = (prUrl: string, id: string) => {
    const found = github.get(prUrl)?.threads.find((t) => t.id === id);
    if (!found) throw Error('This thread is no longer on GitHub. Refresh comments.');
    return found;
  };

  const readQueue = mocks.workbenchQueue as () => Promise<WorkbenchQueue>;
  /** Like main's queue: members with the reader's pending writes applied. */
  const overlay = async (read: Promise<WorkbenchQueue>) => {
    const queue = await read;
    return {
      ...queue,
      items: queue.items.map((item) => ({
        ...item,
        subject: { ...item.subject, members: item.subject.members.map((m) => service.metadata(m)) },
      })),
    };
  };
  const readSignals = mocks.getQueueSignals as (requests: QueueSignalRequest[]) => Promise<QueueSignals[]>;
  Object.assign(mocks, {
    onGitHubOptimistic: (callback: (event: { url: string; discussion: GitHubReviewThreads }) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getCachedReviewThreads: (prUrl: string) =>
      Promise.resolve(
        github.has(prUrl) ? service.discussion(prUrl, clone(github.get(prUrl) as GitHubReviewThreads)) : undefined
      ),
    getReviewThreads: (prUrl: string) => {
      const data = clone(github.get(prUrl) ?? { headSha: '', baseSha: '', threads: [] });
      service.observe(prUrl, 'discussion', data);
      return Promise.resolve(service.discussion(prUrl, data));
    },
    workbenchQueue: () => overlay(readQueue()),
    workbenchSnapshot: () => overlay(readQueue()),
    getQueueSignals: async (requests: QueueSignalRequest[]) => {
      const values = await readSignals(requests);
      return values.map((value) => {
        // The fixture's own counts are stable per PR, so a count that moves is the write's.
        const known = shownSignals.get(value.url) ?? {
          ...value,
          comments: githubComments.get(value.url) ?? value.comments,
        };
        shownSignals.set(value.url, known);
        return service.signals({ ...known, checkedAt: Date.now() });
      });
    },
    reviewThreadAction: (req: ReviewThreadAction) => {
      const change: OptimisticChange =
        req.action === 'reply'
          ? { action: 'thread-reply', threadId: req.threadId, body: (req.body ?? '').trim() }
          : { action: req.action === 'resolve' ? 'thread-resolve' : 'thread-unresolve', threadId: req.threadId };
      return write(
        change.action,
        req.prUrl,
        change,
        () => {
          const t = thread(req.prUrl, req.threadId);
          if (req.action === 'reply')
            t.comments.push({
              ...comment(`gh-${++ids}`, (req.body ?? '').trim(), 'oddur'),
              createdAt: new Date().toISOString(),
            });
          else {
            t.isResolved = req.action === 'resolve';
            t.viewerCanResolve = !t.isResolved;
            t.viewerCanUnresolve = t.isResolved;
          }
          if (req.action === 'reply') inlineCommentAdded(req.prUrl);
          return clone(t);
        },
        (value) => ({ thread: value })
      ).then((value) => service.thread(req.prUrl, value));
    },
    reviewCommentAction: (req: ReviewCommentAction) => {
      const change: OptimisticChange =
        req.action === 'delete'
          ? { action: 'comment-delete', threadId: req.threadId, commentId: req.commentId }
          : { action: 'comment-edit', threadId: req.threadId, commentId: req.commentId, body: (req.body ?? '').trim() };
      return write(
        change.action,
        req.prUrl,
        change,
        () => {
          const t = thread(req.prUrl, req.threadId);
          t.comments =
            req.action === 'delete'
              ? t.comments.filter((c) => c.id !== req.commentId)
              : t.comments.map((c) => (c.id === req.commentId ? { ...c, body: (req.body ?? '').trim() } : c));
          return clone(t);
        },
        (value) => ({ thread: value })
      ).then((value) => service.thread(req.prUrl, value));
    },
    feedbackAction: (req: FeedbackAction) => {
      const feedback = github.get(req.prUrl)?.feedback;
      if (req.action === 'request-review' || req.action === 'nudge')
        return write('request-review', req.prUrl, { action: 'request-review', reviewer: req.reviewer }, () => {
          feedback?.requestedReviewers.push(req.reviewer);
        });
      const source = [...(feedback?.comments ?? []), ...(feedback?.reviews ?? [])].find((c) => c.id === req.sourceId);
      const body = feedbackReplyBody(source?.url ?? '', req.body.trim());
      return write('feedback-reply', req.prUrl, source ? { action: 'feedback-reply', body } : undefined, () => {
        feedback?.comments.push({ ...comment(`gh-${++ids}`, body, 'oddur'), createdAt: new Date().toISOString() });
        githubComments.set(req.prUrl, (githubComments.get(req.prUrl) ?? 0) + 1);
        githubMember.set(req.prUrl, {
          ...githubMember.get(req.prUrl),
          commentCount: (member(req.prUrl).commentCount ?? 0) + 1,
        });
      });
    },
    createReviewComment: (req: CreateReviewCommentRequest) =>
      write(
        'review-comment',
        req.prUrl,
        {
          action: 'review-comment',
          path: req.path,
          line: req.line,
          startLine: req.startLine,
          side: req.side,
          body: req.body.trim(),
        },
        () => {
          const id = `gh-${++ids}`;
          github.get(req.prUrl)?.threads.push({
            id: `thread-${id}`,
            path: req.path,
            line: req.line,
            startLine: req.startLine ?? null,
            diffSide: req.side,
            isResolved: false,
            isOutdated: false,
            viewerCanResolve: true,
            viewerCanUnresolve: false,
            comments: [{ ...comment(id, req.body.trim(), 'oddur'), createdAt: new Date().toISOString() }],
          });
          inlineCommentAdded(req.prUrl);
          return { id, url: `${req.prUrl}#${id}` };
        },
        (value) => ({ comment: value })
      ),
    performPrAction: (request: { kind: string; url: string; method?: string }) =>
      write(request.kind, request.url, prActionChange(request.kind, request.method), () => {
        if (request.kind === 'mark-ready' || request.kind === 'convert-draft')
          githubMember.set(request.url, {
            ...githubMember.get(request.url),
            isDraft: request.kind === 'convert-draft',
          });
        return { status: 'completed', message: 'GitHub updated the PR.' };
      }),
  });
  Object.assign(window, {
    optimisticFixture: {
      url,
      record,
      held: () => held.map((write) => write.action),
      /** Answers the oldest write: `ok`, or GitHub's error message. */
      settle: (outcome = 'ok') => {
        const next = held.shift();
        if (!next) throw Error('No write is waiting');
        next.settle(outcome);
      },
      /** The follow-up read after a write: GitHub's copies reach the page, and the patches they show are cleared. */
      refresh: (prUrl = url) => {
        Object.assign(member(prUrl), githubMember.get(prUrl) ?? {});
        const data = clone(github.get(prUrl) as GitHubReviewThreads);
        data.checkedAt = Date.now();
        const signals = shownSignals.get(prUrl);
        const fresh = signals && {
          ...signals,
          comments: githubComments.get(prUrl) ?? signals.comments,
          checkedAt: Date.now(),
        };
        if (fresh) shownSignals.set(prUrl, fresh);
        service.observe(prUrl, 'discussion', data);
        service.observe(prUrl, 'metadata', member(prUrl));
        if (fresh) service.observe(prUrl, 'signals', fresh);
        sync.emit({ kind: 'discussion', url: prUrl, value: service.discussion(prUrl, clone(data)) });
        publish(prUrl, ['discussion', 'metadata', 'signals']);
      },
      patches: () => service.layer.list().map((patch) => `${patch.change.action}:${patch.status}`),
    },
  });
}
