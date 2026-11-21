import { useSyncExternalStore } from 'react';
import { preferencesReady, startupPreferences } from './startup-preferences';

/**
 * The reader's code theme (Settings → Code theme), for views that have no preferences of their own, such as chat.
 * It follows the saved preference: the startup read, then every change.
 */
let current: string | undefined;
let started = false;
const listeners = new Set<() => void>();

function set(theme: unknown) {
  if (typeof theme !== 'string' || theme === current) return;
  current = theme;
  for (const listener of listeners) listener();
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI;
  const fromPreferences = (preferences: unknown) =>
    set((preferences as { codeTheme?: unknown } | undefined)?.codeTheme);
  // Some windows and fixtures expose only part of the API.
  if (api?.loadPreferences) {
    fromPreferences(startupPreferences());
    void preferencesReady().then(fromPreferences, () => {});
  }
  api?.onPreferencesChanged?.(fromPreferences);
  window.addEventListener('gnosis-preferences-changed', (event) =>
    fromPreferences((event as CustomEvent<unknown>).detail)
  );
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The saved code theme's id, or undefined until preferences load. */
export function useReaderCodeTheme(): string | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
