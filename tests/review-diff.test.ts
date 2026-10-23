import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareReviewHunk, reviewContextRanges, sliceReviewHunk } from '../lib/review-diff';
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
