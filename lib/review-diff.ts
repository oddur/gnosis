import { contentHasDiffMarkers, parseDiffLines } from './diff-lines';
import type { DiffHunk, FileMetadata } from './types';

export interface DiffAppearance {
  contextLines?: number;
  indicators: 'bars' | 'classic' | 'none';
  inline: 'word-alt' | 'word-line' | 'word' | 'char' | 'none';
  backgrounds: boolean;
  wrap: boolean;
  lineNumbers: boolean;
}
export const DEFAULT_DIFF_APPEARANCE: DiffAppearance = {
  contextLines: 3,
  indicators: 'classic',
  inline: 'word-alt',
  backgrounds: true,
  wrap: false,
  lineNumbers: true,
};

export function diffContextLines(appearance?: DiffAppearance): number {
  const count = appearance?.contextLines;
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 50 ? count : 3;
}

/** Saved reviews contain selected/expanded hunks, not complete files. Recount
 * their actual lines, preserving source coordinates and authoritative status. */
export function prepareReviewHunk(hunk: DiffHunk, status?: FileMetadata['status']) {
  const match = hunk.hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match || !hunk.content) return null;
  const added = status === 'added' || (!status && match[1] === '0' && match[2] === '0');
  const deleted = status === 'deleted' || (!status && match[3] === '0' && match[4] === '0');
  const content = hunk.content
    .split('\n')
    .filter((l) => !l.startsWith('\\ No newline at end of file'))
    .join('\n');
  const normalized = contentHasDiffMarkers(content)
    ? content
    : content
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => (added ? '+' : deleted ? '-' : ' ') + line)
        .join('\n');
  const lines = parseDiffLines(hunk.hunkHeader, normalized).map((line) => {
    if (added && line.type !== 'remove') return { ...line, type: 'add' as const, baseLineNumber: null };
    if (deleted && line.type !== 'add')
      return {
        ...line,
        type: 'remove' as const,
        side: 'LEFT' as const,
        lineNumber: line.baseLineNumber ?? line.lineNumber,
        headLineNumber: null,
      };
    return line;
  });
  if (
    !lines.length ||
    (added && lines.some((l) => l.type === 'remove')) ||
    (deleted && lines.some((l) => l.type === 'add'))
  )
    return null;
  const oldCount = lines.filter((l) => l.type !== 'add').length;
  const newCount = lines.filter((l) => l.type !== 'remove').length;
  const header = `@@ -${added ? 0 : match[1]},${oldCount} +${deleted ? 0 : match[3]},${newCount} @@`;
  const patch = `diff --git a/source b/source\n${added ? 'new file mode 100644\n' : deleted ? 'deleted file mode 100644\n' : ''}--- ${added ? '/dev/null' : 'a/source'}\n+++ ${deleted ? '/dev/null' : 'b/source'}\n${header}\n${lines.map((l) => (l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ') + l.text).join('\n')}\n`;
  return { patch, lines, singleSide: added || deleted };
}

export interface ContextRange {
  start: number;
  end: number;
  hidden: boolean;
}

/** Fold only unchanged source that is actually saved, never changes or unknown
 * gaps between hunks. Comments/checks pin their source lines into view. */
export function reviewContextRanges(
  lines: ReturnType<typeof parseDiffLines>,
  pinned: ReadonlySet<number> = new Set(),
  revealed: ReadonlySet<number> = new Set(),
  context = 3
): ContextRange[] {
  if (!lines.some((line) => line.type !== 'context')) return [{ start: 0, end: lines.length, hidden: false }];
  const visible = new Set(revealed);
  lines.forEach((line, index) => {
    if (line.type !== 'context' || pinned.has(index)) {
      for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) visible.add(i);
    }
  });
  const ranges: ContextRange[] = [];
  lines.forEach((_, index) => {
    const hidden = !visible.has(index);
    const last = ranges.length > 0 ? ranges[ranges.length - 1] : undefined;
    if (last && last.hidden === hidden) last.end = index + 1;
    else ranges.push({ start: index, end: index + 1, hidden });
  });
  return ranges;
}

/** Slice a saved hunk without renumbering its source. Normalization guarantees
 * all hidden rows are context, so each emitted section starts at a real line. */
export function sliceReviewHunk(
  hunk: DiffHunk,
  lines: ReturnType<typeof parseDiffLines>,
  start: number,
  end: number
): DiffHunk {
  const selected = lines.slice(start, end);
  const header = hunk.hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!header || !selected.length) return hunk;
  const oldCount = selected.filter((line) => line.type !== 'add').length;
  const newCount = selected.filter((line) => line.type !== 'remove').length;
  const before = lines.slice(0, start);
  const oldStart = Number(header[1]) + before.filter((line) => line.type !== 'add').length;
  const newStart = Number(header[3]) + before.filter((line) => line.type !== 'remove').length;
  return {
    ...hunk,
    hunkHeader: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    content: selected
      .map((line) => (line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ') + line.text)
      .join('\n'),
  };
}

/** Height of one Pierre code row, from --leading-code (1.25rem). */
export const CODE_LINE_HEIGHT = 20;
/** A visible range longer than this renders as several diffs, so off-screen slices can skip style and layout. */
export const HUNK_SLICE_LIMIT = 300;
export const HUNK_SLICE_SIZE = 200;

/** Split [start, end) into slices of `size` lines when it is longer than `limit`. Source numbers are kept by
 * sliceReviewHunk, so line numbers, annotations and deep links still address the original lines. */
export function reviewHunkSlices(
  start: number,
  end: number,
  limit = HUNK_SLICE_LIMIT,
  size = HUNK_SLICE_SIZE
): [number, number][] {
  if (end - start <= limit) return [[start, end]];
  const slices: [number, number][] = [];
  for (let from = start; from < end; from += size) slices.push([from, Math.min(end, from + size)]);
  return slices;
}

/** Placeholder height for `contain-intrinsic-block-size` while a diff is skipped. `auto` replaces it with the
 * real height once the diff has rendered, so this only has to be close for diffs not yet seen. */
export function estimateHunkBlockHeight(lines: number, lineHeight = CODE_LINE_HEIGHT) {
  return Math.max(1, lines) * lineHeight + 8;
}

/** Placeholder height for the block that holds a hunk's visible ranges, each sliced as reviewHunkSlices does, with
 * one bar per folded range. A 3,000-line file skipped at the stylesheet's 400px fallback made the document about
 * 60,000px shorter for a frame, and the browser clamped scrollTop to fit, which scrolled a find match out of view
 * (#288). */
export function estimateSlicedBlockHeight(ranges: ContextRange[], lineHeight = CODE_LINE_HEIGHT) {
  let height = 0;
  for (const range of ranges) {
    if (range.hidden) height += 1.5 * lineHeight;
    else
      for (const [start, end] of reviewHunkSlices(range.start, range.end))
        height += estimateHunkBlockHeight(end - start, lineHeight);
  }
  return Math.round(height);
}

/** Placeholder height for a whole file group: its header, plus the rows it shows when expanded. Folded context
 * counts as one bar. */
export function estimateFileBlockHeight(
  hunks: DiffHunk[],
  {
    status,
    expanded = true,
    contextLines = 3,
    lineHeight = CODE_LINE_HEIGHT,
  }: { status?: FileMetadata['status']; expanded?: boolean; contextLines?: number; lineHeight?: number } = {}
) {
  const header = 48;
  if (!expanded) return header;
  let rows = 0;
  for (const hunk of hunks) {
    const prepared = prepareReviewHunk(hunk, status);
    if (!prepared) {
      rows += hunk.content.split('\n').length;
      continue;
    }
    if (prepared.singleSide) {
      rows += prepared.lines.length;
      continue;
    }
    for (const range of reviewContextRanges(prepared.lines, new Set(), new Set(), contextLines))
      rows += range.hidden ? 1.5 : range.end - range.start;
  }
  return Math.round(header + rows * lineHeight + hunks.length * 8);
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
  const files = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) files.set(hunk.filePath, [...(files.get(hunk.filePath) ?? []), hunk]);
  let height = 80;
  for (const [filePath, fileHunks] of files)
    height += 20 + estimateFileBlockHeight(fileHunks, { status: status?.(filePath), expanded: !viewed?.(filePath) });
  return Math.round(height);
}
