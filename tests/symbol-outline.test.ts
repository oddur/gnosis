import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import type { GapHunk } from '../lib/diff-gaps';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import { bodyId, changedSymbolLines, changedSymbols, outlineSummary, reviewItems, spokenSymbol, trivialLine, trivialSymbols } from '../lib/symbol-outline';

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

void test("Each symbol's changed lines, by side, for the scrolled-through ticks; a folded symbol's go to its parent", async () => {
  const after = BEFORE
    .map((line) => (line === '  out.push(...b);' ? '  out.push(...b.filter(Boolean));' : line))
    .concat(['', 'export class Queue {', '  push(n: number) {', '    return n;', '  }', '}']);
  const hunks = hunksOf(BEFORE, after);
  const definitions = { after: await parse('typescript', after), before: await parse('typescript', BEFORE) };
  const lines = changedSymbolLines(hunks, definitions);
  assert.ok(lines);
  const push = BEFORE.indexOf('  out.push(...b);') + 1;
  const queue = after.indexOf('export class Queue {') + 1;
  // Which lines, in any order.
  assert.deepEqual(Object.fromEntries([...lines].map(([id, list]) => [id, [...list].sort()])), {
    'function:merge': [`a${push}`, `b${push}`],
    // The added method folds into the added class, with its lines.
    'class:Queue': [queue, queue + 1, queue + 2, queue + 3, queue + 4].map((line) => `a${line}`),
  });
  // The same symbols as the outline lists, in the same order.
  assert.deepEqual([...lines.keys()], changedSymbols(hunks, definitions)?.map((symbol) => symbol.id));
  // Lines the outline leaves out are left out here too.
  assert.deepEqual([...(changedSymbolLines(hunks, definitions, (side) => side === 'before')?.get('function:merge') ?? [])], [`a${push}`]);
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

void test('a class whose own changes are a blank line or a brace is a roll-up; a changed field makes it a Body item', async () => {
  for (const line of ['', '  ', '}', '});', '},', '{', ')', ']']) assert.equal(trivialLine(line), true, JSON.stringify(line));
  for (const line of ['  private items = 1;', '@Injectable()', '} else {', 'x']) assert.equal(trivialLine(line), false, line);
  const methods = (lines: string[]) =>
    lines.map((line) => (line === '    return this.items.length;' ? '    return this.items.length * 2;' : line === '    this.items = [];' ? '    this.items = [0];' : line));
  // Both methods change, and a blank line comes in between them: the class's own change is that blank line.
  const blank = methods(BEFORE).flatMap((line) => (line === '  clear(): void {' ? ['', line] : [line]));
  const hunks = hunksOf(BEFORE, blank);
  const definitions = { after: await parse('typescript', blank), before: await parse('typescript', BEFORE) };
  const all = changedSymbols(hunks, definitions) ?? [];
  assert.ok(all.some((symbol) => symbol.id === 'class:Store'), 'The blank line makes the class a changed symbol');
  const trivial = trivialSymbols(hunks, definitions);
  assert.ok(trivial.has('class:Store'));
  assert.deepEqual(reviewItems(all, trivial).map((symbol) => symbol.id), ['class:Store>method:flush', 'class:Store>method:clear']);
  // A changed field: the class's own lines are its Body, an item beside the methods.
  const field = methods(BEFORE).map((line) => (line === '  private items: number[] = [];' ? '  private items: number[] = [1];' : line));
  const fieldHunks = hunksOf(BEFORE, field);
  const fieldDefinitions = { after: await parse('typescript', field), before: await parse('typescript', BEFORE) };
  const fieldAll = changedSymbols(fieldHunks, fieldDefinitions) ?? [];
  assert.equal(trivialSymbols(fieldHunks, fieldDefinitions).has('class:Store'), false);
  const items = reviewItems(fieldAll, trivialSymbols(fieldHunks, fieldDefinitions));
  assert.deepEqual(new Set(items.map((symbol) => symbol.id)), new Set([bodyId('class:Store'), 'class:Store>method:flush', 'class:Store>method:clear']));
  const body = items.find((symbol) => symbol.id === bodyId('class:Store'));
  assert.ok(body);
  assert.equal(body.definition.crumb, 'Store · body');
  assert.equal(body.first.line, field.indexOf('  private items: number[] = [1];') + 1, 'The Body goes to the first of its own lines');
  // Lines the reader hides as quiet count as trivial too.
  const quietField = trivialSymbols(fieldHunks, fieldDefinitions, undefined, (_side, line) => line === field.indexOf('  private items: number[] = [1];') + 1);
  assert.equal(quietField.has('class:Store'), true);
  // An added class folds its methods: one item, as before.
  const added = [...BEFORE, '', 'export class Queue {', '  push(n: number) {', '    return n;', '  }', '}'];
  const addedHunks = hunksOf(BEFORE, added);
  const addedDefinitions = { after: await parse('typescript', added), before: await parse('typescript', BEFORE) };
  assert.deepEqual(reviewItems(changedSymbols(addedHunks, addedDefinitions) ?? [], trivialSymbols(addedHunks, addedDefinitions)).map((symbol) => symbol.id), ['class:Queue']);
});

// With a backtracking pattern the first call would not return in any useful time: the test would hang, not fail.
void test('a trivial-line check is linear: a long run of brackets with text after it is not trivial', () => {
  assert.equal(trivialLine(`${'}'.repeat(200)} as const`), false);
  assert.equal(trivialLine(`${'})'.repeat(200)};`), true);
});

void test('A nested function in a method of an added class folds into the class, with every line', async () => {
  const after = [...BEFORE, '', 'export class Queue {', '  push(n: number) {', '    function inner() {', '      return n;', '    }', '    return inner();', '  }', '}'];
  const hunks = hunksOf(BEFORE, after);
  const definitions = { after: await parse('typescript', after), before: await parse('typescript', BEFORE) };
  const symbols = changedSymbols(hunks, definitions);
  assert.deepEqual(brief(symbols ?? []), [['class:Queue', 'added', 8, 0]], 'The class counts its method and the function in it');
  assert.equal(changedSymbolLines(hunks, definitions)?.get('class:Queue')?.length, 8, 'and has all their lines');
});

void test('The tree and the outline list the same items when a hidden comment sits in an added class', async () => {
  const { symbolTree } = await import('../lib/tree-symbols');
  const { countedIds } = await import('../lib/tree-symbol-review');
  const { visibleSymbols } = await import('../lib/symbol-outline');
  const after = [...BEFORE, '', 'export class Queue {', '  // a note the reader hides', '  push(n: number) {', '    return n;', '  }', '}'];
  const hunks = hunksOf(BEFORE, after);
  // Without the old side, "added" needs every line of the class added: leaving the comment out must not unfold it.
  const definitions = { after: await parse('typescript', after) };
  const comment = after.indexOf('  // a note the reader hides') + 1;
  const skip = (side: 'before' | 'after', line: number) => side === 'after' && line === comment;
  const all = changedSymbols(hunks, definitions) ?? [];
  const shown = changedSymbols(hunks, definitions, skip) ?? [];
  assert.notDeepEqual(brief(all), brief(shown), 'The case: leaving the comment out changes the folding');
  const trivial = trivialSymbols(hunks, definitions, undefined, skip);
  const tree = countedIds({ state: 'ready', nodes: symbolTree(all, shown, [], undefined, trivial) });
  const visible = visibleSymbols(all, shown);
  const outline = reviewItems(all.filter((symbol) => visible.has(symbol.id)), trivial).map((symbol) => symbol.id);
  assert.deepEqual(outline, tree);
  assert.deepEqual(outline, ['class:Queue']);
});
