import { prepareFileTreeInput } from '@pierre/trees';

/** Orders items as ChangesFileTree shows them, so the diff stream follows the tree top to bottom. */
export function inTreeOrder<T>(items: readonly T[], path: (item: T) => string): T[] {
  const rank = new Map(prepareFileTreeInput(items.map(path)).paths.map((value, index) => [value, index]));
  return [...items].sort((a, b) => (rank.get(path(a)) ?? 0) - (rank.get(path(b)) ?? 0));
}
