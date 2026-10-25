import { AlertCircle, CheckCircle2, CircleHelp, Clock3 } from 'lucide-react';
import type { MergeReadiness } from '../lib/merge-readiness';
import { timeAgo } from '../lib/utils';

export function ReadinessBadge({ readiness }: { readiness: MergeReadiness }) {
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
    <span className={`merge-readiness-badge is-${readiness.tone}`} title={description}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {readiness.label}
        {readiness.stale && readiness.label !== 'Readiness out of date' ? ' · Out of date' : ''}
      </span>
    </span>
  );
}

export function ReadinessCheckedAt({ readiness }: { readiness: MergeReadiness }) {
  return (
    <span className="merge-readiness-checked">
      {readiness.checkedAt ? (
        <>
          Checked{' '}
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
