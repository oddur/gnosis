import { diffArrays } from 'diff';
import { blockResolutions } from './conflict-carry';
import { inferChoices, parseConflicts, type ConflictSegment } from './conflict-blocks';
import { hasConflictMarkers, type ConflictFile, type ConflictProposal } from './conflict-resolution';
import { definitionChain, syntaxLanguage, type SyntaxDefinition, type SyntaxLanguage } from './syntax-scope';

/**
 * Conflict buckets (phase 1 of the conflict redesign). Each conflict block is Merged (resolved during preparation and
 * checked), Check (a proposal to read) or Decide (no safe proposal). Pure functions: the service maps resolver output
 * onto Git's blocks, and the workspace checks the result with tree-sitter and counts the buckets.
 */
export type ConflictBucket = 'merged' | 'check' | 'decide' | 'decided';

/** The outcome of the checks for one file's proposals. `merged` false means they all stay in Check. */
export interface Verdict {
  merged: boolean;
  /** What passed, or the first check that failed, in one plain sentence. */
  note: string;
}
export interface ParsedText {
  definitions: SyntaxDefinition[];
  /** The tree holds an ERROR or MISSING node. */
  errors: boolean;
}
export type Analyse = (language: SyntaxLanguage, text: string) => Promise<ParsedText>;

const lineEnding = (text: string) => (/\r\n/.test(text) ? (/(^|[^\r])\n/.test(text) ? 'mixed' : 'crlf') : 'lf');
/** Each definition by its scope path and kind, such as `class RetryPolicy.method nextDelay`, with its count. */
function symbols(definitions: readonly SyntaxDefinition[]) {
  const counts = new Map<string, number>();
  for (const d of definitions) {
    const key = `${d.kind} ${definitionChain(definitions, d)
      .map((x) => x.name)
      .join('.')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Checks one file's proposals together, cheapest first: no conflict markers and one line-ending style; the result
 * parses where both sides parsed (an undecided conflict may take either side's lines); no definition is duplicated.
 * Structural merge is also held to the line accounting of each block (`accountLines`), and to no renamed name coming
 * back, no member declared twice and no stray line. Your own earlier resolutions stay Merged in files Gnosis has no
 * grammar for; structural merge does not.
 */
export async function verifyProposals(
  file: Pick<ConflictFile, 'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals'>,
  analyse: Analyse,
  /** The whole file is one conflict, its three versions, and the first proposal is the whole result. */
  whole = false
): Promise<Verdict> {
  const proposals = file.proposals ?? [];
  const segments: ConflictSegment[] = whole
    ? [
        {
          kind: 'conflict',
          index: 0,
          block: { base: file.base, ours: file.ours, theirs: file.theirs, raw: '', line: 1 },
        },
      ]
    : parseConflicts(file.original);
  const open = segments.filter(
    (s): s is Extract<ConflictSegment, { kind: 'conflict' }> => s.kind === 'conflict' && !proposals[s.index]
  );
  const probe = segments.map((s) => (s.kind === 'text' ? s.text : (proposals[s.index]?.text ?? s.block.ours))).join('');
  if (hasConflictMarkers(probe)) return { merged: false, note: 'The result still has conflict markers.' };
  const ending = lineEnding(file.ours);
  if (lineEnding(probe) !== ending && ending !== 'mixed')
    return { merged: false, note: 'The result mixes line endings.' };
  const language = syntaxLanguage(file.path);
  if (!language)
    return proposals.every((p) => !p || p.source === 'rerere')
      ? { merged: true, note: 'Same as you resolved before. Gnosis can’t parse this file type.' }
      : { merged: false, note: 'Gnosis can’t parse this file type, so it couldn’t check the result.' };
  let parsed: ParsedText[];
  try {
    parsed = await Promise.all([file.base, file.ours, file.theirs, probe].map((text) => analyse(language, text)));
  } catch {
    return { merged: false, note: 'Gnosis couldn’t parse this file to check the result.' };
  }
  const [, ours, theirs, result] = parsed;
  // The probe fills undecided conflicts with the PR's lines; with main's lines it may parse. Only a result that fails
  // both ways is the proposals' fault.
  if (result.errors && !ours.errors && !theirs.errors) {
    const withMain = segments.map((s) => (s.kind === 'text' ? s.text : (proposals[s.index]?.text ?? s.block.theirs)));
    if (!open.length || (await analyse(language, withMain.join(''))).errors)
      return { merged: false, note: 'The result doesn’t parse.' };
  }
  const [b, o, t, r] = parsed.map((p) => symbols(p.definitions));
  for (const key of new Set([...o.keys(), ...t.keys(), ...r.keys()])) {
    const [inBase, inOurs, inTheirs, inResult] = [b, o, t, r].map((m) => m.get(key) ?? 0);
    if (inResult > Math.max(inOurs, inTheirs, inOurs + inTheirs - inBase)) {
      const name = key.slice(key.lastIndexOf('.') + 1).replace(/^\S+ /, '');
      return { merged: false, note: `${name} is defined twice in the result.` };
    }
  }
  const moved = whole ? lostEdit([file.base, file.ours, file.theirs, probe], parsed) : undefined;
  if (moved) return { merged: false, note: moved };
  // Your own earlier resolutions may drop a side on purpose: only structural merge is held to the line accounting.
  if (proposals.some((p) => p?.source === 'mergiraf')) {
    const indented = language === 'python' || language === 'yaml';
    for (const s of segments) {
      const proposal = s.kind === 'conflict' ? proposals[s.index] : undefined;
      if (s.kind !== 'conflict' || !proposal) continue;
      const note = whole
        ? accountWholeFile(file, proposal.text, indented)
        : accountLines(s.block, proposal.text, indented);
      if (note) return { merged: false, note };
    }
    const named =
      danglingName(file, segments) ?? duplicateMember(segments, proposals) ?? strayLine(segments, proposals);
    if (named) return { merged: false, note: named };
  }
  return { merged: true, note: 'The file parses. Every line of both sides is accounted for.' };
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
  return {
    merged: false,
    note: verdict.merged ? `${verdict.note} It changes the whole file, so read it before you use it.` : verdict.note,
  };
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
      const key = `${d.kind} ${definitionChain(definitions, d)
        .map((x) => x.name)
        .join('.')}`;
      const body = lines
        .slice(d.start - 1, d.end)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
      bodies.set(key, [...(bodies.get(key) ?? []), body]);
    }
    return bodies;
  });
  for (const [key, [base, ...more]] of b) {
    const [ours, theirs, result] = [o, t, r].map((m) => m.get(key));
    if (more.length || ours?.length !== 1 || theirs?.length !== 1 || result?.length !== 1) continue;
    const name = key.slice(key.lastIndexOf('.') + 1).replace(/^\S+ /, '');
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
 * changes leave it (PR + main − ancestor, or one side's count when both sides changed it alike). Order is not checked.
 */
export function accountWholeFile(
  file: { base: string; ours: string; theirs: string },
  result: string,
  indented: boolean
): string | undefined {
  const spelled = new Map<string, string>();
  const count = (text: string) => {
    const counts = new Map<string, number>();
    for (const raw of text.split(/\r?\n/)) {
      const line = (indented ? raw.replace(/\s+$/, '') : raw.replace(/\s+/g, '')).replace(/,$/, '');
      if (!line.trim()) continue;
      if (!spelled.has(line)) spelled.set(line, raw.trim());
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const [base, ours, theirs, merged] = [file.base, file.ours, file.theirs, result].map(count);
  const shown = (line: string) => {
    const text = spelled.get(line) ?? line;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };
  const missing: string[] = [];
  let extra: string | undefined;
  for (const line of new Set([...base.keys(), ...ours.keys(), ...theirs.keys(), ...merged.keys()])) {
    const [b, o, t, r] = [base, ours, theirs, merged].map((m) => m.get(line) ?? 0);
    const expected = o === t ? o : Math.max(0, o + t - b);
    if (r < expected) missing.push(line);
    else if (r > expected) extra ??= line;
  }
  // Name the most telling missing line: one with a word in it, not a lone brace.
  const line = missing.find((l) => /[\p{L}\p{N}]/u.test(l)) ?? missing.at(0);
  if (line !== undefined) {
    const from = ours.has(line) ? (theirs.has(line) ? 'both sides' : 'the PR') : 'main';
    return `${shown(line)} from ${from} is missing from the result.`;
  }
  if (extra !== undefined)
    return base.has(extra)
      ? `${shown(extra)} was removed on one side but is still in the result.`
      : `${shown(extra)} is in neither side.`;
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
  const spelled = new Map<string, string>();
  const lines = (text: string) =>
    text.split(/\r?\n/).flatMap((raw) => {
      const line = (indented ? raw.replace(/\s+$/, '') : raw.replace(/\s+/g, '')).replace(/,$/, '');
      if (!line.trim()) return [];
      if (!spelled.has(line)) spelled.set(line, raw.trim());
      return [line];
    });
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
        return 'Both sides changed the same lines, so the result is a choice, not a merge.';
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
  const shown = (line: string) => {
    const text = spelled.get(line) ?? line;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };
  // Name the most telling missing line: one with a word in it, not a lone brace.
  const missing = [...expected].filter(([line, n]) => (found.get(line) ?? 0) < n).map(([line]) => line);
  const line = missing.find((l) => /[\p{L}\p{N}]/u.test(l)) ?? missing.at(0);
  if (line !== undefined) {
    const from = ours.includes(line) ? (theirs.includes(line) ? 'both sides' : 'the PR') : 'main';
    return `${shown(line)} from ${from} is missing from the result.`;
  }
  for (const [line, n] of found)
    if (n > (expected.get(line) ?? 0))
      return base.includes(line)
        ? `${shown(line)} was removed on one side but is still in the result.`
        : `${shown(line)} is in neither side.`;
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
function danglingName(file: Pick<ConflictFile, 'base' | 'ours' | 'theirs' | 'proposals'>, segments: ConflictSegment[]) {
  const whole = { base: words(file.base), ours: words(file.ours), theirs: words(file.theirs) };
  for (const s of segments) {
    const proposal = s.kind === 'conflict' ? file.proposals?.[s.index] : undefined;
    if (s.kind !== 'conflict' || !proposal) continue;
    const block = { base: words(s.block.base ?? ''), ours: words(s.block.ours), theirs: words(s.block.theirs) };
    const removed = (word: string, side: 'ours' | 'theirs', other: 'ours' | 'theirs') =>
      block[other].has(word) &&
      ((whole.base.has(word) && !whole[side].has(word)) || (block.base.has(word) && !block[side].has(word)));
    for (const word of words(proposal.text)) {
      if (word.length < 2 || KEYWORDS.has(word)) continue;
      if (removed(word, 'ours', 'theirs'))
        return `${word} was renamed or removed on the PR, but the result still uses it.`;
      if (removed(word, 'theirs', 'ours'))
        return `${word} was renamed or removed on main, but the result still uses it.`;
    }
  }
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
function duplicateMember(segments: ConflictSegment[], proposals: readonly (ConflictProposal | null)[]) {
  for (const s of segments) {
    const proposal = s.kind === 'conflict' ? proposals[s.index] : undefined;
    if (s.kind !== 'conflict' || !proposal) continue;
    const [result, ours, theirs] = [proposal.text, s.block.ours, s.block.theirs].map(declared);
    for (const [name, n] of result)
      if (n > Math.max(ours.get(name) ?? 0, theirs.get(name) ?? 0, 1))
        return `${name} is declared twice in the result.`;
  }
}
/** Structural merge sometimes writes a line holding only `;` (JavaScript class fields with CRLF). */
function strayLine(segments: ConflictSegment[], proposals: readonly (ConflictProposal | null)[]) {
  const semicolons = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() === ';').length;
  for (const s of segments)
    if (s.kind === 'conflict' && proposals[s.index]) {
      const text = proposals[s.index]?.text ?? '';
      if (semicolons(text) > Math.max(semicolons(s.block.ours), semicolons(s.block.theirs)))
        return 'The result adds a line that holds only a semicolon.';
    }
}

const proposalKeys = new WeakMap<object, string>();
/**
 * A cheap fingerprint of a file's conflict and proposals (FNV-1a and length), remembered per file object. A check
 * result counts only for the proposals it checked.
 */
export function proposalKey(file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile'>) {
  let key = proposalKeys.get(file);
  if (key === undefined) {
    const proposals = [...(file.proposals ?? []), ...(file.wholeFile ? [null, file.wholeFile] : [])];
    const text = [file.original, ...proposals.map((p) => (p ? `${p.source}\u0001${p.text}` : ''))].join('\u0000');
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
  verdict: Verdict | undefined
): ConflictBucket[] {
  if (file.unsupported) return ['decide'];
  // A whole-file proposal is one thing to check, until you use it or start choosing conflicts yourself.
  if (file.wholeFile && contents === file.original) return ['check'];
  const segments = parseConflicts(file.original);
  const choices = inferChoices(segments, contents, file.proposals);
  const blocks = segments.filter((s) => s.kind === 'conflict');
  if (!choices) {
    // Edited by hand somewhere: each block's own text where the draft still shows it. A proposal that is not shown
    // to be in place unchanged needs you: it is never Decided, and only Merged when its exact text is there.
    const texts = blockResolutions(segments, contents);
    let open = parseConflicts(contents).filter((s) => s.kind === 'conflict').length;
    return blocks.map((s) => {
      const proposal = file.proposals?.[s.index];
      const text = texts?.[s.index];
      if (proposal && text === proposal.text) return verdict?.merged ? 'merged' : 'check';
      if (proposal && text === undefined) return 'check';
      if (texts) return text === undefined ? 'decide' : 'decided';
      return open-- > 0 ? 'decide' : 'decided';
    });
  }
  return blocks.map((s) => {
    const pick = choices[s.index];
    if (pick === 'proposal') return verdict?.merged ? 'merged' : 'check';
    return pick ? 'decided' : 'decide';
  });
}

export interface BucketSummary {
  files: number;
  conflicts: number;
  merged: number;
  /** Decide blocks, and Check blocks in files you have not marked reviewed. */
  needs: number;
  /** Proposals whose checks are still running. */
  checking: number;
}
export function bucketSummary(
  files: { buckets: readonly ConflictBucket[]; verdict: Verdict | undefined; reviewed: boolean }[]
): BucketSummary {
  const summary: BucketSummary = { files: files.length, conflicts: 0, merged: 0, needs: 0, checking: 0 };
  for (const { buckets, verdict, reviewed } of files) {
    for (const bucket of buckets) {
      summary.conflicts++;
      if (bucket === 'merged') summary.merged++;
      else if (bucket === 'decide' || (bucket === 'check' && !reviewed)) summary.needs++;
      // Only a proposal is in Check: with no verdict yet, its checks are running.
      if (bucket === 'check' && !verdict) summary.checking++;
    }
  }
  return summary;
}
/** "3 files conflict. 7 of 9 conflicts are merged and checked. 2 need you." */
export function summarySentence(s: BucketSummary) {
  const files = s.files === 1 ? '1 file conflicts.' : `${s.files} files conflict.`;
  const merged = s.merged
    ? ` ${s.merged} of ${s.conflicts} ${s.conflicts === 1 ? 'conflict is' : 'conflicts are'} merged and checked.`
    : '';
  const needs = s.checking
    ? ` Checking ${s.checking} ${s.checking === 1 ? 'result' : 'results'}…`
    : s.needs
      ? ` ${s.needs} ${s.needs === 1 ? 'needs' : 'need'} you.`
      : ' Nothing needs you.';
  return files + merged + needs;
}
