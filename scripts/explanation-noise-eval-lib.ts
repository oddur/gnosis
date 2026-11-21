import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { buildIndexedHunks, formatHunkIndexForPrompt, type IndexedHunk } from '../lib/diff-parse';
import { createSyntaxEngine } from '../lib/syntax-scope';
import {
  applyNoise,
  hunkNoiseKinds,
  noiseRequests,
  ruleNoise,
} from '../lib/explanation-noise';
import { DEFAULT_EXPLANATION_PREFERENCES, explanationInstructions, type NoiseLevel } from '../lib/explanation-options';
import { buildPlannerContext } from '../lib/context-builder';
import { PLANNER_SYSTEM, plannerUserSuffix } from '../lib/agent';
import type { PlannerOutput, PrMetadata } from '../lib/types';

/**
 * The Reduce noise eval (tests/fixtures/explanation-noise/README.md). Each fixture is a small synthetic PR with a label
 * per hunk. Replay runs the rules and scores recorded planner answers; live mode records new ones.
 */
export const FIXTURES = path.resolve(__dirname, '../tests/fixtures/explanation-noise');
export const LEVELS = ['conservative', 'aggressive'] as const;
export type EvalLevel = (typeof LEVELS)[number];

export type Label = 'essential' | 'noise' | 'aggressive-only';
export interface FixtureHunkLabel {
  label: Label;
  note: string;
  /** For an essential hunk: whether it changes behavior. Defaults to true; only false hunks may go at Aggressive. */
  behavior?: boolean;
}
export interface Fixture {
  id: string;
  title: string;
  description: string;
  source: string;
  files: { path: string; before: string[] | null; after: string[] | null; hunks: FixtureHunkLabel[] }[];
}
export interface PreparedFixture {
  fixture: Fixture;
  diff: string;
  hunks: IndexedHunk[];
  labels: Map<string, FixtureHunkLabel>;
  before: Record<string, string>;
  after: Record<string, string>;
}

const text = (lines: string[] | null) => (lines ? lines.join('\n') + '\n' : '');

/** A fixture's unified diff, as GitHub shows a PR's patch (3 lines of context). */
export function fixtureDiff(fixture: Fixture): string {
  return fixture.files
    .map((file) => {
      const patch = structuredPatch(file.path, file.path, text(file.before), text(file.after), '', '', { context: 3 });
      const header = [
        `diff --git a/${file.path} b/${file.path}`,
        ...(file.before ? [] : ['new file mode 100644']),
        ...(file.after ? [] : ['deleted file mode 100644']),
        file.before ? `--- a/${file.path}` : '--- /dev/null',
        file.after ? `+++ b/${file.path}` : '+++ /dev/null',
      ];
      const hunks = patch.hunks.map((hunk) =>
        [
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ...hunk.lines.filter((line) => !line.startsWith('\\')),
        ].join('\n')
      );
      return [...header, ...hunks].join('\n');
    })
    .join('\n');
}

export function loadFixtures(directory = path.join(FIXTURES, 'cases')): Fixture[] {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as Fixture);
}

/** The fixture's hunks with their labels. Throws when a file's label count does not match its hunks. */
export function prepareFixture(fixture: Fixture): PreparedFixture {
  const diff = fixtureDiff(fixture);
  const before: Record<string, string> = {},
    after: Record<string, string> = {};
  for (const file of fixture.files) {
    if (file.before) before[file.path] = text(file.before);
    if (file.after) after[file.path] = text(file.after);
  }
  const hunks = buildIndexedHunks(diff, before, after);
  const labels = new Map<string, FixtureHunkLabel>();
  for (const file of fixture.files) {
    const own = hunks.filter((hunk) => hunk.filePath === file.path);
    if (own.length !== file.hunks.length)
      throw new Error(`${fixture.id}: ${file.path} has ${own.length} hunks but ${file.hunks.length} labels`);
    own.forEach((hunk, i) => labels.set(hunk.id, file.hunks[i]));
  }
  return { fixture, diff, hunks, labels, before, after };
}

/** The tree-sitter engine with the grammars Gnosis ships, as tests/semantic-noise.test.ts loads it. */
export function noiseEngine() {
  const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
  const engine = createSyntaxEngine(TreeSitter, {
    runtime: () => Promise.resolve(new Uint8Array(fs.readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')))),
    grammar: (language) => Promise.resolve(new Uint8Array(fs.readFileSync(path.join(assets, `${language}.wasm`)))),
    tags: (name) => Promise.resolve(fs.readFileSync(path.join(assets, `${name}-tags.scm`), 'utf8')),
  });
  return engine;
}
type Engine = ReturnType<typeof noiseEngine>;

/** Layer 1 at a level: the hunks the rules cut, with reasons. */
export async function ruleCutsFor(engine: Engine, prepared: PreparedFixture, level: NoiseLevel) {
  const requests = noiseRequests(prepared.hunks, prepared.after);
  const results = [];
  for (const request of requests) {
    try {
      results.push((await engine.noise(request.language, request.after, request.hunks)).blocks.map((b) => b.kind));
    } catch {
      results.push(null);
    }
  }
  return ruleNoise(prepared.hunks, prepared.before, prepared.after, hunkNoiseKinds(requests, results), level);
}

/** What generation sends the planner for a fixture at a level, from the same builders as src/main.ts. */
export function plannerInput(prepared: PreparedFixture, ruleCuts: ReadonlyMap<string, string>, level: EvalLevel) {
  const planning = prepared.hunks.filter((hunk) => !ruleCuts.has(hunk.id));
  const hunkIndex = formatHunkIndexForPrompt(planning);
  const prData = {
    title: prepared.fixture.title,
    description: prepared.fixture.description,
    author: 'fixture',
    baseBranch: 'main',
  } as PrMetadata;
  const changedFiles = prepared.fixture.files.map((file) => ({
    filename: file.path,
    status: file.before ? (file.after ? 'modified' : 'removed') : 'added',
    additions: prepared.hunks.filter((h) => h.filePath === file.path).reduce((n, h) => n + h.additions, 0),
    deletions: prepared.hunks.filter((h) => h.filePath === file.path).reduce((n, h) => n + h.deletions, 0),
  }));
  const options = { ...DEFAULT_EXPLANATION_PREFERENCES, reduceNoise: level };
  const context =
    buildPlannerContext(prData, changedFiles as never, hunkIndex, '', null, planning) +
    `\n\n<explanation_instructions>\n${explanationInstructions(options)}\n</explanation_instructions>`;
  return { hunkIndex, context, options, userMessage: context + plannerUserSuffix(level) };
}

/** Changes when the planner's prompt does: recordings made with another prompt are reported as stale. */
export function promptHash(level: EvalLevel): string {
  const options = { ...DEFAULT_EXPLANATION_PREFERENCES, reduceNoise: level };
  return createHash('sha256')
    .update(PLANNER_SYSTEM)
    .update(plannerUserSuffix(level))
    .update(explanationInstructions(options))
    .digest('hex')
    .slice(0, 16);
}
export const fixtureHash = (fixture: Fixture) =>
  createHash('sha256').update(JSON.stringify(fixture)).digest('hex').slice(0, 16);

export interface Manifest {
  recordedAt: string;
  provider: string;
  model: string;
  effort?: string;
  promptHash: Record<EvalLevel, string>;
  options: Record<EvalLevel, unknown>;
  fixtures: Record<string, string>;
}
const recordedPath = (level: EvalLevel, id: string, root = FIXTURES) => path.join(root, 'recorded', level, `${id}.json`);
export function readRecorded(level: EvalLevel, id: string, root = FIXTURES): PlannerOutput | undefined {
  const file = recordedPath(level, id, root);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { plan: PlannerOutput }).plan : undefined;
}
export function writeRecorded(level: EvalLevel, id: string, plan: PlannerOutput, root = FIXTURES) {
  const file = recordedPath(level, id, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ plan }, null, 2) + '\n');
}
export function readManifest(root = FIXTURES): Manifest | undefined {
  const file = path.join(root, 'recorded', 'manifest.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest) : undefined;
}

// ── Scoring ─────────────────────────────────────────────────────

export interface WrongCut {
  fixture: string;
  hunk: string;
  file: string;
  label: Label;
  level: EvalLevel;
  layer: 'rules' | 'planner';
  reason: string;
  /** A failure: an essential hunk cut (at Aggressive, one that changes behavior). Otherwise an over-cut warning. */
  failure: boolean;
  note: string;
}
export interface LevelScore {
  level: EvalLevel;
  layer: 'rules' | 'rules+planner';
  expected: number;
  cutExpected: number;
  cuts: number;
  recall: number;
  precision: number;
  wrong: WrongCut[];
  missed: { fixture: string; hunk: string; file: string; label: Label }[];
}
export const shouldCut = (label: FixtureHunkLabel, level: EvalLevel) =>
  label.label === 'noise' || (label.label === 'aggressive-only' && level === 'aggressive');
const isFailure = (label: FixtureHunkLabel, level: EvalLevel) =>
  label.label === 'essential' && (level === 'conservative' || label.behavior !== false);

/** Scores one level's cuts over every fixture. */
export function score(
  level: EvalLevel,
  layer: LevelScore['layer'],
  runs: { prepared: PreparedFixture; cut: Map<string, { reason: string; source: 'rules' | 'planner' }> }[]
): LevelScore {
  let expected = 0,
    cutExpected = 0,
    cuts = 0;
  const wrong: WrongCut[] = [];
  const missed: LevelScore['missed'] = [];
  for (const { prepared, cut } of runs)
    for (const hunk of prepared.hunks) {
      const label = prepared.labels.get(hunk.id);
      if (!label) throw new Error(`${prepared.fixture.id}: ${hunk.id} has no label`);
      const want = shouldCut(label, level);
      const got = cut.get(hunk.id);
      if (want) expected++;
      if (got) cuts++;
      if (want && got) cutExpected++;
      if (want && !got) missed.push({ fixture: prepared.fixture.id, hunk: hunk.id, file: hunk.filePath, label: label.label });
      if (got && !want)
        wrong.push({
          fixture: prepared.fixture.id,
          hunk: hunk.id,
          file: hunk.filePath,
          label: label.label,
          level,
          layer: got.source,
          reason: got.reason,
          failure: isFailure(label, level),
          note: label.note,
        });
    }
  return {
    level,
    layer,
    expected,
    cutExpected,
    cuts,
    recall: expected ? cutExpected / expected : 1,
    precision: cuts ? (cuts - wrong.length) / cuts : 1,
    wrong,
    missed,
  };
}

export interface ReplayResult {
  scores: LevelScore[];
  /** Levels with no recorded planner answers, or only some. */
  unrecorded: { level: EvalLevel; missing: string[] }[];
  stale: string[];
  failed: boolean;
}

/** Replay: the rules always; the planner's recorded answers where they exist. Free and reproducible. */
export async function replay(fixtures = loadFixtures(), root = FIXTURES): Promise<ReplayResult> {
  const engine = noiseEngine();
  const prepared = fixtures.map(prepareFixture);
  const manifest = readManifest(root);
  const scores: LevelScore[] = [];
  const unrecorded: ReplayResult['unrecorded'] = [];
  const stale: string[] = [];
  for (const level of LEVELS) {
    const rules: Parameters<typeof score>[2] = [];
    const planned: Parameters<typeof score>[2] = [];
    const missing: string[] = [];
    for (const item of prepared) {
      const ruleCuts = await ruleCutsFor(engine, item, level);
      rules.push({ prepared: item, cut: applyNoise([], item.hunks, ruleCuts, undefined, level).cut });
      const plan = readRecorded(level, item.fixture.id, root);
      if (!plan) {
        missing.push(item.fixture.id);
        continue;
      }
      planned.push({ prepared: item, cut: applyNoise(plan.topics, item.hunks, ruleCuts, plan.noise, level).cut });
      if (manifest && manifest.fixtures[item.fixture.id] !== fixtureHash(item.fixture))
        stale.push(`${level}/${item.fixture.id}: the fixture changed since it was recorded`);
    }
    scores.push(score(level, 'rules', rules));
    if (planned.length) scores.push(score(level, 'rules+planner', planned));
    if (missing.length) unrecorded.push({ level, missing });
    if (manifest && manifest.promptHash[level] !== promptHash(level))
      stale.push(`${level}: recorded with prompt ${manifest.promptHash[level]}, the prompt is now ${promptHash(level)}`);
  }
  return { scores, unrecorded, stale, failed: scores.some((s) => s.wrong.some((w) => w.failure)) };
}

export function formatReplay(result: ReplayResult, fixtures: number): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines = [`Reduce noise eval: ${fixtures} fixtures`];
  for (const s of result.scores) {
    lines.push(
      `${s.level.padEnd(12)} ${s.layer.padEnd(13)} noise recall ${pct(s.recall)} (${s.cutExpected}/${s.expected}), essential precision ${pct(s.precision)} (${s.cuts - s.wrong.length}/${s.cuts} cuts), wrong cuts ${s.wrong.length}`
    );
    for (const w of s.wrong)
      lines.push(
        `  ${w.failure ? 'FAIL' : 'warn'} ${w.fixture} ${w.hunk} ${w.file} [${w.label}] cut by ${w.layer}: ${w.reason} (${w.note})`
      );
  }
  for (const { level, missing } of result.unrecorded)
    lines.push(
      `${level.padEnd(12)} planner       not recorded${missing.length < fixtures ? ` for ${missing.join(', ')}` : ''}, run --live`
    );
  for (const note of result.stale) lines.push(`stale: ${note}`);
  lines.push(result.failed ? 'FAILED: an essential hunk was cut.' : 'Passed: no essential hunk was cut.');
  return lines.join('\n');
}

// ── Live: the real planner, recorded ────────────────────────────

/** Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Fable 5.2 $8/$40 per million tokens (input/output). */
export const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40],
};
/** Planner answers for these fixtures are a few thousand tokens; thinking adds more. */
export const OUTPUT_TOKENS_PER_CALL = 4000;
export const CHARS_PER_TOKEN = 3.5;

export function estimate(fixtures: Fixture[], model: string, ruleCuts: (prepared: PreparedFixture, level: EvalLevel) => Promise<ReadonlyMap<string, string>>) {
  return (async () => {
    let inputChars = 0,
      calls = 0;
    for (const fixture of fixtures) {
      const prepared = prepareFixture(fixture);
      for (const level of LEVELS) {
        const input = plannerInput(prepared, await ruleCuts(prepared, level), level);
        inputChars += PLANNER_SYSTEM.length + input.userMessage.length;
        calls++;
      }
    }
    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
    const outputTokens = calls * OUTPUT_TOKENS_PER_CALL;
    const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
    const usd = price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : undefined;
    return { calls, inputTokens, outputTokens, usd };
  })();
}
