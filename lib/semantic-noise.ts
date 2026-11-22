import { diffArrays } from 'diff';
import type * as TreeSitter from 'web-tree-sitter';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * Quiet changes (#396): whitespace-only, formatting-only and comment-only changes, from the two sides' syntax trees.
 *
 * A diff's unit here is a change block: a run of added and deleted lines with no unchanged line between them. A
 * GitHub hunk holds one or more; a view that joins hunks (a revealed gap) still shows the same blocks. Each block is
 * - `whitespace` when both sides have the same tokens as written, in the same tree: only indentation, line breaks,
 *   spaces and blank lines differ;
 * - `formatting` when the tokens differ only by the equivalences below, which a formatter writes;
 * - `comments` when the code is the same as written and only comments differ (doc comments too), at the same layout;
 * - `whitespace-comments` and `formatting-comments` when comments differ along with whitespace or formatting;
 * - `code` otherwise, and whenever the comparison is in doubt.
 * - `imports` only when the caller asks for it, in place of `code`: a block of a hunk that only widens imports the
 *   file already has, by Reduce noise's rule (importOnlyHunk, lib/explanation-noise.ts).
 *
 * The comparison is structural: each tree is read as a sequence of events (a node opens, a token, the node closes),
 * with comments left out, once with the equivalences and once as written. Comparing structure as well as tokens is
 * what keeps whitespace-sensitive languages safe: a Python line that changes indentation changes which `block` holds
 * it, a YAML key that changes indentation changes which mapping holds it, and a JavaScript line break after `return`
 * changes the statements. Those trees differ, so the block is code. When the two whole files read the same, every
 * block is quiet, however the line diff paired their lines.
 *
 * Safeguards, so that a quiet label is never wrong:
 * - Either side with a parse error (an ERROR or MISSING node anywhere) makes every block code.
 * - Strings, template strings, regexes, characters and YAML scalars are compared whole, as written: a change of
 *   whitespace inside one is a change of the program. Text inside a node that no child covers is compared too.
 * - A string or other token across a block's edge makes every block it reaches code once the string changed.
 * - The unchanged lines between blocks must give the same events on both sides. Where they do not (a change made a
 *   comment swallow code, or regrouped the code around it), the blocks whose nodes reach the difference are code, and
 *   if no block reaches it, every block is.
 * - Comments that tools read are code: `//go:build`, `// +build`, `@ts-ignore`, `/// <reference …>`, `# type:`,
 *   `eslint-disable`, `prettier-ignore`, and the like.
 * - Import order is never formatting: a module can run code when it is imported.
 *
 * Equivalences (formatting), each exact in its grammar; FLATTEN and `optional` hold the structural ones:
 * - A trailing comma before `)`, `]`, `}` or `>` in argument, parameter, array, object, import, type and pattern lists,
 *   per language, and in tuples of two or more. Never in a one-element tuple, a Python subscript, or a macro.
 * - Single or double quotes around a simple string in JavaScript, TypeScript and Python (no escapes, no quotes inside,
 *   no prefix), and around a simple quoted YAML scalar. JSX text as React reads it.
 * - Number spelling: digit separators, letter case, and in JavaScript the value (`1.50` is `1.5`).
 * - JavaScript and TypeScript: optional `;`, parentheses where they group nothing, one arrow parameter's parentheses,
 *   a union's leading `|`, braces around one statement. Python: parentheses around a whole value. Rust: a match arm's or
 *   closure's `{ expr }`, a match arm's `,`. Java and C#: braces around one statement.
 * - A Python docstring (a string alone as the first statement of a module, class or function) is a doc comment.
 *
 * scripts/noise-audit.ts checks these on real code: formatter output must be quiet, and mutations must be code.
 */
export type NoiseKind = 'whitespace' | 'formatting' | 'comments' | 'whitespace-comments' | 'formatting-comments' | 'imports' | 'code';

/** A run of changed lines. Starts are 1-based line numbers; a side with no lines names the line its change sits before. */
export interface ChangeBlock {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}
export interface NoiseBlock extends ChangeBlock {
  kind: NoiseKind;
  /** Why a block is code, for tests and diagnostics: `tokens`, `context`, `edge`, `parse-error`, `mismatch`. */
  reason?: string;
}

interface Row {
  type: ' ' | '+' | '-';
  text: string;
}
interface HunkLike {
  oldStart: number;
  newStart: number;
  rows: readonly Row[];
}

/** The change blocks of a diff's hunks, in order. */
export function changeBlocks(hunks: readonly HunkLike[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    let open: ChangeBlock | undefined;
    for (const row of hunk.rows) {
      if (row.type === ' ') {
        open = undefined;
        oldLine++;
        newLine++;
        continue;
      }
      if (!open) {
        open = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0 };
        blocks.push(open);
      }
      if (row.type === '-') {
        open.oldCount++;
        oldLine++;
      } else {
        open.newCount++;
        newLine++;
      }
    }
  }
  return blocks;
}

/** A GitHub patch as hunks of rows, for a file whose diff is not on screen (prefetch). Undefined for no patch. */
export function patchHunks(patch: string | undefined): { oldStart: number; newStart: number; rows: Row[] }[] | undefined {
  if (!patch) return undefined;
  const hunks: { oldStart: number; newStart: number; rows: Row[] }[] = [];
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      // A side with no lines names the line before the change, as in `@@ -5,0 +6,2 @@`.
      const oldStart = Number(header[1]) + (header[2] === '0' ? 1 : 0);
      const newStart = Number(header[3]) + (header[4] === '0' ? 1 : 0);
      hunks.push({ oldStart, newStart, rows: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) continue;
    const sign = line[0];
    if (sign === ' ' || sign === '+' || sign === '-') hunk.rows.push({ type: sign, text: line.slice(1) });
  }
  return hunks.length ? hunks : undefined;
}

/** A block's identity in a view, by where it starts on both sides. */
export const blockKey = (block: Pick<ChangeBlock, 'oldStart' | 'newStart'>) => `${block.oldStart},${block.newStart}`;

/** Every block's identity, for a cache key: blocks are the same whatever context the view shows around them. */
export const blocksSignature = (blocks: readonly ChangeBlock[]) =>
  blocks.map((b) => `${b.oldStart},${b.oldCount},${b.newStart},${b.newCount}`).join(';');

const BOM = '﻿';
const clean = (line: string, first: boolean) => {
  let text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (first && text.startsWith(BOM)) text = text.slice(1);
  return text;
};

/** Where each block sits in the two texts the comparison parses, by 0-based row. */
export interface SideBlock {
  oldRow: number;
  oldCount: number;
  newRow: number;
  newCount: number;
}

/**
 * The two texts to compare, from the new side and the hunks: the old text is the new one with each hunk's change
 * undone, so the lines between hunks are the same on both sides by construction. Hunks that are some of a file's (an
 * Explanation topic's) undo only their own changes, so each block is compared with everything else as it is now.
 * Line endings and a byte order mark are left out on both sides: they are whitespace. Undefined when the hunks do not
 * match the text.
 */
export function comparisonTexts(
  after: string,
  hunks: readonly HunkLike[]
): { before: string; after: string; blocks: SideBlock[] } | undefined {
  const lines = after.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const newLines = lines.map((line, index) => clean(line, index === 0));
  const oldLines: string[] = [];
  const blocks: SideBlock[] = [];
  let next = 1; // The next new line to copy.
  for (const hunk of hunks) {
    if (hunk.newStart < next) return undefined;
    for (; next < hunk.newStart; next++) {
      if (next > newLines.length) return undefined;
      oldLines.push(newLines[next - 1]);
    }
    let open: SideBlock | undefined;
    for (const row of hunk.rows) {
      const text = clean(row.text, next === 1 && row.type !== '-');
      if (row.type === ' ') {
        open = undefined;
        if (newLines[next - 1] !== text) return undefined;
        oldLines.push(text);
        next++;
        continue;
      }
      if (!open) {
        open = { oldRow: oldLines.length, oldCount: 0, newRow: next - 1, newCount: 0 };
        blocks.push(open);
      }
      if (row.type === '-') {
        oldLines.push(clean(row.text, oldLines.length === 0));
        open.oldCount++;
      } else {
        if (newLines[next - 1] !== text) return undefined;
        open.newCount++;
        next++;
      }
    }
  }
  for (; next <= newLines.length; next++) oldLines.push(newLines[next - 1]);
  return { before: oldLines.length ? `${oldLines.join('\n')}\n` : '', after: newLines.length ? `${newLines.join('\n')}\n` : '', blocks };
}

// ── Per-language rules ──────────────────────────────────────────────────────

export const COMMENTS: ReadonlySet<string> = new Set(['comment', 'line_comment', 'block_comment', 'html_comment', 'doc_comment', 'multiline_comment']);
/** Extras that only join lines. Python's `\` continuation changes nothing once the tree is the same. */
const LAYOUT_EXTRAS = new Set(['line_continuation']);

const STRINGS = [
  'string',
  'template_string',
  'string_literal',
  'raw_string_literal',
  'char_literal',
  'character_literal',
  'rune_literal',
  'interpreted_string_literal',
  'verbatim_string_literal',
  'interpolated_string_expression',
  'interpolated_verbatim_string_expression',
  'text_block',
  'regex',
  'jsx_text',
  'heredoc_body',
];
/** Nodes compared whole, as written. */
const ATOMS: Record<SyntaxLanguage, Set<string>> = {
  typescript: new Set(STRINGS),
  tsx: new Set(STRINGS),
  javascript: new Set(STRINGS),
  rust: new Set(STRINGS),
  go: new Set(STRINGS),
  python: new Set([...STRINGS, 'concatenated_string']),
  java: new Set(STRINGS),
  csharp: new Set(STRINGS),
  json: new Set(['string']),
  yaml: new Set(['double_quote_scalar', 'single_quote_scalar', 'block_scalar', 'plain_scalar', 'alias', 'anchor', 'tag']),
};

const SCRIPT_LISTS = [
  'arguments',
  'formal_parameters',
  'array',
  'object',
  'object_pattern',
  'array_pattern',
  'named_imports',
  'export_clause',
  'enum_body',
  'type_arguments',
  'type_parameters',
  'object_type',
  'tuple_type',
];
/** Parents in which a comma right before the closing bracket is optional and means nothing. */
const TRAILING_COMMA: Record<SyntaxLanguage, Set<string>> = {
  typescript: new Set(SCRIPT_LISTS),
  tsx: new Set(SCRIPT_LISTS),
  javascript: new Set(SCRIPT_LISTS),
  rust: new Set([
    'arguments',
    'parameters',
    'array_expression',
    'field_initializer_list',
    'field_declaration_list',
    'enum_variant_list',
    'use_list',
    'type_arguments',
    'type_parameters',
    'struct_pattern',
    'tuple_struct_pattern',
    'slice_pattern',
    'ordered_field_declaration_list',
  ]),
  go: new Set(['argument_list', 'parameter_list', 'literal_value', 'type_arguments', 'type_parameter_list']),
  python: new Set(['argument_list', 'parameters', 'list', 'dictionary', 'set', 'import_from_statement']),
  java: new Set(['array_initializer', 'element_value_array_initializer']),
  csharp: new Set(['initializer_expression', 'enum_member_declaration_list', 'collection_expression', 'switch_expression']),
  json: new Set(),
  // YAML flow collections allow a comma before their closing bracket.
  yaml: new Set(['flow_sequence', 'flow_mapping']),
};
/**
 * Rows a node read as one event must keep clear of, as running counts (`count[row]` rows guarded before `row`): next to
 * each block, the unchanged lines that repeat one of the block's lines, and one more. A line diff may pair such a line
 * with either copy, so the two sides could read the same node once whole and once token by token. Reading every node
 * there token by token keeps the two readings comparable.
 */
function guards(
  texts: { before: string; after: string },
  blocks: readonly SideBlock[],
  oldRows: number,
  newRows: number
): [Int32Array, Int32Array] {
  const oldLines = texts.before.split('\n'),
    newLines = texts.after.split('\n');
  const oldMark = new Uint8Array(oldRows + 1),
    newMark = new Uint8Array(newRows + 1);
  for (const block of blocks) {
    const own = new Set<string>();
    for (let r = block.oldRow; r < block.oldRow + block.oldCount; r++) own.add((oldLines[r] ?? '').trim());
    for (let r = block.newRow; r < block.newRow + block.newCount; r++) own.add((newLines[r] ?? '').trim());
    const mark = (lines: string[], marks: Uint8Array, from: number, step: 1 | -1) => {
      let r = from;
      while (r >= 0 && r < lines.length && own.has((lines[r] ?? '').trim())) {
        marks[r] = 1;
        r += step;
      }
      if (r >= 0 && r < marks.length) marks[r] = 1;
    };
    mark(oldLines, oldMark, block.oldRow - 1, -1);
    mark(oldLines, oldMark, block.oldRow + block.oldCount, 1);
    mark(newLines, newMark, block.newRow - 1, -1);
    mark(newLines, newMark, block.newRow + block.newCount, 1);
  }
  const counts = (marks: Uint8Array) => {
    const result = new Int32Array(marks.length + 1);
    for (let r = 0; r < marks.length; r++) result[r + 1] = result[r] + marks[r];
    return result;
  };
  return [counts(oldMark), counts(newMark)];
}

/**
 * Whether a node's text may start or end with a comment: a node read whole stands for its rows, while one read token
 * by token stands for its first and last code tokens' rows, and a comment at its edge would set the two apart. Any
 * comment marker on its first or last line counts.
 */
function commentAtEdge(text: string, start: number, end: number): boolean {
  const head = text.slice(start, Math.min(end, text.indexOf('\n', start) < 0 ? end : text.indexOf('\n', start)));
  const lastBreak = text.lastIndexOf('\n', end - 1);
  const tail = text.slice(Math.max(start, lastBreak + 1), end);
  return COMMENT_MARKER.test(head) || COMMENT_MARKER.test(tail);
}
const COMMENT_MARKER = /\/\/|\/\*|\*\/|#|<!--|-->/;
/** Nodes this long or longer that lie wholly in unchanged lines are read as one event (see `read`). */
const SUMMARY_MIN = 32;
/**
 * Tuples, where a trailing comma is optional once there are two elements: `(a, b,)` is `(a, b)`, but `(a,)` is a tuple
 * and `(a)` is not.
 */
const TUPLES = new Set(['tuple_expression', 'tuple_pattern', 'tuple_type', 'tuple']);
const CLOSERS = new Set([')', ']', '}', '>']);

/** Comments that tools read: changing one changes the build, the type check or the bundle. */
export const DIRECTIVE =
  /^\/\/go:|^\/\/\s*\+build\b|^\/\/export\s|^\/\/line\s|@ts-(ignore|expect-error|nocheck|check)\b|^\/\/\/\s*<(reference|amd)|@jsx(Runtime|ImportSource|Frag)?\b|#__PURE__|@__PURE__|webpackChunkName|^#\s*type:|^#\s*-\*-|^#!|^#\s*(pyright|mypy):|^#\s*(noqa|pylint)\b|eslint-disable|prettier-ignore|^#\s*yaml-language-server|#cgo\b|#include\b|sourceMappingURL|@vite-ignore|webpack(Ignore|Mode|Prefetch|Preload)|@flow\b|(istanbul|c8) ignore|\bnolint\b|NOLINT|pragma: ?no ?cover|fmt: ?(off|on|skip)\b|@formatter:(off|on)|biome-ignore|deno-lint-ignore|oxlint-disable|#\s*nosec\b|@(jest|vitest)-environment\b/;
/**
 * JSDoc that type-checks JavaScript (`checkJs`): its types are code to the checker, so a change to one is code. Prose
 * in the same comment is a comment. TypeScript's own JSDoc types are ignored by its checker, so there it is prose.
 */
const JSDOC_TYPES = /@(import|type|typedef|callback|template|satisfies|overload|implements|extends|augments|enum|this)\b|@(param|returns?|property|prop|arg|argument)\s*\{/;

/**
 * JSX text as React and every JSX compiler read it (Babel's `cleanJSXElementLiteralChild`): each line is trimmed where
 * it meets a line break, lines with nothing left are dropped, and line breaks between the rest become one space. Text
 * that differs only in that layout is the same text on the page.
 */
export function jsxText(value: string): string {
  const rows = value.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  rows.forEach((row, i) => {
    if (/[^ \t]/.test(row)) lastNonEmpty = i;
  });
  let result = '';
  rows.forEach((row, i) => {
    let trimmed = row.replace(/\t/g, ' ');
    if (i > 0) trimmed = trimmed.replace(/^ +/, '');
    if (i < rows.length - 1) trimmed = trimmed.replace(/ +$/, '');
    if (!trimmed) return;
    result += i === lastNonEmpty ? trimmed : `${trimmed} `;
  });
  return result;
}

/** Numeric literals, by grammar: their spelling is formatting (`1_000`, `0xFF`, `1E3`), their value is not. */
const NUMBERS: Record<SyntaxLanguage, ReadonlySet<string>> = {
  typescript: new Set(['number']),
  tsx: new Set(['number']),
  javascript: new Set(['number']),
  rust: new Set(['integer_literal', 'float_literal']),
  go: new Set(['int_literal', 'float_literal', 'imaginary_literal']),
  python: new Set(['integer', 'float']),
  java: new Set([
    'decimal_integer_literal',
    'hex_integer_literal',
    'octal_integer_literal',
    'binary_integer_literal',
    'decimal_floating_point_literal',
    'hex_floating_point_literal',
  ]),
  csharp: new Set(['integer_literal', 'real_literal']),
  // JSON and YAML values are read by many parsers, some exact: their numbers stay as written.
  json: new Set(),
  yaml: new Set(),
};
/**
 * A number as compared. Digit separators go and letters are lower-cased in every language with numbers here: case never
 * changes a literal's value or type (`0XFF`, `1E3`, `10L`, `1F`). JavaScript's numbers are doubles, so their spelling
 * reduces to the value (`1.50` is `1.5`), except a legacy octal (`017`) and a BigInt, which keep their digits.
 */
export function numberText(language: SyntaxLanguage, text: string): string {
  const value = text.replace(/_/g, '').toLowerCase();
  if (language !== 'typescript' && language !== 'tsx' && language !== 'javascript') return value;
  if (/^0\d/.test(value) || value.endsWith('n')) return value;
  if (!/^(0[xob][0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/.test(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : value;
}

/** A string as compared: simple strings in quote-insensitive languages lose their quote style. */
function atomText(language: SyntaxLanguage, type: string, text: string): string {
  if (type === 'jsx_text') return jsxText(text);
  if ((type === 'string' && (language === 'typescript' || language === 'tsx' || language === 'javascript' || language === 'python')) ||
    ((type === 'double_quote_scalar' || type === 'single_quote_scalar') && language === 'yaml')) {
    const simple = /^(['"])([^'"\\\n]*)\1$/.exec(text);
    if (simple) return `"${simple[2]}"`;
  }
  return text;
}
/** The node type a compared string goes by: YAML's two quoted scalars are one kind once their quotes are equal. */
const atomType = (type: string) => (type === 'single_quote_scalar' ? 'double_quote_scalar' : type);

// ── Reading a tree ──────────────────────────────────────────────────────────

/** One event of a tree's reading. `seg` is the segment of the side it falls in; `a`–`b`, its node's rows. */
interface Event {
  sig: string;
  seg: number;
  a: number;
  b: number;
}
interface Comment {
  a: number;
  b: number;
  start: number;
  end: number;
  text: string;
}
interface Reading {
  events: Event[];
  /**
   * The same reading with no equivalence: every token as written, every node. Two sides with equal strict readings
   * differ only in whitespace; equal readings but different strict ones, in formatting.
   */
  strict: Event[];
  comments: Comment[];
  /**
   * Tokens that cross a block's edge (a multi-line string): the segment they start in, and the blocks they reach. They
   * matter only when they changed, which the segment they start in shows.
   */
  edges: { seg: number; blocks: number[] }[];
}

/** Each row's segment: `2i + 1` inside block i, `2j` in the unchanged lines before block j (and after the last). */
function segments(rows: number, blocks: readonly { row: number; count: number }[]): Int32Array {
  const seg = new Int32Array(rows + 1);
  let b = 0;
  for (let row = 0; row <= rows; row++) {
    while (b < blocks.length && (blocks[b].count ? blocks[b].row + blocks[b].count <= row : blocks[b].row <= row)) b++;
    const inside = b < blocks.length && blocks[b].count > 0 && row >= blocks[b].row;
    seg[row] = inside ? 2 * b + 1 : 2 * b;
  }
  return seg;
}

function read(
  tree: TreeSitter.Tree,
  text: string,
  language: SyntaxLanguage,
  seg: Int32Array,
  lineStarts: readonly number[],
  /** Rows near a block a line diff could have paired either way: a node there is always read token by token. */
  guarded: Int32Array
): Reading {
  // A row from an offset, found here rather than asked of the cursor: each question to the WASM tree costs a call.
  let hint = 0;
  const rowOf = (index: number) => {
    let low = 0,
      high = lineStarts.length - 1;
    if (lineStarts[hint] <= index && (hint + 1 >= lineStarts.length || lineStarts[hint + 1] > index)) return hint;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    hint = low;
    return low;
  };
  const atoms = ATOMS[language];
  const trailing = TRAILING_COMMA[language];
  const events: Event[] = [];
  const strict: Event[] = [];
  const comments: Comment[] = [];
  const edges: Reading['edges'] = [];
  const pushStrict = (sig: string, a: number) => {
    const event = { sig, seg: segOf(a), a, b: a };
    strict.push(event);
    return event;
  };
  const last = seg.length - 1;
  const segOf = (row: number) => seg[Math.min(row, last)];
  const leafEnd = (row: number, column: number, startRow: number) => (column === 0 && row > startRow ? row - 1 : row);
  interface Frame {
    type: string;
    enter?: Event;
    strictEnter: Event;
    first: number;
    lastRow: number;
    /** End of the last child, for text no child covers. */
    covered: number;
    end: number;
    /** A comma held back until the next sibling shows whether it is trailing. */
    comma?: Event;
    /** The previous non-comment sibling was a named node. */
    afterNamed: boolean;
    /** The first non-comment child is still to come: a Python docstring is the first statement. */
    firstChild: boolean;
    parentType: string;
    /** An equivalence leaves this node out (FLATTEN): no events of its own, and these delimiters among its children. */
    flat?: ReadonlySet<string>;
    /** A one-parameter arrow function's parentheses are left out: so is its parameter's wrapper. */
    flatParameter?: boolean;
    /** Children seen so far, for a delimiter that only counts as the first child. */
    children: number;
    /** Named children seen so far: a tuple of two or more may end in a comma. */
    named: number;
  }
  const stack: Frame[] = [];
  // A token's rows go to the innermost open node; each node hands its rows to its parent when it closes.
  const touch = (row: number, endRow: number) => {
    const frame = stack.at(-1);
    if (!frame) return;
    if (frame.first < 0) frame.first = row;
    frame.lastRow = endRow;
  };
  const push = (sig: string, a: number, b: number, closer = false) => {
    const frame = stack.at(-1);
    if (frame?.comma) {
      // A comma right before a closing bracket is the trailing comma the list allows.
      if (!closer) events.push(frame.comma);
      frame.comma = undefined;
    }
    const event = { sig, seg: segOf(a), a, b };
    events.push(event);
    return event;
  };
  const leaf = (type: string, value: string, a: number, b: number, raw?: string) => {
    const sig = `${type}\u0000${value}`;
    pushStrict(raw ?? sig, a);
    if (segOf(a) !== segOf(b)) {
      const reached: number[] = [];
      for (let s = segOf(a); s <= segOf(b); s++) if (s % 2) reached.push((s - 1) / 2);
      edges.push({ seg: segOf(a), blocks: reached });
    }
    push(sig, a, b, CLOSERS.has(type));
    touch(a, b);
  };
  const gap = (from: number, to: number, row: number) => {
    if (to <= from) return;
    let blank = true;
    for (let i = from; i < to && blank; i++) {
      const c = text.charCodeAt(i);
      blank = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xfeff || c === 0xa0;
    }
    if (blank) return;
    const between = text.slice(from, to);
    if (/\S/.test(between)) leaf('\u0001text', between.replace(/\s+/g, ' ').trim(), row, row);
  };
  /** Closes a node: text no child covered, a held comma, its exit events, and its rows handed to its parent. */
  const closeFrame = (frame: Frame) => {
    gap(frame.covered, frame.end, frame.lastRow < 0 ? 0 : frame.lastRow);
    if (frame.comma) events.push(frame.comma);
    if (frame.first < 0) {
      const index = strict.lastIndexOf(frame.strictEnter);
      if (index >= 0) strict.splice(index, 1);
    } else {
      frame.strictEnter.seg = segOf(frame.first);
      strict.push({ sig: '<', seg: segOf(frame.lastRow), a: frame.first, b: frame.lastRow });
    }
    if (frame.enter) {
      if (frame.first < 0) {
        // A node with no tokens (all comments, or empty): no events.
        const index = events.lastIndexOf(frame.enter);
        if (index >= 0) events.splice(index, 1);
      } else {
        frame.enter.a = frame.first;
        frame.enter.b = frame.lastRow;
        frame.enter.seg = segOf(frame.first);
        events.push({ sig: '<', seg: segOf(frame.lastRow), a: frame.first, b: frame.lastRow });
      }
    }
    const parent = stack.at(-1);
    if (parent) {
      parent.afterNamed = true;
      if (frame.first >= 0) {
        if (parent.first < 0) parent.first = frame.first;
        parent.lastRow = frame.lastRow;
      }
    }
  };
  let flat: ReadonlySet<string> | undefined;
  const cursor = tree.walk();
  try {
    for (;;) {
      const type = cursor.nodeType;
      const start = cursor.startIndex,
        end = cursor.endIndex;
      const a = rowOf(start);
      const endRow = rowOf(end);
      const b = leafEnd(endRow, lineStarts[endRow] === end ? 0 : 1, a);
      const rowsEnd = () => b;
      const parent = stack.at(-1);
      if (parent) {
        gap(parent.covered, start, a);
        parent.covered = Math.max(parent.covered, end);
      }
      let descend = false;
      // A node wholly in unchanged lines reads as one event, its type and length: its text is the same on both sides,
      // so a node there with the same type and length on the other side is the same subtree (as tree-sitter's own
      // incremental parsing assumes). A difference here still shows: the other side has another node, or none.
      // Short nodes, such as a closing bracket a trailing comma waits for, are read as usual. The node's last offset,
      // not its last line, decides: a node whose text ends with a line break (Go's statements and their blank lines)
      // touches the next line, which may be a block's.
      if (
        parent &&
        end - start >= SUMMARY_MIN &&
        seg[Math.min(a, last)] % 2 === 0 &&
        seg[Math.min(a, last)] === seg[Math.min(endRow, last)] &&
        !COMMENTS.has(type) &&
        !commentAtEdge(text, start, end) &&
        guarded[Math.min(endRow + 1, guarded.length - 1)] === guarded[Math.min(a, guarded.length - 1)]
      ) {
        parent.children++;
        parent.firstChild = false;
        leaf(`=${type}`, String(end - start), a, b);
        parent.afterNamed = true;
        for (;;) {
          if (cursor.gotoNextSibling()) break;
          const frame = stack.pop();
          if (!frame) return { events, strict, comments, edges };
          closeFrame(frame);
          if (!cursor.gotoParent()) return { events, strict, comments, edges };
        }
        continue;
      }
      if (parent) {
        parent.children++;
        if (TUPLES.has(parent.type) && cursor.nodeIsNamed && !COMMENTS.has(type)) parent.named++;
      }
      const docstring =
        language === 'python' &&
        type === 'expression_statement' &&
        parent?.firstChild &&
        (parent.type === 'module' || (parent.type === 'block' && /^(function|class)_definition$/.test(parent.parentType))) &&
        isDocstring(cursor.currentNode);
      if (COMMENTS.has(type) || docstring) {
        const value = text.slice(start, end);
        if (!docstring && (DIRECTIVE.test(value.trim()) || (language === 'javascript' && JSDOC_TYPES.test(value))))
          leaf('\u0001directive', value.trim(), a, rowsEnd());
        else comments.push({ a, b: rowsEnd(), start, end, text: value });
      } else {
        if (parent) parent.firstChild = false;
        if (LAYOUT_EXTRAS.has(type)) {
          // Joins two lines and nothing else.
        } else if (atoms.has(type)) {
          const written = text.slice(start, end);
          const value = atomText(language, type, written);
          // JSX text that is only layout is no child at all.
          if (value || type !== 'jsx_text') leaf(atomType(type), value, a, rowsEnd(), `${type}\u0000${written}`);
          else pushStrict(`${type}\u0000${written}`, a);
          if (parent) parent.afterNamed = true;
        } else if (FLATTEN_CANDIDATES[language].has(type) && (flat = flatten(language, type, parent, cursor.currentNode)) && cursor.gotoFirstChild()) {
          const strictEnter = pushStrict(`>${type}`, a);
          stack.push({ type, strictEnter, first: -1, lastRow: -1, covered: start, end, afterNamed: false, firstChild: true, parentType: parent?.type ?? '', flat, flatParameter: type === 'formal_parameters', children: 0, named: 0 });
          descend = true;
        } else if (cursor.gotoFirstChild()) {
          const enter = push(`>${type}`, a, a);
          const strictEnter = pushStrict(`>${type}`, a);
          stack.push({ type, enter, strictEnter, first: -1, lastRow: -1, covered: start, end, afterNamed: false, firstChild: true, parentType: parent?.type ?? '', children: 0, named: 0 });
          descend = true;
        } else {
          const value = text.slice(start, end);
          const named = cursor.nodeIsNamed;
          if (parent && optional(language, type, parent)) {
            // A delimiter an equivalence leaves out (FLATTEN, optional): no event, and the rows stay.
            pushStrict(`${type}\u0000${value}`, a);
          } else if (type === ',' && parent && (trailing.has(parent.type) || (TUPLES.has(parent.type) && parent.named >= 2)) && parent.afterNamed) {
            // Held until the next sibling: dropped before a closing bracket.
            pushStrict(`,\u0000,`, a);
            if (parent.comma) events.push(parent.comma);
            parent.comma = { sig: `,\u0000,`, seg: segOf(a), a, b: a };
            touch(a, a);
          } else if (NUMBERS[language].has(type)) leaf(type, numberText(language, value), a, rowsEnd(), `${type}\u0000${value}`);
          else leaf(type, /\S/.test(value) ? value : '', a, rowsEnd());
          if (parent) parent.afterNamed = named;
        }
      }
      if (descend) continue;
      // Up and along: close every frame that has no next sibling.
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        const frame = stack.pop();
        if (!frame) return { events, strict, comments, edges };
        closeFrame(frame);
        if (!cursor.gotoParent()) return { events, strict, comments, edges };
      }
    }
  } finally {
    cursor.delete();
  }
}

/**
 * Equivalences of structure, each exact in its grammar: the left side and the right side are one program.
 * - JavaScript and TypeScript: `(expr)` where a whole expression goes (a return value, an initializer, an argument, an
 *   arrow's body…) is `expr`: the tree already holds the grouping, and those places take the expression whole. Not
 *   around a sequence (`a, b`). Around a JSX element, a name or a literal, anywhere. `(x) => …` is `x => …` for one plain parameter. A union or intersection type's leading
 *   `|` or `&` (`| A | B`) is `A | B`. A `;` is left out everywhere but a `for` header: where it ends a statement, the
 *   tree's statements already say so, and a `;` that changes them (ASI) changes the tree.
 * - Python: `(expr)` as a return value, an assigned value, an argument or a statement is `expr`.
 * - Rust: a match arm's or closure's body `{ expr }` is `expr` (rustfmt writes one for the other), and a match arm's
 *   `,` is optional.
 * Redundant parentheses elsewhere stay: inside an operator they can change precedence, and `(a?.b).c` is not `a?.b.c`.
 */
const SCRIPT_WHOLE = new Set([
  'return_statement',
  'variable_declarator',
  'assignment_expression',
  'augmented_assignment_expression',
  'arrow_function',
  'jsx_expression',
  'arguments',
  'array',
  'pair',
  'template_substitution',
  'await_expression',
  'spread_element',
  'yield_expression',
  'throw_statement',
  'expression_statement',
  'export_statement',
]);
const SCRIPT_PRIMARY = new Set([
  'jsx_element',
  'jsx_self_closing_element',
  'jsx_fragment',
  'identifier',
  'number',
  'string',
  'template_string',
  'true',
  'false',
  'null',
  'undefined',
  'this',
]);
const PYTHON_WHOLE = new Set(['return_statement', 'assignment', 'augmented_assignment', 'keyword_argument', 'argument_list', 'expression_statement']);
const SCRIPT_FLATTEN = new Set(['parenthesized_expression', 'formal_parameters', 'required_parameter', 'union_type', 'intersection_type', 'statement_block']);
const FLATTEN_CANDIDATES: Record<SyntaxLanguage, ReadonlySet<string>> = {
  typescript: SCRIPT_FLATTEN,
  tsx: SCRIPT_FLATTEN,
  javascript: SCRIPT_FLATTEN,
  python: new Set(['parenthesized_expression']),
  rust: new Set(['block', 'expression_statement']),
  go: new Set(),
  java: new Set(['block']),
  csharp: new Set(['block']),
  json: new Set(),
  yaml: new Set(),
};
const PARENS: ReadonlySet<string> = new Set(['(', ')']);
const SCRIPT_BRACED = new Set(['if_statement', 'else_clause', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement']);
/** Statements whose body may be one statement with or without braces. */
const BRACED: Partial<Record<SyntaxLanguage, ReadonlySet<string>>> = {
  typescript: SCRIPT_BRACED,
  tsx: SCRIPT_BRACED,
  javascript: SCRIPT_BRACED,
  java: new Set(['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement']),
  csharp: new Set(['if_statement', 'else_clause', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement']),
};
const NONE: ReadonlySet<string> = new Set();
const BRACES: ReadonlySet<string> = new Set(['{', '}']);
/** The delimiters a node drops when an equivalence leaves it out, or undefined when it stays. */
function flatten(
  language: SyntaxLanguage,
  type: string,
  parent: { type: string; flatParameter?: boolean; flat?: ReadonlySet<string> } | undefined,
  node: TreeSitter.Node
): ReadonlySet<string> | undefined {
  if (!parent) return undefined;
  if (type === 'parenthesized_expression') {
    const whole = language === 'python' ? PYTHON_WHOLE : SCRIPT_WHOLE;
    if (node.namedChildCount !== 1) return undefined;
    const inner = node.namedChild(0)?.type ?? '';
    // Around a primary expression (a JSX element, a name, a literal), parentheses change nothing anywhere: there is no
    // operator inside for them to group. Calls and member accesses are left out: `(a?.b).c` is not `a?.b.c`.
    if (language !== 'python' && SCRIPT_PRIMARY.has(inner)) return PARENS;
    if (!whole.has(parent.type)) return undefined;
    return /sequence|comment|yield|generator|tuple/.test(inner) ? undefined : PARENS;
  }
  if (type === 'formal_parameters') {
    if (parent.type !== 'arrow_function' || node.namedChildCount !== 1) return undefined;
    const only = node.namedChild(0);
    if (!only) return undefined;
    if (only.type === 'identifier') return PARENS;
    // TypeScript: `required_parameter` with a plain name and nothing else: no type, default, modifier or `...`.
    return only.type === 'required_parameter' && only.childCount === 1 && only.child(0)?.type === 'identifier' ? PARENS : undefined;
  }
  if (type === 'required_parameter') return parent.flatParameter && parent.flat ? NONE : undefined;
  if (type === 'union_type' || type === 'intersection_type') {
    const lead = type === 'union_type' ? '|' : '&';
    return node.childCount === 2 && node.child(0)?.type === lead ? new Set([lead]) : undefined;
  }
  if ((type === 'statement_block' || type === 'block') && BRACED[language]?.has(parent.type)) {
    // `if (a) { b(); }` is `if (a) b();`: one statement, braced or not. The tree says which `if` an `else` belongs to,
    // so braces that move an `else` change the tree. Declarations are left alone: they cannot stand unbraced.
    if (node.childCount !== 3 || node.child(0)?.type !== '{' || node.child(2)?.type !== '}') return undefined;
    const inner = node.child(1)?.type ?? '';
    return inner.endsWith('_statement') && !/declaration|labeled|local_function/.test(inner) ? BRACES : undefined;
  }
  if (type === 'block' && language === 'rust') {
    if (parent.type !== 'match_arm' && parent.type !== 'closure_expression') return undefined;
    if (node.childCount !== 3 || node.child(0)?.type !== '{' || node.child(2)?.type !== '}') return undefined;
    const inner = node.child(1);
    if (!inner?.isNamed) return undefined;
    // A block-like expression (`match`, `if`, `loop`) at the end of a block reads as an expression statement
    // without a `;`: it is still the block's value.
    if (inner.type === 'expression_statement') return inner.childCount === 1 ? BRACES : undefined;
    return !/statement|declaration|_item$|comment|^label$/.test(inner.type) ? BRACES : undefined;
  }
  if (type === 'expression_statement' && language === 'rust')
    return parent.type === 'block' && parent.flat === BRACES && node.childCount === 1 ? NONE : undefined;
  return undefined;
}
const SCRIPTS = new Set<SyntaxLanguage>(['typescript', 'tsx', 'javascript']);
/** A token that is left out: a flattened node's delimiter, or a token the language never needs (see FLATTEN). */
function optional(language: SyntaxLanguage, type: string, parent: { type: string; flat?: ReadonlySet<string>; children: number }): boolean {
  if (parent.flat?.has(type)) return parent.type !== 'union_type' && parent.type !== 'intersection_type' ? true : parent.children === 1;
  if (type === ';' && SCRIPTS.has(language)) return !/^for(_in)?_statement$/.test(parent.type);
  if (type === ',' && language === 'rust') return parent.type === 'match_arm';
  return false;
}

function isDocstring(node: TreeSitter.Node): boolean {
  if (node.namedChildCount !== 1) return false;
  const only = node.namedChild(0);
  return only?.type === 'string';
}

// ── Comparing ───────────────────────────────────────────────────────────────

const same = (a: readonly Event[], b: readonly Event[]) => a.length === b.length && a.every((event, i) => event.sig === b[i].sig);
const bySegment = (events: readonly Event[], count: number) => {
  const groups: Event[][] = Array.from({ length: count }, () => []);
  for (const event of events) groups[event.seg]?.push(event);
  return groups;
};
/** Whether rows `a`–`b` reach a block of `count` rows from `row`; a block of no rows sits between `row - 1` and `row`. */
const reaches = (a: number, b: number, row: number, count: number) =>
  count ? a < row + count && b >= row : a < row && b >= row;

/** The block's lines with comments blanked out and blank lines dropped: what changed besides comments. */
function layout(text: string, lineStarts: readonly number[], row: number, count: number, comments: readonly Comment[]): string[] {
  const result: string[] = [];
  for (let r = row; r < row + count; r++) {
    const from = lineStarts[r],
      to = (lineStarts[r + 1] ?? text.length + 1) - 1;
    let line = '';
    let at = from;
    for (const comment of comments) {
      if (comment.end <= from || comment.start >= to) continue;
      line += text.slice(at, Math.max(at, comment.start));
      at = Math.max(at, comment.end);
    }
    line += text.slice(Math.min(at, to), to);
    line = line.trimEnd();
    if (line) result.push(line);
  }
  return result;
}
const starts = (text: string) => {
  const result = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) result.push(i + 1);
  return result;
};
const commentTexts = (comments: readonly Comment[], row: number, count: number) =>
  comments.filter((c) => reaches(c.a, c.b, row, count)).map((c) => c.text.replace(/\s+/g, ' ').trim());

/** Blocks compared together at most, and the unchanged lines between two of them: about one GitHub hunk. */
const JOIN_BLOCKS = 48;
const JOIN_GAP = 40;

/**
 * Files larger than this are not compared: a comparison parses both sides in the one worker, and a long one would hold
 * up the next file's breadcrumbs.
 */
export const NOISE_MAX_CHARACTERS = 400_000;

export interface NoiseParser {
  /** Parses `text`, reusing `previous` (already edited to match) where it can, as tree-sitter's incremental parse. */
  parse: (text: string, previous?: TreeSitter.Tree) => TreeSitter.Tree | null;
}

/**
 * Both sides' trees for `texts` (comparisonTexts): the new side parses whole; the old side reuses it, edited block by
 * block from the last up, since the two texts differ only in the blocks' lines. Every edit starts and ends at a line
 * start. The caller deletes both.
 */
export function comparisonTrees(
  parser: NoiseParser,
  texts: { before: string; after: string; blocks: readonly SideBlock[] },
  oldStarts = starts(texts.before),
  newStarts = starts(texts.after)
): { oldTree: TreeSitter.Tree | null; newTree: TreeSitter.Tree | null } {
  const { blocks } = texts;
  const newTree = parser.parse(texts.after);
  let oldTree: TreeSitter.Tree | null = null;
  if (newTree) {
    const edited = newTree.copy();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const startIndex = newStarts[block.newRow] ?? texts.after.length;
      const oldEndIndex = newStarts[block.newRow + block.newCount] ?? texts.after.length;
      const length = (oldStarts[block.oldRow + block.oldCount] ?? texts.before.length) - (oldStarts[block.oldRow] ?? texts.before.length);
      edited.edit({
        startIndex,
        oldEndIndex,
        newEndIndex: startIndex + length,
        startPosition: { row: block.newRow, column: 0 },
        oldEndPosition: { row: block.newRow + block.newCount, column: 0 },
        newEndPosition: { row: block.newRow + block.oldCount, column: 0 },
        // The runtime reads these six fields; its Edit class adds helpers this does not need.
      } as unknown as TreeSitter.Edit);
    }
    oldTree = parser.parse(texts.before, edited);
    edited.delete();
  }
  return { oldTree, newTree };
}

/**
 * Classifies each block of `texts` (comparisonTexts). `parse` parses with the file's grammar; trees are deleted
 * before this returns.
 */
export function classifyBlocks(
  parser: NoiseParser,
  language: SyntaxLanguage,
  texts: { before: string; after: string; blocks: readonly SideBlock[] },
  /** Reads both trees before they are deleted: moved symbols fingerprint from the same parse (lib/syntax-scope.ts). */
  trees?: (before: TreeSitter.Tree | null, after: TreeSitter.Tree | null) => void
): { kind: NoiseKind; reason?: string }[] {
  const { blocks } = texts;
  if (!blocks.length) return [];
  const all = (reason: string) => blocks.map(() => ({ kind: 'code' as const, reason }));
  const oldStarts = starts(texts.before),
    newStarts = starts(texts.after);
  const { oldTree, newTree } = comparisonTrees(parser, texts, oldStarts, newStarts);
  try {
    if (!oldTree || !newTree) return all('parse-error');
    if (oldTree.rootNode.hasError || newTree.rootNode.hasError) return all('parse-error');
    const oldSeg = segments(oldStarts.length, blocks.map((b) => ({ row: b.oldRow, count: b.oldCount })));
    const newSeg = segments(newStarts.length, blocks.map((b) => ({ row: b.newRow, count: b.newCount })));
    const [oldGuard, newGuard] = guards(texts, blocks, oldStarts.length, newStarts.length);
    const before = read(oldTree, texts.before, language, oldSeg, oldStarts, oldGuard);
    const after = read(newTree, texts.after, language, newSeg, newStarts, newGuard);
    const count = 2 * blocks.length + 1;
    const oldGroups = bySegment(before.events, count),
      newGroups = bySegment(after.events, count);
    const reasons: (string | undefined)[] = blocks.map(() => undefined);
    // The whole program reads the same: every block is formatting or comments, however the line diff paired lines.
    // Blocks compared together (a join below), so their strict readings are compared together too.
    const groups = blocks.map((_, i): [number, number] => [i, i]);
    const strictSame = (i: number) => {
      const [from, to] = groups[i];
      const pick = (list: Event[]) => list.filter((event) => event.seg >= 2 * from + 1 && event.seg <= 2 * to + 1);
      return same(pick(before.strict), pick(after.strict));
    };
    if (same(before.events, after.events)) {
      const whole = same(before.strict, after.strict);
      return quietKinds(blocks, texts, before, after, oldStarts, newStarts, reasons, (i) => whole || strictSame(i));
    }
    blocks.forEach((_, i) => {
      if (!same(oldGroups[2 * i + 1], newGroups[2 * i + 1])) reasons[i] ??= 'tokens';
    });
    // The unchanged lines must read the same. Where they do not, the blocks whose nodes reach the difference are code.
    const contextDiffers: boolean[] = [];
    for (let j = 0; j <= blocks.length; j++) {
      const o = oldGroups[2 * j],
        n = newGroups[2 * j];
      contextDiffers[j] = !same(o, n);
      if (!contextDiffers[j]) continue;
      let head = 0;
      while (head < o.length && head < n.length && o[head].sig === n[head].sig) head++;
      let tail = 0;
      while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail].sig === n[n.length - 1 - tail].sig) tail++;
      const blame = (events: readonly Event[], side: 'old' | 'new') => {
        let unreached = false;
        for (const event of events) {
          let found = false;
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const [row, rows] = side === 'old' ? [block.oldRow, block.oldCount] : [block.newRow, block.newCount];
            if (!reaches(event.a, event.b, row, rows)) continue;
            found = true;
            reasons[i] ??= 'context';
          }
          if (!found) unreached = true;
        }
        return !unreached;
      };
      const reached = blame(o.slice(head, o.length - tail), 'old') && blame(n.slice(head, n.length - tail), 'new');
      if (reached) continue;
      // Nodes wholly in these unchanged lines read differently. A difference that runs up to a block is that block's:
      // a node that now ends inside the block below (Python's loop that takes in the next line, YAML's mapping that
      // gives up a key), or code the block above swallowed (a comment it opened). One that touches neither block is
      // not traced: every block is code.
      const above = head === 0 && j > 0,
        below = tail === 0 && j < blocks.length;
      if (!above && !below) return all('context');
      if (above) reasons[j - 1] ??= 'context';
      if (below) reasons[j] ??= 'context';
    }
    // A token across a block's edge (a multi-line string) is compared in the segment it starts in; when that segment
    // differs, every block it reaches is code.
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of [...before.edges, ...after.edges]) {
        const start = edge.seg % 2 ? reasons[(edge.seg - 1) / 2] !== undefined : contextDiffers[edge.seg / 2];
        if (!start) continue;
        for (const index of edge.blocks)
          if (reasons[index] === undefined) {
            reasons[index] = 'edge';
            changed = true;
          }
      }
    }
    // A line diff can pair lines across blocks, such as a closing brace of a reindented block matched to another
    // one: no single block reads the same, though together they do. Neighbouring blocks that differ only in their
    // tokens are compared together, unchanged lines between them included.
    const joined = (from: number, to: number, groups: Event[][]) => groups.slice(2 * from + 1, 2 * to + 2).flat();
    for (let i = 0; i < blocks.length; i++) {
      if (reasons[i] !== 'tokens') continue;
      for (let k = i + 1; k < blocks.length && k <= i + JOIN_BLOCKS; k++) {
        if (blocks[k].newRow - (blocks[k - 1].newRow + blocks[k - 1].newCount) > JOIN_GAP) break;
        if (reasons[k] && reasons[k] !== 'tokens') break;
        if (!same(joined(i, k, oldGroups), joined(i, k, newGroups))) continue;
        for (let m = i; m <= k; m++) {
          reasons[m] = undefined;
          groups[m] = [i, k];
        }
        i = k;
        break;
      }
    }
    return quietKinds(blocks, texts, before, after, oldStarts, newStarts, reasons, strictSame);
  } finally {
    try {
      trees?.(oldTree, newTree);
    } catch {
      // The trees' reader fails on its own (moved symbols mark the file): the classification above still stands.
    } finally {
      oldTree?.delete();
      newTree?.delete();
    }
  }
}

/** Each block's kind: code for a reason, else formatting, comments or both, by its comments and its layout. */
function quietKinds(
  blocks: readonly SideBlock[],
  texts: { before: string; after: string },
  before: Reading,
  after: Reading,
  oldStarts: readonly number[],
  newStarts: readonly number[],
  reasons: readonly (string | undefined)[],
  /** The block's tokens are the same as written, not only equivalent: whitespace, not formatting. */
  strictSame: (index: number) => boolean
): { kind: NoiseKind; reason?: string }[] {
  return blocks.map((block, i) => {
    const reason = reasons[i];
    if (reason) return { kind: 'code' as const, reason };
    const oldComments = commentTexts(before.comments, block.oldRow, block.oldCount);
    const newComments = commentTexts(after.comments, block.newRow, block.newCount);
    const commented = oldComments.length !== newComments.length || oldComments.some((text, k) => text !== newComments[k]);
    const written = strictSame(i);
    if (!commented) return { kind: written ? ('whitespace' as const) : ('formatting' as const) };
    if (!written) return { kind: 'formatting-comments' as const };
    const oldLayout = layout(texts.before, oldStarts, block.oldRow, block.oldCount, before.comments);
    const newLayout = layout(texts.after, newStarts, block.newRow, block.newCount, after.comments);
    const moved = oldLayout.length !== newLayout.length || oldLayout.some((line, k) => line !== newLayout[k]);
    return { kind: moved ? ('whitespace-comments' as const) : ('comments' as const) };
  });
}

/**
 * Classifies every change block of a diff, from the new side's text and its hunks. Blocks keep the hunks' own line
 * numbers. Every block is code when the hunks do not match the text.
 */
export function classifyNoise(
  parser: NoiseParser,
  language: SyntaxLanguage,
  after: string,
  hunks: readonly HunkLike[],
  /** Reads the two texts and their trees before the trees are deleted; not called when the hunks do not match. */
  trees?: (
    texts: NonNullable<ReturnType<typeof comparisonTexts>>,
    before: TreeSitter.Tree | null,
    after: TreeSitter.Tree | null
  ) => void
): NoiseBlock[] {
  const blocks = changeBlocks(hunks);
  const texts = comparisonTexts(after, hunks);
  if (!texts || texts.blocks.length !== blocks.length) return blocks.map((block) => ({ ...block, kind: 'code', reason: 'mismatch' }));
  const kinds = classifyBlocks(parser, language, texts, trees && ((before, now) => trees(texts, before, now)));
  return blocks.map((block, i) => ({ ...block, ...kinds[i] }));
}

/**
 * Whether two versions of a file are the same program, by the comparison above: every change between them is
 * whitespace or formatting. A comment change, a parse error on either side or any doubt is a difference. The conflict
 * checks use it to tell a side that only reformatted lines (lib/conflict-verify.ts).
 */
export function formattingEquivalent(parser: NoiseParser, language: SyntaxLanguage, before: string, after: string): boolean {
  const lines = (text: string) => {
    const list = text.split('\n');
    if (list.at(-1) === '') list.pop();
    return list;
  };
  const rows: Row[] = diffArrays(lines(before), lines(after)).flatMap((part) =>
    part.value.map((text) => ({ type: part.added ? ('+' as const) : part.removed ? ('-' as const) : (' ' as const), text }))
  );
  const blocks = classifyNoise(parser, language, after, [{ oldStart: 1, newStart: 1, rows }]);
  return blocks.every((block) => block.kind === 'whitespace' || block.kind === 'formatting');
}

// ── Views ───────────────────────────────────────────────────────────────────

/**
 * What the reader chose to hide (Diff appearance). Hiding formatting hides whitespace too: a formatter's change is
 * whitespace and equivalent tokens, so the reader who hides one hides the lesser.
 */
export interface NoiseFilter {
  whitespace: boolean;
  formatting: boolean;
  comments: boolean;
  /** Hunks that only add names from modules the file already imports. */
  imports: boolean;
}
export const NO_NOISE_FILTER: NoiseFilter = { whitespace: false, formatting: false, comments: false, imports: false };
export const noiseFilterOn = (filter: NoiseFilter) => filter.whitespace || filter.formatting || filter.comments || filter.imports;

/** The parts of a kind: its code's layout or spelling (whitespace or formatting), comments, and imports. */
function parts(kind: NoiseKind): { layout?: 'whitespace' | 'formatting'; comments: boolean; imports?: boolean } {
  switch (kind) {
    case 'imports':
      return { comments: false, imports: true };
    case 'whitespace':
      return { layout: 'whitespace', comments: false };
    case 'formatting':
      return { layout: 'formatting', comments: false };
    case 'comments':
      return { comments: true };
    case 'whitespace-comments':
      return { layout: 'whitespace', comments: true };
    case 'formatting-comments':
      return { layout: 'formatting', comments: true };
    default:
      return { comments: false };
  }
}

/** Whether the filter hides a block of this kind: a mixed kind only when the filter hides each of its parts. */
export function hidden(kind: NoiseKind | undefined, filter: NoiseFilter): boolean {
  if (!kind || kind === 'code') return false;
  if (kind === 'imports') return filter.imports;
  const { layout, comments } = parts(kind);
  const layoutHidden = !layout || (layout === 'whitespace' ? filter.whitespace || filter.formatting : filter.formatting);
  return layoutHidden && (!comments || filter.comments);
}

/** The kinds of quiet change a run holds, leading first: its layout (formatting includes whitespace), comments, imports. */
export type QuietPart = 'whitespace' | 'formatting' | 'comments' | 'imports';
export function quietParts(kinds: Iterable<NoiseKind>): QuietPart[] {
  let whitespace = false,
    formatting = false,
    comments = false,
    imports = false;
  for (const kind of kinds) {
    const p = parts(kind);
    if (p.layout === 'whitespace') whitespace = true;
    if (p.layout === 'formatting') formatting = true;
    if (p.comments) comments = true;
    if (p.imports) imports = true;
  }
  const layout = formatting ? 'formatting' : whitespace ? 'whitespace' : undefined;
  return [layout, comments ? 'comments' : undefined, imports ? 'imports' : undefined].filter((part): part is QuietPart => !!part);
}
/** The kind that leads a run, for its icon. */
export const quietKind = (kinds: Iterable<NoiseKind>): QuietPart => quietParts(kinds)[0] ?? 'comments';

/**
 * A hidden run's label: "Whitespace only", "Formatting only", "Comments only", "Imports only", or the parts together,
 * "Formatting and comments", "Whitespace, comments and imports".
 */
export function noiseLabel(kinds: Iterable<NoiseKind>): string {
  const words = quietParts(kinds) as string[];
  if (!words.length) return 'Comments only';
  const first = words[0][0].toUpperCase() + words[0].slice(1);
  if (words.length === 1) return `${first} only`;
  return `${[first, ...words.slice(1, -1)].join(', ')} and ${words.at(-1)}`;
}
/** Whether a run is comments alone, for its icon. */
export const commentsOnly = (kinds: Iterable<NoiseKind>) => quietKind(kinds) === 'comments' && quietParts(kinds).length === 1;

/** One hunk of a view, as the filter sees it: hidden when every change in it is, with what it hides. */
export interface HunkNoise {
  hidden: boolean;
  /** The kinds of its hidden blocks. */
  kinds: NoiseKind[];
  /** Lines of hidden blocks: added and deleted. */
  added: number;
  deleted: number;
  /** New lines of hidden blocks, for dimming them in a hunk that also changes code. */
  lines: { side: 'before' | 'after'; line: number }[];
}

/**
 * How the filter treats a hunk the view shows: its change blocks are looked up by where they start. A block the
 * classification does not know (a different diff of the same file) is code.
 */
export function hunkNoise(hunk: HunkLike, kinds: ReadonlyMap<string, NoiseKind>, filter: NoiseFilter): HunkNoise {
  const result: HunkNoise = { hidden: false, kinds: [], added: 0, deleted: 0, lines: [] };
  let changed = 0,
    quiet = 0;
  for (const block of changeBlocks([hunk])) {
    changed++;
    const kind = kinds.get(blockKey(block));
    if (!hidden(kind, filter) || !kind) continue;
    quiet++;
    result.kinds.push(kind);
    result.added += block.newCount;
    result.deleted += block.oldCount;
    for (let i = 0; i < block.oldCount; i++) result.lines.push({ side: 'before', line: block.oldStart + i });
    for (let i = 0; i < block.newCount; i++) result.lines.push({ side: 'after', line: block.newStart + i });
  }
  result.hidden = changed > 0 && quiet === changed;
  return result;
}

/** A file as the filter sees it: whether all its changes are hidden, and how many of its lines are. */
export interface FileNoise {
  /** Every change block is hidden by the filter. */
  all: boolean;
  kinds: NoiseKind[];
  added: number;
  deleted: number;
  /** Hidden lines by what they are: a block of formatting and comments counts as formatting. */
  lines: { whitespace: number; formatting: number; comments: number; imports: number };
  /** Lines of the changes that show: code, and noise the filter does not hide. */
  shown: number;
  /**
   * Every change is whitespace or formatting, across several hunks or many lines: the file reads as one run of a
   * formatter. Only then does it say "Reformatted".
   */
  reformatted: boolean;
}
/** Hunks, or changed lines, a quiet file needs before it reads as reformatted. */
const REFORMATTED_BLOCKS = 3;
const REFORMATTED_LINES = 20;
export function fileNoise(blocks: readonly NoiseBlock[], filter: NoiseFilter): FileNoise {
  const result: FileNoise = {
    all: blocks.length > 0,
    kinds: [],
    added: 0,
    deleted: 0,
    lines: { whitespace: 0, formatting: 0, comments: 0, imports: 0 },
    shown: 0,
    reformatted: false,
  };
  for (const block of blocks) {
    const lines = block.newCount + block.oldCount;
    if (!hidden(block.kind, filter)) {
      result.all = false;
      result.shown += lines;
      continue;
    }
    result.kinds.push(block.kind);
    result.added += block.newCount;
    result.deleted += block.oldCount;
    const p = parts(block.kind);
    result.lines[p.layout ?? (p.imports ? 'imports' : 'comments')] += lines;
  }
  const layoutOnly = result.kinds.every((kind) => kind === 'whitespace' || kind === 'formatting');
  result.reformatted =
    result.all && layoutOnly && (blocks.length >= REFORMATTED_BLOCKS || result.added + result.deleted >= REFORMATTED_LINES);
  return result;
}

/** The hidden lines in words, quietly, largest first: "90 formatting · 12 comments". */
export function noiseStat(noise: Pick<FileNoise, 'lines'>): string | undefined {
  const words = (['formatting', 'whitespace', 'comments', 'imports'] as const)
    .filter((key) => noise.lines[key] > 0)
    .sort((a, b) => noise.lines[b] - noise.lines[a])
    .map((key) => `${noise.lines[key].toLocaleString()} ${key}`);
  return words.length ? words.join(' · ') : undefined;
}
