import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveMark } from '../lib/moved-symbols-store';
import { reviewItems, type ChangedSymbol } from '../lib/symbol-outline';
import type { SyntaxDefinition } from '../lib/syntax-scope';
import { countedIds, moveMirrors } from '../lib/tree-symbol-review';
import { movedAwayIds, movedMirrorId, symbolTree } from '../lib/tree-symbols';

/** Moves and renames as one review item, the new copy (lib/tree-symbols.ts `movedAwayIds`). */

const OLD = '["https://github.com/o/r/pull/1","src/old.ts","b","h"]';
const NEW = '["https://github.com/o/r/pull/1","src/new.ts","b","h"]';
const definition = (name: string, start: number, end = start + 9): SyntaxDefinition => ({ kind: 'function', name, label: `${name}()`, crumb: `${name}()`, start, end, signatureEnd: start });
const symbol = (name: string, start: number, change: ChangedSymbol['change']): ChangedSymbol => ({
  id: `function:${name}`,
  change,
  definition: definition(name, start),
  side: change === 'removed' ? 'before' : 'after',
  parents: [],
  first: { side: change === 'removed' ? 'before' : 'after', line: start },
  added: change === 'removed' ? 0 : 10,
  deleted: change === 'removed' ? 10 : 0,
});
/** A move's mark as the file on `side` shows it, its other end in `otherFile` at `otherStart`. */
function mark(side: 'before' | 'after', name: string, start: number, otherFile: string, otherStart: number, { exact = true, renamed = false, otherName = name } = {}): MoveMark {
  return {
    side,
    kind: 'function',
    name,
    label: `${name}()`,
    start,
    end: start + 9,
    signatureEnd: start,
    other: {
      file: otherFile,
      url: 'https://github.com/o/r/pull/1',
      headSha: 'h',
      path: otherFile === OLD ? 'src/old.ts' : 'src/new.ts',
      diffPath: otherFile === OLD ? 'src/old.ts' : 'src/new.ts',
      side: side === 'before' ? 'after' : 'before',
      kind: 'function',
      name: otherName,
      label: `${otherName}()`,
      start: otherStart,
      end: otherStart + 9,
      signatureEnd: otherStart,
    },
    sameFile: otherFile === (side === 'before' ? OLD : NEW),
    exact,
    renamed,
    similarity: exact ? 1 : 0.8,
    commentsChanged: false,
  };
}
const ready = (nodes: ReturnType<typeof symbolTree>) => ({ state: 'ready' as const, nodes });

void test('an exact move is one item, the new copy; the old copy is none, and mirrors it', () => {
  const oldAll = [symbol('parse', 10, 'removed'), symbol('keep', 30, 'modified')];
  const oldMarks = [mark('before', 'parse', 10, NEW, 3)];
  const oldNodes = symbolTree(oldAll, oldAll, oldMarks);
  assert.deepEqual(countedIds(ready(oldNodes)), ['function:keep'], 'The old copy is no item');
  assert.deepEqual(moveMirrors(oldNodes).away, [movedMirrorId(10)]);
  const newAll = [symbol('parse', 3, 'added')];
  const newNodes = symbolTree(newAll, newAll, [mark('after', 'parse', 3, OLD, 10)]);
  assert.deepEqual(countedIds(ready(newNodes)), ['function:parse']);
  assert.deepEqual(moveMirrors(newNodes).into, { 'function:parse': { file: OLD, id: movedMirrorId(10) } }, 'Its tick ticks the old copy');
  // The outline lists the same items.
  assert.deepEqual(reviewItems(oldAll, new Set(), movedAwayIds(oldAll, oldMarks)).map((item) => item.id), ['function:keep']);
});

void test('a move with edits and a rename are one item too; an ambiguous match (no mark) leaves both', () => {
  const edited = [symbol('parse', 10, 'removed')];
  assert.deepEqual(countedIds(ready(symbolTree(edited, edited, [mark('before', 'parse', 10, NEW, 3, { exact: false })]))), []);
  // Renamed in the same file: the old name is no item, the new one is.
  const renamed = [symbol('load', 10, 'removed'), symbol('read', 12, 'added')];
  const marks = [mark('before', 'load', 10, OLD, 12, { renamed: true, otherName: 'read' }), mark('after', 'read', 12, OLD, 10, { renamed: true, otherName: 'load' })];
  assert.deepEqual(countedIds(ready(symbolTree(renamed, renamed, marks))), ['function:read']);
  assert.deepEqual(reviewItems(renamed, new Set(), movedAwayIds(renamed, marks)).map((item) => item.id), ['function:read']);
  // The matcher reports no move for one source with several destinations: both copies stay items.
  assert.deepEqual(countedIds(ready(symbolTree(renamed, renamed, []))), ['function:load', 'function:read']);
});

void test('ticking the new copy ticks the old one, and a deleted file whose content all moved becomes Viewed', async () => {
  const progress = await import('../lib/file-view-progress');
  const { markReviewSymbols, registerCountedSymbols } = await import('../lib/symbol-file-sync');
  // The old file is deleted: its one symbol moved. The new file has the new copy.
  const stopOld = registerCountedSymbols(OLD, () => ({ ids: [], away: [movedMirrorId(10)] }));
  const stopNew = registerCountedSymbols(NEW, () => ({ ids: ['function:parse', 'function:other'], into: { 'function:parse': { file: OLD, id: movedMirrorId(10) } } }));
  await markReviewSymbols(NEW, ['function:parse'], true);
  assert.equal(progress.isSymbolViewed(OLD, movedMirrorId(10)), true, 'The old copy reads viewed with the new one');
  assert.equal(progress.isFileViewed(OLD), true, 'Everything in the deleted file moved and is viewed: so is the file');
  assert.equal(progress.isFileViewed(NEW), false, 'The new file has more to review');
  // Unticking the new copy unticks the old, and the old file is unviewed again.
  await markReviewSymbols(NEW, ['function:parse'], false);
  assert.equal(progress.isSymbolViewed(OLD, movedMirrorId(10)), false);
  assert.equal(progress.isFileViewed(OLD), false);
  stopOld();
  stopNew();
});

void test('carry-over: a moved item carries by its new copy; a pair that breaks after a push is two items again', () => {
  // In the next revision the matcher finds no move: the old copy is an item of its own (it carries nothing, having
  // never been ticked under its own id), and the new copy carries by its own print as any item does.
  const oldAll = [symbol('parse', 10, 'removed')];
  assert.deepEqual(countedIds(ready(symbolTree(oldAll, oldAll, []))), ['function:parse']);
});
