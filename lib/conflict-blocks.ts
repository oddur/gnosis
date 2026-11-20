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

const pickText = (
  segment: Extract<ConflictSegment, { kind: 'conflict' }>,
  pick: BlockPick | undefined,
  proposals?: BlockProposals
) =>
  pick === 'proposal'
    ? (proposals?.[segment.index]?.text ?? segment.block.raw)
    : pick
      ? chosenText(segment.block, pick)
      : segment.block.raw;

/** The file text for a set of choices; an open block keeps its markers. */
export function applyChoices(
  segments: ConflictSegment[],
  choices: readonly (BlockPick | undefined)[],
  proposals?: BlockProposals
) {
  return segments
    .map((segment) => (segment.kind === 'text' ? segment.text : pickText(segment, choices[segment.index], proposals)))
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
  // Options with the same text are one option: the proposal comes first, so one that equals a side is still the
  // proposal that was checked.
  const options = (segment: Extract<ConflictSegment, { kind: 'conflict' }>) => {
    const seen = new Set<string>();
    return (
      [undefined, ...(proposals?.[segment.index] ? ['proposal' as const] : []), 'ours', 'theirs', 'both'] as const
    )
      .map((choice) => ({ choice, text: pickText(segment, choice, proposals) }))
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
  const choices: (BlockPick | undefined)[] = [];
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

export interface ConflictModel {
  /** The text the blocks come from: the original conflict when Undo is available, else the draft. */
  source: string;
  segments: ConflictSegment[];
  choices: (BlockPick | undefined)[];
  /** False when the draft no longer derives from the original blocks, so earlier choices cannot be undone. */
  undoable: boolean;
}
/** Blocks for the displayed draft, with Undo whenever the draft still derives from the original conflict. */
export function conflictModel(original: string, contents: string, proposals?: BlockProposals): ConflictModel {
  const segments = parseConflicts(original);
  const choices = segments.some((s) => s.kind === 'conflict') ? inferChoices(segments, contents, proposals) : undefined;
  if (choices) return { source: original, segments, choices, undoable: true };
  const own = parseConflicts(contents);
  return { source: contents, segments: own, choices: [], undoable: false };
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
