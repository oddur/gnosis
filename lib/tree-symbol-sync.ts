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
/** When each file's place last changed, so `n` starts from whichever moved last: the reader, or the tree's row. */
const placeTimes = new Map<string, number>();
const placeListeners = new Set<() => void>();
const lines = new Map<string, string>();
const SEP = '>';

/**
 * The reader is in `chain` (outermost first) of the file, or no longer in any of its hunks (undefined). Each part is
 * `kind:name@start`: the start tells overloads apart (lib/tree-symbols.ts `readingSymbol`).
 */
export function setReadingPlace(
  fileKey: string,
  chain: readonly Pick<SyntaxDefinition, 'kind' | 'name' | 'start'>[] | undefined,
  /** The line at the reading position, `a12` or `b7`: a changed top-level line is the top level's, whatever is near. */
  line?: string
) {
  const value = chain?.map((definition) => `${definition.kind}:${definition.name}@${definition.start}`).join(SEP);
  if (line === undefined) lines.delete(fileKey);
  else lines.set(fileKey, line);
  if ((places.get(fileKey) ?? undefined) === value) return;
  if (value === undefined) places.delete(fileKey);
  else places.set(fileKey, value);
  placeTimes.set(fileKey, Date.now());
  for (const listener of placeListeners) listener();
}
/** Where the reader is in the file now, as `useReadingPlace` has it, and when that last changed (0: never). */
export function peekReadingPlace(fileKey: string): { place: string[] | undefined; at: number; line?: string } {
  const value = places.get(fileKey);
  return { place: value === undefined ? undefined : value ? value.split(SEP) : [], at: placeTimes.get(fileKey) ?? 0, line: lines.get(fileKey) };
}

/** The symbol row last chosen in the tree, or moved to with its keys, by entry key and symbol id. */
let treeCursor: { key: string; id: string; at: number } | undefined;
export function setTreeCursor(key: string, id: string) {
  treeCursor = { key, id, at: Date.now() };
}
export const peekTreeCursor = () => treeCursor;

/**
 * The review item the reader was taken to (V, n, Shift+V, a tree row), which stays the current one until the reader
 * moves on their own: their wheel, touch, pointer or a scroll key in the diff (`readerMoved`), or another target.
 * The jump's own scroll, layout settling and the reading place naming a neighbour never end it, nor does time. The
 * tree keeps its row lit meanwhile, and V ticks it (lib/tree-symbol-review.ts `currentItem`).
 */
let target: { key: string; id: string } | undefined;
const targetListeners = new Set<() => void>();
const targetChanged = () => targetListeners.forEach((listener) => listener());
export function setReviewTarget(item: { key: string; id: string } | undefined) {
  if (target?.key === item?.key && target?.id === item?.id) return;
  target = item;
  targetChanged();
}
/** The reader moved on their own: the item they were taken to is no longer the current one. */
export const readerMoved = () => setReviewTarget(undefined);
export const peekReviewTarget = () => target;
export function useReviewTarget(): { key: string; id: string } | undefined {
  return useSyncExternalStore(
    (listener) => {
      targetListeners.add(listener);
      return () => targetListeners.delete(listener);
    },
    () => target
  );
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

/**
 * The newest jump anywhere in Changes. Each diff runs its own jump, an eased scroll that aims anew each frame, and one
 * diff's jump knows nothing of another's: a quick second n or V into another file would be pulled back by the first
 * still on its way. Every jump, and every move to another file, takes a new number; a jump that is not the newest stops.
 */
let newestJump = 0;
export const beginJump = () => ++newestJump;
export const isNewestJump = (jump: number) => jump === newestJump;
