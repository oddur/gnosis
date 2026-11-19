import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReviewHunk, diffContextLines, DEFAULT_DIFF_APPEARANCE, CODE_LINE_HEIGHT } from '../lib/review-diff';
import {
  FILE_HEADER,
  HUNK_BAR,
  TRAILING_BAR,
  estimateCodeColumnHeight,
  estimateFileBlockHeight,
  reviewGapHunks,
} from '../lib/review-gap-hunks';
import { SLICE_CHROME } from '../lib/diff-gaps';
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

void test('a topic folds unchanged lines around changes, keeping source numbers (#157 parity)', () => {
  const original = hunk(
    '@@ -50,31 +70,31 @@',
    Array.from({ length: 31 }, (_, i) => (i === 10 ? '-old\n+new' : ` context ${i}`)).join('\n')
  );
  const topic = reviewGapHunks([original]);
  assert.deepEqual(
    topic.hunks.map((h) => [h.oldStart, h.newStart, h.rows.length]),
    [[57, 77, 8]]
  );
  assert.equal(topic.hunks[0].rows[3].type, '-');
  // Every saved new line is known, so the gaps around the change reveal without a read.
  assert.equal(topic.known[69], ' context 0'.slice(1));
  assert.equal(topic.known[99], 'context 30');
  assert.equal(topic.known[68], undefined);
});

void test('pins commented and referenced context and leaves context-only snippets intact', () => {
  const saved = hunk('@@ -1,30 +1,30 @@', Array.from({ length: 30 }, (_, i) => (i === 15 ? '+' : ' ') + `line ${i}`).join('\n'));
  const topic = reviewGapHunks([saved], { pins: [{ line: 2 }, { line: 29, side: 'RIGHT' }] });
  const shown = (line: number) => topic.hunks.some((h) => h.newStart <= line && line < h.newStart + h.rows.filter((r) => r.type !== '-').length);
  for (const line of [2, 16, 29]) assert.ok(shown(line), `line ${line} shows`);
  assert.equal(shown(10), false);
  const context = reviewGapHunks([hunk('@@ -1,29 +1,29 @@', Array.from({ length: 29 }, (_, i) => ` line ${i}`).join('\n'))]);
  assert.deepEqual(context.hunks.map((h) => h.rows.length), [29]);
});

void test('surrounding-line preferences preserve source coordinates and pinned review annotations', () => {
  const original = hunk(
    '@@ -50,31 +70,31 @@',
    Array.from({ length: 31 }, (_, i) => (i === 10 ? '-old\n+new' : ` context ${i}`)).join('\n')
  );
  for (const count of [1, 3, 5, 10, 20, 50]) {
    const pinned = reviewGapHunks([original], { context: count, pins: [{ line: 70 }] });
    assert.equal(pinned.hunks[0].newStart, 70, 'Pinned lines must remain visible');
    const topic = reviewGapHunks([original], { context: count });
    assert.equal(
      topic.hunks.reduce((sum, h) => sum + h.rows.length, 0),
      Math.min(count, 10) + Math.min(count, 20) + 2
    );
    const first = topic.hunks[0];
    let newLine = first.newStart,
      oldLine = first.oldStart;
    for (const row of first.rows) {
      if (row.type === '+') assert.equal(newLine, 80);
      if (row.type === '-') assert.equal(oldLine, 60);
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  }
  assert.equal(diffContextLines(), 3);
  assert.equal(diffContextLines({ ...DEFAULT_DIFF_APPEARANCE, contextLines: NaN }), 3);
  assert.equal(diffContextLines({ ...DEFAULT_DIFF_APPEARANCE, contextLines: 10 }), 10);
});

void test('placeholder heights follow what Changes renders: rows, slices, bars and collapsed files', () => {
  const added = hunk('@@ -0,0 +1,100 @@', Array.from({ length: 100 }, (_, i) => `+${i}`).join('\n'));
  // An added file is one hunk with no bars, as in Changes.
  assert.equal(estimateFileBlockHeight([added], { status: 'added' }), FILE_HEADER + 100 * CODE_LINE_HEIGHT + SLICE_CHROME);
  assert.equal(estimateFileBlockHeight([added], { status: 'added', expanded: false }), FILE_HEADER);
  // One change in 41 lines shows 3 lines either side under a hunk header, then the trailing bar.
  const folded = hunk(
    '@@ -1,41 +1,41 @@',
    Array.from({ length: 41 }, (_, i) => (i === 20 ? '-a\n+b' : ` c${i}`)).join('\n')
  );
  assert.equal(
    estimateFileBlockHeight([folded]),
    Math.round(FILE_HEADER + HUNK_BAR + 8 * CODE_LINE_HEIGHT + SLICE_CHROME + TRAILING_BAR)
  );
  // 3,000 lines render as fifteen 200-line slices: about 60,000px, where a fixed placeholder was 400px (#288).
  const huge = hunk('@@ -0,0 +1,3000 @@', Array.from({ length: 3000 }, (_, i) => `+${i}`).join('\n'));
  assert.equal(estimateFileBlockHeight([huge], { status: 'added' }), FILE_HEADER + 3000 * CODE_LINE_HEIGHT + 15 * SLICE_CHROME);
  const column = estimateCodeColumnHeight([added, { ...folded, filePath: 'other.ts' }], {
    status: (path) => (path === 'other.ts' ? 'modified' : 'added'),
    viewed: (path) => path === 'other.ts',
  });
  assert.equal(column, 80 + 20 + (FILE_HEADER + 100 * CODE_LINE_HEIGHT + SLICE_CHROME) + 20 + FILE_HEADER);
});
