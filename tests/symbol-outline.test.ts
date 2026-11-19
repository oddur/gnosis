import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import type { GapHunk } from '../lib/diff-gaps';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import { changedSymbols, outlineSummary, spokenSymbol } from '../lib/symbol-outline';

/** The changed-symbols outline (#394) with the real tree-sitter runtime: added, modified and removed symbols. */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const parse = async (language: SyntaxLanguage, lines: string[]) => (await engine.definitions(language, `${lines.join('\n')}\n`)).definitions;
function hunksOf(before: string[], after: string[]): GapHunk[] {
  const patch = structuredPatch('a', 'b', `${before.join('\n')}\n`, `${after.join('\n')}\n`, '', '', { context: 3 });
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    rows: hunk.lines.map((line) => ({ type: line[0] as ' ' | '+' | '-', text: line.slice(1) })),
    noEofOld: false,
    noEofNew: false,
  }));
}
async function outline(language: SyntaxLanguage, before: string[], after: string[], { old = true } = {}) {
  const symbols = changedSymbols(hunksOf(before, after), {
    after: await parse(language, after),
    before: old ? await parse(language, before) : undefined,
  });
  assert.ok(symbols);
  return symbols;
}
const brief = (symbols: Awaited<ReturnType<typeof outline>>) => symbols.map((s) => [s.id, s.change, s.added, s.deleted]);

const BEFORE = [
  "import { join } from 'node:path';",
  '',
  'export function merge(a: number[], b: number[]): number[] {',
  '  const out = [...a];',
  '  out.push(...b);',
  '  return out;',
  '}',
  '',
  ...Array.from({ length: 10 }, (_, i) => `export const pad${i} = ${i};`),
  '',
  'export function rebase(list: number[]): number[] {',
  '  return list.slice(1);',
  '}',
  '',
  ...Array.from({ length: 10 }, (_, i) => `export const gap${i} = ${i};`),
  '',
  'export class Store {',
  '  private items: number[] = [];',
  '  flush(): number {',
  '    return this.items.length;',
  '  }',
  '  clear(): void {',
  '    this.items = [];',
  '  }',
  '}',
];

void test('Added, modified and removed symbols, matched across both sides by their path of names', async () => {
  const after = BEFORE
    // merge() changes a line: modified.
    .map((line) => (line === '  out.push(...b);' ? '  out.push(...b.filter(Boolean));' : line))
    // rebase() goes: removed.
    .filter((line, i, all) => !(i >= all.indexOf('export function rebase(list: number[]): number[] {') && i <= all.indexOf('export function rebase(list: number[]): number[] {') + 2))
    // Store.flush() changes, and Store gains a method: modified, and added.
    .map((line) => (line === '    return this.items.length;' ? '    return this.items.length * 1;' : line))
    .flatMap((line) => (line === '  clear(): void {' ? ['  size(): number {', '    return 0;', '  }', line] : [line]));
  const symbols = await outline('typescript', BEFORE, after);
  assert.deepEqual(brief(symbols), [
    ['function:merge', 'modified', 1, 1],
    ['function:rebase', 'removed', 0, 3],
    ['class:Store>method:flush', 'modified', 1, 1],
    ['class:Store>method:size', 'added', 3, 0],
  ]);
  const removed = symbols[1];
  assert.equal(removed.side, 'before', 'A removed symbol is in the old file');
  assert.deepEqual(removed.first, { side: 'before', line: BEFORE.indexOf('export function rebase(list: number[]): number[] {') + 1 });
  assert.deepEqual(symbols[2].parents.map((d) => d.name), ['Store'], 'A method keeps its class as its parent');
  assert.equal(outlineSummary(symbols), 'Changes 4 functions');
  assert.equal(spokenSymbol(symbols[1]), 'function rebase, removed');
});

void test('A symbol inside an added one folds into it; a whole new class lists once', async () => {
  const after = [...BEFORE, '', 'export class Queue {', '  push(n: number) {', '    return n;', '  }', '  pop() {', '    return 1;', '  }', '}'];
  const symbols = await outline('typescript', BEFORE, after);
  assert.deepEqual(brief(symbols), [['class:Queue', 'added', 8, 0]]);
  assert.equal(outlineSummary(symbols), 'Adds 1 class');
});

void test('Lines outside every definition are no symbol; the summary names kinds in the order they come', async () => {
  const after = BEFORE.map((line) =>
    line === "import { join } from 'node:path';"
      ? "import { join, resolve } from 'node:path';"
      : line === '  private items: number[] = [];'
        ? '  private items: number[] = [0];'
        : line === '  return list.slice(1);'
          ? '  return list.slice(2);'
          : line
  );
  const symbols = await outline('typescript', BEFORE, after);
  assert.deepEqual(brief(symbols), [
    ['function:rebase', 'modified', 1, 1],
    ['class:Store', 'modified', 1, 1],
  ]);
  assert.equal(outlineSummary(symbols), 'Changes 1 function and 1 class');
  assert.equal(outlineSummary([]), 'No functions or classes changed');
});

void test('Without the old file, deleted lines count towards the new symbol, and only wholly new symbols are added', async () => {
  const after = BEFORE.filter((line) => line !== '    this.items = [];');
  const withNew = [...after, '', 'export function fresh(): number {', '  return 1;', '}'];
  const symbols = await outline('typescript', BEFORE, withNew, { old: false });
  assert.deepEqual(brief(symbols), [
    ['class:Store>method:clear', 'modified', 0, 1],
    ['function:fresh', 'added', 3, 0],
  ]);
  assert.equal(symbols[0].side, 'after');
});

void test('Rust: impl blocks and their methods; overloads in C# keep apart', async () => {
  const rustBefore = ['struct Bridge;', '', 'impl Bridge {', '    fn send(&self) -> u32 {', '        1', '    }', '    fn recv(&self) -> u32 {', '        2', '    }', '}'];
  const rustAfter = rustBefore.map((line) => (line === '        2' ? '        3' : line));
  assert.deepEqual(brief(await outline('rust', rustBefore, rustAfter)), [['impl:Bridge>method:recv', 'modified', 1, 1]]);
  const cs = (body: string) => [
    'namespace Seed',
    '{',
    '    public class Navmesh',
    '    {',
    '        public int Cost(int a) { return a; }',
    `        public int Cost(int a, int b) { return ${body}; }`,
    '    }',
    '}',
  ];
  assert.deepEqual(brief(await outline('csharp', cs('a + b'), cs('a * b'))), [['module:Seed>class:Navmesh>method:Cost#2', 'modified', 1, 1]]);
});

void test('Per-symbol Viewed: kept by file revision and symbol, following the file through a head that leaves it alone', async () => {
  const { isSymbolViewed, markSymbolsViewed, registerChangeProgress, isFileViewed } = await import('../lib/file-view-progress');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/394';
  const snapshot = (head: string, changeId: string) =>
    ({ url, metadata: { baseSha: 'base', headSha: head }, files: [{ path: 'src/a.ts', changeId }] }) as unknown as Parameters<
      typeof registerChangeProgress
    >[0];
  const first = fileRevisionKey(url, 'src/a.ts', 'base', 'head1');
  // Ticked before the file's revision is registered: found under the raw key.
  await markSymbolsViewed(first, ['function:merge'], true);
  assert.equal(isSymbolViewed(first, 'function:merge'), true);
  assert.equal(isSymbolViewed(first, 'function:rebase'), false);
  assert.equal(isFileViewed(first), false, 'A symbol is not the file');
  registerChangeProgress(snapshot('head1', 'change-1'));
  await markSymbolsViewed(first, ['function:rebase'], true);
  // A new head with the same change to the file keeps its ticks; a new change to it starts afresh.
  registerChangeProgress(snapshot('head2', 'change-1'));
  const second = fileRevisionKey(url, 'src/a.ts', 'base', 'head2');
  assert.equal(isSymbolViewed(second, 'function:rebase'), true, 'The tick follows the file');
  registerChangeProgress(snapshot('head3', 'change-2'));
  const third = fileRevisionKey(url, 'src/a.ts', 'base', 'head3');
  assert.equal(isSymbolViewed(third, 'function:rebase'), false, 'A new change to the file starts afresh');
  // Unticking writes false, which wins over an older raw mark.
  await markSymbolsViewed(first, ['function:merge'], false);
  assert.equal(isSymbolViewed(first, 'function:merge'), false);
});

void test('An added file lists its symbols as added, and a deleted file its symbols as removed', async () => {
  const lines = [
    '#[derive(Debug, Clone, Serialize)]',
    'pub struct BuildingObjectPositionResponse {',
    '    pub x: f32,',
    '    pub y: f32,',
    '}',
    '',
    'impl BuildingObjectPositionResponse {',
    '    pub fn new(x: f32, y: f32) -> Self {',
    '        Self { x, y }',
    '    }',
    '}',
  ];
  const definitions = await parse('rust', lines);
  // The whole file is one hunk; an added file has no old side, so its old definitions are none.
  const added = changedSymbols(hunksOf([], lines), { after: definitions, before: [] });
  assert.ok(added);
  assert.ok(added.every((symbol) => symbol.change === 'added'), JSON.stringify(brief(added)));
  assert.deepEqual(
    added.map((symbol) => symbol.id),
    ['struct:BuildingObjectPositionResponse', 'impl:BuildingObjectPositionResponse'],
    'The method folds into its impl'
  );
  assert.equal(outlineSummary(added), 'Adds 1 struct and 1 impl block');
  const removed = changedSymbols(hunksOf(lines, []), { after: [], before: definitions });
  assert.ok(removed);
  assert.ok(removed.every((symbol) => symbol.change === 'removed' && symbol.side === 'before'));
  assert.equal(outlineSummary(removed), 'Removes 1 struct and 1 impl block');
});
