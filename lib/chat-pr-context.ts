/**
 * PR-wide context for chat: the whole change, not one file, filled by relevance up to a token budget.
 *
 * Both chats use it. The main process builds it per question (src/main.ts, `ask-pr-file` and `send-slide-chat`):
 * what is relevant depends on the question. Fill order, most relevant first, until the budget is used:
 *
 * 1. The PR: title, description, and every changed file with its +/− counts. Always included.
 * 2. The anchor: the selected code, then the anchor files' diffs (a file chat's file, or a topic's files), with the
 *    enclosing definition git names in each hunk header.
 * 3. Files related to the anchor through code, strongest edge first: a symbol the anchor's changes use that the file
 *    defines, or one the anchor defines that the file uses (definitions from tree-sitter where the caller parsed them,
 *    else from definition-like lines); then an import either way (lib/import-paths.ts, as the explanation's neighbour
 *    reading resolves imports); then the same directory.
 * 4. Files named in the question or the conversation, by path, file name or a symbol they define.
 * 5. The rest of the PR's diffs, closest to the anchor first (same directory, then the longest shared path prefix),
 *    smaller first. A diff too large for what is left goes in hunk by hunk.
 * 6. With budget still left: the anchor's head source, first the definitions its changes touch, then the whole file.
 *
 * Every item says why it is there. Files that did not fit are listed by path, so the model knows they exist. No React
 * or Node imports.
 */
import { extractImports, resolveImport } from './import-paths';

/** "Chat context size" presets, in tokens. */
export const CHAT_CONTEXT_BUDGETS = [32_000, 64_000, 128_000] as const;
export type ChatContextBudget = (typeof CHAT_CONTEXT_BUDGETS)[number];
export const DEFAULT_CHAT_CONTEXT_BUDGET: ChatContextBudget = 64_000;

/** The size of text in tokens, by the 4 characters a token the explanation's context builder assumes. */
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export function normalizeChatContextBudget(value: unknown): ChatContextBudget {
  return (CHAT_CONTEXT_BUDGETS as readonly unknown[]).includes(value)
    ? (value as ChatContextBudget)
    : DEFAULT_CHAT_CONTEXT_BUDGET;
}

export const chatContextBudgetLabel = (budget: number) => `${Math.round(budget / 1000)}k`;

export interface ChatContextFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** A definition, as tree-sitter's `collectDefinitions` reports it: lines from 1, inclusive. */
export interface ChatContextDefinition {
  name: string;
  label?: string;
  start: number;
  end: number;
}

export interface ChatContextInput {
  title: string;
  description: string;
  files: readonly ChatContextFile[];
  /** The files the chat is about: the file a file chat was opened on, or a topic's files. */
  anchor: readonly string[];
  /** How the anchor reads in a label: `the file`, `the topic`. */
  anchorName?: string;
  /** The selected code, as lib/chat-selection.ts formats it. */
  selection?: string;
  question: string;
  history?: readonly { content: string }[];
  /** Head source of files the caller read, by path: the anchor's, at least, when it has it. */
  sources?: Readonly<Record<string, string>>;
  /**
   * Definitions by path: for a file with a source, the whole file's; for others, those found in its hunks' new
   * side. The caller parses them with tree-sitter; without them, definition-like lines stand in.
   */
  definitions?: Readonly<Record<string, readonly ChatContextDefinition[]>>;
  budgetTokens: number;
}

export type ChatContextKind = 'pr' | 'selection' | 'anchor' | 'related' | 'mentioned' | 'diff' | 'source';

export interface ChatContextItem {
  kind: ChatContextKind;
  path?: string;
  /** Why it is included, as the model and the trace read it: `imports scope.ts`, `defines go()`. */
  reason: string;
  tokens: number;
  /** Some of the file's hunks, when the whole diff did not fit. */
  partial?: { hunks: number; of: number };
}

export interface ChatContextResult {
  /** The context block for the prompt. */
  text: string;
  items: ChatContextItem[];
  /** Changed files with nothing included, by path. */
  leftOut: string[];
  tokens: number;
  budget: number;
}

export interface Relation {
  path: string;
  /** 3: a symbol, 2: an import, 1: the same directory. */
  strength: 1 | 2 | 3;
  reason: string;
}

const baseName = (path: string) => path.split('/').at(-1) ?? path;
const dirName = (path: string) => path.split('/').slice(0, -1).join('/');

interface Hunk {
  header: string;
  /** The enclosing definition git names after the header, such as `function retry()`. */
  context: string;
  body: string;
  added: string[];
  /** New-side lines: context and added. */
  newLines: string[];
  newStart: number;
  newCount: number;
}

export function parseHunks(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header) {
      current = {
        header: line,
        context: header[3].trim(),
        body: '',
        added: [],
        newLines: [],
        newStart: Number(header[1]),
        newCount: Number((header[2] as string | undefined) ?? 1),
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.body += (current.body ? '\n' : '') + line;
    if (line.startsWith('+')) {
      current.added.push(line.slice(1));
      current.newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) current.newLines.push(line.slice(1));
  }
  return hunks;
}

/** Definition-like lines, for files no one parsed: `function x`, `class X`, `const x =`, `def x`, `fn x`, `func x`. */
const DEFINITION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/;

function definedNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const match = DEFINITION.exec(line);
    if (match && match[1].length > 2) names.add(match[1]);
  }
  return names;
}

const KEYWORDS = new Set(
  'const let var function return export import from await async class interface type enum new this true false null undefined void if else for while switch case break continue default throw try catch finally typeof instanceof extends implements public private protected static readonly string number boolean unknown never any def self None True False pub fn struct impl trait use mod func package nil'.split(
    ' '
  )
);

function identifiers(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines)
    for (const match of line.matchAll(/[A-Za-z_$][\w$]{2,}/g)) if (!KEYWORDS.has(match[0])) names.add(match[0]);
  return names;
}

/** Names a file defines: tree-sitter's when given, else definition-like lines in its source or hunks. */
function namesDefinedBy(input: ChatContextInput, path: string, hunks: Hunk[]): Set<string> {
  const parsed = input.definitions?.[path];
  if (parsed?.length) return new Set(parsed.map((d) => d.name).filter((n) => n.length > 2));
  const source = input.sources?.[path];
  return definedNames(source ? source.split('\n') : hunks.flatMap((h) => h.newLines));
}

/** Names the anchor's changes define or change: definitions that overlap a changed line, else changed definitions. */
function namesChangedBy(input: ChatContextInput, path: string, hunks: Hunk[]): Set<string> {
  const parsed = input.definitions?.[path];
  if (parsed?.length && input.sources?.[path]) {
    const changed = changedLines(hunks);
    return new Set(parsed.filter((d) => changed.some((line) => line >= d.start && line <= d.end)).map((d) => d.name));
  }
  return definedNames(hunks.flatMap((h) => h.added));
}

function changedLines(hunks: Hunk[]): number[] {
  const lines: number[] = [];
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const row of hunk.body.split('\n')) {
      if (row.startsWith('-')) continue;
      if (row.startsWith('+')) lines.push(line);
      line++;
    }
  }
  return lines;
}

/**
 * How each other changed file relates to the anchor through code, strongest first. One relation a file: its
 * strongest edge, with the reason the model reads.
 */
export function relateToAnchor(input: ChatContextInput): Relation[] {
  const files = new Map(input.files.map((f) => [f.path, f]));
  const paths = new Set(files.keys());
  const anchors = input.anchor.filter((p) => paths.has(p));
  const hunks = new Map(input.files.map((f) => [f.path, parseHunks(f.patch)]));
  const best = new Map<string, Relation>();
  const offer = (relation: Relation) => {
    if (anchors.includes(relation.path)) return;
    const known = best.get(relation.path);
    if (!known || relation.strength > known.strength) best.set(relation.path, relation);
  };
  for (const anchor of anchors) {
    const anchorHunks = hunks.get(anchor) ?? [];
    const used = identifiers(anchorHunks.flatMap((h) => h.added));
    const changed = namesChangedBy(input, anchor, anchorHunks);
    for (const file of input.files) {
      if (file.path === anchor) continue;
      const theirs = hunks.get(file.path) ?? [];
      // Symbols: the anchor's changes use a name the file defines, or the file uses a name the anchor changes.
      const defines = [...namesDefinedBy(input, file.path, theirs)].find((name) => used.has(name));
      if (defines) {
        offer({ path: file.path, strength: 3, reason: `defines \`${defines}\`, which ${baseName(anchor)} uses` });
        continue;
      }
      const theirLines = theirs.flatMap((h) => h.newLines);
      const uses = [...changed].find((name) =>
        theirLines.some((line) => new RegExp(`\\b${escape(name)}\\b`).test(line))
      );
      if (uses) {
        offer({ path: file.path, strength: 3, reason: `uses \`${uses}\` from ${baseName(anchor)}` });
        continue;
      }
      // Imports, either way: the anchor's whole source when the caller read it, else the lines its diff shows.
      const anchorText = input.sources?.[anchor] ?? anchorHunks.flatMap((h) => h.newLines).join('\n');
      const imported = extractImports(anchorText, anchor).some((base) => resolveImport(base, paths) === file.path);
      if (imported) {
        offer({ path: file.path, strength: 2, reason: `imported by ${baseName(anchor)}` });
        continue;
      }
      const theirText = input.sources?.[file.path] ?? theirLines.join('\n');
      const importsAnchor = extractImports(theirText, file.path).some((base) => resolveImport(base, paths) === anchor);
      if (importsAnchor) {
        offer({ path: file.path, strength: 2, reason: `imports ${baseName(anchor)}` });
        continue;
      }
      if (dirName(file.path) === dirName(anchor))
        offer({ path: file.path, strength: 1, reason: `in the same directory as ${baseName(anchor)}` });
    }
  }
  return [...best.values()].sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files the question or the conversation names: by path, file name, or a symbol the file defines. */
export function mentionedFiles(input: ChatContextInput): { path: string; reason: string }[] {
  const question = input.question;
  const conversation = (input.history ?? []).map((m) => m.content).join('\n');
  const found: { path: string; reason: string }[] = [];
  for (const file of input.files) {
    const where = (text: string) => {
      if (text.includes(file.path)) return true;
      const name = baseName(file.path);
      return new RegExp(`(^|[^\\w./-])${escape(name)}($|[^\\w-])`).test(text);
    };
    if (where(question)) found.push({ path: file.path, reason: 'named in your question' });
    else if (where(conversation)) found.push({ path: file.path, reason: 'named earlier in the conversation' });
    else {
      const symbols = namesDefinedBy(input, file.path, parseHunks(file.patch));
      const symbol = [...symbols].find((name) => name.length > 3 && new RegExp(`\\b${escape(name)}\\b`).test(question));
      if (symbol) found.push({ path: file.path, reason: `defines \`${symbol}\`, named in your question` });
    }
  }
  return found;
}

/** How close a file is to the anchor: the same directory first, then the longest shared path prefix. */
function closeness(path: string, anchors: readonly string[]): number {
  let best = 0;
  for (const anchor of anchors) {
    if (dirName(anchor) === dirName(path)) return 1000;
    const a = anchor.split('/'),
      b = path.split('/');
    let shared = 0;
    while (shared < a.length - 1 && shared < b.length - 1 && a[shared] === b[shared]) shared++;
    best = Math.max(best, shared);
  }
  return best;
}

const fileTag = (file: ChatContextFile, reason: string, extra = '') =>
  `<file path="${file.path}"${file.previousPath ? ` previous="${file.previousPath}"` : ''} status="${file.status}" changes="+${file.additions} -${file.deletions}" included="${reason}"${extra}>`;

export function buildChatPrContext(input: ChatContextInput): ChatContextResult {
  const budget = Math.max(1000, input.budgetTokens);
  const items: ChatContextItem[] = [];
  const parts: string[] = [];
  let used = 0;
  const files = new Map(input.files.map((f) => [f.path, f]));
  const included = new Set<string>();
  const fits = (text: string) => used + estimateTokens(text) <= budget;
  const add = (item: Omit<ChatContextItem, 'tokens'>, text: string) => {
    const tokens = estimateTokens(text);
    used += tokens;
    parts.push(text);
    items.push({ ...item, tokens });
    if (item.path) included.add(item.path);
  };

  // 1. The PR, always.
  const list = input.files.map((f) => `- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`).join('\n');
  add(
    { kind: 'pr', reason: 'the PR: title, description and file list' },
    `<pr>\nTitle: ${input.title}\nDescription:\n${input.description.slice(0, 20_000)}\n\nChanged files (${input.files.length}):\n${list}\n</pr>`
  );

  // 2. The anchor: the selection first, then its diffs.
  if (input.selection?.trim())
    add(
      { kind: 'selection', reason: 'the code you selected' },
      `<selected_code>\n${input.selection}\n</selected_code>`
    );
  const anchorName = input.anchorName ?? 'the file';
  const anchors = input.anchor.filter((p) => files.has(p));
  const diffItem = (file: ChatContextFile | undefined, kind: ChatContextKind, reason: string) => {
    if (!file) return;
    const hunks = parseHunks(file.patch);
    const whole = `${fileTag(file, reason)}\n${file.patch ?? '(no text diff)'}\n</file>`;
    if (fits(whole)) {
      add({ kind, path: file.path, reason }, whole);
      return;
    }
    // Hunk by hunk: each with the definition git names around it.
    let text = '';
    let count = 0;
    for (const hunk of hunks) {
      const next = `${hunk.header}\n${hunk.body}\n`;
      const candidate = `${fileTag(file, reason, ` partial="${count + 1} of ${hunks.length} hunks"`)}\n${text}${next}</file>`;
      if (!fits(candidate)) break;
      text += next;
      count++;
    }
    if (count)
      add(
        { kind, path: file.path, reason, partial: { hunks: count, of: hunks.length } },
        `${fileTag(file, reason, ` partial="${count} of ${hunks.length} hunks"`)}\n${text}</file>`
      );
  };
  for (const path of anchors) diffItem(files.get(path), 'anchor', `${anchorName} you asked about`);

  // 3. Related through code. 4. Named in the question or the conversation.
  for (const relation of relateToAnchor(input))
    if (!included.has(relation.path)) diffItem(files.get(relation.path), 'related', relation.reason);
  for (const mention of mentionedFiles(input))
    if (!included.has(mention.path)) diffItem(files.get(mention.path), 'mentioned', mention.reason);

  // 5. The rest: closest to the anchor, then smaller first.
  const rest = input.files
    .filter((f) => !included.has(f.path) && f.patch)
    .sort(
      (a, b) =>
        closeness(b.path, anchors) - closeness(a.path, anchors) ||
        (a.patch?.length ?? 0) - (b.patch?.length ?? 0) ||
        a.path.localeCompare(b.path)
    );
  for (const file of rest) diffItem(file, 'diff', 'another change in this PR');

  // 6. The anchor's head source: the definitions its changes touch, then the whole file.
  for (const path of anchors) {
    const source = input.sources?.[path];
    if (!source) continue;
    const lines = source.split('\n');
    const changed = changedLines(parseHunks(files.get(path)?.patch));
    const touched = (input.definitions?.[path] ?? []).filter((d) =>
      changed.some((line) => line >= d.start && line <= d.end)
    );
    const numbered = (from: number, to: number) =>
      lines
        .slice(from - 1, to)
        .map((line, i) => `${from + i}: ${line}`)
        .join('\n');
    const whole = `<source path="${path}" revision="head" included="the whole file around the change">\n${numbered(1, lines.length)}\n</source>`;
    if (fits(whole)) {
      add({ kind: 'source', path, reason: 'the whole file around the change' }, whole);
      continue;
    }
    for (const definition of touched) {
      const reason = `the source of \`${definition.label ?? definition.name}\`, which the change touches`;
      const text = `<source path="${path}" revision="head" lines="${definition.start}-${definition.end}" included="${reason}">\n${numbered(definition.start, definition.end)}\n</source>`;
      if (fits(text)) add({ kind: 'source', path, reason }, text);
    }
  }

  const leftOut = input.files.map((f) => f.path).filter((p) => !included.has(p));
  if (leftOut.length)
    parts.push(
      `<not_included reason="context budget">\nThese changed files are in the PR but not shown here. Say so rather than guess about them:\n${leftOut.map((p) => `- ${p}`).join('\n')}\n</not_included>`
    );
  return { text: parts.join('\n\n'), items, leftOut, tokens: used, budget };
}

/** One short line for the trace: `imports scope.ts · 1.2k tokens`. */
export function chatContextItemDetail(item: ChatContextItem): string {
  const size = item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}k tokens` : `${item.tokens} tokens`;
  const partial = item.partial ? ` · ${item.partial.hunks} of ${item.partial.of} hunks` : '';
  return `${item.reason}${partial} · ${size}`;
}
