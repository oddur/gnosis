import { changesRequestedReviews, isResponseThread, isUnresolvedThread } from './response-needed';
import {
  isPendingComment,
  type GitHubReviewComment,
  type GitHubReviewThread,
  type GitHubReviewThreads,
} from './review-threads';
import type { ReviewMember } from './workbench';
export interface FeedbackItem {
  id: string;
  headSha?: string;
  baseSha?: string;
  member: ReviewMember;
  kind: 'thread' | 'review' | 'comment';
  comments: GitHubReviewComment[];
  thread?: GitHubReviewThread;
  state?: string;
  relatedThreads: string[];
}
export function feedbackItems(member: ReviewMember, snapshot?: GitHubReviewThreads): FeedbackItem[] {
  if (!snapshot) return [];
  const items: FeedbackItem[] = snapshot.threads.map((thread) => ({
    id: thread.id,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    member,
    kind: 'thread',
    thread,
    comments: thread.comments,
    relatedThreads: [],
  }));
  for (const review of snapshot.feedback?.reviews ?? []) {
    if (review.state === 'PENDING') continue;
    const relatedThreads = snapshot.threads
      .filter((t) => t.comments.some((c) => c.pullRequestReview?.id === review.id))
      .map((t) => t.id);
    // Each inline comment or reply is submitted as a comment review with no text. GitHub shows only the thread.
    if (review.state === 'COMMENTED' && !review.body.trim() && relatedThreads.length) continue;
    items.push({
      id: review.id,
      member,
      kind: 'review',
      state: review.state,
      comments: [{ ...review, createdAt: review.submittedAt ?? review.createdAt }],
      relatedThreads,
    });
  }
  for (const comment of snapshot.feedback?.comments ?? [])
    items.push({ id: comment.id, member, kind: 'comment', comments: [comment], relatedThreads: [] });
  return items
    .filter((item) => item.comments.length)
    .sort((a, b) => (b.comments.at(-1)?.createdAt ?? '').localeCompare(a.comments.at(-1)?.createdAt ?? ''));
}
export const feedbackKey = (item: FeedbackItem) => `${item.member.url}#${item.id}`;
export const feedbackReadKey = (account: string, item: FeedbackItem) =>
  `gnosis-feedback-read:v1:${encodeURIComponent(account.toLowerCase())}:${feedbackKey(item)}`;
/**
 * Own replies, unsubmitted comments and comments hidden on GitHub do not make feedback unread. The edited
 * timestamp tracks changed comments too.
 */
export function feedbackFingerprint(item: FeedbackItem, account: string): string {
  const comments = item.comments.filter(
    (c) => c.author?.login.toLowerCase() !== account.toLowerCase() && !isPendingComment(c) && !c.isMinimized
  );
  return comments.length ? JSON.stringify(comments.map((c) => [c.id, c.updatedAt ?? c.createdAt])) : '';
}
export function feedbackReviewers(snapshot: GitHubReviewThreads) {
  return changesRequestedReviews(snapshot).flatMap((r) => {
    if (r.state !== 'CHANGES_REQUESTED' || !r.author) return [];
    const login = r.author.login;
    return [
      {
        login,
        reviewId: r.id,
        requested:
          snapshot.feedback?.requestedReviewers.some((name) => name.toLowerCase() === login.toLowerCase()) ?? false,
        unresolved: snapshot.threads.filter(
          (t) => isUnresolvedThread(t) && t.comments.some((c) => c.author?.login.toLowerCase() === login.toLowerCase())
        ).length,
      },
    ];
  });
}
export const feedbackStateLabel = (state?: string) =>
  ({
    CHANGES_REQUESTED: 'Changes requested',
    APPROVED: 'Approved',
    COMMENTED: 'Review',
    DISMISSED: 'Dismissed review',
  })[state ?? ''] ?? 'Review';

export const feedbackActivity = (item: FeedbackItem) =>
  item.comments.reduce((latest, comment) => {
    const time = comment.updatedAt ?? comment.createdAt;
    return time > latest ? time : latest;
  }, '');

/** Hide only automation-only conversations; never discard a human or unknown-author reply. */
export const isGitHubActionsFeedback = (item: FeedbackItem) =>
  item.comments.length > 0 &&
  item.comments.every((comment) => /^github-actions(?:\[bot\])?$/i.test(comment.author?.login ?? ''));
export const feedbackOptionsKey = (account: string) =>
  `gnosis-feedback-options:v1:${encodeURIComponent(account.toLowerCase())}`;

/** GitHub coordinates are valid only for the displayed revision and side. */
export function feedbackCodeContext(
  thread: GitHubReviewThread,
  discussion: Pick<GitHubReviewThreads, 'headSha' | 'baseSha'> | undefined,
  displayed: { headSha: string; baseSha: string } | undefined
): 'current' | 'earlier' | 'unavailable' {
  if (thread.isOutdated) return 'earlier';
  if (!discussion || !displayed) return 'unavailable';
  if (
    discussion.headSha !== displayed.headSha ||
    (thread.diffSide === 'LEFT' && discussion.baseSha !== displayed.baseSha)
  )
    return 'earlier';
  return thread.line === null ? 'unavailable' : 'current';
}

export type ResponseIntent = 'response' | 'response-threads' | 'response-review';
export interface FeedbackRequest {
  id: string;
  subjectId: string;
  intent: ResponseIntent;
}
/** Preserve the queue reason when entering Feedback, rather than restoring an unrelated conversation. */
export function responseFeedbackTarget(
  items: FeedbackItem[],
  account: string,
  intent: ResponseIntent
): FeedbackItem | undefined {
  const threads = items.filter((item) => item.thread && isResponseThread(item.thread, account, item.member.author));
  const byPr = new Map<string, FeedbackItem[]>();
  for (const item of items)
    if (item.kind === 'review') byPr.set(item.member.url, [...(byPr.get(item.member.url) ?? []), item]);
  const reviews = [...byPr.values()].flatMap((group) => {
    const current = changesRequestedReviews(
      {
        headSha: '',
        baseSha: '',
        threads: [],
        feedback: {
          comments: [],
          requestedReviewers: [],
          viewerCanUpdate: false,
          state: 'OPEN',
          reviews: group.map((item) => ({
            ...item.comments[0],
            state: item.state ?? '',
            submittedAt: item.comments[0].createdAt,
          })),
        },
      },
      account
    );
    return group.filter((item) => current.some((review) => review.id === item.id));
  });
  return intent === 'response-threads'
    ? threads[0]
    : intent === 'response-review'
      ? reviews[0]
      : (reviews[0] ?? threads[0]);
}

/**
 * A comment as one line of plain text, for list previews: GitHub renders HTML in comments, so HTML comments such as
 * `<!-- linear-linkback -->` and tags such as `<details>` never show as text, and link text stands for its link.
 */
export function plainCommentText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/^[\s#>*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Someone else's comment in the conversation names the reader with an @-mention. */
export function mentionsAccount(item: FeedbackItem, account: string): boolean {
  const name = account.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(^|[^\\w/-])@${name}(?![\\w-])`, 'i');
  return item.comments.some(
    (c) => c.author?.login.toLowerCase() !== account.toLowerCase() && !c.isMinimized && mention.test(c.body)
  );
}

/**
 * The line a GitHub diff hunk ends on. GitHub saves each review comment's hunk from its header to the commented
 * line, so its last line is where the comment was anchored, even after the thread became outdated.
 */
export function diffHunkAnchor(hunk: string | undefined): { line: number; side: 'LEFT' | 'RIGHT' } | undefined {
  const lines = hunk?.replace(/\n$/, '').split('\n') ?? [];
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '');
  if (!match || lines.length < 2) return undefined;
  let old = Number(match[1]),
    next = Number(match[2]);
  let anchor: { line: number; side: 'LEFT' | 'RIGHT' } | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) anchor = { line: old++, side: 'LEFT' };
    else if (line.startsWith('+')) anchor = { line: next++, side: 'RIGHT' };
    else {
      anchor = { line: next++, side: 'RIGHT' };
      old++;
    }
  }
  return anchor;
}

export type FeedbackOrder = 'activity' | 'file';
/**
 * Latest activity first, as an inbox: new replies and edits rise to the top. File order walks the code: the PR's own
 * conversation first, oldest first, then code threads by PR, path and line, so Resolve & next moves down the code.
 */
export function sortFeedback(items: FeedbackItem[], order: FeedbackOrder): FeedbackItem[] {
  if (order === 'activity') return [...items].sort((a, b) => feedbackActivity(b).localeCompare(feedbackActivity(a)));
  const line = (item: FeedbackItem) =>
    item.thread?.line ?? item.thread?.startLine ?? diffHunkAnchor(item.comments[0]?.diffHunk)?.line ?? 0;
  return [...items].sort(
    (a, b) =>
      Number(!!a.thread) - Number(!!b.thread) ||
      a.member.number - b.member.number ||
      (a.thread && b.thread
        ? a.thread.path.localeCompare(b.thread.path) || line(a) - line(b)
        : (a.comments[0]?.createdAt ?? '').localeCompare(b.comments[0]?.createdAt ?? ''))
  );
}

/** A thread's comments oldest first. GitHub sends them in order; saved and optimistic copies may not be. */
export function chronologicalThread<T extends { comments: { createdAt: string }[] }>(thread: T): T {
  const sorted = thread.comments.every((c, i, all) => !i || all[i - 1].createdAt <= c.createdAt);
  return sorted
    ? thread
    : { ...thread, comments: [...thread.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}
