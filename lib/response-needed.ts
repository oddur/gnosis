import type { QueueSignals } from './queue-signals';
import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';
import type { ReviewMember } from './workbench';

export interface ResponseNeeded {
  changesRequested: boolean;
  unresolvedThreads: number;
  /** False means absence of feedback has not yet been confirmed. */
  complete: boolean;
}

export const isResponseThread = (thread: GitHubReviewThread, account: string) =>
  !thread.isResolved &&
  thread.comments.length > 0 &&
  thread.comments[0].author?.login.toLowerCase() !== account.toLowerCase() &&
  !thread.comments.every((comment) => /^github-actions(?:\[bot\])?$/i.test(comment.author?.login ?? ''));

/** Comments do not supersede a review decision; approval or dismissal does. */
export function changesRequestedReviews(discussion: GitHubReviewThreads, account?: string) {
  const latest = new Map<string, NonNullable<GitHubReviewThreads['feedback']>['reviews'][number]>();
  for (const review of discussion.feedback?.reviews ?? []) {
    const login = review.author?.login.toLowerCase();
    if (
      !login ||
      login === account?.toLowerCase() ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    )
      continue;
    const previous = latest.get(login);
    if (!previous || (review.submittedAt ?? review.createdAt) >= (previous.submittedAt ?? previous.createdAt))
      latest.set(login, review);
  }
  return [...latest.values()].filter((review) => review.state === 'CHANGES_REQUESTED');
}

/** Local evidence only. Unresolved feedback survives new commits until explicitly resolved. */
export function responseNeeded(
  member: ReviewMember,
  account: string,
  signals?: QueueSignals,
  discussion?: GitHubReviewThreads
): ResponseNeeded {
  const empty = { changesRequested: false, unresolvedThreads: 0, complete: true };
  if (member.state !== 'open' || member.merged || member.author.toLowerCase() !== account.toLowerCase()) return empty;
  const currentSignals = signals?.headSha === member.headSha ? signals : undefined;
  const decision = currentSignals?.readiness?.reviewDecision;
  // A newer discussion read can contain a resolution before the next signals refresh.
  const useDecision = decision && (!discussion?.feedback || currentSignals.checkedAt >= (discussion.checkedAt ?? 0));
  return {
    changesRequested: useDecision
      ? decision === 'CHANGES_REQUESTED'
      : !!discussion && changesRequestedReviews(discussion, account).length > 0,
    unresolvedThreads: discussion?.threads.filter((thread) => isResponseThread(thread, account)).length ?? 0,
    complete: !!discussion?.feedback && discussion.headSha === member.headSha,
  };
}

export const needsResponse = (value?: ResponseNeeded) =>
  !!value && (value.changesRequested || value.unresolvedThreads > 0);
export function responseNeededLabel(value: ResponseNeeded) {
  return [
    value.changesRequested ? 'Changes requested' : '',
    value.unresolvedThreads
      ? `${value.unresolvedThreads} unresolved ${value.unresolvedThreads === 1 ? 'thread' : 'threads'}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
