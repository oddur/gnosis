import type * as TreeSitter from 'web-tree-sitter';
import type { SyntaxLanguage } from './syntax-scope';

/**
 * Formatting-only and comment-only changes (#396), from the two sides' syntax trees.
 *
 * A diff's unit here is a change block: a run of added and deleted lines with no unchanged line between them. A
 * GitHub hunk holds one or more; a view that joins hunks (a revealed gap) still shows the same blocks. Each block is
 * - `formatting` when both sides have the same code: the same tokens, in the same tree, with only whitespace, line
 *   breaks, blank lines, and the equivalences below between them;
 * - `comments` when the code is the same and only comments differ (added, removed or edited, doc comments too);
 * - `both` when the code is the same and comments and layout both differ;
 * - `code` otherwise, and whenever the comparison is in doubt.
 *
 * The comparison is structural: each tree is read as a sequence of events (a node opens, a token, the node closes),
 * with comments left out. Comparing structure as well as tokens is what keeps whitespace-sensitive languages safe: a
 * Python line that changes indentation changes which `block` holds it, a YAML key that changes indentation changes
 * which mapping holds it, and a JavaScript line break after `return` changes the statements. Those trees differ, so
 * the block is code.
 *
 * Safeguards, so that "formatting only" is never wrong:
 * - Either side with a parse error (an ERROR or MISSING node anywhere) makes every block code.
 * - Strings, template strings, regexes, characters and YAML scalars are compared whole, as written: a change of
 *   whitespace inside one is a change of the program. Text inside a node that no child covers is compared too.
 * - A string or other token that spans a block's edge makes that block code.
 * - The unchanged lines between blocks must give the same events on both sides. Where they do not (a change made a
 *   comment swallow code, or regrouped the code around it), the blocks whose nodes reach the difference are code, and
 *   if no block reaches it, every block is.
 * - Comments that tools read are code: `//go:build`, `// +build`, `@ts-ignore`, `/// <reference …>`, `# type:`, and
 *   the like.
 *
 * Equivalences, chosen where the grammar makes them exact:
 * - A trailing comma before `)`, `]`, `}` or `>` in argument, parameter, array, object, import and type lists, per
 *   language. Never in Python tuples or subscripts, Rust tuples, or anything not listed.
 * - Single or double quotes around a simple string in JavaScript, TypeScript and Python (no escapes, no quotes inside,
 *   no prefix), and around a simple quoted YAML scalar.
 * - A Python docstring (a string alone as the first statement of a module, class or function) is a doc comment.
 * Redundant parentheses are not an equivalence: whether they are redundant depends on precedence.
 */
export type NoiseKind = 'formatting' | 'comments' | 'both' | 'code';

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

const COMMENTS = new Set(['comment', 'line_comment', 'block_comment', 'html_comment', 'doc_comment', 'multiline_comment']);
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
  ]),
  go: new Set(['argument_list', 'parameter_list', 'literal_value', 'type_arguments', 'type_parameter_list']),
  python: new Set(['argument_list', 'parameters', 'list', 'dictionary', 'set', 'import_from_statement']),
  java: new Set(['array_initializer', 'element_value_array_initializer']),
  csharp: new Set(['initializer_expression', 'enum_member_declaration_list', 'collection_expression', 'switch_expression']),
  json: new Set(),
  yaml: new Set(),
};
const CLOSERS = new Set([')', ']', '}', '>']);

/** Comments that tools read: changing one changes the build, the type check or the bundle. */
const DIRECTIVE =
  /^\/\/go:|^\/\/\s*\+build\b|^\/\/export\s|^\/\/line\s|@ts-(ignore|expect-error|nocheck|check)\b|^\/\/\/\s*<(reference|amd)|@jsx(Runtime|ImportSource|Frag)?\b|#__PURE__|@__PURE__|webpackChunkName|^#\s*type:|^#\s*-\*-|^#!|^#\s*(pyright|mypy):|^#\s*(noqa|pylint)\b|eslint-disable|prettier-ignore|^#\s*yaml-language-server|#cgo\b|#include\b|sourceMappingURL|@vite-ignore|webpack(Ignore|Mode|Prefetch|Preload)|@flow\b|(istanbul|c8) ignore/;

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
  comments: Comment[];
  /** Blocks a token crosses the edge of. */
  edges: Set<number>;
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

function read(tree: TreeSitter.Tree, text: string, language: SyntaxLanguage, seg: Int32Array): Reading {
  const atoms = ATOMS[language];
  const trailing = TRAILING_COMMA[language];
  const events: Event[] = [];
  const comments: Comment[] = [];
  const edges = new Set<number>();
  const last = seg.length - 1;
  const segOf = (row: number) => seg[Math.min(row, last)];
  const leafEnd = (row: number, column: number, startRow: number) => (column === 0 && row > startRow ? row - 1 : row);
  interface Frame {
    type: string;
    enter?: Event;
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
  const leaf = (type: string, value: string, a: number, b: number) => {
    if (segOf(a) !== segOf(b)) for (let s = segOf(a); s <= segOf(b); s++) if (s % 2) edges.add((s - 1) / 2);
    push(`${type}\u0000${value}`, a, b, CLOSERS.has(type));
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
  const cursor = tree.walk();
  try {
    for (;;) {
      const type = cursor.nodeType;
      const start = cursor.startIndex,
        end = cursor.endIndex;
      const { row: a } = cursor.startPosition;
      // The last row, read only for tokens: most nodes never need it.
      let last = -1;
      const rowsEnd = () => {
        if (last < 0) {
          const { row, column } = cursor.endPosition;
          last = leafEnd(row, column, a);
        }
        return last;
      };
      const parent = stack.at(-1);
      if (parent) {
        gap(parent.covered, start, a);
        parent.covered = Math.max(parent.covered, end);
      }
      let descend = false;
      const docstring =
        language === 'python' &&
        type === 'expression_statement' &&
        parent?.firstChild &&
        (parent.type === 'module' || (parent.type === 'block' && /^(function|class)_definition$/.test(parent.parentType))) &&
        isDocstring(cursor.currentNode);
      if (COMMENTS.has(type) || docstring) {
        const value = text.slice(start, end);
        if (!docstring && DIRECTIVE.test(value.trim())) leaf('\u0001directive', value.trim(), a, rowsEnd());
        else comments.push({ a, b: rowsEnd(), start, end, text: value });
      } else {
        if (parent) parent.firstChild = false;
        if (LAYOUT_EXTRAS.has(type)) {
          // Joins two lines and nothing else.
        } else if (atoms.has(type)) {
          const value = atomText(language, type, text.slice(start, end));
          // JSX text that is only layout is no child at all.
          if (value || type !== 'jsx_text') leaf(atomType(type), value, a, rowsEnd());
          if (parent) parent.afterNamed = true;
        } else if (cursor.gotoFirstChild()) {
          const enter = push(`>${type}`, a, a);
          stack.push({ type, enter, first: -1, lastRow: -1, covered: start, end, afterNamed: false, firstChild: true, parentType: parent?.type ?? '' });
          descend = true;
        } else {
          const value = text.slice(start, end);
          const named = cursor.nodeIsNamed;
          if (type === ',' && parent && trailing.has(parent.type) && parent.afterNamed) {
            // Held until the next sibling: dropped before a closing bracket.
            if (parent.comma) events.push(parent.comma);
            parent.comma = { sig: `,\u0000,`, seg: segOf(a), a, b: a };
            touch(a, a);
          } else leaf(type, /\S/.test(value) ? value : '', a, rowsEnd());
          if (parent) parent.afterNamed = named;
        }
      }
      if (descend) continue;
      // Up and along: close every frame that has no next sibling.
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        const frame = stack.pop();
        if (!frame) return { events, comments, edges };
        gap(frame.covered, frame.end, frame.lastRow < 0 ? 0 : frame.lastRow);
        if (frame.comma) events.push(frame.comma);
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
        if (!cursor.gotoParent()) return { events, comments, edges };
      }
    }
  } finally {
    cursor.delete();
  }
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
const JOIN_BLOCKS = 16;
const JOIN_GAP = 6;

export interface NoiseParser {
  parse: (text: string) => TreeSitter.Tree | null;
}

/**
 * Classifies each block of `texts` (comparisonTexts). `parse` parses with the file's grammar; trees are deleted
 * before this returns.
 */
export function classifyBlocks(
  parser: NoiseParser,
  language: SyntaxLanguage,
  texts: { before: string; after: string; blocks: readonly SideBlock[] }
): { kind: NoiseKind; reason?: string }[] {
  const { blocks } = texts;
  if (!blocks.length) return [];
  const all = (reason: string) => blocks.map(() => ({ kind: 'code' as const, reason }));
  const oldTree = parser.parse(texts.before);
  const newTree = oldTree && parser.parse(texts.after);
  try {
    if (!oldTree || !newTree) return all('parse-error');
    if (oldTree.rootNode.hasError || newTree.rootNode.hasError) return all('parse-error');
    const oldStarts = starts(texts.before),
      newStarts = starts(texts.after);
    const oldSeg = segments(oldStarts.length, blocks.map((b) => ({ row: b.oldRow, count: b.oldCount })));
    const newSeg = segments(newStarts.length, blocks.map((b) => ({ row: b.newRow, count: b.newCount })));
    const before = read(oldTree, texts.before, language, oldSeg);
    const after = read(newTree, texts.after, language, newSeg);
    const count = 2 * blocks.length + 1;
    const oldGroups = bySegment(before.events, count),
      newGroups = bySegment(after.events, count);
    const reasons: (string | undefined)[] = blocks.map(() => undefined);
    for (const index of [...before.edges, ...after.edges]) reasons[index] ??= 'edge';
    blocks.forEach((_, i) => {
      if (!same(oldGroups[2 * i + 1], newGroups[2 * i + 1])) reasons[i] ??= 'tokens';
    });
    // The unchanged lines must read the same. Where they do not, the blocks whose nodes reach the difference are code.
    for (let j = 0; j <= blocks.length; j++) {
      const o = oldGroups[2 * j],
        n = newGroups[2 * j];
      if (same(o, n)) continue;
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
        for (let m = i; m <= k; m++) reasons[m] = undefined;
        i = k;
        break;
      }
    }
    return blocks.map((block, i) => {
      const reason = reasons[i];
      if (reason) return { kind: 'code' as const, reason };
      const oldComments = commentTexts(before.comments, block.oldRow, block.oldCount);
      const newComments = commentTexts(after.comments, block.newRow, block.newCount);
      const commented = oldComments.length !== newComments.length || oldComments.some((text, k) => text !== newComments[k]);
      if (!commented) return { kind: 'formatting' as const };
      const oldLayout = layout(texts.before, oldStarts, block.oldRow, block.oldCount, before.comments);
      const newLayout = layout(texts.after, newStarts, block.newRow, block.newCount, after.comments);
      const moved = oldLayout.length !== newLayout.length || oldLayout.some((line, k) => line !== newLayout[k]);
      return { kind: moved ? ('both' as const) : ('comments' as const) };
    });
  } finally {
    oldTree?.delete();
    newTree?.delete();
  }
}

/**
 * Classifies every change block of a diff, from the new side's text and its hunks. Blocks keep the hunks' own line
 * numbers. Every block is code when the hunks do not match the text.
 */
export function classifyNoise(
  parser: NoiseParser,
  language: SyntaxLanguage,
  after: string,
  hunks: readonly HunkLike[]
): NoiseBlock[] {
  const blocks = changeBlocks(hunks);
  const texts = comparisonTexts(after, hunks);
  if (!texts || texts.blocks.length !== blocks.length) return blocks.map((block) => ({ ...block, kind: 'code', reason: 'mismatch' }));
  const kinds = classifyBlocks(parser, language, texts);
  return blocks.map((block, i) => ({ ...block, ...kinds[i] }));
}

// ── Views ───────────────────────────────────────────────────────────────────

/** What the reader chose to hide (Diff appearance). */
export interface NoiseFilter {
  whitespace: boolean;
  comments: boolean;
}
export const NO_NOISE_FILTER: NoiseFilter = { whitespace: false, comments: false };
export const noiseFilterOn = (filter: NoiseFilter) => filter.whitespace || filter.comments;

/** Whether the filter hides a block of this kind: both kinds hide `both`. */
export function hidden(kind: NoiseKind | undefined, filter: NoiseFilter): boolean {
  if (kind === 'formatting') return filter.whitespace;
  if (kind === 'comments') return filter.comments;
  if (kind === 'both') return filter.whitespace && filter.comments;
  return false;
}

/** A hidden run's label: "Formatting only", "Comments only", or "Formatting and comments". */
export function noiseLabel(kinds: Iterable<NoiseKind>): string {
  let formatting = false,
    comments = false;
  for (const kind of kinds) {
    if (kind === 'formatting' || kind === 'both') formatting = true;
    if (kind === 'comments' || kind === 'both') comments = true;
  }
  return formatting && comments ? 'Formatting and comments' : comments ? 'Comments only' : 'Formatting only';
}

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
}
export function fileNoise(blocks: readonly NoiseBlock[], filter: NoiseFilter): FileNoise {
  const result: FileNoise = { all: blocks.length > 0, kinds: [], added: 0, deleted: 0 };
  for (const block of blocks) {
    if (!hidden(block.kind, filter)) {
      result.all = false;
      continue;
    }
    result.kinds.push(block.kind);
    result.added += block.newCount;
    result.deleted += block.oldCount;
  }
  return result;
}

/** The noise in a `+N −M` stat, quietly: "90 formatting", "12 comments", "40 formatting and comments". */
export function noiseStat(noise: Pick<FileNoise, 'kinds' | 'added' | 'deleted'>): string | undefined {
  const lines = noise.added + noise.deleted;
  if (!lines) return undefined;
  const label = noiseLabel(noise.kinds);
  const word = label === 'Formatting only' ? 'formatting' : label === 'Comments only' ? 'comments' : 'formatting and comments';
  return `${lines.toLocaleString()} ${word}`;
}
