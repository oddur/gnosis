import { hasConflictMarkers } from './conflict-resolution';

/**
 * Conflict blocks in Gnosis's own words. Git writes `<<<<<<<`, `|||||||`, `=======` and `>>>>>>>`
 * markers with branch names or commit IDs; the workspace reads them here and never shows them as
 * labels. Pure functions, shared by the conflict view, the restack view and their tests.
 */
export interface ConflictBlock {
  /** The PR side (Git's "current" side in a merge into the PR branch). */
  ours: string;
  /** The common ancestor, when Git wrote one (diff3 style). */
  base?: string;
  /** The other side (the base branch in a merge; the PR commit in a restack). */
  theirs: string;
  /** The complete marker block, exactly as it appears in the file. */
  raw: string;
  /** First line of the block in the file it was parsed from, 1-based. */
  line: number;
}
export type ConflictSegment =
  | { kind: 'text'; text: string }
  | { kind: 'conflict'; index: number; block: ConflictBlock };
export type BlockChoice = 'ours' | 'theirs' | 'both';
/** A block's state in a draft: one side, both, or the proposal preparation made for it. */
export type BlockPick = BlockChoice | 'proposal';
/** Proposal texts by block index, as `ConflictFile.proposals` holds them. */
export type BlockProposals = readonly ({ text: string } | null | undefined)[];
/**
 * A conflict you edited in place (#445 item 11): the text you saved for it, and what it replaced, so Undo restores that
 * choice. An edit is yours: it clears your pick for the conflict, and only the resolver's lines you left as they were
 * keep their mark (`written`, 0-based indexes into `text`; #445 item 10).
 */
export interface BlockEdit {
  text: string;
  /** The conflict's state before your first edit of it: Undo returns to it. */
  before: BlockPick | undefined;
  /** Your pick before the edit, restored with `before`. */
  pick: BlockPick | undefined;
  written?: readonly number[];
}
/** Your in-place edits by block index. They are kept while the view is open; the draft itself is what is saved. */
export type BlockEdits = readonly (BlockEdit | undefined)[];
/** A block's state in the view: a pick, or your edit of it. */
export type ModelChoice = BlockPick | 'edit';

/** A text's lines, each with its line break. */
export const textLines = (text: string) => text.split(/(?<=\n)/).filter(Boolean);
/** Every use of the identifier `name` in a text: not part of a longer identifier (letters, digits, `_` or `$`). */
export const identifierPattern = (name: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_$])`, 'gu');

const marker = (line: string, char: string) => new RegExp(`^\\${char}{7}(?:[ \\t].*)?\\r?\\n?$`).test(line);

/** Split a file into unchanged text and conflict blocks. An unfinished block stays text. */
export function parseConflicts(text: string): ConflictSegment[] {
  const lines = text.split(/(?<=\n)/);
  const segments: ConflictSegment[] = [];
  let plain = '';
  let index = 0;
  let lineNumber = 1;
  for (let i = 0; i < lines.length; i++) {
    if (!marker(lines[i], '<')) {
      plain += lines[i];
      continue;
    }
    // Find the complete block before committing to it.
    let part: 'ours' | 'base' | 'theirs' = 'ours';
    const parts = { ours: '', base: '', theirs: '' };
    let hasBase = false;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (part === 'ours' && marker(line, '|')) {
        part = 'base';
        hasBase = true;
      } else if ((part === 'ours' || part === 'base') && marker(line, '=')) part = 'theirs';
      else if (part === 'theirs' && marker(line, '>')) {
        end = j;
        break;
      } else if (marker(line, '<')) break;
      else parts[part] += line;
    }
    if (end < 0) {
      plain += lines[i];
      continue;
    }
    if (plain) segments.push({ kind: 'text', text: plain });
    lineNumber += countLines(plain);
    plain = '';
    const raw = lines.slice(i, end + 1).join('');
    segments.push({
      kind: 'conflict',
      index: index++,
      block: {
        ours: parts.ours,
        theirs: parts.theirs,
        ...(hasBase ? { base: parts.base } : {}),
        raw,
        line: lineNumber,
      },
    });
    lineNumber += end - i + 1;
    i = end;
  }
  if (plain) segments.push({ kind: 'text', text: plain });
  return segments;
}
function countLines(text: string) {
  let count = 0;
  for (const char of text) if (char === '\n') count++;
  return count;
}
export function conflictCount(text: string) {
  return parseConflicts(text).filter((segment) => segment.kind === 'conflict').length;
}

/** "Keep both" puts the PR block first, as Git and the previous editor did. */
export function chosenText(block: ConflictBlock, choice: BlockChoice) {
  if (choice === 'ours') return block.ours;
  if (choice === 'theirs') return block.theirs;
  const first = block.ours && !block.ours.endsWith('\n') && block.theirs ? `${block.ours}\n` : block.ours;
  return first + block.theirs;
}

export const pickText = (
  segment: Extract<ConflictSegment, { kind: 'conflict' }>,
  pick: ModelChoice | undefined,
  proposals?: BlockProposals,
  edits?: BlockEdits
) =>
  pick === 'edit'
    ? (edits?.[segment.index]?.text ?? segment.block.raw)
    : pick === 'proposal'
      ? (proposals?.[segment.index]?.text ?? segment.block.raw)
      : pick
        ? chosenText(segment.block, pick)
        : segment.block.raw;

/** The file text for a set of choices; an open block keeps its markers. */
export function applyChoices(
  segments: readonly ConflictSegment[],
  choices: readonly (ModelChoice | undefined)[],
  proposals?: BlockProposals,
  edits?: BlockEdits
) {
  return segments
    .map((segment) =>
      segment.kind === 'text' ? segment.text : pickText(segment, choices[segment.index], proposals, edits)
    )
    .join('');
}

/**
 * Recover per-block choices from a saved draft, so Undo survives switching files and reopening.
 * Returns undefined when the draft was edited by hand or by a suggestion; the view then works on
 * the draft's own remaining markers.
 */
export function inferChoices(
  segments: ConflictSegment[],
  contents: string,
  proposals?: BlockProposals
): (BlockPick | undefined)[] | undefined {
  return inferModelChoices(segments, contents, proposals) as (BlockPick | undefined)[] | undefined;
}
/**
 * inferChoices, with your in-place edits as one more option per block (#445 item 11). An edit comes before the
 * proposal and the sides: text you saved for a conflict is yours, even when it equals one of them.
 */
export function inferModelChoices(
  segments: readonly ConflictSegment[],
  contents: string,
  proposals?: BlockProposals,
  edits?: BlockEdits
): (ModelChoice | undefined)[] | undefined {
  // Options with the same text are one option: the proposal comes first, so one that equals a side is still the
  // proposal that was checked.
  const options = (segment: Extract<ConflictSegment, { kind: 'conflict' }>) => {
    const seen = new Set<string>();
    return (
      [
        undefined,
        ...(edits?.[segment.index] ? ['edit' as const] : []),
        ...(proposals?.[segment.index] ? ['proposal' as const] : []),
        'ours',
        'theirs',
        'both',
      ] as const
    )
      .map((choice) => ({ choice, text: pickText(segment, choice, proposals, edits) }))
      .filter(({ text }) => {
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
      });
  };
  // How many ways the draft splits into the segments, up to 2. Only one way may count: when two splits give a block
  // different text, neither can be trusted, and the draft is treated as edited by hand.
  const memo = new Map<string, number>();
  const ways = (i: number, at: number): number => {
    if (i === segments.length) return at === contents.length ? 1 : 0;
    const key = `${i}:${at}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const segment = segments[i];
    let n = 0;
    if (segment.kind === 'text') n = contents.startsWith(segment.text, at) ? ways(i + 1, at + segment.text.length) : 0;
    else
      for (const { text } of options(segment)) {
        if (contents.startsWith(text, at)) n += ways(i + 1, at + text.length);
        if (n >= 2) break;
      }
    memo.set(key, Math.min(n, 2));
    return Math.min(n, 2);
  };
  if (ways(0, 0) !== 1) return undefined;
  const choices: (ModelChoice | undefined)[] = [];
  let at = 0;
  segments.forEach((segment, i) => {
    if (segment.kind === 'text') {
      at += segment.text.length;
      return;
    }
    const found = options(segment).find(
      ({ text }) => contents.startsWith(text, at) && ways(i + 1, at + text.length) === 1
    );
    choices[segment.index] = found?.choice;
    at += found?.text.length ?? 0;
  });
  return choices;
}

/**
 * The choices you made in this view, by block index: a Keep, or `proposal` when you chose Use the proposal after
 * choosing something else. Undefined: none; an untouched proposal is never a pick.
 */
export type BlockPicks = readonly (BlockPick | undefined)[];
/**
 * A choice you made is yours, whatever was proposed. The draft alone can't tell "Keep PR change" from a proposal with
 * the same text, or "Keep both" from one side when the other is empty, so a block takes your pick wherever the pick
 * gives the text the draft reads as.
 */
export function withPicks<C extends ModelChoice>(
  segments: readonly ConflictSegment[],
  choices: (C | undefined)[],
  proposals?: BlockProposals,
  picks?: BlockPicks
): (C | BlockPick | undefined)[] {
  if (!picks?.some(Boolean)) return choices;
  const next: (C | BlockPick | undefined)[] = [...choices];
  for (const segment of segments) {
    if (segment.kind !== 'conflict') continue;
    const pick = picks[segment.index];
    const read = next[segment.index];
    // Your edit is yours already: a pick left from before it never stands in for it.
    if (pick && read && read !== 'edit' && pickText(segment, pick, proposals) === pickText(segment, read, proposals))
      next[segment.index] = pick;
  }
  return next;
}

export interface ConflictModel {
  /** The text the blocks come from: the original conflict when Undo is available, else the draft. */
  source: string;
  segments: ConflictSegment[];
  choices: (ModelChoice | undefined)[];
  /** False when the draft no longer derives from the original blocks, so earlier choices cannot be undone. */
  undoable: boolean;
  /** Your in-place edits the choices read, by block index (#445 item 11). */
  edits?: BlockEdits;
}
/** Blocks for the displayed draft, with Undo whenever the draft still derives from the original conflict. */
export function conflictModel(
  original: string,
  contents: string,
  proposals?: BlockProposals,
  picks?: BlockPicks,
  edits?: BlockEdits
): ConflictModel {
  const segments = parseConflicts(original);
  const choices = segments.some((s) => s.kind === 'conflict')
    ? inferModelChoices(segments, contents, proposals, edits)
    : undefined;
  if (choices)
    return {
      source: original,
      segments,
      choices: withPicks(segments, choices, proposals, picks),
      undoable: true,
      ...(edits?.some(Boolean) ? { edits } : {}),
    };
  const own = parseConflicts(contents);
  return { source: contents, segments: own, choices: [], undoable: false };
}

/** An edit that still holds a conflict marker: its conflict stays open, in Decide (#445 item 11). */
export const editOpen = (edit: BlockEdit | undefined) => !!edit && hasConflictMarkers(edit.text);

/** Where conflict `index` sits in the draft, as character offsets: its text is `contents.slice(start, end)`. */
export interface ConflictSpan {
  index: number;
  start: number;
  end: number;
}
/**
 * Conflict `index`'s span in `contents` (#445 item 11). Only for a draft that is exactly its choices: the text before
 * and after the conflict must be what the model says it is, byte for byte. Undefined otherwise, and then nothing may be
 * edited in place.
 */
export function conflictSpan(
  model: ConflictModel,
  contents: string,
  index: number,
  proposals?: BlockProposals
): ConflictSpan | undefined {
  if (!model.undoable) return undefined;
  const at = model.segments.findIndex((s) => s.kind === 'conflict' && s.index === index);
  const segment = model.segments.at(at);
  if (at < 0 || segment?.kind !== 'conflict') return undefined;
  const before = applyChoices(model.segments.slice(0, at), model.choices, proposals, model.edits);
  const text = pickText(segment, model.choices[index], proposals, model.edits);
  const after = applyChoices(model.segments.slice(at + 1), model.choices, proposals, model.edits);
  if (contents !== before + text + after) return undefined;
  return { index, start: before.length, end: before.length + text.length };
}
/** Whether `next` differs from `contents` only inside `span`: everything before and after it is unchanged. */
export function onlyInSpan(contents: string, next: string, span: ConflictSpan): boolean {
  const tail = contents.length - span.end;
  return (
    span.start >= 0 &&
    span.start <= span.end &&
    span.end <= contents.length &&
    next.length >= span.start + tail &&
    next.slice(0, span.start) === contents.slice(0, span.start) &&
    next.slice(next.length - tail) === contents.slice(span.end)
  );
}

/**
 * Your text for one conflict as the draft writes it: the file's line endings, and a final line break where the
 * conflict's text had one, so the line after the conflict never joins your last line.
 */
export function editText(block: ConflictBlock, current: string, typed: string): string {
  const eol = /\r\n/.test(block.ours + block.theirs + current) ? '\r\n' : '\n';
  const text = typed.replace(/\r?\n/g, eol);
  return text && current.endsWith('\n') && !text.endsWith('\n') ? text + eol : text;
}

/**
 * The draft with conflict `index` as your `typed` text, and nothing else changed (#445 item 11). Refused (undefined)
 * when the draft isn't exactly its choices, when the new draft would differ outside the conflict, or when its
 * conflicts could no longer be told apart afterwards: every other conflict keeps its choice and its Undo.
 */
export function editConflict(
  model: ConflictModel,
  contents: string,
  index: number,
  typed: string,
  proposals?: BlockProposals,
  picks?: BlockPicks
): { contents: string; edits: (BlockEdit | undefined)[]; edit: BlockEdit } | undefined {
  const span = conflictSpan(model, contents, index, proposals);
  const segment = model.segments.find((s) => s.kind === 'conflict' && s.index === index);
  if (!span || segment?.kind !== 'conflict') return undefined;
  const text = editText(segment.block, contents.slice(span.start, span.end), typed);
  const next = contents.slice(0, span.start) + text + contents.slice(span.end);
  if (!onlyInSpan(contents, next, span)) return undefined;
  const choice = model.choices[index];
  const previous = choice === 'edit' ? model.edits?.[index] : undefined;
  // Only the edits the draft still reads are kept.
  const edits: (BlockEdit | undefined)[] = [];
  for (const s of model.segments)
    if (s.kind === 'conflict' && model.choices[s.index] === 'edit') edits[s.index] = model.edits?.[s.index];
  // A second edit of the same conflict keeps what the first one replaced: Undo goes back past both.
  const edit: BlockEdit = {
    text,
    before: previous ? previous.before : (choice as BlockPick | undefined),
    pick: previous ? previous.pick : picks?.[index],
  };
  edits[index] = edit;
  const nextPicks = picks ? [...picks] : [];
  nextPicks[index] = undefined;
  const after = conflictModel(model.source, next, proposals, nextPicks, edits);
  // Every other conflict must read as it did, and this one as your edit (or open again, for Git's own text).
  const reads = (s: ConflictSegment) =>
    s.kind !== 'conflict' ||
    after.choices[s.index] ===
      (s.index === index ? (text === s.block.raw ? undefined : 'edit') : model.choices[s.index]);
  if (!after.undoable || !after.segments.every(reads)) return undefined;
  return { contents: next, edits, edit };
}

/** Middle-truncate long branch names for buttons; the full name stays in titles and badges. */
export function shortBranch(name: string, max = 24) {
  if (name.length <= max) return name;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - (keep - head))}`;
}

export interface ConflictLabels {
  /** Column heading for the PR side, such as "This PR · feature/retry". */
  ours: string;
  theirs: string;
  base: string;
  keep: Record<BlockChoice, string>;
  kept: Record<BlockChoice, string>;
}
/**
 * Labels for both kinds of conflict. A merge brings the base branch into the PR; a restack replays
 * a dependent PR's commit onto its updated parent. Branch names come from the session, never from
 * the markers, which may hold commit IDs.
 */
export function conflictLabels(kind: 'merge' | 'restack', branches: { head: string; base: string }): ConflictLabels {
  if (kind === 'restack') {
    const parent = shortBranch(branches.base);
    return {
      ours: `Updated parent · ${branches.base}`,
      theirs: `This PR · ${branches.head}`,
      base: 'Before both changes',
      keep: { ours: `Keep ${parent}’s change`, theirs: 'Keep PR change', both: 'Keep both' },
      kept: { ours: `Kept ${parent}’s change`, theirs: 'Kept PR change', both: 'Kept both changes' },
    };
  }
  const base = shortBranch(branches.base);
  return {
    ours: `This PR · ${branches.head}`,
    theirs: branches.base,
    base: 'Before both changes',
    keep: { ours: 'Keep PR change', theirs: `Keep ${base}’s change`, both: 'Keep both' },
    kept: { ours: 'Kept PR change', theirs: `Kept ${base}’s change`, both: 'Kept both changes' },
  };
}
