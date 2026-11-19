import type { FileDiffMetadata } from '@pierre/diffs';
import { CODE_LINE_HEIGHT, HUNK_SLICE_LIMIT, HUNK_SLICE_SIZE } from './review-diff';

/**
 * Context gaps between the hunks of a patch, revealed from the after side only (#299).
 *
 * The gap model is ported, with permission, from quarterdeck by Rainer (https://github.com/plucked/quarterdeck):
 * `crates/diff/src/hunk_context.rs`, `context_gap.rs`, `revealed_lines.rs` and `source_lines.rs`, and
 * `crates/app/src/diff_view/gap_part.rs`.
 *
 * Unchanged lines are the same on both sides, so a gap needs only the after text: its old line numbers are its new
 * ones plus a fixed offset. The patch already says where each gap starts and ends on both sides; the after text
 * only fills it in, and must agree with every line the patch shows on the new side.
 */

export interface DiffRow {
  type: ' ' | '+' | '-';
  /** The line without its line feed. A carriage return stays. */
  text: string;
}
export interface GapHunk {
  /** First old line number, as if the old side had a line here. */
  oldStart: number;
  /** First new line number, as if the new side had a line here. */
  newStart: number;
  rows: DiffRow[];
  /** The side's last line has no line feed (`\ No newline at end of file`). */
  noEofOld: boolean;
  noEofNew: boolean;
}
export interface DiffGap {
  /** The gap lies before hunk `index`; `index === hunks.length` is the gap after the last hunk. */
  index: number;
  /** First hidden new line. */
  newStart: number;
  /** Last hidden new line, inclusive. Unknown below the last hunk until the after text arrives. */
  newEnd?: number;
  /** Old line = new line + oldOffset, anywhere in the gap. */
  oldOffset: number;
}
/** Lines revealed in one gap: `down` continues the hunk above, `up` the hunk below. */
export interface GapReveal {
  down: number;
  up: number;
}
export type GapReveals = Readonly<Record<number, GapReveal>>;
export type GapDirection = 'up' | 'down' | 'all';
/** One click reveals this many lines, or the rest of the gap. */
export const GAP_STEP = 20;

const oldCount = (hunk: Pick<GapHunk, 'rows'>) => hunk.rows.reduce((n, row) => n + (row.type === '+' ? 0 : 1), 0);
const newCount = (hunk: Pick<GapHunk, 'rows'>) => hunk.rows.reduce((n, row) => n + (row.type === '-' ? 0 : 1), 0);
const oldEnd = (hunk: GapHunk) => hunk.oldStart + oldCount(hunk) - 1;
const newEnd = (hunk: GapHunk) => hunk.newStart + newCount(hunk) - 1;
const stripFeed = (line: string | undefined) => (line ?? '').replace(/\n$/, '');

/** What a hunk changes: lines added, lines deleted, or both. Undefined for context alone. */
export type HunkChange = 'added' | 'deleted' | 'modified';
export function hunkChange(hunk: Pick<GapHunk, 'rows'>): HunkChange | undefined {
  const added = hunk.rows.some((row) => row.type === '+');
  const deleted = hunk.rows.some((row) => row.type === '-');
  return added && deleted ? 'modified' : added ? 'added' : deleted ? 'deleted' : undefined;
}

export interface HunkRange {
  /** As the hunk header shows it: `L120–148`, or `old L9–11` for a hunk that only deletes. */
  label: string;
  /** In words, for the tooltip and screen readers: "Lines 120 to 148", "Old lines 9 to 11". */
  spoken: string;
}
/**
 * Where a hunk is, by its new lines, or by its old lines when it only deletes: its deleted lines have no new numbers.
 * Every hunk header shows it (#395).
 */
export function hunkRange(hunk: Pick<GapHunk, 'oldStart' | 'newStart' | 'rows'>): HunkRange {
  const old = !hunk.rows.some((row) => row.type === '+') && hunk.rows.some((row) => row.type === '-');
  const start = old ? hunk.oldStart : hunk.newStart;
  const count = old ? oldCount(hunk) : newCount(hunk);
  const end = start + Math.max(count, 1) - 1;
  const prefix = old ? 'old L' : 'L';
  const words = old ? 'Old line' : 'Line';
  if (end <= start) return { label: `${prefix}${start}`, spoken: `${words} ${start}` };
  return { label: `${prefix}${start}–${end}`, spoken: `${words}s ${start} to ${end}` };
}

/** The hunks of a parsed diff as rows. Works for a patch preview and for a diff of two whole files. */
export function hunksFromDiff(diff: FileDiffMetadata): GapHunk[] {
  return diff.hunks.map((hunk) => {
    const rows: DiffRow[] = [];
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines; i++)
          rows.push({ type: ' ', text: stripFeed(diff.additionLines[content.additionLineIndex + i]) });
        continue;
      }
      for (let i = 0; i < content.deletions; i++)
        rows.push({ type: '-', text: stripFeed(diff.deletionLines[content.deletionLineIndex + i]) });
      for (let i = 0; i < content.additions; i++)
        rows.push({ type: '+', text: stripFeed(diff.additionLines[content.additionLineIndex + i]) });
    }
    // A side with no lines in the hunk names the line before it, as in `@@ -5,0 +6,2 @@`.
    return {
      oldStart: hunk.deletionCount === 0 ? hunk.deletionStart + 1 : hunk.deletionStart,
      newStart: hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart,
      rows,
      noEofOld: hunk.noEOFCRDeletions,
      noEofNew: hunk.noEOFCRAdditions,
    };
  });
}

/** The after text as lines, without line feeds. A final line feed ends the last line; it does not start another. */
export function afterLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * The gaps before, between and after the hunks. Each gap must hide as many old lines as new ones; a patch that says
 * otherwise has no gaps to reveal, and this returns undefined.
 */
export function diffGaps(hunks: GapHunk[], afterLineCount?: number): DiffGap[] | undefined {
  if (!hunks.length) return undefined;
  const gaps: DiffGap[] = [];
  let previousOld = 0,
    previousNew = 0;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const oldSize = hunk.oldStart - 1 - previousOld,
      newSize = hunk.newStart - 1 - previousNew;
    if (oldSize !== newSize || newSize < 0) return undefined;
    gaps.push({ index, newStart: previousNew + 1, newEnd: hunk.newStart - 1, oldOffset: previousOld - previousNew });
    previousOld = oldEnd(hunk);
    previousNew = newEnd(hunk);
  }
  const last = hunks[hunks.length - 1];
  const end = afterLineCount ?? (last.noEofNew ? previousNew : undefined);
  if (end !== undefined && end < previousNew) return undefined;
  gaps.push({ index: hunks.length, newStart: previousNew + 1, newEnd: end, oldOffset: previousOld - previousNew });
  return gaps;
}

export const gapSize = (gap: DiffGap) => (gap.newEnd === undefined ? undefined : gap.newEnd - gap.newStart + 1);

/** Whether `lines` can be the after side of `hunks`: every line the patch shows on the new side is that line. */
export function matchesAfter(hunks: GapHunk[], lines: string[]): boolean {
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const row of hunk.rows) {
      if (row.type === '-') continue;
      if (lines[line - 1] !== row.text) return false;
      line++;
    }
  }
  const last = hunks.at(-1);
  return !last || !last.noEofNew || newEnd(last) === lines.length;
}

/** Reveal `GAP_STEP` lines on one side of a gap, or all of it. The edges of the file reveal towards their hunk. */
export function revealGap(reveals: GapReveals, gap: DiffGap, hunkCount: number, direction: GapDirection, step = GAP_STEP): GapReveals {
  const current = reveals[gap.index] ?? { down: 0, up: 0 };
  const towards: GapDirection = gap.index === 0 && direction !== 'all' ? 'up' : gap.index === hunkCount && direction !== 'all' ? 'down' : direction;
  const next =
    towards === 'all'
      ? { down: Infinity, up: Infinity }
      : towards === 'down'
        ? { ...current, down: current.down + step }
        : { ...current, up: current.up + step };
  return { ...reveals, [gap.index]: next };
}

export type GapPart =
  | {
      kind: 'gap';
      gap: DiffGap;
      /** First and last hidden new lines; `end` is unknown below the last hunk until the after text arrives. */
      start: number;
      end?: number;
      /** Lines still hidden, if known. */
      hidden?: number;
      /** A hunk lies above or below, so the gap can grow towards it. */
      above: boolean;
      below: boolean;
    }
  | { kind: 'hunk'; key: string; hunk: GapHunk };

/** Gaps between two hunks this short show their lines once the after text is known: a bar would be taller. */
export const SMALL_GAP = 3;

/**
 * The hunks and remaining gaps after revealing lines from the after text. Without the after text, reveals wait and
 * every gap shows as it is in the patch. A gap that is revealed in full joins the hunks on either side of it, and so
 * does a gap between hunks of at most `joinUpTo` lines.
 */
export function revealedParts(
  hunks: GapHunk[],
  gaps: DiffGap[],
  reveals: GapReveals,
  lines?: string[],
  joinUpTo = SMALL_GAP
): GapPart[] {
  const parts: GapPart[] = [];
  const context = (from: number, count: number): DiffRow[] =>
    Array.from({ length: count }, (_, i) => ({ type: ' ' as const, text: lines?.[from - 1 + i] ?? '' }));
  let current: { key: string; hunk: GapHunk } | undefined;
  for (const gap of gaps) {
    const above = gap.index > 0,
      below = gap.index < hunks.length;
    const size = gapSize(gap);
    const small = above && below && size !== undefined && size <= joinUpTo;
    const reveal =
      lines && size !== undefined
        ? small
          ? { down: size, up: 0 }
          : (reveals[gap.index] ?? { down: 0, up: 0 })
        : { down: 0, up: 0 };
    const down = above && size !== undefined ? Math.min(reveal.down, size) : 0;
    const up = below && size !== undefined ? Math.min(reveal.up, size - down) : 0;
    if (current && down) current.hunk = { ...current.hunk, rows: [...current.hunk.rows, ...context(gap.newStart, down)] };
    const hidden = size === undefined ? undefined : size - down - up;
    const next = below ? hunks[gap.index] : undefined;
    const upRows = next && up && size !== undefined ? context(gap.newStart + size - up, up) : [];
    if (hidden === 0) {
      if (next) {
        const rows = [...upRows, ...next.rows];
        if (current) current.hunk = { ...current.hunk, rows: [...current.hunk.rows, ...rows], noEofOld: next.noEofOld, noEofNew: next.noEofNew };
        else current = { key: `h${gap.index}`, hunk: { ...next, oldStart: next.oldStart - up, newStart: next.newStart - up, rows } };
      }
      continue;
    }
    if (current) parts.push({ kind: 'hunk', ...current });
    parts.push({
      kind: 'gap',
      gap,
      start: gap.newStart + down,
      end: gap.newEnd === undefined ? undefined : gap.newEnd - up,
      hidden,
      above,
      below,
    });
    current = next
      ? { key: `h${gap.index}`, hunk: { ...next, oldStart: next.oldStart - up, newStart: next.newStart - up, rows: [...upRows, ...next.rows] } }
      : undefined;
  }
  if (current) parts.push({ kind: 'hunk', ...current });
  return parts;
}

/** The gap that hides a line, if any. Before-side lines map through the gap's offset. */
export function gapContaining(gaps: DiffGap[], side: 'before' | 'after', line: number): DiffGap | undefined {
  return gaps.find((gap) => {
    const n = side === 'after' ? line : line - gap.oldOffset;
    return n >= gap.newStart && (gap.newEnd === undefined || n <= gap.newEnd);
  });
}

export interface DiffSlice {
  key: string;
  diff: FileDiffMetadata;
  /** Rendered rows in each layout, for a height estimate before the slice is laid out. */
  unifiedRows: number;
  splitRows: number;
  oldLines: [number, number];
  newLines: [number, number];
}

/**
 * A hunk as one or more diffs for Pierre. A hunk longer than `limit` rows renders as slices of `size` rows, like the
 * Explanation view's (lib/review-diff.ts), so slices outside the viewport skip style and layout (#353). Source
 * numbers are kept, so line numbers, comments and jumps still address the original lines.
 */
export function hunkSlices(
  key: string,
  hunk: GapHunk,
  file: { name: string; prevName?: string; status?: string },
  /** Pierre's `processFile`, passed in so this module loads without Pierre in unit tests. */
  parse: (patch: string) => FileDiffMetadata | undefined,
  limit = HUNK_SLICE_LIMIT,
  size = HUNK_SLICE_SIZE
): DiffSlice[] {
  const windows: [number, number][] = [];
  if (hunk.rows.length <= limit) windows.push([0, hunk.rows.length]);
  else for (let from = 0; from < hunk.rows.length; from += size) windows.push([from, Math.min(hunk.rows.length, from + size)]);
  let lastOld = -1,
    lastNew = -1;
  hunk.rows.forEach((row, i) => {
    if (row.type !== '+') lastOld = i;
    if (row.type !== '-') lastNew = i;
  });
  const added = file.status === 'added',
    deleted = file.status === 'deleted';
  const prefix = `diff --git a/source b/source\n${added ? 'new file mode 100644\n' : deleted ? 'deleted file mode 100644\n' : ''}--- ${added ? '/dev/null' : 'a/source'}\n+++ ${deleted ? '/dev/null' : 'b/source'}\n`;
  let oldLine = hunk.oldStart,
    newLine = hunk.newStart;
  return windows.flatMap(([from, to], index) => {
    const rows = hunk.rows.slice(from, to);
    const olds = oldCount({ rows }),
      news = newCount({ rows });
    const body: string[] = [];
    rows.forEach((row, i) => {
      body.push(row.type + row.text);
      const at = from + i;
      if ((hunk.noEofOld && at === lastOld) || (hunk.noEofNew && at === lastNew))
        body.push('\\ No newline at end of file');
    });
    const header = `@@ -${olds ? oldLine : oldLine - 1},${olds} +${news ? newLine : newLine - 1},${news} @@`;
    const slice = { oldLines: [oldLine, oldLine + olds - 1] as [number, number], newLines: [newLine, newLine + news - 1] as [number, number] };
    oldLine += olds;
    newLine += news;
    try {
      const diff = parse(`${prefix}${header}\n${body.join('\n')}\n`);
      if (!diff) return [];
      diff.name = file.name;
      if (file.prevName) diff.prevName = file.prevName;
      return [{ key: windows.length > 1 ? `${key}:${index}` : key, diff, // File-level counts include the lines before the hunk; only the hunk renders.
        unifiedRows: diff.hunks.reduce((n, h) => n + h.unifiedLineCount, 0),
        splitRows: diff.hunks.reduce((n, h) => n + h.splitLineCount, 0), ...slice }];
    } catch {
      return [];
    }
  });
}

/** Pierre adds this much to each diff's rows in Changes: 8px of padding above and below. A slice whose lines
 * overflow also shows a thin scrollbar; its real height replaces the estimate once it is laid out. */
export const SLICE_CHROME = 16;
/** Placeholder height for a slice that has not been laid out yet. */
export const estimateSliceHeight = (rows: number, lineHeight = CODE_LINE_HEIGHT) => Math.max(1, rows) * lineHeight + SLICE_CHROME;

/** The text of the shown lines on each side, for the selection and the agent brief. */
export function shownLines(parts: GapPart[]) {
  const before = new Map<number, string>(),
    after = new Map<number, string>();
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const row of part.hunk.rows) {
      if (row.type !== '+') before.set(oldLine++, row.text);
      if (row.type !== '-') after.set(newLine++, row.text);
    }
  }
  return { before, after };
}

/** Selected lines as text. When some of them are hidden, each shown line is prefixed by its number, unless
 * `numbered` is false. */
export function shownSelection(lines: Map<number, string>, start: number, end: number, numbered = true): string {
  const from = Math.min(start, end),
    to = Math.max(start, end);
  const selected: [number, string][] = [];
  for (let line = from; line <= to; line++) {
    const text = lines.get(line);
    if (text !== undefined) selected.push([line, text.replace(/\r$/, '')]);
  }
  const complete = selected.length === to - from + 1;
  return selected.map(([line, text]) => (complete || !numbered ? text : `${line}: ${text}`)).join('\n');
}

/**
 * Reveals new lines `start`–`end` where they continue a hunk: the top of a gap continues the hunk above it, and the
 * bottom continues the hunk below. A span that touches no hunk in a gap leaves that gap alone; `pinLines` shows such
 * lines. Reveals only grow, so applying the same span twice changes nothing (#393).
 */
export function revealSpan(reveals: GapReveals, gaps: DiffGap[], start: number, end: number): GapReveals {
  let next = reveals;
  for (const gap of gaps) {
    const gapEnd = gap.newEnd;
    if (gapEnd === undefined || end < gap.newStart || start > gapEnd) continue;
    const current = next[gap.index] ?? { down: 0, up: 0 };
    const down = start <= gap.newStart ? Math.max(current.down, Math.min(end, gapEnd) - gap.newStart + 1) : current.down;
    const up = end >= gapEnd ? Math.max(current.up, gapEnd - Math.max(start, gap.newStart) + 1) : current.up;
    if (down !== current.down || up !== current.up) next = { ...next, [gap.index]: { down, up } };
  }
  return next;
}

/**
 * Shows new lines `start`–`end` in the middle of a gap, such as a long function's signature far above its change
 * (#393). Lines that touch what a gap already shows extend that reveal. The rest are returned as a pin: `withPins`
 * makes it a hunk of unchanged lines, which splits the gap in two. Reveals are by gap index, so the reveals of the
 * gaps after the pin move up one.
 */
export function pinLines(
  hunks: GapHunk[],
  gaps: DiffGap[],
  reveals: GapReveals,
  start: number,
  end: number
): { pin?: [number, number]; reveals: GapReveals } {
  const gap = gaps.find((g) => g.newEnd !== undefined && start >= g.newStart && start <= g.newEnd);
  if (!gap || gap.newEnd === undefined) return { reveals };
  const current = reveals[gap.index] ?? { down: 0, up: 0 };
  const above = gap.index > 0,
    below = gap.index < hunks.length;
  const shownTop = above ? gap.newStart + current.down : gap.newStart;
  const shownBottom = below ? gap.newEnd - current.up : gap.newEnd;
  const from = Math.max(start, shownTop),
    to = Math.min(end, shownBottom);
  if (from > to) return { reveals };
  if (above && from === shownTop) return { reveals: revealSpan(reveals, gaps, gap.newStart, to) };
  if (below && to === shownBottom) return { reveals: revealSpan(reveals, gaps, from, gap.newEnd) };
  const shifted: Record<number, GapReveal> = {};
  for (const [key, value] of Object.entries(reveals)) {
    const index = Number(key);
    if (index < gap.index) shifted[index] = value;
    else if (index > gap.index) shifted[index + 1] = value;
  }
  shifted[gap.index] = { down: current.down, up: 0 };
  shifted[gap.index + 1] = { down: 0, up: current.up };
  return { pin: [from, to], reveals: shifted };
}

/** The hunks with each pinned span of new lines as a hunk of unchanged lines, in order. A pin that is not inside a
 * gap is left out. */
export function withPins(hunks: GapHunk[], pins: readonly (readonly [number, number])[], lines: string[]): GapHunk[] {
  if (!pins.length) return hunks;
  const result: GapHunk[] = [];
  const sorted = [...pins].sort((a, b) => a[0] - b[0]);
  let p = 0;
  let previousOld = 0,
    previousNew = 0;
  const pinUntil = (next: number) => {
    for (; p < sorted.length && sorted[p][0] < next; p++) {
      const [from, to] = sorted[p];
      if (from <= previousNew || to >= next || to > lines.length) continue;
      const offset = previousOld - previousNew;
      result.push({
        oldStart: from + offset,
        newStart: from,
        rows: lines.slice(from - 1, to).map((text) => ({ type: ' ' as const, text })),
        noEofOld: false,
        noEofNew: false,
      });
      previousOld = to + offset;
      previousNew = to;
    }
  };
  for (const hunk of hunks) {
    pinUntil(hunk.newStart);
    result.push(hunk);
    previousOld = oldEnd(hunk);
    previousNew = newEnd(hunk);
  }
  pinUntil(Infinity);
  return result;
}
