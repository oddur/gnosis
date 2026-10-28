import { AlertCircle, CheckCircle2, CircleHelp, Clock3 } from 'lucide-react';
import type { MergeReadiness } from '../lib/merge-readiness';
import { timeAgo } from '../lib/utils';

export function ReadinessBadge({ readiness, reviewStatusShown = false, staleLabel = 'Out of date' }: { readiness: MergeReadiness; reviewStatusShown?: boolean; staleLabel?: string }) {
  // The prominent review badge already communicates these states. Keep this slot for merge eligibility.
  if (reviewStatusShown && ['Changes requested', 'Approval required', 'Draft PR', 'Merged', 'Closed'].includes(readiness.label)) return null;
  const Icon =
    readiness.tone === 'success'
      ? CheckCircle2
      : readiness.tone === 'danger'
        ? AlertCircle
        : readiness.tone === 'warning'
          ? Clock3
          : CircleHelp;
  const description = [
    ...readiness.details,
    readiness.checkedAt ? `Last checked ${new Date(readiness.checkedAt).toLocaleString()}.` : '',
  ].join(' ');
  return (
    <><span className={`merge-readiness-badge is-${readiness.tone}`} title={description}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {readiness.label}
        {readiness.stale && readiness.label !== 'Readiness out of date' ? ` · ${staleLabel}` : ''}
      </span>
    </span>{!!readiness.blockedCount && <span className="merge-readiness-blocked">{readiness.blockedCount} blocked</span>}</>
  );
}

export function ReadinessCheckedAt({ readiness, label = 'Checked' }: { readiness: MergeReadiness; label?: string }) {
  return (
    <span className="merge-readiness-checked">
      {readiness.checkedAt ? (
        <>
          {label}{' '}
          <time
            dateTime={new Date(readiness.checkedAt).toISOString()}
            title={new Date(readiness.checkedAt).toLocaleString()}
          >
            {timeAgo(new Date(readiness.checkedAt).toISOString())}
          </time>
        </>
      ) : (
        'Not checked for this revision'
      )}
    </span>
  );
}
