import type { DiffHunk, DiffSide, FileMetadata, ReviewGuide } from './types';
import { sourceForPath } from './workbench';
import { prepareReviewHunk } from './review-diff';

export interface GitHubReviewComment {
  updatedAt?: string;
  diffHunk?: string;
  /** `state` is absent in older saved discussions. `PENDING` means the author has not submitted it. */
  pullRequestReview?: { id: string; state?: string };
  /** Hidden on GitHub by a maintainer or the author. Absent in older saved discussions. */
  isMinimized?: boolean;
  minimizedReason?: string | null;
  viewerCanUpdate?: boolean;
  viewerCanDelete?: boolean;
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string; avatarUrl: string; __typename?: string } | null;
  /**
   * The reader's write, shown before GitHub confirmed it. Not GitHub's pending review comment
   * (`isPendingComment`). See lib/optimistic-patches.ts.
   */
  sending?: true;
}
/** Your own review comment that you have not submitted yet. Only you can see it on GitHub. */
export const isPendingComment = (comment: Pick<GitHubReviewComment, 'pullRequestReview'>) =>
  comment.pullRequestReview?.state === 'PENDING';
/** GitHub reports the reason in lower case, such as `outdated` or `off-topic`. */
export const minimizedLabel = (comment: Pick<GitHubReviewComment, 'minimizedReason'>) => {
  const reason = comment.minimizedReason?.toLowerCase().replace(/_/g, '-');
  return reason ? `Hidden on GitHub as ${reason}` : 'Hidden on GitHub';
};
export interface GitHubReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: DiffSide;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  /** Who resolved the thread. Absent in older saved discussions; GitHub does not say when. */
  resolvedBy?: { login: string } | null;
  comments: GitHubReviewComment[];
  /** A write to the thread GitHub has not confirmed yet. See lib/optimistic-patches.ts. */
  sending?: 'comment' | 'resolving' | 'reopening';
}
export interface FeedbackReview extends GitHubReviewComment {
  state: string;
  submittedAt: string | null;
}
/** What happened on a PR besides comments and reviews, for the Feedback timeline. */
export type FeedbackEvent =
  | { kind: 'commit'; id: string; at: string; sha: string; message: string; author: string | null; url?: string }
  | { kind: 'force-push'; id: string; at: string; actor: string | null; before?: string; after?: string }
  | { kind: 'review-requested'; id: string; at: string; actor: string | null; reviewer: string }
  | { kind: 'merged' | 'closed' | 'reopened'; id: string; at: string; actor: string | null };
export interface PrFeedback {
  comments: GitHubReviewComment[];
  reviews: FeedbackReview[];
  requestedReviewers: string[];
  viewerCanUpdate: boolean;
  state: string;
  /** The latest timeline events, oldest first. Absent in older saved discussions. */
  events?: FeedbackEvent[];
  /** GitHub has earlier events than `events` holds. */
  earlierEvents?: boolean;
}
export type FeedbackAction =
  | { prUrl: string; action: 'reply'; sourceId: string; body: string }
  | { prUrl: string; action: 'request-review'; reviewer: string }
  /** The Overview's Nudge (#390): request a requested or past reviewer's review again on your PR. */
  | { prUrl: string; action: 'nudge'; reviewer: string };
export interface GitHubReviewThreads {
  feedback?: PrFeedback;
  checkedAt?: number;
  /** A saved copy shown while GitHub is read again. */
  stale?: boolean;
  headSha: string;
  baseSha: string;
  threads: GitHubReviewThread[];
}
/** GitHub's text for a reply to conversation feedback. */
export const feedbackReplyBody = (sourceUrl: string, body: string) => `In reply to [this feedback](${sourceUrl}):\n\n${body}`;
export interface ReviewThreadAction {
  prUrl: string;
  threadId: string;
  action: 'reply' | 'resolve' | 'unresolve';
  body?: string;
}

export function threadSource(review: ReviewGuide, filePath: string) {
  const source = sourceForPath(review, filePath);
  // An unknown stack prefix must never fall back to the submission target PR.
  if ((review.snapshot?.subject.members.length ?? 0) > 1 && !source.member) return null;
  const prUrl = source.member?.url ?? review.prUrl;
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(prUrl)) return null;
  return {
    prUrl,
    path: source.path,
    headSha: source.member?.headSha ?? review.headSha,
    baseSha: source.member?.baseSha,
  };
}

/** Return a reason when current GitHub coordinates cannot safely label saved code. */
export function threadPlacementReason(
  thread: GitHubReviewThread,
  snapshot: Pick<GitHubReviewThreads, 'headSha' | 'baseSha'>,
  source: { headSha?: string; baseSha?: string },
  hunks: DiffHunk[],
  fileStatus?: FileMetadata['status']
): string | null {
  if (thread.isOutdated) return 'Outdated thread — GitHub no longer attaches it to the current diff.';
  if (source.headSha !== snapshot.headSha || (thread.diffSide === 'LEFT' && source.baseSha !== snapshot.baseSha))
    return 'The GitHub revision differs from this saved code, or its revision is unknown.';
  if (thread.line == null) return 'This thread has no current line in the diff.';
  if (
    !hunks.some((h) =>
      prepareReviewHunk(h, fileStatus)?.lines.some(
        (l) => (thread.diffSide === 'LEFT' ? l.baseLineNumber : l.headLineNumber) === thread.line
      )
    )
  )
    return 'This line is outside the code saved in this topic.';
  return null;
}

export interface ReviewCommentAction {
  prUrl: string;
  threadId: string;
  commentId: string;
  action: 'edit' | 'delete';
  body?: string;
}
export interface CreateReviewCommentRequest {
  prUrl: string;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  path: string;
  line: number;
  startLine?: number;
  side: DiffSide;
  body: string;
}
