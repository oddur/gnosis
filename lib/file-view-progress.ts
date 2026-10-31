import { readReviewState, patchFileProgress } from './renderer-review-state';
import { FILE_PROGRESS_KEY, type FileProgressPatch } from './review-state';
import { useSyncExternalStore } from 'react';
import { fileRevisionKey, type PrChanges } from './pr-changes';
import { commitViewedKey } from './pr-commits';
interface Progress {
  aliases: Record<string, string>;
  marks: Partial<Record<string, boolean>>;
}
const storageKey = FILE_PROGRESS_KEY;
let state: Progress | undefined;
let version = 0;
const listeners = new Set<() => void>();
function load(): Progress {
  if (!state) {
    try {
      const saved = readReviewState(storageKey) as Partial<Progress> | null;
      state =
        saved?.aliases && saved.marks ? { aliases: saved.aliases, marks: saved.marks } : { aliases: {}, marks: {} };
    } catch {
      state = { aliases: {}, marks: {} };
    }
  }
  return state;
}
function changed(patch: FileProgressPatch) {
  version++;
  listeners.forEach((fn) => fn());
  return patchFileProgress(patch)
    .then(() => true)
    .catch((error: unknown) => {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function')
        window.dispatchEvent(
          new CustomEvent('gnosis-storage-error', {
            detail: {
              message: 'Viewed progress could not be saved. Your marks are kept for this session.',
              retry: () =>
                patchFileProgress({
                  aliases: Object.fromEntries(Object.keys(patch.aliases).map((key) => [key, load().aliases[key]])),
                  marks: Object.fromEntries(Object.keys(patch.marks).map((key) => [key, !!load().marks[key]])),
                }),
            },
          })
        );
      else console.warn('Viewed progress could not be saved:', error);
      return false;
    });
}
export function registerChangeProgress(snapshot: PrChanges) {
  const store = load();
  let dirty = false;
  const patch: FileProgressPatch = { aliases: {}, marks: {} };
  for (const file of snapshot.files) {
    const revision = fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha);
    const content = JSON.stringify([snapshot.url, file.path, file.changeId]);
    if (store.aliases[revision] === content) continue;
    if (store.marks[revision]) {
      store.marks[content] = true;
      patch.marks[content] = true;
    }
    store.aliases[revision] = content;
    patch.aliases[revision] = content;
    dirty = true;
  }
  if (dirty) void changed(patch);
}
export function isFileViewed(key: string): boolean {
  const s = load();
  return !!s.marks[s.aliases[key] ?? key];
}
/** Update a folder with one notification and one persisted patch, even for thousands of files. */
export function markFilesViewed(keys: readonly string[], viewed: boolean) {
  const s = load();
  const marks: Record<string, boolean> = {};
  for (const key of new Set(keys)) {
    const resolved = s.aliases[key] ?? key;
    if (!!s.marks[resolved] !== viewed) {
      s.marks[resolved] = viewed;
      marks[resolved] = viewed;
    }
    // Clearing any file must also clear the completed-commit summary.
    if (!viewed && key.startsWith('commit:')) {
      try {
        const [url, , base, head] = JSON.parse(key.slice('commit:'.length)) as string[];
        const summary = commitViewedKey(url, head, base === '4b825dc642cb6eb9a060e54bf8d69288fbee4904' ? '' : base);
        if (s.marks[summary]) {
          s.marks[summary] = false;
          marks[summary] = false;
        }
      } catch {
        /* An unknown legacy key still retains its file mark. */
      }
    }
  }
  return Object.keys(marks).length ? changed({ aliases: {}, marks }) : Promise.resolve(true);
}
export function markFileViewed(key: string, viewed: boolean) {
  return markFilesViewed([key], viewed);
}
export function useFileProgress() {
  useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => version
  );
  return { isFileViewed, markFileViewed, markFilesViewed };
}
