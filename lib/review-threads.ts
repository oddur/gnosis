import type { DiffHunk, DiffSide, FileMetadata, ReviewGuide } from './types';
import { sourceForPath } from './workbench';
import { prepareReviewHunk } from './review-diff';

export interface GitHubReviewComment {
  viewerCanUpdate?: boolean;
  viewerCanDelete?: boolean;
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string; avatarUrl: string } | null;
}
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
  comments: GitHubReviewComment[];
}
export interface GitHubReviewThreads {
  headSha: string;
  baseSha: string;
  threads: GitHubReviewThread[];
}
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
