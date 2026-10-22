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
