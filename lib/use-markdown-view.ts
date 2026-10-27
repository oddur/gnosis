import { useSyncExternalStore } from 'react';
import { readReviewState, writeReviewState } from './renderer-review-state';
interface MarkdownView {
  mode: 'source' | 'preview';
  changes: boolean;
}
const key = 'gnosis-markdown-view:v1';
let value: MarkdownView | undefined;
const listeners = new Set<() => void>();
function load(): MarkdownView {
  if (!value) {
    let saved: Partial<MarkdownView> | undefined;
    try {
      saved = readReviewState(key) as Partial<MarkdownView> | undefined;
    } catch {
      /* Default before storage is ready. */
    }
    value = { mode: saved?.mode === 'source' ? 'source' : 'preview', changes: saved?.changes !== false };
  }
  return value;
}
export function useMarkdownView() {
  const current = useSyncExternalStore((callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }, load);
  return [
    current,
    (patch: Partial<MarkdownView>) => {
      value = { ...load(), ...patch };
      listeners.forEach((listener) => listener());
      void writeReviewState(key, value).catch(() =>
        window.dispatchEvent(
          new CustomEvent('gnosis-storage-error', {
            detail: {
              message: 'Markdown display preferences could not be saved. Your choice is kept for this session.',
            },
          })
        )
      );
    },
  ] as const;
}
