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
  /**
   * Changes the view leaves out lie in this gap, so its sides differ in length and its lines cannot be revealed from
   * the after side: an Explanation topic shows some of a file's hunks (`diffGaps` with `partial`).
   */
  opaque?: boolean;
  /**
   * In an opaque gap, how many lines next to the hunk above, and next to the hunk below, both sides agree on: those
   * reveal; the change between them does not.
   */
  revealDown?: number;
  revealUp?: number;
  /**
   * An Explanation topic shows this file in more than one block, and this gap covers a change another block shows: the
   * block (its `run`) that shows it. The gap is opaque and reveals nothing (`markElsewhere`).
   */
  elsewhere?: number;
}
/** A change another block of the same file shows, in new-side lines (lib/slide-file-groups.ts). */
export interface ElsewhereChange {
  start: number;
  end: number;
  run: number;
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

export interface HunkRange {
  /** As the hunk header shows it: `L120–148`, or `old L9–11` for a hunk that only deletes. */
  label: string;
  /**
   * In words, for the tooltip and screen readers: "Lines 120 to 148", "Old lines 9 to 11", and the old lines too where
   * they differ: "Lines 12 to 14 (old lines 9 to 11)".
   */
  spoken: string;
}
/** One side's lines in a hunk: `L4`, `L120–148`, with `prefix` before the L. */
function sideRange(start: number, count: number, prefix: string, words: string): HunkRange {
  const end = start + Math.max(count, 1) - 1;
  if (end <= start) return { label: `${prefix}L${start}`, spoken: `${words} ${start}` };
  return { label: `${prefix}L${start}–${end}`, spoken: `${words}s ${start} to ${end}` };
}
/**
 * Where a hunk is, by its new lines, or by its old lines when it only deletes: its deleted lines have no new numbers.
 * Every hunk header shows it (#395). Where the old lines differ, they are in the words alone, for the tooltip and
 * screen readers: the header shows one range.
 */
export function hunkRange(hunk: Pick<GapHunk, 'oldStart' | 'newStart' | 'rows'>): HunkRange {
  const adds = hunk.rows.some((row) => row.type === '+');
  const deletes = hunk.rows.some((row) => row.type === '-');
  if (!adds && deletes) return sideRange(hunk.oldStart, oldCount(hunk), 'old ', 'Old line');
  const after = sideRange(hunk.newStart, newCount(hunk), '', 'Line');
  if (!deletes) return after;
  const before = sideRange(hunk.oldStart, oldCount(hunk), 'old ', 'Old line');
  if (before.label === `old ${after.label}`) return after;
  return { label: after.label, spoken: `${after.spoken} (${before.spoken.toLowerCase()})` };
}

/** How many lines a hunk adds and deletes. */
export interface HunkCounts {
  added: number;
  deleted: number;
}
export function hunkCounts(hunk: Pick<GapHunk, 'rows'>): HunkCounts {
  let added = 0,
    deleted = 0;
  for (const row of hunk.rows) {
    if (row.type === '+') added++;
    else if (row.type === '-') deleted++;
  }
  return { added, deleted };
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

/**
 * Gaps that cover a change another block of the topic shows reveal nothing: their lines are not unchanged code, and the
 * change shows once, in its own block. Each names that block, for a jump there.
 */
export function markElsewhere(gaps: DiffGap[], changes: readonly ElsewhereChange[] | undefined): DiffGap[] {
  if (!changes?.length) return gaps;
  return gaps.map((gap) => {
    const end = gap.newEnd ?? Infinity;
    const hit = changes.find((change) => change.start <= end + 1 && change.end >= gap.newStart);
    return hit ? { ...gap, opaque: true, revealDown: 0, revealUp: 0, elsewhere: hit.run } : gap;
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
 * otherwise has no gaps to reveal, and this returns undefined. With `partial`, the hunks are some of a file's (an
 * Explanation topic's), and a gap whose sides differ holds changes left out: it is `opaque`, and reveals only the
 * lines next to its hunks that the view finds unchanged (`revealDown`, `revealUp`).
 */
export function diffGaps(hunks: GapHunk[], afterLineCount?: number, { partial = false } = {}): DiffGap[] | undefined {
  if (!hunks.length) return undefined;
  const gaps: DiffGap[] = [];
  let previousOld = 0,
    previousNew = 0;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const oldSize = hunk.oldStart - 1 - previousOld,
      newSize = hunk.newStart - 1 - previousNew;
    if (newSize < 0 || oldSize < 0 || (oldSize !== newSize && !partial)) return undefined;
    gaps.push({
      index,
      newStart: previousNew + 1,
      newEnd: hunk.newStart - 1,
      oldOffset: previousOld - previousNew,
      ...(oldSize !== newSize ? { opaque: true } : {}),
    });
    previousOld = oldEnd(hunk);
    previousNew = newEnd(hunk);
  }
  const last = hunks[hunks.length - 1];
  const end = afterLineCount ?? (last.noEofNew ? previousNew : undefined);
  if (end !== undefined && end < previousNew) return undefined;
  // Below the last hunk shown, a topic may leave out more changes: its lines are known only from the after text.
  gaps.push({ index: hunks.length, newStart: previousNew + 1, newEnd: end, oldOffset: previousOld - previousNew });
  return gaps;
}

export const gapSize = (gap: DiffGap) => (gap.newEnd === undefined ? undefined : gap.newEnd - gap.newStart + 1);

/** Whether `lines` can be the after side of `hunks`: every line the patch shows on the new side is that line. */
export function matchesAfter(hunks: GapHunk[], lines: string[]): boolean {
  return firstMismatch(hunks, lines) === undefined;
}

const BOM = '\ufeff';
/**
 * A line as the comparison sees it: without a carriage return at its end, and line 1 without a byte order mark. Main
 * decodes file contents with TextDecoder, which drops a leading BOM that GitHub's patch keeps; and a topic's saved
 * hunks, or a patch from another source, can lose the carriage returns of a CRLF file. Neither is a change.
 */
function sameLine(file: string | undefined, patch: string, line: number): boolean {
  if (file === patch) return true;
  if (file === undefined) return false;
  const strip = (text: string) => {
    const start = line === 1 && text.startsWith(BOM) ? 1 : 0;
    const end = text.endsWith('\r') ? text.length - 1 : text.length;
    return text.slice(start, end);
  };
  return strip(file) === strip(patch);
}

/**
 * The first new line where `lines` disagrees with `hunks`, or undefined when they agree (`matchesAfter`). A patch
 * that ends without a final line feed and a file with more lines below disagree at the line after the patch's last.
 */
export function firstMismatch(hunks: GapHunk[], lines: readonly string[]): number | undefined {
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const row of hunk.rows) {
      if (row.type === '-') continue;
      if (!sameLine(lines[line - 1], row.text, line)) return line;
      line++;
    }
  }
  const last = hunks.at(-1);
  if (!last || !last.noEofNew || newEnd(last) === lines.length) return undefined;
  return newEnd(last) + 1;
}

/** How a file's text ends its lines, for the diagnostics of a file that does not match its patch. */
export interface LineEndings {
  /** `crlf` when every line feed follows a carriage return, `mixed` when some do. */
  endings: 'lf' | 'crlf' | 'mixed' | 'none';
  finalNewline: boolean;
  bom: boolean;
}
export function lineEndings(text: string): LineEndings {
  const feeds = text.split('\n').length - 1;
  const crlf = text.split('\r\n').length - 1;
  return {
    endings: !feeds ? 'none' : crlf === feeds ? 'crlf' : crlf ? 'mixed' : 'lf',
    finalNewline: text.endsWith('\n'),
    bom: text.startsWith(BOM),
  };
}
/** The same, for a patch's new side: its rows end in a carriage return where the file's lines do. */
export function patchLineEndings(hunks: GapHunk[]): LineEndings {
  const rows = hunks.flatMap((hunk) => hunk.rows.filter((row) => row.type !== '-'));
  const returns = rows.filter((row) => row.text.endsWith('\r')).length;
  const first = hunks[0]?.newStart === 1 ? hunks[0].rows.find((row) => row.type !== '-') : undefined;
  return {
    endings: !rows.length ? 'none' : returns === rows.length ? 'crlf' : returns ? 'mixed' : 'lf',
    finalNewline: !hunks.at(-1)?.noEofNew,
    bom: !!first?.text.startsWith(BOM),
  };
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
      /** Lines the view has, next to the hunk above or below, are still hidden. */
      more?: { down: boolean; up: boolean };
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
  lines?: readonly (string | undefined)[],
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
    // A gap reveals only lines the text has: all of them with the after text, or those next to a hunk that a topic
    // saved, below the last hunk too before the after text says where the file ends. A gap holding changes left out
    // reveals nothing.
    const has = (from: number, step: 1 | -1) => (lines ? definedRun(lines, from, size ?? Infinity, step) : 0);
    const downTo = Math.min(has(gap.newStart, 1), gap.opaque ? (gap.revealDown ?? 0) : Infinity),
      upTo = size === undefined ? 0 : Math.min(has(gap.newStart + size - 1, -1), gap.opaque ? (gap.revealUp ?? 0) : Infinity);
    const small = above && below && size !== undefined && size <= joinUpTo && downTo === size;
    const reveal = small ? { down: size, up: 0 } : (reveals[gap.index] ?? { down: 0, up: 0 });
    const down = above ? Math.min(reveal.down, size ?? Infinity, downTo) : 0;
    const up = below && size !== undefined ? Math.min(reveal.up, size - down, upTo) : 0;
    if (current && down) current.hunk = { ...current.hunk, rows: [...current.hunk.rows, ...context(gap.newStart, down)] };
    const hidden = size === undefined ? undefined : size - down - up;
    const next = below ? hunks[gap.index] : undefined;
    const upRows = next && up && size !== undefined ? context(gap.newStart + size - up, up) : [];
    if (hidden === 0 && !gap.opaque) {
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
      more: { down: above && downTo > down, up: below && upTo > up },
    });
    current = next
      ? { key: `h${gap.index}`, hunk: { ...next, oldStart: next.oldStart - up, newStart: next.newStart - up, rows: [...upRows, ...next.rows] } }
      : undefined;
  }
  if (current) parts.push({ kind: 'hunk', ...current });
  return parts;
}

/** How many lines `lines` has in a row from `start`, going `step`, at most `count`: a topic's saved lines leave holes. */
function definedRun(lines: readonly (string | undefined)[], start: number, count: number, step: 1 | -1): number {
  let run = 0;
  while (run < count && lines[start - 1 + run * step] !== undefined) run++;
  return run;
}

/** Whether `lines` has every line from `start`, `count` of them: a topic's saved lines leave holes. */
export function knownLines(lines: readonly (string | undefined)[], start: number, count: number): boolean {
  for (let line = start; line < start + count; line++) if (lines[line - 1] === undefined) return false;
  return true;
}

/**
 * Where a line of one side is among a diff's parts (#417): a row of a hunk, or hidden in a gap, whose bar stands in
 * for it. A line that neither shows nor hides, such as one past the file's end, gives the nearest shown row or gap
 * above it, and `top` when nothing is above it. Nothing is revealed to find it.
 */
export type LinePlace =
  | { kind: 'row'; key: string; row: number; line: number }
  | { kind: 'gap'; gap: number }
  | { kind: 'top' };
export function placeOfLine(parts: readonly GapPart[], side: 'before' | 'after', line: number): LinePlace {
  let above: LinePlace = { kind: 'top' };
  for (const part of parts) {
    if (part.kind === 'gap') {
      // A gap's hidden lines in the side's numbers; an opaque gap's old numbers are not known.
      const offset = side === 'before' ? part.gap.oldOffset : 0;
      const start = part.start + offset,
        end = part.end === undefined ? Infinity : part.end + offset;
      if (start > line) return above;
      if (start > end) continue;
      if (line <= end) return { kind: 'gap', gap: part.gap.index };
      above = { kind: 'gap', gap: part.gap.index };
      continue;
    }
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const [row, { type }] of part.hunk.rows.entries()) {
      const shows = side === 'before' ? type !== '+' : type !== '-';
      const at = side === 'before' ? oldLine : newLine;
      if (type !== '+') oldLine++;
      if (type !== '-') newLine++;
      if (!shows) continue;
      if (at === line) return { kind: 'row', key: part.key, row, line };
      if (at > line) return above;
      above = { kind: 'row', key: part.key, row, line: at };
    }
  }
  return above;
}

/**
 * A line of one side as a new line, for reveals, which are in new numbers: an old line hidden in a gap maps through
 * the gap's offset, and a deleted row maps to the new line where it sits. Undefined where the parts do not say.
 */
export function newLineAt(parts: readonly GapPart[], side: 'before' | 'after', line: number): number | undefined {
  if (side === 'after') return line;
  for (const part of parts) {
    if (part.kind === 'gap') {
      const offset = part.gap.oldOffset;
      if (line >= part.start + offset && (part.end === undefined || line <= part.end + offset)) return line - offset;
      continue;
    }
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const { type } of part.hunk.rows) {
      if (type !== '+' && oldLine === line) return newLine;
      if (type !== '+') oldLine++;
      if (type !== '-') newLine++;
    }
  }
  return undefined;
}

/** Whether any line from new line `start` to `end` is hidden in a gap that can show it. */
export function hiddenBetween(parts: readonly GapPart[], start: number, end: number): boolean {
  return parts.some(
    (part) => part.kind === 'gap' && !!part.hidden && part.start <= end && (part.end === undefined || part.end >= start)
  );
}

/** The gap that hides a line, if any. Before-side lines map through the gap's offset. */
export function gapContaining(gaps: DiffGap[], side: 'before' | 'after', line: number): DiffGap | undefined {
  return gaps.find((gap) => {
    if (gap.opaque) return false;
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
  const gap = gaps.find((g) => !g.opaque && g.newEnd !== undefined && start >= g.newStart && start <= g.newEnd);
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
