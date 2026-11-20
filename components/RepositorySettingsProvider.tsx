import { RepositoryContext, preferencesUpdated } from '../lib/use-repository-settings';
import { useEffect, useState, type ReactNode } from 'react';
import { useWorkbenchQueue } from '../lib/workbench-store';
import type { Preferences } from '../lib/types';
import {
  repositoryKey,
  normalizeRepositorySettings,
  type RepositorySettings,
  type BriefingBudget,
} from '../lib/repository-settings';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { RepositorySettingsEditor } from './RepositorySettingsEditor';
import {
  botAllowed,
  normalizeBotLogins,
  normalizeNotificationPreferences,
  notificationSettings,
  repositoryNotificationLevel,
  type RepositoryNotificationLevel,
} from '../lib/notification-settings';
export function RepositorySettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>();
  const [repo, setRepo] = useState('');
  // The budget comes with the shared queue snapshot; a snapshot read of its own would copy the whole queue again (#345).
  const budget: BriefingBudget | undefined = useWorkbenchQueue(!!repo).briefingBudget;
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void window.electronAPI
      .loadPreferences()
      .then((p) => {
        if (live) setPrefs(p);
      })
      .catch(() => {});
    const listener = (e: Event) => setPrefs((e as CustomEvent<Preferences>).detail);
    window.addEventListener('gnosis-preferences-changed', listener);
    const unsub = window.electronAPI.onPreferencesChanged?.((p) => preferencesUpdated(p));
    return () => {
      live = false;
      window.removeEventListener('gnosis-preferences-changed', listener);
      unsub?.();
    };
  }, []);
  async function save(value: RepositorySettings) {
    setSaving(true);
    setError('');
    try {
      const current = await window.electronAPI.loadPreferences();
      const next = {
        ...current,
        repositorySettings: normalizeRepositorySettings({
          ...current.repositorySettings,
          [repositoryKey(repo)]: value,
        }),
      };
      await window.electronAPI.savePreferences(next);
      preferencesUpdated(next);
      setRepo('');
    } catch {
      setError('Could not save repository settings. Try again.');
    } finally {
      setSaving(false);
    }
  }
  /** Saves one change on top of the latest preferences, so edits made elsewhere are kept. */
  async function update(change: (current: Preferences) => Preferences) {
    const current = await window.electronAPI.loadPreferences();
    const next = change(current);
    await window.electronAPI.savePreferences(next);
    preferencesUpdated(next);
  }
  const notifications = prefs ? notificationSettings(prefs) : undefined;
  return (
    <RepositoryContext.Provider
      value={{
        settings: prefs?.repositorySettings ?? {},
        notificationLevel: notifications
          ? (name) => ({ level: repositoryNotificationLevel(notifications, name), explicit: !!notifications.repositories[repositoryKey(name)] })
          : undefined,
        setNotificationLevel: (name: string, level: RepositoryNotificationLevel) =>
          update((current) => {
            const key = repositoryKey(name);
            return { ...current, repositorySettings: normalizeRepositorySettings({ ...current.repositorySettings, [key]: { ...current.repositorySettings?.[key], notifications: level } }) };
          }),
        setShowMergedConflicts: (name: string, show: boolean) =>
          update((current) => {
            const key = repositoryKey(name);
            const value: RepositorySettings = { ...current.repositorySettings?.[key] };
            delete value.showMergedConflicts;
            if (!show) value.showMergedConflicts = false;
            return { ...current, repositorySettings: normalizeRepositorySettings({ ...current.repositorySettings, [key]: value }) };
          }),
        allowBotNotifications: (login: string) =>
          update((current) => {
            const saved = normalizeNotificationPreferences(current);
            return { ...current, notificationSettings: { ...saved, allowedBots: normalizeBotLogins([...saved.allowedBots, login]) } };
          }),
        botNotificationsAllowed: notifications ? (login) => botAllowed(notifications, login) : undefined,
        configure: prefs
          ? (name) => {
              setError('');
              setRepo(name);
            }
          : undefined,
      }}
    >
      {children}
      <Dialog
        open={!!repo}
        onOpenChange={(open) => {
          if (!open && !saving) setRepo('');
        }}
      >
        <DialogContent className="repository-settings-dialog" showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>Repository settings</DialogTitle>
            <DialogDescription>Global defaults apply unless you override them here.</DialogDescription>
          </DialogHeader>
          {prefs && repo && (
            <RepositorySettingsEditor
              key={repo}
              repo={repo}
              value={prefs.repositorySettings?.[repositoryKey(repo)] ?? {}}
              defaults={prefs}
              budget={budget}
              saving={saving}
              error={error}
              onCancel={() => setRepo('')}
              onApply={(value) => void save(value)}
            />
          )}
        </DialogContent>
      </Dialog>
    </RepositoryContext.Provider>
  );
}
