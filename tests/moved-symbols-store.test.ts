import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMovesStore, MOVES_MAX_FILES, MOVES_PR_ENTRIES, type MovesWorker } from '../lib/moved-symbols-core';
import { movesFilePlan } from '../lib/moved-symbols-plan';
import { moveEditsLabel, moveNoteLines, movedLineKeys } from '../lib/moved-symbols-view';
import {
  moveEdits,
  patchMayMove,
  type FilePrints,
  type MovesResult,
  type SymbolMove,
  type SymbolPrint,
} from '../lib/moved-symbols';
import { settledSubscription } from '../lib/settled-subscription';
import type { SymbolsInput } from '../lib/syntax-scope';
import { fileRevisionKey, type PrChangeFile, type PrChanges, type PrFileSide } from '../lib/pr-changes';
import type { MoveMark } from '../lib/moved-symbols-core';
import type { GapPart } from '../lib/diff-gaps';

/**
 * The page's store of moved symbols (#398, lib/moved-symbols-core.ts), with the worker's two calls faked: what it reads
 * from, when it matches, what it keeps and what it lets go.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (n: number, head = 'head', files: PrChangeFile[] = []): PrChanges =>
  ({
    version: 1,
    url: `https://github.com/a/b/pull/${n}`,
    metadata: { baseSha: 'base', headSha: head },
    comparisonBase: 'base',
    files,
    fetchedAt: 0,
  }) as unknown as PrChanges;
const run = (sign: '+' | '-', n: number, at = 1) =>
  [
    `@@ -${at},${sign === '-' ? n : 0} +${at},${sign === '+' ? n : 0} @@`,
    ...Array.from({ length: n }, (_, i) => `${sign}line ${i}`),
  ].join('\n');
/** A modified file whose patch has two hunks, each removing a run of lines. */
const modified = (path: string): PrChangeFile => ({
  path,
  status: 'modified',
  additions: 0,
  deletions: 8,
  changeId: path,
  patch: `${run('-', 4, 1)}\n${run('-', 4, 20).replace('@@ -20,4 +20,0 @@', '@@ -20,4 +16,0 @@')}`,
});
const added = (path: string): PrChangeFile => ({
  path,
  status: 'added',
  additions: 4,
  deletions: 0,
  changeId: path,
  patch: run('+', 4),
});
const text = (content: string): PrFileSide => ({ kind: 'text', content });
const print = (start: number): SymbolPrint => ({
  kind: 'function',
  name: 'f',
  label: 'f()',
  start,
  end: start + 3,
  signatureEnd: start,
  tokens: 50,
  lines: 4,
  hash: 'h',
  sketch: new Uint32Array(),
  lineHashes: new Uint32Array(4),
  comments: 0,
});

/** A fake worker: every fingerprint read waits until the test answers it; matching moves `from` to `to`. */
function fakeWorker() {
  const reads: { key: string; input: SymbolsInput; resolve: (prints: FilePrints) => void }[] = [];
  let matches = 0;
  const worker: MovesWorker = {
    readSymbols: (request) => new Promise((resolve) => reads.push({ key: request.key, input: request.input, resolve })),
    readMoves: (files) => {
      matches++;
      const from = files.find((f) => f.prints.before.length),
        to = files.find((f) => f.prints.after.length);
      const end = (file: typeof from, side: 'before' | 'after') => ({
        file: file?.file ?? '',
        url: file?.url ?? '',
        headSha: file?.headSha ?? '',
        path: file?.path ?? '',
        diffPath: file?.path ?? '',
        side,
        kind: 'function' as const,
        name: 'f',
        label: 'f()',
        start: 1,
        end: 4,
        signatureEnd: 1,
      });
      const move: SymbolMove = {
        from: end(from, 'before'),
        to: end(to, 'after'),
        exact: true,
        renamed: false,
        similarity: 1,
        commentsChanged: false,
        lines: { before: Uint32Array.from([1, 2, 3, 4]), after: Uint32Array.from([1, 2, 3, 4]) },
      };
      return Promise.resolve({
        moves: [move],
        candidates: { before: 1, after: 1 },
        compared: 0,
        capped: false,
        ms: 0,
      } satisfies MovesResult);
    },
  };
  return { worker, reads, matches: () => matches };
}
const keyOf = (s: PrChanges, f: PrChangeFile) => fileRevisionKey(s.url, f.path, s.metadata.baseSha, s.metadata.headSha);
const allowed = () => true;
const nothing = () => undefined;

void test('A topic’s file with some of the hunks is fingerprinted from the PR’s whole patch', () => {
  const { worker, reads } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  const file = modified('src/a.ts');
  assert.equal(store.track([{ snapshot: pr, file }], allowed, nothing).length, 1, 'The file waits for its new side');
  // An Explanation topic's file: the same revision key, only the first hunk.
  const topic = { ...file, patch: file.patch?.split(/\n(?=@@)/)[0] };
  store.noteText(pr, topic, text('x\n'.repeat(20)));
  assert.equal(reads.length, 1);
  const input = reads[0].input;
  assert.ok(input.mode === 'modified', 'A modified file');
  assert.equal(input.hunks.length, 2, 'Both hunks of the PR’s patch');
});

function trackPair(store: ReturnType<typeof createMovesStore>, pr: PrChanges) {
  const from = modified('src/a.ts'),
    to = added('src/b.ts');
  store.track(
    [
      { snapshot: pr, file: from },
      { snapshot: pr, file: to },
    ],
    allowed,
    () => ({ after: text('x\n'.repeat(20)) })
  );
  return { from, to };
}
async function answer(reads: ReturnType<typeof fakeWorker>['reads']) {
  for (const read of reads.splice(0))
    read.resolve(read.input.mode === 'added' ? { before: [], after: [print(1)] } : { before: [print(1)], after: [] });
  await flush();
}

void test('A PR tracked again after it left shows each note once', async () => {
  const { worker, reads } = fakeWorker();
  let clock = 0;
  const store = createMovesStore(worker, () => ++clock);
  const pr = snapshot(1);
  const { to } = trackPair(store, pr);
  await answer(reads);
  assert.equal(store.peek(keyOf(pr, to))?.marks.length, 1);
  // Other PRs push it out, then it is tracked again.
  for (let n = 2; n <= MOVES_PR_ENTRIES + 1; n++)
    store.track([{ snapshot: snapshot(n), file: added('src/c.ts') }], allowed, nothing);
  assert.equal(store.peek(keyOf(pr, to)), undefined, 'It left whole, marks too');
  trackPair(store, pr);
  await answer(reads);
  assert.equal(store.peek(keyOf(pr, to))?.marks.length, 1, 'One note, not two');
});

void test('PRs leave least recently used first, and a PR still waiting for files is kept while used', async () => {
  const { worker, reads } = fakeWorker();
  let clock = 0;
  const store = createMovesStore(worker, () => ++clock);
  const waitingPr = snapshot(1);
  const { to } = trackPair(store, waitingPr);
  // Many files of other PRs, more than any file limit would hold; the waiting PR is used again in between.
  for (let n = 2; n <= MOVES_PR_ENTRIES + 10; n++) {
    store.track([{ snapshot: snapshot(n), file: added(`src/${n}.ts`) }], allowed, nothing);
    if (n % 5 === 0) trackPair(store, waitingPr);
  }
  await answer(reads);
  assert.equal(store.peek(keyOf(waitingPr, to))?.marks.length, 1, 'Its family still matched');
  const stats = store.stats();
  assert.equal(stats.prs.length, MOVES_PR_ENTRIES);
  assert.ok(!stats.prs.some((p) => p.url.endsWith('/2')), 'The least recently used PR left');
});

void test('A new head replaces the PR’s old revision, and the PR counts as used for the idle sweep', async () => {
  const { worker, reads } = fakeWorker();
  let clock = 100;
  const store = createMovesStore(worker, () => clock);
  const old = snapshot(1, 'head-1');
  const { to } = trackPair(store, old);
  await answer(reads);
  assert.equal(store.peek(keyOf(old, to))?.marks.length, 1);
  clock = 200;
  store.track([{ snapshot: snapshot(1, 'head-2'), file: added('src/b.ts') }], allowed, nothing);
  assert.equal(store.peek(keyOf(old, to)), undefined, 'The old head’s notes are gone');
  assert.equal(store.stats().prs.length, 1);
  const uses = new Map<string, number>();
  store.uses(uses);
  assert.equal(uses.get(old.url), 200);
});

void test('A file of a family whose language is off keeps the family from matching', async () => {
  const { worker, reads, matches } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  // JavaScript is off; TypeScript is on: one family, so the JavaScript file could hold a rival.
  const on = (path: string) => !path.endsWith('.js');
  store.track(
    [
      { snapshot: pr, file: modified('src/a.ts') },
      { snapshot: pr, file: added('src/b.ts') },
      { snapshot: pr, file: added('src/c.js') },
    ],
    on,
    () => ({ after: text('x\n'.repeat(20)) })
  );
  await answer(reads);
  assert.equal(matches(), 0);
  assert.equal(store.stats().prs[0].families[0].state, 'incomplete');
  assert.deepEqual(movesFilePlan({}, added('src/c.js'), on), {
    language: 'javascript',
    readable: false,
    reason: 'off',
  });
});

void test('Languages without functions are not planned, and do not count toward the file limit', () => {
  assert.equal(movesFilePlan({}, added('config/app.json'), allowed), undefined);
  assert.equal(movesFilePlan({}, added('config/app.yaml'), allowed), undefined);
  const { worker } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  const files = [
    ...Array.from({ length: MOVES_MAX_FILES + 1 }, (_, i) => ({ snapshot: pr, file: added(`config/${i}.json`) })),
    { snapshot: pr, file: added('src/a.ts') },
  ];
  store.track(files, allowed, nothing);
  assert.equal(store.stats().prs[0].skipped, false);
});

void test('A side with more candidates than it keeps refuses its family', async () => {
  const { worker, reads, matches } = fakeWorker();
  const store = createMovesStore(worker);
  trackPair(store, snapshot(1));
  for (const read of reads.splice(0))
    read.resolve(
      read.input.mode === 'added' ? { before: [], after: [print(1)], capped: true } : { before: [print(1)], after: [] }
    );
  await flush();
  assert.equal(matches(), 0);
  assert.equal(store.stats().prs[0].families[0].state, 'incomplete');
});

// ── Where a note sits, and which lines dim ──────────────────────────────────

const mark = (side: 'before' | 'after', start: number, kept: number[]): MoveMark =>
  ({ side, start, end: start + 3, edits: { changed: [], kept } }) as unknown as MoveMark;
const hunk = (oldStart: number, newStart: number, rows: string): GapPart =>
  ({
    kind: 'hunk',
    key: 'h0',
    hunk: { oldStart, newStart, rows: rows.split('').map((type) => ({ type, text: '' })) },
  }) as unknown as GapPart;

void test('A note sits under the line above its symbol only when that is the row right above it', () => {
  // Unified rows: context (new 10), three deleted rows, then the added symbol at new 11.
  const deletedAbove = hunk(10, 10, ' ---++++');
  const into = mark('after', 11, []);
  assert.equal(moveNoteLines([deletedAbove], [into]).get(into), 11, 'Deleted rows between: under its first line');
  const contextAbove = hunk(10, 10, ' ++++');
  assert.equal(moveNoteLines([contextAbove], [into]).get(into), 10, 'Context right above: under it');
  const outOf = mark('before', 11, []);
  assert.equal(moveNoteLines([hunk(10, 10, ' ----')], [outOf]).get(outOf), 10);
  assert.equal(moveNoteLines([hunk(20, 20, ' ++')], [into]).has(into), false, 'Not shown: no note');
});

void test('Only lines the body diff matched dim: a comment line added in the move keeps its colour', () => {
  // Lines 11–14: 12 is a comment the line diff skipped, so it is neither an edit nor kept.
  assert.deepEqual([...movedLineKeys([mark('after', 11, [11, 13, 14])])], ['a11', 'a13', 'a14']);
  assert.deepEqual([...movedLineKeys([mark('before', 5, [5])])], ['b5']);
});

// ── Second review ───────────────────────────────────────────────────────────

void test('A shown PR is the last to leave, and one that left while shown can be tracked again', async () => {
  const { worker, reads } = fakeWorker();
  let clock = 0;
  const store = createMovesStore(worker, () => ++clock);
  const shown = snapshot(1);
  const { to } = trackPair(store, shown);
  await answer(reads);
  for (let n = 2; n <= MOVES_PR_ENTRIES + 5; n++) {
    store.track([{ snapshot: snapshot(n), file: added('src/c.ts') }], allowed, nothing);
    // A mounted diff reads its marks on every render.
    assert.equal(store.peek(keyOf(shown, to))?.marks.length, 1, `Still shown after PR ${n}`);
  }
  const drops = store.drops();
  store.forget(new Set([shown.url]));
  assert.ok(store.drops() > drops, 'A drop is counted, so a view that shows the PR tracks it again');
});

void test('New Settings or another file list plan the PR again', () => {
  const { worker } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  const files = [
    { snapshot: pr, file: added('src/a.ts') },
    { snapshot: pr, file: added('src/b.js') },
  ];
  store.track(files, (path) => !path.endsWith('.js'), nothing, 'js-off');
  assert.equal(store.stats().prs[0].families[0].failed, 1, 'The JavaScript file is off');
  store.track(files, allowed, nothing, 'all-on');
  assert.equal(store.stats().prs[0].families[0].failed, 0, 'Turned on: planned again');
  store.track([...files, { snapshot: pr, file: added('src/c.ts') }], allowed, nothing, 'all-on');
  assert.equal(store.stats().prs[0].families[0].files, 3, 'A new file: planned again');
});

void test('A read refused or failed for good marks the family incomplete instead of waiting', async () => {
  const { worker, matches } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  const file = modified('src/a.ts');
  store.track(
    [
      { snapshot: pr, file },
      { snapshot: pr, file: added('src/b.ts') },
    ],
    allowed,
    nothing
  );
  store.failKey(keyOf(pr, file), 'This PR read as many files for structure as it may.');
  await flush();
  assert.equal(store.stats().prs[0].families[0].state, 'incomplete');
  assert.equal(matches(), 0);
});

void test('Marks are made when a view first shows the file: the line diff waits until then', async () => {
  const { worker, reads } = fakeWorker();
  const store = createMovesStore(worker);
  const pr = snapshot(1);
  const { to } = trackPair(store, pr);
  await answer(reads);
  const marks = store.peek(keyOf(pr, to))?.marks;
  assert.deepEqual(marks?.[0].edits, { changed: [], kept: [1, 2, 3, 4] });
  assert.equal(store.peek(keyOf(pr, to))?.marks, marks, 'Made once');
});

void test('Moved-symbol labels: exact moves by their tokens, comments on their own, long bodies not counted', () => {
  const label = (mark: Partial<MoveMark>) =>
    moveEditsLabel({ exact: false, renamed: false, commentsChanged: false, edits: { changed: [], kept: [] }, ...mark });
  assert.equal(label({ exact: true }), 'unchanged');
  assert.equal(label({ exact: true, renamed: true, edits: { changed: [3], kept: [] } }), 'body unchanged');
  assert.equal(label({ exact: true, edits: { changed: [3, 4], kept: [] } }), 'reformatted');
  assert.equal(
    label({ exact: true, commentsChanged: true }),
    'comments edited',
    'An exact move whose comments changed'
  );
  assert.equal(label({ exact: true, edits: undefined }), 'unchanged', 'Too long to diff, exact by its tokens');
  assert.equal(label({ exact: true, renamed: true, edits: undefined }), 'body unchanged');
  assert.equal(label({ edits: undefined }), 'too large to compare', 'Not every line edited');
  assert.equal(label({ edits: { changed: [1, 2], kept: [3] } }), '2 lines edited');
});

void test('A long body is not diffed: no edits, nothing dims', () => {
  const long = new Uint32Array(3000).map((_, i) => i + 1);
  const end = (start: number) => ({ start }) as SymbolMove['from'];
  assert.equal(moveEdits({ from: end(1), to: end(1), lines: { before: long, after: long } }), undefined);
  assert.deepEqual(
    [...movedLineKeys([{ side: 'after', start: 1, end: 3000, edits: undefined } as unknown as MoveMark])],
    []
  );
});

void test('Only marks with a note dim: a symbol whose first line is not shown keeps its colour', () => {
  const shown = mark('after', 11, [11, 12]);
  const hidden = mark('after', 40, [40, 41]);
  const notes = moveNoteLines([hunk(10, 10, ' ++++')], [shown, hidden]);
  assert.deepEqual([...movedLineKeys([...notes.keys()])], ['a11', 'a12']);
});

void test('A whole patch’s removed or added lines count, in any hunk: as permissive as the candidates', () => {
  // Three removed lines in three hunks: a candidate's changed lines can sit apart.
  const spread = ['@@ -1,1 +1,0 @@', '-a', '@@ -10,1 +9,0 @@', '-b', '@@ -20,1 +18,0 @@', '-c'].join('\n');
  assert.equal(patchMayMove(spread), true);
  assert.equal(patchMayMove(['@@ -1,2 +1,2 @@', '-a', '+b', ' c'].join('\n')), false);
});

void test('A subscription told at once (a hidden window) still hears the next change', () => {
  let emit = () => {};
  const subscribe = (listener: () => void) => {
    emit = listener;
    return () => {};
  };
  let heard = 0;
  // `when` runs at once, as whenSettled does in a hidden window.
  const stop = settledSubscription(subscribe, (run) => {
    run();
    return () => {};
  })(() => heard++);
  emit();
  emit();
  emit();
  assert.equal(heard, 3);
  stop();
});
