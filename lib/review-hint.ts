import { useSyncExternalStore } from 'react';

/**
 * The one-time tip under the Changes tree's options, with Symbols on: "Press V to mark what you're reading and go on to
 * the next change". It shows until the reader's first V or its ×, then never again, on this computer, as the tree's
 * width is kept (localStorage).
 */
const KEY = 'gnosis-review-v-hint';
const listeners = new Set<() => void>();
const read = () => {
  try {
    return localStorage.getItem(KEY) !== 'done';
  } catch {
    // Without storage, no tip: it could never go away for good.
    return false;
  }
};
let showing: boolean | undefined;
/** The tip is done with: the reader pressed V, or dismissed it. */
export function finishVHint() {
  if (showing === false) return;
  showing = false;
  try {
    localStorage.setItem(KEY, 'done');
  } catch {
    /* Gone for this session at least. */
  }
  listeners.forEach((listener) => listener());
}
export function useVHint(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (showing ??= read())
  );
}
