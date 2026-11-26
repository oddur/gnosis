import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNames, callerCoverage, findCallers, itemCalls, peekHunks, type CallerFile } from '../lib/review-peek';
import type { ChangedSymbol } from '../lib/symbol-outline';
import type { SyntaxDefinition } from '../lib/syntax-scope';
import { FILE_STOP } from '../lib/tree-symbol-review';
import { symbolTree } from '../lib/tree-symbols';

/** Peek at a symbol: its own hunks, and its changed callers (lib/review-peek.ts). */

const definition = (name: string, start: number, end: number): SyntaxDefinition => ({ kind: 'function', name, label: name, crumb: name, start, end, signatureEnd: start });
const symbol = (name: string, start: number, end: number, change: ChangedSymbol['change'] = 'modified'): ChangedSymbol => ({
  id: `function:${name}`,
  change,
  definition: definition(name, start, end),
  side: 'after',
  parents: [],
  first: { side: 'after', line: start },
  added: 1,
  deleted: 0,
});

void test('a line calls the names right before a parenthesis, not in comments, strings or keywords', () => {
  assert.deepEqual(callNames('  const n = flush(queue) + store.size();'), ['flush', 'size']);
  assert.deepEqual(callNames('// flush() is gone'), []);
  assert.deepEqual(callNames('log("flush()")'), ['log']);
  assert.deepEqual(callNames('if (ready) return start(1);'), ['start']);
  assert.deepEqual(callNames('const x = new Queue<number>();'), ['Queue']);
});

void test("a peek shows the item's own hunks: by its lines, or by its definition on its side", () => {
  const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -10,2 +10,3 @@', ' x', '+y', ' z'].join('\n');
  assert.deepEqual(peekHunks(patch, { keys: ['a11'] }).map((hunk) => hunk.header), ['@@ -10,2 +10,3 @@']);
  // A definition on the new side, lines 1 to 2: its rows only, the deleted line among them kept, the line after it not.
  assert.deepEqual(peekHunks(patch, { side: 'after', start: 1, end: 2 }), [{ header: '@@ -1,2 +1,2 @@', content: [' a', '-b', '+B'].join('\n') }]);
  // A method inside a hunk that also holds the imports above it and the next method below: only the method.
  const big = ['@@ -1,9 +1,9 @@', " import 'a';", " import 'b';", ' class S {', '   f() {', '-    return 1;', '+    return 2;', '   }', '   g() {', '   }'].join('\n');
  assert.deepEqual(peekHunks(big, { side: 'after', start: 4, end: 6 }), [
    { header: '@@ -4,3 +4,3 @@', content: ['   f() {', '-    return 1;', '+    return 2;', '   }'].join('\n') },
  ]);
  assert.equal(peekHunks(patch).length, 2, 'A file: every hunk');
  assert.deepEqual(peekHunks(undefined), []);
});

const file = (key: string, symbols: ChangedSymbol[], lines: Record<string, string[]>, rows: Record<string, string>): CallerFile => ({
  key,
  nodes: symbolTree(symbols),
  calls: itemCalls(new Map(Object.entries(lines)), new Map(Object.entries(rows))),
});

void test('callers: a changed line calling a name defined by one changed symbol, across files', () => {
  const store = file('src/store.ts', [symbol('flush', 1, 5), symbol('drain', 10, 14)], { 'function:flush': ['a2'], 'function:drain': ['a11'] }, { a2: 'return 1;', a11: 'flush();' });
  // tasks.ts's start calls flush on a changed line; stop calls it only on an unchanged line, which it does not list.
  const tasks = file('src/tasks.ts', [symbol('start', 1, 3), symbol('stop', 5, 7)], { 'function:start': ['a2'], 'function:stop': ['a6'] }, { a2: '  flush(); // go', a6: '  return 0;' });
  const result = findCallers({ key: 'src/store.ts', id: 'function:flush' }, [store, tasks]);
  assert.ok(result.kind === 'callers');
  assert.deepEqual(result.callers.map((caller) => `${caller.key}:${caller.id}`), ['src/store.ts:function:drain', 'src/tasks.ts:function:start']);
  // An added caller: all of its lines are changed lines, so a call anywhere in it counts.
  const added = file('src/new.ts', [symbol('boot', 1, 4, 'added')], { 'function:boot': ['a1', 'a2', 'a3', 'a4'] }, { a3: 'drain();' });
  const drains = findCallers({ key: 'src/store.ts', id: 'function:drain' }, [store, tasks, added]);
  assert.deepEqual(drains.kind === 'callers' && drains.callers.map((caller) => caller.id), ['function:boot']);
  // No callers: said so.
  const none = findCallers({ key: 'src/tasks.ts', id: 'function:stop' }, [store, tasks]);
  assert.deepEqual(none, { kind: 'callers', callers: [] });
});

void test('a name defined by several changed symbols matches nothing; the top level and files have no callers', () => {
  const a = file('a.ts', [symbol('run', 1, 3)], {}, {});
  const b = file('b.ts', [symbol('run', 1, 3), symbol('go', 5, 7)], { 'function:go': ['a6'] }, { a6: 'run();' });
  assert.deepEqual(findCallers({ key: 'a.ts', id: 'function:run' }, [a, b]), { kind: 'ambiguous' });
  assert.deepEqual(findCallers({ key: 'a.ts', id: '@top' }, [a, b]), { kind: 'none' });
  assert.deepEqual(findCallers({ key: 'a.ts', id: FILE_STOP }, [a, b]), { kind: 'none' });
});

void test('coverage counts the files read, of those that can list symbols', () => {
  assert.deepEqual(callerCoverage(['ready', 'loading', 'none', undefined]), { checked: 2, total: 4 });
});
