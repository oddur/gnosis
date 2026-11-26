import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyntaxDefinition } from '../lib/syntax-scope';
import type { FileSymbols } from '../lib/tree-symbol-paths';
import type { TopLevelChanges, TreeSymbolNode } from '../lib/tree-symbols';
import { TOP_LEVEL_ID, bodyId, type ChangedSymbol } from '../lib/symbol-outline';
import { symbolTree } from '../lib/tree-symbols';
import { countedIds, fileAfterTick, folderProgress, progressLabel, reviewIds, reviewStops, rolledUp, stepUnviewed, symbolProgress, treeOrder, type ReviewFile } from '../lib/tree-symbol-review';
import { AUTO_VIEW_DWELL_MS, MAX_LOOK_GAP_MS, createAutoViewer, diffRowPositions } from '../lib/symbol-auto-view';

/** The tree as a review list (lib/tree-symbol-review.ts) and scrolled-through ticks (lib/symbol-auto-view.ts). */

const definition = (name: string): SyntaxDefinition => ({ kind: 'function', name, label: name, crumb: name, start: 1, end: 2, signatureEnd: 1 });
/** A changed symbol's node; `quiet` for one whose every change is hidden, `context` for an unchanged parent. */
function node(id: string, children: TreeSymbolNode[] = [], { quiet = false, context = false } = {}): TreeSymbolNode {
  const name = id.split('>').at(-1) ?? id;
  const symbol = context ? undefined : ({ id, change: 'modified', definition: definition(name), side: 'after', parents: [], first: { side: 'after', line: 1 }, added: 1, deleted: 0 } satisfies ChangedSymbol);
  return { id, definition: definition(name), change: context ? 'context' : 'modified', symbol, added: context ? 0 : 1, deleted: 0, quiet: quiet ? 'Formatting only' : undefined, children };
}
const ready = (nodes: TreeSymbolNode[]): FileSymbols => ({ state: 'ready', nodes });

void test('progress counts changed symbols only, as the outline does', () => {
  const nodes = [node('class:Store', [node('class:Store>flush'), node('class:Store>keep')], { context: true }), node('gone'), node('fmt', [], { quiet: true })];
  assert.deepEqual(treeOrder(nodes).map((n) => n.id), ['class:Store', 'class:Store>flush', 'class:Store>keep', 'gone', 'fmt']);
  const viewed = new Set(['class:Store>flush', 'fmt']);
  // The context class and the quiet symbol are not counted, and a quiet symbol's tick does not count either.
  assert.deepEqual(symbolProgress(nodes, (id) => viewed.has(id)), { viewed: 1, total: 3 });
  // A Viewed file has every symbol viewed.
  assert.deepEqual(symbolProgress(nodes, () => false, true), { viewed: 3, total: 3 });
  assert.deepEqual(symbolProgress([node('fmt', [], { quiet: true })], () => true), { viewed: 0, total: 0 });
});

void test('the row shows progress once a symbol is viewed, and a check once all are', () => {
  assert.deepEqual(progressLabel(undefined), { kind: 'none' });
  assert.deepEqual(progressLabel({ viewed: 0, total: 5 }), { kind: 'none' });
  assert.deepEqual(progressLabel({ viewed: 0, total: 0 }), { kind: 'none' });
  assert.deepEqual(progressLabel({ viewed: 2, total: 5 }), { kind: 'some', text: '2/5' });
  assert.deepEqual(progressLabel({ viewed: 5, total: 5 }), { kind: 'all', text: '✓ 5/5' });
});

void test('folders sum the files under them whose symbols are known', () => {
  const sums = folderProgress(
    new Map([
      ['src/lib/a.ts', { viewed: 2, total: 5 }],
      ['src/lib/b.ts', { viewed: 1, total: 4 }],
      ['src/c.ts', { viewed: 4, total: 10 }],
      ['src/none.ts', { viewed: 0, total: 0 }],
      ['top.ts', { viewed: 1, total: 1 }],
    ])
  );
  assert.deepEqual(Object.fromEntries(sums), {
    'src/': { viewed: 7, total: 19 },
    'src/lib/': { viewed: 3, total: 9 },
  });
});

void test('n and Shift+N walk unviewed symbols in the tree order, across files', () => {
  const files: ReviewFile[] = [
    { key: 'a.ts', viewed: false, symbols: ready([node('a1'), node('a2')]) },
    { key: 'b.json', viewed: false },
    { key: 'c.ts', viewed: true, symbols: ready([node('c1')]) },
    { key: 'd.ts', viewed: false, symbols: ready([node('class:D', [node('class:D>d1'), node('class:D>d2', [], { quiet: true })], { context: true })]) },
    { key: 'e.ts', viewed: false, symbols: { state: 'none', reason: 'Too large to list symbols' } },
    { key: 'f.ts', viewed: false, symbols: ready([node('f1'), node('f2')]) },
  ];
  const viewed = new Set(['a.ts\u0000a2', 'f.ts\u0000f1']);
  const isViewed = (key: string, id: string) => viewed.has(`${key}\u0000${id}`);
  const next = (key: string, id?: string, direction: 1 | -1 = 1) => {
    const step = stepUnviewed(files, { key, id }, direction, isViewed);
    return step.kind === 'go' ? `${step.key}:${step.id}` : step.kind;
  };
  // From a file's top, its first unviewed symbol.
  assert.equal(next('a.ts'), 'a.ts:a1');
  // Past a viewed symbol, a file without symbols and a Viewed file, to a method under a context class.
  assert.equal(next('a.ts', 'a1'), 'd.ts:class:D>d1');
  // From the context row itself, its first changed child.
  assert.equal(next('d.ts', 'class:D'), 'd.ts:class:D>d1');
  // A quiet symbol and an unreadable file are passed.
  assert.equal(next('d.ts', 'class:D>d1'), 'f.ts:f2');
  assert.equal(next('f.ts', 'f2'), 'end');
  // Back the same way.
  assert.equal(next('f.ts', 'f2', -1), 'd.ts:class:D>d1');
  assert.equal(next('d.ts', 'class:D>d1', -1), 'a.ts:a1');
  assert.equal(next('a.ts', 'a1', -1), 'end');
  // From a file's top, back goes to the files before it, never into the file.
  assert.equal(next('d.ts', undefined, -1), 'a.ts:a1');
  // A place the file does not list (the reader outside its symbols) is its top.
  assert.equal(next('f.ts', 'function:gone'), 'f.ts:f2');
  // From a file not in the list: from the start, or the end.
  assert.equal(next('missing.ts'), 'a.ts:a1');
  assert.equal(next('missing.ts', undefined, -1), 'f.ts:f2');
});

void test('a file whose symbols are not known yet is read before the walk passes it', () => {
  const files: ReviewFile[] = [
    { key: 'a.ts', viewed: false, symbols: ready([node('a1')]) },
    { key: 'b.ts', viewed: true, symbols: { state: 'loading' } },
    { key: 'c.ts', viewed: false, symbols: { state: 'loading' } },
    { key: 'd.ts', viewed: false, symbols: ready([node('d1')]) },
  ];
  // A Viewed file is skipped without reading it; an unviewed one is read first.
  assert.deepEqual(stepUnviewed(files, { key: 'a.ts', id: 'a1' }, 1, () => false), { kind: 'load', key: 'c.ts' });
  assert.deepEqual(stepUnviewed(files, { key: 'd.ts', id: 'd1' }, -1, () => false), { kind: 'load', key: 'c.ts' });
  // Once read, the walk goes on through it.
  const known = files.map((file) => (file.key === 'c.ts' ? { ...file, symbols: ready([]) } : file));
  const step = stepUnviewed(known, { key: 'a.ts', id: 'a1' }, 1, () => false);
  assert.equal(step.kind === 'go' && step.id, 'd1');
  // The reader's own file, still loading, is read too.
  assert.deepEqual(stepUnviewed(files, { key: 'c.ts' }, 1, () => false), { kind: 'load', key: 'c.ts' });
});

void test('row places: one per line in the unified diff, side by side in the split one', () => {
  const hunks = [
    { oldStart: 1, newStart: 1, rows: [{ type: ' ' }, { type: '-' }, { type: '-' }, { type: '+' }, { type: ' ' }] as const },
    { oldStart: 20, newStart: 19, rows: [{ type: '+' }, { type: '+' }] as const },
  ];
  assert.deepEqual(Object.fromEntries(diffRowPositions(hunks, false)), { a1: 0, b2: 1, b3: 2, a2: 3, a3: 4, a19: 5, a20: 6 });
  assert.deepEqual(Object.fromEntries(diffRowPositions(hunks, true)), { a1: 0, b2: 1, b3: 2, a2: 1, a3: 3, a19: 4, a20: 5 });
});

void test('a symbol is ticked after every changed line was on screen for the dwell time', () => {
  const positions = new Map([['a1', 0], ['a2', 1], ['a3', 2], ['a4', 3], ['a5', 4]]);
  const viewer = createAutoViewer([{ id: 'f', lines: ['a2', 'a4'] }], positions, () => true);
  // First look: only part of it on screen. It waits for its dwell, so a still view keeps looking.
  assert.deepEqual(viewer.look({ at: 0, range: [0, 2], fast: false }), []);
  assert.equal(viewer.waiting(), true);
  // Still on screen, but a4 not seen yet: dwell grows, no tick. With its dwell, it waits for a scroll, not the clock.
  for (let at = 400; at <= 2_000; at += 400) assert.deepEqual(viewer.look({ at, range: [0, 2], fast: false }), []);
  assert.equal(viewer.waiting(), false);
  // The rest comes into view; a line counts once two looks in a row had it on screen.
  assert.deepEqual(viewer.look({ at: 2_400, range: [1, 4], fast: false }), []);
  assert.deepEqual(viewer.look({ at: 2_800, range: [1, 4], fast: false }), ['f']);
  // Once only, and nothing waits any more.
  assert.deepEqual(viewer.look({ at: 3_200, range: [1, 4], fast: false }), []);
  assert.equal(viewer.waiting(), false);
});

void test('flying past never ticks, and neither does idle time', () => {
  const positions = new Map([['a1', 0], ['a2', 1]]);
  const flown = createAutoViewer([{ id: 'f', lines: ['a1', 'a2'] }], positions, () => true);
  for (let at = 0; at <= 5_000; at += 100) assert.deepEqual(flown.look({ at, range: [0, 1], fast: true }), []);
  // A fast look in between breaks the dwell: it starts again.
  const broken = createAutoViewer([{ id: 'f', lines: ['a1', 'a2'] }], positions, () => true);
  broken.look({ at: 0, range: [0, 1], fast: false });
  broken.look({ at: 400, range: [0, 1], fast: false });
  broken.look({ at: 800, range: [0, 1], fast: false });
  broken.look({ at: 900, range: [0, 1], fast: true });
  assert.deepEqual(broken.look({ at: 1_300, range: [0, 1], fast: false }), []);
  assert.deepEqual(broken.look({ at: 1_700, range: [0, 1], fast: false }), []);
  // One long gap (the window hidden) counts as MAX_LOOK_GAP_MS only.
  const idle = createAutoViewer([{ id: 'f', lines: ['a1'] }], positions, () => true);
  idle.look({ at: 0, range: [0, 1], fast: false });
  assert.deepEqual(idle.look({ at: 60_000, range: [0, 1], fast: false }), []);
  let at = 60_000;
  const looks = Math.ceil((AUTO_VIEW_DWELL_MS - MAX_LOOK_GAP_MS) / MAX_LOOK_GAP_MS);
  for (let i = 0; i < looks - 1; i++) assert.deepEqual(idle.look({ at: (at += MAX_LOOK_GAP_MS), range: [0, 1], fast: false }), []);
  assert.deepEqual(idle.look({ at: (at += MAX_LOOK_GAP_MS), range: [0, 1], fast: false }), ['f']);
});

void test('a symbol scrolled off before the dwell, unticked, or with lines the diff hides is not ticked', () => {
  const positions = new Map([['a1', 0], ['a2', 1], ['a9', 8]]);
  // Each look sees it for a moment only: the time between looks without it on screen is not dwell.
  const passing = createAutoViewer([{ id: 'f', lines: ['a1'] }], positions, () => true);
  for (let at = 0; at < 6_000; at += 800) {
    assert.deepEqual(passing.look({ at, range: [0, 1], fast: false }), []);
    passing.look({ at: at + 400, range: [5, 9], fast: false });
  }
  // The reader unticked it: never again.
  const unticked = createAutoViewer([{ id: 'f', lines: ['a1'] }], positions, () => false);
  for (let at = 0; at < 6_000; at += 400) assert.deepEqual(unticked.look({ at, range: [0, 1], fast: false }), []);
  // A line with no place (hidden) is never seen.
  const hidden = createAutoViewer([{ id: 'f', lines: ['a1', 'a5'] }], positions, () => true);
  for (let at = 0; at < 6_000; at += 400) assert.deepEqual(hidden.look({ at, range: [0, 9], fast: false }), []);
  // No range: nothing of the diff on screen.
  const away = createAutoViewer([{ id: 'f', lines: ['a1'] }], positions, () => true);
  for (let at = 0; at < 6_000; at += 400) assert.deepEqual(away.look({ at, fast: false }), []);
});

const top = (quiet = false): TopLevelChanges => ({ added: 2, deleted: 0, imports: true, lines: ['a1', 'a40'], first: { side: 'after', line: 1 }, quiet: quiet || undefined });

void test("a file's top-level changes count as one more symbol, first in the file, unless they are all quiet", () => {
  const nodes = [node('a1'), node('a2')];
  assert.deepEqual(reviewStops(nodes, top()).map((stop) => [stop.id, stop.counted]), [[TOP_LEVEL_ID, true], ['a1', true], ['a2', true]]);
  assert.deepEqual(symbolProgress(nodes, () => false, false, top()), { viewed: 0, total: 3 });
  assert.deepEqual(symbolProgress(nodes, (id) => id === TOP_LEVEL_ID, false, top()), { viewed: 1, total: 3 });
  // Without top-level changes, or with only quiet ones, the count is the symbols'.
  assert.deepEqual(symbolProgress(nodes, () => false), { viewed: 0, total: 2 });
  assert.deepEqual(symbolProgress(nodes, () => true, false, top(true)), { viewed: 2, total: 2 });
  // A file of top-level changes only still has something to review.
  assert.deepEqual(symbolProgress([], () => false, false, top()), { viewed: 0, total: 1 });
  // The folder sums them in.
  assert.deepEqual(folderProgress(new Map([['src/a.ts', symbolProgress(nodes, () => false, false, top())]])).get('src/'), { viewed: 0, total: 3 });
});

void test('n stops at the top level first in each file, and Shift+N comes back to it', () => {
  const files: ReviewFile[] = [
    { key: 'a.ts', viewed: false, symbols: { state: 'ready', nodes: [node('a1')], top: top() } },
    { key: 'b.ts', viewed: false, symbols: { state: 'ready', nodes: [node('b1')], top: top() } },
    { key: 'c.ts', viewed: false, symbols: { state: 'ready', nodes: [node('c1')], top: top(true) } },
  ];
  const at = (key: string, id?: string, direction: 1 | -1 = 1, viewed: string[] = []) => {
    const step = stepUnviewed(files, { key, id }, direction, (file, symbol) => viewed.includes(`${file}:${symbol}`));
    return step.kind === 'go' ? `${step.key}:${step.id}${step.top ? ' (top)' : ''}` : step.kind;
  };
  assert.equal(at('a.ts'), `a.ts:${TOP_LEVEL_ID} (top)`);
  assert.equal(at('a.ts', TOP_LEVEL_ID), 'a.ts:a1');
  assert.equal(at('a.ts', 'a1'), `b.ts:${TOP_LEVEL_ID} (top)`);
  assert.equal(at('a.ts', 'a1', 1, [`b.ts:${TOP_LEVEL_ID}`]), 'b.ts:b1');
  // Quiet top-level changes are passed.
  assert.equal(at('b.ts', 'b1'), 'c.ts:c1');
  assert.equal(at('b.ts', 'b1', -1), `b.ts:${TOP_LEVEL_ID} (top)`);
  assert.equal(at('b.ts', TOP_LEVEL_ID, -1), 'a.ts:a1');
});

void test('scattered top-level lines must all be seen: imports at the top and a statement far below', () => {
  const positions = new Map([['a1', 0], ['a2', 1], ['a40', 39]]);
  const viewer = createAutoViewer([{ id: TOP_LEVEL_ID, lines: ['a1', 'a40'] }], positions, () => true);
  // The imports on screen for a long while: the far statement is not seen yet.
  for (let at = 0; at <= 3_000; at += 400) assert.deepEqual(viewer.look({ at, range: [0, 20], fast: false }), []);
  // Read on down to it: ticked once it has been on screen in two looks.
  assert.deepEqual(viewer.look({ at: 3_400, range: [30, 45], fast: false }), []);
  assert.deepEqual(viewer.look({ at: 3_800, range: [30, 45], fast: false }), [TOP_LEVEL_ID]);
});

void test('the file follows its ticks: the last counted tick marks it, any untick unmarks it', () => {
  const plan = (counted: string[] | undefined, ids: string[], viewed: boolean, fileViewed: boolean, ticked: string[] = []) =>
    fileAfterTick({ counted, ids, viewed, fileViewed, isViewed: (id) => ticked.includes(id) });
  const counted = [TOP_LEVEL_ID, 'a', 'b'];
  // Not the last: nothing happens to the file.
  assert.deepEqual(plan(counted, ['a'], true, false, [TOP_LEVEL_ID]), { others: [] });
  // The last one marks it.
  assert.deepEqual(plan(counted, ['b'], true, false, [TOP_LEVEL_ID, 'a']), { file: 'mark', others: [] });
  // Several at once (a context row's V), finishing it.
  assert.deepEqual(plan(counted, ['a', 'b'], true, false, [TOP_LEVEL_ID]), { file: 'mark', others: [] });
  // An untick of a Viewed file unmarks it, and ticks the rest, which read as viewed with the file.
  assert.deepEqual(plan(counted, ['a'], false, true, ['b']), { file: 'unmark', others: [TOP_LEVEL_ID] });
  // Ticking in a Viewed file, or unticking in an unviewed one, leaves the file alone.
  assert.deepEqual(plan(counted, ['a'], true, true), { others: [] });
  assert.deepEqual(plan(counted, ['a'], false, false, ['a']), { others: [] });
  // Unknown or failed symbols: never marked, never unmarked.
  assert.deepEqual(plan(undefined, ['a'], true, false, [TOP_LEVEL_ID, 'b']), { others: [] });
  assert.deepEqual(plan(undefined, ['a'], false, true), { others: [] });
  assert.deepEqual(plan([], ['a'], true, false), { others: [] });
});

void test('what a file counts for its Viewed mark: symbols and top level, quiet ones out, nothing until known', () => {
  assert.deepEqual(countedIds({ state: 'ready', nodes: [node('a'), node('q', [], { quiet: true }), node('class:C', [node('class:C>m')], { context: true })], top: top() }), [
    TOP_LEVEL_ID,
    'a',
    'class:C>m',
  ]);
  assert.deepEqual(countedIds({ state: 'ready', nodes: [node('a')], top: top(true) }), ['a']);
  assert.equal(countedIds({ state: 'loading' }), undefined);
  assert.equal(countedIds({ state: 'none', reason: 'Couldn’t parse this file' }), undefined);
  assert.equal(countedIds(undefined), undefined);
  // A quiet symbol's tick does not finish a file whose real symbol is unticked.
  const ids = countedIds({ state: 'ready', nodes: [node('a'), node('q', [], { quiet: true })] });
  assert.deepEqual(fileAfterTick({ counted: ids, ids: ['q'], viewed: true, fileViewed: false, isViewed: () => false }), { others: [] });
});

/** Changed symbols as `changedSymbols()` lists them, nested by id: `namespace:N>class:C>method:m`. */
function changed(id: string, change: ChangedSymbol['change'] = 'modified'): ChangedSymbol {
  const parts = id.split('>');
  const parents = parts.slice(0, -1).map((part) => definition(part));
  return { id, change, definition: definition(parts.at(-1) ?? id), side: 'after', parents, first: { side: 'after', line: 1 }, added: 1, deleted: 0 };
}

void test('a class changed only by a brace between its changed methods rolls up from them; it is no stop', () => {
  const nodes = symbolTree([changed('class:C'), changed('class:C>a'), changed('class:C>b')], undefined, [], undefined, new Set(['class:C']));
  // No Body: the brace is nothing to read.
  assert.deepEqual(treeOrder(nodes).map((n) => n.id), ['class:C', 'class:C>a', 'class:C>b']);
  assert.deepEqual(countedIds({ state: 'ready', nodes }), ['class:C>a', 'class:C>b']);
  const ticked = new Set<string>();
  const on = (id: string) => ticked.has(id);
  assert.equal(rolledUp(nodes[0], on), false);
  ticked.add('class:C>a');
  assert.equal(rolledUp(nodes[0], on), false);
  ticked.add('class:C>b');
  assert.equal(rolledUp(nodes[0], on), true, 'All its methods viewed: the class reads viewed');
  ticked.delete('class:C>a');
  assert.equal(rolledUp(nodes[0], on), false, 'One unticked: not any more');
  // n walks the methods, never the class.
  const files: ReviewFile[] = [{ key: 'c.ts', viewed: false, symbols: { state: 'ready', nodes } }];
  const step = stepUnviewed(files, { key: 'c.ts' }, 1, () => false);
  assert.equal(step.kind === 'go' && step.id, 'class:C>a');
  // V on the class ticks what is under it.
  assert.deepEqual(reviewIds(nodes[0]), ['class:C>a', 'class:C>b']);
});

void test("a class's changed field is its Body, first under it; the class rolls up only when that is ticked too", () => {
  const nodes = symbolTree([changed('class:C'), changed('class:C>a'), changed('class:C>b')]);
  const body = bodyId('class:C');
  assert.deepEqual(treeOrder(nodes).map((n) => n.id), ['class:C', body, 'class:C>a', 'class:C>b']);
  assert.equal(nodes[0].children[0].symbol?.definition.crumb, 'class:C · body');
  assert.deepEqual(countedIds({ state: 'ready', nodes }), [body, 'class:C>a', 'class:C>b']);
  assert.equal(rolledUp(nodes[0], (id) => id !== body), false, 'Its methods are not all of it');
  assert.equal(rolledUp(nodes[0], () => true), true);
  // The Body is a stop, walked first under the class.
  const files: ReviewFile[] = [{ key: 'c.ts', viewed: false, symbols: { state: 'ready', nodes } }];
  const step = stepUnviewed(files, { key: 'c.ts', id: 'class:C' }, 1, () => false);
  assert.equal(step.kind === 'go' && step.id, body);
  // An added class whose methods folded into it is one leaf, with no Body.
  const added = symbolTree([changed('class:Q', 'added')]);
  assert.deepEqual(countedIds({ state: 'ready', nodes: added }), ['class:Q']);
});

void test('roll-ups nest, and one untick clears them up to the file', () => {
  const nodes = symbolTree(
    [changed('namespace:N'), changed('namespace:N>class:C'), changed('namespace:N>class:C>m'), changed('namespace:N>f')],
    undefined,
    [],
    undefined,
    new Set(['namespace:N'])
  );
  const body = bodyId('namespace:N>class:C');
  const counted = countedIds({ state: 'ready', nodes });
  assert.deepEqual(counted, [body, 'namespace:N>class:C>m', 'namespace:N>f']);
  const ticked = new Set(counted);
  const on = (id: string) => ticked.has(id);
  const namespace = nodes[0];
  const inner = namespace.children.find((n) => n.id === 'namespace:N>class:C');
  assert.ok(inner);
  assert.equal(rolledUp(namespace, on), true);
  assert.equal(rolledUp(inner, on), true);
  // The last tick marks the file; one untick clears the class, the namespace and the file.
  assert.deepEqual(fileAfterTick({ counted, ids: ['namespace:N>f'], viewed: true, fileViewed: false, isViewed: (id) => id !== 'namespace:N>f' && on(id) }).file, 'mark');
  ticked.delete('namespace:N>class:C>m');
  assert.equal(rolledUp(inner, on), false);
  assert.equal(rolledUp(namespace, on), false);
  assert.equal(fileAfterTick({ counted, ids: ['namespace:N>class:C>m'], viewed: false, fileViewed: true, isViewed: on }).file, 'unmark');
  // The scrolled-through ticks see the same items: a container is never among them.
  assert.ok(!counted.includes('namespace:N') && !counted.includes('namespace:N>class:C'));
});

void test("Reset viewed clears a view's files and ticks, and Undo puts back exactly those", async () => {
  const { viewedMarkKeys, symbolViewedKey, resetViewed, restoreViewed, markFileViewed, markSymbolsViewed, isFileViewed, isSymbolViewed, hasViewedMarks, wasSymbolUnticked } =
    await import('../lib/file-view-progress');
  // The pure part: which marks make the view's files read as viewed.
  const state = {
    aliases: { rev1: 'content-a', rev2: 'content-b' },
    marks: {
      'content-a': true,
      'content-b': false,
      [symbolViewedKey('content-a', 'function:f')]: true,
      [symbolViewedKey('rev2', 'class:C>@body')]: true,
      [symbolViewedKey('content-a', TOP_LEVEL_ID)]: true,
      // Another file, and another revision of a file of this view, under its own alias.
      'content-other': true,
      [symbolViewedKey('content-old', 'function:f')]: true,
    },
  };
  assert.deepEqual(viewedMarkKeys(state, ['rev1', 'rev2']).sort(), [
    'content-a',
    symbolViewedKey('content-a', TOP_LEVEL_ID),
    symbolViewedKey('content-a', 'function:f'),
    symbolViewedKey('rev2', 'class:C>@body'),
  ].sort());

  // Against the store: a marked file, a tick in another, an untick remembered, and a file outside the view.
  await markFileViewed('reset:a', true);
  await markSymbolsViewed('reset:b', ['function:g', 'function:h'], true);
  await markSymbolsViewed('reset:b', ['function:h'], false);
  await markFileViewed('reset:outside', true);
  assert.equal(hasViewedMarks(['reset:a', 'reset:b']), true);
  assert.equal(wasSymbolUnticked('reset:b', 'function:h'), true);
  const { snapshot } = resetViewed(['reset:a', 'reset:b']);
  assert.equal(isFileViewed('reset:a'), false);
  assert.equal(isSymbolViewed('reset:b', 'function:g'), false);
  assert.equal(wasSymbolUnticked('reset:b', 'function:h'), false, 'The session forgets its unticks too');
  assert.equal(isFileViewed('reset:outside'), true, 'Files outside the view keep their marks');
  assert.equal(hasViewedMarks(['reset:a', 'reset:b']), false, 'Nothing left: the button disables');
  await restoreViewed(snapshot);
  assert.equal(isFileViewed('reset:a'), true);
  assert.equal(isSymbolViewed('reset:b', 'function:g'), true);
  assert.equal(isSymbolViewed('reset:b', 'function:h'), false, 'Unticked before stays unticked');
  assert.equal(wasSymbolUnticked('reset:b', 'function:h'), true);
});
