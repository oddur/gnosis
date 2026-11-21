import type { GapHunk, GapPart } from './diff-gaps';
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
  const result = new Map<MoveMark, MoveNoteAt>();
  for (const mark of marks)
    for (const part of parts) {
      const at = part.kind === 'hunk' ? noteAt(part.key, part.hunk, mark, split) : undefined;
      if (at) {
        result.set(mark, at);
        break;
      }
    }
  return result;
}

/** Where a mark's note goes in one hunk, if its first line is there. */
function noteAt(key: string, hunk: GapHunk, mark: MoveMark, split: boolean): MoveNoteAt | undefined {
  const after = mark.side === 'after';
  let oldLine = hunk.oldStart,
    newLine = hunk.newStart;
  // The row before, as the diff shows it: its type and lines; and whether a row before was on the mark's side.
  let previous: string | undefined,
    previousOld = 0,
    previousNew = 0,
    ownBefore = false;
  for (const row of hunk.rows) {
    const own = after ? row.type !== '-' : row.type !== '+';
    if (own && (after ? newLine : oldLine) === mark.start) {
      // A side's lines are consecutive in a hunk: a row on the mark's side before it is its line before.
      if (split || previous === ' ') return ownBefore ? { side: mark.side, line: mark.start - 1 } : { hunk: key };
      if (previous === undefined) return { hunk: key };
      return previous === '-' ? { side: 'before', line: previousOld } : { side: 'after', line: previousNew };
    }
    ownBefore ||= own;
    previous = row.type;
    previousOld = oldLine;
    previousNew = newLine;
    if (row.type !== '+') oldLine++;
    if (row.type !== '-') newLine++;
  }
  return undefined;
}

/** Where an old line sits among the new lines: its new line if kept, else the line that took its place. */
function newSlot(parts: readonly GapPart[], line: number): number {
  let offset = 0;
  for (const part of parts) {
    if (part.kind !== 'hunk') continue;
    const { oldStart, newStart, rows } = part.hunk;
    if (line < oldStart) return line + newStart - oldStart;
    let oldLine = oldStart,
      newLine = newStart;
    for (const row of rows) {
      if (row.type !== '+' && oldLine++ === line) return newLine;
      if (row.type !== '-') newLine++;
    }
    offset = newLine - oldLine;
  }
  return line + offset;
}

/**
 * A move's words, for its note: "Moved from src/a.ts:12" for another file's, and within the file, which way it went:
 * "Moved up from line 22", "Moved down to line 40". The way is by order in the new file, the old line placed among
 * the new ones through the diff's hunks, so lines added or removed above either end do not turn it around. `where`
 * says the place for a screen reader.
 */
export function moveWords(
  mark: Pick<MoveMark, 'side' | 'start' | 'sameFile' | 'other'>,
  parts: readonly GapPart[]
): { verb: string; place: string; where: string } {
  const into = mark.side === 'after';
  const { other } = mark;
  if (!mark.sameFile)
    return {
      verb: into ? 'Moved from' : 'Moved to',
      place: `${other.path}:${other.start}`,
      where: `${other.path}, line ${other.start}`,
    };
  const at = (end: { side: MoveMark['side']; start: number }) =>
    end.side === 'after' ? end.start : newSlot(parts, end.start);
  const [from, to] = into ? [at(other), at(mark)] : [at(mark), at(other)];
  const way = to < from ? 'up ' : to > from ? 'down ' : '';
  return {
    verb: `Moved ${way}${into ? 'from' : 'to'}`,
    place: `line ${other.start}`,
    where: `line ${other.start} of this file${other.side === 'before' ? ', old side' : ''}`,
  };
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
