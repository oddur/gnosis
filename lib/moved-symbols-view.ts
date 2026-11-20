import type { GapPart } from './diff-gaps';
import type { MoveMark } from './moved-symbols-core';

/**
 * Where a diff shows a moved symbol's note (#398, ChangesDiff): under the line right above the symbol on its side, so
 * it reads as the symbol's heading, or under the symbol's first line when the row above is another side's (a deleted
 * block right above an added symbol, in a unified diff: the note would sit over unrelated lines) or not shown. A
 * symbol whose first line is not shown has no note. Lines are on the mark's side.
 */
export function moveNoteLines(parts: readonly GapPart[], marks: readonly MoveMark[]): Map<MoveMark, number> {
  // Each line's row, in the order a unified diff shows rows, on each side. Hunks are apart: a row never follows a gap.
  const rowOf = { after: new Map<number, number>(), before: new Map<number, number>() };
  let index = 0;
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    let oldLine = part.hunk.oldStart,
      newLine = part.hunk.newStart;
    for (const row of part.hunk.rows) {
      if (row.type !== '+') rowOf.before.set(oldLine++, index);
      if (row.type !== '-') rowOf.after.set(newLine++, index);
      index++;
    }
    index++;
  }
  const result = new Map<MoveMark, number>();
  for (const mark of marks) {
    const own = rowOf[mark.side];
    const at = own.get(mark.start);
    if (at === undefined) continue;
    result.set(mark, own.get(mark.start - 1) === at - 1 ? mark.start - 1 : mark.start);
  }
  return result;
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
