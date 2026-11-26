import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { structuredPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import type { GapHunk } from '../lib/diff-gaps';
import { createSyntaxEngine, type SyntaxDefinition, type SyntaxLanguage } from '../lib/syntax-scope';
import { TOP_LEVEL_ID, changedSymbols, outlineSummary, type ChangedSymbol } from '../lib/symbol-outline';
import {
  changedIds,
  matchingSymbols,
  moveWords,
  pruneSymbols,
  readingSymbol,
  rowDestination,
  symbolTree,
  topLevelChanges,
  topLevelSymbol,
  type TreeSymbolNode,
} from '../lib/tree-symbols';
import { FILE_MARK, NAME_SLASH, ancestorPaths, rowCodes, symbolRowKey, symbolTreePaths, type FileSymbols } from '../lib/tree-symbol-paths';

/** The Changes tree's symbol rows (lib/tree-symbols.ts) from the outline's changedSymbols(), with real tree-sitter. */
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

const BEFORE = [
  "import { a } from 'a';",
  '',
  'export class Store {',
  '  items = 1;',
  '  flush() {',
  '    return 1;',
  '  }',
  '  keep() {',
  '    return 2;',
  '  }',
  '}',
  '',
  ...Array.from({ length: 8 }, (_, i) => `export const pad${i} = ${i};`),
  '',
  'export function gone() {',
  '  return 0;',
  '}',
];
const AFTER = [
  "import { a } from 'a';",
  "import {",
  '  b,',
  "} from 'b';",
  '',
  'export class Store {',
  '  items = 1;',
  '  flush() {',
  '    return 2;',
  '  }',
  '  keep() {',
  '    return 2;',
  '  }',
  '}',
  '',
  ...Array.from({ length: 8 }, (_, i) => `export const pad${i} = ${i};`),
  '',
  'export function added() {',
  '  if (Math.random()) return 3;',
  '  return 4;',
  '}',
];

async function file() {
  const hunks = hunksOf(BEFORE, AFTER);
  const definitions = { after: await parse('typescript', AFTER), before: await parse('typescript', BEFORE) };
  const all = changedSymbols(hunks, definitions);
  assert.ok(all);
  return { hunks, definitions, all };
}
const brief = (nodes: readonly TreeSymbolNode[]): unknown[] =>
  nodes.map((node) => [node.definition.name, node.change, node.added, node.deleted, ...(node.children.length ? [brief(node.children)] : [])]);

void test('a method changed in an unchanged class nests under a context row for the class', async () => {
  const { all } = await file();
  const nodes = symbolTree(all);
  assert.deepEqual(brief(nodes), [
    ['Store', 'context', 0, 0, [['flush', 'modified', 1, 1]]],
    // The diff pairs the two functions' closing braces: those lines are unchanged.
    ['gone', 'removed', 0, 2],
    ['added', 'added', 3, 0],
  ]);
  // The context row carries the class's definition, and Viewed on it marks the symbols under it.
  assert.equal(nodes[0].definition.kind, 'class');
  assert.equal(nodes[0].symbol, undefined);
  assert.deepEqual(changedIds(nodes[0]), [nodes[0].children[0].id]);
  assert.equal(nodes[0].children[0].id, all.find((symbol) => symbol.definition.name === 'flush')?.id);
});

void test('changes outside every definition make the first row, and the rows add up to the file', async () => {
  const { hunks, definitions, all } = await file();
  const top = topLevelChanges(hunks, definitions);
  // A multi-line import reads as imports.
  assert.ok(top);
  assert.deepEqual({ added: top.added, deleted: top.deleted, imports: top.imports }, { added: 3, deleted: 0, imports: true });
  assert.equal(top.lines.length, 3, 'Each changed top-level line is named, for the scrolled-through ticks');
  assert.deepEqual(top.first, { side: 'after', line: Number(top.lines[0].slice(1)) });
  const sum = (nodes: readonly TreeSymbolNode[]): [number, number] =>
    nodes.reduce<[number, number]>((total, node) => {
      const [a, d] = sum(node.children);
      return [total[0] + node.added + a, total[1] + node.deleted + d];
    }, [0, 0]);
  const [added, deleted] = sum(symbolTree(all));
  const changed = hunks.flatMap((hunk) => hunk.rows);
  assert.equal(added + top.added, changed.filter((row) => row.type === '+').length);
  assert.equal(deleted + top.deleted, changed.filter((row) => row.type === '-').length);
  // Top-level code that is not an import is "Top level".
  const code = topLevelChanges(hunksOf(['const a = 1;'], ['const a = 2;']), { after: [], before: [] });
  assert.deepEqual(code, { added: 1, deleted: 1, imports: false, lines: ['b1', 'a1'], first: { side: 'before', line: 1 } });
  assert.equal(topLevelChanges(hunksOf(['x'], ['x']), { after: [] }), undefined);
  // Quiet lines are left out as the outline leaves them out; all quiet is none.
  const quiet = (side: 'before' | 'after') => side === 'before';
  assert.deepEqual(topLevelChanges(hunksOf(['const a = 1;'], ['const a = 2;']), { after: [], before: [] }, quiet), {
    added: 1,
    deleted: 0,
    imports: false,
    lines: ['a1'],
    first: { side: 'after', line: 1 },
  });
  assert.equal(topLevelChanges(hunksOf(['const a = 1;'], ['const a = 2;']), { after: [], before: [] }, () => true), undefined);
  // As an outline entry: ticked under its own id, going to its first changed line, and named by no summary.
  const entry = topLevelSymbol(code);
  assert.deepEqual([entry.id, entry.change, entry.side, entry.definition.name, entry.definition.start], [TOP_LEVEL_ID, 'modified', 'before', 'Top level', 1]);
  assert.equal(outlineSummary([entry]), 'No functions or classes changed');
  assert.equal(topLevelSymbol({ ...code, deleted: 0 }).change, 'added');
  // Its tree row goes where its outline entry goes, through the rows' one destination.
  assert.deepEqual(rowDestination(code), entry);
  // A reader at a top-level line has no definition around it: no symbol row, the caller's top-level row instead.
  assert.equal(readingSymbol(symbolTree([]), []), undefined);
});

void test('an added class folds its methods; quiet and moved symbols say so', async () => {
  const before = ['export const a = 1;'];
  const after = ['export const a = 1;', '', 'export class Fresh {', '  one() {', '    return 1;', '  }', '}'];
  const hunks = hunksOf(before, after);
  const definitions = { after: await parse('typescript', after), before: await parse('typescript', before) };
  const all = changedSymbols(hunks, definitions) ?? [];
  const nodes = symbolTree(all, [], [
    {
      side: 'after',
      kind: 'class',
      name: 'Fresh',
      label: 'Fresh',
      start: all[0].definition.start,
      end: all[0].definition.end,
      signatureEnd: all[0].definition.start,
      other: { file: 'x', url: 'u', headSha: 'h', path: 'lib/old.ts', diffPath: 'lib/old.ts', side: 'before', kind: 'class', name: 'Fresh', start: 12 } as never,
      sameFile: false,
      exact: true,
      renamed: false,
      similarity: 1,
      commentsChanged: false,
    },
  ], () => 'Formatting only');
  // Its blank line above is top-level.
  assert.deepEqual(brief(nodes), [['Fresh', 'added', 5, 0]]);
  assert.equal(nodes[0].quiet, 'Formatting only');
  assert.equal(nodes[0].moved, 'Moved from lib/old.ts, line 12');
  assert.equal(moveWords({ side: 'after', sameFile: true, renamed: true, other: { start: 4, name: 'old', path: 'a.ts' } as never }), 'Renamed from old, line 4 of this file');
});

void test('the reader’s place lights the innermost row it is in', async () => {
  const { all } = await file();
  const nodes = symbolTree(all);
  const flush = nodes[0].children[0].id;
  assert.equal(readingSymbol(nodes, ['class:Store', 'method:flush']), flush);
  // Elsewhere in the class: its context row.
  assert.equal(readingSymbol(nodes, ['class:Store', 'method:keep']), nodes[0].id);
  assert.equal(readingSymbol(nodes, ['function:elsewhere']), undefined);
  assert.equal(readingSymbol(nodes, undefined), undefined);
});

void test('search keeps the matching symbols and the rows around them', async () => {
  const { all } = await file();
  const nodes = symbolTree(all);
  const hits = matchingSymbols(nodes, 'FLU');
  assert.ok(hits);
  assert.deepEqual(brief(pruneSymbols(nodes, hits)), [['Store', 'context', 0, 0, [['flush', 'modified', 1, 1]]]]);
  assert.equal(matchingSymbols(nodes, '  '), undefined);
});

void test('paths: files keep the diff order, folders flatten as Pierre does, files and symbols never do', async () => {
  const { all } = await file();
  const nodes = symbolTree(all);
  const keys = ['a/b/c/x.ts', 'a/b/c/y.json', 'lib/store.ts', 'one/only.ts', 'readme.md'];
  const symbols = new Map<string, FileSymbols>([
    ['lib/store.ts', { state: 'ready', nodes, top: { added: 1, deleted: 0, imports: true, lines: ['a2'], first: { side: 'after', line: 2 } } }],
    ['a/b/c/x.ts', { state: 'loading' }],
    ['one/only.ts', { state: 'none', reason: 'Too large to list symbols' }],
  ]);
  const folders = new Set(['a/b/c/x.ts', 'lib/store.ts', 'one/only.ts']);
  const layout = symbolTreePaths(keys, folders, symbols, new Set(['a/b/c/x.ts']));
  const shown = layout.paths.map((p) => p.replace(/[\u2061-\u2064\u200b\u200c]/g, '').replace(/∕/g, '|'));
  assert.deepEqual(shown, [
    'a | b | c/x.ts/Loading symbols…',
    'a | b | c/y.json',
    'lib/store.ts/Imports',
    'lib/store.ts/Store/flush',
    'lib/store.ts/gone',
    'lib/store.ts/added',
    // A collapsed file with nothing to show yet is still a folder, so it has its chevron; its note waits for it to open.
    'one/only.ts/',
    'readme.md',
  ]);
  // Rows are found by their paths, and files and folders by their keys.
  const store = layout.pierreOf.get('lib/store.ts');
  assert.ok(store);
  assert.ok(store.endsWith(`${FILE_MARK}/`));
  assert.deepEqual(layout.rows.get(store), { type: 'file', key: 'lib/store.ts', folder: true });
  assert.deepEqual(layout.rows.get(store.slice(0, -1)), { type: 'file', key: 'lib/store.ts', folder: true });
  assert.equal(layout.pierreOf.get('a/'), layout.pierreOf.get('a/b/c/'));
  assert.deepEqual(layout.rows.get(layout.pierreOf.get('a/b/') ?? ''), { type: 'folder', path: 'a/b/c/' });
  assert.equal(layout.rows.get(layout.pierreOf.get('readme.md') ?? '')?.type, 'file');
  const flush = layout.symbolPaths.get(symbolRowKey('lib/store.ts', nodes[0].children[0].id));
  assert.ok(flush);
  assert.equal(layout.rows.get(flush)?.type, 'symbol');
  // The Imports row is found by its review id, as a symbol's row is.
  assert.equal(layout.rows.get(layout.symbolPaths.get(symbolRowKey('lib/store.ts', TOP_LEVEL_ID)) ?? '')?.type, 'top');
  // A directory is known by what stays the same, for keeping it open across rebuilds.
  assert.ok(layout.directories.has(symbolRowKey('lib/store.ts', nodes[0].id)));
  assert.ok(layout.directories.has('lib/store.ts'));
});

void test('paths: repeated names stay apart, a slash in a name does not split it, and codes never overlap', async () => {
  const { all } = await file();
  const flush = symbolTree(all)[0].children[0];
  const twin = { ...flush, id: `${flush.id}#2` };
  const slashed = { ...flush, id: 'function:a/b', definition: { ...flush.definition, kind: 'function' as const, name: 'a/b' } };
  const layout = symbolTreePaths(['x.ts'], new Set(['x.ts']), new Map([['x.ts', { state: 'ready', nodes: [flush, twin, slashed] }]]), new Set());
  assert.equal(new Set(layout.paths).size, 3);
  assert.equal(layout.paths.every((p) => p.split('/').length === 2), true);
  assert.ok(layout.paths[2].includes(`a${NAME_SLASH}b`));
  const codes = rowCodes().map((entry) => entry.code);
  for (const code of codes) assert.equal(codes.filter((other) => other.includes(code)).length, 1);
});

const def = (kind: SyntaxDefinition['kind'], name: string, start: number, end: number): SyntaxDefinition => ({
  kind,
  name,
  label: name,
  crumb: name,
  start,
  end,
  signatureEnd: start,
});
const symbol = (id: string, change: ChangedSymbol['change'], side: 'after' | 'before', definition: SyntaxDefinition, parents: SyntaxDefinition[]): ChangedSymbol => ({
  id,
  change,
  side,
  definition,
  parents,
  first: { side, line: definition.start + 1 },
  added: change === 'removed' ? 0 : 1,
  deleted: change === 'added' ? 0 : 1,
});

void test('a context row goes to its definition on the side of the change it reveals, after a search too', () => {
  // The class starts at line 10 in the new file and at line 40 in the old one.
  const after = def('class', 'Store', 10, 30);
  const before = def('class', 'Store', 40, 60);
  const nodes = symbolTree([
    symbol('class:Store>method:flush', 'modified', 'after', def('method', 'flush', 12, 14), [after]),
    symbol('class:Store>method:gone', 'removed', 'before', def('method', 'gone', 50, 52), [before]),
  ]);
  assert.deepEqual(
    [rowDestination(nodes[0])?.side, rowDestination(nodes[0])?.definition.start],
    ['after', 10]
  );
  // A search for "gone" keeps only the removed method: the class row goes to its old-side start.
  const pruned = pruneSymbols(nodes, matchingSymbols(nodes, 'gone') ?? new Set());
  const target = rowDestination(pruned[0]);
  assert.deepEqual([target?.side, target?.definition.start, target?.first.line], ['before', 40, 51]);
  assert.equal(rowDestination(nodes[0].children[0]), nodes[0].children[0].symbol);
});

void test('overloads are told apart by where the reader is', () => {
  const nodes = symbolTree([
    symbol('function:parse', 'modified', 'after', def('function', 'parse', 1, 3), []),
    symbol('function:parse#2', 'modified', 'after', def('function', 'parse', 5, 9), []),
  ]);
  assert.equal(readingSymbol(nodes, ['function:parse@5']), 'function:parse#2');
  assert.equal(readingSymbol(nodes, ['function:parse@1']), 'function:parse');
  // Without a start, or at one no row has, the first.
  assert.equal(readingSymbol(nodes, ['function:parse']), 'function:parse');
  assert.equal(readingSymbol(nodes, ['function:parse@99']), 'function:parse');
});

void test('a row\'s ancestors, outermost first, for a jump to open: folders, the file, its containers', () => {
  assert.deepEqual(ancestorPaths('src ∕ lib/store.ts⁢/Store⁣x/flush⁣y'), ['src ∕ lib/', 'src ∕ lib/store.ts⁢/', 'src ∕ lib/store.ts⁢/Store⁣x/']);
  // A directory row's own path is not its ancestor.
  assert.deepEqual(ancestorPaths('src/store.ts⁢/Store⁣x/'), ['src/', 'src/store.ts⁢/']);
  assert.deepEqual(ancestorPaths('readme.md'), []);
});
