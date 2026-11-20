import { inferChoices, parseConflicts, type ConflictSegment } from './conflict-blocks';
import { hasConflictMarkers, type ConflictFile } from './conflict-resolution';
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
 * parses where both sides parsed; no definition either side kept is lost; no definition is duplicated. Blocks with no
 * proposal take the PR's lines for the parse, and a definition that only main's side of such a block holds is not
 * expected. Your own earlier resolutions stay Merged in files Gnosis has no grammar for; structural merge does not.
 */
export async function verifyProposals(
  file: Pick<ConflictFile, 'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals'>,
  analyse: Analyse
): Promise<Verdict> {
  const proposals = file.proposals ?? [];
  const segments = parseConflicts(file.original);
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
  if (result.errors && !ours.errors && !theirs.errors) return { merged: false, note: 'The result doesn’t parse.' };
  const [b, o, t, r] = parsed.map((p) => symbols(p.definitions));
  const name = (key: string) => key.slice(key.lastIndexOf('.') + 1).replace(/^\S+ /, '');
  for (const key of new Set([...o.keys(), ...t.keys()])) {
    const [inBase, inOurs, inTheirs, inResult] = [b, o, t, r].map((m) => m.get(key) ?? 0);
    // A side that removed one meant to: only what both sides kept is expected.
    const expected = inOurs < inBase || inTheirs < inBase ? Math.min(inOurs, inTheirs) : Math.max(inOurs, inTheirs);
    if (inResult < expected && !open.some((s) => s.block.theirs.includes(name(key))))
      return { merged: false, note: `${name(key)} is missing from the result.` };
    if (inResult > Math.max(inOurs, inTheirs, inOurs + inTheirs - inBase))
      return { merged: false, note: `${name(key)} is defined twice in the result.` };
  }
  return { merged: true, note: 'The file parses. No definition was lost.' };
}

/**
 * Each conflict block's bucket in the displayed draft. A block that still holds its proposal is Merged when the
 * checks passed, else Check; `verdict` undefined means the checks are still running. A block you chose is Decided.
 * A draft edited by hand counts its remaining markers as Decide and the rest as Decided.
 */
export function blockBuckets(
  file: Pick<ConflictFile, 'original' | 'proposals' | 'unsupported'>,
  contents: string,
  verdict: Verdict | undefined
): ConflictBucket[] {
  if (file.unsupported) return ['decide'];
  const segments = parseConflicts(file.original);
  const choices = inferChoices(segments, contents, file.proposals);
  const blocks = segments.filter((s) => s.kind === 'conflict');
  if (!choices) {
    const open = parseConflicts(contents).filter((s) => s.kind === 'conflict').length;
    return blocks.map((_, i) => (i < open ? 'decide' : 'decided'));
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
