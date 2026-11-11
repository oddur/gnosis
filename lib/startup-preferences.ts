import type { Preferences } from './types';

interface PreferencesApi {
  loadPreferences: () => Promise<Preferences>;
  onPreferencesChanged?: (callback: (prefs: Preferences) => void) => () => void;
}

/** Read preferences once at startup and share them, instead of one IPC read per consumer. */
export function createStartupPreferences(api: PreferencesApi) {
  let current: Preferences | undefined;
  let changed = false;
  // A failed read resolves to undefined: settings recovery must stay available.
  const ready = api.loadPreferences().then(
    (prefs) => {
      if (!changed) current = prefs;
      return prefs;
    },
    () => undefined
  );
  api.onPreferencesChanged?.((prefs) => {
    changed = true;
    current = prefs;
  });
  let taken = false;
  return {
    /** The preferences read at startup. Startup-only settings, such as the diff highlighter, use these. */
    ready,
    /** The latest preferences seen, or undefined until the startup read finishes. */
    current: () => current,
    /** The first caller receives the startup read; later callers read again, so they never see stale values. */
    initial(): Promise<Preferences> {
      if (taken) return api.loadPreferences();
      taken = true;
      return ready.then((prefs) => (changed ? current : prefs) ?? api.loadPreferences());
    },
  };
}

// Created on first use, so test fixtures can install electronAPI after importing the app.
let shared: ReturnType<typeof createStartupPreferences> | undefined;
const startup = () => (shared ??= createStartupPreferences(window.electronAPI));

/** Resolves once the startup read finishes, with undefined if it failed. The renderer calls this first. */
export const preferencesReady = (): Promise<Preferences | undefined> => startup().ready;
/** Synchronous; kept current by preferences-changed. */
export const startupPreferences = (): Preferences | undefined => startup().current();
/** The first queue page uses the startup read; later pages and retries read again. */
export const initialPreferences = (): Promise<Preferences> => startup().initial();
