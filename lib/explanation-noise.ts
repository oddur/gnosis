import { changeBlocks, NOISE_MAX_CHARACTERS, patchHunks, type NoiseKind } from './semantic-noise';
import { syntaxLanguage, type SyntaxLanguage } from './syntax-scope';
import { importBindings, type ImportNode } from './import-nodes';
import {
  normalizeExplanationPreferences,
  type ExplanationPreferences,
  type NoiseLevel,
} from './explanation-options';
import type { ParsedHunk } from './diff-parse';
import type { TopicPlan } from './types';

/**
 * Reduce noise: the explanation explains the change's essential complexity and leaves out hunks a reviewer doesn't need
 * explained. Changes still shows every hunk, and the overview lists the ones left out.
 *
 * Two layers, both fail closed (a hunk is cut only when all of it is noise; any doubt keeps it):
 * - Rules, no model: a hunk whose every change block is whitespace, formatting or comments (lib/semantic-noise.ts),
 *   unless a tool reads the comment (a doctest, a fenced example, a JSDoc type); or whose every changed line lies alone
 *   in an import node of the file's syntax tree (lib/import-nodes.ts). Side-effect imports, re-exports, a name bound
 *   to something else, and a package's entry file are never import-only, and a file with no grammar never is. An import
 *   of a package the file didn't import before is a new dependency: kept at Conservative, cut at Aggressive.
 * - The planner, in the same call that plans the topics: it lists the hunks it judges noise in `noise`. Only listed
 *   hunks whose whole source was in its evidence are cut. A hunk it neither assigns nor lists still goes to "Other
 *   changes". A hunk it both assigns and lists stays in its topic.
 * - When the cuts would leave nothing, nothing is cut: the noise is the change.
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
      // Bare forms only: `@use 'x' with (…)` and `@import … layer(…)`/media configure what they load.
      pattern: /^[ \t]*@(?:import\s+url\(\s*(['"]?)([^'")\s;]+)\1\s*\)|use\s+(['"])([^'"\s;]+)\3)\s*;[ \t]*$/gm,
      pkg: (m) => [scriptPackage((m[2] as string | undefined) ?? m[4])],
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

/** The pre-filter: whether every changed line of `hunk` matches an import pattern. The syntax tree decides. */
export function importCandidate(
  hunk: Hunk,
  before: string | undefined,
  after: string | undefined
): boolean {
  if (hunk.fileStatus === 'deleted' || !importFamily(hunk.filePath)) return false;
  const added = hunk.fileStatus === 'added';
  if (after === undefined || (!added && before === undefined)) return false;
  const oldStatements = added ? [] : importStatements(hunk.filePath, before ?? '');
  const newStatements = importStatements(hunk.filePath, after);
  const holding = (statements: ImportStatement[], line: number) => statements.filter((s) => s.start <= line && line <= s.end);
  const rows = hunkLines(hunk);
  let changed = 0;
  for (const row of rows) {
    if (row.type === ' ') continue;
    if (!row.text.trim()) continue;
    changed++;
    const statements = row.type === '+' ? holding(newStatements, row.newLine) : holding(oldStatements, row.oldLine);
    if (!statements.length) return false;
  }
  return changed > 0;
}


/** A package's public entry file: its imports are its API. */
export const isPackageEntry = (path: string) =>
  /(^|\/)(__init__\.py|index\.(?:[cm]?[jt]sx?)|mod\.rs|lib\.rs)$/i.test(path);

/** The package an import names, or null for a local or built-in module. */
function packageOf(language: SyntaxLanguage, module: string | null): string | null {
  if (!module) return null;
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return scriptPackage(module);
    case 'python':
      return module.startsWith('.') ? null : module.split('.')[0];
    case 'go':
      return goPackage(module);
    case 'rust':
      return RUST_LOCAL.has(module) ? null : module;
    case 'java':
      return /^(java|javax|kotlin)\./.test(module) ? null : module.split('.').slice(0, 2).join('.');
    case 'csharp':
      return module.startsWith('System') ? null : module.split('.').slice(0, 2).join('.');
    default:
      return null;
  }
}

/** A file's import nodes on both sides (lib/import-nodes.ts), rows counted from 0. */
export interface FileImports {
  before: ImportNode[];
  after: ImportNode[];
}

/**
 * Whether every changed line of `hunk` lies alone in an import node of its side's syntax tree (blank lines aside), and
 * which packages its added imports name that the old file did not import. Undefined when it is not import-only, and
 * whenever in doubt: no syntax tree, a side-effect import, a re-export, a name bound to something else, a package's
 * entry file.
 */
export function importOnlyHunk(hunk: Hunk, imports: FileImports | undefined): { newPackages: string[] } | undefined {
  const language = syntaxLanguage(hunk.filePath);
  if (!imports || !language || hunk.fileStatus === 'added' || hunk.fileStatus === 'deleted') return undefined;
  if (isPackageEntry(hunk.filePath)) return undefined;
  const touched = { before: new Set<ImportNode>(), after: new Set<ImportNode>() };
  let changed = 0;
  for (const row of hunkLines(hunk)) {
    if (row.type === ' ' || !row.text.trim()) continue;
    changed++;
    const side = row.type === '+' ? 'after' : 'before';
    const index = (row.type === '+' ? row.newLine : row.oldLine) - 1;
    const covering = imports[side].filter((node) => node.startRow <= index && index <= node.endRow);
    if (!covering.length || covering.some((node) => !node.alone || node.blocked)) return undefined;
    // The innermost node names the import: a Go spec rather than its declaration.
    touched[side].add(covering.reduce((a, b) => (b.endRow - b.startRow < a.endRow - a.startRow ? b : a)));
  }
  if (!changed) return undefined;
  const bindings = (nodes: Iterable<ImportNode>) => [...nodes].map((node) => importBindings(language, node.text));
  const oldBindings = bindings(touched.before),
    newBindings = bindings(touched.after);
  // A local name bound to something else, or the same import under another name, changes what the code refers to.
  const index = (list: ReturnType<typeof bindings>, key: 0 | 1) => {
    const map = new Map<string, Set<string>>();
    for (const { pairs } of list)
      for (const pair of pairs) map.set(pair[key], (map.get(pair[key]) ?? new Set()).add(pair[1 - key]));
    return map;
  };
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((v) => b.has(v));
  for (const key of [0, 1] as const) {
    const before = index(oldBindings, key),
      after = index(newBindings, key);
    for (const [name, values] of before) {
      const now = after.get(name);
      if (now && !same(values, now)) return undefined;
    }
  }
  const known = new Set(
    imports.before.map((node) => packageOf(language, importBindings(language, node.text).module)).filter(Boolean)
  );
  const newPackages = [
    ...new Set(
      newBindings.map((b) => packageOf(language, b.module)).filter((p): p is string => !!p && !known.has(p))
    ),
  ];
  return { newPackages };
}

// ── Rules: comments a tool reads ────────────────────────────────

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--)/;
const JSDOC_TYPES =
  /@(type|typedef|callback|template|satisfies|import|enum|this|extends|augments|implements|overload)\b|@(param|returns?|property|prop|arg|argument)\s*\{/;

/**
 * Whether the comment or docstring holding `line` (from 1) is read by a tool, so changing it is not comment-only: a
 * Python docstring with a doctest (`>>>`), a doc comment with a fenced code example (Rust and others run them), or a
 * JSDoc type annotation in a JavaScript file.
 */
export function toolReadComment(path: string, text: string | undefined, line: number): boolean {
  if (text === undefined) return true;
  const lines = text.split('\n');
  const at = line - 1;
  if (at < 0 || at >= lines.length) return true;
  if (/\.pyi?$/i.test(path)) {
    let open: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      const quotes = (lines[i].match(/"""|'''/g) ?? []).length;
      if (open === undefined && quotes % 2 === 1) open = i;
      else if (open !== undefined && quotes % 2 === 1) {
        if (open <= at && at <= i && lines.slice(open, i + 1).some((l) => l.includes('>>>'))) return true;
        open = undefined;
      } else if (open === undefined && quotes >= 2 && i === at && lines[i].includes('>>>')) return true;
    }
  }
  let start = at,
    end = at;
  while (start > 0 && COMMENT_LINE.test(lines[start - 1])) start--;
  while (end < lines.length - 1 && COMMENT_LINE.test(lines[end + 1])) end++;
  const block = lines.slice(start, end + 1).join('\n');
  if (block.includes('```')) return true;
  return /\.(c|m)?jsx?$/i.test(path) && JSDOC_TYPES.test(block);
}

// ── Rules: whitespace, formatting and comments (lib/semantic-noise.ts) ──

/** One file for classifyNoise: its new text and its hunks in order, with each hunk's ID. */
export interface NoiseRequest {
  path: string;
  language: SyntaxLanguage;
  after: string;
  hunks: { oldStart: number; newStart: number; rows: { type: ' ' | '+' | '-'; text: string }[] }[];
  ids: string[];
  /** Also read both sides' import nodes: a hunk passed the import pre-filter. */
  imports: boolean;
}
/** What the worker answers for a file: its change blocks' kinds, and its import nodes when asked. Null on failure. */
export interface NoiseAnswer {
  kinds: NoiseKind[] | null;
  imports?: FileImports | null;
}
/** The files whose hunks the syntax comparison can classify: a grammar, a new side, within the size limit. */
export function noiseRequests(
  hunks: readonly Hunk[],
  before: Record<string, string>,
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
  const text = (files: Record<string, string>, path: string) => (Object.hasOwn(files, path) ? files[path] : undefined);
  const requests: NoiseRequest[] = [];
  for (const [path, list] of byFile) {
    const language = syntaxLanguage(path);
    const newText = text(after, path);
    if (!language || newText === undefined || newText.length > NOISE_MAX_CHARACTERS || !enabled(language)) continue;
    const parsed = list.flatMap((hunk) => patchHunks(`${hunk.hunkHeader}\n${hunk.content}`)?.slice(0, 1) ?? []);
    if (parsed.length !== list.length) continue;
    const imports = list.some((hunk) => importCandidate(hunk, text(before, path), newText));
    requests.push({ path, language, after: newText, hunks: parsed, ids: list.map((h) => h.id), imports });
  }
  return requests;
}
/** Each hunk's block kinds, and each file's import nodes, from the worker's answers. A mismatch gives none. */
export function classifiedNoise(requests: readonly NoiseRequest[], answers: readonly (NoiseAnswer | null | undefined)[]) {
  const kinds = new Map<string, NoiseKind[]>();
  const imports = new Map<string, FileImports>();
  requests.forEach((request, index) => {
    const answer = answers[index];
    if (answer?.imports) imports.set(request.path, answer.imports);
    const blocks = answer?.kinds;
    if (!blocks) return;
    const counts = request.hunks.map((hunk) => changeBlocks([hunk]).length);
    if (counts.reduce((a, b) => a + b, 0) !== blocks.length) return;
    let at = 0;
    request.ids.forEach((id, i) => {
      kinds.set(id, blocks.slice(at, at + counts[i]));
      at += counts[i];
    });
  });
  return { kinds, imports };
}
export type ClassifiedNoise = ReturnType<typeof classifiedNoise>;
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
  classified: ClassifiedNoise,
  level: NoiseLevel
): Map<string, string> {
  const cuts = new Map<string, string>();
  if (level === 'off') return cuts;
  const text = (files: Record<string, string>, path: string) => (Object.hasOwn(files, path) ? files[path] : undefined);
  for (const hunk of hunks) {
    const imports = importOnlyHunk(hunk, classified.imports.get(hunk.filePath));
    if (imports) {
      if (imports.newPackages.length && level === 'conservative') continue;
      cuts.set(hunk.id, imports.newPackages.length ? `import only (new dependency: ${imports.newPackages.join(', ')})` : 'import only');
      continue;
    }
    const quiet = quietReason(classified.kinds.get(hunk.id));
    if (!quiet) continue;
    // A comment a tool reads is code: a doctest, a fenced example, a JSDoc type.
    if (
      quiet.includes('comments') &&
      hunkLines(hunk).some(
        (row) =>
          row.type !== ' ' &&
          toolReadComment(
            hunk.filePath,
            text(row.type === '+' ? after : before, hunk.filePath),
            row.type === '+' ? row.newLine : row.oldLine
          )
      )
    )
      continue;
    cuts.set(hunk.id, quiet);
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
  level: NoiseLevel,
  /** Hunks whose whole source was in the planner's evidence: the only ones its list can cut. */
  evidence: ReadonlySet<string> = new Set()
): { topics: TopicPlan[]; cut: Map<string, { reason: string; source: LeftOutHunk['source'] }>; leftOut: LeftOutHunk[] } {
  const cut = new Map<string, { reason: string; source: LeftOutHunk['source'] }>();
  if (level === 'off') return { topics: [...topics], cut, leftOut: [] };
  const ids = new Set(hunks.map((h) => h.id));
  for (const [id, reason] of ruleCuts) if (ids.has(id)) cut.set(id, { reason, source: 'rules' });
  const assigned = new Set(topics.flatMap((topic) => topic.hunkIds));
  for (const { hunkId, reason } of normalizePlannerNoise(plannerNoise, ids))
    if (evidence.has(hunkId) && !assigned.has(hunkId) && !cut.has(hunkId))
      cut.set(hunkId, { reason, source: 'planner' });
  // When everything would go, the noise is the change: explain it.
  if (hunks.length && cut.size >= hunks.length) return { topics: [...topics], cut: new Map(), leftOut: [] };
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
