import { createContext, useContext } from 'react';
import type { Preferences } from './types';
import type { RepositorySettingsMap } from './repository-settings';
export const RepositoryContext = createContext<{ settings: RepositorySettingsMap; configure?: (repo: string) => void }>(
  { settings: {} }
);
export const useRepositorySettings = () => useContext(RepositoryContext);
export function preferencesUpdated(prefs: Preferences) {
  window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: prefs }));
}
