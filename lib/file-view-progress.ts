import { readReviewState, patchFileProgress } from './renderer-review-state';
import { FILE_PROGRESS_KEY, type FileProgressPatch } from './review-state';
import { useSyncExternalStore } from 'react';
import { span } from './perf-spans';
import { fileRevisionKey, type PrChanges } from './pr-changes';
import { commitViewedKey } from './pr-commits';
export interface Progress {
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
  span('viewed marks', () => listeners.forEach((fn) => fn()));
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
/**
 * Per-symbol Viewed (#394): a reviewer ticks off the symbols of a file's outline (lib/symbol-outline.ts). A mark is
 * kept beside the file's own, under the file's revision key and the symbol's id, and follows the file's content alias
 * as the file's mark does: a new head that leaves the file's change alone keeps its ticks, a new change to the file
 * starts them afresh. A mark made before the alias was known is still found under the raw key.
 */
export const symbolViewedKey = (fileKey: string, symbolId: string) => `symbol:${JSON.stringify([fileKey, symbolId])}`;
export function isSymbolViewed(fileKey: string, symbolId: string): boolean {
  const s = load();
  const resolved = s.marks[symbolViewedKey(s.aliases[fileKey] ?? fileKey, symbolId)];
  return resolved ?? !!s.marks[symbolViewedKey(fileKey, symbolId)];
}
/**
 * Symbols the reader unticked in this session, by file revision key and id: "Mark a symbol viewed after you scroll
 * through it" (lib/symbol-auto-view.ts) never ticks one of them again, so it does not fight the reader's own choice.
 * Kept in memory only: a new session starts with the marks as they were saved.
 */
const unticked = new Set<string>();
export const wasSymbolUnticked = (fileKey: string, symbolId: string) => unticked.has(JSON.stringify([fileKey, symbolId]));
/** Ticks or unticks symbols of one file with one notification and one persisted patch. */
export function markSymbolsViewed(fileKey: string, symbolIds: readonly string[], viewed: boolean) {
  const s = load();
  const resolvedFile = s.aliases[fileKey] ?? fileKey;
  const marks: Record<string, boolean> = {};
  for (const id of new Set(symbolIds)) {
    if (isSymbolViewed(fileKey, id) === viewed) continue;
    const key = symbolViewedKey(resolvedFile, id);
    s.marks[key] = viewed;
    marks[key] = viewed;
    if (!viewed) unticked.add(JSON.stringify([fileKey, id]));
  }
  return Object.keys(marks).length ? changed({ aliases: {}, marks }) : Promise.resolve(true);
}
export function useFileProgress() {
  useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => version
  );
  return { isFileViewed, markFileViewed, markFilesViewed, isSymbolViewed, markSymbolsViewed };
}

/**
 * The marks that make files of a view read as viewed, by key, from a progress state: each file's own mark under its
 * content alias, and every symbol tick (`@top` and Body ids included) under its alias or its raw revision key. Ticks
 * kept for another revision of a file, under another alias, are not this view's and are left alone.
 */
export function viewedMarkKeys(state: Progress, fileKeys: readonly string[]): string[] {
  const files = new Set<string>();
  for (const key of fileKeys) {
    files.add(key);
    files.add(state.aliases[key] ?? key);
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(state.marks)) {
    if (!value) continue;
    // A file's own mark, under its alias or, made before the alias was known, its revision key.
    if (files.has(key)) {
      keys.push(key);
      continue;
    }
    if (!key.startsWith('symbol:')) continue;
    try {
      const [file] = JSON.parse(key.slice('symbol:'.length)) as [string, string];
      if (files.has(file)) keys.push(key);
    } catch {
      /* Not a symbol mark of ours. */
    }
  }
  return keys;
}

/** What a reset cleared, to put back exactly: the marks that were on, and the session's unticks for these files. */
export interface ViewedSnapshot {
  marks: string[];
  unticked: string[];
}
/** Whether any file of the view reads as viewed or has a tick. */
export const hasViewedMarks = (fileKeys: readonly string[]) => viewedMarkKeys(load(), fileKeys).length > 0;
/** The progress store's version: it changes with every mark, for views that derive from all of it. */
export const progressVersion = () => version;

/**
 * Clears Viewed for every file in `fileKeys` and every one of their symbol ticks, in one notification and one saved
 * patch, and forgets the session's unticks for them. Returns what it cleared, for `restoreViewed`.
 */
export function resetViewed(fileKeys: readonly string[]): { snapshot: ViewedSnapshot; saved: Promise<boolean> } {
  const s = load();
  const keys = viewedMarkKeys(s, fileKeys);
  const files = new Set(fileKeys);
  const forgotten = [...unticked].filter((entry) => files.has((JSON.parse(entry) as [string, string])[0]));
  for (const entry of forgotten) unticked.delete(entry);
  const marks: Record<string, boolean> = {};
  for (const key of keys) {
    s.marks[key] = false;
    marks[key] = false;
  }
  return { snapshot: { marks: keys, unticked: forgotten }, saved: keys.length ? changed({ aliases: {}, marks }) : Promise.resolve(true) };
}
/** Puts back what `resetViewed` cleared. */
export function restoreViewed(snapshot: ViewedSnapshot): Promise<boolean> {
  const s = load();
  const marks: Record<string, boolean> = {};
  for (const key of snapshot.marks) {
    s.marks[key] = true;
    marks[key] = true;
  }
  for (const entry of snapshot.unticked) unticked.add(entry);
  return snapshot.marks.length ? changed({ aliases: {}, marks }) : Promise.resolve(true);
}
