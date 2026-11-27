import { checkCounts } from './pr-checks';
import type { CiCheck } from './types';
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
/** How urgently the Overview reads status: `visible` while it is the shown tab in a visible window, else `background`. */
export type OverviewStatusPriority = 'visible' | 'background';
/**
 * The Overview's status read priority (#390). Shown, as the active tab of a visible window: `visible`. Anything else
 * (hidden behind another tab, resolving the queue's lane filter, or a hidden window): `background`.
 */
export const overviewStatusPriority = (shown: boolean, windowVisible: boolean): OverviewStatusPriority => (shown && windowVisible ? 'visible' : 'background');
/**
 * The queue-signals request options for a priority. Visible reads are `active`, which main runs at foreground
 * priority (`withGitHubPriority`), still automatic, so they stay inside the automatic budget, back-off and 25-PR
 * batches. Background reads carry no options, like the queue rows' own reads.
 */
export const overviewStatusOptions = (priority: OverviewStatusPriority): QueueSignalOptions => (priority === 'visible' ? { active: true } : {});

export interface SignalReview {
  url: string;
  author: string;
  state: string;
  submittedAt: string;
  headSha: string | null;
}
export interface QueueSignals extends QueueSignalRequest {
  checkedAt: number;
  /** GitHub's `totalCommentsCount`: conversation comments and inline review comments, as in its PR list. */
  comments: number;
  /** Undefined for older cache entries; null means GitHub returned no submitted review. */
  latestReview?: SignalReview | null;
  /**
   * GitHub's `latestOpinionatedReviews` from reviewers with write access: each reviewer's latest review that is
   * `APPROVED` or `CHANGES_REQUESTED`. A later comment does not replace it; a dismissal removes it.
   * Undefined for older cache entries.
   */
  opinions?: SignalReview[];
  /**
   * GitHub's `viewerLatestReview`: the reader's own latest review, of any state and however old, with its commit.
   * Null when the reader has no submitted review, or the latest is still pending. Undefined for older cache entries; then `viewerReview` reads
   * `opinions` and `latestReview` instead.
   */
  mine?: SignalReview | null;
  /** When the head commit was committed. Absent in older cache entries. */
  headCommittedAt?: string;
  activity?: {
    comment?: { id: string; at: string; author: string };
    review?: { id: string; at: string; author: string; state?: string };
    /**
     * The last ten conversation comments and submitted reviews, oldest first, so unread state can skip your
     * own, bot and hidden ones. Absent in older cache entries.
     */
    recent?: {
      kind: 'comment' | 'review';
      id: string;
      at: string;
      author: string;
      automated: boolean;
      minimized?: boolean;
      state?: string;
    }[];
    /** Logins of the head commit's author and committer; null when GitHub matched no account. */
    head?: { author: string | null; committer: string | null };
  };
  /**
   * Unresolved review thread ids. Resolving a thread changes no other signal. `complete` is false past the
   * first 100 threads. Absent in older cache entries.
   */
  threads?: { unresolved: string[]; complete: boolean };
  /**
   * `awaitingApproval`: checks GitHub reports as ACTION_REQUIRED, such as fork workflow runs held for a maintainer's
   * approval (#595). They are counted in `failed` too. Set only when some are: absent means none, or a read
   * from before this was counted.
   */
  checks: { state: 'success' | 'failure' | 'pending' | 'neutral'; passed: number; failed?: number; running?: number; skipped?: number; awaitingApproval?: number; total: number };
  /**
   * GitHub's `authorAssociation` for the PR's author: FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, NONE, CONTRIBUTOR, MEMBER,
   * COLLABORATOR or OWNER. Absent in older cache entries.
   */
  authorAssociation?: string;
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
/** How often the Overview looks for status past its time-to-live. A local check; only expired PRs are read. */
export const OVERVIEW_STATUS_SWEEP_MS = 30_000;
export const queueSignalKey = (request: QueueSignalRequest) => `${request.url}@${request.headSha}`;
/** Queue check counts from a check list, so rows agree with the Checks tab. */
/** `awaitingApproval` when any check waits for approval: absent means none, or a read that could not tell. */
export const awaiting = (count: number): { awaitingApproval?: number } => (count > 0 ? { awaitingApproval: count } : {});
export function checkSignals(checks: CiCheck[]): QueueSignals['checks'] {
  const counts = checkCounts(checks);
  return {
    state: counts.attention ? 'failure' : counts.running ? 'pending' : checks.length ? 'success' : 'neutral',
    passed: counts.passed,
    failed: counts.attention,
    running: counts.running,
    skipped: counts.skipped,
    ...awaiting(checks.filter((check) => check.status === 'completed' && check.conclusion === 'action_required').length),
    total: checks.length,
  };
}
/**
 * v4: check counts leave out jobs of superseded workflow runs. v5: entries carry `opinions`. v6: `comments` is
 * GitHub's total, and entries carry recent activity authors, the head commit author and unresolved thread ids.
 */
export const queueSignalsCacheKey = (request: QueueSignalRequest) => `queue-signals:v6:${queueSignalKey(request)}`;

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
const SUBMITTED = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
/**
 * The reader's latest submitted review on GitHub (approval, request for changes or comment), with the commit it was
 * made on: `mine`, else the reader's newest of `opinions` and `latestReview`. Pending and dismissed reviews do not count.
 */
export function viewerReview(signals: Pick<QueueSignals, 'mine' | 'opinions' | 'latestReview'> | undefined, login: string): SignalReview | undefined {
  const reviews = [...(signals?.mine ? [signals.mine] : []), ...(signals?.opinions ?? []), ...(signals?.latestReview ? [signals.latestReview] : [])];
  return reviews
    .filter((review) => SUBMITTED.has(review.state) && review.author.toLowerCase() === login.toLowerCase() && Number.isFinite(Date.parse(review.submittedAt)))
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
    .at(0);
}
/** GitHub's PR list count: saved signals first, then the REST metadata's conversation and inline counts. */
export function prCommentTotal(
  member: { commentCount?: number; reviewCommentCount?: number },
  signals?: Pick<QueueSignals, 'comments'>
): number | undefined {
  if (signals) return signals.comments;
  return member.commentCount === undefined ? undefined : member.commentCount + (member.reviewCommentCount ?? 0);
}
