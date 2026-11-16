import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  GAP_STEP,
  afterLines,
  diffGaps,
  gapContaining,
  gapSize,
  hunkSlices,
  hunksFromDiff,
  matchesAfter,
  revealGap,
  revealedParts,
  shownLines,
  shownSelection,
  type GapPart,
} from '../lib/diff-gaps';
import { diffGapFiles, diffGapsAfter, diffGapsBefore, hugeLines } from './fixtures/diff-gaps';

// Pierre is ESM only; this suite runs as CommonJS.
let pierre: typeof import('@pierre/diffs');
const pierreParse = (patch: string) => pierre.processFile(patch, { throwOnError: true });
const parse = (patch: string, status = 'modified') => {
  const added = status === 'added';
  const diff = pierre.processFile(
    `diff --git a/source b/source\n${added ? 'new file mode 100644\n' : ''}--- ${added ? '/dev/null' : 'a/source'}\n+++ b/source\n${patch}\n`,
    { throwOnError: true }
  );
  assert.ok(diff);
  return diff;
};
const must = <T>(value: T | undefined): T => {
  assert.ok(value !== undefined);
  return value;
};
const gapsFile = diffGapFiles[0];
let hunks: ReturnType<typeof hunksFromDiff>;
before(async () => {
  pierre = await import('@pierre/diffs');
  hunks = hunksFromDiff(parse(must(gapsFile.patch)));
});
const lines = afterLines(diffGapsAfter);
const range = (part: GapPart) => {
  if (part.kind === 'gap') return `gap ${part.start}-${part.end ?? '?'} (${part.hidden ?? '?'})`;
  const news = part.hunk.rows.filter((r) => r.type !== '-').length;
  return `hunk +${part.hunk.newStart}-${part.hunk.newStart + news - 1} -${part.hunk.oldStart}`;
};

void test('gaps come from the patch: before the first hunk, between hunks, and after the last', () => {
  assert.deepEqual(
    hunks.map((h) => [h.oldStart, h.newStart, h.rows.length]),
    [
      [47, 47, 9],
      [147, 148, 8],
    ]
  );
  assert.deepEqual(diffGaps(hunks), [
    { index: 0, newStart: 1, newEnd: 46, oldOffset: 0 },
    { index: 1, newStart: 55, newEnd: 147, oldOffset: -1 },
    // The file's length is unknown until the after text arrives.
    { index: 2, newStart: 155, newEnd: undefined, oldOffset: -1 },
  ]);
  const known = must(diffGaps(hunks, lines.length));
  assert.deepEqual(known[2], { index: 2, newStart: 155, newEnd: 201, oldOffset: -1 });
  assert.deepEqual(known.map(gapSize), [46, 93, 47]);
});

void test('a gap that hides a different number of lines on each side has nothing to reveal', () => {
  const broken = hunksFromDiff(parse('@@ -10,1 +10,1 @@\n-a\n+b\n@@ -20,1 +25,1 @@\n-c\n+d'));
  assert.equal(diffGaps(broken), undefined);
  assert.equal(diffGaps([]), undefined);
});

void test('zero-length sides name the line before them', () => {
  const inserted = hunksFromDiff(parse('@@ -5,0 +6,2 @@\n+x\n+y'));
  assert.deepEqual([inserted[0].oldStart, inserted[0].newStart], [6, 6]);
  assert.deepEqual(diffGaps(inserted, 10), [
    { index: 0, newStart: 1, newEnd: 5, oldOffset: 0 },
    { index: 1, newStart: 8, newEnd: 10, oldOffset: -2 },
  ]);
});

void test('a patch that ends without a line feed has no gap below it', () => {
  const end = hunksFromDiff(parse('@@ -3,2 +3,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file'));
  assert.equal(end[0].noEofNew, true);
  const gaps = must(diffGaps(end));
  assert.equal(gapSize(gaps[1]), 0);
  assert.equal(matchesAfter(end, ['1', '2', 'a', 'c']), true);
  assert.equal(matchesAfter(end, ['1', '2', 'a', 'c', 'extra']), false);
});

void test('the after text must agree with every new-side line of the patch', () => {
  assert.equal(matchesAfter(hunks, lines), true);
  assert.equal(matchesAfter(hunks, afterLines(diffGapsBefore)), false);
  const stale = [...lines];
  stale[148] = 'changed since';
  assert.equal(matchesAfter(hunks, stale), false);
  assert.deepEqual(afterLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(afterLines('a\r\nb'), ['a\r', 'b']);
});

void test('without the after text, reveals wait and the patch shows as it is', () => {
  const gaps = must(diffGaps(hunks));
  const reveals = revealGap({}, gaps[1], hunks.length, 'down');
  assert.deepEqual(revealedParts(hunks, gaps, reveals).map(range), [
    'gap 1-46 (46)',
    'hunk +47-54 -47',
    'gap 55-147 (93)',
    'hunk +148-154 -147',
    'gap 155-? (?)',
  ]);
});

void test('each click reveals 20 lines next to a hunk, numbering the old side by the gap offset', () => {
  const gaps = must(diffGaps(hunks, lines.length));
  let reveals = revealGap({}, gaps[1], hunks.length, 'down');
  assert.deepEqual(reveals, { 1: { down: GAP_STEP, up: 0 } });
  let parts = revealedParts(hunks, gaps, reveals, lines);
  assert.deepEqual(parts.map(range), [
    'gap 1-46 (46)',
    'hunk +47-74 -47',
    'gap 75-147 (73)',
    'hunk +148-154 -147',
    'gap 155-201 (47)',
  ]);
  reveals = revealGap(reveals, gaps[1], hunks.length, 'up');
  // The edges of the file reveal towards their only hunk, whichever way was asked.
  reveals = revealGap(reveals, gaps[0], hunks.length, 'down');
  reveals = revealGap(reveals, gaps[2], hunks.length, 'up');
  parts = revealedParts(hunks, gaps, reveals, lines);
  assert.deepEqual(parts.map(range), [
    'gap 1-26 (26)',
    'hunk +27-74 -27',
    'gap 75-127 (53)',
    'hunk +128-174 -127',
    'gap 175-201 (27)',
  ]);
  const shown = shownLines(parts);
  // New line 128 is old line 127: the first change added a line.
  assert.equal(shown.after.get(128), 'export const g127 = 127;');
  assert.equal(shown.before.get(127), 'export const g127 = 127;');
  assert.equal(shown.after.get(151), 'export const g150 = 1500;');
  assert.equal(shown.before.get(150), 'export const g150 = 150;');
  assert.equal(shown.after.has(100), false);
});

void test('revealing a whole gap joins the hunks around it', () => {
  const gaps = must(diffGaps(hunks, lines.length));
  const parts = revealedParts(hunks, gaps, revealGap({}, gaps[1], hunks.length, 'all'), lines);
  assert.deepEqual(parts.map(range), ['gap 1-46 (46)', 'hunk +47-154 -47', 'gap 155-201 (47)']);
  const all = gaps.reduce((r, gap) => revealGap(r, gap, hunks.length, 'all'), {});
  const whole = revealedParts(hunks, gaps, all, lines);
  assert.deepEqual(whole.map(range), ['hunk +1-201 -1']);
  const shown = shownLines(whole);
  assert.equal([...shown.after.values()].join('\n') + '\n', diffGapsAfter);
  assert.equal([...shown.before.values()].join('\n') + '\n', diffGapsBefore);
  // Small steps that meet in the middle also join, without revealing a line twice.
  let steps = {};
  for (let i = 0; i < 3; i++) steps = revealGap(revealGap(steps, gaps[1], hunks.length, 'down'), gaps[1], hunks.length, 'up');
  assert.deepEqual(revealedParts(hunks, gaps, steps, lines).map(range).slice(1, 2), ['hunk +47-154 -47']);
});

void test('gaps of up to 3 lines between hunks show their lines once the after text is known', () => {
  const many = hunksFromDiff(parse('@@ -2,1 +2,1 @@\n-a\n+A\n@@ -6,1 +6,1 @@\n-b\n+B\n@@ -20,1 +20,1 @@\n-c\n+C'));
  const text = Array.from({ length: 30 }, (_, i) => String(i + 1));
  text[1] = 'A';
  text[5] = 'B';
  text[19] = 'C';
  const gaps = must(diffGaps(many, text.length));
  assert.deepEqual(revealedParts(many, gaps, {}).map(range), [
    'gap 1-1 (1)',
    'hunk +2-2 -2',
    'gap 3-5 (3)',
    'hunk +6-6 -6',
    'gap 7-19 (13)',
    'hunk +20-20 -20',
    'gap 21-30 (10)',
  ]);
  // The 3-line gap joins its hunks; the edges of the file and longer gaps keep their bars.
  assert.deepEqual(revealedParts(many, gaps, {}, text).map(range), [
    'gap 1-1 (1)',
    'hunk +2-6 -2',
    'gap 7-19 (13)',
    'hunk +20-20 -20',
    'gap 21-30 (10)',
  ]);
});

void test('a jump finds the gap that hides its line on either side', () => {
  const gaps = must(diffGaps(hunks, lines.length));
  assert.equal(gapContaining(gaps, 'after', 100)?.index, 1);
  assert.equal(gapContaining(gaps, 'before', 146)?.index, 1);
  assert.equal(gapContaining(gaps, 'after', 147)?.index, 1);
  assert.equal(gapContaining(gaps, 'after', 50), undefined);
  assert.equal(gapContaining(gaps, 'after', 201)?.index, 2);
});

void test('long hunks render as 200-row slices that keep their source numbers', () => {
  const added = hunksFromDiff(parse(must(diffGapFiles[1].patch), 'added'));
  const slices = hunkSlices('h0', added[0], { name: 'zz/huge.ts', status: 'added' }, pierreParse);
  assert.equal(slices.length, 15);
  assert.deepEqual(slices[1].newLines, [201, 400]);
  assert.equal(slices[1].key, 'h0:1');
  assert.equal(slices[1].diff.name, 'zz/huge.ts');
  assert.equal(slices[1].diff.type, 'new');
  assert.equal(slices[1].unifiedRows, 200);
  assert.equal(slices[14].diff.additionLines.at(-1)?.replace(/\n$/, ''), hugeLines[2999]);
  assert.equal(slices[14].diff.hunks[0].additionStart, 2801);
  // A short hunk stays one diff with the hunk's own key.
  const short = hunkSlices('h1', hunks[1], { name: 'src/gaps.ts' }, pierreParse);
  assert.deepEqual(short.map((s) => [s.key, s.oldLines, s.newLines]), [['h1', [147, 153], [148, 154]]]);
  assert.equal(short[0].diff.hunks[0].deletionStart, 147);
});

void test('slices keep a missing final line feed', () => {
  const end = hunksFromDiff(parse('@@ -3,2 +3,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file'));
  const [slice] = hunkSlices('h0', end[0], { name: 'a.txt' }, pierreParse);
  assert.equal(slice.diff.hunks[0].noEOFCRAdditions, true);
  assert.equal(slice.diff.hunks[0].noEOFCRDeletions, true);
});

void test('whole-file diffs, without a patch, give the same gaps', () => {
  const diff = pierre.parseDiffFromFile(
    { name: 'src/gaps.ts', contents: diffGapsBefore },
    { name: 'src/gaps.ts', contents: diffGapsAfter },
    { context: 3 }
  );
  const whole = hunksFromDiff(diff);
  assert.deepEqual(diffGaps(whole, lines.length), diffGaps(hunks, lines.length));
  assert.equal(matchesAfter(whole, lines), true);
});

void test('a selection across hidden lines numbers each shown line', () => {
  const gaps = must(diffGaps(hunks, lines.length));
  const shown = shownLines(revealedParts(hunks, gaps, {}, lines));
  assert.equal(shownSelection(shown.after, 47, 49), 'export const g47 = 47;\nexport const g48 = 48;\nexport const g49 = 49;');
  assert.equal(shownSelection(shown.after, 54, 56), '54: export const g53 = 53;');
});
