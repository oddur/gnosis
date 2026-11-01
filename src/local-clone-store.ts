import fs from 'node:fs';
import path from 'node:path';
import { inspectLocalClone, normalizeLocalClones, type LocalCloneEntry } from '../lib/local-clone';

/** Clones belong to this machine, not an account, and outlive the GitHub cache. */
export function createLocalCloneStore(file: () => string) {
  const load = (): LocalCloneEntry[] => {
    try {
      return normalizeLocalClones(JSON.parse(fs.readFileSync(file(), 'utf8')));
    } catch {
      /* First use or an unreadable file. */
      return [];
    }
  };
  const save = (entries: LocalCloneEntry[]) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(file() + '.tmp', file());
    return entries;
  };
  return {
    load,
    async connect(repo: string, directory: string) {
      if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error('Choose a GitHub repository first.');
      const inspected = await inspectLocalClone(directory);
      const match = inspected.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase());
      if (!match)
        throw new Error(
          `This clone has no GitHub remote for ${repo}. Choose its clone or add a matching remote in Git.`
        );
      return save(normalizeLocalClones([...load(), match]));
    },
    disconnect(repo: string) {
      return save(load().filter((entry) => entry.repo.toLowerCase() !== repo.toLowerCase()));
    },
  };
}
