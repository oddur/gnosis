import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareWarning,
} from 'lucide-react';
import { prReviewStatus, subjectReviewStatuses, type PrReviewStatus } from '../lib/pr-review-status';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

const icons = {
  'changes-requested': MessageSquareWarning,
  'awaiting-review': Clock3,
  approved: CheckCircle2,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  checking: Clock3,
  unavailable: CircleHelp,
  unknown: CircleHelp,
};

function StatusBadge({
  status,
  count,
  details = status.details,
}: {
  status: PrReviewStatus;
  count?: number;
  details?: string;
}) {
  const Icon = icons[status.kind];
  const label = count === undefined ? status.label : `${count} ${status.label.toLowerCase()}`;
  return (
    <span className={`pr-review-status is-${status.tone}`} data-review-status={status.kind} title={details}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {label}
        {status.stale && ' · Out of date'}
      </span>
    </span>
  );
}

export function MemberReviewStatus({
  member,
  signals,
  checking,
}: {
  member: ReviewMember;
  signals?: QueueSignals;
  checking?: boolean;
}) {
  return <StatusBadge status={prReviewStatus(member, signals, checking)} />;
}

export function SubjectReviewStatus({
  subject,
  signals,
  checking,
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checking: boolean;
}) {
  const stacked = subject.kind === 'stack' && subject.members.length > 1;
  return (
    <span className="pr-review-statuses" role="group" aria-label={stacked ? 'Stack review status' : 'Review status'}>
      {subjectReviewStatuses(subject, signals, checking).map((group) => (
        <StatusBadge
          key={`${group.status.kind}:${group.status.stale}`}
          status={group.status}
          count={stacked ? group.members.length : undefined}
          details={group.members.map((m) => `#${m.number}: ${m.status.details}`).join('\n')}
        />
      ))}
    </span>
  );
}
