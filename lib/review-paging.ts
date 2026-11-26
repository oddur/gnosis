import { useSyncExternalStore } from 'react';

/**
 * Long symbols: V pages through before it ticks. When the item V is on has changed lines that have not all been on
 * screen since it became current, V scrolls the diff on by about a screen instead of ticking it; once every one has
 * been seen, the next V ticks it and goes on, as for any item. Most items fit on one screen and tick at once.
 *
 * The diff (components/ChangesDiff.tsx) is the pager: it says which of its lines are on screen, by place
 * (lib/symbol-auto-view.ts `diffRowPositions`), as the scrolled-through ticks find them, and scrolls by a page. Its
 * scrolls are the program's, so the item stays the reader's target while V pages through it.
 */

/** Lines a page keeps from the one before, so the reader does not lose their place. */
export const PAGE_OVERLAP_LINES = 2;

/** The lines on screen, as places, first and last; undefined when none of the diff shows. */
export type ScreenRange = readonly [number, number] | undefined;

/** Adds the item's lines on screen to `seen`. */
export function markSeen(seen: Set<string>, lines: readonly string[], place: (line: string) => number | undefined, range: ScreenRange) {
  if (!range) return;
  for (const line of lines) {
    const at = place(line);
    if (at !== undefined && at >= range[0] && at <= range[1]) seen.add(line);
  }
}

/**
 * What V does on an item: tick it, once every changed line has been seen (or a line the diff does not show at all,
 * such as a hidden quiet hunk, which no scroll could show; or nothing is left to scroll to, at the stream's end); else
 * page down to the lines not seen yet, or back up to them when the reader scrolled past some.
 */
export type PageStep = { kind: 'tick' } | { kind: 'down' } | { kind: 'to'; place: number };
export function pageStep({
  lines,
  place,
  seen,
  range,
  atEnd,
}: {
  lines: readonly string[];
  place: (line: string) => number | undefined;
  seen: ReadonlySet<string>;
  range: ScreenRange;
  atEnd: boolean;
}): PageStep {
  const unseen = lines.flatMap((line) => {
    const at = place(line);
    return at !== undefined && !seen.has(line) ? [at] : [];
  });
  if (!unseen.length) return { kind: 'tick' };
  const next = Math.min(...unseen);
  // Above the view: the reader scrolled past it. Back to it, whatever the end of the stream says.
  if (range && next < range[0]) return { kind: 'to', place: next };
  // Nothing more to scroll to: what is left is on screen or cannot be, so V never gets stuck.
  if (atEnd) return { kind: 'tick' };
  return { kind: 'down' };
}

/** How much of the item has been seen, for its row's "Reading 40%". */
export const seenShare = (lines: readonly string[], seen: ReadonlySet<string>) =>
  lines.length ? Math.round((100 * lines.filter((line) => seen.has(line)).length) / lines.length) : 100;

/** A diff that can show what of an item is on screen and page through it. */
export interface Pager {
  /** The item's changed lines (`a12`, `b7`), by id. */
  lines: (id: string) => readonly string[] | undefined;
  /** A line's place in the diff as it shows; undefined for a line it does not show. */
  place: (line: string) => number | undefined;
  /** The places on screen now. */
  range: () => ScreenRange;
  /** Scrolls down by a page; false when the stream is at its end already. */
  page: () => boolean;
  /** Scrolls a place to the top of the view. */
  goToPlace: (place: number) => void;
}
const pagers = new Map<string, Pager>();
/** A file's diff, by its revision key, while it is mounted. */
export function registerPager(fileKey: string, pager: Pager): () => void {
  pagers.set(fileKey, pager);
  return () => {
    if (pagers.get(fileKey) === pager) pagers.delete(fileKey);
  };
}
export const pagerOf = (fileKey: string) => pagers.get(fileKey);

/** The item V is paging through, and how much of it has been seen: its tree row and outline chip say so. */
export interface Paging {
  key: string;
  fileKey: string;
  id: string;
  share: number;
}
let paging: Paging | undefined;
const listeners = new Set<() => void>();
export function setPaging(next: Paging | undefined) {
  if (paging?.key === next?.key && paging?.id === next?.id && paging?.share === next?.share) return;
  paging = next;
  listeners.forEach((listener) => listener());
}
export const peekPaging = () => paging;
export function usePaging(): Paging | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => paging
  );
}

/**
 * What a paged item's row says: "Reading 40%" while some of it is unseen; "Read" once all of it has been on screen,
 * which says what the next V does, in the info ink (`full`). One short word fits the narrow tree at 12 px.
 */
export function readingLabel(share: number): { text: string; full: boolean; title: string } {
  return share >= 100
    ? { text: 'Read', full: true, title: 'Seen in full · press V to mark it viewed' }
    : { text: `Reading ${share}%`, full: false, title: "Press V to continue reading; it's marked once you've seen all of it" };
}
