import type { GapPart } from './diff-gaps';
import type { MoveMark } from './moved-symbols-core';

/** Where a move's note goes: under a line of the diff, or at the top of a hunk, above its first row. */
export type MoveNoteAt = { side: MoveMark['side']; line: number } | { hunk: string };

/**
 * Where a diff shows a moved symbol's note (#398, ChangesDiff): right above the symbol, so it reads as its heading.
 * Notes sit under a line, so the note goes under the row the diff shows right before the symbol's first line: in a
 * unified diff, that row on either side (a deleted block right above an added symbol), and in a split diff, the row
 * before it on its own side. With no such row in its hunk, the note heads the hunk (`{ hunk }`). A symbol whose first
 * line is not shown has no note.
 */
export function moveNoteLines(
  parts: readonly GapPart[],
  marks: readonly MoveMark[],
  split = false
): Map<MoveMark, MoveNoteAt> {
  // Each line's row, in the order a unified diff shows rows, on each side; each row's hunk, and its side and line.
  const rowOf = { after: new Map<number, number>(), before: new Map<number, number>() };
  const rows: { hunk: string; side?: MoveMark['side']; line: number }[] = [];
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const row of part.hunk.rows) {
      if (row.type !== '+') rowOf.before.set(oldLine, rows.length);
      if (row.type !== '-') rowOf.after.set(newLine, rows.length);
      // A context row is on both sides: a note under it is on the mark's.
      if (row.type === '-') rows.push({ hunk: part.key, side: 'before', line: oldLine });
      else rows.push({ hunk: part.key, side: row.type === '+' ? 'after' : undefined, line: newLine });
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  }
  const result = new Map<MoveMark, MoveNoteAt>();
  for (const mark of marks) {
    const own = rowOf[mark.side];
    const at = own.get(mark.start);
    if (at === undefined) continue;
    const { hunk } = rows[at];
    const before = split ? own.get(mark.start - 1) : at - 1;
    const above = before === undefined ? undefined : rows[before];
    if (above?.hunk !== hunk) result.set(mark, { hunk });
    else result.set(mark, { side: above.side ?? mark.side, line: above.side ? above.line : mark.start - 1 });
  }
  return result;
}

/**
 * A move's verb and place, for its note: "Moved from src/a.ts:12" for another file's, and within the file, which way
 * it went, by line number on either side: "Moved up from line 22", "Moved down to line 40".
 */
export function moveWords(mark: Pick<MoveMark, 'side' | 'start' | 'sameFile' | 'other'>): {
  verb: string;
  place: string;
} {
  const into = mark.side === 'after';
  const { other } = mark;
  if (!mark.sameFile) return { verb: into ? 'Moved from' : 'Moved to', place: `${other.path}:${other.start}` };
  const up = into ? mark.start < other.start : other.start < mark.start;
  return { verb: `Moved ${up ? 'up' : 'down'} ${into ? 'from' : 'to'}`, place: `line ${other.start}` };
}

/**
 * The lines a diff dims as carried over by a move, by side and line (`a12`, `b9`): only lines the body diff matched to
 * the other end. A comment or blank line, which the diff of code lines cannot vouch for, keeps its change colour.
 */
export function movedLineKeys(marks: readonly MoveMark[]): Set<string> {
  const result = new Set<string>();
  for (const mark of marks)
    for (const line of mark.edits?.kept ?? []) result.add(`${mark.side === 'after' ? 'a' : 'b'}${line}`);
  return result;
}

const lines = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`;
/**
 * How much of a moved symbol changed, in words, for its note. An exact match has the same code tokens, the name aside:
 * a rename's differing lines are where the name is ("body unchanged"), other differing lines only break or join lines
 * ("reformatted"). Comments are compared on their own ("comments edited"). Bodies too long to diff line by line are
 * not counted ("too large to compare"); an exact one still says so by its tokens.
 */
export function moveEditsLabel(mark: Pick<MoveMark, 'exact' | 'renamed' | 'commentsChanged' | 'edits'>): string {
  if (mark.exact) {
    if (mark.commentsChanged) return 'comments edited';
    if (mark.renamed) return 'body unchanged';
    return mark.edits?.changed.length ? 'reformatted' : 'unchanged';
  }
  if (!mark.edits) return 'too large to compare';
  return `${lines(mark.edits.changed.length)} edited${mark.commentsChanged ? ', comments too' : ''}`;
}
