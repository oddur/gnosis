import { useEffect, useRef, useState } from 'react';
import { clearWriteFailure, onUnseenWriteFailure, showingWriteFailure, useWriteFailure } from '../lib/write-failures';
import { toast } from './ui/toast';

// A failure whose own notice is not on screen, such as a comment on a file scrolled out of view, still reaches the
// reader: as a toast with the same text and Retry. The typed text is already back in its composer.
onUnseenWriteFailure((failure) => {
  const id = toast.add({
    title: failure.title,
    description: failure.detail,
    type: 'error',
    ...(failure.retry
      ? {
          actionProps: {
            children: 'Retry',
            onClick: () => {
              toast.close(id);
              void failure.retry?.();
            },
          },
        }
      : {}),
  });
});

/**
 * A GitHub write that failed and was rolled back: what did not happen, GitHub's reason, and Retry. The reader's text
 * is already back in its composer; Retry sends it again. Quiet by default: one line of danger-colored text.
 */
export function WriteFailureNotice({ failureKey, className }: { failureKey: string | undefined; className?: string }) {
  const failure = useWriteFailure(failureKey);
  const [retrying, setRetrying] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const shown = !!failure;
  useEffect(() => (failureKey && shown ? showingWriteFailure(failureKey) : undefined), [failureKey, shown]);
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
