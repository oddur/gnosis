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

/** The file text for a set of choices; an open block keeps its markers. */
export function applyChoices(segments: ConflictSegment[], choices: readonly (BlockChoice | undefined)[]) {
  return segments
    .map((segment) => {
      if (segment.kind === 'text') return segment.text;
      const choice = choices[segment.index];
      return choice ? chosenText(segment.block, choice) : segment.block.raw;
    })
    .join('');
}

/**
 * Recover per-block choices from a saved draft, so Undo survives switching files and reopening.
 * Returns undefined when the draft was edited by hand or by a suggestion; the view then works on
 * the draft's own remaining markers.
 */
export function inferChoices(segments: ConflictSegment[], contents: string): (BlockChoice | undefined)[] | undefined {
  const choices: (BlockChoice | undefined)[] = [];
  const failed = new Set<string>();
  const options: (BlockChoice | undefined)[] = [undefined, 'ours', 'theirs', 'both'];
  const walk = (i: number, at: number): boolean => {
    if (i === segments.length) return at === contents.length;
    const key = `${i}:${at}`;
    if (failed.has(key)) return false;
    const segment = segments[i];
    if (segment.kind === 'text') {
      if (contents.startsWith(segment.text, at) && walk(i + 1, at + segment.text.length)) return true;
    } else {
      for (const choice of options) {
        const text = choice ? chosenText(segment.block, choice) : segment.block.raw;
        if (!contents.startsWith(text, at)) continue;
        choices[segment.index] = choice;
        if (walk(i + 1, at + text.length)) return true;
      }
      choices[segment.index] = undefined;
    }
    failed.add(key);
    return false;
  };
  return walk(0, 0) ? choices : undefined;
}

export interface ConflictModel {
  /** The text the blocks come from: the original conflict when Undo is available, else the draft. */
  source: string;
  segments: ConflictSegment[];
  choices: (BlockChoice | undefined)[];
  /** False when the draft no longer derives from the original blocks, so earlier choices cannot be undone. */
  undoable: boolean;
}
/** Blocks for the displayed draft, with Undo whenever the draft still derives from the original conflict. */
export function conflictModel(original: string, contents: string): ConflictModel {
  const segments = parseConflicts(original);
  const choices = segments.some((s) => s.kind === 'conflict') ? inferChoices(segments, contents) : undefined;
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
