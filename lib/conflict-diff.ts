import { diffArrays } from 'diff';
import {
  applyChoices,
  chosenText,
  conflictModel,
  editOpen,
  parseConflicts,
  pickText,
  textLines,
  type BlockEdits,
  type BlockPicks,
  type BlockProposals,
  type ConflictModel,
  type ConflictSegment,
} from './conflict-blocks';
import { writtenInEdit, type ConflictFile, type ConflictProposal } from './conflict-resolution';
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
    // Your edit shows as you wrote it, markers included: the draft holds that text.
    return choice === 'edit'
      ? pickText(segment, choice, proposals, model.edits)
      : choice === 'proposal' && proposal
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
    const edit = model.edits?.[index];
    // An edit with a conflict marker left in it is not a result yet: its card says Decide.
    const result =
      choice === 'edit'
        ? editOpen(edit)
          ? undefined
          : edit?.text
        : choice === 'proposal'
          ? proposal?.text
          : choice
            ? chosenText(block, choice)
            : undefined;
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
/**
 * A line as the rules compare it: its text with its line ending, so a resolver that turns CRLF into LF (or back) wrote
 * that line. A last line without a line ending compares as if it had an LF: Git's markers end every side with one.
 */
const lineKey = (line: string) => (line.endsWith('\n') ? line : `${line}\n`);
const keys = (text: string) => textLines(text).map(lineKey);
const tally = (lines: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/**
 * One conflict's result lines that neither side wrote, as 0-based indexes into `result`'s lines. The two sides' lines
 * are one multiset, compared exactly, line endings included (a re-indented line is a new line). A text the result has
 * more often than both sides together marks every one of its copies: which copy is new can't be told, so none is
 * trusted.
 */
export function writtenLines(result: string, ours: string, theirs: string): number[] {
  const sides = tally([...keys(ours), ...keys(theirs)]);
  const lines = keys(result);
  const counts = tally(lines);
  return lines.flatMap((line, i) => ((counts.get(line) ?? 0) > (sides.get(line) ?? 0) ? [i] : []));
}

/** A shared time limit for whole-file marks (writtenFileLines): a confirmation with many files spends it once. */
export interface WrittenBudget {
  /** Epoch milliseconds after which no line diff runs, and the cautious rule marks instead. */
  until: number;
}
/** A text as a short cache key: its length and a 32-bit FNV-1a hash. */
function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}
/** The longest one line diff may take, when no budget says less. */
const DIFF_MS = 150;
/** Whole-file marks by their four texts: a file's draft version is diffed once, however often it renders. */
const fileMarks = new Map<string, ReadonlySet<number>>();
const FILE_MARKS = 64;

/**
 * A whole file's lines that neither side wrote, as 1-based line numbers of `result`: the draft of a whole-file proposal,
 * a remembered resolution or a suggestion, whose conflicts can't be told apart. A line is a side's only where a line
 * diff against that side keeps it, so a line moved to where neither side had it is marked too.
 *
 * When a diff doesn't finish in time (or `budget` is spent), the cautious rule marks instead: every copy of a line the
 * result has more often than the side that has it most, never the two sides' sum.
 *
 * With `resolver`, the text the resolver wrote (ConflictFile.resolverText), only its lines can be marked: a line you
 * typed is yours, never Gnosis's, and a line you kept from a side is that side's.
 */
export function writtenFileLines(
  result: string,
  ours: string,
  theirs: string,
  resolver?: string,
  budget?: WrittenBudget
): ReadonlySet<number> {
  const key = [result, ours, theirs].map(textFingerprint).join('|') + (resolver === undefined ? '' : `|${textFingerprint(resolver)}`);
  const known = fileMarks.get(key);
  if (known) {
    fileMarks.delete(key);
    fileMarks.set(key, known);
    return known;
  }
  const lines = keys(result);
  let marked: number[] | undefined;
  // The budget ran out, rather than a diff timing out on its own within its usual time.
  let spent = false;
  const kept = new Set<number>();
  for (const side of [ours, theirs]) {
    const remaining = budget ? budget.until - Date.now() : DIFF_MS;
    const left = Math.min(DIFF_MS, remaining);
    const parts = left > 0 ? diffArrays(keys(side), lines, { timeout: left }) : undefined;
    if (!parts) {
      marked = cautiousLines(lines, ours, theirs);
      spent = remaining < DIFF_MS;
      break;
    }
    let at = 0;
    for (const part of parts) {
      if (part.removed) continue;
      if (!part.added) for (let i = 0; i < part.count; i++) kept.add(at + i);
      at += part.count;
    }
  }
  marked ??= lines.flatMap((_, i) => (kept.has(i) ? [] : [i]));
  const own = resolver === undefined ? undefined : new Set(keys(resolver));
  const set = new Set(marked.filter((i) => !own || own.has(lines[i])).map((i) => i + 1));
  // A cautious result because the shared budget ran out is not kept: with time, the next call diffs the file properly.
  // One whose diff timed out on its own is kept, so a render does not wait for that diff again.
  if (!spent) {
    fileMarks.set(key, set);
    if (fileMarks.size > FILE_MARKS) fileMarks.delete(fileMarks.keys().next().value as string);
  }
  return set;
}
/** Every copy of a line the result has more often than the side with most copies of it: no diff needed. */
function cautiousLines(lines: readonly string[], ours: string, theirs: string): number[] {
  const a = tally(keys(ours)),
    b = tally(keys(theirs));
  const counts = tally(lines);
  return lines.flatMap((line, i) =>
    (counts.get(line) ?? 0) > Math.max(a.get(line) ?? 0, b.get(line) ?? 0) ? [i] : []
  );
}

/**
 * Each proposal-filled conflict's written lines (writtenLines), by conflict index, as 0-based indexes into its
 * proposal's lines. A Keep, an open conflict or a proposal with no new line has no entry.
 */
export function conflictWritten(model: ConflictModel, proposals?: BlockProposals): Map<number, number[]> {
  const written = new Map<number, number[]>();
  for (const segment of model.segments) {
    if (segment.kind !== 'conflict') continue;
    // Your edit keeps only the marks of the resolver's lines you left as they were (keptMarks); a typed line has none.
    const edit = model.choices[segment.index] === 'edit' ? model.edits?.[segment.index] : undefined;
    // Only indexes inside the edit's own lines: one past it would mark a line after the conflict (#509).
    const kept = edit ? writtenInEdit(edit.text, edit.written) : [];
    if (kept.length) written.set(segment.index, kept);
    if (model.choices[segment.index] !== 'proposal') continue;
    const text = proposals?.[segment.index]?.text;
    if (text === undefined) continue;
    const lines = writtenLines(text, segment.block.ours, segment.block.theirs);
    if (lines.length) written.set(segment.index, lines);
  }
  return written;
}

/**
 * The marks an in-place edit keeps (#445 items 10 and 11): of `from`, the conflict's text you started from, its marked
 * lines (0-based) that a line diff keeps unchanged in `to`, as 0-based indexes into `to`. A line you typed or changed is
 * yours and never marked, even when it reads like one the resolver wrote. Without time for the diff, nothing is kept:
 * the edit is yours.
 */
export function keptMarks(from: string, marked: readonly number[], to: string): number[] {
  if (!marked.length) return [];
  const own = new Set(marked);
  const parts = diffArrays(textLines(from), textLines(to), { timeout: DIFF_MS });
  if (!parts) return [];
  const kept: number[] = [];
  let a = 0,
    b = 0;
  for (const part of parts) {
    if (part.added) b += part.count;
    else if (part.removed) a += part.count;
    else
      for (let i = 0; i < part.count; i++, a++, b++) {
        if (own.has(a)) kept.push(b);
      }
  }
  return kept;
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

/**
 * The text a resolver wrote for a file, the baseline its marks come from (#445 item 10): the resolver's whole draft
 * (`resolverText`, kept by the service), a whole-file proposal the draft still is, or else the file with every proposal
 * applied. Undefined when no resolver wrote anything for the file.
 */
export function resolverBaseline(
  file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile' | 'resolverText' | 'source'>,
  contents: string
): string | undefined {
  if (file.resolverText !== undefined) return file.resolverText;
  if (file.wholeFile && contents === file.wholeFile.text) return file.wholeFile.text;
  // A draft a resolver wrote before Gnosis kept its text (an older session): cautious, every line neither side had.
  if (!file.proposals?.some(Boolean)) return file.source === 'manual' ? undefined : contents;
  const segments = parseConflicts(file.original);
  // Choices are by conflict index, as the proposals are.
  const choices = file.proposals.map((proposal) => (proposal ? ('proposal' as const) : undefined));
  return applyChoices(segments, choices, file.proposals);
}

/**
 * The lines of a draft a resolver wrote, which neither side had (#445 item 10), as 1-based line numbers of `contents`,
 * the live draft. A draft that still derives from its conflicts marks each proposal's new lines (conflictWritten).
 * Otherwise (a whole-file result, a suggestion, a hand edit of either) the whole file is compared with both sides
 * (writtenFileLines), and only lines of `resolver` (resolverBaseline) count: one you typed is never Gnosis's.
 */
export function draftWritten(
  file: Pick<ConflictFile, 'original' | 'ours' | 'theirs' | 'proposals'>,
  contents: string,
  resolver: string | undefined,
  picks?: BlockPicks,
  budget?: WrittenBudget,
  /** Your in-place edits (#445 item 11): their typed lines are never marked. */
  edits?: BlockEdits
): ReadonlySet<number> {
  const model = conflictModel(file.original, contents, file.proposals, picks, edits);
  if (model.undoable) {
    const { blocks } = segmentsText(model.segments, (s) =>
      pickText(s, model.choices[s.index], file.proposals, model.edits)
    );
    return shownWritten(blocks, conflictWritten(model, file.proposals));
  }
  if (resolver === undefined) return new Set();
  const marked = writtenFileLines(contents, file.ours, file.theirs, resolver, budget);
  // A conflict the draft still has open (its markers and sides) is undecided: its card says Decide, not Gnosis wrote it.
  const open = segmentsText(model.segments, (s) => s.block.raw).blocks;
  if (!open.length) return marked;
  return new Set([...marked].filter((line) => !open.some((b) => line >= b.start && line <= b.end)));
}

/**
 * Whether `draft` still holds any line the resolver wrote that neither side had: while it does, the resolver's text
 * stays the file's baseline (a base move carrying the draft, a save); once it doesn't, the text is dropped, so a line you
 * type later is never taken for the resolver's.
 */
export function holdsResolverLines(resolver: string, ours: string, theirs: string, draft: string): boolean {
  const own = writtenLines(resolver, ours, theirs);
  if (!own.length) return false;
  const lines = keys(resolver);
  const present = new Set(keys(draft));
  return own.some((i) => lines[i].trim() !== '' && present.has(lines[i]));
}

/**
 * Who wrote a resolver's lines, for "written by …": structural merge, the model by name, one of Gnosis's rules, or you
 * in an earlier merge. The writer is what tells the reader how carefully to read. Unknown is "a resolver", never Gnosis.
 */
export function writerOf(source: string | undefined, by?: string) {
  switch (source) {
    case 'model':
    case 'agent':
      return by ?? 'the model';
    case 'mergiraf':
      return 'structural merge';
    case 'rerere':
      return 'you in an earlier merge';
    case 'union':
    case 'same':
    case 'layout':
    case 'moved':
      return 'Gnosis’s rule';
    default:
      return 'a resolver';
  }
}
/** Who wrote a proposal, for "written by …" and its labels. */
export const proposalWriter = (proposal: Pick<ConflictProposal, 'source' | 'by'>) => writerOf(proposal.source, proposal.by);
/** Who wrote a file's resolver text: its whole-file proposal's writer, else the file's source. */
export const fileWriter = (file: Pick<ConflictFile, 'wholeFile' | 'source'>) =>
  file.wholeFile ? proposalWriter(file.wholeFile) : writerOf(file.source);
/** "3 lines written by structural merge (neither side had them)". */
export const writtenLabel = (count: number, by = 'a resolver') =>
  `${count} ${count === 1 ? 'line' : 'lines'} written by ${by} (neither side had ${count === 1 ? 'it' : 'them'})`;

/** Line numbers as runs of consecutive lines, for pins: a marked line is never hidden in a gap. */
export function lineRuns(lines: ReadonlySet<number>): (readonly [number, number])[] {
  const runs: [number, number][] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}
