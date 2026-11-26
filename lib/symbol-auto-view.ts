/**
 * Settings › Review › "Mark a symbol viewed after you scroll through it" (Beta, off by default): a changed symbol is
 * ticked Viewed once the reader has had every one of its changed lines on screen, and has stayed on it for
 * AUTO_VIEW_DWELL_MS. Only what the reader read counts:
 * - a moment the view moved faster than FAST_SCROLL_PX_PER_MS is flying past: its lines are not seen, and its time is
 *   not dwell;
 * - dwell is time between two looks that both had the symbol on screen, so a symbol that scrolled in a moment ago has
 *   not been read for the whole gap;
 * - a gap between looks counts for at most MAX_LOOK_GAP_MS, so time the window was hidden or idle is not reading.
 * The ticks are the outline's own (lib/file-view-progress.ts); the file is never marked, and a symbol the reader
 * unticked is left alone (the caller's `eligible`).
 *
 * The diff (components/ChangesDiff.tsx) looks at the lines on screen when the reader scrolls, at most every few
 * hundred milliseconds, and while the view is still; these functions say what that adds up to.
 */

/** How long the reader stays on a symbol before it counts as read. */
export const AUTO_VIEW_DWELL_MS = 1_500;
/** Faster than this the reader is moving through the diff, not reading it: 1.5 px/ms is a screen in about half a second. */
export const FAST_SCROLL_PX_PER_MS = 1.5;
/** The most one gap between looks adds to a symbol's dwell. */
export const MAX_LOOK_GAP_MS = 500;

/** A symbol and its changed lines, as `changedSymbolLines()` names them: `a12` (new line 12), `b7` (old line 7). */
export interface AutoViewSymbol {
  id: string;
  lines: readonly string[];
}

/**
 * Each line's place in the diff as it shows, top to bottom, by `a…`/`b…` key (an unchanged line by its new number).
 * In the split diff a change's deleted and added lines sit side by side, so the n-th of each share a place.
 */
export function diffRowPositions(
  hunks: readonly { oldStart: number; newStart: number; rows: readonly { type: ' ' | '+' | '-' }[] }[],
  split: boolean
): Map<string, number> {
  const out = new Map<string, number>();
  let place = 0;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    let deleted = 0,
      added = 0;
    const endBlock = () => {
      place += Math.max(deleted, added);
      deleted = added = 0;
    };
    for (const row of hunk.rows) {
      if (row.type === ' ') {
        if (split) endBlock();
        out.set(`a${newLine}`, place++);
      } else if (row.type === '-') out.set(`b${oldLine}`, split ? place + deleted++ : place++);
      else out.set(`a${newLine}`, split ? place + added++ : place++);
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
    if (split) endBlock();
  }
  return out;
}

/** One look at the view: when, which lines were on screen, and whether the view moved fast since the last look. */
export interface Look {
  at: number;
  /** The places on screen, top and bottom, from `diffRowPositions`; undefined when none of the diff showed. */
  range?: readonly [number, number];
  fast: boolean;
}

export interface AutoViewer {
  /** Takes a look; returns the symbols now read, each once. */
  look: (look: Look) => string[];
}

export function createAutoViewer(
  symbols: readonly AutoViewSymbol[],
  positions: ReadonlyMap<string, number>,
  /** Whether a symbol may still be ticked: not Viewed already, and not unticked by the reader. */
  eligible: (id: string) => boolean,
  dwellMs = AUTO_VIEW_DWELL_MS
): AutoViewer {
  // Each symbol's lines by place; a line the diff does not show (a hidden quiet hunk) has none, and is never seen.
  const tracked = symbols
    .filter((symbol) => symbol.lines.length > 0)
    .map((symbol) => ({
      id: symbol.id,
      places: symbol.lines.map((line) => positions.get(line)),
      seen: new Set<number>(),
      dwell: 0,
      onScreen: false,
      done: false,
    }));
  let last: number | undefined;
  return {
    look: ({ at, range, fast }) => {
      const gap = last === undefined ? 0 : Math.min(Math.max(0, at - last), MAX_LOOK_GAP_MS);
      last = at;
      const ready: string[] = [];
      for (const symbol of tracked) {
        if (symbol.done) continue;
        let showing = false;
        if (range && !fast)
          for (let index = 0; index < symbol.places.length; index++) {
            const place = symbol.places[index];
            if (place === undefined || place < range[0] || place > range[1]) continue;
            showing = true;
            symbol.seen.add(index);
          }
        // Time counts only between two slow looks that both had the symbol on screen.
        if (showing && symbol.onScreen) symbol.dwell += gap;
        symbol.onScreen = showing;
        if (symbol.seen.size === symbol.places.length && symbol.dwell >= dwellMs && eligible(symbol.id)) {
          symbol.done = true;
          ready.push(symbol.id);
        }
      }
      return ready;
    },
  };
}
