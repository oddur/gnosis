import { TOP_LEVEL_ID } from './symbol-outline';
import type { FileSymbols } from './tree-symbol-paths';
import type { TopLevelChanges, TreeSymbolNode } from './tree-symbols';

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
const changedNode = (node: TreeSymbolNode) => !!node.symbol && !node.quiet;
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
  /** A file on the way whose symbols are not known yet: read and parse it, then ask again. */
  | { kind: 'load'; key: string }
  /** No unviewed symbol that way. */
  | { kind: 'end' };

/**
 * The next (`1`) or previous (`-1`) unviewed symbol from `from`, in the tree's order: the files in their order, each
 * file's symbols as its rows show them. Viewed files are skipped whole, and files without symbols are passed. A file
 * on the way whose symbols are still unknown stops the walk (`load`): the next symbol may be in it, so it is read
 * rather than guessed past. Nothing wraps around: the end says so.
 */
export function stepUnviewed(
  files: readonly ReviewFile[],
  from: ReviewPlace,
  direction: 1 | -1,
  isViewed: (key: string, id: string) => boolean
): ReviewStep {
  const start = files.findIndex((file) => file.key === from.key);
  const pick = (file: ReviewFile, after: number | undefined): ReviewStep | undefined => {
    if (file.viewed || !file.symbols || file.symbols.state === 'none') return undefined;
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
