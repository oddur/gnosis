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
  return result(
    'unknown',
    'No review decision',
    'muted',
    'GitHub has not supplied a review decision. This does not mean the PR is approved or awaiting review.'
  );
}

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
