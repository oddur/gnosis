import { useEffect, useSyncExternalStore } from 'react';
import { fresherPrCopy, type PrStateSource } from './pr-state';

type Copy = Pick<PrStateSource, 'state' | 'merged' | 'isDraft' | 'updatedAt'>;

/**
 * The freshest PR state the window has shown, by URL. Every state icon reports its copy and reads the freshest one,
 * so a tab, breadcrumb or recent entry holding an older copy follows a merge shown in the header or queue.
 */
const copies = new Map<string, Copy>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function notePrCopy(url: string, copy: Copy) {
  const known = copies.get(url);
  // On a tie the copy reported last wins, so an optimistic draft change shown by a live copy reaches older ones.
  const next = fresherPrCopy<Copy>(copy, known);
  if (!next || (known && next === known)) return;
  if (known && known.state === next.state && known.merged === next.merged && known.isDraft === next.isDraft && known.updatedAt === next.updatedAt) return;
  copies.set(url, { state: next.state, merged: next.merged, isDraft: next.isDraft, updatedAt: next.updatedAt });
  for (const listener of listeners) listener();
}

/** The copy to show: this one, or a fresher copy of the same PR seen elsewhere in the window. */
export function useFreshPrCopy(pr: PrStateSource | null | undefined): PrStateSource | null | undefined {
  const url = pr?.url;
  const known = useSyncExternalStore(subscribe, () => (url ? copies.get(url) : undefined), () => undefined);
  const { state, merged, isDraft, updatedAt } = pr ?? {};
  useEffect(() => {
    if (url && state) notePrCopy(url, { state, merged, isDraft, updatedAt });
  }, [url, state, merged, isDraft, updatedAt]);
  return fresherPrCopy(pr, known);
}

/** The freshest copy noted for a PR. */
export const knownPrCopy = (url: string) => copies.get(url);
/** Test seam. */
export const resetPrCopies = () => copies.clear();
