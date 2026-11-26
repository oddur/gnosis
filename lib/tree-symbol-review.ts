import { TOP_LEVEL_ID } from './symbol-outline';
import type { FileSymbols } from './tree-symbol-paths';
import { movedMirrorId, type TopLevelChanges, type TreeSymbolNode } from './tree-symbols';

/**
 * The Changes tree as a review list (Settings › Review, Beta): how many of each file's changed symbols are Viewed, the
 * same for a folder, and which unviewed symbol `n` and Shift+N go to.
 *
 * A symbol counts as the outline counts it (components/DiffOutline.tsx): a changed symbol with a change that shows.
 * Context rows (an unchanged class around a changed method) and symbols whose every change is quiet are not counted, so
 * the tree's `2/5` and the outline's "2/5 viewed" agree, and "every symbol viewed" means the same in both. A file's
 * top-level changes (its Imports or Top level row) count as one more symbol, under TOP_LEVEL_ID, first in the file,
 * unless every one of them is quiet.
 */

/** A changed symbol with a change that shows. */
const changedNode = (node: TreeSymbolNode) => !!node.symbol && !node.quiet && !node.moveAway;
const changedBelow = (node: TreeSymbolNode): boolean => node.children.some((child) => changedNode(child) || changedBelow(child));
/**
 * A review item: a changed leaf with a change that shows, the file's top level, or a container's Body (its own changed
 * lines, lib/tree-symbols.ts). A container (a class, a namespace, with changed symbols under it) is never one: it reads
 * as viewed once everything under it is (`rolledUp`), as a file does.
 */
export const reviewed = (node: TreeSymbolNode) => changedNode(node) && !changedBelow(node);

/** The review items in a row's subtree, itself included: what V on the row ticks, and what its ✓ rolls up from. */
export function reviewIds(node: TreeSymbolNode): string[] {
  return treeOrder([node])
    .filter(reviewed)
    .map((item) => item.id);
}

/**
 * Whether a row reads as viewed: every review item under it, itself included, is ticked (or the file is Viewed).
 * Derived, never stored, for a container, so it cannot disagree with what is under it, its Body included. Undefined
 * for a row with no review items (a quiet symbol).
 */
export function rolledUp(node: TreeSymbolNode, isViewed: (id: string) => boolean, fileViewed = false): boolean | undefined {
  const ids = reviewIds(node);
  if (!ids.length) return undefined;
  return fileViewed || ids.every(isViewed);
}


/** A file's symbols in the tree's order, context rows included: depth first, as the rows show. */
export function treeOrder(nodes: readonly TreeSymbolNode[]): TreeSymbolNode[] {
  const out: TreeSymbolNode[] = [];
  const walk = (node: TreeSymbolNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export interface SymbolProgress {
  viewed: number;
  total: number;
}

/** One stop of the review in a file: its top-level changes, or a symbol row. */
export interface ReviewStop {
  id: string;
  /** Counted and walked to; a context row or a quiet symbol only marks a place. */
  counted: boolean;
  node?: TreeSymbolNode;
  top?: TopLevelChanges;
}
/** A file's stops in the tree's order: its top-level changes first, then its symbols. */
export function reviewStops(nodes: readonly TreeSymbolNode[], top?: TopLevelChanges): ReviewStop[] {
  return [
    ...(top ? [{ id: TOP_LEVEL_ID, counted: !top.quiet, top }] : []),
    ...treeOrder(nodes).map((node) => ({ id: node.id, counted: reviewed(node), node })),
  ];
}

/** How many of a file's counted symbols are Viewed. A Viewed file has every one viewed, as its outline shows. */
export function symbolProgress(
  nodes: readonly TreeSymbolNode[],
  isViewed: (id: string) => boolean,
  fileViewed = false,
  top?: TopLevelChanges
): SymbolProgress {
  let viewed = 0,
    total = 0;
  for (const stop of reviewStops(nodes, top)) {
    if (!stop.counted) continue;
    total++;
    if (fileViewed || isViewed(stop.id)) viewed++;
  }
  return { viewed, total };
}

/**
 * Each folder's sum of its files' progress, by folder path with a trailing slash (`src/`, `src/lib/`): only files
 * whose symbols are known are in `files`, so a folder sums what is known so far.
 */
export function folderProgress(files: ReadonlyMap<string, SymbolProgress>): Map<string, SymbolProgress> {
  const out = new Map<string, SymbolProgress>();
  for (const [key, progress] of files) {
    if (!progress.total) continue;
    for (let at = key.indexOf('/'); at >= 0; at = key.indexOf('/', at + 1)) {
      const folder = key.slice(0, at + 1);
      const sum = out.get(folder) ?? { viewed: 0, total: 0 };
      sum.viewed += progress.viewed;
      sum.total += progress.total;
      out.set(folder, sum);
    }
  }
  return out;
}

/**
 * What a row's decoration shows of its progress. The tree is narrow, so a row keeps one short reading:
 * - nothing viewed yet: no progress, and the row keeps its `+N −M` (or its quiet word), so rows do not all change as
 *   files are parsed in the background, and the size of each change stays in sight until the reader starts on it;
 * - some viewed: `2/5` in place of the counts, which stay in the tooltip;
 * - every symbol viewed but not the file: a muted check, `✓ 5/5`, which offers what the outline offers, marking the
 *   file Viewed, and never does it by itself.
 * A Viewed file reads "Viewed" as it always did; that is the caller's.
 */
export type ProgressLabel = { kind: 'none' } | { kind: 'some'; text: string } | { kind: 'all'; text: string };
export function progressLabel(progress: SymbolProgress | undefined): ProgressLabel {
  if (!progress?.total || !progress.viewed) return { kind: 'none' };
  const text = `${progress.viewed}/${progress.total}`;
  return progress.viewed >= progress.total ? { kind: 'all', text: `✓ ${text}` } : { kind: 'some', text };
}

/**
 * A file or folder row's reading, with items that changed since the reader viewed them (lib/symbol-carry.ts) first:
 * "2 changed" until none are left, then its progress as `progressLabel` reads it (or its counts, `none`).
 */
export type RowLabel = ProgressLabel | { kind: 'changed'; text: string };
export function rowLabel(progress: SymbolProgress | undefined, changed = 0): RowLabel {
  return changed > 0 ? { kind: 'changed', text: `${changed} changed` } : progressLabel(progress);
}
/** Each folder's sum of a count of its files (changed items, say), by folder path with a trailing slash. */
export function folderSums(files: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, count] of files) {
    if (!count) continue;
    for (let at = key.indexOf('/'); at >= 0; at = key.indexOf('/', at + 1)) out.set(key.slice(0, at + 1), (out.get(key.slice(0, at + 1)) ?? 0) + count);
  }
  return out;
}

/** A file of the review list, in the tree's order. */
export interface ReviewFile {
  key: string;
  viewed: boolean;
  /** What is known of its symbols; undefined for a file that lists none (a language without tags, an image). */
  symbols?: FileSymbols;
}
/** Where the reader is: a file, and the symbol row they are at in it (none: the file's top). */
export interface ReviewPlace {
  key: string;
  id?: string;
}
export type ReviewStep =
  /** The next unviewed symbol: a symbol row's `node`, or the file's `top`-level changes. */
  | { kind: 'go'; key: string; id: string; node?: TreeSymbolNode; top?: TopLevelChanges }
  /** A file without symbols (JSON, an image, a language without tags, a file too large or unreadable): one stop. */
  | { kind: 'file'; key: string }
  /** A file on the way whose symbols are not known yet: read and parse it, then ask again. */
  | { kind: 'load'; key: string }
  /** No unviewed symbol that way. */
  | { kind: 'end' };

/**
 * The next (`1`) or previous (`-1`) unviewed symbol from `from`, in the tree's order: the files in their order, each
 * file's symbols as its rows show them. Viewed files are skipped whole, and a file without symbols is one stop of its
 * own (`file`), which the walk passes once the reader is on it. A file on the way whose symbols are still unknown stops
 * the walk (`load`): the next symbol may be in it, so it is read rather than guessed past. Nothing wraps around: the
 * end says so.
 */
export function stepUnviewed(
  files: readonly ReviewFile[],
  from: ReviewPlace,
  direction: 1 | -1,
  isViewed: (key: string, id: string) => boolean
): ReviewStep {
  const start = files.findIndex((file) => file.key === from.key);
  const pick = (file: ReviewFile, after: number | undefined): ReviewStep | undefined => {
    if (file.viewed) return undefined;
    // A file without symbols: a stop when the walk comes to it from another file, passed from the file itself.
    if (!file.symbols || file.symbols.state === 'none') return after === undefined ? { kind: 'file', key: file.key } : undefined;
    if (file.symbols.state === 'loading') return { kind: 'load', key: file.key };
    const order = reviewStops(file.symbols.nodes, file.symbols.top);
    // From a row in this file: the rows past it. From the file's top: every row forward, none back.
    const first = after === undefined ? (direction === 1 ? 0 : order.length - 1) : after + direction;
    for (let i = first; i >= 0 && i < order.length; i += direction) {
      const { id, counted, node, top } = order[i];
      if (counted && !isViewed(file.key, id)) return { kind: 'go', key: file.key, id, node, top };
    }
    return undefined;
  };
  if (start >= 0) {
    const file = files[start];
    let at: number | undefined;
    if (from.id !== undefined && file.symbols?.state === 'ready') {
      const index = reviewStops(file.symbols.nodes, file.symbols.top).findIndex((stop) => stop.id === from.id);
      if (index >= 0) at = index;
    }
    // At the file's top, nothing in it comes before the reader.
    const here = at === undefined && direction === -1 ? undefined : pick(file, at ?? -1);
    if (here) return here;
  }
  const begin = start >= 0 ? start + direction : direction === 1 ? 0 : files.length - 1;
  for (let i = begin; i >= 0 && i < files.length; i += direction) {
    const step = pick(files[i], undefined);
    if (step) return step;
  }
  return { kind: 'end' };
}

/**
 * The ids a file's review counts, as its progress counts them: the changed symbols and `@top`, quiet-only ones left
 * out. Undefined while they are not known (loading, or failed to load): a file is then never marked by its ticks.
 */
export function countedIds(symbols: FileSymbols | undefined): string[] | undefined {
  if (symbols?.state !== 'ready') return undefined;
  return reviewStops(symbols.nodes, symbols.top)
    .filter((stop) => stop.counted)
    .map((stop) => stop.id);
}

/**
 * What a tick or untick does to its file, in symbol mode: ticking the last counted item marks the file Viewed, and
 * unticking any of a Viewed file's symbols makes it unviewed again. `ticks` are the ids to set to `viewed`; `others`
 * are the counted ids to tick first, so that unticking one symbol of a file marked Viewed as a whole keeps the rest
 * ticked, as the file showed them. Nothing happens to the file without its counted ids (`counted` undefined).
 */
export function fileAfterTick({
  counted,
  ids,
  viewed,
  fileViewed,
  isViewed,
}: {
  counted: readonly string[] | undefined;
  ids: readonly string[];
  viewed: boolean;
  fileViewed: boolean;
  isViewed: (id: string) => boolean;
}): { file?: 'mark' | 'unmark'; others: string[] } {
  if (!counted?.length) return { others: [] };
  if (!viewed) {
    if (!fileViewed) return { others: [] };
    return { file: 'unmark', others: counted.filter((id) => !ids.includes(id) && !isViewed(id)) };
  }
  if (fileViewed) return { others: [] };
  const done = counted.every((id) => ids.includes(id) || isViewed(id));
  return done ? { file: 'mark', others: [] } : { others: [] };
}

/** The id a file without symbols is known by as a stop of the walk: `@` never starts a real `kind:name` part. */
export const FILE_STOP = '@file';

/**
 * How many stops of the walk are left: in each unviewed file, its counted items not ticked, or one for a file without
 * symbols. A file whose symbols are still loading counts as one: something is left in it, how much is not known yet.
 */
export function itemsLeft(files: readonly ReviewFile[], isViewed: (key: string, id: string) => boolean): number {
  let left = 0;
  for (const file of files) {
    if (file.viewed) continue;
    const ids = countedIds(file.symbols);
    if (ids) left += ids.filter((id) => !isViewed(file.key, id)).length;
    else left += 1;
  }
  return left;
}

/** A review item the reader is on: a symbol, Body or top level by its id, or a file without symbols (FILE_STOP). */
export interface ReviewItem {
  key: string;
  id: string;
}
/**
 * The item `V` ticks: the one the reader was taken to (by V, n, Shift+V or a tree row), until they move on their own
 * (`moved`: a wheel, a touch, the pointer or a scroll key in the diff); else the focused tree row, when it is a review
 * item or a file; else the review item under the reading position. Else none: `V` then ticks nothing, and only goes to
 * the next unviewed item. Never an item the reader was not taken to and is not on. Where the reading place says the
 * reader is does not matter while a target holds: a jump to a top-level line between two functions lands with one of
 * them named by the pinned crumb, which is not what the reader was taken to.
 */
export function currentItem({
  target,
  moved = false,
  focused,
  reading,
  paging,
}: {
  target?: ReviewItem;
  moved?: boolean;
  focused?: ReviewItem;
  reading?: ReviewItem;
  /**
   * A long item V was paging through (lib/review-paging.ts): after the reader's own scroll, it stays current while
   * some of its changed lines are on screen and not all have been seen, over a neighbour that merely peeks in.
   */
  paging?: { item: ReviewItem; onScreen: boolean; done: boolean };
}): ReviewItem | undefined {
  if (target && !moved) return target;
  if (paging && paging.onScreen && !paging.done) return paging.item;
  return focused ?? reading;
}

/**
 * The review item under the reading position, from the symbol row the place names (`readingSymbol`): a leaf is
 * itself; a container is its Body when it has one (the reader is in its own lines), else none; the file's own lines
 * are its top level when it has one.
 */
export function readingItem(
  nodes: readonly TreeSymbolNode[],
  top: TopLevelChanges | undefined,
  id: string | undefined,
  outside: boolean,
  /** The line at the reading position (`a12`, `b7`): a changed top-level line is the top level's, whatever is named. */
  line?: string
): string | undefined {
  if (top && line && top.lines.includes(line)) return TOP_LEVEL_ID;
  if (outside) return top ? TOP_LEVEL_ID : undefined;
  if (id === undefined) return undefined;
  const node = treeOrder(nodes).find((item) => item.id === id);
  if (!node) return undefined;
  if (reviewed(node)) return node.id;
  const body = node.children.find((child) => child.id === `${node.id}>@body`);
  return body && reviewed(body) ? body.id : undefined;
}

/** What one `V` did, for `Shift+V` to take back: the item it ticked, and whether that marked its file Viewed. */
export interface ReviewTick extends ReviewItem {
  /** The tick marked the file Viewed (its last item, or a file without symbols). */
  markedFile: boolean;
  /** The ids it ticked: one item, or everything under a container `v` ticked from the tree. */
  ids: string[];
}
/** The session's `V`s, newest last. `Shift+V` takes the newest back; Reset viewed and leaving Changes clear it. */
export function createTickStack() {
  let ticks: ReviewTick[] = [];
  return {
    push: (tick: ReviewTick) => {
      ticks = [...ticks, tick];
    },
    pop: (): ReviewTick | undefined => {
      const last = ticks.at(-1);
      ticks = ticks.slice(0, -1);
      return last;
    },
    clear: () => {
      ticks = [];
    },
    get size() {
      return ticks.length;
    },
  };
}

/**
 * What V and the Viewed menu tick for a tree row: a symbol row's review items (a leaf or Body itself, everything under
 * a container), or exactly the file's top level for its Imports or Top level row.
 */
export function rowReviewIds(row: { type: 'symbol'; node: TreeSymbolNode } | { type: 'top' } | { type: string }): string[] {
  if (row.type === 'top') return [TOP_LEVEL_ID];
  return row.type === 'symbol' && 'node' in row ? reviewIds(row.node) : [];
}

/**
 * Moves across the file's items (lib/tree-symbols.ts `movedMirrorId`): each new copy's id with the old copy's file and
 * mirror id, which its tick also ticks; and the mirror ids of this file's old copies, which its Viewed follows too.
 */
export function moveMirrors(nodes: readonly TreeSymbolNode[]): { into: Record<string, { file: string; id: string }>; away: string[] } {
  const into: Record<string, { file: string; id: string }> = {};
  const away: string[] = [];
  for (const node of treeOrder(nodes)) {
    if (node.moveInto && reviewed(node)) into[node.id] = { file: node.moveInto.other.file, id: movedMirrorId(node.moveInto.other.start) };
    if (node.moveAway) away.push(movedMirrorId(node.definition.start));
  }
  return { into, away };
}
