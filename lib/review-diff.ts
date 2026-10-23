import { contentHasDiffMarkers, parseDiffLines } from './diff-lines';
import type { DiffHunk, FileMetadata } from './types';

export interface DiffAppearance {
  indicators: 'bars' | 'classic' | 'none';
  inline: 'word-alt' | 'word-line' | 'word' | 'char' | 'none';
  backgrounds: boolean;
  wrap: boolean;
  lineNumbers: boolean;
}
export const DEFAULT_DIFF_APPEARANCE: DiffAppearance = {
  indicators: 'classic',
  inline: 'word-alt',
  backgrounds: true,
  wrap: false,
  lineNumbers: true,
};

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
