import { diffArrays } from 'diff';
import { blockResolutions } from './conflict-carry';
import {
  conflictCount,
  inferChoices,
  parseConflicts,
  withPicks,
  type BlockPicks,
  type ConflictSegment,
} from './conflict-blocks';
import {
  hasConflictMarkers,
  type ConflictFile,
  type ConflictFileStage,
  type ConflictProposal,
} from './conflict-resolution';
import { layoutTokens, unionNote, unionOf } from './conflict-union';
import {
  definitionChain,
  syntaxLanguage,
  type RangeUnits,
  type SyntaxDefinition,
  type SyntaxLanguage,
} from './syntax-scope';

/**
 * Conflict buckets (phase 1 of the conflict redesign). Each conflict block is Merged (resolved during preparation and
 * checked), Check (a proposal to read) or Decide (no safe proposal). Pure functions: the service maps resolver output
 * onto Git's blocks, and the workspace checks the result with tree-sitter and counts the buckets.
 */
export type ConflictBucket = 'merged' | 'check' | 'decide' | 'decided';

/** The outcome of the checks for one conflict's proposal. `merged` false means it stays in Check. */
export interface BlockVerdict {
  merged: boolean;
  /** What passed, or the first check that failed, in one plain sentence. */
  note: string;
}
/**
 * The outcome of the checks for one file's proposals. `merged` is true when every proposal passed; `note` is the first
 * failure, or what passed. A failure the checks can trace to some conflicts is theirs alone (`blocks`); one they can't
 * trace keeps every proposal in the file in Check.
 */
export interface Verdict extends BlockVerdict {
  /** A whole-file proposal passed its checks. It is still never Merged. */
  passed?: boolean;
  /** Each conflict's own outcome, by block index. Absent: every proposal shares the file's. */
  blocks?: (BlockVerdict | undefined)[];
  /**
   * The conflicts whose 'same' proposal the syntax trees didn't confirm: both sides are not the same program, or they
   * couldn't be compared. Such a proposal is taken back, and the conflict is yours to decide (src/conflict-checks.ts).
   */
  unconfirmed?: number[];
}
/** A conflict's own outcome: its entry in `blocks`, else the file's. Undefined while the checks run. */
export const blockVerdict = (verdict: Verdict | undefined, index: number): BlockVerdict | undefined =>
  verdict && (verdict.blocks?.[index] ?? verdict);
export interface ParsedText {
  definitions: SyntaxDefinition[];
  /** The tree holds an ERROR or MISSING node. */
  errors: boolean;
  /** The lines (1-based, inclusive) of each outermost ERROR or MISSING node, when the parser said where. */
  errorLines?: [number, number][];
  /** The whole nodes in each of `ranges`, as asked (lib/syntax-scope.ts `rangeUnits`). */
  units?: (RangeUnits | undefined)[];
}
export type Analyse = (
  language: SyntaxLanguage,
  text: string,
  ranges?: readonly (readonly [number, number])[]
) => Promise<ParsedText>;
/** Whether `after` is `before` with formatting changes only (lib/semantic-noise.ts). Rejects when it can't tell. */
export type Equivalent = (language: SyntaxLanguage, before: string, after: string) => Promise<boolean>;

const lineEnding = (text: string) => (/\r\n/.test(text) ? (/(^|[^\r])\n/.test(text) ? 'mixed' : 'crlf') : 'lf');
/** A definition by its kind and scope path, such as `class RetryPolicy.method nextDelay`. */
const symbolKey = (definitions: readonly SyntaxDefinition[], d: SyntaxDefinition) =>
  `${d.kind} ${definitionChain(definitions, d)
    .map((x) => x.name)
    .join('.')}`;
/** The name at the end of a symbol key. */
const symbolName = (key: string) => key.slice(key.lastIndexOf('.') + 1).replace(/^\S+ /, '');
/** Each definition by its symbol key, with its count. */
function symbols(definitions: readonly SyntaxDefinition[]) {
  const counts = new Map<string, number>();
  for (const key of definitions.map((d) => symbolKey(definitions, d))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}
const newlines = (text: string) => text.split('\n').length - 1;

type Conflict = Extract<ConflictSegment, { kind: 'conflict' }>;
/**
 * The file with each proposal in place and each other conflict filled with one side's lines, and where each proposal
 * landed: lines [start, end], 1-based. An empty proposal reaches the lines on both sides of where it was. `except`
 * conflicts are filled with the side's lines too.
 */
function fill(
  segments: ConflictSegment[],
  proposals: readonly (ConflictProposal | null)[],
  side: 'ours' | 'theirs',
  except: ReadonlySet<number> = new Set()
) {
  let text = '';
  let line = 1;
  const regions = new Map<number, [number, number]>();
  for (const s of segments) {
    const proposal = s.kind === 'conflict' && !except.has(s.index) ? proposals[s.index] : undefined;
    const part = s.kind === 'text' ? s.text : proposal ? proposal.text : s.block[side];
    if (s.kind === 'conflict' && proposal) {
      const lines = newlines(part) + (part && !part.endsWith('\n') ? 1 : 0);
      regions.set(s.index, lines ? [line, line + lines - 1] : [line - 1, line]);
    }
    text += part;
    line += newlines(part);
  }
  return { text, regions };
}
/** The proposals whose lines reach any of `lines`; undefined when one of the ranges reaches none of them. */
function reaching(regions: ReadonlyMap<number, [number, number]>, lines: readonly (readonly [number, number])[]) {
  const found = new Set<number>();
  for (const [start, end] of lines) {
    const hit = [...regions].filter(([, [a, z]]) => a <= end && z >= start).map(([index]) => index);
    if (!hit.length) return undefined;
    for (const index of hit) found.add(index);
  }
  return found;
}

/**
 * Checks one file's proposals, cheapest first: no conflict markers and one line-ending style; the result parses where
 * both sides parsed (an undecided conflict may take either side's lines); no definition is duplicated. Structural merge
 * and unions (lib/conflict-union.ts) are also held to the line accounting of each block (`accountLines`), and to no
 * renamed name coming back, no member declared twice and no stray line. A union of both sides' additions is never
 * Merged: it is in Check with a note on what each side added. Your own earlier resolutions stay Merged in files Gnosis
 * has no grammar for; nothing else does.
 *
 * Each failure belongs to the conflicts it can be traced to: the line checks are per block, a duplicated definition
 * belongs to the proposals that hold a copy, and, when no conflict is left undecided, a parse error belongs to the
 * proposals its lines reach once the file parses with them taken out. Only those conflicts go to Check, each with its
 * own reason. A failure that can't be traced keeps every proposal in the file in Check.
 */
export async function verifyProposals(
  file: Pick<ConflictFile, 'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals'> &
    /** The draft: a conflict you decided in it is checked as the text you chose, not as its proposal. */
    Partial<Pick<ConflictFile, 'result'>>,
  analyse: Analyse,
  /** The whole file is one conflict, its three versions, and the first proposal is the whole result. */
  whole = false,
  /**
   * Tells a side that only reformatted a conflict's lines, or two sides that made the same change; without it, such a
   * conflict stays in Check.
   */
  equivalent?: Equivalent
): Promise<Verdict> {
  const proposals = file.proposals ?? [];
  const parsedConflicts = whole ? [] : parseConflicts(file.original);
  // A conflict whose text in the draft is not its proposal is yours: it is fixed text around the others, so each
  // proposal is checked beside what you chose.
  const chosen = file.result === undefined ? undefined : blockResolutions(parsedConflicts, file.result);
  const segments: ConflictSegment[] = whole
    ? [
        {
          kind: 'conflict',
          index: 0,
          block: { base: file.base, ours: file.ours, theirs: file.theirs, raw: '', line: 1 },
        },
      ]
    : parsedConflicts.map((s): ConflictSegment => {
        if (s.kind !== 'conflict') return s;
        const text = chosen?.[s.index];
        return text === undefined || text === proposals[s.index]?.text || hasConflictMarkers(text)
          ? s
          : { kind: 'text', text };
      });
  const conflicts = segments.filter((s): s is Conflict => s.kind === 'conflict');
  const open = conflicts.filter((s) => !proposals[s.index]);
  const proposed = conflicts.filter((s) => proposals[s.index]);
  let probe = fill(segments, proposals, 'ours');
  if (hasConflictMarkers(probe.text)) return { merged: false, note: 'The result still has conflict markers.' };
  const ending = lineEnding(file.ours);
  if (lineEnding(probe.text) !== ending && ending !== 'mixed')
    return { merged: false, note: 'The result mixes line endings.' };
  /** The first failure of each conflict. */
  const failed = new Map<number, string>();
  const fail = (index: number, note: string) => void (failed.has(index) || failed.set(index, note));
  const unconfirmed: number[] = [];
  const verdict = (passed: (index: number) => string): Verdict => {
    const blocks: (BlockVerdict | undefined)[] = [];
    for (const s of proposed) {
      const note = failed.get(s.index);
      blocks[s.index] = note === undefined ? { merged: true, note: passed(s.index) } : { merged: false, note };
    }
    const first = blocks.find((v) => v && !v.merged) ?? blocks.find(Boolean);
    // A proposal your draft decided wasn't checked as itself: if you pick it again before the draft is saved, it
    // stays in Check rather than borrowing the file's verdict.
    const unchecked = proposals.flatMap((p, index) => (p && !proposed.some((s) => s.index === index) ? [index] : []));
    for (const index of unchecked)
      blocks[index] = { merged: false, note: 'You changed this conflict. Gnosis checks it again when you save.' };
    const shared =
      !unchecked.length &&
      proposed.every(({ index }) => blocks[index]?.merged === first?.merged && blocks[index]?.note === first?.note);
    return {
      merged: !failed.size && proposed.length > 0,
      note: first?.note ?? '',
      ...(shared ? {} : { blocks }),
      ...(unconfirmed.length ? { unconfirmed } : {}),
    };
  };
  const language = syntaxLanguage(file.path);
  if (!language) {
    // Your own earlier resolutions stay Merged; nothing else can be checked.
    for (const s of proposed)
      if (proposals[s.index]?.source !== 'rerere')
        fail(s.index, 'Gnosis can’t parse this file type, so it couldn’t check the result.');
    return verdict(() => 'Same as you resolved before. Gnosis can’t parse this file type.');
  }
  // Each union's two insertions, as lines of the probe, to read as whole syntax nodes.
  const unions = proposed.flatMap((s) => {
    const union = proposals[s.index]?.source === 'union' ? unionOf(s.block) : undefined;
    return union ? [{ index: s.index, union }] : [];
  });
  const unionRanges = (regions: ReadonlyMap<number, [number, number]>) =>
    unions.length
      ? unions.flatMap(({ index, union }) => {
          const start = (regions.get(index)?.[0] ?? 0) + union.before;
          return [
            [start, start + union.ours - 1],
            [start + union.ours, start + union.ours + union.theirs - 1],
          ] as [number, number][];
        })
      : undefined;
  let parsed: ParsedText[];
  try {
    parsed = await Promise.all([
      ...[file.base, file.ours, file.theirs].map((text) => analyse(language, text)),
      analyse(language, probe.text, unionRanges(probe.regions)),
    ]);
    const [, ours, theirs, result] = parsed;
    // The probe fills undecided conflicts with the PR's lines; with main's lines it may parse. Only a result that fails
    // both ways is the proposals' fault. With every conflict proposed, it is the fault of the ones its errors reach, when
    // the file parses with those taken out. With one undecided, the whole file's: a proposal can't be cleared against one
    // filling of the open conflicts.
    if (
      result.errors &&
      !ours.errors &&
      !theirs.errors &&
      (!open.length || (await analyse(language, fill(segments, proposals, 'theirs').text)).errors)
    ) {
      const suspects = result.errorLines?.length ? reaching(probe.regions, result.errorLines) : undefined;
      let without: { probe: typeof probe; parsed: ParsedText } | undefined;
      const traceable = suspects && !open.length && suspects.size < proposed.length;
      for (const side of traceable ? (['ours', 'theirs'] as const) : []) {
        const next = fill(segments, proposals, side, suspects);
        const read = await analyse(language, next.text, unionRanges(next.regions));
        if (!read.errors) {
          without = { probe: next, parsed: read };
          break;
        }
      }
      if (!suspects || !without) return { merged: false, note: 'The result doesn’t parse.' };
      for (const index of suspects) fail(index, 'This result doesn’t parse.');
      probe = without.probe;
      parsed[3] = without.parsed;
    }
  } catch {
    return { merged: false, note: 'Gnosis couldn’t parse this file to check the result.' };
  }
  const result = parsed[3];
  const [b, o, t, r] = parsed.map((p) => symbols(p.definitions));
  for (const key of new Set([...o.keys(), ...t.keys(), ...r.keys()])) {
    const [inBase, inOurs, inTheirs, inResult] = [b, o, t, r].map((m) => m.get(key) ?? 0);
    if (inResult > Math.max(inOurs, inTheirs, inOurs + inTheirs - inBase)) {
      const note = `${symbolName(key)} is defined twice in the result.`;
      // The proposals in place that hold a copy. With none, the copies come from lines the proposals didn't write.
      const copies = result.definitions.filter((d) => symbolKey(result.definitions, d) === key);
      const holders = [...probe.regions].filter(([, [a, z]]) => copies.some((d) => a <= d.end && z >= d.start));
      if (!holders.length) return { merged: false, note };
      for (const [index] of holders) fail(index, note);
    }
  }
  const moved = whole ? lostEdit([file.base, file.ours, file.theirs, probe.text], parsed) : undefined;
  if (moved) return { merged: false, note: moved };
  // Your own earlier resolutions may drop a side on purpose: only structural merge and unions are held to the line
  // accounting.
  const reformats = new Map<number, string>();
  if (proposals.some((p) => p && p.source !== 'rerere')) {
    const indented = language === 'python' || language === 'yaml';
    for (const s of proposed) {
      const proposal = proposals[s.index];
      if (!proposal) continue;
      // Spacing inside a line is ignored by the count, so a side whose only change was spacing looks unchanged. Counted
      // again with spacing, such a block is two changes to the same lines: the formatting check below decides it.
      let note = whole
        ? accountWholeFile(file, proposal.text, indented)
        : (accountLines(s.block, proposal.text, indented) ??
          (indented ? undefined : accountLines(s.block, proposal.text, true)));
      // The PR's version of a change both sides may have made (lib/conflict-union.ts) is Merged only on the syntax
      // trees' word, never on the line count, which ignores trailing commas.
      const same = proposal.source === 'same';
      if ((note === SAME_LINES || same) && !whole) {
        const formatted = await reformatted(segments, s.index, proposal.text, language, equivalent, same);
        if (formatted?.merged) {
          reformats.set(s.index, formatted.note);
          continue;
        }
        if (same) unconfirmed.push(s.index);
        note = formatted?.note ?? (same ? NOT_SAME : note);
      }
      if (note) fail(s.index, note);
    }
    // A union is never Merged. Its note comes from the syntax nodes each side added; an earlier failure on the block wins.
    unions.forEach(({ index }, k) => {
      // A union set aside for a parse error was not in the text these units came from.
      const units = probe.regions.has(index) ? result.units : undefined;
      fail(index, unionNote(language, units?.[2 * k], units?.[2 * k + 1]));
    });
    for (const s of proposed)
      if (proposals[s.index]?.source === 'union') fail(s.index, unionNote(language, undefined, undefined));
    for (const [index, note] of [
      ...danglingNames(file, segments),
      ...duplicateMembers(segments, proposals),
      ...strayLines(segments, proposals),
    ])
      fail(index, note);
  }
  return verdict((index) => {
    const own = reformats.get(index);
    return own ? `${own} The file parses.` : 'The file parses. Every line of both sides is accounted for.';
  });
}

/** The line check's note when both sides changed the same lines: the proposal combines them, so read it. */
export const SAME_LINES = 'Both sides changed the same lines. Check that the result keeps both changes.';
/** The tokens `after` drops from `before` and the ones it adds, in order. */
function tokenChanges(before: readonly string[], after: readonly string[]) {
  const removed: string[] = [];
  const added: string[] = [];
  for (const part of diffArrays([...before], [...after]))
    if (part.removed) removed.push(...part.value);
    else if (part.added) added.push(...part.value);
  return `${removed.join('\u0000')}\u0001${added.join('\u0000')}`;
}
/**
 * The proposal is the reformatting side's text with exactly the editing side's token changes, spaces in them
 * included: the same whitespace, quotes and punctuation everywhere else. Any doubt (the two diffs pair tokens
 * differently) is a difference.
 */
export function keepsLayout(block: { base: string; edited: string; formatted: string }, proposal: string) {
  return (
    tokenChanges(layoutTokens(block.base), layoutTokens(block.edited)) ===
    tokenChanges(layoutTokens(block.formatted), layoutTokens(proposal))
  );
}

/** The note of a conflict where both sides made the same change in different layouts (#445 item 15). */
export const SAME_CHANGE = 'Both sides made the same change. Kept the PR’s layout.';
/**
 * The PR's version was proposed for a change both sides seemed to make, but the trees don't show the same code. Seen
 * only until the proposal is taken back (Verdict `unconfirmed`).
 */
export const NOT_SAME =
  'Both sides changed these lines almost the same way, but Gnosis couldn’t show it is the same change. The result is the PR’s version. Check main’s change.';

/**
 * A conflict where one side only reformatted the lines the other side changed. Each version of the conflict is read
 * in the file around it (other conflicts as the PR wrote them) and compared with the ancestor's by its syntax tree,
 * formatting aside. The proposal is Merged only when it is the same program as the changing side's version and is the
 * reformatting side's text with only the changing side's tokens changed (keepsLayout). When both sides changed the code,
 * or both only reformatted, and the two versions are the same program (the same change in different layouts), a
 * proposal that is the PR's version word for word is Merged. A 'same' proposal (`same`) is only ever that: its two
 * sides are compared first, and nothing else. Undefined otherwise.
 */
async function reformatted(
  segments: ConflictSegment[],
  index: number,
  proposal: string,
  language: SyntaxLanguage,
  equivalent: Equivalent | undefined,
  same = false
): Promise<{ merged: boolean; note: string } | undefined> {
  const conflict = segments.find((s) => s.kind === 'conflict' && s.index === index);
  if (!equivalent || conflict?.kind !== 'conflict' || conflict.block.base === undefined) return undefined;
  const { base, ours, theirs } = conflict.block;
  const fill = (text: string) =>
    segments.map((s) => (s.kind === 'text' ? s.text : s.index === index ? text : s.block.ours)).join('');
  const merged = { merged: true, note: SAME_CHANGE };
  try {
    if (same) return proposal === ours && (await equivalent(language, fill(ours), fill(theirs))) ? merged : undefined;
    // Which side only reformatted, first. When both changed the code (the common case), only the PR’s own version is
    // compared again.
    const baseText = fill(base);
    const [pr, main] = await Promise.all([
      equivalent(language, baseText, fill(ours)),
      equivalent(language, baseText, fill(theirs)),
    ]);
    // Both changed the code, or both only reformatted: when the two are the same program, laid out differently, the PR's
    // version is the result, word for word.
    if (pr === main)
      return proposal === ours && (await equivalent(language, fill(ours), fill(theirs))) ? merged : undefined;
    const [formatter, editor] = pr ? ['the PR', 'main'] : ['main', 'the PR'];
    const lead = `${pr ? 'The PR' : 'Main'} only reformatted these lines and ${editor} changed them`;
    if (!(await equivalent(language, fill(pr ? theirs : ours), fill(proposal))))
      return { merged: false, note: `${lead}. The result doesn’t match ${editor}’s change. Check it.` };
    if (!keepsLayout({ base, edited: pr ? theirs : ours, formatted: pr ? ours : theirs }, proposal))
      return {
        merged: false,
        note: `${lead}. The result keeps ${editor}’s change, but not in ${formatter}’s layout. Check it.`,
      };
    return { merged: true, note: `${lead}; the result keeps ${editor}’s change in ${formatter}’s formatting.` };
  } catch {
    // The comparison failed (the language is off, the file too large): the conflict stays in Check.
    return undefined;
  }
}

/**
 * The same checks for structural merge's whole-file result. It changes lines outside Git's conflicts, so it is never
 * Merged: a result that passes stays in Check and says so.
 */
export async function verifyWholeFile(
  file: Pick<ConflictFile, 'path' | 'base' | 'ours' | 'theirs'>,
  proposal: ConflictProposal,
  analyse: Analyse
): Promise<Verdict> {
  const verdict = await verifyProposals({ ...file, original: '', proposals: [proposal] }, analyse, true);
  return verdict.merged
    ? {
        merged: false,
        passed: true,
        note: 'Mergiraf moved lines outside the conflict. The result parses and keeps every change from both sides. Read it, then use it.',
      }
    : { merged: false, note: `${verdict.note} Read it before you use it, or resolve conflict by conflict.` };
}

/**
 * A definition only one side changed comes out as that side wrote it, wherever the other side moved it. Line counts
 * alone miss a move between two definitions with the same body: the edit can land in the wrong one.
 */
function lostEdit(texts: string[], parsed: ParsedText[]) {
  const [b, o, t, r] = parsed.map(({ definitions }, i) => {
    const lines = texts[i].split(/\r?\n/);
    const bodies = new Map<string, string[]>();
    for (const d of definitions) {
      const key = symbolKey(definitions, d);
      const body = lines
        .slice(d.start - 1, d.end)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
      bodies.set(key, [...(bodies.get(key) ?? []), body]);
    }
    return bodies;
  });
  // Definitions that hold others, such as a class: their own text changes whenever a member does.
  const definitions = parsed[0].definitions;
  const containers = new Set(
    definitions
      .filter((d) => definitions.some((x) => x !== d && x.start >= d.start && x.end <= d.end))
      .map((d) => symbolKey(definitions, d))
  );
  for (const [key, [base, ...more]] of b) {
    const [ours, theirs, result] = [o, t, r].map((m) => m.get(key));
    if (more.length || ours?.length !== 1 || theirs?.length !== 1 || result?.length !== 1) continue;
    const name = symbolName(key);
    // Two edits to one definition can land in the wrong places and still keep every line.
    if (base !== ours[0] && base !== theirs[0] && !containers.has(key))
      return `Both sides changed ${name}. Check it yourself.`;
    if (base === ours[0] && base !== theirs[0] && result[0] !== theirs[0])
      return `${name} in the result doesn’t match main’s change to it.`;
    if (base === theirs[0] && base !== ours[0] && result[0] !== ours[0])
      return `${name} in the result doesn’t match the PR’s change to it.`;
    if (base === ours[0] && base === theirs[0] && result[0] !== base)
      return `${name} changed in the result, but neither side changed it.`;
  }
}

/**
 * Line accounting for a whole file, where one side may have moved code: each line appears as often as the two sides'
 * changes leave it: ancestor + (PR − ancestor) + (main − ancestor). Order is not checked.
 */
export function accountWholeFile(
  file: { base: string; ours: string; theirs: string },
  result: string,
  indented: boolean
): string | undefined {
  const { lines, report } = lineAccount(indented);
  const count = (text: string) => {
    const counts = new Map<string, number>();
    for (const line of lines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const [base, ours, theirs, merged] = [file.base, file.ours, file.theirs, result].map(count);
  const missing: string[] = [];
  let extra: string | undefined;
  for (const line of new Set([...base.keys(), ...ours.keys(), ...theirs.keys(), ...merged.keys()])) {
    const [b, o, t, r] = [base, ours, theirs, merged].map((m) => m.get(line) ?? 0);
    // Each side's change counts on its own: a `}` both sides added is there twice.
    const expected = Math.max(0, b + (o - b) + (t - b));
    if (r < expected) missing.push(line);
    else if (r > expected) extra ??= line;
  }
  return report(missing, extra, { base, ours, theirs });
}

/**
 * Lines as the line accounting compares them: blank lines, trailing commas and whitespace are ignored; in Python and
 * YAML, indentation counts. `report` names the first problem: the most telling missing line, else a line too many.
 */
function lineAccount(indented: boolean) {
  const spelled = new Map<string, string>();
  const lines = (text: string) =>
    text.split(/\r?\n/).flatMap((raw) => {
      const line = (indented ? raw.replace(/\s+$/, '') : raw.replace(/\s+/g, '')).replace(/,$/, '');
      if (!line.trim()) return [];
      if (!spelled.has(line)) spelled.set(line, raw.trim());
      return [line];
    });
  const shown = (line: string) => {
    const text = spelled.get(line) ?? line;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };
  type Side = { includes(line: string): boolean } | { has(line: string): boolean };
  const holds = (side: Side, line: string) => ('has' in side ? side.has(line) : side.includes(line));
  const report = (
    missing: string[],
    extra: string | undefined,
    sides: { base: Side; ours: Side; theirs: Side }
  ): string | undefined => {
    // Name the most telling missing line: one with a word in it, not a lone brace.
    const line = missing.find((l) => /[\p{L}\p{N}]/u.test(l)) ?? missing.at(0);
    if (line !== undefined) {
      const from = holds(sides.ours, line) ? (holds(sides.theirs, line) ? 'both sides' : 'the PR') : 'main';
      return `${shown(line)} from ${from} is missing from the result.`;
    }
    if (extra !== undefined)
      return holds(sides.base, extra)
        ? `${shown(extra)} was removed on one side but is still in the result.`
        : `${shown(extra)} is in neither side.`;
  };
  return { lines, report };
}

/**
 * One block's line accounting, against the block's own ancestor, PR and main lines. Lines both sides kept must be in
 * the result; lines either side added must be in it; lines a side deleted must be gone; nothing else may appear. Where
 * both sides changed the same ancestor lines differently, the block is a real conflict and nothing is Merged. Blank
 * lines, trailing commas and whitespace are ignored; in Python and YAML, indentation counts.
 */
export function accountLines(
  block: { base?: string; ours: string; theirs: string },
  result: string,
  indented: boolean
): string | undefined {
  if (block.base === undefined) return 'Gnosis couldn’t see the lines before both changes.';
  const { lines, report } = lineAccount(indented);
  const [base, ours, theirs, merged] = [block.base, block.ours, block.theirs, result].map(lines);
  const [mine, other] = [changesOf(base, ours), changesOf(base, theirs)];
  const same = (a: LineChange, b: LineChange) =>
    a.start === b.start && a.end === b.end && a.added.join('\n') === b.added.join('\n');
  const inside = (gap: number, c: LineChange) => c.start < gap && gap < c.end;
  for (const a of mine)
    for (const b of other) {
      if (same(a, b)) continue;
      const overlap = a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;
      if (overlap || (a.start === a.end && inside(a.start, b)) || (b.start === b.end && inside(b.start, a)))
        return SAME_LINES;
    }
  const removed = new Set<number>();
  for (const c of [...mine, ...other]) for (let i = c.start; i < c.end; i++) removed.add(i);
  const expected = new Map<string, number>();
  const add = (line: string) => expected.set(line, (expected.get(line) ?? 0) + 1);
  base.forEach((line, i) => !removed.has(i) && add(line));
  for (const c of mine) c.added.forEach(add);
  for (const c of other) if (!mine.some((m) => same(m, c))) c.added.forEach(add);
  const found = new Map<string, number>();
  for (const line of merged) found.set(line, (found.get(line) ?? 0) + 1);
  const missing = [...expected].filter(([line, n]) => (found.get(line) ?? 0) < n).map(([line]) => line);
  const extra = [...found].find(([line, n]) => n > (expected.get(line) ?? 0))?.[0];
  return report(missing, extra, { base, ours, theirs });
}
/** A side's edits against the ancestor: each replaces ancestor lines [start, end) with `added`. */
interface LineChange {
  start: number;
  end: number;
  added: string[];
}
function changesOf(base: string[], side: string[]): LineChange[] {
  const changes: LineChange[] = [];
  let at = 0;
  let open: LineChange | undefined;
  for (const part of diffArrays(base, side)) {
    if (!part.added && !part.removed) {
      if (open) changes.push(open);
      open = undefined;
      at += part.value.length;
      continue;
    }
    open ??= { start: at, end: at, added: [] };
    if (part.removed) {
      at += part.value.length;
      open.end = at;
    } else open.added.push(...part.value);
  }
  if (open) changes.push(open);
  return changes;
}

/** Keywords of the bundled grammars: a side that drops an `if` has not renamed anything. */
const KEYWORDS = new Set(
  'if else for while do return break continue switch case default match try catch finally throw throws new delete typeof instanceof in of is as await async yield function fn def func class struct enum interface impl trait type let const var val mut pub public private protected internal static readonly final abstract override virtual sealed import from export use using package namespace mod self this super true false null nil None True False void int string bool where with lambda pass raise except elif not and or go defer select chan map range'.split(
    ' '
  )
);
const words = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
/**
 * A name one side removed comes back in a proposal: one side renamed or deleted a function, parameter or keyword
 * argument, and the other side's new lines in the same conflict still use it. A name counts as removed when the side
 * dropped it from the whole file, or from that conflict's lines while the ancestor had it there.
 */
function danglingNames(
  file: Pick<ConflictFile, 'base' | 'ours' | 'theirs' | 'proposals'>,
  segments: ConflictSegment[]
) {
  const whole = { base: words(file.base), ours: words(file.ours), theirs: words(file.theirs) };
  const found: [number, string][] = [];
  for (const s of segments) {
    const proposal = s.kind === 'conflict' ? file.proposals?.[s.index] : undefined;
    if (s.kind !== 'conflict' || !proposal) continue;
    const block = { base: words(s.block.base ?? ''), ours: words(s.block.ours), theirs: words(s.block.theirs) };
    const removed = (word: string, side: 'ours' | 'theirs', other: 'ours' | 'theirs') =>
      block[other].has(word) &&
      ((whole.base.has(word) && !whole[side].has(word)) || (block.base.has(word) && !block[side].has(word)));
    for (const word of words(proposal.text)) {
      if (word.length < 2 || KEYWORDS.has(word)) continue;
      const side = removed(word, 'ours', 'theirs') ? 'the PR' : removed(word, 'theirs', 'ours') ? 'main' : undefined;
      if (side) {
        found.push([s.index, `${word} was renamed or removed on ${side}, but the result still uses it.`]);
        break;
      }
    }
  }
  return found;
}
/**
 * The name each line at a block's first indentation declares or keys: the last word before the first `(`, `=`, `:`,
 * `,` or `{`, with a call's parameter list so overloads differ. Enum members, fields and keys are not definitions.
 */
function declared(text: string) {
  const counts = new Map<string, number>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const indent = lines.length ? (/^\s*/.exec(lines[0])?.[0].length ?? 0) : 0;
  for (const line of lines) {
    if ((/^\s*/.exec(line)?.[0].length ?? 0) !== indent) continue;
    const body = line.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
    if (/^(import|from|using|use|return|if|for|while|else|case|default|#|\/\/|\/\*|\*|-\s)/.test(body)) continue;
    const at = body.search(/[(=:,{]/);
    if (at <= 0) continue;
    const name = /["']?([\w$.-]+)["']?\s*$/.exec(body.slice(0, at))?.[1];
    if (!name) continue;
    const key =
      body[at] === '(' ? `${name}(${(/^\(([^)]*)\)/.exec(body.slice(at))?.[1] ?? '').replace(/\s+/g, ' ')})` : name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
/** A proposal declares one name twice where neither side's lines did: two enum members, fields or keys. */
function duplicateMembers(segments: ConflictSegment[], proposals: readonly (ConflictProposal | null)[]) {
  const found: [number, string][] = [];
  for (const s of segments) {
    const proposal = s.kind === 'conflict' ? proposals[s.index] : undefined;
    if (s.kind !== 'conflict' || !proposal) continue;
    const [result, ours, theirs] = [proposal.text, s.block.ours, s.block.theirs].map(declared);
    const twice = [...result].find(([name, n]) => n > Math.max(ours.get(name) ?? 0, theirs.get(name) ?? 0, 1));
    if (twice) found.push([s.index, `${twice[0]} is declared twice in the result.`]);
  }
  return found;
}
/** Structural merge sometimes writes a line holding only `;` (JavaScript class fields with CRLF). */
function strayLines(segments: ConflictSegment[], proposals: readonly (ConflictProposal | null)[]) {
  const semicolons = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() === ';').length;
  const found: [number, string][] = [];
  for (const s of segments)
    if (s.kind === 'conflict' && proposals[s.index]) {
      const text = proposals[s.index]?.text ?? '';
      if (semicolons(text) > Math.max(semicolons(s.block.ours), semicolons(s.block.theirs)))
        found.push([s.index, 'The result adds a line that holds only a semicolon.']);
    }
  return found;
}

/**
 * The version of the checks in this file. Bump it whenever a check changes what it passes or fails: verdicts saved with
 * a draft (lib/conflict-verdict-key.ts) count only for the version that made them.
 */
export const CHECKS_VERSION = 2;
const proposalKeys = new WeakMap<object, string>();
/**
 * A cheap fingerprint of a file's conflict, proposals and draft (FNV-1a and length), remembered per file object. A
 * check result counts only for the proposals it checked, beside the choices it checked them with.
 */
export function proposalKey(
  file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile'> & Partial<Pick<ConflictFile, 'result'>>
) {
  let key = proposalKeys.get(file);
  if (key === undefined) {
    const proposals = [...(file.proposals ?? []), ...(file.wholeFile ? [null, file.wholeFile] : [])];
    const text = [
      file.original,
      ...proposals.map((p) => (p ? `${p.source}\u0001${p.text}` : '')),
      // The draft matters only to per-conflict checks; a whole-file check ignores it.
      `\u0002${file.wholeFile ? '' : (file.result ?? '')}`,
    ].join('\u0000');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    key = `${(hash >>> 0).toString(36)}:${text.length}`;
    proposalKeys.set(file, key);
  }
  return key;
}

/**
 * Each conflict block's bucket in the displayed draft. A block that still holds its proposal is Merged when the
 * checks passed, else Check; `verdict` undefined means the checks are still running. A block you chose is Decided.
 * A draft edited by hand counts its remaining markers as Decide and the rest as Decided.
 */
export function blockBuckets(
  file: Pick<ConflictFile, 'original' | 'proposals' | 'unsupported' | 'wholeFile'>,
  contents: string,
  verdict: Verdict | undefined,
  /** Keep choices you made: one whose text equals the proposal is Decided, not the proposal (withPicks). */
  picks?: BlockPicks
): ConflictBucket[] {
  if (file.unsupported) return ['decide'];
  // A whole-file proposal puts every conflict in Check, until you use it or start choosing conflicts yourself. One that
  // failed its checks leaves them to decide.
  if (file.wholeFile && contents === file.original && (!verdict || verdict.passed))
    return parseConflicts(file.original).flatMap((s) => (s.kind === 'conflict' ? ['check' as const] : []));
  const segments = parseConflicts(file.original);
  const inferred = inferChoices(segments, contents, file.proposals);
  const choices = inferred && withPicks(segments, inferred, file.proposals, picks);
  const blocks = segments.filter((s) => s.kind === 'conflict');
  if (!choices) {
    // Edited by hand somewhere: each block's own text where the draft still shows it. A proposal that is not shown
    // to be in place unchanged needs you: it is never Decided, and only Merged when its exact text is there.
    const texts = blockResolutions(segments, contents);
    let open = parseConflicts(contents).filter((s) => s.kind === 'conflict').length;
    return blocks.map((s) => {
      const proposal = file.proposals?.[s.index];
      const text = texts?.[s.index];
      if (proposal && text === proposal.text) return blockVerdict(verdict, s.index)?.merged ? 'merged' : 'check';
      if (proposal && text === undefined) return 'check';
      if (texts) return text === undefined ? 'decide' : 'decided';
      return open-- > 0 ? 'decide' : 'decided';
    });
  }
  return blocks.map((s) => {
    const pick = choices[s.index];
    if (pick === 'proposal') return blockVerdict(verdict, s.index)?.merged ? 'merged' : 'check';
    return pick ? 'decided' : 'decide';
  });
}

/**
 * The file's conflicts all wait behind a whole-file proposal that passed its checks, or is being checked. The file
 * list, the file header and the footer use it.
 */
export const proposalReady = (
  f: Pick<ConflictFile, 'wholeFile' | 'original'>,
  draft: string,
  buckets: readonly ConflictBucket[]
) => !!f.wholeFile && draft === f.original && buckets.length > 0 && buckets.every((bucket) => bucket === 'check');

/**
 * A file's state, one for the file list, the file header, the footer and the summary. While any conflict is to decide,
 * to check or merged and the file is not reviewed, it shows those counts. "Resolved · needs review" is only for a file
 * whose every conflict you decided, or whose proposal you used, and that waits for Mark reviewed.
 */
export type FileStatus =
  | { kind: 'unsupported' }
  /** A whole-file proposal waits to be read and used. */
  | { kind: 'proposal' }
  | { kind: 'buckets'; decide: number; check: number; merged: number }
  | { kind: 'conflicted'; conflicts: number }
  /** A line that looks like a conflict marker, outside any whole conflict: a stray `>>>>>>>` left after an edit. */
  | { kind: 'marker' }
  | { kind: 'resolved' }
  | { kind: 'reviewed' };
export function fileStatus(
  file: Pick<ConflictFile, 'wholeFile' | 'original' | 'unsupported'>,
  draft: string,
  stage: ConflictFileStage,
  buckets: readonly ConflictBucket[]
): FileStatus {
  if (file.unsupported) return { kind: 'unsupported' };
  if (proposalReady(file, draft, buckets)) return { kind: 'proposal' };
  if (stage === 'reviewed') return { kind: 'reviewed' };
  // A marker line with no whole conflict around it blocks Mark reviewed: say so, before any bucket.
  const conflicts = stage === 'conflicted' ? conflictCount(draft) : 0;
  if (stage === 'conflicted' && !conflicts) return { kind: 'marker' };
  const counts = { decide: 0, check: 0, merged: 0 };
  for (const bucket of buckets) if (bucket !== 'decided') counts[bucket]++;
  if (counts.decide || counts.check || counts.merged) return { kind: 'buckets', ...counts };
  return stage === 'conflicted' ? { kind: 'conflicted', conflicts } : { kind: 'resolved' };
}
/**
 * Every conflict in the file is Merged, with nothing you chose or edited beside it. Only then are its results all on
 * screen already: Mark reviewed needs no Review result first, and with "Show me every merged conflict" off the file is
 * reviewed for you. The primary action, Mark reviewed, the summary and the automatic review all use it.
 */
export const allMerged = (buckets: readonly ConflictBucket[]) =>
  buckets.length > 0 && buckets.every((bucket) => bucket === 'merged');
/**
 * The file needs nothing but Mark reviewed: no conflict left to decide or check, and not reviewed for you. With "Show me
 * every merged conflict" off, an all-Merged file is reviewed for you, so it waits for nobody.
 */
export function waitsForReview(status: FileStatus, buckets: readonly ConflictBucket[], showMerged: boolean) {
  const settled = status.kind === 'resolved' || (status.kind === 'buckets' && !status.decide && !status.check);
  return settled && (showMerged || !allMerged(buckets));
}
/** The parts a status shows, each with its tone (the icon): "1 to decide", "2 to check", "Resolved · needs review". */
export function fileStatusParts(status: FileStatus): {
  tone: 'decide' | 'check' | 'merged' | 'proposal' | 'conflicted' | 'resolved' | 'reviewed' | 'unsupported';
  text: string;
}[] {
  switch (status.kind) {
    case 'unsupported':
      return [{ tone: 'unsupported', text: 'Needs a local merge tool' }];
    case 'proposal':
      return [{ tone: 'proposal', text: 'Proposal ready' }];
    case 'buckets':
      return (['decide', 'check', 'merged'] as const)
        .filter((bucket) => status[bucket])
        .map((bucket) => ({
          tone: bucket,
          text: `${status[bucket]} ${bucket === 'merged' ? 'merged' : `to ${bucket}`}`,
        }));
    case 'conflicted':
      return [{ tone: 'conflicted', text: `${status.conflicts} ${status.conflicts === 1 ? 'conflict' : 'conflicts'}` }];
    case 'marker':
      return [{ tone: 'conflicted', text: 'Conflict marker left' }];
    case 'resolved':
      return [{ tone: 'resolved', text: 'Resolved · needs review' }];
    case 'reviewed':
      return [{ tone: 'reviewed', text: 'Reviewed' }];
  }
}
/** The footer's words for the open file: "1 to check in this file", or nothing once it waits for Mark reviewed. */
export function fileStatusLine(status: FileStatus): string | undefined {
  if (status.kind === 'unsupported') return 'Gnosis can’t merge this file. Merge the PR on your computer';
  if (status.kind === 'proposal') return '1 proposal to check';
  if (status.kind === 'marker') return 'A conflict marker is left in the file. Check the result';
  if (status.kind === 'conflicted') return `${fileStatusParts(status)[0].text} left in this file`;
  if (status.kind === 'buckets')
    return `${fileStatusParts(status)
      .map((part) => part.text)
      .join(', ')} in this file`;
}

export interface BucketSummary {
  files: number;
  conflicts: number;
  merged: number;
  /** Decide and Check blocks in files you have not marked reviewed, and files with a marker left. */
  needs: number;
  /** Proposals whose checks are still running. */
  checking: number;
  /** Of `needs`: Decide blocks, and the conflicts that whole-file proposals cover. */
  decide: number;
  wholeConflicts: number;
  /** Whole-file proposals to check, one per file. */
  wholeFiles: number;
  /** Of `needs`: files with a conflict marker left outside any whole conflict (fileStatus `marker`). */
  markers: number;
  /** Of `needs`: files Gnosis can't merge (fileStatus `unsupported`). */
  local: number;
  /** Files that need nothing but Mark reviewed. */
  review: number;
}
export function bucketSummary(
  files: {
    buckets: readonly ConflictBucket[];
    verdict: Verdict | undefined;
    reviewed: boolean;
    whole?: boolean;
    /** The file's status is `marker`: it needs you for that alone, whatever its buckets. */
    marker?: boolean;
    /** Gnosis can't merge the file: it needs a local merge tool. */
    unsupported?: boolean;
    /** The file needs nothing but Mark reviewed. */
    review?: boolean;
  }[]
): BucketSummary {
  const summary: BucketSummary = {
    files: files.length,
    conflicts: 0,
    merged: 0,
    needs: 0,
    checking: 0,
    decide: 0,
    wholeConflicts: 0,
    wholeFiles: 0,
    markers: 0,
    local: 0,
    review: 0,
  };
  for (const { buckets, verdict, reviewed, whole, marker, unsupported, review } of files) {
    if (unsupported) {
      summary.conflicts++;
      summary.local++;
      summary.needs++;
      continue;
    }
    if (review && !reviewed) summary.review++;
    if (marker && !reviewed) {
      summary.markers++;
      summary.needs++;
    }
    if (whole && !reviewed && !marker && buckets.includes('check')) summary.wholeFiles++;
    for (const bucket of buckets) {
      summary.conflicts++;
      if (bucket === 'merged') summary.merged++;
      // A reviewed file needs nothing more, whatever its buckets: its status is Reviewed everywhere. A file with a
      // marker left shows that alone, and counts once above.
      if (reviewed || marker) continue;
      if (bucket === 'decide' || bucket === 'check') summary.needs++;
      if (bucket === 'decide') summary.decide++;
      if (bucket === 'check' && whole) summary.wholeConflicts++;
      // Only a proposal is in Check: with no verdict yet, its checks are running.
      if (bucket === 'check' && !verdict) summary.checking++;
    }
  }
  return summary;
}
/**
 * "3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you." With nothing to decide or check,
 * it names the files that wait for Mark reviewed: "1 file is ready for review." Whole-file proposals are named, with the
 * conflicts they cover: "1 proposal to check for 2 conflicts.", or "3 need you: 1 proposal to check for 2 conflicts,
 * 1 to decide."
 */
export function summarySentence(s: BucketSummary) {
  const files = s.files === 1 ? '1 file has conflicts.' : `${s.files} files have conflicts.`;
  const merged = s.merged
    ? ` ${s.merged} of ${s.conflicts} ${s.conflicts === 1 ? 'conflict is' : 'conflicts are'} merged and checked.`
    : '';
  const needs = s.checking
    ? ` Checking ${s.checking} ${s.checking === 1 ? 'result' : 'results'}…`
    : s.needs
      ? needsYou(s)
      : s.review
        ? ` ${s.review} ${s.review === 1 ? 'file is' : 'files are'} ready for review.`
        : ' Nothing needs you.';
  return files + merged + needs;
}
/** What needs you, in the file list's words: "1 to check.", or "3 need you: 2 to check, 1 to decide." */
function needsYou(s: BucketSummary) {
  const check = s.needs - s.decide - s.wholeConflicts - s.markers - s.local;
  const covers = s.wholeConflicts > s.wholeFiles ? ` for ${s.wholeConflicts} conflicts` : '';
  const parts = [
    ...(s.wholeFiles ? [`${s.wholeFiles} ${s.wholeFiles === 1 ? 'proposal' : 'proposals'} to check${covers}`] : []),
    ...(check ? [`${check} to check`] : []),
    ...(s.decide ? [`${s.decide} to decide`] : []),
    ...(s.markers ? [`${s.markers} ${s.markers === 1 ? 'file' : 'files'} with a conflict marker left`] : []),
    ...(s.local ? [`${s.local} ${s.local === 1 ? 'file needs' : 'files need'} a local merge tool`] : []),
  ];
  return parts.length === 1
    ? ` ${parts[0]}.`
    : ` ${s.needs} ${s.needs === 1 ? 'needs' : 'need'} you: ${parts.join(', ')}.`;
}
