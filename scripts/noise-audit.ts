/* eslint-disable @typescript-eslint/no-unnecessary-condition -- indexes into token lists can miss; the types do not say so. */
/**
 * Audits the quiet-change classifier (#396, lib/semantic-noise.ts) on real code. Not part of CI: it reads source trees
 * and git history on disk and runs formatters that may not be installed.
 *
 *   npx tsx scripts/noise-audit.ts roundtrip <dir>...   formatter and synthetic reformatting: every pair must be quiet
 *   npx tsx scripts/noise-audit.ts mutate <dir>...      single meaningful mutations: every one must be code
 *   npx tsx scripts/noise-audit.ts history <repo>...    each commit's changed files, by commit kind
 *
 * Options: `--files N` files per language (default 40), `--mutations N` per file (default 50), `--seed N`,
 * `--show N` examples of each failure to print.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { structuredPatch } from 'diff';
import type * as TreeSitter from 'web-tree-sitter';
import { syntaxLanguage, type SyntaxLanguage } from '../lib/syntax-scope';
import { kinds, parse } from './noise-audit-core';

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const FILES = option('files', 40);
const PER_FILE = option('mutations', 50);
const SHOW = option('show', 3);
let seed = option('seed', 396);
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];

// ── Files ───────────────────────────────────────────────────────────────────

const SKIP = /node_modules|\/\.git\/|\/dist\/|\/build\/|\/target\/|\.min\.|\/vendor\//;
function sourceFiles(dirs: string[]): Map<SyntaxLanguage, string[]> {
  const byLanguage = new Map<SyntaxLanguage, string[]>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (SKIP.test(full + '/')) continue;
      if (entry.isDirectory()) walk(full);
      else {
        const language = syntaxLanguage(full);
        if (!language) continue;
        const size = fs.statSync(full).size;
        if (size < 200 || size > 60_000) continue;
        byLanguage.set(language, [...(byLanguage.get(language) ?? []), full]);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  // A stable sample per language: files sorted, then picked by the seeded random order.
  for (const [language, files] of byLanguage) {
    const sorted = [...files].sort();
    const sample: string[] = [];
    while (sorted.length && sample.length < FILES) sample.push(sorted.splice(Math.floor(random() * sorted.length), 1)[0]);
    byLanguage.set(language, sample);
  }
  return byLanguage;
}
/** Files that parse without an error: the classifier treats any error as code, so they say nothing. */
async function clean(language: SyntaxLanguage, text: string) {
  const tree = await parse(language, text);
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

// ── Leaves ──────────────────────────────────────────────────────────────────

interface Leaf {
  type: string;
  start: number;
  end: number;
  row: number;
  endRow: number;
  named: boolean;
  parent: string;
  /** Inside a string, comment, template or other node compared whole. */
  atom: boolean;
  comment: boolean;
  /** A Python docstring's text: the classifier reads it as a comment. */
  docstring: boolean;
}
const ATOM = /string|template|char|rune|regex|text_block|scalar|heredoc|jsx_text|comment/;
async function leaves(language: SyntaxLanguage, text: string): Promise<{ leaves: Leaf[]; atomRows: Set<number> }> {
  const tree = await parse(language, text);
  const result: Leaf[] = [];
  const atomRows = new Set<number>();
  const visit = (node: TreeSitter.Node, inAtom: boolean, inComment: boolean, inDoc = false) => {
    const doc =
      inDoc ||
      (language === 'python' && node.type === 'string' && node.parent?.type === 'expression_statement' && node.parent.namedChildCount === 1 && !node.parent.previousNamedSibling);
    const atom = inAtom || ATOM.test(node.type);
    const comment = inComment || /comment/.test(node.type);
    if (atom && !inAtom && node.endPosition.row > node.startPosition.row)
      for (let r = node.startPosition.row + 1; r <= node.endPosition.row; r++) atomRows.add(r);
    if (!node.childCount) {
      result.push({
        type: node.type,
        start: node.startIndex,
        end: node.endIndex,
        row: node.startPosition.row,
        endRow: node.endPosition.row,
        named: node.isNamed,
        parent: node.parent?.type ?? '',
        atom,
        comment,
        docstring: doc,
      });
      return;
    }
    for (const child of node.children) if (child) visit(child, atom, comment, doc);
  };
  visit(tree.rootNode, false, false);
  tree.delete();
  return { leaves: result, atomRows };
}

// ── Reformatting ────────────────────────────────────────────────────────────

const WHITESPACE_SENSITIVE = new Set<SyntaxLanguage>(['python', 'yaml']);
type Transform = (language: SyntaxLanguage, text: string) => Promise<string | undefined>;
/** Synthetic reformattings that keep a program's meaning in every language they run on. */
const TRANSFORMS: Record<string, Transform> = {
  // Every line's indentation doubled, except lines inside strings and comments.
  async reindent(language, text) {
    if (WHITESPACE_SENSITIVE.has(language)) return undefined;
    const { atomRows } = await leaves(language, text);
    return text
      .split('\n')
      .map((line, row) => (atomRows.has(row) ? line : line.replace(/^[ \t]+/, (indent) => indent + indent)))
      .join('\n');
  },
  // Python and YAML: every line's indentation doubled together, which keeps every block.
  async scaleIndent(language, text) {
    if (!WHITESPACE_SENSITIVE.has(language)) return undefined;
    const { atomRows } = await leaves(language, text);
    if (atomRows.size) return undefined;
    if (/\t/.test(text)) return undefined;
    return text.split('\n').map((line) => line.replace(/^ +/, (indent) => indent + indent)).join('\n');
  },
  // A space more where two tokens on one line already have one between them.
  async spacing(language, text) {
    const { leaves: list } = await leaves(language, text);
    const spots: number[] = [];
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (a.atom || b.atom || a.endRow !== b.row || b.start - a.end !== 1 || text[a.end] !== ' ') continue;
      if (language === 'yaml' && (a.type === ':' || b.type === ':' || a.type === '-' || b.type === '#')) continue;
      spots.push(a.end);
    }
    if (!spots.length) return undefined;
    const chosen = new Set(Array.from({ length: Math.min(8, spots.length) }, () => pick(spots)));
    let out = '';
    let at = 0;
    for (const spot of [...chosen].sort((x, y) => x - y)) {
      out += text.slice(at, spot) + ' ';
      at = spot;
    }
    return out + text.slice(at);
  },
  // Blank lines added between lines, outside strings.
  async blankLines(language, text) {
    const { atomRows } = await leaves(language, text);
    const lines = text.split('\n');
    const rows = lines.map((_, r) => r).filter((r) => r > 0 && !atomRows.has(r) && lines[r].trim() && lines[r - 1].trim());
    if (!rows.length) return undefined;
    const chosen = new Set(Array.from({ length: Math.min(5, rows.length) }, () => pick(rows)));
    return lines.flatMap((line, r) => (chosen.has(r) ? ['', line] : [line])).join('\n');
  },
  // Blank lines removed, outside strings.
  async noBlankLines(language, text) {
    const { atomRows } = await leaves(language, text);
    const lines = text.split('\n');
    // Python's top-level definitions keep their blank lines only for style; YAML's documents do not care.
    const kept = lines.filter((line, r) => line.trim() || atomRows.has(r) || r === lines.length - 1);
    return kept.length === lines.length ? undefined : kept.join('\n');
  },
  // A line break after a comma inside parentheses or brackets.
  async wrap(language, text) {
    if (language === 'yaml' || language === 'json') return undefined;
    const { leaves: list } = await leaves(language, text);
    const spots = list
      .filter((l) => l.type === ',' && !l.atom && /^(arguments|argument_list|formal_parameters|parameters|parameter_list|array|list|array_expression|array_initializer)$/.test(l.parent))
      .map((l) => l.end);
    if (!spots.length) return undefined;
    const chosen = new Set(Array.from({ length: Math.min(4, spots.length) }, () => pick(spots)));
    let out = '';
    let at = 0;
    for (const spot of [...chosen].sort((x, y) => x - y)) {
      out += text.slice(at, spot) + '\n        ';
      at = spot;
      while (text[at] === ' ') at++;
    }
    return out + text.slice(at);
  },
  // Trailing spaces on lines outside strings.
  async trailingSpaces(language, text) {
    const { atomRows } = await leaves(language, text);
    const lines = text.split('\n');
    return lines.map((line, r) => (atomRows.has(r + 1) || atomRows.has(r) || !line.trim() || r % 3 ? line : `${line}  `)).join('\n');
  },
  // CRLF line endings.
  crlf(_language, text) {
    return Promise.resolve(text.replace(/\r?\n/g, '\r\n'));
  },
};

function format(language: SyntaxLanguage, file: string, text: string): { tool: string; text: string } | undefined {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-fmt-'));
  const target = path.join(tmp, path.basename(file));
  fs.writeFileSync(target, text);
  try {
    if (['typescript', 'tsx', 'javascript', 'json', 'yaml'].includes(language)) {
      const out = execFileSync(path.resolve(__dirname, '../node_modules/.bin/prettier'), ['--no-config', '--print-width', '60', target], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { tool: 'prettier', text: out };
    }
    if (language === 'go') {
      return { tool: 'gofmt', text: execFileSync('gofmt', [target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
    }
    if (language === 'rust') {
      execFileSync(path.join(os.homedir(), '.cargo/bin/rustfmt'), ['--edition', '2021', '--config', 'max_width=60', target], { stdio: 'ignore' });
      return { tool: 'rustfmt', text: fs.readFileSync(target, 'utf8') };
    }
  } catch {
    return undefined;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return undefined;
}

async function roundtrip(dirs: string[]) {
  const files = sourceFiles(dirs);
  const table: Record<string, { pairs: number; quiet: number; code: number; reasons: Record<string, number> }> = {};
  const examples: Record<string, string[]> = {};
  const blockTable: Record<string, { blocks: number; whitespace: number; formatting: number; comments: number; code: number; imports: number }> = {};
  const record = (key: string, ok: boolean, reason: string, example: string) => {
    const row = (table[key] ??= { pairs: 0, quiet: 0, code: 0, reasons: {} });
    row.pairs++;
    if (ok) row.quiet++;
    else {
      row.code++;
      row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
      const list = (examples[key] ??= []);
      if (list.length < SHOW) list.push(example);
    }
  };
  for (const [language, list] of files) {
    for (const file of list) {
      const before = fs.readFileSync(file, 'utf8');
      if (!(await clean(language, before))) continue;
      const pairs: [string, string | undefined][] = [];
      const formatted = format(language, file, before);
      if (formatted) pairs.push([formatted.tool, formatted.text]);
      for (const [name, transform] of Object.entries(TRANSFORMS)) pairs.push([name, await transform(language, before)]);
      // The formatter undoing each synthetic change: the before side is the reformatted file.
      const undo: [string, string, string][] = [];
      for (const [name, ugly] of pairs) {
        if (!ugly || name === formatted?.tool || name === 'crlf') continue;
        const back = format(language, file, ugly);
        if (back && back.text !== ugly) undo.push([`${back.tool}(${name})`, ugly, back.text]);
      }
      const all: [string, string, string | undefined][] = [...pairs.map(([n, a]): [string, string, string | undefined] => [n, before, a]), ...undo];
      for (const [name, base, after] of all) {
        const before = base;
        if (after === undefined || after === before) continue;
        if (!(await clean(language, before))) continue;
        // A formatter that broke the parse (or a grammar that does not know its output) says nothing.
        if (!(await clean(language, after))) continue;
        const { blocks } = await kinds(language, before, after);
        const code = blocks.filter((b) => b.kind === 'code');
        record(`${language} ${name}`, !code.length, code[0]?.reason ?? '', `${file} ${JSON.stringify(code.slice(0, 2))}`);
        // Blocks, by kind. A code block whose lines include an import moved by the formatter (rustfmt and gofmt sort
        // them) is counted apart: import order is code by design.
        const group = `${language} ${/^(prettier|gofmt|rustfmt)/.test(name) ? 'formatter' : 'synthetic'}`;
        const row = (blockTable[group] ??= { blocks: 0, whitespace: 0, formatting: 0, comments: 0, code: 0, imports: 0 });
        const oldLines = before.split('\n'),
          newLines = after.split('\n');
        for (const block of blocks) {
          row.blocks++;
          if (block.kind !== 'code') {
            row[block.kind === 'whitespace' || block.kind === 'formatting' ? block.kind : 'comments']++;
            continue;
          }
          const text = [...oldLines.slice(block.oldStart - 1, block.oldStart - 1 + block.oldCount), ...newLines.slice(block.newStart - 1, block.newStart - 1 + block.newCount)];
          if (text.some((line) => /^\s*(pub(\(crate\))? )?(use|import) |^\s*"[\w./-]+"$/.test(line))) row.imports++;
          else row.code++;
        }
      }
    }
  }
  console.log('ROUNDTRIP', JSON.stringify(table, null, 1));
  console.log('BLOCKS', JSON.stringify(blockTable, null, 1));
  console.log('EXAMPLES', JSON.stringify(examples, null, 1));
}

/** Whether two texts give the same tree of named nodes, with the same tokens: a whitespace change by the parser. */
async function sameTree(language: SyntaxLanguage, before: string, after: string) {
  const [a, b] = [await parse(language, before), await parse(language, after)];
  try {
    const tokens = (text: string) => text.replace(/\s+/g, '');
    return a.rootNode.toString() === b.rootNode.toString() && tokens(before) === tokens(after);
  } finally {
    a.delete();
    b.delete();
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

const OPERATORS: Record<string, string> = { '+': '-', '-': '+', '*': '/', '<': '>', '>': '<', '==': '!=', '!=': '==', '&&': '||', '||': '&&', '<=': '>=', '>=': '<=', and: 'or', or: 'and', '+=': '-=', '-=': '+=' };
type Mutation = (language: SyntaxLanguage, text: string, list: Leaf[]) => string | undefined;
const replace = (text: string, leaf: Leaf, value: string) => text.slice(0, leaf.start) + value + text.slice(leaf.end);
const codeLeaves = (list: Leaf[]) => list.filter((l) => !l.atom && !l.comment && l.end > l.start);
const MUTATIONS: Record<string, Mutation> = {
  operator(_l, text, list) {
    const ops = codeLeaves(list).filter((l) => OPERATORS[l.type] && text.slice(l.start, l.end) === l.type);
    if (!ops.length) return;
    const leaf = pick(ops);
    return replace(text, leaf, OPERATORS[leaf.type]);
  },
  identifier(_l, text, list) {
    const ids = codeLeaves(list).filter((l) => /identifier|^name$|field_identifier|type_identifier/.test(l.type));
    if (!ids.length) return;
    const leaf = pick(ids);
    return replace(text, leaf, text.slice(leaf.start, leaf.end) + 'X');
  },
  literal(_l, text, list) {
    const numbers = list.filter((l) => !l.comment && /number|integer|int_literal|float|decimal|numeric|integer_scalar|float_scalar/.test(l.type));
    if (!numbers.length) return;
    const leaf = pick(numbers);
    const value = text.slice(leaf.start, leaf.end);
    return replace(text, leaf, /^\d+$/.test(value) ? String(Number(value) + 1) : `1${value}`);
  },
  string(language, text, list) {
    // Inside the string, never at its edge: a YAML plain scalar's edges are whitespace. Python docstrings are comments.
    const strings = list.filter((l) => /string_content|string_fragment|string_scalar|escape/.test(l.type) && !l.comment && l.end - l.start >= 2 && !l.docstring);
    if (!strings.length) return;
    const leaf = pick(strings);
    // A space inside a string is still a change of its contents, except inside a plain YAML scalar, which folds them.
    const at = leaf.start + 1 + Math.floor(random() * (leaf.end - leaf.start - 1));
    return text.slice(0, at) + (random() < 0.5 && language !== 'yaml' ? ' ' : 'q') + text.slice(at);
  },
  deleteToken(_l, text, list) {
    const tokens = codeLeaves(list).filter((l) => ![';', ',', '\n'].includes(l.type) && !/^\s*$/.test(text.slice(l.start, l.end)));
    if (!tokens.length) return;
    const leaf = pick(tokens);
    return replace(text, leaf, '');
  },
  swapLines(language, text, list) {
    const lines = text.split('\n');
    const atomRows = new Set(list.filter((l) => l.atom || l.comment).flatMap((l) => Array.from({ length: l.endRow - l.row + 1 }, (_, i) => l.row + i)));
    const rows = lines
      .map((_, r) => r)
      .filter((r) => r + 1 < lines.length && !atomRows.has(r) && !atomRows.has(r + 1) && lines[r].trim() && lines[r + 1].trim() && lines[r].trim() !== lines[r + 1].trim())
      // Same indentation, so a whitespace-sensitive language keeps its blocks: only the order changes.
      .filter((r) => /^\s*/.exec(lines[r])?.[0] === /^\s*/.exec(lines[r + 1])?.[0]);
    if (!rows.length) return;
    const r = pick(rows);
    [lines[r], lines[r + 1]] = [lines[r + 1], lines[r]];
    return lines.join('\n');
  },
  // Python and YAML: one line's indentation changed, so it moves in or out of a block.
  indent(language, text, list) {
    if (!WHITESPACE_SENSITIVE.has(language)) return;
    const lines = text.split('\n');
    const atomRows = new Set(list.filter((l) => l.atom || l.comment).flatMap((l) => Array.from({ length: l.endRow - l.row + 1 }, (_, i) => l.row + i)));
    const rows = lines.map((_, r) => r).filter((r) => lines[r].trim() && !atomRows.has(r) && !lines[r].trim().startsWith('#'));
    if (!rows.length) return;
    const r = pick(rows);
    lines[r] = random() < 0.5 ? `    ${lines[r]}` : lines[r].replace(/^ {1,4}/, '');
    return lines.join('\n');
  },
  // Parentheses that regroup a binary expression: `a * b + c` becomes `a * (b + c)`.
  regroup(_l, text, list) {
    const ops = codeLeaves(list).filter((l) => /binary|boolean_operator|comparison_operator/.test(l.parent) && OPERATORS[l.type]);
    for (let tries = 0; tries < 10 && ops.length; tries++) {
      const op = pick(ops);
      const i = list.indexOf(op);
      // The operand before the operator, and everything to the end of the line after it.
      const left = list[i - 1];
      if (!left || left.atom || left.row !== op.row) continue;
      // Only inside a chain, `a + b * c` → `a + (b * c)`, so the parentheses always regroup: an operator before.
      const before = list[i - 2];
      if (!before || !OPERATORS[before.type] || before.row !== op.row) continue;
      const lineEnd = text.indexOf('\n', op.end);
      const stop = /[;,)\]}]/.exec(text.slice(op.end, lineEnd < 0 ? undefined : lineEnd));
      if (!stop || stop.index < 2) continue;
      return `${text.slice(0, left.start)}(${text.slice(left.start, op.end + stop.index)})${text.slice(op.end + stop.index)}`;
    }
    return undefined;
  },
  // Two neighbouring imports swapped: a module can run code when it is imported, so order is code.
  importSwap(language, text) {
    const pattern =
      language === 'go'
        ? /^\t"[^"]+"$/
        : language === 'rust'
          ? /^use /
          : language === 'python'
            ? /^(import|from) /
            : language === 'csharp'
              ? /^using /
              : /^import /;
    const lines = text.split('\n');
    const rows = lines.map((_, r) => r).filter((r) => r + 1 < lines.length && pattern.test(lines[r]) && pattern.test(lines[r + 1]) && lines[r] !== lines[r + 1]);
    if (!rows.length) return undefined;
    const r = pick(rows);
    [lines[r], lines[r + 1]] = [lines[r + 1], lines[r]];
    return lines.join('\n');
  },
  // ASI traps: a `;` taken off a statement whose next line starts with `(`, `[`, a template, `+` or a regex.
  asi(language, text, list) {
    if (language !== 'typescript' && language !== 'javascript' && language !== 'tsx') return undefined;
    // An expression statement: its last token can always continue into the trap line.
    const semis = list.filter((l) => l.type === ';' && !l.atom && l.parent === 'expression_statement' && text[l.end] === '\n');
    if (!semis.length) return undefined;
    const semi = pick(semis);
    const indent = /^[ \t]*/.exec(text.slice(semi.end + 1))?.[0] ?? '';
    const trap = pick(['(globalThis).x;', '[0].forEach(String);', '`t`;', '+1;', '/re/g.test("");']);
    // Both sides get the new line; only the `;` before it differs.
    const withLine = `${text.slice(0, semi.end)}\n${indent}${trap}${text.slice(semi.end)}`;
    return `${withLine}\u0000PAIR\u0000${withLine.slice(0, semi.start)}${withLine.slice(semi.end)}`;
  },
  // A code line turned into a comment, and back.
  uncomment(language, text, list) {
    const marker = language === 'python' || language === 'yaml' ? '# ' : '// ';
    if (language === 'json') return;
    const lines = text.split('\n');
    const atomRows = new Set(list.filter((l) => l.atom || l.comment).flatMap((l) => Array.from({ length: l.endRow - l.row + 1 }, (_, i) => l.row + i)));
    const rows = lines.map((_, r) => r).filter((r) => lines[r].trim().length > 3 && !atomRows.has(r));
    if (!rows.length) return;
    const r = pick(rows);
    lines[r] = lines[r].replace(/^(\s*)/, `$1${marker}`);
    return lines.join('\n');
  },
};

async function mutate(dirs: string[]) {
  const files = sourceFiles(dirs);
  const table: Record<string, Record<string, { tried: number; parsed: number; code: number; quiet: number }>> = {};
  const failures: string[] = [];
  for (const [language, list] of files) {
    for (const file of list) {
      const original = fs.readFileSync(file, 'utf8');
      if (!(await clean(language, original))) continue;
      const { leaves: tokens } = await leaves(language, original);
      for (let n = 0; n < PER_FILE; n++) {
        const name = pick(Object.keys(MUTATIONS));
        const mutated = MUTATIONS[name](language, original, tokens);
        if (mutated === undefined || mutated === original) continue;
        // Uncommenting is the mutation of interest: the commented line is the before side. A pair mutation (ASI)
        // makes both sides.
        const pair = mutated.split('\u0000PAIR\u0000');
        const [before, after] = pair.length === 2 ? pair : name === 'uncomment' ? [mutated, original] : [original, mutated];
        if (pair.length === 2 && !(await clean(language, before))) continue;
        const row = ((table[language] ??= {})[name] ??= { tried: 0, parsed: 0, code: 0, quiet: 0 });
        row.tried++;
        if (await clean(language, after)) row.parsed++;
        const { blocks } = await kinds(language, before, after);
        // Re-indenting Python or YAML changes the program only when the parser's tree changes: a block's first line
        // sets its indentation, and lines inside brackets have none that counts. The tree is the oracle there.
        if (name === 'indent' && (await sameTree(language, before, after))) {
          row.tried--;
          const quiet = blocks.every((b) => b.kind !== 'code');
          const kept = ((table[language] ??= {})['indent (same tree)'] ??= { tried: 0, parsed: 0, code: 0, quiet: 0 });
          kept.tried++;
          kept.parsed++;
          if (quiet) kept.quiet++;
          else kept.code++;
          continue;
        }
        if (blocks.length && blocks.every((b) => b.kind === 'code')) row.code++;
        else {
          row.quiet++;
          if (failures.length < 60) {
            const patch = structuredPatch('a', 'b', before, after, '', '', { context: 1 }).hunks.map((h) => h.lines.join('\n')).join('\n...\n');
            failures.push(`${language} ${name} ${file} ${JSON.stringify(blocks.map((b) => b.kind))}\n${patch.slice(0, 600)}`);
          }
        }
      }
    }
  }
  console.log('MUTATIONS', JSON.stringify(table, null, 1));
  console.log('FALSE QUIET', failures.length ? failures.join('\n\n') : 'none');
}

// ── History ─────────────────────────────────────────────────────────────────

const git = (repo: string, ...rest: string[]) => execFileSync('git', ['-C', repo, ...rest], { encoding: 'utf8', maxBuffer: 1 << 28 });
const STYLE = /\b(format|formatting|lint|style|whitespace|prettier|rustfmt|gofmt|black|fmt|indent|csharpier|reformat)\b/i;
async function history(repos: string[]) {
  const totals: Record<string, Record<string, number>> = {};
  const samples: string[] = [];
  for (const repo of repos) {
    const log = git(repo, 'log', '--no-merges', '--format=%H%x00%s', '-n', '300').trim().split('\n');
    for (const entry of log) {
      const [sha, subject] = entry.split('\0');
      let parent: string;
      try {
        parent = git(repo, 'rev-parse', `${sha}^`).trim();
      } catch {
        continue;
      }
      const kind = STYLE.test(subject) ? 'style' : 'other';
      const key = `${path.basename(repo)} ${kind}`;
      const row = (totals[key] ??= { commits: 0, blocks: 0 });
      row.commits++;
      const changed = git(repo, 'diff', '--name-status', '--no-renames', parent, sha).trim().split('\n');
      for (const line of changed.slice(0, 40)) {
        const [status, file] = line.split('\t');
        if (status !== 'M' || !file) continue;
        const language = syntaxLanguage(file);
        if (!language) continue;
        let before: string, after: string;
        try {
          before = git(repo, 'show', `${parent}:${file}`);
          after = git(repo, 'show', `${sha}:${file}`);
        } catch {
          continue;
        }
        if (before.length > 400_000 || after.length > 400_000) continue;
        const { blocks } = await kinds(language, before, after);
        for (const block of blocks) {
          row.blocks++;
          row[block.kind] = (row[block.kind] ?? 0) + 1;
          if (kind === 'other' && block.kind !== 'code' && samples.length < 400) {
            const b = block as unknown as { oldStart: number; oldCount: number; newStart: number; newCount: number };
            const old = before.split('\n').slice(b.oldStart - 1, b.oldStart - 1 + b.oldCount).map((l) => `-${l}`);
            const neu = after.split('\n').slice(b.newStart - 1, b.newStart - 1 + b.newCount).map((l) => `+${l}`);
            samples.push(`${path.basename(repo)} ${sha.slice(0, 8)} ${file} ${block.kind}\n${[...old, ...neu].join('\n').slice(0, 500)}`);
          }
        }
      }
    }
  }
  console.log('HISTORY', JSON.stringify(totals, null, 1));
  const out = path.join(os.tmpdir(), 'noise-history-samples.txt');
  fs.writeFileSync(out, samples.join('\n\n'));
  console.log(`Quiet blocks in ordinary commits: ${samples.length}, written to ${out}`);
}

const [mode, ...rest] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const run = { roundtrip, mutate, history }[mode as 'roundtrip' | 'mutate' | 'history'];
if (!run) {
  console.error('Usage: npx tsx scripts/noise-audit.ts roundtrip|mutate|history <dir>...');
  process.exit(2);
}
void run(rest);
