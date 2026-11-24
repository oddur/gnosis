import { SLICE_CHROME, estimateSliceHeight, type DiffRow, type GapHunk } from './diff-gaps';
import { CODE_LINE_HEIGHT, HUNK_SLICE_LIMIT, HUNK_SLICE_SIZE, prepareReviewHunk } from './review-diff';
import type { DiffHunk, DiffSide, FileMetadata } from './types';
import { groupSlideHunks } from './slide-file-groups';
import { rangeBlockHunks } from './explanation-ranges';

/** A line that stays in view: a review check (either side), a thread, a note or a draft comment. */
export interface ReviewPin {
  line: number;
  side?: DiffSide;
}

interface Row extends DiffRow {
  old?: number;
  new?: number;
  /** The saved hunk's header, for comments made on the line. */
  header: string;
}

export interface ReviewGapHunks {
  /** The topic's hunks as Changes shows a file's: changes with `context` lines around them, sorted, never overlapping. */
  hunks: GapHunk[];
  /**
   * The new side's lines the topic saved, by line number less one, with holes where it saved nothing. Gaps inside a
   * saved hunk reveal from these without a read.
   */
  known: (string | undefined)[];
  /** The saved hunk header of each shown line, `RIGHT:12` or `LEFT:9`, for comments (PendingReviewComment.hunkHeader). */
  headers: Map<string, string>;
  /** A GitHub-style patch of the saved hunks, for provisional breadcrumbs and the scope read's plan. */
  patch: string;
  /** Saved hunks that could not be read as a diff. */
  unreadable: DiffHunk[];
}

const startOf = (header: string) => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return undefined;
  // A side with no lines names the line before it, as `hunksFromDiff` reads it.
  return {
    old: Number(match[1]) + (match[2] === '0' ? 1 : 0),
    new: Number(match[3]) + (match[4] === '0' ? 1 : 0),
  };
};

/**
 * An Explanation topic's saved hunks as the hunks Changes renders (#157 parity): a topic saves some of a file's hunks,
 * often with more context than GitHub's three lines. Each saved hunk keeps its changes and pinned lines with `context`
 * lines around them, like a GitHub patch; the context between them becomes gaps that reveal from the saved lines.
 * Added and deleted files show whole, as in Changes. Saved hunks that overlap keep each line once.
 */
export function reviewGapHunks(
  saved: DiffHunk[],
  {
    status,
    context = 3,
    pins = [],
  }: { status?: FileMetadata['status']; context?: number; pins?: readonly ReviewPin[] } = {}
): ReviewGapHunks {
  const unreadable: DiffHunk[] = [];
  const known: (string | undefined)[] = [];
  const headers = new Map<string, string>();
  const groups: Row[][] = [];
  for (const hunk of saved) {
    const prepared = prepareReviewHunk(hunk, status);
    const start = prepared && startOf(prepared.patch.split('\n').find((line) => line.startsWith('@@')) ?? '');
    if (!prepared || !start) {
      unreadable.push(hunk);
      continue;
    }
    let oldLine = start.old,
      newLine = start.new;
    const rows: Row[] = prepared.lines.map((line) => {
      const type = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      const row: Row = {
        type,
        text: line.text,
        header: hunk.hunkHeader,
        ...(type !== '+' ? { old: oldLine++ } : {}),
        ...(type !== '-' ? { new: newLine++ } : {}),
      };
      return row;
    });
    groups.push(rows);
  }
  const first = (rows: Row[]) => ({
    new: rows.find((row) => row.new !== undefined)?.new ?? Infinity,
    old: rows.find((row) => row.old !== undefined)?.old ?? Infinity,
  });
  groups.sort((a, b) => first(a).new - first(b).new || first(a).old - first(b).old);
  // One run of rows per stretch of the file the topic saved; overlapping saved hunks keep each line once.
  const runs: Row[][] = [];
  let lastOld = 0,
    lastNew = 0;
  for (const rows of groups) {
    const fresh = rows.filter((row) => (row.new === undefined || row.new > lastNew) && (row.old === undefined || row.old > lastOld));
    if (!fresh.length) continue;
    const head = fresh[0];
    const run = runs.at(-1);
    const joins =
      run &&
      (head.old === undefined || head.old === lastOld + 1) &&
      (head.new === undefined || head.new === lastNew + 1);
    if (run && joins) run.push(...fresh);
    else runs.push(fresh);
    for (const row of fresh) {
      if (row.old !== undefined) lastOld = Math.max(lastOld, row.old);
      if (row.new !== undefined) lastNew = Math.max(lastNew, row.new);
    }
  }
  const whole = status === 'added' || status === 'deleted';
  const pinned = (row: Row) =>
    pins.some((pin) =>
      pin.side === 'LEFT' ? row.old === pin.line : pin.side === 'RIGHT' ? row.new === pin.line : row.new === pin.line || row.old === pin.line
    );
  const hunks: GapHunk[] = [];
  const patch: string[] = [];
  for (const run of runs) {
    for (const row of run) {
      if (row.new !== undefined) {
        known[row.new - 1] = row.text;
        headers.set(`RIGHT:${row.new}`, row.header);
      }
      if (row.old !== undefined) headers.set(`LEFT:${row.old}`, row.header);
    }
    const oldStart = run.find((row) => row.old !== undefined)?.old;
    const newStart = run.find((row) => row.new !== undefined)?.new;
    const olds = run.filter((row) => row.old !== undefined).length,
      news = run.filter((row) => row.new !== undefined).length;
    // The line before a side with no lines, as GitHub's headers name it.
    const runOld = oldStart ?? lastBefore(run, 'old'),
      runNew = newStart ?? lastBefore(run, 'new');
    patch.push(`@@ -${olds ? runOld : runOld - 1},${olds} +${news ? runNew : runNew - 1},${news} @@${headerText(run[0].header)}`);
    patch.push(...run.map((row) => row.type + row.text));
    const keep = run.map(() => whole || !run.some((row) => row.type !== ' '));
    if (!whole)
      run.forEach((row, index) => {
        if (row.type === ' ' && !pinned(row)) return;
        for (let i = Math.max(0, index - context); i <= Math.min(run.length - 1, index + context); i++) keep[i] = true;
      });
    let oldLine = runOld,
      newLine = runNew;
    let current: GapHunk | undefined;
    run.forEach((row, index) => {
      if (keep[index]) {
        current ??= { oldStart: oldLine, newStart: newLine, rows: [], noEofOld: false, noEofNew: false };
        current.rows.push({ type: row.type, text: row.text });
      } else if (current) {
        hunks.push(current);
        current = undefined;
      }
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    });
    if (current) hunks.push(current);
  }
  return { hunks, known, headers, patch: patch.join('\n'), unreadable };
}

/** Where a run with no lines on one side sits on that side: the line after the last one before it. */
function lastBefore(run: Row[], side: 'old' | 'new'): number {
  // A run of only added lines sits after the old line before them; the saved header said where.
  const start = startOf(run[0].header);
  return start ? start[side] : 1;
}

const headerText = (header: string) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.exec(header)?.[1] ?? '';

/** The code-tier file header (DiffFileHeader) and the topic file's frame. */
export const FILE_HEADER = 46;
/** The code's surface above each hunk header and under the trailing bar (`--diff-hunk-air` in src/tokens.css). */
export const HUNK_AIR = 8;
/** A hunk header: 1.5 code lines, its rule, and the air above it (globals.css `.diff-hunk > .diff-gap[data-hunk-header]`). */
export const HUNK_BAR = 1.5 * CODE_LINE_HEIGHT + 1 + HUNK_AIR;
/** The bar below the last hunk: one code line, its rule, and the air under it. */
export const TRAILING_BAR = CODE_LINE_HEIGHT + 1 + HUNK_AIR;

/**
 * Placeholder height for a topic's file while content-visibility skips it: what ChangesDiff renders for the topic's
 * hunks (reviewGapHunks), each sliced as hunkSlices does, with a bar above each hunk and one below the last. `auto`
 * keeps the real height once the file has rendered. A 3,000-line file skipped at a 400px fallback made the document
 * about 60,000px shorter for a frame, and the browser clamped scrollTop to fit (#288).
 */
export function estimateFileBlockHeight(
  hunks: DiffHunk[],
  {
    status,
    expanded = true,
    contextLines = 3,
    lineHeight = CODE_LINE_HEIGHT,
  }: { status?: FileMetadata['status']; expanded?: boolean; contextLines?: number; lineHeight?: number } = {}
) {
  if (!expanded) return FILE_HEADER;
  const topic = reviewGapHunks(hunks, { status, context: contextLines });
  let height = FILE_HEADER;
  for (const hunk of topic.hunks) {
    const rows = hunk.rows.length;
    if (rows <= HUNK_SLICE_LIMIT) height += estimateSliceHeight(rows, lineHeight);
    else for (let from = 0; from < rows; from += HUNK_SLICE_SIZE) height += estimateSliceHeight(Math.min(HUNK_SLICE_SIZE, rows - from), lineHeight);
  }
  // Added and deleted files are one hunk with no bars, as in Changes.
  if (topic.hunks.length && status !== 'added' && status !== 'deleted')
    height += topic.hunks.length * (lineHeight * 1.5 + 1 + HUNK_AIR) + lineHeight + 1 + HUNK_AIR;
  for (const hunk of topic.unreadable) height += hunk.content.split('\n').length * lineHeight + SLICE_CHROME;
  return Math.round(height);
}

/** Placeholder height for a section's code before it mounts: each file's estimate, collapsed when viewed, plus the
 * gaps and padding of the code column. */
export function estimateCodeColumnHeight(
  hunks: DiffHunk[],
  {
    status,
    viewed,
  }: { status?: (filePath: string) => FileMetadata['status'] | undefined; viewed?: (filePath: string) => boolean } = {}
) {
  let height = 80;
  // One block per run of a file, as SlideView renders the reading order; slices show only their ranges (#563).
  for (const { filePath, hunks: fileHunks } of groupSlideHunks(hunks))
    height +=
      20 +
      estimateFileBlockHeight(rangeBlockHunks(fileHunks).hunks, { status: status?.(filePath), expanded: !viewed?.(filePath) });
  return Math.round(height);
}
