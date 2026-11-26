import { useSyncExternalStore } from 'react';
import { isFileViewed, isSymbolViewed, markFileViewed, markSymbolsViewed } from './file-view-progress';
import { fileAfterTick } from './tree-symbol-review';

/**
 * A file's symbol ticks and its own Viewed mark agree, in symbol mode (Settings › Review › "Show changed symbols in the
 * file tree"): ticking the last counted item marks the file Viewed, and unticking any of a Viewed file's symbols makes
 * it unviewed again (lib/tree-symbol-review.ts `fileAfterTick`). Every tick goes through `markReviewSymbols`: the
 * tree's V and menu, the outline's ticks, and the scrolled-through ticks.
 *
 * Changes registers each symbol-mode file with what its review counts (`registerCountedSymbols`). A file without one
 * (symbol mode off, or an Explanation topic with no Changes open for the PR) keeps its ticks apart from the file, as
 * before. Marking or unmarking the file by hand never changes the ticks: unviewing a file keeps the reader's work.
 *
 * A file its ticks marked stays open while the reader is on it (`useHeldOpen`): its code does not collapse out from
 * under them. It collapses once they move on, scrolling it out of view or jumping elsewhere (`releaseHeld`).
 */

const counters = new Map<string, () => readonly string[] | undefined>();
const syncListeners = new Set<() => void>();
const syncChanged = () => syncListeners.forEach((listener) => listener());

/** The file's counted ids now, or undefined while its symbols are not known for this revision. */
export function registerCountedSymbols(fileKey: string, counted: () => readonly string[] | undefined): () => void {
  counters.set(fileKey, counted);
  syncChanged();
  return () => {
    if (counters.get(fileKey) !== counted) return;
    counters.delete(fileKey);
    syncChanged();
  };
}
/** Whether the file's ticks and its Viewed mark agree: the outline then offers no "Mark file viewed". */
export function useSymbolFileSync(fileKey: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    () => counters.has(fileKey)
  );
}

/** Ticks or unticks symbols of a file, and marks or unmarks the file as its ticks then say. */
export async function markReviewSymbols(fileKey: string, ids: readonly string[], viewed: boolean): Promise<boolean> {
  const counted = counters.get(fileKey)?.();
  const fileViewed = isFileViewed(fileKey);
  const plan = fileAfterTick({ counted, ids, viewed, fileViewed, isViewed: (id) => isSymbolViewed(fileKey, id) });
  // The rest of a Viewed file's symbols read as ticked: they stay ticked once the file is not Viewed.
  const saved = [plan.others.length ? markSymbolsViewed(fileKey, plan.others, true) : Promise.resolve(true), markSymbolsViewed(fileKey, ids, viewed)];
  if (plan.file === 'mark') {
    holdOpen(fileKey);
    saved.push(markFileViewed(fileKey, true));
  } else if (plan.file === 'unmark') {
    releaseOne(fileKey);
    saved.push(markFileViewed(fileKey, false));
  }
  return (await Promise.all(saved)).every(Boolean);
}

// Files their ticks marked Viewed that stay open until the reader moves on.
const held = new Set<string>();
const heldListeners = new Set<() => void>();
const heldChanged = () => heldListeners.forEach((listener) => listener());
/** Before a held file collapses: the stream keeps what the reader looks at in place (PrChangesView). */
let beforeCollapse: (() => void) | undefined;
export function setBeforeCollapse(run: (() => void) | undefined) {
  beforeCollapse = run;
}
function holdOpen(fileKey: string) {
  held.add(fileKey);
  heldChanged();
}
function releaseOne(fileKey: string) {
  if (held.delete(fileKey)) heldChanged();
}
/**
 * The reader moved on: held files collapse, but `except` (the file a jump goes into). `anchor` keeps the view in
 * place first, for a collapse the reader did not ask for (scrolling it out of view); a jump moves the view anyway.
 */
export function releaseHeld({ except, anchor = false, only }: { except?: string; anchor?: boolean; only?: string } = {}) {
  const going = [...held].filter((key) => key !== except && (only === undefined || key === only));
  if (!going.length) return;
  if (anchor) beforeCollapse?.();
  for (const key of going) held.delete(key);
  heldChanged();
}
/** The files held open now, one per line: Unviewed only keeps them listed until the reader moves on. */
export function useHeldFiles(): ReadonlySet<string> {
  const value = useSyncExternalStore(
    (listener) => {
      heldListeners.add(listener);
      return () => heldListeners.delete(listener);
    },
    () => [...held].join('\n')
  );
  return new Set(value ? value.split('\n') : []);
}
/** Whether the file stays open though it is Viewed: its ticks marked it, and the reader is still on it. */
export function useHeldOpen(fileKey: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      heldListeners.add(listener);
      return () => heldListeners.delete(listener);
    },
    () => held.has(fileKey)
  );
}
