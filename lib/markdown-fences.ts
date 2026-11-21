/**
 * Fenced code in chat Markdown, found the one way chat's rewrites need it (lib/chat-diffs.ts turns some fences into
 * islands; lib/chat-citations.ts must never touch text inside one). A fence opens with three or more backticks or
 * tildes, indented up to three spaces, or further when it sits in a list item: a line above it, at a smaller indent,
 * starts the item (`- `, `* `, `+ `, `1. `, `1) `). It closes at the same character, at least as long, indented no
 * more than three spaces past the opener. A fence still open when the text ends runs to the end. No React imports.
 */
export interface MarkdownFence {
  /** Line index of the opening fence. */
  start: number;
  /** Line index of the closing fence, or the number of lines when the fence is still open. */
  end: number;
  closed: boolean;
  /** The opener's leading spaces. */
  indent: string;
  marker: string;
  /** The first word after the marker, such as `diff` or `ts`. */
  info: string;
}

const OPENER = /^( *)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;

const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

/** Whether a line indented `indent` spaces is content of a list item above it. */
function inListItem(lines: readonly string[], index: number, indent: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) >= indent) continue;
    const item = LIST_ITEM.exec(line);
    // The item's content starts after its marker; the fence must be indented at least that far, and at most three more.
    return !!item && indent >= item[1].length + item[2].length + 1 && indent <= item[0].length + 3;
  }
  return false;
}

export function findFences(lines: readonly string[]): MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPENER.exec(lines[i]);
    if (!open) continue;
    const [, indent, marker, info] = open;
    if (indent.length > 3 && !inListItem(lines, i, indent.length)) continue;
    const close = new RegExp(`^ {0,${indent.length + 3}}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    fences.push({ start: i, end, closed: end < lines.length, indent, marker, info });
    i = end;
  }
  return fences;
}
