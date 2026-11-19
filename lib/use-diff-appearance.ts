import { useSyncExternalStore, useMemo } from 'react';
import { DEFAULT_DIFF_APPEARANCE, type DiffAppearance } from './review-diff';
import { startupPreferences } from './startup-preferences';
let current: DiffAppearance | undefined;
const listeners = new Set<() => void>();
/** Keep mounted tabs and newly opened diff views in sync before the preference write finishes. */
export function publishDiffAppearance(value: DiffAppearance) {
  current = value;
  listeners.forEach((listener) => listener());
}
export function useDiffAppearance(saved?: DiffAppearance) {
  const value = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => current
  );
  return useMemo(() => ({ ...DEFAULT_DIFF_APPEARANCE, ...(value ?? saved) }), [value, saved]);
}

/** The appearance every diff follows now: the latest published, else the one saved at startup. */
export function currentDiffAppearance(): DiffAppearance {
  return { ...DEFAULT_DIFF_APPEARANCE, ...(current ?? startupPreferences()?.diffAppearance) };
}
