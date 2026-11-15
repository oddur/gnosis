import { useEffect, useRef, useState } from 'react';
import { clearWriteFailure, useWriteFailure } from '../lib/write-failures';

/**
 * A GitHub write that failed and was rolled back: what did not happen, GitHub's reason, and Retry. The reader's text
 * is already back in its composer; Retry sends it again. Quiet by default: one line of danger-colored text.
 */
export function WriteFailureNotice({ failureKey, className }: { failureKey: string | undefined; className?: string }) {
  const failure = useWriteFailure(failureKey);
  const [retrying, setRetrying] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!failure) return;
    element.current?.scrollIntoView({ block: 'nearest' });
    element.current?.focus({ preventScroll: true });
  }, [failure]);
  if (!failure) return null;
  const retry = failure.retry;
  return (
    <div
      ref={element}
      role="alert"
      tabIndex={-1}
      className={`write-failure ${className ?? ''}`}
      data-action={failure.action}
    >
      <p>
        <strong>{failure.title}</strong> <span className="write-failure-detail">{failure.detail}</span>
      </p>
      <div className="write-failure-actions">
        {retry && (
          <button
            type="button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void retry().finally(() => setRetrying(false));
            }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <button type="button" disabled={retrying} onClick={() => clearWriteFailure(failure.key)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
