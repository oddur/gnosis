import { useEffect, useState } from 'react';
import { FolderGit2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import type { LocalCloneStatus } from '../lib/local-clone';

const groupByPath = (clones: LocalCloneStatus[]) => {
  const groups = new Map<string, LocalCloneStatus[]>();
  for (const clone of clones) groups.set(clone.path, [...(groups.get(clone.path) ?? []), clone]);
  return [...groups];
};
const activity = (clone: LocalCloneStatus) =>
  clone.reads || clone.fallbacks
    ? `${clone.reads.toLocaleString()} read${clone.reads === 1 ? '' : 's'} from Git this session${clone.fallbacks ? `, ${clone.fallbacks.toLocaleString()} from GitHub after a clone problem` : ''}`
    : `Uses the ${clone.remote} remote`;

export function LocalCloneSettings() {
  const [clones, setClones] = useState<LocalCloneStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void window.electronAPI
      .getLocalClones()
      .then(setClones)
      .catch(() => {});
  }, []);
  const change = async (action: () => Promise<LocalCloneStatus[] | undefined>) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (next) setClones(next);
    } catch (reason) {
      setError(
        (reason instanceof Error ? reason.message : String(reason)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
      );
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    change(async () => {
      const directory = await window.electronAPI.pickRepoDir();
      return directory ? window.electronAPI.addLocalClone(directory) : undefined;
    });
  return (
    <section className="flex flex-col items-start gap-3" aria-labelledby="local-clones-title">
      <h3 id="local-clones-title" className="text-sm font-medium">
        Local clones
      </h3>
      <p className="settings-description">
        Read PR changes, commits, and files from a clone on this computer to save GitHub API requests. PR details,
        comments, and checks still come from GitHub. Gnosis fetches missing commits into the clone, without changing its
        branches or working files.
      </p>
      {groupByPath(clones).map(([directory, entries]) => (
        <div key={directory} className="flex w-full items-start justify-between gap-3" data-local-clone={directory}>
          <div className="min-w-0">
            {entries.map((clone) => (
              <div key={clone.repo}>
                <p className="text-sm">{clone.repo}</p>
                <p className="settings-description">{activity(clone)}</p>
                {clone.lastError && <p className="settings-description break-words">Last problem: {clone.lastError}</p>}
              </div>
            ))}
            <p className="settings-description break-all">{directory}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`Remove clone at ${directory}`}
            onClick={() => void change(() => window.electronAPI.removeLocalClone(directory))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void add()}>
        <FolderGit2 aria-hidden="true" />
        Add clone…
      </Button>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
