import { useSyncExternalStore } from 'react';
import type { ChangedSymbol } from './symbol-outline';
import type { SyntaxDefinition } from './syntax-scope';

/**
 * What the Changes file tree's symbol rows (lib/tree-symbols.ts) share with the diffs, by the file's revision key:
 * - where the reader is in each file, as its pinned breadcrumb names it (ChangesDiff), so the tree lights the symbol
 *   under the reading position;
 * - a jump the tree asked for, which the file's diff takes as its outline's own (DiffOutline), once it is mounted.
 */

const places = new Map<string, string>();
const placeListeners = new Set<() => void>();
const SEP = '>';

/**
 * The reader is in `chain` (outermost first) of the file, or no longer in any of its hunks (undefined). Each part is
 * `kind:name@start`: the start tells overloads apart (lib/tree-symbols.ts `readingSymbol`).
 */
export function setReadingPlace(fileKey: string, chain: readonly Pick<SyntaxDefinition, 'kind' | 'name' | 'start'>[] | undefined) {
  const value = chain?.map((definition) => `${definition.kind}:${definition.name}@${definition.start}`).join(SEP);
  if ((places.get(fileKey) ?? undefined) === value) return;
  if (value === undefined) places.delete(fileKey);
  else places.set(fileKey, value);
  for (const listener of placeListeners) listener();
}
const subscribePlaces = (listener: () => void) => {
  placeListeners.add(listener);
  return () => placeListeners.delete(listener);
};
/** Where the reader is in the file, as `kind:name@start` parts, outermost first; undefined outside its hunks. */
export function useReadingPlace(fileKey: string | undefined): string[] | undefined {
  const value = useSyncExternalStore(subscribePlaces, () => (fileKey ? places.get(fileKey) : undefined));
  return value === undefined ? undefined : value ? value.split(SEP) : [];
}

interface Jump {
  symbol: ChangedSymbol;
  before?: () => void;
  at: number;
}
/** A jump not taken by then is dropped: the reader has moved on, and a late one would pull the view away. */
const JUMP_WAIT_MS = 5_000;
const jumps = new Map<string, Jump>();
const targets = new Map<string, (symbol: ChangedSymbol) => void>();
const jumpListeners = new Set<() => void>();
const notifyJumps = () => jumpListeners.forEach((listener) => listener());

/**
 * A file's diff can take the reader to a symbol (ChangesDiff's navigator, as DiffOutline does): a jump that waited for
 * it goes now. `before` runs first, so the stream stops holding the file's top in place.
 */
export function registerSymbolTarget(fileKey: string, go: (symbol: ChangedSymbol) => void): () => void {
  targets.set(fileKey, go);
  const waiting = jumps.get(fileKey);
  if (waiting) {
    jumps.delete(fileKey);
    notifyJumps();
    if (Date.now() - waiting.at < JUMP_WAIT_MS) {
      waiting.before?.();
      go(waiting.symbol);
    }
  }
  return () => {
    if (targets.get(fileKey) === go) targets.delete(fileKey);
  };
}
/** Whether the file's diff is mounted and can take a jump now. */
export const hasSymbolTarget = (fileKey: string) => targets.has(fileKey);
/** Takes the reader to `symbol` in the file: now if its diff is mounted, else as soon as it mounts. */
export function requestSymbolJump(fileKey: string, symbol: ChangedSymbol, before?: () => void) {
  const go = targets.get(fileKey);
  if (go) {
    before?.();
    go(symbol);
    return;
  }
  jumps.set(fileKey, { symbol, before, at: Date.now() });
  notifyJumps();
}
const subscribeJumps = (listener: () => void) => {
  jumpListeners.add(listener);
  return () => jumpListeners.delete(listener);
};
/** A jump waits for the file's diff: a file shown collapsed (Viewed) opens for it. */
export function usePendingSymbolJump(fileKey: string): boolean {
  return useSyncExternalStore(subscribeJumps, () => {
    const jump = jumps.get(fileKey);
    return !!jump && Date.now() - jump.at < JUMP_WAIT_MS;
  });
}
