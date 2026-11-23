/**
 * The resolver audit (#445 item 19). Runs each resolver and rule over the conflict lab's cases (tests/fixtures/conflicts
 * and a sample of the generated matrix), as the conflict service does, then mutates every result the checks pass:
 * a dropped or duplicated definition, a broken parse, a line dropped from either side, two lines swapped inside a
 * function, a one-line unit repeated or two of one side's swapped (#481), a changed string or number, and text outside the conflict touched. Every mutation must fail the checks:
 * it must never end Merged (lib/conflict-verify.ts). Pure library code; scripts/conflict-resolver-audit.ts prints it,
 * and tests/conflict-resolver-audit.test.ts runs it with `npm test`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as TreeSitter from 'web-tree-sitter';
import { blockProposals, withProposals } from '../lib/conflict-carry';
import { parseConflicts, type ConflictSegment } from '../lib/conflict-blocks';
import { hasConflictMarkers, type ConflictFile, type ConflictProposal } from '../lib/conflict-resolution';
import { withUnions } from '../lib/conflict-union';
import { blockBuckets, blockVerdict, changesOf, SAME_CHANGE, type Verdict } from '../lib/conflict-verify';
import { createSyntaxEngine, syntaxLanguage, type SyntaxLanguage } from '../lib/syntax-scope';
import { conflictChecker, moveProposer, withoutUnconfirmed, type CheckedFile } from '../src/conflict-checks';
import { runConflictProcess } from '../src/conflict-process';
import { casePlan, gitRunner, loadCases, root } from './conflict-lab-lib.mjs';
import { generateMatrix } from './conflict-lab-generate.mjs';

/** Who wrote a result: a resolver, or a rule the checks apply to a structural merge's proposal. */
/** `model` (lib/conflict-model.ts) is never Merged by construction, and the audit has no model to run: it has no row. */
export type Resolver = 'mergiraf' | 'reformat' | 'same' | 'union' | 'rerere' | 'whole-file' | 'moved' | 'model';
export const RESOLVERS: Resolver[] = ['mergiraf', 'reformat', 'same', 'union', 'rerere', 'whole-file', 'moved'];
export type MutationKind =
  | 'drop-definition'
  | 'duplicate-definition'
  | 'broken-parse'
  | 'drop-pr-line'
  | 'drop-main-line'
  | 'swap-order'
  | 'interleave-sides'
  | 'cross-anchor'
  | 'definition-into-definition'
  | 'duplicate-unit'
  | 'swap-units'
  | 'change-context'
  | 'change-number'
  | 'change-string'
  | 'touch-outside';
export const MUTATIONS: MutationKind[] = [
  'drop-definition',
  'duplicate-definition',
  'broken-parse',
  'drop-pr-line',
  'drop-main-line',
  'swap-order',
  'interleave-sides',
  'cross-anchor',
  'definition-into-definition',
  'duplicate-unit',
  'swap-units',
  'change-context',
  'change-number',
  'change-string',
  'touch-outside',
];
/**
 * Mutations a remembered resolution may make on purpose: it is your own earlier resolution of the same conflict (Git's
 * rerere matches the conflict's exact text), and you may have dropped a side, reordered, repeated or edited it. The checks hold it
 * only to parsing, no duplicated definition and no text outside the conflict.
 */
export const REMEMBERED_OWN: ReadonlySet<MutationKind> = new Set([
  'drop-definition',
  'drop-pr-line',
  'drop-main-line',
  'swap-order',
  'swap-units',
  'duplicate-unit',
  'interleave-sides',
  'cross-anchor',
  'change-number',
  'change-string',
]);

/**
 * `caught`: a check failed. `held`: no check failed, but the resolver is never Merged (a union is always in Check). `own`:
 * a remembered resolution that may do this on purpose (REMEMBERED_OWN). `escaped`: the mutation ended Merged, or a whole-file
 * proposal passed its checks.
 */
export type Outcome = 'caught' | 'held' | 'own' | 'escaped';
export interface MutationResult {
  case: string;
  path: string;
  block: number;
  resolver: Resolver;
  mutation: MutationKind;
  outcome: Outcome;
  /** The check's note, or why it escaped. */
  note: string;
  /** Which check caught it (checkOf), for a caught mutation. */
  check?: string;
  /** The mutated result, for an escape. */
  text?: string;
}
export interface Baseline {
  case: string;
  path: string;
  block: number;
  resolver: Resolver;
  /** The resolver's own result passed the checks (Merged, a union in Check for its own reason, a whole file `passed`). */
  passed: boolean;
  note: string;
}
export interface AuditReport {
  cases: number;
  files: number;
  baselines: Baseline[];
  results: MutationResult[];
  /** Cases that could not run, with why. */
  errors: string[];
  ms: number;
}

const require = createRequire(import.meta.url);
const assets = path.join(root, 'src/assets/tree-sitter');
export const MERGIRAF = path.join(
  root,
  'resources/mergiraf/runtime',
  process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'
);
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});

interface LabCase {
  name: string;
  dir?: string;
  meta: {
    mergiraf?: string;
    languagesOff?: SyntaxLanguage[];
    stack?: string[];
  };
  trees: Record<string, Map<string, Buffer> | undefined>;
}
/** One merge of a case: three trees and the known-correct resolution, by path. */
interface Merge {
  name: string;
  base: Map<string, Buffer>;
  ours: Map<string, Buffer>;
  theirs: Map<string, Buffer>;
  resolved?: Map<string, Buffer>;
  canned?: string;
  disabled: SyntaxLanguage[];
  /** Mergiraf is replaced by a stand-in: only the move rule, which runs without it, has a result to audit. */
  standIn?: boolean;
}
/** Mergiraf replaced by a script: only `canned` (a wrong output replayed by hand) says anything about the checks. */
const STAND_INS = new Set(['hang', 'timeout', 'fail', 'missing', 'garbage']);
function merges(c: LabCase): Merge[] {
  const standIn = !!c.meta.mergiraf && STAND_INS.has(c.meta.mergiraf);
  const disabled = c.meta.languagesOff ?? [];
  const canned = c.meta.mergiraf === 'canned' && c.dir ? path.join(c.dir, 'canned') : undefined;
  const base = c.trees.base ?? new Map<string, Buffer>();
  const theirs = c.trees.theirs ?? new Map<string, Buffer>();
  // A stack's lowest PR against main; the PRs above it repeat its conflict.
  const [first] = casePlan(c) as { step: string; tree?: Map<string, Buffer> }[];
  const ours = first.tree ?? new Map<string, Buffer>();
  const resolvedSteps = c.trees.resolvedSteps as unknown as Record<string, Map<string, Buffer>> | undefined;
  const resolved = c.meta.stack ? resolvedSteps?.[first.step] : c.trees.resolved;
  const list: Merge[] = [{ name: c.name, base, ours, theirs, resolved, canned, disabled, standIn }];
  const theirs2 = c.trees.theirs2;
  if (theirs2)
    list.push({ name: `${c.name} (after-move)`, base, ours, theirs: theirs2, resolved: c.trees.resolved2, disabled });
  return list;
}

const utf8 = (data: Buffer | undefined) => {
  if (!data || data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
};
/** Git's conflict for one file, as `git merge-tree` with diff3 markers writes it; undefined when it merges cleanly. */
async function gitConflict(dir: string, texts: [string, string, string]) {
  const names = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
  await Promise.all(names.map((n, i) => fs.writeFile(n, [texts[1], texts[0], texts[2]][i])));
  const git = gitRunner(dir);
  const allowed = Array.from({ length: 128 }, (_, i) => i);
  const { code, stdout } = (await git(
    ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'Common ancestor', '-L', 'theirs', ...names],
    { allowed, encoding: 'buffer' }
  )) as { code: number; stdout: Buffer };
  if (!code) return undefined;
  return stdout.toString('utf8');
}
async function structuralMerge(
  dir: string,
  file: { path: string; base: string; ours: string; theirs: string },
  canned?: string
) {
  if (canned) {
    const text = await fs.readFile(path.join(canned, file.path), 'utf8').catch(() => undefined);
    if (text !== undefined) return text;
  }
  const names = ['base', 'ours', 'theirs'].map((n) => path.join(dir, `m-${n}`));
  await Promise.all(names.map((n, i) => fs.writeFile(n, [file.base, file.ours, file.theirs][i])));
  const result = await runConflictProcess(
    MERGIRAF,
    [
      'merge',
      ...names,
      `--path-name=${file.path}`,
      '--timeout',
      '10000',
      '--base-name',
      'Common ancestor',
      '--left-name=ours',
      '--right-name=theirs',
    ],
    { cwd: dir, timeout: 20_000 }
  ).catch(() => undefined);
  if (!result || result.code > 1 || result.code < 0) return undefined;
  return result.stdout.toString('utf8');
}

type AuditFile = CheckedFile & { result: string; resolved: boolean; source: ConflictFile['source'] };
/**
 * A file as the service would hold it after checking: its proposals, draft and verdict. A 'same' proposal its check
 * didn't Merge is taken back, and the rest checked again (src/conflict-resolution-service.ts `check`).
 */
async function checked(file: AuditFile, disabled: SyntaxLanguage[]) {
  const check = conflictChecker(engine, disabled);
  let current = file;
  let verdict = await check(current);
  const back = withoutUnconfirmed(current, verdict);
  if (back) {
    current = { ...current, ...back } as AuditFile;
    verdict = verdict && current.proposals ? await check(current) : undefined;
  }
  return { file: current, verdict };
}
/** The file the service prepares from a resolver's whole output: per-conflict proposals, or one whole-file proposal. */
function fromOutput(
  base: Omit<AuditFile, 'proposals' | 'wholeFile' | 'result' | 'source'>,
  output: string,
  source: 'mergiraf' | 'rerere'
): AuditFile | undefined {
  const mapped = blockProposals(base.original, output, source);
  if (source === 'rerere') {
    if (!mapped) return undefined;
    return { ...base, proposals: mapped, result: withProposals(base.original, mapped), source };
  }
  const whole = !mapped && !hasConflictMarkers(output);
  if (whole)
    return { ...base, wholeFile: { source: 'mergiraf', text: output }, result: base.original, source: 'manual' };
  const proposals = withUnions(base.path, base.original, mapped);
  if (!proposals) return undefined;
  return { ...base, proposals, result: withProposals(base.original, proposals), source: 'mergiraf' };
}

/** The resolver behind one block's result: its source, or the rule that Merged a structural merge's proposal. */
function resolverOf(proposal: ConflictProposal, verdict: Verdict | undefined, index: number): Resolver {
  const note = blockVerdict(verdict, index)?.note ?? '';
  if (proposal.source !== 'mergiraf') return proposal.source;
  if (note.startsWith(SAME_CHANGE)) return 'same';
  if (/only reformatted these lines/.test(note)) return 'reformat';
  return 'mergiraf';
}
/** The notes a union gets from its own rule (lib/conflict-union.ts unionNote), not from a failed check. */
const UNION_NOTES = /^Both sides added /;

// ── Mutations ────────────────────────────────────────────────────────────────

const splitLines = (text: string) => text.split(/(?<=\n)/).filter((l) => l !== '');
const hasWord = (line: string) => /[\p{L}\p{N}_]/u.test(line);
const norm = (line: string) => line.replace(/\s+/g, '').replace(/,$/, '');
/** The text before and after conflict `index`, each other conflict as its proposal or the PR's lines. */
function around(segments: ConflictSegment[], proposals: readonly (ConflictProposal | null)[], index: number) {
  const part = (s: ConflictSegment) => (s.kind === 'text' ? s.text : (proposals[s.index]?.text ?? s.block.ours));
  const at = segments.findIndex((s) => s.kind === 'conflict' && s.index === index);
  return {
    before: segments.slice(0, at).map(part).join(''),
    after: segments
      .slice(at + 1)
      .map(part)
      .join(''),
  };
}
interface Target {
  language: SyntaxLanguage;
  /** The result being mutated: one conflict's proposal, or a whole file. */
  text: string;
  /** The text around it, to parse: `before + text + after`. */
  before: string;
  after: string;
  /** The conflict's three versions, or the file's. */
  sides: { base: string; ours: string; theirs: string };
}
type Mutant = { text: string } | { skip: string };
const replaceLines = (lines: string[], at: number, remove: number, insert: string[] = []) => {
  const next = [...lines];
  next.splice(at, remove, ...insert);
  return next.join('');
};
const withEnding = (line: string, like: string) =>
  line.replace(/\r?\n$/, '') + (/\r\n$/.test(like) ? '\r\n' : like.endsWith('\n') ? '\n' : '');

async function definitionsIn(target: Target) {
  const parsed = await engine.definitions(target.language, target.before + target.text + target.after);
  const first = target.before.split('\n').length; // the 1-based line where `text` starts
  const last = first + splitLines(target.text).length - 1;
  return { parsed, first, last };
}
/** A definition wholly inside the result: the first one, outermost. */
async function wholeDefinition(target: Target) {
  const { parsed, first, last } = await definitionsIn(target);
  const inside = parsed.definitions.filter((d) => d.start >= first && d.end <= last);
  const outer = inside.find((d) => !inside.some((x) => x !== d && x.start <= d.start && x.end >= d.end));
  return outer && { start: outer.start - first, end: outer.end - first };
}
const LINE_BREAKERS = [')]}', '= = = ;', '"unterminated'];
/** Lines the side's own text holds, by normalised text. */
const sideLines = (text: string) => new Set(splitLines(text).map(norm));

export async function mutate(kind: MutationKind, target: Target): Promise<Mutant> {
  const lines = splitLines(target.text);
  switch (kind) {
    case 'drop-definition':
    case 'duplicate-definition': {
      const d = await wholeDefinition(target);
      if (!d) return { skip: 'no whole definition in the result' };
      const body = lines.slice(d.start, d.end + 1);
      if (!body.length) return { skip: 'no whole definition in the result' };
      const last = body.at(-1) ?? '';
      if (!/\n$/.test(last)) body[body.length - 1] = withEnding(last, lines[0]);
      return kind === 'drop-definition'
        ? { text: replaceLines(lines, d.start, d.end - d.start + 1) }
        : { text: replaceLines(lines, d.end + 1, 0, body) };
    }
    case 'broken-parse': {
      if (!lines.length) return { skip: 'empty result' };
      const at = Math.floor(lines.length / 2);
      const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
      for (const breaker of LINE_BREAKERS) {
        const text = replaceLines(lines, at, 0, [withEnding(indent + breaker, lines[at] ?? '\n')]);
        const read = await engine.definitions(target.language, target.before + text + target.after);
        if (read.errors) return { text };
      }
      return { skip: 'no inserted line breaks the parse' };
    }
    case 'drop-pr-line':
    case 'drop-main-line': {
      const [mine, other] =
        kind === 'drop-pr-line' ? [target.sides.ours, target.sides.theirs] : [target.sides.theirs, target.sides.ours];
      const [own, others, base] = [sideLines(mine), sideLines(other), sideLines(target.sides.base)];
      const candidates = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => hasWord(line) && own.has(norm(line)));
      // The side's own addition first, then a line only it kept, then any line of its.
      const pick =
        candidates.find(({ line }) => !others.has(norm(line)) && !base.has(norm(line))) ??
        candidates.find(({ line }) => !others.has(norm(line))) ??
        candidates.at(0);
      if (!pick) return { skip: 'the result holds no line of this side' };
      return { text: replaceLines(lines, pick.i, 1) };
    }
    case 'swap-order': {
      // Two neighbouring statements inside one function's body, where order is the program.
      const { parsed, first } = await definitionsIn(target);
      const defs = parsed.definitions;
      const leaf = defs.filter((d) => !defs.some((x) => x !== d && x.start >= d.start && x.end <= d.end));
      // Both lines from one side, so that side fixed their order. Two lines that only one side each added at the same
      // place have no order of their own: either is a correct merge.
      const sides = [sideLines(target.sides.ours), sideLines(target.sides.theirs)];
      for (let i = 0; i + 1 < lines.length; i++) {
        const [a, b] = [lines[i], lines[i + 1]];
        if (!hasWord(a) || !hasWord(b) || norm(a) === norm(b)) continue;
        if (!sides.some((side) => side.has(norm(a)) && side.has(norm(b)))) continue;
        const [la, lb] = [first + i, first + i + 1];
        if (leaf.some((d) => la > d.signatureEnd && lb < d.end))
          return { text: replaceLines(lines, i, 2, [withEnding(b, a), withEnding(a, b)]) };
      }
      return { skip: 'no two statements of one function body in the result' };
    }
    case 'definition-into-definition': {
      // One whole definition moved into the middle of the next one's body: every line is still there, and with two
      // methods both sides added, each side's lines might even look together.
      const { parsed, first, last } = await definitionsIn(target);
      const inside = parsed.definitions.filter((d) => d.start >= first && d.end <= last);
      const leaves = inside
        .filter((d) => !inside.some((x) => x !== d && x.start >= d.start && x.end <= d.end))
        .sort((x, y) => x.start - y.start);
      for (let i = 0; i + 1 < leaves.length; i++) {
        const [moved, host] = [leaves[i], leaves[i + 1]];
        if (moved.end >= host.start || host.end - host.signatureEnd < 2) continue;
        const [a, z] = [moved.start - first, moved.end - first];
        const into = host.signatureEnd - first + 1;
        const body = lines.slice(a, z + 1);
        body[body.length - 1] = withEnding(body[body.length - 1], lines[into - 1]);
        const rest = [...lines.slice(0, a), ...lines.slice(z + 1)];
        const at = into - body.length;
        return { text: [...rest.slice(0, at), ...body, ...rest.slice(at)].join('') };
      }
      return { skip: 'no two whole definitions in the result' };
    }
    case 'cross-anchor': {
      // A line one side changed moved past lines the other side inserted next to it. They sit at different places in the
      // ancestor (an insertion before or after the changed line), so their order is fixed.
      const base = splitLines(target.sides.base).filter(hasWord).map(norm);
      // The side's changes as the line checks see them (lib/conflict-verify.ts changesOf).
      const kinds = (text: string) => {
        const changed = new Set<string>();
        const inserted = new Set<string>();
        for (const c of changesOf(base, splitLines(text).filter(hasWord).map(norm)))
          for (const line of c.added) (c.end > c.start ? changed : inserted).add(line);
        return { changed, inserted, all: sideLines(text) };
      };
      const [ours, theirs] = [kinds(target.sides.ours), kinds(target.sides.theirs)];
      const inBase = new Set(base);
      for (const [x, y] of [
        [ours, theirs],
        [theirs, ours],
      ]) {
        const changedLine = (line: string) =>
          hasWord(line) && x.changed.has(norm(line)) && !y.all.has(norm(line)) && !inBase.has(norm(line));
        const insertedLine = (line: string) =>
          hasWord(line) && y.inserted.has(norm(line)) && !x.all.has(norm(line)) && !inBase.has(norm(line));
        for (let i = 0; i < lines.length; i++) {
          if (!changedLine(lines[i])) continue;
          let end = i + 1;
          while (end < lines.length && insertedLine(lines[end])) end++;
          // The lines from `from` to `to` (exclusive) in a new order, each place keeping its line ending, as swap-order does.
          const reorder = (from: number, to: number, next: string[]) => ({
            text: [
              ...lines.slice(0, from),
              ...next.map((line, k) => withEnding(line, lines[from + k])),
              ...lines.slice(to),
            ].join(''),
          });
          if (end > i + 1) return reorder(i, end, [...lines.slice(i + 1, end), lines[i]]);
          let start = i;
          while (start > 0 && insertedLine(lines[start - 1])) start--;
          if (start < i) return reorder(start, i + 1, [lines[i], ...lines.slice(start, i)]);
        }
      }
      return { skip: 'no changed line next to the other side’s insertion' };
    }
    case 'interleave-sides': {
      // One side's line moved inside the other side's lines, or past them: every line is still there, and each side's
      // lines may even keep their own order, but they no longer stand together.
      const base = sideLines(target.sides.base);
      const pairs: [string, string][] = [
        [target.sides.ours, target.sides.theirs],
        [target.sides.theirs, target.sides.ours],
      ];
      for (const [x, y] of pairs) {
        const [inX, inY] = [sideLines(x), sideLines(y)];
        const own = (side: Set<string>, other: Set<string>) =>
          lines.flatMap((line, i) =>
            hasWord(line) && side.has(norm(line)) && !other.has(norm(line)) && !base.has(norm(line)) ? [i] : []
          );
        const [mine, theirs] = [own(inX, inY), own(inY, inX)];
        if (!mine.length || !theirs.length) continue;
        const runs: [number, number][] = [];
        for (const i of theirs) {
          const last = runs.at(-1);
          if (last && last[1] === i - 1) last[1] = i;
          else runs.push([i, i]);
        }
        const move = (from: number, to: number) => {
          const next = [...lines];
          const [line] = next.splice(from, 1);
          next.splice(from < to ? to - 1 : to, 0, line);
          return { text: next.join('') };
        };
        // Inside the other side's run of lines.
        for (const [start, end] of runs)
          if (end > start) {
            const from = mine.reduce((best, i) => (Math.abs(i - start) < Math.abs(best - start) ? i : best));
            return move(from, start + 1);
          }
        // Past it, leaving another line of its own side behind.
        for (const [start, end] of runs) {
          const before = mine.filter((i) => i < start);
          const after = mine.filter((i) => i > end);
          if (before.length > 1) return move(before[before.length - 1], end + 1);
          if (after.length > 1) return move(after[0], start);
        }
      }
      return { skip: 'the result has no lines only one side added beside the other side’s' };
    }
    case 'duplicate-unit': {
      // The order-free kinds (#481) are one line each: an interface member, an import, a JSON key. One such line a
      // side added, repeated after itself: a merge neither side wrote.
      const own = addedBy(target);
      const i = lines.findIndex((line) => own(line) && /[,;]\s*$/.test(line));
      return i < 0 ? { skip: 'no one-line unit a side added' } : { text: replaceLines(lines, i + 1, 0, [lines[i]]) };
    }
    case 'swap-units': {
      // Two lines one side added together, in the other order: the two sides may change places, one side's own may not.
      const own = addedBy(target);
      for (let i = 0; i + 1 < lines.length; i++) {
        const side = own(lines[i]);
        if (!side || own(lines[i + 1]) !== side || norm(lines[i]) === norm(lines[i + 1])) continue;
        return {
          text: replaceLines(lines, i, 2, [withEnding(lines[i + 1], lines[i]), withEnding(lines[i], lines[i + 1])]),
        };
      }
      return { skip: 'no two lines one side added together' };
    }
    case 'change-context':
      return { skip: 'handled on all three sides' };
    case 'change-number':
    case 'change-string': {
      const pattern = kind === 'change-number' ? /(?<![\w.$#])\d+(?![\w.])/ : /(["'])([^"'\\\n]*)\1/;
      // A line a side wrote first: a changed literal there is a wrong merge of that side's change.
      const base = sideLines(target.sides.base);
      const order = lines
        .map((line, i) => ({ line, i }))
        .sort((x, y) => +base.has(norm(x.line)) - +base.has(norm(y.line)));
      for (const { line, i } of order) {
        const match = pattern.exec(line);
        if (!match) continue;
        const changed = kind === 'change-number' ? String(Number(match[0]) + 1) : `${match[1]}${match[2]}x${match[1]}`;
        const next = line.slice(0, match.index) + changed + line.slice(match.index + match[0].length);
        return { text: replaceLines(lines, i, 1, [next]) };
      }
      return { skip: `no ${kind === 'change-number' ? 'number' : 'string'} in the result` };
    }
    case 'touch-outside':
      return { skip: 'handled on the whole output' };
  }
}
/** The side that alone added a line of the result, or undefined. */
function addedBy(target: Target) {
  const [base, ours, theirs] = [target.sides.base, target.sides.ours, target.sides.theirs].map(sideLines);
  return (line: string) => {
    const key = norm(line);
    if (!hasWord(line) || base.has(key) || ours.has(key) === theirs.has(key)) return undefined;
    return ours.has(key) ? ('ours' as const) : ('theirs' as const);
  };
}
const KEYWORDS = new Set(
  'abstract as async await break case catch class const continue def default defer delete do elif else enum except export extends final finally fn for from func function go if impl implements import in interface is lambda let match mod module namespace new not or package pass private protected pub public raise readonly return select self static struct super switch this throw throws trait try type typeof use using val var void where while with yield'.split(
    ' '
  )
);
/**
 * A line of text with one value changed: its first number plus one, else its first name that is not a keyword with `X`
 * added (`value` becomes `valueX`). The line still parses, so only the check on text outside the conflicts can see it.
 */
function touch(line: string) {
  const number = /(?<![\w.$#])\d+(?![\w.])/.exec(line);
  if (number)
    return line.slice(0, number.index) + String(Number(number[0]) + 1) + line.slice(number.index + number[0].length);
  return line.replace(/[\p{L}_$][\p{L}\p{N}_$]*/gu, (word, at: number) => (at === firstName(line) ? `${word}X` : word));
}
/** Where the first name that is not a keyword starts, or -1. */
function firstName(line: string) {
  for (const match of line.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) if (!KEYWORDS.has(match[0])) return match.index;
  return -1;
}
const touchable = (line: string) => /(?<![\w.$#])\d+(?![\w.])/.test(line) || firstName(line) >= 0;

/** Which check caught a mutation, from its note. */
export function checkOf(note: string) {
  const checks: [string, RegExp][] = [
    ['outside text', /no longer maps onto Git|did not reach the draft|resolver output was not used/],
    ['conflict markers', /conflict markers/],
    ['line endings', /line endings/],
    ['parse', /doesn’t parse|couldn’t parse/],
    ['duplicate definition', /defined twice|declared twice/],
    ['order', /changes the order of lines/],
    ['both changed the same lines', /Both sides changed the same lines/],
    ['same change / reformat', /couldn’t show it is the same change|only reformatted|took the proposal back/],
    ['lost edit', /change to it\.|Check it yourself|neither side changed it/],
    ['line accounting', /missing from the result|is in neither side|still in the result/],
    ['renamed name', /renamed or removed/],
    ['stray line', /semicolon/],
    ['union rule', /^Both sides added /],
  ];
  return checks.find(([, pattern]) => pattern.test(note))?.[0] ?? 'other';
}

// ── The audit ────────────────────────────────────────────────────────────────

/**
 * What one mutated file comes to: its block's bucket, or for a whole-file proposal whether it passed. `union` blocks
 * whose note is still a union note were held by the union rule alone.
 */
async function judge(
  file: AuditFile,
  disabled: SyntaxLanguage[],
  index: number | undefined,
  resolver: Resolver,
  mutation: MutationKind
): Promise<{ outcome: Outcome; note: string }> {
  const { file: after, verdict } = await checked(file, disabled);
  if (resolver === 'rerere' && REMEMBERED_OWN.has(mutation)) {
    const merged = index !== undefined && blockBuckets(after, after.result, verdict)[index] === 'merged';
    return { outcome: merged ? 'own' : 'caught', note: blockVerdict(verdict, index ?? 0)?.note ?? '' };
  }
  if (after.wholeFile) {
    return verdict?.passed
      ? { outcome: 'escaped', note: 'The whole-file proposal passed its checks.' }
      : { outcome: 'caught', note: verdict?.note ?? 'The checks did not run.' };
  }
  const buckets = blockBuckets(after, after.result, verdict);
  if (index === undefined) {
    // Text outside the conflicts: nothing may be Merged with it in the draft.
    const merged = buckets.findIndex((b) => b === 'merged');
    return merged >= 0
      ? { outcome: 'escaped', note: `Conflict ${merged + 1} is Merged with the touched line in the result.` }
      : { outcome: 'caught', note: verdict?.note ?? 'The resolver output was not used.' };
  }
  // A 'same' proposal the checks didn't confirm is taken back (withoutUnconfirmed): the conflict is yours to decide.
  const note = !after.proposals?.[index]
    ? 'The same-change rule took the proposal back.'
    : (blockVerdict(verdict, index)?.note ?? 'The checks did not run.');
  if (buckets[index] === 'merged') return { outcome: 'escaped', note };
  if (resolver === 'union' && UNION_NOTES.test(note)) return { outcome: 'held', note };
  return { outcome: 'caught', note };
}

export interface AuditOptions {
  /** Every matrix case, not the sample. */
  all?: boolean;
  /** Matrix cases per pattern and language (default 1): the deterministic sample. */
  variants?: number;
  /** Only cases whose name contains this. */
  only?: string;
  concurrency?: number;
  progress?: (done: number, total: number, name: string) => void;
}
export async function labCases(options: AuditOptions = {}) {
  const fixtures = (await loadCases(
    options.only ? (n: string) => n.includes(options.only ?? '') : undefined
  )) as unknown as LabCase[];
  // The generator's options are JavaScript defaults; `filter` has none, so TypeScript doesn't see it.
  const generate = generateMatrix as unknown as (options: { variants: number; filter?: string }) => LabCase[];
  const matrix = generate({ variants: options.all ? 4 : (options.variants ?? 1), filter: options.only });
  return [...fixtures, ...matrix];
}

export async function runResolverAudit(options: AuditOptions = {}): Promise<AuditReport> {
  const started = Date.now();
  const cases = await labCases(options);
  const work = cases.flatMap(merges);
  const report: AuditReport = { cases: cases.length, files: 0, baselines: [], results: [], errors: [], ms: 0 };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-resolver-audit-'));
  try {
    let next = 0;
    let done = 0;
    const lanes = Array.from(
      { length: options.concurrency ?? Math.max(2, Math.min(8, os.cpus().length)) },
      async (_, lane) => {
        const dir = path.join(temp, String(lane));
        await fs.mkdir(dir);
        for (let i = next++; i < work.length; i = next++) {
          try {
            await auditMerge(work[i], dir, report);
          } catch (error) {
            report.errors.push(`${work[i].name}: ${error instanceof Error ? error.message : String(error)}`);
          }
          options.progress?.(++done, work.length, work[i].name);
        }
      }
    );
    await Promise.all(lanes);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  const order = (r: { case: string; path: string; block: number }) => `${r.case}\u0000${r.path}\u0000${r.block}`;
  report.baselines.sort((a, b) => order(a).localeCompare(order(b)));
  report.results.sort((a, b) => order(a).localeCompare(order(b)) || a.mutation.localeCompare(b.mutation));
  report.ms = Date.now() - started;
  return report;
}

async function auditMerge(m: Merge, dir: string, report: AuditReport) {
  const paths = [...new Set([...m.base.keys(), ...m.ours.keys(), ...m.theirs.keys()])].sort();
  for (const p of paths) {
    const [base, ours, theirs] = [m.base, m.ours, m.theirs].map((t) => utf8(t.get(p)));
    // A deletion, an addition on both sides, a binary file: a local merge tool's, not a resolver's.
    if (base === undefined || ours === undefined || theirs === undefined) continue;
    const language = syntaxLanguage(p);
    const original = await gitConflict(dir, [base, ours, theirs]);
    if (!original) continue;
    report.files++;
    const plain = { path: p, base, ours, theirs, original, resolved: false };
    const subjects: AuditFile[] = [];
    // Structural merge's proposals, with the 'same' and union rules on the conflicts it left (none when it failed).
    const output = m.standIn ? undefined : await structuralMerge(dir, plain, m.canned);
    const merged = output === undefined ? undefined : fromOutput(plain, output, 'mergiraf');
    if (merged) subjects.push(merged);
    // A remembered resolution: the case's known-correct one, as if you had published it before.
    const resolved = m.standIn ? undefined : utf8(m.resolved?.get(p));
    const remembered = resolved === undefined ? undefined : fromOutput(plain, resolved, 'rerere');
    if (remembered) subjects.push(remembered);
    // The move rule (lib/conflict-moved.ts) on Git's conflicts, as when structural merge proposes nothing: the service
    // runs it only on a file with no other proposal.
    const moved = await moveProposer(engine, m.disabled)(plain);
    if (moved) subjects.push({ ...plain, wholeFile: moved, result: original, source: 'manual' });
    for (const subject of subjects) {
      await auditFile(m, subject, (subject === remembered ? resolved : output) ?? '', language, report);
    }
  }
}

async function auditFile(
  m: Merge,
  subject: AuditFile,
  output: string,
  language: SyntaxLanguage | undefined,
  report: AuditReport
) {
  const { file, verdict } = await checked(subject, m.disabled);
  const at = { case: m.name, path: file.path };
  const record = (r: Omit<MutationResult, 'case' | 'path'>) =>
    report.results.push({ ...at, ...r, check: r.outcome === 'caught' ? (r.check ?? checkOf(r.note)) : undefined });
  if (file.wholeFile) {
    const passed = !!verdict?.passed;
    const resolver: Resolver = file.wholeFile.source === 'moved' ? 'moved' : 'whole-file';
    report.baselines.push({ ...at, block: 0, resolver, passed, note: verdict?.note ?? '' });
    if (!passed || !language) return;
    const target: Target = { language, text: file.wholeFile.text, before: '', after: '', sides: file };
    for (const mutation of MUTATIONS) {
      let mutant: Mutant;
      if (mutation === 'touch-outside') {
        // A line neither side changed, far from the conflicts: the first one with a word that all three share.
        const shared = [sideLines(file.base), sideLines(file.ours), sideLines(file.theirs)];
        const lines = splitLines(target.text);
        const i = lines.findIndex((l) => touchable(l) && shared.every((s) => s.has(norm(l))));
        mutant = i < 0 ? { skip: 'no line both sides kept' } : { text: replaceLines(lines, i, 1, [touch(lines[i])]) };
      } else mutant = await mutate(mutation, target);
      if ('skip' in mutant || mutant.text === target.text) continue;
      const result = await judge(
        { ...file, wholeFile: { ...file.wholeFile, text: mutant.text } },
        m.disabled,
        0,
        resolver,
        mutation
      );
      record({
        block: 0,
        resolver,
        mutation,
        ...result,
        text: result.outcome === 'escaped' ? mutant.text : undefined,
      });
    }
    return;
  }
  const proposals = file.proposals ?? [];
  const segments = parseConflicts(file.original);
  const buckets = blockBuckets(file, file.result, verdict);
  for (const s of segments) {
    if (s.kind !== 'conflict') continue;
    const proposal = proposals[s.index];
    if (!proposal) continue;
    const resolver = resolverOf(proposal, verdict, s.index);
    const note = blockVerdict(verdict, s.index)?.note ?? '';
    const passed = buckets[s.index] === 'merged' || (resolver === 'union' && UNION_NOTES.test(note));
    report.baselines.push({ ...at, block: s.index, resolver, passed, note });
    if (!passed || !language) continue;
    const target: Target = {
      language,
      text: proposal.text,
      ...around(segments, proposals, s.index),
      sides: { base: s.block.base ?? '', ours: s.block.ours, theirs: s.block.theirs },
    };
    for (const mutation of MUTATIONS) {
      if (mutation === 'touch-outside') {
        // Union and 'same' proposals are made from Git's conflict alone; only a whole output can touch other lines.
        if (resolver === 'union' || proposal.source === 'same') continue;
        await touchOutside(m, file, s.index, resolver, output, record);
        continue;
      }
      if (mutation === 'change-context') {
        if (resolver === 'mergiraf' && ORDER_FREE_NOTE.test(note))
          await changeContext(m, file, s.index, output, record);
        continue;
      }
      const mutant = await mutate(mutation, target);
      if ('skip' in mutant || mutant.text === proposal.text) continue;
      const next = proposals.map((p, i) => (i === s.index && p ? { ...p, text: mutant.text } : p));
      const result = await judge(
        { ...file, proposals: next, result: withProposals(file.original, next) },
        m.disabled,
        s.index,
        resolver,
        mutation
      );
      record({
        block: s.index,
        resolver,
        mutation,
        ...result,
        text: result.outcome === 'escaped' ? mutant.text : undefined,
      });
    }
  }
}

/**
 * The resolver's whole output with one line next to the conflict changed, mapped onto Git's conflicts again as the
 * service maps it. Lines just before and just after the conflict, where a mapping could take them for the conflict's.
 */
/** The note of a structural merge Merged because both sides' insertions are order-free (lib/conflict-verify.ts). */
const ORDER_FREE_NOTE = /and their order doesn’t matter/;
/** A change to the file around an order-free insertion, made on all three sides, that its proof must not survive. */
interface ContextChange {
  name: string;
  language: RegExp;
  /** The changed path and text, or undefined when the change doesn't apply. */
  apply: (path: string, text: string) => { path: string; text: string } | undefined;
}
/** Every match of `from` replaced by `to`. */
const everywhere = (from: RegExp, to: string) => (path: string, text: string) =>
  from.test(text) ? { path, text: text.replace(new RegExp(from.source, `${from.flags}g`), to) } : undefined;
const CONTEXT_CHANGES: ContextChange[] = [
  { name: 'value imports', language: /\.tsx?$/, apply: everywhere(/^import type /m, 'import ') },
  {
    name: 'unknown JSON file',
    language: /(?:package|tsconfig[\w.-]*|jsconfig)\.json$/,
    apply: (path, text) => ({ path: path.replace(/[^/\\]+\.json$/, 'settings.json'), text }),
  },
];
/**
 * The order-free proofs (#481) read the file around the insertion: the kind of import, and the file name. Each change of CONTEXT_CHANGES is made on all three sides, the conflict and the structural merge's output alike,
 * and the conflict must then not be Merged.
 */
async function changeContext(
  m: Merge,
  file: AuditFile,
  index: number,
  output: string,
  record: (r: Omit<MutationResult, 'case' | 'path'>) => void
) {
  for (const change of CONTEXT_CHANGES) {
    if (!change.language.test(file.path)) continue;
    const texts = [file.base, file.ours, file.theirs, file.original, output].map((t) => change.apply(file.path, t));
    if (texts.some((t) => !t) || (texts[0]?.text === file.base && texts[0].path === file.path)) continue;
    const [base, ours, theirs, original, merged] = texts as { path: string; text: string }[];
    // A change that reaches into a conflict changes it on one side only: not this mutation.
    if (
      parseConflicts(original.text).filter((x) => x.kind === 'conflict').length !==
      parseConflicts(file.original).filter((x) => x.kind === 'conflict').length
    )
      continue;
    const plain = {
      path: base.path,
      base: base.text,
      ours: ours.text,
      theirs: theirs.text,
      original: original.text,
      resolved: false,
    };
    const next = fromOutput(plain, merged.text, 'mergiraf');
    if (!next) continue;
    const result = await judge(next, m.disabled, index, 'mergiraf', 'change-context');
    record({
      block: index,
      resolver: 'mergiraf',
      mutation: 'change-context',
      ...result,
      note: `${change.name}: ${result.note}`,
      text: result.outcome === 'escaped' ? original.text : undefined,
    });
  }
}
async function touchOutside(
  m: Merge,
  file: AuditFile,
  index: number,
  resolver: Resolver,
  output: string,
  record: (r: Omit<MutationResult, 'case' | 'path'>) => void
) {
  const segments = parseConflicts(file.original);
  const at = segments.findIndex((s) => s.kind === 'conflict' && s.index === index);
  const source = file.proposals?.[index]?.source === 'rerere' ? 'rerere' : 'mergiraf';
  // The output as the resolver wrote it: each proposal in place, other conflicts as the resolver left them.
  const full =
    source === 'rerere'
      ? output
      : withProposals(
          file.original,
          (file.proposals ?? []).map((p) => (p?.source === 'mergiraf' ? p : null))
        );
  for (const side of [-1, 1]) {
    const neighbour = segments.at(at + side);
    if (neighbour?.kind !== 'text') continue;
    const lines = splitLines(neighbour.text);
    const order = side < 0 ? [...lines.keys()].reverse() : [...lines.keys()];
    const i = order.find((k) => touchable(lines[k]));
    if (i === undefined) continue;
    const touched = replaceLines(lines, i, 1, [touch(lines[i])]);
    // The same text before or after, in the resolver's output: the neighbour's text is there exactly once.
    const count = full.split(neighbour.text).length - 1;
    if (count !== 1) continue;
    const mutated = full.replace(neighbour.text, touched);
    const base = {
      path: file.path,
      base: file.base,
      ours: file.ours,
      theirs: file.theirs,
      original: file.original,
      resolved: false,
    };
    const next = fromOutput(base, mutated, source);
    if (!next) {
      record({
        block: index,
        resolver,
        mutation: 'touch-outside',
        outcome: 'caught',
        note: 'The output no longer maps onto Git’s conflicts.',
      });
      continue;
    }
    const result = await judge(next, m.disabled, next.wholeFile ? 0 : undefined, resolver, 'touch-outside');
    // A draft that does not hold the touched line kept Git's text outside the conflicts: nothing was touched.
    const kept = next.wholeFile || next.result.includes(touch(lines[i]));
    record({
      block: index,
      resolver,
      mutation: 'touch-outside',
      ...(kept ? result : { outcome: 'caught', note: 'The touched line did not reach the draft.' }),
      // The mapping refused the output's conflicts, so it became a whole-file proposal, never Merged; its checks say why.
      ...(next.wholeFile && result.outcome === 'caught'
        ? { check: `outside text → whole file (${checkOf(result.note)})` }
        : {}),
      text: kept && result.outcome === 'escaped' ? mutated : undefined,
    });
  }
}

/** The table: per resolver and mutation, caught / held / own / escaped. */
export function summarize(report: AuditReport) {
  const table = new Map<string, Record<Outcome, number>>();
  for (const r of report.results) {
    const key = `${r.resolver}\u0000${r.mutation}`;
    const row = table.get(key) ?? { caught: 0, held: 0, own: 0, escaped: 0 };
    row[r.outcome]++;
    table.set(key, row);
  }
  const lines = ['resolver     mutation                    caught  held  own  escaped'];
  for (const resolver of RESOLVERS)
    for (const mutation of MUTATIONS) {
      const row = table.get(`${resolver}\u0000${mutation}`);
      if (!row) continue;
      lines.push(
        `${resolver.padEnd(12)} ${mutation.padEnd(27)} ${String(row.caught).padStart(6)} ${String(row.held).padStart(5)} ${String(row.own).padStart(4)} ${String(row.escaped).padStart(8)}`
      );
    }
  const byCheck = new Map<string, Map<string, number>>();
  for (const r of report.results) {
    if (r.outcome !== 'caught' || !r.check) continue;
    const row = byCheck.get(r.mutation) ?? new Map<string, number>();
    row.set(r.check, (row.get(r.check) ?? 0) + 1);
    byCheck.set(r.mutation, row);
  }
  const checks = MUTATIONS.filter((m) => byCheck.has(m)).map(
    (m) =>
      `${m.padEnd(27)} ${[...(byCheck.get(m) ?? [])]
        .sort((a, b) => b[1] - a[1])
        .map(([check, n]) => `${check} ${n}`)
        .join(', ')}`
  );
  const base = new Map<Resolver, { passed: number; total: number }>();
  for (const b of report.baselines) {
    const row = base.get(b.resolver) ?? { passed: 0, total: 0 };
    row.total++;
    if (b.passed) row.passed++;
    base.set(b.resolver, row);
  }
  const baseline = RESOLVERS.filter((r) => base.has(r)).map((r) => `${r} ${base.get(r)?.passed}/${base.get(r)?.total}`);
  return {
    lines,
    checks: ['Caught by check, per mutation:', ...checks],
    baseline: `Results that passed the checks, by resolver: ${baseline.join(', ')}.`,
  };
}
