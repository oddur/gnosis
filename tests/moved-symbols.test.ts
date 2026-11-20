import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, syntaxLanguage, type SyntaxLanguage } from '../lib/syntax-scope';
import { assertPerf } from './perf-budget';
import {
  SAME_NAME,
  languageFamily,
  matchMoves,
  moveEdits,
  sketchSimilarity,
  type MoveFile,
  type MovesResult,
  type SymbolMove,
} from '../lib/moved-symbols';
import { patchHunks } from '../lib/semantic-noise';
import { wholeFileText } from '../lib/syntax-contents';
import { movesFilePlan } from '../lib/moved-symbols-plan';
import type { PrChangeFile, PrFileContents } from '../lib/pr-changes';
import {
  LARGE_MOVES,
  MOVE_FILES,
  largeMovePath,
  largeMoves,
  movedSymbolsContents,
  movedSymbolsFiles,
  movedSymbolsLargeContents,
  movedSymbolsLargeFiles,
} from './fixtures/moved-symbols';

/**
 * Moved and renamed symbols (#398), with the real tree-sitter runtime and the bundled grammars. Each case is a
 * synthetic PR: files with their old and new text. A wrong "moved from" is worse than none, so every negative case
 * expects no move at all.
 */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});

const text = (lines: readonly string[]) => (lines.length ? `${lines.join('\n')}\n` : '');
interface FixtureFile {
  path: string;
  previousPath?: string;
  before?: string[];
  after?: string[];
}
function hunksOf(before: string, after: string) {
  return structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks.map((hunk) => ({
    oldStart: hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart,
    newStart: hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart,
    rows: hunk.lines
      .filter((line) => !line.startsWith('\\'))
      .map((line) => ({ type: line[0] as ' ' | '+' | '-', text: line.slice(1) })),
  }));
}
/** A file's candidates, as the worker reads them. */
async function moveFile(file: FixtureFile): Promise<MoveFile> {
  const language = syntaxLanguage(file.path) as SyntaxLanguage;
  const before = text(file.before ?? []),
    after = text(file.after ?? []);
  const result = !file.before?.length
    ? await engine.symbols(language, { mode: 'added', text: after })
    : !file.after?.length
      ? await engine.symbols(language, { mode: 'deleted', text: before })
      : await engine.symbols(language, { mode: 'modified', text: after, hunks: hunksOf(before, after) });
  return {
    file: file.path,
    url: 'pr',
    headSha: 'head',
    path: file.path,
    previousPath: file.previousPath,
    family: languageFamily(language),
    prints: result.prints,
  };
}
async function moves(files: FixtureFile[]): Promise<MovesResult> {
  return matchMoves(await Promise.all(files.map(moveFile)));
}
/** A move's changed lines on each side (`moveEdits`). */
const edits = (move: SymbolMove) => {
  const found = moveEdits(move);
  return found && { before: found.before, after: found.after };
};
/** A move in words: `a.ts:3 save -> b.ts:7 save`. */
const spoken = (move: SymbolMove) =>
  `${move.from.path}:${move.from.start} ${move.from.name} -> ${move.to.path}:${move.to.start} ${move.to.name}`;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A TypeScript function of `steps + 3` lines whose statements depend on `seed`, so different seeds differ. */
const tsFunction = (name: string, seed: string, steps = 8, indent = '') => [
  `${indent}export function ${name}(input: number[], limit: number): number {`,
  `${indent}  let total = 0;`,
  ...Array.from(
    { length: steps },
    (_, i) => `${indent}  total += input[${i}] * ${seed}${i} - Math.min(limit, input.length + ${i});`
  ),
  `${indent}  return total;`,
  `${indent}}`,
];
const filler = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `export const ${prefix}${i} = ${i};`);

const csMethod = (name: string, type: string, steps = 6, extra = '') => [
  `        public int ${name}(${type} value, int limit)`,
  '        {',
  '            var total = 0;',
  ...Array.from({ length: steps }, (_, i) => `            total += Compute(value, ${i}) * (limit - ${i});${extra}`),
  '            return total;',
  '        }',
];
const csClass = (name: string, body: string[]) => [
  'namespace Gnosis.Moves',
  '{',
  `    public class ${name}`,
  '    {',
  ...body,
  '    }',
  '}',
];

// ── True moves ──────────────────────────────────────────────────────────────

void describe('moved symbols: true moves', () => {
  void test('a function moved to another file is moved from there, unchanged', async () => {
    const result = await moves([
      {
        path: 'src/a.ts',
        before: [...filler('a', 4), '', ...tsFunction('accumulate', 'x'), '', ...filler('b', 4)],
        after: [...filler('a', 4), '', ...filler('b', 4)],
      },
      { path: 'src/b.ts', before: filler('c', 6), after: [...filler('c', 6), '', ...tsFunction('accumulate', 'x')] },
    ]);
    assert.deepEqual(result.moves.map(spoken), ['src/a.ts:6 accumulate -> src/b.ts:8 accumulate']);
    const [move] = result.moves;
    assert.equal(move.exact, true);
    assert.equal(move.renamed, false);
    assert.deepEqual(edits(move), { before: [], after: [] });
  });

  void test('a function moved within its file is moved from its old line', async () => {
    const one = tsFunction('first', 'p'),
      two = tsFunction('second', 'q');
    const result = await moves([
      {
        path: 'src/order.ts',
        before: [...one, '', ...filler('m', 10), '', ...two],
        after: [...filler('m', 10), '', ...two, '', ...one],
      },
    ]);
    assert.deepEqual(result.moves.map(spoken), ['src/order.ts:1 first -> src/order.ts:25 first']);
  });

  void test('a renamed function with the same body is renamed from its old name, recursive calls included', async () => {
    const body = (name: string) => [
      `export function ${name}(node: Tree | undefined, depth: number): number {`,
      '  if (!node) return depth;',
      `  const left = ${name}(node.left, depth + 1);`,
      `  const right = ${name}(node.right, depth + 1);`,
      '  return Math.max(left, right, node.weight * depth);',
      '}',
    ];
    const result = await moves([
      { path: 'src/tree.ts', before: [...filler('t', 3), '', ...body('depthOf')], after: [...filler('t', 3)] },
      { path: 'src/walk.ts', before: filler('w', 3), after: [...filler('w', 3), '', ...body('treeDepth')] },
    ]);
    assert.deepEqual(result.moves.map(spoken), ['src/tree.ts:5 depthOf -> src/walk.ts:5 treeDepth']);
    assert.equal(result.moves[0].renamed, true);
    assert.equal(result.moves[0].exact, true);
    // The rename is a real edit of its signature line; the recursive calls are too, and nothing else.
    assert.deepEqual(edits(result.moves[0]), { before: [5, 7, 8], after: [5, 7, 8] });
  });

  void test('a move with a small edit is moved, and only the edited line is an edit', async () => {
    const before = tsFunction('accumulate', 'x', 12);
    const after = [...before];
    after[6] = after[6].replace('input[4] * x4', 'input[4] * x4 * 2');
    const result = await moves([
      { path: 'src/a.ts', before: [...filler('a', 3), ...before], after: filler('a', 3) },
      { path: 'src/b.ts', before: filler('b', 3), after: [...filler('b', 3), ...after] },
    ]);
    assert.equal(result.moves.length, 1, JSON.stringify(result.moves.map(spoken)));
    const [move] = result.moves;
    assert.equal(move.exact, false);
    assert.ok(move.similarity >= SAME_NAME, `similarity ${move.similarity}`);
    assert.deepEqual(edits(move), { before: [10], after: [10] });
  });

  void test('a moved class is one move, not one per method', async () => {
    const klass = (name: string) => [
      `export class ${name} {`,
      ...tsFunction('save', 's', 6, '  ').map((line) => line.replace('export function ', '')),
      '',
      ...tsFunction('load', 'l', 6, '  ').map((line) => line.replace('export function ', '')),
      '}',
    ];
    const result = await moves([
      { path: 'src/store.ts', before: [...filler('s', 3), '', ...klass('Store')], after: filler('s', 3) },
      { path: 'src/store/index.ts', before: undefined, after: klass('Store') },
    ]);
    assert.deepEqual(result.moves.map(spoken), ['src/store.ts:5 Store -> src/store/index.ts:1 Store']);
  });

  void test('a function moved into a class becomes a method there', async () => {
    const fn = tsFunction('flush', 'f', 8);
    const method = tsFunction('flush', 'f', 8, '  ').map((line) => line.replace('export function ', ''));
    const result = await moves([
      { path: 'src/flush.ts', before: [...filler('f', 2), ...fn], after: filler('f', 2) },
      {
        path: 'src/queue.ts',
        before: ['export class Queue {', '  size = 0;', '}'],
        after: ['export class Queue {', '  size = 0;', ...method, '}'],
      },
    ]);
    // `export function` is gone from the method: not exact, but the same name and body.
    assert.deepEqual(result.moves.map(spoken), ['src/flush.ts:3 flush -> src/queue.ts:3 flush']);
    assert.equal(result.moves[0].exact, false);
  });

  void test('a renamed file names the symbol at its old path', async () => {
    const result = await moves([
      {
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        before: [...filler('o', 4), ...tsFunction('parse', 'p')],
        after: filler('o', 4),
      },
      { path: 'src/parse.ts', after: tsFunction('parse', 'p') },
    ]);
    assert.equal(result.moves.length, 1);
    assert.equal(result.moves[0].from.path, 'src/old-name.ts');
    assert.equal(result.moves[0].from.diffPath, 'src/new-name.ts');
  });

  void test('C#: a method moved to another class, and one renamed, match', async () => {
    const result = await moves([
      {
        path: 'Runtime/Bridge.cs',
        before: csClass('Bridge', [...csMethod('Flush', 'int'), '', ...csMethod('Drain', 'string', 7)]),
        after: csClass('Bridge', ['        public int Size;']),
      },
      {
        path: 'Runtime/Queue.cs',
        before: csClass('Queue', ['        public int Count;']),
        after: csClass('Queue', [
          '        public int Count;',
          '',
          ...csMethod('Flush', 'int'),
          '',
          ...csMethod('DrainAll', 'string', 7),
        ]),
      },
    ]);
    assert.deepEqual(result.moves.map(spoken).sort(), [
      'Runtime/Bridge.cs:17 Drain -> Runtime/Queue.cs:19 DrainAll',
      'Runtime/Bridge.cs:5 Flush -> Runtime/Queue.cs:7 Flush',
    ]);
  });

  void test('Python: a function moved between modules matches', async () => {
    const def = (name: string) => [
      `def ${name}(rows, limit):`,
      '    total = 0',
      ...Array.from({ length: 6 }, (_, i) => `    total += rows[${i}] * (limit - ${i}) + len(rows)`),
      '    return total',
    ];
    const result = await moves([
      { path: 'pkg/a.py', before: ['import os', '', ...def('score'), '', 'X = 1'], after: ['import os', '', 'X = 1'] },
      { path: 'pkg/b.py', before: ['import sys'], after: ['import sys', '', ...def('score')] },
    ]);
    assert.deepEqual(result.moves.map(spoken), ['pkg/a.py:3 score -> pkg/b.py:3 score']);
  });
});

// ── Negatives ───────────────────────────────────────────────────────────────

void describe('moved symbols: never a wrong move', () => {
  void test('similar but different functions do not match', async () => {
    // The same shape, other operands and names in every line: a new function, not the deleted one.
    const result = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...tsFunction('sumPrices', 'price')], after: filler('a', 2) },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...tsFunction('sumWeights', 'weight')] },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('a rewritten function under the same name, in place, is not a move', async () => {
    const before = tsFunction('accumulate', 'x', 8);
    const after = before.map((line) => line.replace(/input\[(\d)\]/, 'values.at($1) ?? 0'));
    const result = await moves([
      {
        path: 'src/a.ts',
        before: [...filler('a', 4), ...before, ...filler('b', 4)],
        after: [...filler('a', 4), ...after, ...filler('b', 4)],
      },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('a function reindented in place (wrapped in a block) is not a move', async () => {
    const fn = tsFunction('accumulate', 'x', 8);
    const result = await moves([
      {
        path: 'src/a.ts',
        before: [...filler('a', 4), ...fn, ...filler('b', 4)],
        after: [
          ...filler('a', 4),
          'export namespace Totals {',
          ...fn.map((line) => `  ${line}`),
          '}',
          ...filler('b', 4),
        ],
      },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('duplicated boilerplate is a tie: two removed copies, one added, match nothing', async () => {
    const dispose = (owner: string) => [
      `export class ${owner} {`,
      '  dispose(): void {',
      '    for (const listener of this.listeners) listener.close();',
      '    this.listeners.length = 0;',
      '    this.timers.forEach((timer) => clearTimeout(timer));',
      '    this.timers.clear();',
      '    this.closed = true;',
      '  }',
      '}',
    ];
    const method = dispose('X').slice(1, -1);
    const result = await moves([
      {
        path: 'src/a.ts',
        before: [...dispose('A'), ...filler('a', 4)],
        after: ['export class A {', '}', ...filler('a', 4)],
      },
      {
        path: 'src/b.ts',
        before: [...dispose('B'), ...filler('b', 4)],
        after: ['export class B {', '}', ...filler('b', 4)],
      },
      { path: 'src/base.ts', before: ['export class Base {', '}'], after: ['export class Base {', ...method, '}'] },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('a copy that keeps its original is not a move', async () => {
    const fn = tsFunction('accumulate', 'x', 8);
    const result = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...fn], after: [...filler('a', 2), ...fn, '// kept'] },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...fn] },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('overloads: two near-equal rivals for one edited copy match nothing', async () => {
    // Save(int) and Save(long) differ only in a parameter type; the new copy, edited, is as near to both.
    const result = await moves([
      {
        path: 'Runtime/Store.cs',
        before: csClass('Store', [...csMethod('Save', 'int', 8), '', ...csMethod('Save', 'long', 8)]),
        after: csClass('Store', ['        public int Size;']),
      },
      {
        path: 'Runtime/Writer.cs',
        before: csClass('Writer', ['        public int Count;']),
        after: csClass('Writer', ['        public int Count;', '', ...csMethod('Save', 'short', 8, ' Log(total);')]),
      },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('overloads that move together each match their own copy', async () => {
    const result = await moves([
      {
        path: 'Runtime/Store.cs',
        before: csClass('Store', [...csMethod('Save', 'int', 8), '', ...csMethod('Save', 'long', 8)]),
        after: csClass('Store', ['        public int Size;']),
      },
      {
        path: 'Runtime/Writer.cs',
        before: csClass('Writer', ['        public int Count;']),
        after: csClass('Writer', [
          '        public int Count;',
          '',
          ...csMethod('Save', 'long', 8),
          '',
          ...csMethod('Save', 'int', 8),
        ]),
      },
    ]);
    assert.deepEqual(result.moves.map(spoken).sort(), [
      'Runtime/Store.cs:19 Save -> Runtime/Writer.cs:7 Save',
      'Runtime/Store.cs:5 Save -> Runtime/Writer.cs:21 Save',
    ]);
  });

  void test('tiny functions and getters never match, even when identical', async () => {
    const tiny = ['export function id(value: number): number {', '  return value;', '}'];
    const getter = ['export class Box {', '  get size(): number { return this.items.length; }', '}'];
    const result = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...tiny, ...getter], after: filler('a', 2) },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...tiny, ...getter] },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('a renamed function with edits needs the stricter threshold', async () => {
    const before = tsFunction('accumulate', 'x', 10);
    const after = tsFunction('sumAll', 'x', 10);
    // Two of ten statements rewritten (similarity about 0.75): close enough under the same name, not under a new one.
    for (const i of [3, 6]) after[i] = `  total -= limit / (${i} + input.length);`;
    const renamed = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...before], after: filler('a', 2) },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...after] },
    ]);
    const sameName = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...before], after: filler('a', 2) },
      {
        path: 'src/b.ts',
        before: filler('b', 2),
        after: [...filler('b', 2), ...after.map((line) => line.replace('sumAll', 'accumulate'))],
      },
    ]);
    assert.deepEqual(renamed.moves.map(spoken), []);
    assert.deepEqual(sameName.moves.map(spoken), ['src/a.ts:3 accumulate -> src/b.ts:3 accumulate']);
  });

  void test('another language is never a match', async () => {
    const result = await moves([
      {
        path: 'pkg/a.py',
        before: [
          'def score(rows, limit):',
          ...Array.from({ length: 6 }, (_, i) => `    total = rows[${i}] * (limit - ${i})`),
          '    return total',
        ],
        after: [],
      },
      { path: 'src/b.ts', after: tsFunction('score', 'x') },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });
});

void describe('moved symbols: review regressions', () => {
  const rewrite = (lines: string[], index: number) =>
    lines.map((line, i) => (i === index ? `  total -= limit / (${index} + input.length);` : line));
  void test('a tie’s copies still count as rivals: an edited copy as near to them as to its original matches nothing', async () => {
    const original = tsFunction('accumulate', 'x', 10);
    const edited = rewrite(original, 3);
    // A near copy of the original, removed twice: a tie, which never matches, but a rival all the same.
    const near = rewrite(original, 6);
    const control = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...original], after: filler('a', 2) },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...edited] },
    ]);
    assert.equal(control.moves.length, 1, 'Without the rivals it is a move');
    const result = await moves([
      { path: 'src/a.ts', before: [...filler('a', 2), ...original], after: filler('a', 2) },
      { path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...edited] },
      { path: 'src/c.ts', before: [...filler('c', 2), ...near], after: filler('c', 2) },
      { path: 'src/d.ts', before: [...filler('d', 2), ...near], after: filler('d', 2) },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('small bodies count as rivals too', async () => {
    // A rival under the similarity size floor still blocks: the floor only decides what may match.
    const original = tsFunction('accumulate', 'x', 10);
    const files = await Promise.all([
      moveFile({ path: 'src/a.ts', before: [...filler('a', 2), ...original], after: filler('a', 2) }),
      moveFile({ path: 'src/b.ts', before: filler('b', 2), after: [...filler('b', 2), ...rewrite(original, 3)] }),
      moveFile({ path: 'src/c.ts', before: [...filler('c', 2), ...rewrite(original, 6)], after: filler('c', 2) }),
    ]);
    assert.equal(matchMoves(files).moves.length, 0, 'Two near rivals: no match');
    const rival = files[2].prints.before[0];
    // Token counts as if the bodies were small: the pair just over the floor, the rival just under it.
    files[0].prints.before[0] = { ...files[0].prints.before[0], tokens: 70 };
    files[1].prints.after[0] = { ...files[1].prints.after[0], tokens: 70 };
    files[2].prints.before[0] = { ...rival, tokens: 59 };
    assert.equal(matchMoves(files).moves.length, 0, 'A rival below the size floor still blocks the match');
  });

  void test('an edit in place parted from its removed block by blank lines is not a move', async () => {
    // The old function is removed, two blank lines stay as context, and the edited, re-indented copy follows them.
    const fn = (indent: string, op: string) =>
      tsFunction('foo', 'x', 10)
        .map((line, i) => (i === 6 ? line.replace('- Math', `${op} Math`) : line))
        .map((line) => indent + line);
    const result = await moves([
      {
        path: 'src/a.ts',
        before: [...filler('a', 7), ...fn('', '-'), '', '', ...filler('b', 3)],
        after: [...filler('a', 7), '', '', ...fn('    ', '+'), ...filler('b', 3)],
      },
    ]);
    assert.deepEqual(result.moves.map(spoken), []);
  });

  void test('a side with more candidates than it keeps is reported, and refuses the match', async () => {
    const many = Array.from({ length: 401 }, (_, i) => tsFunction(`f${i}`, `s${i}x`, 2)).flat();
    const file = await moveFile({ path: 'src/many.ts', after: many });
    assert.equal(file.prints.capped, true);
    const source = await moveFile({
      path: 'src/a.ts',
      before: [...filler('a', 2), ...tsFunction('f0', 's0x', 2)],
      after: filler('a', 2),
    });
    assert.equal(matchMoves([source, file]).moves.length, 0);
    assert.equal(matchMoves([source, file]).capped, true);
  });
});

void describe('moved symbols: limits', () => {
  void test('past the pair limit the similarity pass is dropped whole, exact matches stay', async () => {
    const files = await Promise.all([
      moveFile({ path: 'src/a.ts', before: [...tsFunction('keep', 'k'), ...tsFunction('edited', 'e', 10)], after: [] }),
      moveFile({
        path: 'src/b.ts',
        after: [
          ...tsFunction('keep', 'k'),
          ...tsFunction('edited', 'e', 10).map((l, i) => (i === 4 ? l.replace('Math.min', 'Math.max') : l)),
        ],
      }),
    ]);
    assert.equal(matchMoves(files).moves.length, 2);
    const capped = matchMoves(files, { pairs: 0 });
    assert.equal(capped.capped, true);
    assert.deepEqual(capped.moves.map(spoken), ['src/a.ts:1 keep -> src/b.ts:1 keep']);
  });

  void test('sketch similarity is exact for small sets and symmetric', () => {
    const a = Uint32Array.from([1, 2, 3, 4]),
      b = Uint32Array.from([2, 3, 4, 5]);
    assert.equal(sketchSimilarity(a, b), 3 / 5);
    assert.equal(sketchSimilarity(b, a), 3 / 5);
  });
});

// ── The browser fixtures, end to end through the patch, and the cost on a large PR ──────────────────────────────

/** A PR's files as the store reads them: from the patch for added and deleted files, else the new side and hunks. */
async function prMoves(files: PrChangeFile[], contents: (path: string) => PrFileContents | undefined) {
  const started = performance.now();
  let fingerprintMs = 0,
    read = 0,
    modified = 0,
    comparedMs = 0;
  const moveFiles: MoveFile[] = [];
  const parsesBefore = engine.parses();
  // With the noise comparison on (the default), a modified file is fingerprinted from the comparison's two trees.
  let combinedParses = 0;
  for (const file of files) {
    const plan = movesFilePlan({}, file, () => true);
    if (!plan) continue;
    read++;
    const patch = file.patch ?? '';
    const after = contents(file.path)?.after;
    const input =
      file.status === 'added'
        ? { mode: 'added' as const, text: wholeFileText(patch, 'after') ?? '' }
        : file.status === 'deleted'
          ? { mode: 'deleted' as const, text: wholeFileText(patch, 'before') ?? '' }
          : {
              mode: 'modified' as const,
              text: after?.kind === 'text' ? after.content : '',
              hunks: patchHunks(patch) ?? [],
            };
    const result = await engine.symbols(plan.language, input);
    fingerprintMs += result.ms;
    if (input.mode === 'modified') {
      modified++;
      const at = engine.parses();
      const compared = await engine.noise(plan.language, input.text, input.hunks, true);
      combinedParses += engine.parses() - at;
      comparedMs += compared.classify;
      assert.equal(
        compared.symbols?.after.length,
        result.prints.after.length,
        'The comparison finds the same candidates'
      );
    }
    moveFiles.push({
      file: file.path,
      url: 'pr',
      headSha: 'head',
      path: file.path,
      family: languageFamily(plan.language),
      prints: result.prints,
    });
  }
  const matched = matchMoves(moveFiles);
  const symbolsParses = engine.parses() - parsesBefore - combinedParses;
  return {
    ...matched,
    fingerprintMs,
    comparedMs,
    read,
    totalMs: performance.now() - started,
    // Per modified file, in the app with the comparison on: before, its own two-side parse on top of the comparison's
    // two; now none.
    parses: { symbolsJobs: symbolsParses, comparisonWithSymbols: combinedParses, modified, savedPerModifiedFile: 2 },
  };
}

void describe('moved symbols: the browser fixtures', () => {
  void test('?moved-symbols: three moves, one rename, one C# rename, and the tie shows nothing', async () => {
    const result = await prMoves(movedSymbolsFiles, movedSymbolsContents);
    assert.deepEqual(result.moves.map(spoken).sort(), [
      `${MOVE_FILES.bridge}:7 Drain -> ${MOVE_FILES.pump}:5 DrainAll`,
      `${MOVE_FILES.store}:3 formatEntry -> ${MOVE_FILES.store}:49 formatEntry`,
      `${MOVE_FILES.store}:35 flushQueue -> ${MOVE_FILES.queue}:16 flushQueue`,
      `${MOVE_FILES.store}:62 parseHeader -> ${MOVE_FILES.headers}:3 readHeader`,
    ]);
    const flush = result.moves.find((move) => move.to.name === 'flushQueue');
    assert.deepEqual(flush && edits(flush), { before: [40], after: [21] });
  });

  void test('?moved-symbols-large: every move is found and nothing else, within the cost budget', async () => {
    const files = movedSymbolsLargeFiles();
    const result = await prMoves(files, movedSymbolsLargeContents);
    const expected = largeMoves()
      .map((move) => `${largeMovePath(move.from)} -> ${largeMovePath(move.to)}`)
      .sort();
    const found = result.moves.map((move) => `${move.from.path} -> ${move.to.path}`).sort();
    const truePositives = found.filter((move) => expected.includes(move)).length;
    const precision = found.length ? truePositives / found.length : 1;
    const recall = truePositives / expected.length;
    console.log(
      'MOVED SYMBOLS COST',
      JSON.stringify({
        files: files.length,
        fingerprinted: result.read,
        candidates: result.candidates,
        compared: result.compared,
        moves: found.length,
        precision,
        recall,
        fingerprintMs: Math.round(result.fingerprintMs),
        comparisonWithSymbolsMs: Math.round(result.comparedMs),
        parses: result.parses,
        matchMs: Math.round(result.ms * 10) / 10,
        totalMs: Math.round(result.totalMs),
      })
    );
    assert.equal(expected.length, LARGE_MOVES);
    assert.equal(precision, 1, `No wrong move: ${found.filter((move) => !expected.includes(move)).join(', ')}`);
    assert.equal(recall, 1, `Every move: missing ${expected.filter((move) => !found.includes(move)).join(', ')}`);
    assert.equal(result.capped, false);
    // Bounded: the match is a small part of the work, and well under a frame's budget per file.
    assertPerf('moved symbols: matching the large PR', result.ms, 250);
  });
});
