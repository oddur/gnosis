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
    async add(directory: string) {
      const added = await inspectLocalClone(directory);
      return save(normalizeLocalClones([...load(), ...added]));
    },
    remove(directory: string) {
      return save(load().filter((entry) => entry.path !== directory));
    },
  };
}
