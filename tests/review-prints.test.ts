import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedRowTexts, itemPrint, itemPrints, planCarry, printText, readSavedPrint, savedPrint } from '../lib/review-prints';
import { TOP_LEVEL_ID, bodyId, type ChangedSymbol } from '../lib/symbol-outline';
import type { SyntaxDefinition } from '../lib/syntax-scope';
import { symbolTree, type TopLevelChanges } from '../lib/tree-symbols';

/** Re-review only what changed (lib/review-prints.ts, lib/symbol-carry.ts). */

const definition = (name: string, start: number, end: number): SyntaxDefinition => ({ kind: 'function', name, label: name, crumb: name, start, end, signatureEnd: start });
function changed(id: string, start: number, end: number, change: ChangedSymbol['change'] = 'modified', side: 'after' | 'before' = 'after'): ChangedSymbol {
  const parts = id.split('>');
  return { id, change, definition: definition(parts.at(-1) ?? id, start, end), side, parents: parts.slice(0, -1).map((part) => definition(part, 1, 99)), first: { side, line: start }, added: 1, deleted: 0 };
}

void test('a print reads the text, not its whitespace', () => {
  assert.equal(printText('  function f() {\n\n\treturn  1;\n}  '), 'function f() {\nreturn 1;\n}');
  assert.equal(itemPrint('function f() {\n  return 1;\n}'), itemPrint('function f() {\n        return 1;\n\n}'));
  assert.notEqual(itemPrint('function f() {\n  return 1;\n}'), itemPrint('function f() {\n  return 2;\n}'));
  assert.match(itemPrint('x'), /^v1:/, 'Versioned, so a change of the rules never matches an old print');
  assert.deepEqual(readSavedPrint(savedPrint('v1:abc', 42)), { print: 'v1:abc', at: 42 });
  assert.equal(readSavedPrint(undefined), undefined);
});

void test("each item's print: a symbol's definition on its side, the top level's and a Body's own changed lines", () => {
  const after = ['import { a } from "a";', 'function f() {', '  return 2;', '}', 'class C {', '  x = 1;', '  m() {}', '}'].join('\n');
  const before = ['function gone() {', '  return 0;', '}'].join('\n');
  const hunks = [
    { oldStart: 1, newStart: 1, rows: [{ type: '+' as const, text: 'import { a } from "a";' }, { type: '-' as const, text: 'function gone() {' }] },
    { oldStart: 6, newStart: 6, rows: [{ type: '-' as const, text: '  x = 0;' }, { type: '+' as const, text: '  x = 1;' }] },
  ];
  const nodes = symbolTree([changed('function:f', 2, 4), changed('function:gone', 1, 3, 'removed', 'before'), changed('class:C', 5, 8), changed('class:C>m', 7, 7)]);
  const top: TopLevelChanges = { added: 1, deleted: 0, imports: true, lines: ['a1'], first: { side: 'after', line: 1 } };
  const prints = itemPrints({
    items: [TOP_LEVEL_ID, 'function:f', 'function:gone', bodyId('class:C'), 'class:C>m', 'function:missing'],
    nodes,
    top,
    after,
    before,
    rows: changedRowTexts(hunks),
    own: new Map([['class:C', ['b6', 'a6']]]),
  });
  assert.equal(prints['function:f'], itemPrint('function f() {\n  return 2;\n}'));
  assert.equal(prints['function:gone'], itemPrint(before), 'A removed symbol reads its old side');
  assert.equal(prints[TOP_LEVEL_ID], itemPrint('+import { a } from "a";'));
  assert.equal(prints[bodyId('class:C')], itemPrint('@body\n-  x = 0;\n+  x = 1;'));
  assert.equal(prints['class:C>m'], itemPrint('  m() {}'));
  assert.equal(prints['function:missing'], undefined, 'No text at hand: no print, so it neither carries nor is Updated');
});

void test('carry-over: the same text carries, other text is Updated, new and legacy ticks are neither', () => {
  const plan = planCarry({
    items: ['same', 'changed', 'new', 'legacy', 'ticked', 'unprinted'],
    prints: { same: 'v1:a', changed: 'v1:b', new: 'v1:c', legacy: 'v1:d', ticked: 'v1:e' },
    earlier: new Map([
      ['same', { print: 'v1:a', at: 5 }],
      ['changed', { print: 'v1:old', at: 6 }],
      ['legacy', { at: 0 }],
      ['ticked', { print: 'v1:other', at: 7 }],
      ['unprinted', { print: 'v1:f', at: 8 }],
    ]),
    viewed: (id) => id === 'ticked',
  });
  assert.deepEqual(plan.carry, [{ id: 'same', at: 5 }]);
  assert.deepEqual(plan.updated, ['changed'], 'Ticked here already, or with no print now: neither');
});

void test('a new revision of a file takes the ticks that still read the same, and marks the rest Updated', async () => {
  const progress = await import('../lib/file-view-progress');
  const { ensureCarried, isUpdated, updatedCount } = await import('../lib/symbol-carry');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/9';
  const snapshot = (head: string, files: { path: string; changeId: string; patch?: string; previousPath?: string }[]) =>
    ({ url, metadata: { baseSha: 'base', headSha: head }, files: files.map((file) => ({ status: 'modified', additions: 1, deletions: 1, ...file })) }) as unknown as Parameters<
      typeof progress.registerChangeProgress
    >[0];
  const nodes = symbolTree([changed('function:flush', 1, 3), changed('function:gone', 5, 7)]);
  const symbols = (prints: Record<string, string>) => ({ state: 'ready' as const, nodes, prints });
  // Revision 1: both ticked, with what they read.
  progress.registerChangeProgress(snapshot('h1', [{ path: 'src/store.ts', changeId: 'c1' }, { path: 'data.json', changeId: 'j1', patch: '@@ -1 +1 @@\n-1\n+2' }]));
  const first = fileRevisionKey(url, 'src/store.ts', 'base', 'h1');
  await progress.markSymbolsViewed(first, ['function:flush', 'function:gone'], true, { 'function:flush': 'v1:flush1', 'function:gone': 'v1:gone' });
  await progress.markFileViewed(fileRevisionKey(url, 'data.json', 'base', 'h1'), true);
  // Revision 2: flush changed, gone did not; the JSON file has the same patch under a new blob.
  progress.registerChangeProgress(snapshot('h2', [{ path: 'src/store.ts', changeId: 'c2' }, { path: 'data.json', changeId: 'j2', patch: '@@ -1 +1 @@\n-1\n+2' }]));
  const second = fileRevisionKey(url, 'src/store.ts', 'base', 'h2');
  assert.equal(progress.isSymbolViewed(second, 'function:gone'), false, 'A new change to the file starts its ticks afresh, before carry-over');
  ensureCarried(second, symbols({ 'function:flush': 'v1:flush2', 'function:gone': 'v1:gone' }));
  assert.equal(progress.isSymbolViewed(second, 'function:gone'), true, 'gone reads the same: it carries');
  assert.equal(progress.isSymbolViewed(second, 'function:flush'), false);
  assert.equal(isUpdated(second, 'function:flush'), true, 'flush changed: Updated');
  assert.equal(isUpdated(second, 'function:gone'), false);
  assert.equal(progress.isFileViewed(second), false, 'Not every item carried: the file is unviewed');
  assert.equal(updatedCount([second]), 1);
  // A file without symbols carries by its patch.
  const json = fileRevisionKey(url, 'data.json', 'base', 'h2');
  ensureCarried(json, undefined);
  assert.equal(progress.isFileViewed(json), true);
  // Ticking the Updated item here ends it; an untick here is never undone by carrying again.
  await progress.markSymbolsViewed(second, ['function:flush'], true, { 'function:flush': 'v1:flush2' });
  assert.equal(isUpdated(second, 'function:flush'), false);
  await progress.markSymbolsViewed(second, ['function:gone'], false);
  ensureCarried(second, symbols({ 'function:flush': 'v1:flush2', 'function:gone': 'v1:gone' }));
  assert.equal(progress.isSymbolViewed(second, 'function:gone'), false);

  // Revision 3, renamed: flush, ticked in revision 2 and the same, carries from the old path. gone was unticked in
  // revision 2, after its tick in revision 1: the untick wins, and the old tick does not come back.
  progress.registerChangeProgress(snapshot('h3', [{ path: 'src/stores.ts', previousPath: 'src/store.ts', changeId: 'c3' }]));
  const third = fileRevisionKey(url, 'src/stores.ts', 'base', 'h3');
  ensureCarried(third, symbols({ 'function:flush': 'v1:flush2', 'function:gone': 'v1:gone' }));
  assert.equal(progress.isSymbolViewed(third, 'function:flush'), true, 'The rename carries from the old path');
  assert.equal(progress.isSymbolViewed(third, 'function:gone'), false, 'An untick is not undone by the next push');
  assert.equal(progress.isFileViewed(third), false);
  // Ticked here, every item reads the same in revision 4: all carry, and the file is Viewed with no reader on it.
  await progress.markSymbolsViewed(third, ['function:gone'], true, { 'function:gone': 'v1:gone' });
  progress.registerChangeProgress(snapshot('h4', [{ path: 'src/stores.ts', changeId: 'c4' }]));
  const fourth = fileRevisionKey(url, 'src/stores.ts', 'base', 'h4');
  ensureCarried(fourth, symbols({ 'function:flush': 'v1:flush2', 'function:gone': 'v1:gone' }));
  assert.equal(progress.isSymbolViewed(fourth, 'function:gone'), true);
  assert.equal(progress.isFileViewed(fourth), true, 'Everything carried: the file is Viewed');
});

void test('Reset viewed is an untick: nothing it cleared carries to the next push, until Undo puts it back', async () => {
  const progress = await import('../lib/file-view-progress');
  const { ensureCarried } = await import('../lib/symbol-carry');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/11';
  const snapshot = (head: string, changeId: string) =>
    ({ url, metadata: { baseSha: 'base', headSha: head }, files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, changeId }] }) as unknown as Parameters<
      typeof progress.registerChangeProgress
    >[0];
  const nodes = symbolTree([changed('function:f', 1, 3), changed('function:g', 5, 7)]);
  progress.registerChangeProgress(snapshot('h1', 'c1'));
  const first = fileRevisionKey(url, 'a.ts', 'base', 'h1');
  await progress.markSymbolsViewed(first, ['function:f', 'function:g'], true, { 'function:f': 'v1:f', 'function:g': 'v1:g' });
  const { snapshot: cleared } = progress.resetViewed([first]);
  progress.registerChangeProgress(snapshot('h2', 'c2'));
  const second = fileRevisionKey(url, 'a.ts', 'base', 'h2');
  ensureCarried(second, { state: 'ready', nodes, prints: { 'function:f': 'v1:f', 'function:g': 'v1:g' } });
  assert.equal(progress.isSymbolViewed(second, 'function:f'), false, 'Reset: nothing carries');
  // Undo restores the ticks with their prints, so they carry again to a later revision.
  await progress.restoreViewed(cleared);
  progress.registerChangeProgress(snapshot('h3', 'c3'));
  const third = fileRevisionKey(url, 'a.ts', 'base', 'h3');
  ensureCarried(third, { state: 'ready', nodes, prints: { 'function:f': 'v1:f', 'function:g': 'v1:g' } });
  assert.equal(progress.isSymbolViewed(third, 'function:f'), true);
});

void test('Unticking a symbol of a file marked Viewed by hand is remembered, so scrolling does not tick it again', async () => {
  const progress = await import('../lib/file-view-progress');
  const key = 'untick:file';
  await progress.markFileViewed(key, true);
  await progress.markSymbolsViewed(key, ['function:f'], false);
  assert.equal(progress.wasSymbolUnticked(key, 'function:f'), true);
});

void test('ticks saved before prints, and files still loading, never carry', async () => {
  const progress = await import('../lib/file-view-progress');
  const { ensureCarried, isUpdated } = await import('../lib/symbol-carry');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/10';
  const snapshot = (head: string, changeId: string) =>
    ({ url, metadata: { baseSha: 'base', headSha: head }, files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, changeId }] }) as unknown as Parameters<
      typeof progress.registerChangeProgress
    >[0];
  progress.registerChangeProgress(snapshot('h1', 'c1'));
  await progress.markSymbolsViewed(fileRevisionKey(url, 'a.ts', 'base', 'h1'), ['function:f'], true);
  progress.registerChangeProgress(snapshot('h2', 'c2'));
  const second = fileRevisionKey(url, 'a.ts', 'base', 'h2');
  const nodes = symbolTree([changed('function:f', 1, 3)]);
  // Still loading: nothing decided.
  ensureCarried(second, { state: 'loading' });
  ensureCarried(second, { state: 'ready', nodes, prints: { 'function:f': 'v1:f' } });
  assert.equal(progress.isSymbolViewed(second, 'function:f'), false, 'A tick with no print does not carry');
  assert.equal(isUpdated(second, 'function:f'), false, 'and is not Updated either: nothing is known of what it read');
});

void test('carry-over waits for the revision to be registered, and a file with no patch never carries', async () => {
  const progress = await import('../lib/file-view-progress');
  const { ensureCarried } = await import('../lib/symbol-carry');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/12';
  const snapshot = (head: string, files: { path: string; changeId: string; patch?: string }[]) =>
    ({ url, metadata: { baseSha: 'base', headSha: head }, files: files.map((file) => ({ status: 'modified', additions: 1, deletions: 0, ...file })) }) as unknown as Parameters<
      typeof progress.registerChangeProgress
    >[0];
  progress.registerChangeProgress(snapshot('h1', [{ path: 'a.json', changeId: 'a1', patch: '+1' }, { path: 'big.json', changeId: 'b1' }]));
  await progress.markFilesViewed([fileRevisionKey(url, 'a.json', 'base', 'h1'), fileRevisionKey(url, 'big.json', 'base', 'h1')], true);
  const second = fileRevisionKey(url, 'a.json', 'base', 'h2');
  // Asked before the new revision is registered (the tree's effect runs before the view's): nothing yet, and not done.
  ensureCarried(second, undefined);
  assert.equal(progress.isFileViewed(second), false);
  progress.registerChangeProgress(snapshot('h2', [{ path: 'a.json', changeId: 'a2', patch: '+1' }, { path: 'big.json', changeId: 'b2' }]));
  ensureCarried(second, undefined);
  assert.equal(progress.isFileViewed(second), true, 'Registered: the same patch carries');
  // No patch on either side: a blob says nothing of the base, so nothing carries.
  const big = fileRevisionKey(url, 'big.json', 'base', 'h2');
  ensureCarried(big, undefined);
  assert.equal(progress.isFileViewed(big), false);
});

void test("carry-over's per-PR state leaves with the PR's inspection data", async () => {
  const progress = await import('../lib/file-view-progress');
  // The inspection caches call this when the PR leaves them (lib/use-tree-symbols.ts registers it).
  const { forgetCarry } = await import('../lib/symbol-carry');
  const { fileRevisionKey } = await import('../lib/pr-changes');
  const url = 'https://github.com/o/r/pull/13';
  progress.registerChangeProgress({
    url,
    metadata: { baseSha: 'base', headSha: 'h1' },
    files: [{ path: 'a.json', status: 'modified', additions: 1, deletions: 0, changeId: 'a1', patch: '+1' }],
  } as unknown as Parameters<typeof progress.registerChangeProgress>[0]);
  const key = fileRevisionKey(url, 'a.json', 'base', 'h1');
  assert.equal(progress.isRegistered(key), true);
  const before = progress.revisionFileStats().entries;
  forgetCarry(new Set([url]));
  assert.equal(progress.isRegistered(key), false, 'Its patch is no longer held');
  assert.equal(progress.revisionFileStats().entries, before - 1);
});
