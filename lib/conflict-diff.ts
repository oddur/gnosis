import { diffArrays } from 'diff';
import { chosenText, textLines, type BlockProposals, type ConflictModel, type ConflictSegment } from './conflict-blocks';
import type { GapHunk } from './diff-gaps';

/** A text's lines; a final line feed ends the last line rather than starting another. */
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

/** One conflict's place in the shown text: its lines, and the line its card sits under. */
export interface ConflictDiffBlock {
  index: number;
  /** First and last new line; `end < start` when the conflict shows no lines. */
  start: number;
  end: number;
  /** The new line the conflict's card follows; undefined when the text has no lines. */
  anchor?: number;
}

/**
 * What the Conflicts view compares the result with (#445 item 9). `pr`: the PR's version, what the author sees change
 * on their branch. `main`: the base branch's version, what the PR still changes after the merge. `both`: each
 * conflict's two sides with its result under them.
 */
export type CompareWith = 'pr' | 'main' | 'both';
export const COMPARE_MODES: readonly CompareWith[] = ['pr', 'main', 'both'];
export const isCompareWith = (value: unknown): value is CompareWith =>
  value === 'pr' || value === 'main' || value === 'both';

/**
 * A file's conflicts as the Conflicts view's diff shows them (#445 items 8 and 9), against the PR's version of the file
 * (`against` 'ours') or the base branch's ('theirs'). A decided or proposed conflict shows its result. An open conflict
 * shows the other side's lines in place of the compared side's, so the diff reads as its two sides, never as no change:
 * that is never the result, and its card says Decide.
 */
export function conflictDiffText(
  model: ConflictModel,
  proposals?: BlockProposals,
  against: 'ours' | 'theirs' = 'ours'
): { after: string; blocks: ConflictDiffBlock[] } {
  return segmentsText(model.segments, (segment) => {
    const choice = model.choices[segment.index];
    const proposal = proposals?.[segment.index];
    return choice === 'proposal' && proposal
      ? proposal.text
      : choice && choice !== 'proposal'
        ? chosenText(segment.block, choice)
        : against === 'ours'
          ? segment.block.theirs
          : segment.block.ours;
  });
}

/**
 * A file built from its segments, each conflict as `text(conflict)`, with the lines of the conflicts `track` keeps
 * (all by default). The Conflicts view's diff and the push confirmation's groups (lib/conflict-confirm.ts) use it.
 */
export function segmentsText(
  segments: readonly ConflictSegment[],
  text: (segment: Extract<ConflictSegment, { kind: 'conflict' }>) => string,
  track: (index: number) => boolean = () => true
): { after: string; blocks: ConflictDiffBlock[] } {
  let after = '';
  let line = 0;
  const blocks: ConflictDiffBlock[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') {
      after += segment.text;
      line += lineCount(segment.text);
      continue;
    }
    const part = text(segment);
    const start = line + 1;
    after += part;
    line += lineCount(part);
    if (track(segment.index)) blocks.push({ index: segment.index, start, end: line });
  }
  // A conflict that shows no lines sits under the line before it, or under the first line at the top of the file.
  for (const block of blocks)
    block.anchor = block.end >= block.start ? block.end : block.start > 1 ? block.start - 1 : line ? 1 : undefined;
  return { after, blocks };
}

/** Where a conflict's card sits in the diff: under a new line, or under an old one. */
export interface CardAnchor {
  index: number;
  side: 'additions' | 'deletions';
  line: number;
}
/**
 * Each conflict's card place (#445 items 8 and 9): under its last shown line. A conflict that shows no lines sits under
 * the last of the compared version's lines it removes (the PR's, or main's), so the card stays with the lines it
 * decides, at the top of a file too. Only when it removes none either does it sit under the line before it.
 */
export function cardAnchors(blocks: readonly ConflictDiffBlock[], hunks: readonly GapHunk[]): CardAnchor[] {
  return blocks.flatMap((block): CardAnchor[] => {
    if (block.end >= block.start) return [{ index: block.index, side: 'additions', line: block.end }];
    let removed: number | undefined;
    for (const hunk of hunks) {
      let oldLine = hunk.oldStart,
        newLine = hunk.newStart;
      for (const row of hunk.rows) {
        if (row.type === '-' && newLine === block.start) removed = Math.max(removed ?? 0, oldLine);
        if (row.type !== '+') oldLine++;
        if (row.type !== '-') newLine++;
      }
    }
    if (removed !== undefined) return [{ index: block.index, side: 'deletions', line: removed }];
    return block.anchor === undefined ? [] : [{ index: block.index, side: 'additions', line: block.anchor }];
  });
}

/** One conflict in the "both" comparison: its two sides, the ancestor they changed, and its result. */
export interface ConflictCompareRows {
  index: number;
  /** The common ancestor's lines; empty when Git wrote none. */
  base: string;
  ours: string;
  theirs: string;
  /** The conflict's lines in the draft; undefined while nothing is chosen, so no row can pass for the result. */
  result?: string;
}
/**
 * Each conflict's rows for Compare with: both (#445 item 9): the PR's side, main's side and the result, each against
 * the ancestor. A conflict whose card is open (Decide) has no result row: its card says nothing is chosen.
 */
export function conflictCompareRows(model: ConflictModel, proposals?: BlockProposals): ConflictCompareRows[] {
  return model.segments.flatMap((segment): ConflictCompareRows[] => {
    if (segment.kind !== 'conflict') return [];
    const { block, index } = segment;
    const choice = model.choices[index];
    const proposal = proposals?.[index];
    const result = choice === 'proposal' ? proposal?.text : choice ? chosenText(block, choice) : undefined;
    const rows: ConflictCompareRows = { index, base: block.base ?? '', ours: block.ours, theirs: block.theirs };
    if (result !== undefined) rows.result = result;
    return [rows];
  });
}

/**
 * The context lines for a Compare with: both row (#445 item 9): as many as its longer version has, so the row's diff is
 * one hunk with every line of both versions. Pins can't do this: a pin that overlaps a hunk is dropped, and the row
 * cannot expand, so the unchanged lines between two changes would be hidden.
 */
export function compareRowContext(before: string, after: string): number {
  return Math.max(lineCount(before), lineCount(after), 1);
}

/**
 * The pins for a Compare with: both row whose diff has no hunks (#445 item 9): the version equals the ancestor, or the
 * diff could not be parsed. Every line is pinned as unchanged context, so the row still shows its lines.
 */
export function compareRowPins(hunks: readonly GapHunk[], after: string): (readonly [number, number])[] {
  const count = lineCount(after);
  return hunks.length || !count ? [] : [[1, count]];
}

/*
 * The lines a resolver wrote (#445 item 10): Mergiraf, a union, the same-change or move rules, a remembered resolution
 * or a suggestion. Each is a line of the result that neither side had, so the reader knows which lines to read most
 * carefully. When in doubt a line is marked: the mark never hides anything, and an unmarked line must be a side's.
 */
const lineText = (line: string) => line.replace(/\r?\n$/, '');
const tally = (lines: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/**
 * One conflict's result lines that neither side wrote, as 0-based indexes into `result`'s lines. The two sides' lines
 * are one multiset, compared exactly (a re-indented line is a new line). A text the result has more often than both
 * sides together marks every one of its copies: which copy is new can't be told, so none is trusted.
 */
export function writtenLines(result: string, ours: string, theirs: string): number[] {
  const sides = tally([...textLines(ours), ...textLines(theirs)].map(lineText));
  const lines = textLines(result).map(lineText);
  const counts = tally(lines);
  return lines.flatMap((line, i) => ((counts.get(line) ?? 0) > (sides.get(line) ?? 0) ? [i] : []));
}

/**
 * A whole file's lines that neither side wrote (a whole-file proposal, or a remembered resolution or suggestion whose
 * conflicts can't be told apart), as 1-based line numbers of `result`. A line is a side's only where a line diff
 * against that side keeps it, so a line moved to where neither side had it is marked too. A diff that runs out of time
 * falls back to the multiset rule over the whole files.
 */
export function writtenFileLines(result: string, ours: string, theirs: string): Set<number> {
  const lines = textLines(result).map(lineText);
  const kept = new Set<number>();
  for (const side of [ours, theirs]) {
    const parts = diffArrays(textLines(side).map(lineText), lines, { timeout: 500 });
    if (!parts) return new Set(writtenLines(result, ours, theirs).map((i) => i + 1));
    let at = 0;
    for (const part of parts) {
      if (part.removed) continue;
      if (!part.added) for (let i = 0; i < part.count; i++) kept.add(at + i);
      at += part.count;
    }
  }
  return new Set(lines.flatMap((_, i) => (kept.has(i) ? [] : [i + 1])));
}

/**
 * Each proposal-filled conflict's written lines (writtenLines), by conflict index, as 0-based indexes into its
 * proposal's lines. A Keep, an open conflict or a proposal with no new line has no entry.
 */
export function conflictWritten(model: ConflictModel, proposals?: BlockProposals): Map<number, number[]> {
  const written = new Map<number, number[]>();
  for (const segment of model.segments) {
    if (segment.kind !== 'conflict' || model.choices[segment.index] !== 'proposal') continue;
    const text = proposals?.[segment.index]?.text;
    if (text === undefined) continue;
    const lines = writtenLines(text, segment.block.ours, segment.block.theirs);
    if (lines.length) written.set(segment.index, lines);
  }
  return written;
}

/** The shown text's line numbers of each conflict's written lines (conflictWritten), from its place in the text. */
export function shownWritten(
  blocks: readonly ConflictDiffBlock[],
  written: ReadonlyMap<number, readonly number[]>
): Set<number> {
  const lines = new Set<number>();
  for (const block of blocks) for (const i of written.get(block.index) ?? []) lines.add(block.start + i);
  return lines;
}

/** "3 lines written by Gnosis (neither side had them)". */
export const writtenLabel = (count: number) =>
  `${count} ${count === 1 ? 'line' : 'lines'} written by Gnosis (neither side had ${count === 1 ? 'it' : 'them'})`;
