import { useSyncExternalStore } from 'react';
import { fileRevisionKey, type PrChanges } from './pr-changes';
interface Progress {
  aliases: Record<string, string>;
  marks: Partial<Record<string, boolean>>;
}
const storageKey = 'gnosis-file-progress:v1';
let state: Progress | undefined;
let version = 0;
const listeners = new Set<() => void>();
function load(): Progress {
  if (!state) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<Progress> | null;
      state =
        saved?.aliases && saved.marks ? { aliases: saved.aliases, marks: saved.marks } : { aliases: {}, marks: {} };
    } catch {
      state = { aliases: {}, marks: {} };
    }
  }
  return state;
}
function changed() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(load()));
  } catch {
    /* Session progress survives a storage failure. */
  }
  version++;
  listeners.forEach((fn) => fn());
}
export function registerChangeProgress(snapshot: PrChanges) {
  const store = load();
  let dirty = false;
  for (const file of snapshot.files) {
    const revision = fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha);
    const content = JSON.stringify([snapshot.url, file.path, file.changeId]);
    if (store.aliases[revision] === content) continue;
    if (store.marks[revision]) store.marks[content] = true;
    store.aliases[revision] = content;
    dirty = true;
  }
  if (dirty) changed();
}
export function isFileViewed(key: string): boolean {
  const s = load();
  return !!s.marks[s.aliases[key] ?? key];
}
export function markFileViewed(key: string, viewed: boolean) {
  const s = load();
  s.marks[s.aliases[key] ?? key] = viewed;
  changed();
}
export function useFileProgress() {
  useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => version
  );
  return { isFileViewed, markFileViewed };
}
