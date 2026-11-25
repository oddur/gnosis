import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffGaps,
  hiddenTargetText,
  markHidden,
  revealedParts,
  sealedGaps,
  type GapHunk,
  type HiddenChange,
} from '../lib/diff-gaps';
import { movedBody, outsideByFile, outsideLines, rangeBlockHunks, shortSliceNames, sliceOwners } from '../lib/explanation-ranges';
import { reviewGapHunks } from '../lib/review-gap-hunks';
import { sectionFileCounts } from '../lib/slide-file-groups';
import type { DiffHunk } from '../lib/types';

// One hunk of a.ts from old and new line 10, with five changes:
//   a (rows 2-3) and e (row 24) are section 1's, b (rows 9-10) is section 2's, D (row 17) no section shows.
const ROWS = [
  ' c1', ' c2', '-a', '+A', ' c3', ' c4', ' c5', ' c6', ' c7', '-b', '+B', ' c8', ' c9', ' c10', ' c11', ' c12', ' c13',
  '+D', ' c14', ' c15', ' c16', ' c17', ' c18', ' c19', '-e', ' c20',
];
const HUNK: DiffHunk = {
  filePath: 'a.ts',
  hunkHeader: '@@ -10,23 +10,23 @@ fn x',
  content: ROWS.join('\n'),
  language: 'typescript',
  renderedHtml: '',
};
const slice = (start: number, end: number, label: string, extra: Partial<DiffHunk> = {}): DiffHunk => ({
  ...HUNK,
  lineRanges: [{ start, end }],
  sliceId: `h1:${label}`,
  label,
  ...extra,
});
const A = slice(2, 3, 'fn a (impl S)');
const E = slice(24, 24, 'fn e');
const B = slice(9, 10, 'fn b (impl S)');
const SLIDES = [{ diffHunks: [A, E] }, { diffHunks: [B] }];

void test('an old explanation, with no ranges, renders its hunks as they are', () => {
  const hunks = [HUNK, { ...HUNK, filePath: 'b.ts' }];
  const ranged = rangeBlockHunks(hunks, { owners: sliceOwners(SLIDES), section: 1 });
  assert.equal(ranged.hunks, hunks);
  assert.deepEqual(ranged.hidden, []);
});

void test('slices of one hunk in a section merge into one block of ranges, with context as Changes shows it', () => {
  const ranged = rangeBlockHunks([A, E], { context: 3, owners: sliceOwners(SLIDES), section: 1 });
  assert.deepEqual(
    ranged.hunks.map((h) => [h.hunkHeader, h.content.split('\n')]),
    [
      ['@@ -10,6 +10,6 @@ fn x', ROWS.slice(0, 7)],
      // Context stops at the file's rows the hunk holds; the deleted row's new side ends before it.
      ['@@ -28,5 +29,4 @@ fn x', ROWS.slice(21, 26)],
    ]
  );
  // The slices' own fields stay on the entries; the cut hunks are plain.
  assert.ok(ranged.hunks.every((h) => !h.lineRanges && !h.sliceId && !h.label && !h.movedFrom));
  // Rows between the ranges that hold changes: b shows in section 2, D in no section.
  assert.deepEqual(ranged.hidden, [
    {
      oldStart: 18,
      oldEnd: 18,
      newStart: 18,
      newEnd: 18,
      target: { kind: 'section', section: 2, names: ['fn b'], line: 18 },
    },
    {
      oldStart: 25,
      oldEnd: 24,
      newStart: 25,
      newEnd: 25,
      target: { kind: 'outside', lines: 1, side: 'after', start: 25, end: 25 },
    },
  ]);
});

void test('a gap over changes left out names where each went, and is never unchanged context', () => {
  const ranged = rangeBlockHunks([A, E], { context: 3, owners: sliceOwners(SLIDES), section: 1 });
  const topic = reviewGapHunks(ranged.hunks, { context: 3 });
  const gaps = markHidden(diffGaps(topic.hunks, undefined, { partial: true }) ?? [], topic.hunks, ranged.hidden);
  const marked = gaps.filter((gap) => gap.hiddenIn);
  assert.equal(marked.length, 1, 'only the gap between the ranges holds them');
  assert.equal(marked[0].index, 1);
  assert.equal(marked[0].opaque, true);
  assert.deepEqual(marked[0].hiddenIn?.map(hiddenTargetText), ['fn b: section 2', '1 line left out']);
  // The gap above the first range is unchanged context, as in Changes.
  assert.equal(gaps[0].hiddenIn, undefined);
  assert.equal(gaps[0].opaque, undefined);
  const parts = revealedParts(topic.hunks, gaps, {});
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['gap', 'hunk', 'gap', 'hunk', 'gap']
  );
});

void test('section 2 sees section 1’s slices and the left-out code around its own', () => {
  const ranged = rangeBlockHunks([B], { context: 3, owners: sliceOwners(SLIDES), section: 2 });
  assert.deepEqual(
    ranged.hunks.map((h) => h.hunkHeader),
    ['@@ -15,7 +15,7 @@ fn x']
  );
  assert.deepEqual(
    ranged.hidden.map((h) => [h.target.kind, hiddenTargetText(h.target)]),
    [
      ['section', 'fn a: section 1'],
      ['outside', '1 line left out'],
      ['section', 'fn e: section 1'],
    ]
  );
});

void test('targets in one gap merge per section and for the left-out code', () => {
  const change = (newStart: number, target: HiddenChange['target']): HiddenChange => ({
    oldStart: newStart,
    oldEnd: newStart,
    newStart,
    newEnd: newStart,
    target,
  });
  const hunks: GapHunk[] = [
    { oldStart: 1, newStart: 1, rows: [{ type: '+', text: 'x' }], noEofOld: false, noEofNew: false },
    { oldStart: 30, newStart: 31, rows: [{ type: ' ', text: 'y' }], noEofOld: false, noEofNew: false },
  ];
  const gaps = markHidden(diffGaps(hunks, undefined, { partial: true }) ?? [], hunks, [
    change(5, { kind: 'section', section: 3, names: ['fn supersede'], line: 5 }),
    change(8, { kind: 'outside', lines: 30, side: 'after', start: 8, end: 20 }),
    change(22, { kind: 'section', section: 3, names: ['fn adopt'] }),
    change(25, { kind: 'outside', lines: 10, side: 'after', start: 25, end: 27 }),
  ]);
  const targets = gaps[1].hiddenIn ?? [];
  assert.deepEqual(targets.map(hiddenTargetText), ['fn supersede, fn adopt: section 3', '40 lines left out']);
  assert.deepEqual(targets[1], { kind: 'outside', lines: 40, side: 'after', start: 8, end: 27 });
  assert.equal(
    hiddenTargetText({ kind: 'section', section: 4, names: ['a', 'b', 'c', 'd', 'e'] }),
    'a, b, c, 2 more: section 4'
  );
});

void test('a moved definition’s old lines point to the section that shows its new copy', () => {
  const moved = slice(0, 0, 'fn e2', {
    filePath: 'b.ts',
    movedFrom: { filePath: 'a.ts', startLine: 31, endLine: 31, body: 'identical' },
  });
  const owners = sliceOwners([{ diffHunks: [A] }, { diffHunks: [moved] }]);
  const ranged = rangeBlockHunks([A], { context: 3, owners, section: 1 });
  const e = ranged.hidden.find((h) => h.oldStart === 31);
  assert.deepEqual(e?.target, { kind: 'section', section: 2, names: ['fn e2'] });
  // Nothing claims b or D here: they are left out, never unchanged context.
  assert.ok(ranged.hidden.filter((h) => h !== e).every((h) => h.target.kind === 'outside'));
});

void test('an entry without ranges, or with ranges out of the hunk, shows the whole hunk', () => {
  const whole = rangeBlockHunks([A, HUNK], { owners: sliceOwners(SLIDES), section: 1 });
  assert.deepEqual(whole.hunks, [A, HUNK]);
  assert.deepEqual(whole.hidden, []);
  const broken = slice(20, 40, 'fn z');
  assert.deepEqual(rangeBlockHunks([broken]).hunks, [broken]);
});

void test('header counts count only the lines a section shows', () => {
  const ranged = rangeBlockHunks([A, E], { context: 3, owners: sliceOwners(SLIDES), section: 1 });
  assert.deepEqual(sectionFileCounts(ranged.hunks, { additions: 3, deletions: 3 }), {
    additions: 1,
    deletions: 2,
    file: { additions: 3, deletions: 3 },
  });
  // Section 2 shows b alone.
  const two = rangeBlockHunks([B], { context: 3, owners: sliceOwners(SLIDES), section: 2 });
  assert.deepEqual(sectionFileCounts(two.hunks, { additions: 3, deletions: 3 }), {
    additions: 1,
    deletions: 1,
    file: { additions: 3, deletions: 3 },
  });
  // Without ranges, the whole hunk counts, as before.
  assert.deepEqual(sectionFileCounts([HUNK], { additions: 3, deletions: 3 }), { additions: 3, deletions: 3 });
});

void test('an added file’s slices hide the code between them in sealed gaps that reveal nothing', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`);
  const added: DiffHunk = { ...HUNK, hunkHeader: '@@ -0,0 +1,12 @@', content: lines.join('\n') };
  const first = { ...added, lineRanges: [{ start: 0, end: 2 }], label: 'fn one' };
  const last = { ...added, lineRanges: [{ start: 9, end: 11 }], label: 'fn three' };
  const middle = { ...added, lineRanges: [{ start: 3, end: 8 }], label: 'fn two' };
  const ranged = rangeBlockHunks([first, last], {
    owners: sliceOwners([{ diffHunks: [first, last] }, { diffHunks: [middle] }]),
    section: 1,
  });
  assert.deepEqual(
    ranged.hunks.map((h) => h.hunkHeader),
    ['@@ -0,0 +1,3 @@', '@@ -0,0 +10,3 @@']
  );
  const topic = reviewGapHunks(ranged.hunks, { status: 'added' });
  const gaps = markHidden(sealedGaps(topic.hunks) ?? [], topic.hunks, ranged.hidden);
  const marked = gaps.filter((gap) => gap.hiddenIn);
  assert.equal(marked.length, 1);
  assert.deepEqual(marked[0].hiddenIn?.map(hiddenTargetText), ['fn two: section 2']);
  assert.equal(marked[0].revealDown, 0);
  assert.equal(marked[0].revealUp, 0);
  // The gap below the last slice is empty: no "more lines" bar under an added file.
  assert.deepEqual(
    revealedParts(topic.hunks, gaps, {}).map((p) => p.kind),
    ['hunk', 'gap', 'hunk']
  );
});

void test('a deleted file’s hidden changes find their gap by their old lines', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({ type: '-' as const, text: 'x' }));
  const hunks: GapHunk[] = [
    { oldStart: 1, newStart: 1, rows: rows(3), noEofOld: false, noEofNew: false },
    { oldStart: 10, newStart: 1, rows: rows(2), noEofOld: false, noEofNew: false },
  ];
  const gaps = markHidden(sealedGaps(hunks) ?? [], hunks, [
    { oldStart: 5, oldEnd: 7, newStart: 1, newEnd: 0, target: { kind: 'outside', lines: 3, side: 'before', start: 5, end: 7 } },
  ]);
  assert.deepEqual(
    gaps.map((gap) => !!gap.hiddenIn),
    [false, true, false]
  );
  assert.deepEqual(
    revealedParts(hunks, gaps, {}).map((p) => p.kind),
    ['hunk', 'gap', 'hunk']
  );
});

void test('labels, left-out lines and moved bodies', () => {
  assert.deepEqual(shortSliceNames('fn supersede (impl EntityDrainState), fn adopt (impl X)'), ['fn supersede', 'fn adopt']);
  assert.deepEqual(shortSliceNames('function outer() (part)'), ['function outer() (part)']);
  assert.deepEqual(shortSliceNames('a, b, c and 2 more'), ['a', 'b', 'c']);
  assert.deepEqual(outsideLines({ oldLines: [{ start: 9, end: 11 }], newLines: [], additions: 0 }), {
    side: 'before',
    start: 9,
    end: 11,
    label: 'old L9–11',
  });
  assert.deepEqual(
    outsideLines({ oldLines: [{ start: 9, end: 9 }], newLines: [{ start: 120, end: 130 }, { start: 140, end: 148 }], additions: 4 }),
    { side: 'after', start: 120, end: 148, label: 'L120–148' }
  );
  const code = (filePath: string, id: string) => ({ filePath, id, label: id, oldLines: [], newLines: [], additions: 1, deletions: 0 });
  assert.deepEqual(
    outsideByFile([code('b.ts', '1'), code('a.ts', '2'), code('b.ts', '3')]).map((f) => [f.filePath, f.code.map((c) => c.id)]),
    [
      ['a.ts', ['2']],
      ['b.ts', ['1', '3']],
    ]
  );
  assert.deepEqual(movedBody(slice(8, 12, 'fn b')), { text: 'c7\nB\nc8\nc9\n', start: 17 });
});
