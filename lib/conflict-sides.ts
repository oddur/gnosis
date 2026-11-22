/**
 * The two sides of an open conflict in the Conflicts view's diff (#445 distill). The diff shows the draft against one
 * version, so an open conflict's lines arrive as a deletion (the compared version's side) and an addition (the other
 * side). Neither is being deleted or added: nothing is chosen yet. So each side wears its own neutral tint instead of the
 * review diff's red and green, the same for the PR's side in every mode and in a restack, and the first line of each
 * side names it ("PR", "main"). Only these rows change: Changes, Explanation and every chosen conflict keep the
 * review diff's colours.
 *
 * The rows live in Pierre's shadow roots: the CSS goes in through the diff's `unsafeCSS`, and ConflictFileDiff marks the
 * rows after each render (`markSides`), as ChangesDiff marks written lines (lib/diff-here.ts).
 */
import type { GapHunk } from './diff-gaps';
import { gutterOf } from './diff-here';

/** The PR's side, or the side it merges with: main, or a restack's updated parent. */
export type SideTone = 'pr' | 'base';
/** An open conflict's shown lines (new side, `start`..`end`), and which side they and the lines they replace are. */
export interface SideRange {
  start: number;
  end: number;
  added: SideTone;
  removed: SideTone;
}
/** Side tints by line: new-side lines in `added`, old-side lines in `removed`. */
export interface SideRows {
  added: ReadonlyMap<number, SideTone>;
  removed: ReadonlyMap<number, SideTone>;
}

/**
 * Each open conflict's rows in the diff's hunks: its shown lines that the diff adds, and the compared version's lines it
 * removes beside them. Lines both sides share stay plain context.
 */
export function conflictSideRows(hunks: readonly GapHunk[], ranges: readonly SideRange[]): SideRows {
  const added = new Map<number, SideTone>();
  const removed = new Map<number, SideTone>();
  for (const range of ranges) {
    const last = Math.max(range.end, range.start);
    for (const hunk of hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      let adding = false;
      for (const row of hunk.rows) {
        if (row.type === '+') {
          if (newLine >= range.start && newLine <= range.end) {
            added.set(newLine, range.added);
            adding = true;
          }
          newLine++;
        } else if (row.type === '-') {
          // Removed lines sit at the conflict's place: before its first line, among its lines, or right after them.
          if ((newLine >= range.start && newLine <= last) || (adding && newLine === range.end + 1))
            removed.set(oldLine, range.removed);
          oldLine++;
        } else {
          adding = false;
          oldLine++;
          newLine++;
        }
      }
    }
  }
  return { added, removed };
}

/**
 * Neutral tints, cool for the PR and warm for the side it merges with, on the code surface (a dark theme in both app
 * themes). They replace the change colours through Pierre's own properties, so the row, its gutter and its changed words
 * follow; the −/+ glyph goes, and the first row of a side carries its name.
 */
export const SIDE_COLORS: Record<SideTone, string> = { pr: '#9fb1d4', base: '#d2bb8c' };
export const SIDES_CSS = `
[data-conflict-side=pr] { --conflict-side: ${SIDE_COLORS.pr}; }
[data-conflict-side=base] { --conflict-side: ${SIDE_COLORS.base}; }
[data-conflict-side] {
  --diffs-deletion-base: var(--conflict-side); --diffs-addition-base: var(--conflict-side);
  --diffs-bg-deletion-emphasis: rgb(from var(--conflict-side) r g b / 24%); --diffs-bg-addition-emphasis: rgb(from var(--conflict-side) r g b / 24%);
}
[data-line][data-conflict-side]::before { content: '' !important; }
[data-line][data-conflict-label] { position: relative; }
[data-line][data-conflict-label]::after {
  content: attr(data-conflict-label); position: absolute; top: 0; right: 8px; z-index: 1; padding: 0 6px; border-radius: 3px;
  background: var(--conflict-side); color: var(--diffs-bg, #0d1117); font: 600 11px/1.6 var(--font-sans, system-ui); pointer-events: none;
}`;

/**
 * Marks the rows of a rendered diff (`host`, a Pierre container) with their side, with their gutter cells, and names
 * the first row of each side's run. Attributes change only where they differ, so a pass over a marked diff writes
 * nothing; a diff with nothing to mark and nothing marked costs one query.
 */
export function markSides(host: Element, rows: SideRows | undefined, labels: Record<SideTone, string>) {
  const root = host.shadowRoot;
  if (!root) return;
  if (!rows?.added.size && !rows?.removed.size && !root.querySelector('[data-conflict-side]')) return;
  const set = (element: Element | undefined, attribute: string, value: string | undefined) => {
    if (!element || element.getAttribute(attribute) === (value ?? null)) return;
    if (value === undefined) element.removeAttribute(attribute);
    else element.setAttribute(attribute, value);
  };
  let previous: { column: Element | null; tone: SideTone | undefined; row: Element } | undefined;
  for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
    const type = row.dataset.lineType;
    const line = Number(row.dataset.line);
    const tone =
      type === 'change-addition' ? rows?.added.get(line) : type === 'change-deletion' ? rows?.removed.get(line) : undefined;
    const column = row.closest('[data-deletions], [data-additions]');
    // A run continues in the same column, row after row.
    const continues =
      !!previous && previous.column === column && previous.tone === tone && previous.row.nextElementSibling === row;
    set(row, 'data-conflict-side', tone);
    set(gutterOf(row), 'data-conflict-side', tone);
    set(row, 'data-conflict-label', tone && !continues ? labels[tone] : undefined);
    previous = { column, tone, row };
  }
}
