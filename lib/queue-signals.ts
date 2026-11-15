export interface QueueSignalRequest {
  url: string;
  headSha: string;
}
export interface QueueSignalOptions {
  active?: boolean;
  force?: boolean;
  cachedOnly?: boolean;
  /** Refetch saved revisions whose mergeability GitHub was still computing. Other revisions keep the normal freshness. */
  recheckMerge?: boolean;
  /** Main only: receives the measured `rateLimit.cost` of a request this call made. */
  cost?: (cost: number) => void;
}
export interface SignalReview {
  url: string;
  author: string;
  state: string;
  submittedAt: string;
  headSha: string | null;
}
export interface QueueSignals extends QueueSignalRequest {
  checkedAt: number;
  comments: number;
  /** Undefined for older cache entries; null means GitHub returned no submitted review. */
  latestReview?: SignalReview | null;
  /**
   * GitHub's `latestOpinionatedReviews` from reviewers with write access: each reviewer's latest review that is
   * `APPROVED` or `CHANGES_REQUESTED`. A later comment does not replace it; a dismissal removes it.
   * Undefined for older cache entries.
   */
  opinions?: SignalReview[];
  activity?: {
    comment?: { id: string; at: string; author: string };
    review?: { id: string; at: string; author: string; state?: string };
  };
  checks: { state: 'success' | 'failure' | 'pending' | 'neutral'; passed: number; failed?: number; running?: number; skipped?: number; total: number };
  readiness?: {
    state: string;
    isDraft: boolean;
    mergeable: string;
    mergeState: string;
    reviewDecision: string | null;
    baseBranch: string;
    baseSha: string;
    behindBy: number | null;
    mergeQueue: boolean;
    queueState: string | null;
  };
}
export const QUEUE_SIGNALS_TTL = 2 * 60_000;
export const ACTIVE_SIGNALS_TTL = 25_000;

const newestFirst = (a: SignalReview, b: SignalReview) => b.submittedAt.localeCompare(a.submittedAt);
/**
 * Open requests for changes by reviewers other than `login`, newest first. Undefined when the snapshot predates
 * opinionated reviews; then only `latestReview` and `reviewDecision` are known.
 */
export function changeRequests(signals: QueueSignals, login: string): SignalReview[] | undefined {
  return signals.opinions
    ?.filter((review) => review.state === 'CHANGES_REQUESTED' && review.author.toLowerCase() !== login.toLowerCase())
    .sort(newestFirst);
}
/**
 * The review that best explains the PR's review state: the newest open request for changes, else the newest
 * approval, else the newest review of any kind. A later comment never hides an opinion.
 */
export function decidingReview(signals: QueueSignals): SignalReview | null | undefined {
  const opinions = [...(signals.opinions ?? [])].sort(newestFirst);
  return (
    opinions.find((review) => review.state === 'CHANGES_REQUESTED') ??
    opinions.find((review) => review.state === 'APPROVED') ??
    signals.latestReview
  );
}
export const queueSignalKey =(request: QueueSignalRequest) => `${request.url}@${request.headSha}`;
