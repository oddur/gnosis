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

export function StatusBadge({
  status,
  count,
  details = status.details,
  staleLabel = 'Out of date',
  quietUnknown = false,
}: {
  status: PrReviewStatus;
  count?: number;
  details?: string;
  staleLabel?: string;
  /** In a status column, a current "No review decision" is the default and shows as an empty cell. */
  quietUnknown?: boolean;
}) {
  if (quietUnknown && status.kind === 'unknown' && !status.stale && count === undefined)
    return (
      <span className="pr-review-status is-quiet" data-review-status={status.kind} title={details}>
        <span className="sr-only">{status.label}</span>
      </span>
    );
  const Icon = icons[status.kind];
  const label = count === undefined ? status.label : `${count} ${count === 1 ? 'PR' : 'PRs'} · ${status.label}`;
  return (
    <span className={`pr-review-status is-${status.tone}`} data-review-status={status.kind} title={details}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {label}
        {status.stale && ` · ${staleLabel}`}
      </span>
    </span>
  );
}

export function MemberReviewStatus({
  member,
  signals,
  checking,
  now,
  staleLabel,
  quietUnknown,
}: {
  member: ReviewMember;
  signals?: QueueSignals;
  checking?: boolean;
  now?: number;
  staleLabel?: string;
  quietUnknown?: boolean;
}) {
  return <StatusBadge status={prReviewStatus(member, signals, checking, now)} staleLabel={staleLabel} quietUnknown={quietUnknown} />;
}

export function SubjectReviewStatus({
  subject,
  signals,
  checking,
  now,
}: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checking: boolean;
  now?: number;
}) {
  const stacked = subject.kind === 'stack' && subject.members.length > 1;
  return (
    <span className="pr-review-statuses" role="group" aria-label={stacked ? 'Stack review status' : 'Review status'}>
      {subjectReviewStatuses(subject, signals, checking, now).map((group) => (
        <StatusBadge
          key={`${group.status.kind}:${group.status.stale}`}
          status={group.status}
          staleLabel={subject.kind === 'stack' ? 'Status needs refresh' : undefined}
          count={stacked ? group.members.length : undefined}
          details={group.members.map((m) => `#${m.number}: ${m.status.details}`).join('\n')}
        />
      ))}
    </span>
  );
}
