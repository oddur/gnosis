import type { QueueSignals } from './queue-signals';
import type { GitHubReviewThreads } from './review-threads';
import type { ReviewMember } from './workbench';

export interface ResponseNeeded {
  changesRequested: boolean;
  unresolvedThreads: number;
  /** False means absence of feedback has not yet been confirmed. */
  complete: boolean;
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
  const latest = new Map<string, { state: string; at: string }>();
  for (const review of discussion?.feedback?.reviews ?? []) {
    const login = review.author?.login.toLowerCase();
    if (
      !login ||
      login === account.toLowerCase() ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    )
      continue;
    const at = review.submittedAt ?? review.createdAt;
    const previous = latest.get(login);
    if (!previous || at >= previous.at) latest.set(login, { state: review.state, at });
  }
  const decision = currentSignals?.readiness?.reviewDecision;
  // A newer discussion read can contain a resolution before the next signals refresh.
  const useDecision = decision && (!discussion?.feedback || currentSignals.checkedAt >= (discussion.checkedAt ?? 0));
  return {
    changesRequested: useDecision
      ? decision === 'CHANGES_REQUESTED'
      : [...latest.values()].some((review) => review.state === 'CHANGES_REQUESTED'),
    unresolvedThreads:
      discussion?.threads.filter(
        (thread) =>
          !thread.isResolved &&
          thread.comments.length > 0 &&
          thread.comments[0].author?.login.toLowerCase() !== account.toLowerCase() &&
          !thread.comments.every((comment) => /^github-actions(?:\[bot\])?$/i.test(comment.author?.login ?? ''))
      ).length ?? 0,
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
