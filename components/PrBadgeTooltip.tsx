import { GitBranch, ArrowRight, MessageSquare, CircleCheck, CircleX, Clock3 } from 'lucide-react';
import type { PrBadgePreview } from '../lib/pr-badge-preview';
import { prReviewStatus } from '../lib/pr-review-status';
import { mergeReadiness } from '../lib/merge-readiness';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
import { timeAgo } from '../lib/utils';
import { StatusBadge } from './PrReviewStatus';
import { ReadinessBadge } from './MergeReadiness';
export function PrBadgeTooltip({
  preview,
  title,
  failed,
}: {
  preview: PrBadgePreview | null;
  title?: string;
  failed?: boolean;
}) {
  if (!preview)
    return (
      <div className="pr-badge-preview">
        <strong>{title || 'Pull request'}</strong>
        <p>{failed ? 'Saved PR details are unavailable. Try again.' : 'No PR details saved yet.'}</p>
      </div>
    );
  const { member, briefing, stack, savedReview } = preview;
  // Status belongs to the displayed revision; an older green check must never imply current approval.
  const signals =
    preview.signals?.headSha === member.headSha && preview.signals.url === member.url ? preview.signals : undefined;
  const status = prReviewStatus(member, signals, false);
  const readiness = mergeReadiness(member, signals);
  const checks = signals?.checks;
  const CheckIcon = checks?.state === 'failure' ? CircleX : checks?.state === 'pending' ? Clock3 : CircleCheck;
  const comments = signals?.comments ?? member.commentCount;
  return (
    <div className="pr-badge-preview">
      <strong className="pr-badge-preview-title">{member.title}</strong>
      <span className="pr-badge-preview-meta">
        By {member.author} · Updated {timeAgo(member.updatedAt)}
      </span>
      <div className="pr-badge-preview-status">
        {signals?.readiness || ['merged', 'closed', 'draft'].includes(status.kind) ? (
          <StatusBadge status={status} />
        ) : (
          <span>Review status not saved</span>
        )}
        {signals?.readiness && <ReadinessBadge readiness={readiness} reviewStatusShown />}
      </div>
      <div className="pr-badge-preview-facts">
        {checks && (
          <span
            className={`queue-checks is-${checks.state}${Date.now() - signals.checkedAt >= QUEUE_SIGNALS_TTL ? ' is-stale' : ''}`}
          >
            <CheckIcon size={13} />
            {checks.total
              ? `${checks.passed + (checks.skipped ?? 0)}/${checks.total} checks${checks.state === 'failure' ? ' · failing' : checks.state === 'pending' ? ' · pending' : ''}`
              : 'No checks'}
          </span>
        )}
        {comments !== undefined && (
          <span>
            <MessageSquare size={13} />
            {comments} {comments === 1 ? 'comment' : 'comments'}
          </span>
        )}
      </div>
      <span className="pr-badge-preview-branches" title={`${member.headBranch} → ${member.baseBranch}`}>
        <GitBranch size={13} />
        <span className="pr-badge-preview-head">{member.headBranch}</span>
        <ArrowRight size={12} aria-hidden="true" />
        <span className="pr-badge-preview-base">{member.baseBranch}</span>
      </span>
      <div className="pr-badge-preview-briefing">
        <strong>{stack ? `Stack briefing · ${stack.count} PRs` : 'Briefing'}</strong>
        {briefing?.status === 'ready' && briefing.summary ? (
          <p>{briefing.summary}</p>
        ) : (
          <p>
            {briefing?.status === 'generating'
              ? 'Briefing in progress.'
              : briefing?.status === 'queued'
                ? 'Briefing queued.'
                : briefing?.status === 'failed'
                  ? 'Briefing unavailable.'
                  : 'No briefing saved yet.'}
          </p>
        )}
      </div>
      <span className="pr-badge-preview-meta">
        {savedReview
          ? 'Saved review snapshot'
          : signals
            ? `Status checked ${timeAgo(new Date(signals.checkedAt).toISOString())}`
            : 'Saved PR details'}
      </span>
    </div>
  );
}
