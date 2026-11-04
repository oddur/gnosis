import type { Preferences } from './types';

export type ChecksView = 'list' | 'graph';
let preferred: ChecksView = 'list';
let writes: Promise<void> = Promise.resolve();

/** Restore before mounting the app so Checks never flashes the other view. */
export function initializeChecksView(preferences?: Pick<Preferences, 'checksView'>) {
  preferred = preferences?.checksView === 'graph' ? 'graph' : 'list';
}
export function preferredChecksView(): ChecksView {
  return preferred;
}

/** Keep explicit choices across navigation; ordered writes survive component unmounts. */
export function rememberChecksView(view: ChecksView): Promise<void> {
  preferred = view;
  writes = writes
    .catch(() => {})
    .then(async () => {
      const preferences = await window.electronAPI.loadPreferences();
      await window.electronAPI.savePreferences({ ...preferences, checksView: view });
    });
  return writes;
}
