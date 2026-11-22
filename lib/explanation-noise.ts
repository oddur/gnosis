import { blockKey, changeBlocks, NOISE_MAX_CHARACTERS, patchHunks, type NoiseBlock, type NoiseKind } from './semantic-noise';
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
 *   unless a tool reads the comment (a doctest, a fenced example, any Rust doc comment, a cgo preamble, a JSDoc type);
 *   or a hunk that only widens imports the file already has (importOnlyHunk). Nothing else about imports is cut.
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
    'Reduce noise: Aggressive. Also list edits with no runtime effect beyond the main change: renames, test data and fixtures that follow the main change, a field threaded through without changing any value, and doc or comment updates. Never list a hunk that changes what the code does at runtime: any change to a value, condition, call, string handling or data flow is behavior, however small or off-topic. Also never list dependency versions, public API or exports, SQL, or schema.',
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
 * The languages whose widening the rule can prove: TS/JS named specifiers, a Go package spec, a Rust `use`, a Java
 * single-type import. Python never (`from … import` runs the module), nor C# `using`, nor any other language.
 */
const WIDENING: ReadonlySet<SyntaxLanguage> = new Set(['typescript', 'tsx', 'javascript', 'go', 'rust', 'java']);

/**
 * The cheap check before the syntax tree is read: a language the rule covers, and a hunk (`rows`, of a modified file)
 * that only adds lines.
 */
export function importCandidate(path: string, rows: readonly Pick<Row, 'type' | 'text'>[]): boolean {
  const language = syntaxLanguage(path);
  if (!language || !WIDENING.has(language)) return false;
  return !rows.some((row) => row.type === '-') && rows.some((row) => row.type === '+' && !!row.text.trim());
}

/** A package's public entry file: its imports are its API. */
export const isPackageEntry = (path: string) =>
  /(^|\/)(__init__\.py|index\.(?:[cm]?[jt]sx?)|mod\.rs|lib\.rs)$/i.test(path);

/** Names a language defines without an import: binding one by import shadows it. */
const BUILTINS: Partial<Record<SyntaxLanguage, ReadonlySet<string>>> = {
  go: new Set(
    'append cap clear close complex copy delete imag len make max min new panic print println real recover any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr true false iota nil'.split(' ')
  ),
  rust: new Set(
    'Option Some None Result Ok Err Vec String Box ToString ToOwned Into From TryFrom TryInto Iterator IntoIterator Extend Default Clone Copy Send Sync Sized Unpin Drop Fn FnMut FnOnce Eq PartialEq Ord PartialOrd AsRef AsMut DoubleEndedIterator ExactSizeIterator FromIterator Debug Hash'.split(' ')
  ),
  java: new Set(
    'Object String Integer Long Short Byte Double Float Boolean Character Number Math System Thread Runnable Exception RuntimeException Error Throwable Iterable Comparable CharSequence StringBuilder Class Enum Record Void Override Deprecated FunctionalInterface SuppressWarnings'.split(' ')
  ),
};
const isBuiltin = (language: SyntaxLanguage, name: string) =>
  language === 'typescript' || language === 'tsx' || language === 'javascript'
    ? name in globalThis || /^(Promise|Map|Set|WeakMap|WeakSet|Symbol|Proxy|Reflect|JSON|Intl|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|ReturnType|Parameters|Awaited|NonNullable|InstanceType|window|document|navigator|process|Buffer|require|module|exports|global|globalThis|console|fetch|Response|Request|Headers|URL|Event|Element|Node|HTMLElement)$/.test(name)
    : (BUILTINS[language]?.has(name) ?? false);

/** Go's standard library has no dot in its path's first element; any other path is a module. */
function goPackage(path: string): string | null {
  return path.split('/')[0].includes('.') ? path : null;
}

/** A file's import nodes on both sides (lib/import-nodes.ts), rows counted from 0. */
export interface FileImports {
  before: ImportNode[];
  after: ImportNode[];
}

/** The path a Rust or Java binding sits in: everything before its last segment. */
const parentOf = (source: string, separator: string) => source.slice(0, Math.max(0, source.lastIndexOf(separator)));

/** What the old file imports and names, read once per file: a file's hunks each ask (Quiet changes asks for hundreds). */
const oldFiles = new WeakMap<FileImports, { language: SyntaxLanguage; text: string; value: ReturnType<typeof readOldFile> }>();
function oldFile(language: SyntaxLanguage, imports: FileImports, beforeText: string) {
  const known = oldFiles.get(imports);
  if (known && known.language === language && known.text === beforeText) return known.value;
  const value = readOldFile(language, imports, beforeText);
  oldFiles.set(imports, { language, text: beforeText, value });
  return value;
}
/**
 * A TS/JS import that binds only types: `import type …`, or braces whose every specifier is `type X`. The module never
 * loads at run time, so a value import from it is a new runtime dependency.
 */
function typeOnly(text: string): boolean {
  const flat = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^import\s+type\b/.test(flat)) return true;
  const clause = /^import\s+(.*?)\s+from\s/.exec(flat)?.[1] ?? '';
  const named = /^\{(.*)\}$/.exec(clause.trim())?.[1];
  const specifiers = (named ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((part) => /^type\s/.test(part));
}
function readOldFile(language: SyntaxLanguage, imports: FileImports, beforeText: string) {
  const script = language === 'typescript' || language === 'tsx' || language === 'javascript';
  const oldBindings = imports.before.filter((node) => !script || !typeOnly(node.text)).map((node) => importBindings(language, node.text));
  return {
    oldModules: new Set(oldBindings.map((b) => b.module).filter((m): m is string => !!m)),
    oldPairs: new Set(oldBindings.flatMap((b) => b.pairs.map(([local, source]) => `${local}\n${source}`))),
    oldParents: new Set(oldBindings.flatMap((b) => b.pairs.map(([, source]) => parentOf(source, language === 'rust' ? '::' : '.')))),
    words: new Set(beforeText.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []),
  };
}

/**
 * Whether a hunk of a modified file (`rows`, with their line numbers) only widens imports the file already has, the one
 * import change the rule can prove harmless: every changed line is an addition lying alone in an import node, and each
 * added binding is a plain name, new to the file (no shadowing of an import, a global, a builtin or a local), from a
 * module the file already loads at run time. False otherwise: removals, swaps, reorders, aliases, type-only imports,
 * side effects, re-exports, tool directives, entry files, Python, C#, a file with no syntax tree.
 */
export function importOnlyHunk(
  path: string,
  rows: readonly Row[],
  imports: FileImports | undefined,
  beforeText: string | undefined
): boolean {
  const language = syntaxLanguage(path);
  if (!imports || !language || beforeText === undefined || !importCandidate(path, rows) || isPackageEntry(path)) return false;
  const script = language === 'typescript' || language === 'tsx' || language === 'javascript';
  const touched = new Set<ImportNode>();
  for (const row of rows) {
    if (row.type !== '+' || !row.text.trim()) continue;
    const covering = imports.after.filter((node) => node.startRow <= row.newLine - 1 && row.newLine - 1 <= node.endRow);
    if (!covering.length || covering.some((node) => !node.alone || node.blocked)) return false;
    touched.add(covering.reduce((a, b) => (b.endRow - b.startRow < a.endRow - a.startRow ? b : a)));
  }
  if (!touched.size) return false;
  const { oldModules, oldPairs, oldParents, words } = oldFile(language, imports, beforeText);
  let added = 0;
  for (const node of touched) {
    const { module, pairs } = importBindings(language, node.text);
    if (/\bas\b/.test(node.text) || (script && /\btype\b/.test(node.text))) return false;
    if (language === 'go') {
      // A plain package spec added to an existing block, from the standard library: never a new dependency.
      if (!module || !/^\s*"/.test(node.text) || goPackage(module) !== null) return false;
      const block = imports.after.find((decl) => decl !== node && decl.startRow <= node.startRow && node.endRow <= decl.endRow);
      if (!block || !/^import\s*\(/.test(block.text) || !imports.before.some((old) => /^import\s*\(/.test(old.text)))
        return false;
    } else if (script) {
      if (!module || !oldModules.has(module)) return false;
      if (pairs.some(([, source]) => /#(default|\*)$/.test(source))) return false;
    } else if (language === 'java') {
      if (/\bstatic\b|\*/.test(node.text)) return false;
    }
    for (const [local, source] of pairs) {
      if (oldPairs.has(`${local}\n${source}`)) continue;
      added++;
      if (words.has(local) || isBuiltin(language, local)) return false;
      if (language === 'rust' || language === 'java') {
        const parent = parentOf(source, language === 'rust' ? '::' : '.');
        if (!parent || !oldParents.has(parent)) return false;
        if (source.slice(parent.length).replace(/^(::|\.)/, '') !== local) return false;
      } else if (script && source !== `${module}#${local}`) return false;
    }
  }
  return added > 0;
}

/** A hunk as the noise comparison reads it (lib/semantic-noise.ts): starts already moved past a side with no lines. */
export interface RowHunk {
  oldStart: number;
  newStart: number;
  rows: readonly { type: ' ' | '+' | '-'; text: string }[];
}
/** A RowHunk's rows with their line numbers on each side, as hunkLines gives a diff hunk's. */
function numbered(hunk: RowHunk): Row[] {
  let oldLine = hunk.oldStart,
    newLine = hunk.newStart;
  return hunk.rows.map((row): Row =>
    row.type === '+'
      ? { type: '+', text: row.text, newLine: newLine++ }
      : row.type === '-'
        ? { type: '-', text: row.text, oldLine: oldLine++ }
        : { type: ' ', text: row.text, oldLine: oldLine++, newLine: newLine++ }
  );
}

/** Whether any of a modified file's patch hunks passes the import pre-filter: only then are its import nodes read. */
export const importCandidates = (path: string, patch: readonly RowHunk[]) => patch.some((hunk) => importCandidate(path, hunk.rows));

/**
 * Quiet changes' Imports (#396), by the rule above. The rule reads the file's patch hunks, as GitHub groups them and
 * as Reduce noise reads them, never a view's, whose grouping follows its context lines. Each code block of `blocks`
 * (any view's, of the same diff) that is a change block of an import-only patch hunk becomes `imports`. A file with no
 * import nodes or no old text changes nothing.
 */
export function importBlocks(
  path: string,
  patch: readonly RowHunk[],
  blocks: readonly NoiseBlock[],
  imports: FileImports | undefined,
  before: string | undefined
): NoiseBlock[] {
  if (!imports || before === undefined) return [...blocks];
  const quiet = new Set(
    patch.filter((hunk) => importOnlyHunk(path, numbered(hunk), imports, before)).flatMap((hunk) => changeBlocks([hunk]).map(blockKey))
  );
  return blocks.map((block) => (block.kind === 'code' && quiet.has(blockKey(block)) ? { ...block, kind: 'imports' } : block));
}

/**
 * A noise comparison's blocks with the rule applied, as the syntax worker answers Changes and Explanation diffs. Whole
 * hunks rebuild the old text, so its import nodes come from the comparison's trees. A topic's few hunks cannot: its
 * old text comes from the view and is parsed here, and without it nothing changes.
 */
export async function withImportBlocks(
  engine: { imports(language: SyntaxLanguage, text: string): Promise<ImportNode[] | undefined> },
  language: SyntaxLanguage,
  request: { path: string; patch: readonly RowHunk[]; before?: string },
  result: { blocks: NoiseBlock[]; imports?: { before?: ImportNode[]; after: ImportNode[]; beforeText: string } }
): Promise<NoiseBlock[]> {
  const found = result.imports;
  if (!found) return result.blocks;
  if (request.before === undefined)
    return importBlocks(request.path, request.patch, result.blocks, found.before && { before: found.before, after: found.after }, found.beforeText);
  const before = await engine.imports(language, request.before).catch(() => undefined);
  return importBlocks(request.path, request.patch, result.blocks, before && { before, after: found.after }, request.before);
}

// ── Rules: comments a tool reads ────────────────────────────────

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--)/;
const JSDOC_TYPES =
  /@(type|typedef|callback|template|satisfies|import|enum|this|extends|augments|implements|overload)\b|@(param|returns?|property|prop|arg|argument)\s*\{/;

/**
 * Whether the comment or docstring holding `line` (from 1) is read by a tool, so changing it is not comment-only: a
 * Python docstring with a doctest (`>>>`), a doc comment with a fenced code example, any Rust doc comment (rustdoc runs
 * its examples, indented ones too), a Go cgo preamble (the comment right above `import "C"`), or a JSDoc type in a
 * JavaScript file.
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
  const block = lines.slice(start, end + 1);
  if (block.some((l) => l.includes('```'))) return true;
  if (/\.rs$/i.test(path) && block.some((l) => /^\s*(\/\/[/!]|\/\*[*!])/.test(l))) return true;
  if (/\.go$/i.test(path)) {
    let next = end + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    if (/^\s*import\s+"C"\s*$/.test(lines[next] ?? '')) return true;
  }
  return /\.(c|m)?jsx?$/i.test(path) && JSDOC_TYPES.test(block.join('\n'));
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
    const imports = list.some((hunk) => hunk.fileStatus === 'modified' && importCandidate(hunk.filePath, hunkLines(hunk)));
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
  if (!kinds?.length || kinds.some((kind) => kind === 'code' || kind === 'imports')) return undefined;
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
    // A widening names no new module, so it is never a new dependency: both levels cut it.
    const file = classified.imports.get(hunk.filePath);
    if (hunk.fileStatus === 'modified' && importOnlyHunk(hunk.filePath, hunkLines(hunk), file, text(before, hunk.filePath))) {
      cuts.set(hunk.id, 'import only');
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
