import { changeBlocks, NOISE_MAX_CHARACTERS, patchHunks, type NoiseKind } from './semantic-noise';
import { syntaxLanguage, type SyntaxLanguage } from './syntax-scope';
import {
  normalizeExplanationPreferences,
  type ExplanationPreferences,
  type NoiseLevel,
} from './explanation-options';
import type { IndexedHunk, ParsedHunk } from './diff-parse';
import type { TopicPlan } from './types';

/**
 * Reduce noise: the explanation explains the change's essential complexity and leaves out hunks a reviewer doesn't need
 * explained. Changes still shows every hunk, and the overview lists the ones left out.
 *
 * Two layers, both fail closed (a hunk is cut only when all of it is noise; any doubt keeps it):
 * - Rules, no model: a hunk whose every change block is whitespace, formatting or comments (lib/semantic-noise.ts), or
 *   whose every changed line belongs to an import, `use` or `#include` statement. An import of a package the file
 *   didn't import before is a new dependency: kept at Conservative, cut at Aggressive.
 * - The planner, in the same call that plans the topics: it lists the hunks it judges noise in `noise`. Only listed
 *   hunks are cut. A hunk it neither assigns nor lists still goes to "Other changes". A hunk it both assigns and lists
 *   stays in its topic.
 */

/** A hunk left out of the explanation, with where it is in Changes. */
export interface LeftOutHunk {
  filePath: string;
  /** The side its changed lines are on: the new file, or the old one for a hunk that only deletes. */
  side: 'after' | 'before';
  startLine: number;
  endLine: number;
  /** "import only", "formatting", "whitespace", "comments only", or the planner's reason. */
  reason: string;
  source: 'rules' | 'planner';
}
/** Saved with the explanation (ReviewGuide.noiseReduction). */
export interface NoiseReduction {
  level: NoiseLevel;
  leftOut: LeftOutHunk[];
  /** The repository's saved level when generation started, and the repository it was read from (explanationRepository). */
  defaultLevel?: NoiseLevel;
  repository?: string;
}
type Hunk = Pick<ParsedHunk, 'id' | 'filePath' | 'fileStatus' | 'hunkHeader' | 'content'>;

// ── Planner prompt ──────────────────────────────────────────────

export const NOISE_PLANNER_DIRECTIVE = `NOISE: The reviewer reads the essential change here and can read every hunk in Changes. List a hunk in "noise" with a short reason when explaining it would not help the reviewer understand this change. A listed hunk gets no topic.
- List a hunk only when all of it is noise. A hunk with any meaningful change stays in a topic.
- List only hunks whose source you saw in the evidence. Never list a hunk in both a topic and "noise". When unsure, keep it.`;

const NOISE_LEVEL_DIRECTIVES: Record<Exclude<NoiseLevel, 'off'>, string> = {
  conservative:
    'Reduce noise: Conservative. List only clear noise: unused or reordered imports, formatting, comment-only edits, unrelated renames, code moved without change, stray debug lines removed, typo fixes, and lockfile churn that follows a manifest change. Keep anything that could change behavior: logic, config values, dependency versions, public API or exports, SQL, and schema.',
  aggressive:
    'Reduce noise: Aggressive. Also list small related edits that are not part of the main story, such as a helper tweak, a field threaded through, or test data updated to follow the main change. Never list a hunk that changes behavior: logic, config values, dependency versions, public API or exports, SQL, or schema.',
};

/** The planner's noise instructions for a level; empty when the level is Off. */
export function noisePlannerDirective(level: NoiseLevel): string {
  return level === 'off' ? '' : `${NOISE_PLANNER_DIRECTIVE}\n${NOISE_LEVEL_DIRECTIVES[level]}`;
}
/** The schema line the planner adds when noise is on. */
export const NOISE_SCHEMA_FIELD = `  "noise": [{ "hunkId": "hunk-7", "reason": string }],`;

/** The planner's `noise` list, cleaned: known hunk IDs only, once each, with a short reason. */
export function normalizePlannerNoise(value: unknown, hunkIds: ReadonlySet<string>): { hunkId: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: { hunkId: string; reason: string }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { hunkId, reason } = entry as Record<string, unknown>;
    if (typeof hunkId !== 'string' || !hunkIds.has(hunkId) || seen.has(hunkId)) continue;
    seen.add(hunkId);
    const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    result.push({ hunkId, reason: text || 'not part of the main change' });
  }
  return result;
}

// ── Rules: imports ──────────────────────────────────────────────

/** An import statement: its lines (1-based, inclusive) and the package it names, or null for a local or built-in module. */
interface ImportStatement {
  start: number;
  end: number;
  pkg: string | null;
}
type ImportFamily = 'script' | 'python' | 'go' | 'rust' | 'c' | 'csharp' | 'java' | 'swift' | 'ruby' | 'css' | 'php';
const FAMILIES: Record<string, ImportFamily> = {
  ts: 'script', tsx: 'script', mts: 'script', cts: 'script', js: 'script', jsx: 'script', mjs: 'script', cjs: 'script',
  mdx: 'script', md: 'script', vue: 'script', svelte: 'script', astro: 'script',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  cs: 'csharp',
  java: 'java', kt: 'java', kts: 'java', scala: 'java',
  swift: 'swift',
  rb: 'ruby',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  php: 'php',
};
function importFamily(path: string): ImportFamily | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? FAMILIES[name.slice(dot + 1)] : undefined;
}

const scriptPackage = (spec: string) => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('bun:')) return null;
  // Path aliases (`@/lib/x`, `~/x`, `#internal`) are the project's own files.
  if (spec.startsWith('@/') || spec.startsWith('~') || spec.startsWith('#')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};
const RUST_LOCAL = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc']);
const PATTERNS: Record<ImportFamily, { pattern: RegExp; pkg: (m: RegExpExecArray) => (string | null)[] }[]> = {
  script: [
    {
      // import x from 'y'; import { a,\n b } from 'y'; import type T from 'y'; import 'y'; import x = require('y')
      pattern: /^[ \t]*import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*|[\w$]+\s*=\s*require\s*\(\s*)?(['"])([^'"\n]+)\1\s*\)?[ \t]*;?[ \t]*$/gm,
      pkg: (m) => [scriptPackage(m[2])],
    },
    {
      pattern: /^[ \t]*(?:const|let|var)\s+[\w${}\s,:]+=\s*require\s*\(\s*(['"])([^'"\n]+)\1\s*\)[ \t]*;?[ \t]*$/gm,
      pkg: (m) => [scriptPackage(m[2])],
    },
  ],
  python: [
    {
      pattern: /^[ \t]*from\s+([\w.]+)\s+import\s+(?:\([^)]*\)|[^\n]+)$/gm,
      pkg: (m) => [m[1].startsWith('.') ? null : m[1].split('.')[0]],
    },
    {
      pattern: /^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)[ \t]*$/gm,
      pkg: (m) => m[1].split(',').map((part) => part.trim().split(/[\s.]/)[0]),
    },
  ],
  go: [
    {
      pattern: /^import\s+(?:[\w.]+\s+)?"([^"\n]+)"[ \t]*$/gm,
      pkg: (m) => [goPackage(m[1])],
    },
    {
      pattern: /^import\s*\(([^)]*)\)[ \t]*$/gm,
      pkg: (m) => [...m[1].matchAll(/"([^"\n]+)"/g)].map((p) => goPackage(p[1])),
    },
  ],
  rust: [
    {
      // `pub use` re-exports public API, so it is never import-only.
      pattern: /^[ \t]*(?:#\[[^\]\n]*\][ \t]*\n[ \t]*)?use\s+(?:::)?([\w]+)[^;]*;[ \t]*$/gm,
      pkg: (m) => [RUST_LOCAL.has(m[1]) ? null : m[1]],
    },
    { pattern: /^[ \t]*extern\s+crate\s+(\w+)[^;\n]*;[ \t]*$/gm, pkg: (m) => [m[1]] },
  ],
  c: [
    {
      pattern: /^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"][ \t]*$/gm,
      pkg: (m) => [m[1] === '<' ? m[2].split('/')[0] : null],
    },
  ],
  csharp: [
    {
      pattern: /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;[ \t]*$/gm,
      pkg: (m) => [m[1].startsWith('System') ? null : m[1].split('.').slice(0, 2).join('.')],
    },
  ],
  java: [
    {
      pattern: /^[ \t]*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?[ \t]*$/gm,
      pkg: (m) => [/^(java|javax|kotlin)\./.test(m[1]) ? null : m[1].split('.').slice(0, 2).join('.')],
    },
  ],
  swift: [{ pattern: /^[ \t]*(?:@testable\s+)?import\s+(?:\w+\s+)?([\w.]+)[ \t]*$/gm, pkg: (m) => [m[1].split('.')[0]] }],
  ruby: [
    {
      pattern: /^[ \t]*(require|require_relative)\s*\(?\s*(['"])([^'"\n]+)\2\s*\)?[ \t]*$/gm,
      pkg: (m) => [m[1] === 'require_relative' || m[3].startsWith('.') ? null : m[3].split('/')[0]],
    },
  ],
  css: [
    {
      pattern: /^[ \t]*@(?:import|use)\s+(?:url\()?\s*(['"]?)([^'")\s;]+)\1\)?[^;\n]*;[ \t]*$/gm,
      pkg: (m) => [scriptPackage(m[2])],
    },
  ],
  php: [
    {
      // Top level only: an indented `use` in a class body adds a trait.
      pattern: /^use\s+(?:function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+\w+)?\s*;[ \t]*$/gm,
      pkg: (m) => [m[1].split('\\').slice(0, 2).join('\\')],
    },
  ],
};
function goPackage(path: string): string | null {
  // Standard library paths have no dot in their first element.
  return path.split('/')[0].includes('.') ? path : null;
}

/** The import statements of a file, by line. */
export function importStatements(path: string, text: string): ImportStatement[] {
  const family = importFamily(path);
  if (!family || !text) return [];
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let low = 0,
      high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  // Docs: imports in an MDX header pull in components, not dependencies; lines in fenced code are examples.
  const docs = /\.mdx?$/i.test(path);
  const fenced = new Set<number>();
  if (docs) {
    let open = false;
    text.split('\n').forEach((line, i) => {
      const fence = /^[ \t]*(```|~~~)/.test(line);
      if (open || fence) fenced.add(i + 1);
      if (fence) open = !open;
    });
  }
  const statements: ImportStatement[] = [];
  for (const { pattern, pkg } of PATTERNS[family]) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      if (!m[0]) {
        pattern.lastIndex++;
        continue;
      }
      // A match starts at its line's start (the patterns are anchored with ^ and m): skip a leading newline it may include.
      const offset = m.index + (m[0].startsWith('\n') ? 1 : 0);
      const start = lineOf(offset),
        end = lineOf(m.index + m[0].length - 1);
      if (docs && fenced.has(start)) continue;
      const packages = docs ? [null] : pkg(m);
      // One statement per package, on the same lines: a Go import block names several.
      for (const p of packages.length ? packages : [null]) statements.push({ start, end, pkg: p });
    }
  }
  return statements;
}

type Row =
  | { type: '+'; text: string; newLine: number }
  | { type: '-'; text: string; oldLine: number }
  | { type: ' '; text: string; oldLine: number; newLine: number };
/** A hunk's rows with their line numbers on each side. */
export function hunkLines(hunk: Pick<Hunk, 'hunkHeader' | 'content'>): Row[] {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.hunkHeader);
  if (!header) return [];
  let oldLine = Number(header[1]) + (header[2] === '0' ? 1 : 0);
  let newLine = Number(header[3]) + (header[4] === '0' ? 1 : 0);
  const rows: Row[] = [];
  for (const line of hunk.content.split('\n')) {
    const sign = line[0];
    if (sign === '+') rows.push({ type: '+', text: line.slice(1), newLine: newLine++ });
    else if (sign === '-') rows.push({ type: '-', text: line.slice(1), oldLine: oldLine++ });
    else if (sign === ' ' || line === '') rows.push({ type: ' ', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
  }
  return rows;
}

/**
 * Whether every changed line of `hunk` belongs to an import statement (blank lines aside), and which packages its
 * added imports name that the old file did not import. Undefined when the hunk is not import-only or a side's text is
 * missing.
 */
export function importOnlyHunk(
  hunk: Hunk,
  before: string | undefined,
  after: string | undefined
): { newPackages: string[] } | undefined {
  if (hunk.fileStatus === 'deleted' || !importFamily(hunk.filePath)) return undefined;
  const added = hunk.fileStatus === 'added';
  if (after === undefined || (!added && before === undefined)) return undefined;
  const oldStatements = added ? [] : importStatements(hunk.filePath, before ?? '');
  const newStatements = importStatements(hunk.filePath, after);
  const holding = (statements: ImportStatement[], line: number) => statements.filter((s) => s.start <= line && line <= s.end);
  const rows = hunkLines(hunk);
  let changed = 0;
  const touched = new Set<ImportStatement>();
  for (const row of rows) {
    if (row.type === ' ') continue;
    if (!row.text.trim()) continue;
    changed++;
    const statements = row.type === '+' ? holding(newStatements, row.newLine) : holding(oldStatements, row.oldLine);
    if (!statements.length) return undefined;
    if (row.type === '+') statements.forEach((s) => touched.add(s));
  }
  if (!changed) return undefined;
  const known = new Set(oldStatements.map((s) => s.pkg).filter((p): p is string => !!p));
  const newPackages = [...new Set([...touched].map((s) => s.pkg).filter((p): p is string => !!p && !known.has(p)))];
  return { newPackages };
}

// ── Rules: whitespace, formatting and comments (lib/semantic-noise.ts) ──

/** One file for classifyNoise: its new text and its hunks in order, with each hunk's ID. */
export interface NoiseRequest {
  path: string;
  language: SyntaxLanguage;
  after: string;
  hunks: { oldStart: number; newStart: number; rows: { type: ' ' | '+' | '-'; text: string }[] }[];
  ids: string[];
}
/** The files whose hunks the syntax comparison can classify: a grammar, a new side, within the size limit. */
export function noiseRequests(
  hunks: readonly Hunk[],
  after: Record<string, string>,
  enabled: (language: SyntaxLanguage) => boolean = () => true
): NoiseRequest[] {
  const byFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    if (hunk.fileStatus === 'added' || hunk.fileStatus === 'deleted') continue;
    const list = byFile.get(hunk.filePath) ?? [];
    list.push(hunk);
    byFile.set(hunk.filePath, list);
  }
  const requests: NoiseRequest[] = [];
  for (const [path, list] of byFile) {
    const language = syntaxLanguage(path);
    const text = Object.hasOwn(after, path) ? after[path] : undefined;
    if (!language || text === undefined || text.length > NOISE_MAX_CHARACTERS || !enabled(language)) continue;
    const parsed = list.flatMap((hunk) => patchHunks(`${hunk.hunkHeader}\n${hunk.content}`)?.slice(0, 1) ?? []);
    if (parsed.length !== list.length) continue;
    requests.push({ path, language, after: text, hunks: parsed, ids: list.map((h) => h.id) });
  }
  return requests;
}
/** Each hunk's block kinds from its file's classification; a file whose blocks don't line up gives none. */
export function hunkNoiseKinds(requests: readonly NoiseRequest[], results: readonly (readonly NoiseKind[] | null | undefined)[]) {
  const kinds = new Map<string, NoiseKind[]>();
  requests.forEach((request, index) => {
    const blocks = results[index];
    if (!blocks) return;
    const counts = request.hunks.map((hunk) => changeBlocks([hunk]).length);
    if (counts.reduce((a, b) => a + b, 0) !== blocks.length) return;
    let at = 0;
    request.ids.forEach((id, i) => {
      kinds.set(id, blocks.slice(at, at + counts[i]));
      at += counts[i];
    });
  });
  return kinds;
}
/** The reason a hunk is quiet, or undefined when any of its blocks is code. */
export function quietReason(kinds: readonly NoiseKind[] | undefined): string | undefined {
  if (!kinds?.length || kinds.some((kind) => kind === 'code')) return undefined;
  if (kinds.every((kind) => kind === 'whitespace')) return 'whitespace';
  if (kinds.every((kind) => kind === 'whitespace' || kind === 'formatting')) return 'formatting';
  if (kinds.every((kind) => kind === 'comments')) return 'comments only';
  return 'formatting and comments';
}

/** The hunks the rules cut at `level`, with their reasons. */
export function ruleNoise(
  hunks: readonly Hunk[],
  before: Record<string, string>,
  after: Record<string, string>,
  kinds: ReadonlyMap<string, readonly NoiseKind[]>,
  level: NoiseLevel
): Map<string, string> {
  const cuts = new Map<string, string>();
  if (level === 'off') return cuts;
  const text = (files: Record<string, string>, path: string) => (Object.hasOwn(files, path) ? files[path] : undefined);
  for (const hunk of hunks) {
    const imports = importOnlyHunk(hunk, text(before, hunk.filePath), text(after, hunk.filePath));
    if (imports) {
      if (imports.newPackages.length && level === 'conservative') continue;
      cuts.set(hunk.id, imports.newPackages.length ? `import only (new dependency: ${imports.newPackages.join(', ')})` : 'import only');
      continue;
    }
    const quiet = quietReason(kinds.get(hunk.id));
    if (quiet) cuts.set(hunk.id, quiet);
  }
  return cuts;
}

// ── Routing ─────────────────────────────────────────────────────

/** Where a hunk's changed lines are, for its entry in the left-out list. */
export function changedRange(hunk: Pick<Hunk, 'hunkHeader' | 'content'>): Pick<LeftOutHunk, 'side' | 'startLine' | 'endLine'> {
  const rows = hunkLines(hunk);
  const added = rows.flatMap((row) => (row.type === '+' ? [row.newLine] : []));
  if (added.length) return { side: 'after', startLine: added[0], endLine: added[added.length - 1] };
  const removed = rows.flatMap((row) => (row.type === '-' ? [row.oldLine] : []));
  if (removed.length) return { side: 'before', startLine: removed[0], endLine: removed[removed.length - 1] };
  const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk.hunkHeader);
  const line = Number(header?.[1] ?? 1);
  return { side: 'after', startLine: line, endLine: line };
}

/**
 * The plan with noise taken out: topics lose their cut hunks, and a topic left with none disappears (prerequisites on
 * it are dropped). Rule cuts come from `ruleCuts`; planner cuts only from its `noise` list, and never a hunk it also
 * put in a topic. A hunk in neither stays unassigned, for "Other changes". Off changes nothing.
 */
export function applyNoise(
  topics: readonly TopicPlan[],
  hunks: readonly Hunk[],
  ruleCuts: ReadonlyMap<string, string>,
  plannerNoise: unknown,
  level: NoiseLevel
): { topics: TopicPlan[]; cut: Map<string, { reason: string; source: LeftOutHunk['source'] }>; leftOut: LeftOutHunk[] } {
  const cut = new Map<string, { reason: string; source: LeftOutHunk['source'] }>();
  if (level === 'off') return { topics: [...topics], cut, leftOut: [] };
  const ids = new Set(hunks.map((h) => h.id));
  for (const [id, reason] of ruleCuts) if (ids.has(id)) cut.set(id, { reason, source: 'rules' });
  const assigned = new Set(topics.flatMap((topic) => topic.hunkIds));
  for (const { hunkId, reason } of normalizePlannerNoise(plannerNoise, ids))
    if (!assigned.has(hunkId) && !cut.has(hunkId)) cut.set(hunkId, { reason, source: 'planner' });
  const dropped = new Set<string>();
  const kept = topics.flatMap((topic) => {
    const hunkIds = topic.hunkIds.filter((id) => !cut.has(id));
    if (topic.hunkIds.length && !hunkIds.length) {
      dropped.add(topic.title);
      return [];
    }
    return [{ ...topic, hunkIds }];
  });
  const result = kept.map((topic) =>
    topic.dependsOn.some((title) => dropped.has(title))
      ? { ...topic, dependsOn: topic.dependsOn.filter((title) => !dropped.has(title)) }
      : topic
  );
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const leftOut = [...cut]
    .flatMap(([id, { reason, source }]) => {
      const hunk = byId.get(id);
      return hunk ? [{ filePath: hunk.filePath, ...changedRange(hunk), reason, source }] : [];
    })
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
  return { topics: result, cut, leftOut };
}

/** Cut hunks in a kept topic's files: its writer sees them as context only. */
export function contextOnlyHunks<T extends Hunk>(topicHunkIds: readonly string[], hunks: readonly T[], cut: ReadonlySet<string> | ReadonlyMap<string, unknown>): T[] {
  const files = new Set(hunks.filter((h) => topicHunkIds.includes(h.id)).map((h) => h.filePath));
  return hunks.filter((h) => cut.has(h.id) && files.has(h.filePath));
}

/** The left-out list as saved, with only well-formed entries. */
export function normalizeNoiseReduction(value: unknown): NoiseReduction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const level = (['off', 'conservative', 'aggressive'] as const).find((l) => l === v.level);
  if (!level) return undefined;
  const leftOut = (Array.isArray(v.leftOut) ? v.leftOut : []).flatMap((entry): LeftOutHunk[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    if (typeof e.filePath !== 'string' || !Number.isInteger(e.startLine) || !Number.isInteger(e.endLine)) return [];
    return [
      {
        filePath: e.filePath,
        side: e.side === 'before' ? 'before' : 'after',
        startLine: e.startLine as number,
        endLine: e.endLine as number,
        reason: typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim().slice(0, 160) : 'noise',
        source: e.source === 'planner' ? 'planner' : 'rules',
      },
    ];
  });
  const defaultLevel = (['off', 'conservative', 'aggressive'] as const).find((l) => l === v.defaultLevel);
  return {
    level,
    leftOut,
    ...(defaultLevel ? { defaultLevel } : {}),
    ...(typeof v.repository === 'string' ? { repository: v.repository } : {}),
  };
}

/** `path:12-18`, or `path:12` for one line. */
export const leftOutLabel = (entry: Pick<LeftOutHunk, 'filePath' | 'startLine' | 'endLine'>) =>
  `${entry.filePath}:${entry.startLine}${entry.endLine > entry.startLine ? `-${entry.endLine}` : ''}`;

/** The repository's saved level, read as the main process reads its defaults. */
export function savedNoiseLevel(
  preferences: {
    repositorySettings?: Record<string, { explanation?: Partial<ExplanationPreferences> } | undefined>;
    localExplanationPreferences?: Record<string, Partial<ExplanationPreferences> | undefined>;
  },
  repository: string
): NoiseLevel {
  return normalizeExplanationPreferences(
    repository.startsWith('local:')
      ? preferences.localExplanationPreferences?.[repository]
      : preferences.repositorySettings?.[repository]?.explanation
  ).reduceNoise;
}

/**
 * Whether the repository's level changed since this explanation was made with the level it had then: the explanation
 * is out of date and can be regenerated. An explanation whose level was chosen for it alone is not.
 */
export function noiseLevelChanged(noise: NoiseReduction | undefined, current: NoiseLevel | undefined): boolean {
  return (
    !!noise?.defaultLevel &&
    current !== undefined &&
    noise.level === noise.defaultLevel &&
    current !== noise.level
  );
}

/** The hunks the rules leave out of a single-pass explanation, which has no planner. */
export function hunksAfterRules<T extends IndexedHunk>(hunks: readonly T[], ruleCuts: ReadonlyMap<string, string>): T[] {
  return hunks.filter((hunk) => !ruleCuts.has(hunk.id));
}
