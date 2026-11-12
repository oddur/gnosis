import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prepareReviewHunk,
  reviewContextRanges,
  sliceReviewHunk,
  diffContextLines,
  DEFAULT_DIFF_APPEARANCE,
  CODE_LINE_HEIGHT,
  HUNK_SLICE_LIMIT,
  estimateCodeColumnHeight,
  estimateFileBlockHeight,
  estimateHunkBlockHeight,
  reviewHunkSlices,
} from '../lib/review-diff';
import type { DiffHunk } from '../lib/types';
const hunk = (hunkHeader: string, content: string, filePath = 'src/file.ts'): DiffHunk => ({
  hunkHeader,
  content,
  filePath,
  language: 'typescript',
  renderedHtml: '',
});

void test('saved added/deleted files override expanded nonzero hunk headers', () => {
  for (const status of ['added', 'deleted'] as const) {
    const result = prepareReviewHunk(
      hunk('@@ -1,1 +1,3 @@', `${status === 'added' ? '+' : '-'}const x = 1;\n `),
      status
    );
    assert.ok(result);
    assert.equal(result.singleSide, true);
    assert.equal(result.lines[1].text, '');
    assert.equal(result.lines[1].lineNumber, 2);
    assert.equal(result.lines[1].type, status === 'added' ? 'add' : 'remove');
    assert.match(result.patch, status === 'added' ? /--- \/dev\/null/ : /\+\+\+ \/dev\/null/);
  }
});
void test('partial insertions are not misclassified as whole new files', () => {
  const result = prepareReviewHunk(hunk('@@ -40,0 +41,2 @@', '+first\n+second'));
  assert.ok(result);
  assert.equal(result.singleSide, false);
  assert.equal(result.lines[0].headLineNumber, 41);
  assert.match(result.patch, /@@ -40,0 \+41,2 @@/);
});
void test('markerless saved code retains blank lines and coordinates', () => {
  const result = prepareReviewHunk(hunk('@@ -20,3 +30,3 @@', 'const first = 1;\n\nconst last = 2;'));
  assert.ok(result);
  assert.deepEqual(
    result.lines.map((l) => [l.baseLineNumber, l.headLineNumber, l.text]),
    [
      [20, 30, 'const first = 1;'],
      [21, 31, ''],
      [22, 32, 'const last = 2;'],
    ]
  );
});
void test('no-newline metadata does not become code or break change classification', () => {
  const result = prepareReviewHunk(
    hunk('@@ -2 +2 @@', '-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file')
  );
  assert.ok(result);
  assert.deepEqual(
    result.lines.map((l) => [l.type, l.text]),
    [
      ['remove', 'old'],
      ['add', 'new'],
    ]
  );
});
void test('disjoint selected hunks preserve source numbers and stack-qualified paths', () => {
  for (const path of ['PR #12/src/a file.ts', 'PR #13/src/a file.ts']) {
    for (const line of [2, 80]) {
      const result = prepareReviewHunk(hunk(`@@ -${line},1 +${line},1 @@`, '-before\n+after', path));
      assert.ok(result);
      assert.ok(!result.patch.includes(path), 'patch parsing cannot confuse paths with patch metadata');
      assert.deepEqual(
        result.lines.map((l) => l.lineNumber),
        [line, line]
      );
    }
  }
});
void test('unparseable and contradictory cached content uses the legacy fallback', () => {
  assert.equal(prepareReviewHunk(hunk('invalid', '+code')), null);
  assert.equal(prepareReviewHunk(hunk('@@ -1 +1 @@', '-old\n+new'), 'added'), null);
});

void test('folds unchanged lines around changes and reveals only saved context', () => {
  const original = hunk(
    '@@ -50,31 +70,31 @@',
    Array.from({ length: 31 }, (_, i) => (i === 10 ? '-old\n+new' : ` context ${i}`)).join('\n')
  );
  const data = prepareReviewHunk(original);
  assert.ok(data);
  const ranges = reviewContextRanges(data.lines);
  assert.deepEqual(ranges, [
    { start: 0, end: 7, hidden: true },
    { start: 7, end: 15, hidden: false },
    { start: 15, end: 32, hidden: true },
  ]);
  const excerpt = sliceReviewHunk(original, data.lines, 7, 15);
  assert.equal(excerpt.hunkHeader, '@@ -57,7 +77,7 @@');
  const parsed = prepareReviewHunk(excerpt);
  assert.ok(parsed);
  assert.equal(parsed.lines[3].baseLineNumber, 60);
  assert.equal(parsed.lines[4].headLineNumber, 80);
  assert.deepEqual(reviewContextRanges(data.lines, new Set(), new Set(data.lines.map((_, i) => i))), [
    { start: 0, end: 32, hidden: false },
  ]);
});

void test('pins commented and referenced context and leaves context-only snippets intact', () => {
  const data = prepareReviewHunk(
    hunk('@@ -1,30 +1,30 @@', Array.from({ length: 30 }, (_, i) => (i === 15 ? '+' : ' ') + `line ${i}`).join('\n'))
  );
  assert.ok(data);
  const ranges = reviewContextRanges(data.lines, new Set([1, 28]));
  for (const line of [1, 15, 28]) assert.ok(ranges.some((r) => !r.hidden && r.start <= line && r.end > line));
  assert.deepEqual(reviewContextRanges(data.lines.filter((l) => l.type === 'context')), [
    { start: 0, end: 29, hidden: false },
  ]);
});

void test('surrounding-line preferences preserve source coordinates and pinned review annotations', () => {
  const original = hunk(
    '@@ -50,31 +70,31 @@',
    Array.from({ length: 31 }, (_, i) => (i === 10 ? '-old\n+new' : ` context ${i}`)).join('\n')
  );
  const prepared = prepareReviewHunk(original);
  assert.ok(prepared);
  for (const count of [1, 3, 5, 10, 20, 50]) {
    const ranges = reviewContextRanges(prepared.lines, new Set([0]), new Set(), count);
    assert.ok(
      ranges.some((r) => !r.hidden && r.start === 0),
      'Pinned lines must remain visible'
    );
    const visible: ReturnType<typeof reviewContextRanges> = reviewContextRanges(prepared.lines, new Set(), new Set(), count).filter((r) => !r.hidden);
    assert.equal(
      visible.reduce((sum, r) => sum + r.end - r.start, 0),
      Math.min(count, 10) + Math.min(count, 20) + 2
    );
    const excerpt = sliceReviewHunk(original, prepared.lines, visible[0].start, visible[0].end);
    const parsed = prepareReviewHunk(excerpt);
    assert.ok(parsed);
    assert.equal(parsed.lines.find((l) => l.type === 'add')?.headLineNumber, 80);
    assert.equal(parsed.lines.find((l) => l.type === 'remove')?.baseLineNumber, 60);
  }
  assert.equal(diffContextLines(), 3);
  assert.equal(diffContextLines({ ...DEFAULT_DIFF_APPEARANCE, contextLines: NaN }), 3);
  assert.equal(diffContextLines({ ...DEFAULT_DIFF_APPEARANCE, contextLines: 10 }), 10);
});

void test('long visible ranges split into 200-line slices that keep source line numbers', () => {
  assert.deepEqual(reviewHunkSlices(0, HUNK_SLICE_LIMIT), [[0, HUNK_SLICE_LIMIT]]);
  assert.deepEqual(reviewHunkSlices(10, 511), [
    [10, 210],
    [210, 410],
    [410, 511],
  ]);
  // A 3,000-line added file: each slice is its own diff, numbered from where it starts in the file.
  const added = hunk('@@ -0,0 +1,3000 @@', Array.from({ length: 3000 }, (_, i) => `+line ${i + 1}`).join('\n'));
  const prepared = prepareReviewHunk(added, 'added');
  assert.ok(prepared?.singleSide);
  const slices = reviewHunkSlices(0, prepared.lines.length).map(([start, end]) =>
    prepareReviewHunk(sliceReviewHunk(added, prepared.lines, start, end), 'added')
  );
  assert.equal(slices.length, 15);
  assert.equal(slices[0]?.lines[0].headLineNumber, 1);
  assert.equal(slices[7]?.lines[0].headLineNumber, 1401);
  assert.equal(slices[7]?.lines[0].text, 'line 1401');
  assert.equal(slices[14]?.lines.at(-1)?.headLineNumber, 3000);
  assert.ok(slices.every((slice) => slice?.singleSide && slice.lines.every((l) => l.type === 'add')));
  assert.match(slices[7]?.patch ?? '', /@@ -0,0 \+1401,200 @@/);
  // Annotations route by line number, so the slice that owns line 1450 is the one that shows it.
  const owner = slices.findIndex((slice) => slice?.lines.some((l) => l.headLineNumber === 1450));
  assert.equal(owner, 7);
  // A modified hunk keeps both sides' numbers across a slice seam.
  const modified = hunk(
    '@@ -100,400 +200,401 @@',
    Array.from({ length: 400 }, (_, i) => (i === 250 ? '-old\n+new\n+extra' : ` same ${i}`)).join('\n')
  );
  const lines = prepareReviewHunk(modified)?.lines ?? [];
  const second = prepareReviewHunk(sliceReviewHunk(modified, lines, 200, 400));
  assert.ok(second);
  assert.equal(second.lines[0].baseLineNumber, 300);
  assert.equal(second.lines[0].headLineNumber, 400);
  assert.equal(second.lines.find((l) => l.type === 'add')?.headLineNumber, 450);
});

void test('placeholder heights follow the shown rows, folded context and collapsed files', () => {
  assert.equal(estimateHunkBlockHeight(10), 10 * CODE_LINE_HEIGHT + 8);
  const added = hunk('@@ -0,0 +1,100 @@', Array.from({ length: 100 }, (_, i) => `+${i}`).join('\n'));
  assert.equal(estimateFileBlockHeight([added], { status: 'added' }), 48 + 100 * CODE_LINE_HEIGHT + 8);
  assert.equal(estimateFileBlockHeight([added], { status: 'added', expanded: false }), 48);
  // One change in 41 lines shows 3 lines either side; the two folded runs count as bars.
  const folded = hunk(
    '@@ -1,41 +1,41 @@',
    Array.from({ length: 41 }, (_, i) => (i === 20 ? '-a\n+b' : ` c${i}`)).join('\n')
  );
  assert.equal(estimateFileBlockHeight([folded]), Math.round(48 + (8 + 3) * CODE_LINE_HEIGHT + 8));
  const column = estimateCodeColumnHeight([added, { ...folded, filePath: 'other.ts' }], {
    viewed: (path) => path === 'other.ts',
  });
  assert.equal(column, 80 + 20 + (48 + 100 * CODE_LINE_HEIGHT + 8) + 20 + 48);
});
