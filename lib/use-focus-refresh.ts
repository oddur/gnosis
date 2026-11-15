import { useEffect } from 'react';
import { createRefreshThrottle } from './focus-refresh';

/** One throttle per window: switching back and forth between two PRs reads each at most every 30 s. */
const throttle = createRefreshThrottle();

/**
 * Reads the open PR again when the reader switches to its tab. Main reads only its watched metadata and signals, and
 * skips any read that started within 30 s.
 *
 * Returning to the app is main's job alone: `browser-window-focus` wakes every watched sync task, this PR's included,
 * with the same 30 s floor (`githubSync.wake`). Listening for focus here too would ask for the same read twice.
 */
export function useFocusRefresh(urls: readonly string[] | undefined) {
  const key = urls?.join('\n') ?? '';
  useEffect(() => {
    const send = window.electronAPI.refreshOpenPr;
    if (!key || typeof send !== 'function' || document.visibilityState === 'hidden') return;
    const due = throttle.take(key.split('\n'));
    if (due.length) send(due);
  }, [key]);
}
