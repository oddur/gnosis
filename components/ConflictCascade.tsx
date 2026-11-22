import { useEffect, useState } from 'react';
import { cascadePrLine, cascadeReviewLine, cascadeSentence, type CascadeState } from '../lib/conflict-cascade';
import { markersLeft } from '../lib/conflict-markers';
import type { ConflictSession } from '../lib/conflict-resolution';
import { Button } from './ui/button';

export interface ConflictCascade {
  state: CascadeState | undefined;
  /** Check again after a failure. */
  retry: () => void;
}

/**
 * The cascade preview for this draft version (#445 item 22), once every file is reviewed and other PRs stack on this
 * one. Main runs the dry run in the background and says when it changes; a request of yours (`busy`) stops it, and it
 * is asked for again when that is done.
 */
export function useConflictCascade(session: ConflictSession | undefined, busy: boolean): ConflictCascade {
  const [value, setValue] = useState<{ key: string; state: CascadeState | undefined }>();
  const [retries, setRetries] = useState(0);
  const ready =
    !!session &&
    session.status === 'editing' &&
    !session.stale &&
    session.preparation !== 'up-to-date' &&
    !!session.dependents?.length &&
    session.files.every((file) => !file.unsupported && file.resolved && !markersLeft(file, file.result));
  const key = ready ? `${session.id}@${session.version}` : '';
  useEffect(() => {
    const api = window.electronAPI;
    if (!key || busy || !session || !api.conflictCascade) return;
    const { id, version } = session;
    let live = true;
    const read = (retry = false) =>
      api.conflictCascade?.(id, version, retry).then(
        (state) => {
          if (live && state) setValue({ key, state });
        },
        // An older main process, or a test without the handler: nothing shows.
        () => {}
      );
    void read(retries > 0);
    const off = api.onConflictCascadeChanged?.((changed) => {
      if (changed === id) void read();
    });
    return () => {
      live = false;
      off?.();
    };
  }, [key, busy, retries]);
  return {
    state: key && value?.key === key ? value.state : undefined,
    retry: () => setRetries((count) => count + 1),
  };
}

/** The preview in the push confirmation: advisory, it never changes what needs review. */
export function ConflictCascadeLine({ cascade }: { cascade: ConflictCascade }) {
  const { state } = cascade;
  if (!state) return null;
  if (state.state === 'checking')
    return (
      <li data-cascade="checking" role="status">
        Checking the stack…
      </li>
    );
  if (state.state === 'battery')
    return <li data-cascade="battery">The stack is checked when your computer is on power.</li>;
  if (state.state === 'failed')
    return (
      <li data-cascade="failed">
        Couldn’t check the stack: {state.message}{' '}
        <Button size="sm" variant="link" className="h-auto p-0" onClick={cascade.retry}>
          Check again
        </Button>
      </li>
    );
  if (!state.preview.prs.length) return null;
  return (
    <li data-cascade="ready">
      <span data-cascade-sentence="">{cascadeSentence(state.preview)}</span>{' '}
      <span data-cascade-review="">{cascadeReviewLine(state.preview)}</span> A dry run that pushes nothing. The restack
      after the push still asks you to review each update that needs it.
      {/* Each PR's line waits under a disclosure (#445 distill): the sentence says what the stack needs. */}
      <details className="conflict-cascade-details">
        <summary>Each PR</summary>
        <ul className="conflict-cascade-prs">
          {state.preview.prs.map((pr) => (
            <li key={pr.url} data-cascade-outcome={pr.outcome}>
              {cascadePrLine(pr)}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
