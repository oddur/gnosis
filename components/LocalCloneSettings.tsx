import { useEffect, useId, useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Button } from './ui/button';
import type { LocalCloneStatus } from '../lib/local-clone';

const message = (reason: unknown) =>
  (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  );

export function LocalCloneSettings({ repo }: { repo: string }) {
  const id = useId();
  const [clones, setClones] = useState<LocalCloneStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void window.electronAPI
      .getLocalClones()
      .then((entries) => {
        if (active) {
          setClones(entries);
          setLoaded(true);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const clone = clones.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase());
  const change = async (action: () => Promise<LocalCloneStatus[] | undefined>) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (next) setClones(next);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-w-0 flex-col items-start gap-3 border-t pt-4"
      aria-labelledby={id}
      data-local-clone-settings
    >
      <div className="repository-editor-heading">
        <h4 id={id}>Local clone</h4>
        <p>Read changes, commits, and files from Git. PR details, comments, and checks still come from GitHub.</p>
      </div>
      <div className="min-w-0 w-full" aria-live="polite">
        <p className="text-sm font-medium">
          {!loaded
            ? error
              ? 'Could not load clone settings'
              : 'Loading clone settings…'
            : clone
              ? clone.lastError
                ? 'Using GitHub when the clone is unavailable'
                : 'Local clone connected'
              : 'Using GitHub · No local clone'}
        </p>
        {clone && (
          <>
            <p className="settings-description break-all" data-local-clone-path>
              {clone.path}
            </p>
            <p className="settings-description">
              Remote: {clone.remote}
              {clone.reads || clone.fallbacks
                ? ` · ${clone.reads.toLocaleString()} Git reads · ${clone.fallbacks.toLocaleString()} GitHub fallbacks this session`
                : ''}
            </p>
            {clone.lastError && (
              <p className="settings-description break-words">Last clone problem: {clone.lastError}</p>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !loaded}
          onClick={() =>
            void change(async () => {
              const directory = await window.electronAPI.pickRepoDir();
              return directory ? window.electronAPI.connectLocalClone(repo, directory) : undefined;
            })
          }
        >
          <FolderGit2 aria-hidden="true" />
          {busy ? 'Updating…' : clone ? 'Change folder…' : 'Choose folder…'}
        </Button>
        {clone && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void change(() => window.electronAPI.disconnectLocalClone(repo))}
          >
            Disconnect
          </Button>
        )}
        {!loaded && error && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        )}
      </div>
      <p className="settings-description">
        Clone changes apply immediately, on this computer only. Gnosis fetches missing commits without changing your
        branches or working files. Disconnecting keeps the folder.
      </p>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)] break-words">
          {error}
        </p>
      )}
    </section>
  );
}
