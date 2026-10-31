import { RepositoryContext, preferencesUpdated } from '../lib/use-repository-settings';
import { useEffect, useState, type ReactNode } from 'react';
import type { Preferences } from '../lib/types';
import {
  repositoryKey,
  normalizeRepositorySettings,
  type RepositorySettings,
  type BriefingBudget,
} from '../lib/repository-settings';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { RepositorySettingsEditor } from './RepositorySettingsEditor';
export function RepositorySettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>();
  const [repo, setRepo] = useState('');
  const [budget, setBudget] = useState<BriefingBudget>();
  useEffect(() => {
    if (!repo) return;
    let live = true;
    const update = () => {
      void window.electronAPI
        .workbenchSnapshot()
        .then((q) => {
          if (live) setBudget(q.briefingBudget);
        })
        .catch(() => {});
    };
    update();
    const unsubscribe = window.electronAPI.onWorkbenchChanged?.(update);
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [repo]);
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
  return (
    <RepositoryContext.Provider
      value={{
        settings: prefs?.repositorySettings ?? {},
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
