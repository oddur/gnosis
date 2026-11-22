import { diffArrays } from 'diff';
import { blockResolutions } from './conflict-carry';
import {
  conflictCount,
  identifierPattern,
  inferChoices,
  parseConflicts,
  textLines,
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
import { commaUnion, layoutTokens, orderFree, unionNote, unionOf } from './conflict-union';
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
}
/**
 * The verdict with the type check's new errors (#445 item 24): every Merged proposal in the file is Check, with the
 * compiler's error as its note. A verdict without Merged proposals is unchanged.
 */
export function withTypeError(verdict: Verdict | undefined, note: string | undefined): Verdict | undefined {
  if (!verdict || note === undefined || !(verdict.merged || verdict.blocks?.some((block) => block?.merged)))
    return verdict;
  return {
    ...verdict,
    merged: false,
    note: verdict.merged ? note : verdict.note,
    ...(verdict.blocks
      ? { blocks: verdict.blocks.map((block) => (block?.merged ? { merged: false, note } : block)) }
      : {}),
  };
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
  /** Where every conflict landed, as `regions` holds the proposals'. */
  const spans = new Map<number, [number, number]>();
  for (const s of segments) {
    const proposal = s.kind === 'conflict' && !except.has(s.index) ? proposals[s.index] : undefined;
    const part = s.kind === 'text' ? s.text : proposal ? proposal.text : s.block[side];
    if (s.kind === 'conflict') {
      const lines = newlines(part) + (part && !part.endsWith('\n') ? 1 : 0);
      const span: [number, number] = lines ? [line, line + lines - 1] : [line - 1, line];
      spans.set(s.index, span);
      if (proposal) regions.set(s.index, span);
    }
    text += part;
    line += newlines(part);
  }
  return { text, regions, spans };
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
  const verdict = (passed: (index: number) => string): Verdict => {
    // A model proposal (lib/conflict-model.ts) is never Merged: after every check it is still one to read. A check it
    // failed says so first.
    for (const s of proposed)
      if (proposals[s.index]?.source === 'model') fail(s.index, `${MODEL_UNCHECKED} ${passed(s.index)}`);
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
    };
  };
  // A 'moved' proposal (lib/conflict-moved.ts) is a whole file, checked by verifyWholeFile. Per conflict it is never
  // Merged.
  for (const s of proposed)
    if (!whole && proposals[s.index]?.source === 'moved')
      fail(s.index, 'A moved definition is proposed for the whole file. Read it before you use it.');
  const language = syntaxLanguage(file.path);
  if (!language) {
    // Your own earlier resolutions stay Merged; nothing else can be checked.
    for (const s of proposed)
      if (proposals[s.index]?.source !== 'rerere')
        fail(s.index, 'Gnosis can’t parse this file type, so it couldn’t check the result.');
    return verdict(() => 'Same as you resolved before. Gnosis can’t parse this file type.');
  }
  // Each union's two insertions, as lines of the probe, to read as whole syntax nodes. A structural merge whose result
  // is both sides' insertions at one place, each side's lines together (either side first), is read the same way: the
  // nodes may show its order doesn't matter (#476).
  const unions = proposed.flatMap((s) => {
    const proposal = proposals[s.index];
    const union =
      proposal?.source === 'union'
        ? unionOf(s.block)
        : proposal?.source === 'mergiraf'
          ? (unionOf(s.block) ?? commaUnion(s.block))
          : undefined;
    if (!union || !proposal) return [];
    const { before, ours: o, theirs: t } = union;
    if (proposal.source === 'union')
      return [
        {
          index: s.index,
          own: true,
          first: 'ours' as const,
          spans: [
            [before, before + o - 1],
            [before + o, before + o + t - 1],
          ] as [number, number][],
        },
      ];
    // The result is the ancestor's lines before, one side's lines, the other's, the ancestor's lines after, each exactly
    // as written, blank lines inside them included. Only where two of those parts meet may blank lines differ: there they
    // stand between whole nodes. And only the last line of the side placed first may gain a trailing comma, as a JSON
    // object or an enum needs before the other side's lines; not in Python or YAML, where a comma can mean something.
    const lines = union.text.split(/(?<=\n)/);
    const [lead, mine, theirs, rest] = [
      lines.slice(0, before),
      lines.slice(before, before + o),
      lines.slice(before + o, before + o + t),
      lines.slice(before + o + t),
    ];
    const blank = (line: string) => line.trim() === '';
    const trim = (part: string[]) => {
      let [from, to] = [0, part.length];
      while (from < to && blank(part[from])) from++;
      while (to > from && blank(part[to - 1])) to--;
      return part.slice(from, to);
    };
    const written = proposal.text.split(/(?<=\n)/);
    const commas = language !== 'python' && language !== 'yaml';
    /** Where each of the two sides' parts landed, or undefined when the result is not these parts. */
    const place = (one: string[], two: string[]) => {
      const parts = [trim(lead), trim(one), trim(two), trim(rest)];
      const spans: [number, number][] = [];
      let at = 0;
      for (const [k, part] of parts.entries()) {
        if (k > 0) while (at < written.length && blank(written[at])) at++;
        const start = at;
        for (const [i, want] of part.entries()) {
          const have = written[at++] as string | undefined;
          const slack = commas && k === 1 && i === part.length - 1;
          if (have !== want && !(slack && have === want.replace(/(\s*)$/, (end) => `,${end}`))) return undefined;
        }
        if (k === 1 || k === 2) spans.push([start, at - 1]);
      }
      while (at < written.length && blank(written[at])) at++;
      return at === written.length && spans.every(([a, z]) => z >= a) ? spans : undefined;
    };
    const asOurs = place(mine, theirs);
    const asTheirs = asOurs ? undefined : place(theirs, mine);
    const first = asOurs ? ('ours' as const) : asTheirs ? ('theirs' as const) : undefined;
    const spans = asOurs ?? asTheirs;
    if (!first || spans?.length !== 2) return [];
    const [one, two] = spans;
    return [{ index: s.index, own: false, first, spans: first === 'ours' ? [one, two] : [two, one] }];
  });
  /** Each entry's insertions as lines of the probe: the PR's, then main's, wherever each landed. */
  const unionRanges = (regions: ReadonlyMap<number, [number, number]>) =>
    unions.length
      ? unions.flatMap(({ index, spans }) => {
          const start = regions.get(index)?.[0] ?? 0;
          return spans.map(([a, z]) => [start + a, start + z] as [number, number]);
        })
      : undefined;
  let parsed: ParsedText[];
  /** Which side doesn't parse: then the parser can't clear the result, and the checks compare errors instead. */
  let sideBroken: 'The PR' | 'Main' | 'Neither side' | undefined;
  /** The proposal is one side's lines exactly: whatever that side's lines do to the parse, the side did too. */
  const doesnt = () =>
    sideBroken === 'Neither side' ? 'Neither side parses' : `${sideBroken ?? 'A side'} doesn’t parse`;
  const exactSide = (c: Conflict) => {
    const text = proposals[c.index]?.text;
    return text === c.block.ours || text === c.block.theirs;
  };
  try {
    parsed = await Promise.all([
      ...[file.base, file.ours, file.theirs].map((text) => analyse(language, text)),
      analyse(language, probe.text, unionRanges(probe.regions)),
    ]);
    const [, ours, theirs, result] = parsed;
    sideBroken = ours.errors ? (theirs.errors ? 'Neither side' : 'The PR') : theirs.errors ? 'Main' : undefined;
    /** Every entry of `part` is in `whole`, as often. */
    const within = (part: readonly string[], whole: readonly string[]) => {
      const pool = [...whole];
      return part.every((entry) => {
        const at = pool.indexOf(entry);
        if (at >= 0) pool.splice(at, 1);
        return at >= 0;
      });
    };
    /** The file with every proposal replaced by each side's lines, parsed once, both sides at once. */
    let filledSides:
      | Promise<{ side: 'ours' | 'theirs'; filled: ReturnType<typeof fill>; read: ParsedText }[]>
      | undefined;
    const sideFills = () =>
      (filledSides ??= Promise.all(
        (['ours', 'theirs'] as const).map(async (side) => {
          const filled = fill(segments, proposals, side, new Set(proposed.map((c) => c.index)));
          return { side, filled, read: await analyse(language, filled.text) };
        })
      ));
    /**
     * The file's errors as the text around the conflicts they cover, one entry per error range, so two fillings of the
     * conflicts compare. Undefined when the parser can't say where they are.
     */
    const errorSet = async (filled: ReturnType<typeof fill>, parsedAlready?: ParsedText) => {
      const read = parsedAlready ?? (await analyse(language, filled.text));
      if (!read.errors) return [];
      if (!read.errorLines?.length) return undefined;
      const lines = filled.text.split('\n');
      const spans = [...filled.spans.values()];
      const inConflict = (line: number) => spans.some(([a, z]) => a <= line && line <= z);
      return read.errorLines
        .map(([start, end]) =>
          lines
            .slice(start - 1, end)
            .filter((_, i) => !inConflict(start + i))
            .map((line) => line.trim())
            .join('\n')
        )
        .sort();
    };
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
    } else if (result.errors && (ours.errors || theirs.errors)) {
      // A side that doesn't parse can't clear the result. An error that reaches a proposal is the proposal's when the
      // proposal wrote lines neither side had, or when the file has fewer errors with either side's lines in its place;
      // otherwise the error is the side's own. Your own earlier resolutions are not held to the line accounting, so this
      // is the only check that sees them break the file. Errors the sides' own lines don't give, that no proposal
      // accounts for, fail every proposal in the file.
      const ranges = result.errorLines;
      if (!ranges?.length) return { merged: false, note: 'The result doesn’t parse.' };
      const sides = await sideFills();
      /** Error ranges in a parse; errors the parser can't place count as too many. */
      const errorCount = (read: ParsedText) => (read.errors ? read.errorLines?.length || Infinity : 0);
      /**
       * The errors left with `blamed` replaced by a side's lines are ones that side's own lines give, around the
       * conflicts, with every proposal replaced. Checked against either side.
       */
      const explained = async (blamed: ReadonlySet<number>) => {
        for (const { side, filled, read } of sides) {
          // With nothing blamed, the PR's filling is the result as parsed above.
          const [left, own] = await Promise.all([
            !blamed.size && side === 'ours'
              ? errorSet(probe, parsed[3])
              : errorSet(fill(segments, proposals, side, blamed)),
            errorSet(filled, read),
          ]);
          if (left && own && within(left, own)) return true;
        }
        return false;
      };
      const suspects = [...probe.regions]
        .filter(([, [a, z]]) => ranges.some(([start, end]) => a <= end && z >= start))
        .map(([index]) => index);
      const conflictOf = (index: number) => conflicts.find((c) => c.index === index)?.block;
      /** Lines the proposal wrote that neither side nor the ancestor had: inside an error, they are not cleared. */
      const written = (index: number) => {
        const block = conflictOf(index);
        const known = new Set(
          [block?.base ?? '', block?.ours ?? '', block?.theirs ?? ''].flatMap((t) =>
            t.split(/\r?\n/).map((l) => l.trim())
          )
        );
        return (proposals[index]?.text ?? '').split(/\r?\n/).some((l) => l.trim() && !known.has(l.trim()));
      };
      for (const index of suspects) {
        if (written(index)) {
          fail(index, 'This result doesn’t parse.');
          continue;
        }
        const counts = await Promise.all(
          (['ours', 'theirs'] as const).map(async (side) =>
            errorCount(await analyse(language, fill(segments, proposals, side, new Set([index])).text))
          )
        );
        // Errors the parser can't place can't be compared: the proposal is blamed.
        if (counts.some((count) => count < ranges.length || count === Infinity))
          fail(index, 'This result doesn’t parse.');
      }
      // An error no proposal accounts for, that the sides' own lines don't give: every proposal in the file is suspect.
      if (!(await explained(new Set(suspects.filter((index) => failed.has(index))))))
        return { merged: false, note: 'The result doesn’t parse.' };
    }
    if (ours.errors || theirs.errors) {
      // A side that doesn't parse, with an error over a proposal: the parser can't vouch for that proposal, whether the
      // result parses or not, unless the proposal is one side's lines exactly.
      const filledBoth = await sideFills();
      // Only the fillings that have errors say what the broken side's lines do: with one side broken, that side's.
      const broken = filledBoth.filter(({ side }) => (side === 'ours' ? ours : theirs).errors);
      // The result lost or changed an error the broken side's own lines give: a proposal changed how the file around it
      // parses (a brace that closes the side's open block, say). Nothing the parser said can be trusted for the proposals.
      const resultErrors = await errorSet(probe, parsed[3]);
      const sideErrors = await Promise.all(broken.map(({ filled, read }) => errorSet(filled, read)));
      if (!resultErrors || !sideErrors.some((own) => own && within(own, resultErrors)))
        for (const c of proposed)
          if (!exactSide(c)) fail(c.index, `${doesnt()} here, and the result parses differently. Check it.`);
      for (const { filled, read } of filledBoth) {
        if (!read.errors) continue;
        for (const c of proposed) {
          if (exactSide(c)) continue;
          const span = filled.spans.get(c.index);
          if (!read.errorLines?.length || (span && read.errorLines.some(([a, z]) => span[0] <= z && span[1] >= a)))
            fail(c.index, `${doesnt()} around this conflict, so Gnosis couldn’t check it.`);
        }
      }
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
  const texts = [file.base, file.ours, file.theirs, probe.text];
  const moved = whole ? lostEdit(texts, parsed) : undefined;
  if (moved) return { merged: false, note: moved };
  // A 'moved' proposal (lib/conflict-moved.ts) may rename the definition, which lostEdit can't see.
  const renamed = whole && proposals[0]?.source === 'moved' ? renamedEdit(texts, parsed) : undefined;
  if (renamed) return { merged: false, note: renamed };
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
        : (accountLines(s.block, proposal.text, indented, proposal.source === 'union') ??
          (indented ? undefined : accountLines(s.block, proposal.text, true, proposal.source === 'union')));
      // The PR's version of a change both sides may have made (lib/conflict-union.ts) is Merged only on the syntax
      // trees' word, never on the line count, which ignores trailing commas.
      const same = proposal.source === 'same';
      // Both sides inserted at one place, which the line checks never pass. Merged only when the syntax nodes show the
      // order can't matter (orderFree) and the result is each side's lines together, as a union is accounted.
      const k = unions.findIndex((u) => u.index === s.index && !u.own);
      if (note === SAME_LINES && k >= 0 && !whole && probe.regions.has(s.index)) {
        const units = result.units;
        const [mine, theirs] = [units?.[2 * k], units?.[2 * k + 1]];
        const block = unions[k].first === 'ours' ? s.block : { ...s.block, ours: s.block.theirs, theirs: s.block.ours };
        const counted =
          accountLines(block, proposal.text, indented, true) ??
          (indented ? undefined : accountLines(block, proposal.text, true, true));
        if (orderFree(language, mine, theirs, { path: file.path }) && counted === undefined) {
          const imports = [...(mine?.units ?? []), ...(theirs?.units ?? [])].every((u) =>
            /import|use_|using|comment/.test(u.type)
          );
          reformats.set(
            s.index,
            `Both sides added different ${imports ? 'imports' : 'members'} here, and their order doesn’t matter.`
          );
          continue;
        }
      }
      if ((note === SAME_LINES || same) && !whole) {
        const formatted = await reformatted(segments, s.index, proposal.text, language, equivalent, same);
        if (formatted?.merged) {
          reformats.set(s.index, formatted.note);
          continue;
        }
        note = formatted?.note ?? (same ? NOT_SAME : note);
      }
      if (note) fail(s.index, note);
    }
    // A union is never Merged. Its note comes from the syntax nodes each side added, when they were read; an earlier
    // failure on the block wins.
    for (const s of proposed) {
      if (proposals[s.index]?.source !== 'union') continue;
      const k = unions.findIndex((u) => u.index === s.index && u.own);
      // A union set aside for a parse error was not in the text these units came from.
      const units = k >= 0 && probe.regions.has(s.index) ? result.units : undefined;
      fail(s.index, unionNote(language, units?.[2 * k], units?.[2 * k + 1]));
    }
    for (const [index, note] of [
      ...danglingNames(file, segments),
      ...duplicateMembers(segments, proposals),
      ...strayLines(segments, proposals),
    ])
      fail(index, note);
  }
  const accounted = proposals.some((p) => p && p.source !== 'rerere');
  // With a side broken, a result is cleared of adding parse errors only when no proposal in the file was found adding one.
  const parseFailed = [...failed.values()].some((note) => /parse/.test(note));
  const parses = !sideBroken
    ? 'The file parses.'
    : parseFailed
      ? `${doesnt()}, so Gnosis couldn’t check how this result parses.`
      : `${doesnt()}; the result adds no parse errors of its own.`;
  return verdict((index) => {
    const own = reformats.get(index);
    if (own) return `${own} ${parses}`;
    return accounted ? `${parses} Every line of both sides is accounted for.` : parses;
  });
}

/** A model proposal's note when it passed every check: it is still never Merged. */
export const MODEL_UNCHECKED = 'A model wrote this. Read it before you use it.';
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
 * only until the proposal is taken back (src/conflict-checks.ts withoutUnconfirmed).
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
  if (proposal.source === 'moved') {
    // One side moved or renamed a function and the other edited it (lib/conflict-moved.ts). Always Check, never Merged,
    // until its false positives are measured: other files may still call the old name, and nothing here reads them.
    if (!verdict.merged)
      return { merged: false, note: `${verdict.note} Read it before you use it, or resolve conflict by conflict.` };
    return {
      merged: false,
      passed: true,
      note: `${proposal.note ?? 'One side moved this definition, and the other edited it.'} Gnosis applied the edit at the new place. The result parses and keeps every change from both sides. ${MOVED_UNCHECKED}`,
    };
  }
  return verdict.merged
    ? {
        merged: false,
        passed: true,
        note: 'Mergiraf moved lines outside the conflict. The result parses and keeps every change from both sides. Read it, then use it.',
      }
    : { merged: false, note: `${verdict.note} Read it before you use it, or resolve conflict by conflict.` };
}

/** What a 'moved' proposal can't know: the moved or renamed definition's callers in other files. */
export const MOVED_UNCHECKED = 'Call sites in other files were not checked.';

/**
 * A definition one side renamed (and moved) and the other side edited comes out once, under the new name, as the
 * editing side wrote it with the name changed. lostEdit reads definitions by name, so it can't see a rename. A rename
 * is a definition the moving side lost, and exactly one new one there whose body is the ancestor's with the name
 * changed. Reads the parses of the ancestor, both sides and the result (`texts`, in that order) that the checks already
 * made. Undefined when it passes, or when no such rename is found.
 */
function renamedEdit(texts: readonly string[], parsed: readonly ParsedText[]): string | undefined {
  const read = (i: number) => {
    const lines = textLines(texts[i]);
    const definitions = parsed[i].definitions;
    return definitions.map((d) => ({
      key: symbolKey(definitions, d),
      name: d.name,
      kind: d.kind,
      body: lines
        .slice(d.start - 1, d.end)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n'),
    }));
  };
  const [base, ours, theirs, merged] = [0, 1, 2, 3].map(read);
  const rename = (body: string, from: string, to: string) => body.replace(identifierPattern(from), () => to);
  for (const [mover, editor, who] of [
    [ours, theirs, 'main'],
    [theirs, ours, 'the PR'],
  ] as const) {
    for (const old of base) {
      if (!old.name || base.filter((d) => d.key === old.key).length !== 1 || mover.some((d) => d.key === old.key))
        continue;
      const edited = editor.filter((d) => d.key === old.key);
      if (edited.length !== 1 || edited[0].body === old.body) continue;
      const known = new Set([...base, ...editor].map((d) => d.key));
      const targets = mover.filter(
        (d) => d.kind === old.kind && d.name && !known.has(d.key) && d.body === rename(old.body, old.name, d.name)
      );
      if (targets.length !== 1) continue;
      const [to] = targets;
      const out = merged.filter((d) => d.key === to.key);
      if (merged.some((d) => d.key === old.key)) return `${old.name} is still in the result after its rename.`;
      if (out.length !== 1 || out[0].body !== rename(edited[0].body, old.name, to.name))
        return `${to.name} in the result doesn’t match ${who}’s change to ${old.name}.`;
    }
  }
  return undefined;
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
 * the result; lines either side added must be in it; lines a side deleted must be gone; nothing else may appear; and
 * the lines keep the ancestor's order (outOfOrder). Where both sides changed the same ancestor lines differently, the
 * block is a real conflict and nothing is Merged. Blank lines, trailing commas and whitespace are ignored; in Python and
 * YAML, indentation counts.
 */
export function accountLines(
  block: { base?: string; ours: string; theirs: string },
  result: string,
  indented: boolean,
  /** A union (lib/conflict-union.ts): both sides' insertions at one place, the PR's first. Never Merged on its own. */
  union = false
): string | undefined {
  if (block.base === undefined) return 'Gnosis couldn’t see the lines before both changes.';
  const { lines, report } = lineAccount(indented);
  const [base, ours, theirs, merged] = [block.base, block.ours, block.theirs, result].map(lines);
  const [mine, other] = [changesOf(base, ours), changesOf(base, theirs)];
  const inside = (gap: number, c: LineChange) => c.start < gap && gap < c.end;
  // An insertion right before or after the other side's change of several lines: which of those lines it belongs
  // next to (inside a block the change opens, or after it) is not something the ancestor says.
  const several = (c: LineChange) => c.end > c.start && (c.end - c.start > 1 || c.added.length > 1);
  const touches = (p: LineChange, c: LineChange) =>
    p.start === p.end && several(c) && (p.start === c.start || p.start === c.end);
  for (const a of mine)
    for (const b of other) {
      if (sameChange(a, b)) continue;
      const overlap = a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;
      if (
        overlap ||
        (a.start === a.end && inside(a.start, b)) ||
        (b.start === b.end && inside(b.start, a)) ||
        touches(a, b) ||
        touches(b, a)
      )
        return SAME_LINES;
    }
  const removed = new Set<number>();
  for (const c of [...mine, ...other]) for (let i = c.start; i < c.end; i++) removed.add(i);
  const expected = new Map<string, number>();
  const add = (line: string) => expected.set(line, (expected.get(line) ?? 0) + 1);
  base.forEach((line, i) => !removed.has(i) && add(line));
  for (const c of mine) c.added.forEach(add);
  for (const c of other) if (!mine.some((m) => sameChange(m, c))) c.added.forEach(add);
  const found = new Map<string, number>();
  for (const line of merged) found.set(line, (found.get(line) ?? 0) + 1);
  const missing = [...expected].filter(([line, n]) => (found.get(line) ?? 0) < n).map(([line]) => line);
  const extra = [...found].find(([line, n]) => n > (expected.get(line) ?? 0))?.[0];
  return report(missing, extra, { base, ours, theirs }) ?? outOfOrder(base, merged, mine, other, removed, union);
}
/**
 * The result keeps the ancestor's order, anchor by anchor. Each change sits at one place in the ancestor: lines inserted
 * in the gap before an ancestor line, or lines that replace a run of them. Walking the ancestor, the result must hold,
 * in turn, what was inserted in each gap and then the line itself, as kept or as replaced. Where both sides inserted
 * lines in the same gap, no order is the ancestor's: the block is Both sides changed the same lines (Check), except a
 * union's own layout, which the union rule keeps in Check anyway. Line counts alone miss two statements swapped, or a
 * line moved past the other side's change. Changes both sides made alike count once.
 */
function outOfOrder(
  base: readonly string[],
  merged: readonly string[],
  mine: LineChange[],
  other: LineChange[],
  /** The ancestor lines either side changed. */
  removed: ReadonlySet<number>,
  /** Lines both sides inserted at one place are checked as a union lays them out, the PR's first. */
  union: boolean
) {
  /** Each side's insertions and replacements, by the ancestor place they start at. */
  const byStart = (changes: LineChange[]) => {
    const inserted = new Map<number, string[]>();
    const replaced = new Map<number, LineChange>();
    for (const c of changes)
      if (c.start === c.end) inserted.set(c.start, c.added);
      else replaced.set(c.start, c);
    return { inserted, replaced };
  };
  const [a, b] = [byStart(mine), byStart(other.filter((c) => !mine.some((m) => sameChange(m, c))))];
  let r = 0;
  /** The next lines of the result are exactly `lines`. */
  const take = (lines: readonly string[]) => {
    for (const line of lines) if (merged[r++] !== line) return false;
    return true;
  };
  for (let at = 0; at <= base.length; at++) {
    const [x, y] = [a.inserted.get(at) ?? [], b.inserted.get(at) ?? []];
    // Both sides inserted lines at this place. Neither order is the ancestor's, and every order checked so far has
    // let something wrong through: such a block is a choice to check, never Merged on the line checks.
    if (x.length && y.length && !union) return SAME_LINES;
    if (!take([...x, ...y])) return ORDER;
    if (at === base.length) break;
    const change = a.replaced.get(at) ?? b.replaced.get(at);
    if (change) {
      if (!take(change.added)) return ORDER;
    } else if (!removed.has(at) && !take([base[at]])) return ORDER;
  }
  if (r !== merged.length) return ORDER;
}
const ORDER = 'The result changes the order of lines from the PR or main.';

/** A side's edits against the ancestor: each replaces ancestor lines [start, end) with `added`. */
export interface LineChange {
  start: number;
  end: number;
  added: string[];
}
/** Both sides made this change alike. */
const sameChange = (a: LineChange, b: LineChange) =>
  a.start === b.start && a.end === b.end && a.added.join('\n') === b.added.join('\n');
export function changesOf(base: readonly string[], side: readonly string[]): LineChange[] {
  const changes: LineChange[] = [];
  let at = 0;
  let open: LineChange | undefined;
  for (const part of diffArrays([...base], [...side])) {
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
export const CHECKS_VERSION = 10;
const proposalKeys = new WeakMap<object, string>();
/**
 * A cheap fingerprint of a file's conflict, proposals and draft (FNV-1a and length), remembered per file object. A
 * check result counts only for the proposals it checked, beside the choices it checked them with. When given, the path
 * and the three versions the checks read count too (#464), so a verdict never outlives a file whose sides changed.
 */
export function proposalKey(
  file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile'> &
    Partial<Pick<ConflictFile, 'result' | 'path' | 'base' | 'ours' | 'theirs'>>
) {
  let key = proposalKeys.get(file);
  if (key === undefined) {
    const proposals = [...(file.proposals ?? []), ...(file.wholeFile ? [null, file.wholeFile] : [])];
    const sides = [file.path, file.base, file.ours, file.theirs];
    const text = [
      file.original,
      ...proposals.map((p) => (p ? `${p.source}\u0001${p.text}` : '')),
      // The draft matters only to per-conflict checks; a whole-file check ignores it.
      `\u0002${file.wholeFile ? '' : (file.result ?? '')}`,
      // Without them (typeCheckKey), the key is the one it always was.
      ...(sides.some((side) => side !== undefined)
        ? [`\u0003${sides.map((side) => side ?? '\u0004').join('\u0003')}`]
        : []),
    ].join('\u0000');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    key = `${(hash >>> 0).toString(36)}:${text.length}`;
    proposalKeys.set(file, key);
  }
  return key;
}

/** The proposals a type check result belongs to: Git's conflict and the proposals, never the draft. */
export const typeCheckKey = (file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile'>) =>
  proposalKey({ original: file.original, proposals: file.proposals, wholeFile: file.wholeFile });
/** The type check's note for a file, while its proposals are the ones it checked. */
export const typeErrorNote = (file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile' | 'typeError'>) =>
  file.typeError && file.typeError.key === typeCheckKey(file) ? file.typeError.note : undefined;

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
      if (proposal && text === proposal.text)
        return proposal.source !== 'model' && blockVerdict(verdict, s.index)?.merged ? 'merged' : 'check';
      if (proposal && text === undefined) return 'check';
      if (texts) return text === undefined ? 'decide' : 'decided';
      return open-- > 0 ? 'decide' : 'decided';
    });
  }
  return blocks.map((s) => {
    const pick = choices[s.index];
    // A model proposal is never Merged, whatever a verdict says (lib/conflict-model.ts).
    if (pick === 'proposal')
      return file.proposals?.[s.index]?.source !== 'model' && blockVerdict(verdict, s.index)?.merged
        ? 'merged'
        : 'check';
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
