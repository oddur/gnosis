/**
 * Code a reviewer selected and asked about, with where it came from.
 *
 * A selection travels as one string (in drafts, saved conversations and requests), so its location is a first line
 * the model reads too: `After lines 40–52 of src/queue.ts:` then the code. `After` names the new side of the diff and
 * `Before` the old one. Selections made before locations were recorded have no path (`After lines 40–52:`) or no
 * header at all; both still parse. No React imports.
 */
export interface ChatSelection {
  /** The selected code, without the location line. */
  code: string;
  path?: string;
  side?: 'before' | 'after';
  startLine?: number;
  endLine?: number;
}

const HEADER = /^(Before|After) lines? (\d+)(?:[–-](\d+))?(?: of (.+?))?:\n/;

export function formatChatSelection(selection: ChatSelection): string {
  const { code, path, side, startLine, endLine } = selection;
  if (!startLine) return code;
  const end = endLine && endLine !== startLine ? Math.max(startLine, endLine) : undefined;
  const start = end ? Math.min(startLine, endLine ?? startLine) : startLine;
  const lines = end ? `lines ${start}–${end}` : `line ${start}`;
  // A path with a newline or a trailing colon could not be read back; such a path is left out.
  const where = path && !/[\n\r]|:$/.test(path) ? ` of ${path}` : '';
  return `${side === 'before' ? 'Before' : 'After'} ${lines}${where}:\n${code}`;
}

export function parseChatSelection(text: string): ChatSelection {
  const match = HEADER.exec(text);
  if (!match) return { code: text };
  const a = Number(match[2]);
  const b = match[3] ? Number(match[3]) : a;
  return {
    code: text.slice(match[0].length),
    side: match[1] === 'Before' ? 'before' : 'after',
    startLine: Math.min(a, b),
    endLine: Math.max(a, b),
    ...(match[4] ? { path: match[4] } : {}),
  };
}

const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

/** The chip's words: `queue.ts · L40–52`, or `Selected code` when the selection has no location. */
export function chatSelectionLabel(selection: ChatSelection, fallbackPath?: string): string {
  const path = selection.path ?? fallbackPath;
  const range = !selection.startLine
    ? ''
    : selection.endLine && selection.endLine !== selection.startLine
      ? `L${selection.startLine}–${selection.endLine}`
      : `L${selection.startLine}`;
  if (path) return range ? `${baseName(path)} · ${range}` : baseName(path);
  return range ? `Selected code · ${range}` : 'Selected code';
}

export function chatSelectionLineCount(selection: ChatSelection): number {
  return selection.code.split('\n').length;
}

/** Lines of diff rows, as a selection in a rendered diff reports them. */
export interface SelectedDiffLine {
  /** The row's own line number: the old line on a deleted row, the new line otherwise. */
  line: number;
  type: 'addition' | 'deletion' | 'context';
}

/**
 * Where a diff selection sits: the new side when it touches an added or unchanged row, the old side when it holds
 * only deleted rows. The range spans the selected rows of that side.
 */
export function diffSelectionRange(
  lines: SelectedDiffLine[]
): Pick<ChatSelection, 'side' | 'startLine' | 'endLine'> | undefined {
  const valid = lines.filter((l) => Number.isInteger(l.line) && l.line > 0);
  if (!valid.length) return undefined;
  const after = valid.filter((l) => l.type !== 'deletion');
  const side = after.length ? 'after' : 'before';
  const numbers = (after.length ? after : valid).map((l) => l.line);
  return { side, startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}
