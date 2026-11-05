import type { GitHubReviewComment, GitHubReviewThread, GitHubReviewThreads } from './review-threads';
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
    items.push({
      id: review.id,
      member,
      kind: 'review',
      state: review.state,
      comments: [{ ...review, createdAt: review.submittedAt ?? review.createdAt }],
      relatedThreads: snapshot.threads
        .filter((t) => t.comments.some((c) => c.pullRequestReview?.id === review.id))
        .map((t) => t.id),
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
/** Own replies do not make feedback unread. The edited timestamp tracks changed comments too. */
export function feedbackFingerprint(item: FeedbackItem, account: string): string {
  const comments = item.comments.filter((c) => c.author?.login.toLowerCase() !== account.toLowerCase());
  return comments.length ? JSON.stringify(comments.map((c) => [c.id, c.updatedAt ?? c.createdAt])) : '';
}
export function feedbackReviewers(snapshot: GitHubReviewThreads) {
  const latest = new Map<string, NonNullable<typeof snapshot.feedback>['reviews'][number]>();
  for (const review of [...(snapshot.feedback?.reviews ?? [])].sort((a, b) =>
    (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt)
  )) {
    if (review.author && review.state !== 'PENDING') latest.set(review.author.login.toLowerCase(), review);
  }
  return [...latest.values()].flatMap((r) => {
    if (r.state !== 'CHANGES_REQUESTED' || !r.author) return [];
    const login = r.author.login;
    return [
      {
        login,
        reviewId: r.id,
        requested:
          snapshot.feedback?.requestedReviewers.some((name) => name.toLowerCase() === login.toLowerCase()) ?? false,
        unresolved: snapshot.threads.filter(
          (t) => !t.isResolved && t.comments.some((c) => c.author?.login.toLowerCase() === login.toLowerCase())
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
  if (discussion.headSha !== displayed.headSha || (thread.diffSide === 'LEFT' && discussion.baseSha !== displayed.baseSha)) return 'earlier';
  return thread.line === null ? 'unavailable' : 'current';
}
