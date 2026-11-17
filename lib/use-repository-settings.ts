import { createContext, useContext } from 'react';
import type { Preferences } from './types';
import type { RepositorySettingsMap } from './repository-settings';
import type { RepositoryNotificationLevel } from './notification-settings';
export interface RepositoryContextValue {
  settings: RepositorySettingsMap;
  configure?: (repo: string) => void;
  /** The level that applies to a repository's notifications, and whether the repository sets it itself. */
  notificationLevel?: (repo: string) => { level: RepositoryNotificationLevel; explicit: boolean };
  setNotificationLevel?: (repo: string, level: RepositoryNotificationLevel) => Promise<void>;
  /** "Allow notifications from this bot". */
  allowBotNotifications?: (login: string) => Promise<void>;
  botNotificationsAllowed?: (login: string) => boolean;
}
export const RepositoryContext = createContext<RepositoryContextValue>({ settings: {} });
export const useRepositorySettings = () => useContext(RepositoryContext);
export function preferencesUpdated(prefs: Preferences) {
  window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: prefs }));
}
