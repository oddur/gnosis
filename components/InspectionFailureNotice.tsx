import { useEffect, useState, type ReactNode } from 'react';
import type { InspectionFailure } from '../lib/inspection-batch';

export function InspectionFailureNotice({
  failure,
  label,
  retryLabel = 'Retry this PR',
  githubUrl,
  action,
  saved,
  kind,
  busy,
  retryDisabled,
  retry,
}: {
  failure: InspectionFailure;
  label?: string;
  retryLabel?: string;
  githubUrl?: string;
  action?: ReactNode;
  saved: boolean;
  kind: 'changes' | 'commits';
  busy: boolean;
  retryDisabled: boolean;
  retry: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!failure.retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [failure.retryAt]);
  const seconds = Math.max(0, Math.ceil(((failure.retryAt ?? 0) - now) / 1000));
  return (
    <div className="changes-notice" role="status">
      <span>
        Could not update {label ?? `PR #${failure.url.split('/').pop()}`}. {failure.message}{' '}
        {saved ? `Showing its saved ${kind}.` : `Its ${kind} are not shown.`}
      </span>
      <button disabled={retryDisabled || busy || seconds > 0} onClick={retry}>
        {busy ? 'Retrying…' : seconds ? `Retry available in ${seconds}s` : retryDisabled ? 'Waiting for current load…' : retryLabel}
      </button>
      <button
        onClick={() =>
          void window.electronAPI.openExternal(githubUrl ?? `${failure.url}/${kind === 'changes' ? 'files' : 'commits'}`)
        }
      >
        Open on GitHub
      </button>
      {action}
    </div>
  );
}
