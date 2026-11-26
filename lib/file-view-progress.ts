import { readReviewState, patchFileProgress } from './renderer-review-state';
import { FILE_PROGRESS_KEY, type FileProgressPatch } from './review-state';
import { useSyncExternalStore } from 'react';
import { span } from './perf-spans';
import { fileRevisionKey, type PrChanges } from './pr-changes';
import { commitViewedKey } from './pr-commits';
import { UNTICKED, itemPrint, readSavedPrint, savedPrint, type EarlierTick } from './review-prints';
export interface Progress {
  aliases: Record<string, string>;
  marks: Partial<Record<string, boolean>>;
  /** What each tick's item read when ticked, by the mark's key (lib/review-prints.ts `savedPrint`). */
  prints?: Record<string, string>;
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
        saved?.aliases && saved.marks ? { aliases: saved.aliases, marks: saved.marks, prints: saved.prints ?? {} } : { aliases: {}, marks: {}, prints: {} };
    } catch {
      state = { aliases: {}, marks: {}, prints: {} };
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
                  prints: Object.fromEntries(Object.keys(patch.prints ?? {}).map((key) => [key, load().prints?.[key] ?? ''])),
                }),
            },
          })
        );
      else console.warn('Viewed progress could not be saved:', error);
      return false;
    });
}
/** Every PR file revision registered, by PR and path: built once, again only when revisions are added. */
let byPath: Map<string, string[]> | undefined;
function revisionsByPath(s: Progress): Map<string, string[]> {
  if (byPath) return byPath;
  byPath = new Map();
  for (const revision of Object.keys(s.aliases)) {
    if (!revision.startsWith('[')) continue;
    try {
      const [url, path] = JSON.parse(revision) as string[];
      const key = `${url}\u0000${path}`;
      byPath.set(key, [...(byPath.get(key) ?? []), revision]);
    } catch {
      /* Not a PR file revision. */
    }
  }
  return byPath;
}
/** A renamed file's old path, by its revision key, as the PR's file list reports it. */
const renamedFrom = new Map<string, string>();
/** Each registered file revision's patch, for the print a file's Viewed mark saves: no read, nothing hashed till then. */
const revisionFiles = new Map<string, { patch?: string }>();
/**
 * A whole file's print: its patch. None without one (a deferred or very large diff): a blob alone says nothing of the
 * base, so such a file never carries (fail closed).
 */
export function filePrint(fileKey: string): string | undefined {
  const patch = revisionFiles.get(fileKey)?.patch;
  return patch === undefined ? undefined : itemPrint(patch);
}
/** Whether a file revision is registered (`registerChangeProgress`): carry-over waits for it. */
export const isRegistered = (fileKey: string) => revisionFiles.has(fileKey);
export function registerChangeProgress(snapshot: PrChanges) {
  const store = load();
  let dirty = false;
  const patch: FileProgressPatch = { aliases: {}, marks: {} };
  for (const file of snapshot.files) {
    const revision = fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha);
    revisionFiles.set(revision, { patch: file.patch });
    // A rename's earlier revisions are under its old path.
    if (file.previousPath && file.previousPath !== file.path) renamedFrom.set(revision, file.previousPath);
    const content = JSON.stringify([snapshot.url, file.path, file.changeId]);
    if (store.aliases[revision] === content) continue;
    if (store.marks[revision]) {
      store.marks[content] = true;
      patch.marks[content] = true;
    }
    store.aliases[revision] = content;
    patch.aliases[revision] = content;
    byPath = undefined;
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
  const prints: Record<string, string> = {};
  for (const key of new Set(keys)) {
    const resolved = s.aliases[key] ?? key;
    if (!!s.marks[resolved] !== viewed) {
      s.marks[resolved] = viewed;
      marks[resolved] = viewed;
      // A file marked by hand keeps what its whole change read: its mark carries to a revision with the same patch.
      // Unmarked, it shadows its earlier revisions' marks, which then carry no more.
      const print = viewed ? filePrint(key) : UNTICKED;
      if (print) prints[resolved] = (s.prints ??= {})[resolved] = savedPrint(print, Date.now());
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
  return Object.keys(marks).length ? changed({ aliases: {}, marks, prints }) : Promise.resolve(true);
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
/**
 * Ticks or unticks symbols of one file with one notification and one persisted patch. A tick saves its item's print
 * when `prints` has it (lib/review-prints.ts), so it can carry to the file's next revision; one without never does.
 */
export function markSymbolsViewed(fileKey: string, symbolIds: readonly string[], viewed: boolean, prints?: Readonly<Record<string, string>>) {
  const s = load();
  const resolvedFile = s.aliases[fileKey] ?? fileKey;
  const marks: Record<string, boolean> = {};
  const saved: Record<string, string> = {};
  const at = Date.now();
  for (const id of new Set(symbolIds)) {
    // The reader unticked it, even if only its file's mark showed it ticked: scrolling must not tick it again.
    if (!viewed) unticked.add(JSON.stringify([fileKey, id]));
    if (isSymbolViewed(fileKey, id) === viewed) continue;
    const key = symbolViewedKey(resolvedFile, id);
    s.marks[key] = viewed;
    marks[key] = viewed;
    if (viewed && prints?.[id]) saved[key] = (s.prints ??= {})[key] = savedPrint(prints[id], at);
    // An untick shadows the earlier revisions' ticks of the item: none carries past it (`earlierTicks`).
    if (!viewed) saved[key] = (s.prints ??= {})[key] = savedPrint(UNTICKED, at);
  }
  return Object.keys(marks).length ? changed({ aliases: {}, marks, prints: saved }) : Promise.resolve(true);
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
  /** The cleared marks' prints, which the reset replaced with unticks: Undo puts them back. */
  prints?: Record<string, string>;
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
  // Each cleared mark is an untick: its earlier revisions' ticks carry no more (`earlierTicks`).
  const prints: Record<string, string> = {};
  const previous: Record<string, string> = {};
  const at = Date.now();
  for (const key of keys) {
    s.marks[key] = false;
    marks[key] = false;
    previous[key] = s.prints?.[key] ?? '';
    prints[key] = (s.prints ??= {})[key] = savedPrint(UNTICKED, at);
  }
  return {
    snapshot: { marks: keys, unticked: forgotten, prints: previous },
    saved: keys.length ? changed({ aliases: {}, marks, prints }) : Promise.resolve(true),
  };
}
/** Puts back what `resetViewed` cleared. */
export function restoreViewed(snapshot: ViewedSnapshot): Promise<boolean> {
  const s = load();
  const marks: Record<string, boolean> = {};
  const prints: Record<string, string> = {};
  for (const key of snapshot.marks) {
    s.marks[key] = true;
    marks[key] = true;
    // The prints the ticks had (none: a tick saved before prints, which never carries).
    prints[key] = (s.prints ??= {})[key] = snapshot.prints?.[key] ?? '';
  }
  for (const entry of snapshot.unticked) unticked.add(entry);
  return snapshot.marks.length ? changed({ aliases: {}, marks, prints }) : Promise.resolve(true);
}

/**
 * The newest tick of each of `ids` in this PR file's earlier revisions (the same path, or the path it was renamed
 * from), with its print, for carry-over (lib/review-prints.ts `planCarry`). `fileKey` is the new revision's key; the
 * PR's other revisions are the ones registered under the same PR and path. `@file` stands for the file's own mark.
 */
export function earlierTicks(fileKey: string, ids: readonly string[]): Map<string, EarlierTick> {
  const out = new Map<string, EarlierTick>();
  let url: string, path: string;
  try {
    [url, path] = JSON.parse(fileKey) as [string, string];
  } catch {
    // A commit's, or a stack's combined, file: not a PR file revision. Nothing carries.
    return out;
  }
  const s = load();
  const own = s.aliases[fileKey] ?? fileKey;
  const paths = new Set([path, ...(renamedFrom.get(fileKey) ? [renamedFrom.get(fileKey) as string] : [])]);
  const index = revisionsByPath(s);
  const consider = (resolved: string, id: string, unticksOnly: boolean) => {
    const key = id === '@file' ? resolved : symbolViewedKey(resolved, id);
    const saved = readSavedPrint(s.prints?.[key]);
    let tick: EarlierTick;
    if (s.marks[key]) {
      if (unticksOnly) return;
      tick = saved && saved.print !== UNTICKED ? { print: saved.print, at: saved.at } : { at: saved?.at ?? 0 };
    }
    // An untick, there or here: newer than a tick, it shadows it (no print: nothing carries, nothing is Changed).
    else if (saved?.print === UNTICKED) tick = { at: saved.at };
    else return;
    const known = out.get(id);
    if (!known || tick.at > known.at) out.set(id, tick);
  };
  const seen = new Set<string>([own]);
  for (const revision of [...paths].flatMap((one) => index.get(`${url}\u0000${one}`) ?? [])) {
    const resolved = s.aliases[revision] ?? revision;
    // The same content is the same marks already; each content once.
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    for (const id of ids) consider(resolved, id, false);
  }
  // This revision's own unticks: what the reader unticked here, or reset, never comes back.
  for (const id of ids) consider(own, id, true);
  return out;
}
/**
 * Ticks carried from an earlier revision, saved under this one with the print they carried by: one notification, one
 * patch. `file` marks the file Viewed too, every counted item having carried.
 */
export function carryTicks(
  fileKey: string,
  carried: readonly { id: string; at: number; print: string }[],
  /** Marks the file Viewed too, saving this whole-file print with it, or none. */
  file?: { print?: string }
): Promise<boolean> {
  const s = load();
  const resolvedFile = s.aliases[fileKey] ?? fileKey;
  const marks: Record<string, boolean> = {};
  const prints: Record<string, string> = {};
  for (const { id, at, print } of carried) {
    const key = id === '@file' ? resolvedFile : symbolViewedKey(resolvedFile, id);
    if (s.marks[key]) continue;
    s.marks[key] = true;
    marks[key] = true;
    prints[key] = (s.prints ??= {})[key] = savedPrint(print, at);
  }
  if (file && !s.marks[resolvedFile]) {
    s.marks[resolvedFile] = true;
    marks[resolvedFile] = true;
    if (file.print) prints[resolvedFile] = (s.prints ??= {})[resolvedFile] = savedPrint(file.print, Date.now());
  }
  return Object.keys(marks).length ? changed({ aliases: {}, marks, prints }) : Promise.resolve(true);
}
