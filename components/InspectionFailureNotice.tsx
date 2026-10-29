import { useEffect, useState } from 'react';
import type { InspectionFailure } from '../lib/inspection-batch';

export function InspectionFailureNotice({
  failure,
  saved,
  kind,
  busy,
  retryDisabled,
  retry,
}: {
  failure: InspectionFailure;
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
        Could not update PR #{failure.url.split('/').pop()}. {failure.message}{' '}
        {saved ? `Showing its saved ${kind}.` : `Its ${kind} are not shown.`}
      </span>
      <button disabled={retryDisabled || busy || seconds > 0} onClick={retry}>
        {busy ? 'Retrying…' : seconds ? `Retry available in ${seconds}s` : retryDisabled ? 'Waiting for current load…' : 'Retry this PR'}
      </button>
      <button
        onClick={() =>
          void window.electronAPI.openExternal(`${failure.url}/${kind === 'changes' ? 'files' : 'commits'}`)
        }
      >
        Open on GitHub
      </button>
    </div>
  );
}
