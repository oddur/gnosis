import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { ReviewMember, ReviewSubject } from './workbench';

const decisions = {
  CHANGES_REQUESTED: { kind: 'changes-requested', label: 'Changes requested', tone: 'danger' },
  REVIEW_REQUIRED: { kind: 'awaiting-review', label: 'Awaiting review', tone: 'warning' },
  APPROVED: { kind: 'approved', label: 'Approved', tone: 'success' },
} as const;

export interface PrReviewStatus {
  kind:
    | 'changes-requested'
    | 'awaiting-review'
    | 'approved'
    | 'draft'
    | 'merged'
    | 'closed'
    | 'unknown'
    | 'checking'
    | 'unavailable';
  label: string;
  tone: 'danger' | 'warning' | 'success' | 'info' | 'muted';
  stale: boolean;
  checkedAt?: number;
  details: string;
}

/** Review policy and merge eligibility are independent. Never infer approval from review counts or checks. */
export function prReviewStatus(
  member: Pick<ReviewMember, 'url' | 'headSha' | 'merged' | 'state' | 'isDraft'>,
  signals?: QueueSignals,
  checking = true,
  now = Date.now()
): PrReviewStatus {
  const snapshot = signals?.url === member.url && signals.headSha === member.headSha ? signals : undefined;
  const status = snapshot?.readiness;
  const checkedAt = status ? snapshot.checkedAt : undefined;
  const stale = checkedAt !== undefined && now - checkedAt >= QUEUE_SIGNALS_TTL;
  const decision = status && decisions[status.reviewDecision as keyof typeof decisions];
  const result = (
    kind: PrReviewStatus['kind'],
    label: string,
    tone: PrReviewStatus['tone'],
    details: string
  ): PrReviewStatus => ({
    kind,
    label,
    tone: stale ? 'muted' : tone,
    stale,
    checkedAt,
    details: [
      details,
      stale ? 'Out of date. Refresh status before relying on this decision.' : '',
      checkedAt !== undefined
        ? `Last checked ${new Date(checkedAt).toLocaleString()}.`
        : 'Review status has not been checked for this revision.',
    ]
      .filter(Boolean)
      .join(' '),
  });
  const previous = decision ? `Last review decision: ${decision.label}.` : '';
  if (member.merged || status?.state === 'MERGED')
    return result('merged', 'Merged', 'info', `This PR has been merged. ${previous}`);
  if (member.state === 'closed' || status?.state === 'CLOSED')
    return result('closed', 'Closed', 'muted', `This PR is closed without merging. ${previous}`);
  if (status?.isDraft ?? member.isDraft)
    return result('draft', 'Draft', 'muted', `This PR is not ready for review. ${previous}`);
  if (!status)
    return checking
      ? result(
          'checking',
          'Checking review status',
          'muted',
          'Waiting for GitHub’s review decision for the current revision.'
        )
      : result(
          'unavailable',
          'Review status unavailable',
          'muted',
          'Could not get a review decision for this revision. Use Refresh status to try again.'
        );
  if (decision)
    return result(
      decision.kind,
      decision.label,
      decision.tone,
      decision.kind === 'approved'
        ? 'GitHub reports this PR approved. Checks and merge requirements are evaluated separately.'
        : decision.kind === 'changes-requested'
          ? 'GitHub reports changes requested on this PR.'
          : 'GitHub reports required approvals are missing or no longer apply.'
    );
  if (status.reviewDecision !== null)
    return result(
      'unknown',
      'Review status unknown',
      'muted',
      `GitHub reported a review decision Gnosis does not recognize (${status.reviewDecision}). Check the PR on GitHub.`
    );
  // GitHub reports no review decision when no branch-protection review rule applies, as with rulesets that require
  // no approvals. Say who approved the current commit, else what the rules ask for when GitHub allows the merge.
  const approvers = currentApprovers(snapshot, member.headSha);
  if (approvers.length)
    return result(
      'approved',
      approvedBy(approvers),
      'success',
      'Approved on the current commit. GitHub reports no review decision, so its rules may not require a review.'
    );
  if (MERGE_ALLOWED.includes(status.mergeState))
    return result(
      'unknown',
      'No review required',
      'muted',
      'GitHub reports no review decision and allows the merge, so its rules require no review.'
    );
  return result(
    'unknown',
    'Not reviewed',
    'muted',
    'No approvals on the current commit. GitHub reports no review decision, so it does not say whether a review is required.'
  );
}

/** GitHub allows the merge in these states. */
const MERGE_ALLOWED = ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'];

/**
 * Reviewers whose latest opinion approves the current commit, newest first. Opinions are each reviewer's latest
 * approval or request for changes, so a later request for changes replaces an approval. `exclude` leaves out a login,
 * such as your own.
 */
export function currentApprovers(signals: QueueSignals | undefined, headSha: string, exclude?: string): string[] {
  const reviews = signals?.opinions ?? (signals?.latestReview ? [signals.latestReview] : []);
  return [
    ...new Set(
      [...reviews]
        .filter((review) => review.state === 'APPROVED' && review.headSha === headSha && review.author.toLowerCase() !== exclude?.toLowerCase())
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((review) => review.author)
    ),
  ];
}

/** "Approved by plucked", or "Approved by plucked and 2 others". */
export const approvedBy = (approvers: readonly string[]) =>
  approvers.length === 1
    ? `Approved by ${approvers[0]}`
    : `Approved by ${approvers[0]} and ${approvers.length - 1} ${approvers.length === 2 ? 'other' : 'others'}`;

export interface ReviewStatusGroup {
  status: PrReviewStatus;
  members: { number: number; status: PrReviewStatus }[];
}

/** Keep partial and stale approvals distinct, and put requests for changes first. */
export function subjectReviewStatuses(
  subject: ReviewSubject,
  signals: QueueSignals[],
  checking = true,
  now = Date.now()
): ReviewStatusGroup[] {
  const groups = new Map<string, ReviewStatusGroup>();
  for (const member of subject.members) {
    const status = prReviewStatus(
      member,
      signals.find((s) => s.url === member.url && s.headSha === member.headSha),
      checking,
      now
    );
    const key = `${status.kind}:${status.stale}`;
    const group = groups.get(key) ?? { status, members: [] };
    group.members.push({ number: member.number, status });
    groups.set(key, group);
  }
  const order: PrReviewStatus['kind'][] = [
    'changes-requested',
    'awaiting-review',
    'checking',
    'unavailable',
    'unknown',
    'draft',
    'approved',
    'merged',
    'closed',
  ];
  return [...groups.values()].sort(
    (a, b) =>
      order.indexOf(a.status.kind) - order.indexOf(b.status.kind) || Number(a.status.stale) - Number(b.status.stale)
  );
}
