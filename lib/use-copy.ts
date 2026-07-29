import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Clipboard write with a transient confirmation state, shared by every
 * copy affordance. Handles the two failure modes a bare
 * `writeText().then(...)` misses: the promise rejecting (in Electron,
 * NotAllowedError when the window loses focus — surfaced as `failed`
 * instead of silently doing nothing), and the reset timer outliving the
 * component or a rapid re-click (cleared on unmount and before each
 * re-arm, so state can't flicker or setState after unmount).
 */
export function useCopyToClipboard(resetMs = 1500): {
  state: CopyState;
  copy: (text: string) => void;
} {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const flash = useCallback(
    (next: CopyState) => {
      setState(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), resetMs);
    },
    [resetMs]
  );

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => flash('copied'),
        () => flash('failed')
      );
    },
    [flash]
  );

  return { state, copy };
}
