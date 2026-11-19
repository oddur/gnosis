import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  GAP_STEP,
  afterLines,
  diffGaps,
  firstMismatch,
  gapContaining,
  gapSize,
  hunkRange,
  hunkCounts,
  hunkSlices,
  hunksFromDiff,
  lineEndings,
  matchesAfter,
  patchLineEndings,
  placeOfLine,
  newLineAt,
  hiddenBetween,
  revealGap,
  revealedParts,
  shownLines,
  shownSelection,
  type GapPart,
} from '../lib/diff-gaps';
import { diffGapFiles, diffGapsAfter, diffGapsBefore, hugeLines } from './fixtures/diff-gaps';
import { reviewGapHunks } from '../lib/review-gap-hunks';

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

void test('line endings and a byte order mark never make a file look stale', () => {
  // GitHub's patch keeps the carriage returns of a CRLF file, as the file does.
  const crlf = hunksFromDiff(parse('@@ -1,3 +1,3 @@\r\n a\r\n-b\r\n+B\r\n c\r'));
  assert.equal(matchesAfter(crlf, afterLines('a\r\nB\r\nc\r\n')), true);
  // A topic's saved hunks, or another source, can lose them: still the same lines.
  const lf = hunksFromDiff(parse('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'));
  assert.equal(matchesAfter(lf, afterLines('a\r\nB\r\nc\r\n')), true);
  assert.equal(matchesAfter(crlf, afterLines('a\nB\nc\n')), true);
  // Main decodes contents with TextDecoder, which drops a leading BOM; GitHub's patch keeps it.
  const bom = hunksFromDiff(parse('@@ -1,3 +1,3 @@\n \ufeffa\n-b\n+B\n c'));
  assert.equal(matchesAfter(bom, afterLines('a\nB\nc\n')), true);
  assert.equal(matchesAfter(lf, afterLines('\ufeffa\nB\nc\n')), true);
  // Only on line 1: a BOM anywhere else is text.
  const later = hunksFromDiff(parse('@@ -2,2 +2,2 @@\n \ufeffa\n-b\n+B'));
  assert.equal(matchesAfter(later, afterLines('x\na\nB\n')), false);
  // A file without a final line feed matches a patch that says so, with or without CRLF.
  const noEof = hunksFromDiff(parse('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file'));
  assert.equal(matchesAfter(noEof, afterLines('a\nB\nc')), true);
  assert.equal(matchesAfter(noEof, afterLines('a\r\nB\r\nc')), true);
  const crlfNoEof = hunksFromDiff(parse('@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\n\\ No newline at end of file'));
  assert.equal(matchesAfter(crlfNoEof, afterLines('a\r\nB')), true);
  // And one that gained a final line feed is the same lines.
  assert.equal(matchesAfter(noEof, afterLines('a\nB\nc\n')), true);
  // Context trimmed below GitHub's three lines keeps the marker on the file's last line.
  const trimmed = hunksFromDiff(
    must(
      pierreParse(
        pierre.trimPatchContext(
          'diff --git a/source b/source\n--- a/source\n+++ b/source\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n\\ No newline at end of file\n',
          1
        )
      )
    )
  );
  assert.equal(matchesAfter(trimmed, afterLines('a\nB\nc\nd\ne')), true);
  // A real change is still one.
  assert.equal(matchesAfter(lf, afterLines('a\r\nX\r\nc\r\n')), false);
});

void test('a mismatch names its first line and how the patch and the file end their lines', () => {
  const lf = hunksFromDiff(parse('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'));
  assert.equal(firstMismatch(lf, afterLines('a\nB\nc\n')), undefined);
  assert.equal(firstMismatch(lf, afterLines('a\nX\nc\n')), 2);
  assert.equal(firstMismatch(lf, ['a']), 2);
  const noEof = hunksFromDiff(parse('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file'));
  assert.equal(firstMismatch(noEof, afterLines('a\nB\nc\nmore\n')), 4, 'The line after the patch’s last');
  assert.deepEqual(patchLineEndings(lf), { endings: 'lf', finalNewline: true, bom: false });
  assert.deepEqual(patchLineEndings(noEof), { endings: 'lf', finalNewline: false, bom: false });
  assert.deepEqual(patchLineEndings(hunksFromDiff(parse('@@ -1,2 +1,2 @@\n \ufeffa\r\n-b\r\n+B\r'))), {
    endings: 'crlf',
    finalNewline: true,
    bom: true,
  });
  assert.deepEqual(lineEndings('a\r\nb\r\n'), { endings: 'crlf', finalNewline: true, bom: false });
  assert.deepEqual(lineEndings('\ufeffa\nb\r\nc'), { endings: 'mixed', finalNewline: false, bom: true });
  assert.deepEqual(lineEndings('one line'), { endings: 'none', finalNewline: false, bom: false });
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

void test('a pinned crumb finds its line without revealing anything: a row, or the gap that hides it (#417)', () => {
  const two = hunksFromDiff(parse('@@ -5,3 +5,4 @@\n a\n-b\n+B\n+B2\n c\n@@ -20,2 +21,1 @@\n-x\n y'));
  const gaps = must(diffGaps(two, 25));
  const parts = revealedParts(two, gaps, {});
  assert.deepEqual(parts.map(range), ['gap 1-4 (4)', 'hunk +5-8 -5', 'gap 9-20 (12)', 'hunk +21-21 -20', 'gap 22-25 (4)']);
  // Shown rows, on each side in its own numbers.
  assert.deepEqual(placeOfLine(parts, 'after', 6), { kind: 'row', key: 'h0', row: 2, line: 6 });
  assert.deepEqual(placeOfLine(parts, 'before', 6), { kind: 'row', key: 'h0', row: 1, line: 6 });
  assert.deepEqual(placeOfLine(parts, 'after', 8), { kind: 'row', key: 'h0', row: 4, line: 8 });
  assert.deepEqual(placeOfLine(parts, 'before', 20), { kind: 'row', key: 'h1', row: 0, line: 20 });
  assert.deepEqual(placeOfLine(parts, 'after', 21), { kind: 'row', key: 'h1', row: 1, line: 21 });
  // Hidden lines: the bar of their gap. Old lines map through the gap's offset.
  assert.deepEqual(placeOfLine(parts, 'after', 2), { kind: 'gap', gap: 0 });
  assert.deepEqual(placeOfLine(parts, 'after', 15), { kind: 'gap', gap: 1 });
  assert.deepEqual(placeOfLine(parts, 'before', 19), { kind: 'gap', gap: 1 });
  assert.deepEqual(placeOfLine(parts, 'before', 8), { kind: 'gap', gap: 1 });
  assert.deepEqual(placeOfLine(parts, 'after', 24), { kind: 'gap', gap: 2 });
  // Past everything: the nearest place above. Before everything: the top.
  assert.deepEqual(placeOfLine(parts, 'after', 90), { kind: 'gap', gap: 2 });
  assert.deepEqual(placeOfLine(parts, 'after', 0), { kind: 'top' });
  // Revealed lines are rows of the hunk they joined; nothing else changes.
  const text = Array.from({ length: 25 }, (_, i) => `l${i + 1}`);
  const opened = revealedParts(two, gaps, revealGap({}, gaps[1], two.length, 'down'), text);
  assert.deepEqual(placeOfLine(opened, 'after', 15), { kind: 'row', key: 'h0', row: 11, line: 15 });
  assert.deepEqual(placeOfLine(opened, 'before', 6), { kind: 'row', key: 'h0', row: 1, line: 6 });
  // Reveals are in new numbers: old lines map through their gap, a deleted row to the new line where it sits.
  assert.equal(newLineAt(parts, 'after', 15), 15);
  assert.equal(newLineAt(parts, 'before', 19), 20);
  assert.equal(newLineAt(parts, 'before', 6), 6);
  assert.equal(newLineAt(parts, 'before', 7), 8);
  assert.equal(newLineAt(parts, 'before', 20), 21);
  assert.equal(newLineAt(parts, 'before', 2), 2);
  // A jump reveals only when a line between the definition and the reader is hidden.
  assert.equal(hiddenBetween(parts, 2, 6), true);
  assert.equal(hiddenBetween(parts, 5, 8), false);
  assert.equal(hiddenBetween(parts, 15, 21), true);
  assert.equal(hiddenBetween(revealedParts(two, gaps, revealGap({}, gaps[1], two.length, 'all'), text), 9, 21), false);
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

test('a hunk names its lines for a pinned header without structure (#395)', () => {
  const rows = (types: string) => [...types].map((type) => ({ type: type as ' ' | '+' | '-', text: '' }));
  assert.deepEqual(hunkRange({ oldStart: 120, newStart: 120, rows: rows(' -+-+ ') }), { label: 'L120–123', spoken: 'Lines 120 to 123' });
  assert.deepEqual(hunkRange({ oldStart: 4, newStart: 4, rows: rows('+') }), { label: 'L4', spoken: 'Line 4' });
  assert.deepEqual(hunkRange({ oldStart: 9, newStart: 9, rows: rows('---') }), { label: 'old L9–11', spoken: 'Old lines 9 to 11' });
  // A hunk that only deletes is where its deleted lines were, on the old side, context and all.
  assert.deepEqual(hunkRange({ oldStart: 9, newStart: 7, rows: rows(' -- ') }), { label: 'old L9–12', spoken: 'Old lines 9 to 12' });
  assert.deepEqual(hunkRange({ oldStart: 1200, newStart: 1201, rows: rows(' '.repeat(10)) }), { label: 'L1201–1210', spoken: 'Lines 1201 to 1210' });
  // The header shows the new lines; old lines that differ are in the words, for the tooltip and screen readers.
  assert.deepEqual(hunkRange({ oldStart: 9, newStart: 12, rows: rows(' -+ ') }), {
    label: 'L12–14',
    spoken: 'Lines 12 to 14 (old lines 9 to 11)',
  });
  assert.deepEqual(hunkRange({ oldStart: 120, newStart: 120, rows: rows(' -+ ') }), { label: 'L120–122', spoken: 'Lines 120 to 122' });
  assert.deepEqual(hunkRange({ oldStart: 4, newStart: 4, rows: rows(' ++ ') }), { label: 'L4–7', spoken: 'Lines 4 to 7' });
  assert.deepEqual(hunkCounts({ rows: rows(' ++-+ ') }), { added: 3, deleted: 1 });
  assert.deepEqual(hunkCounts({ rows: rows('  ') }), { added: 0, deleted: 0 });
});

/** A topic's saved hunk, as an explanation stores it: its header and its lines with +, - or a space. */
const saved = (hunkHeader: string, content: string) => ({
  filePath: 'src/topic.ts',
  hunkHeader,
  content,
  language: 'typescript',
  renderedHtml: '',
});

void test('a topic keeps its saved changes with Changes’ context, and gaps reveal from what it saved (#157 parity)', () => {
  // One saved hunk with 20 lines of context around one change, as a topic expands it.
  const body = Array.from({ length: 41 }, (_, i) => (i === 20 ? '-old\n+new' : ` line${i + 1}`)).join('\n');
  const topic = reviewGapHunks([saved('@@ -1,41 +1,41 @@', body)], { context: 3 });
  assert.equal(topic.hunks.length, 1);
  assert.deepEqual(
    { oldStart: topic.hunks[0].oldStart, newStart: topic.hunks[0].newStart, rows: topic.hunks[0].rows.length },
    { oldStart: 18, newStart: 18, rows: 8 }
  );
  const gaps = must(diffGaps(topic.hunks, undefined, { partial: true }));
  assert.ok(gaps.every((gap) => !gap.opaque));
  // The saved lines above the change reveal without a read; the file's end is not known.
  const parts = revealedParts(topic.hunks, gaps, { 0: { down: 0, up: 5 } }, topic.known);
  const first = parts.find((part) => part.kind === 'hunk');
  assert.equal(first?.kind === 'hunk' && first.hunk.newStart, 13);
  assert.equal(first?.kind === 'hunk' && first.hunk.rows[0].text, 'line13');
  const last = parts.at(-1);
  assert.ok(last?.kind === 'gap' && last.hidden === undefined, 'the file’s end is unknown without the after side');
  // A pinned line far from the change stays in view with its own context.
  const pinned = reviewGapHunks([saved('@@ -1,41 +1,41 @@', body)], { context: 3, pins: [{ line: 3 }] });
  assert.deepEqual(pinned.hunks.map((hunk) => [hunk.newStart, hunk.rows.length]), [[1, 6], [18, 8]]);
  assert.equal(pinned.headers.get('RIGHT:21'), '@@ -1,41 +1,41 @@');
});

void test('a topic that leaves out changes between its hunks shows that gap without revealing it', () => {
  // Lines 10–12 changed in the file too, adding a line, but the topic left that hunk out.
  const topic = reviewGapHunks([
    saved('@@ -1,3 +1,3 @@', ' a\n-b\n+B'),
    saved('@@ -30,2 +31,2 @@', '-c\n+C\n d'),
  ]);
  assert.equal(diffGaps(topic.hunks), undefined, 'a whole file’s gaps must agree');
  const gaps = must(diffGaps(topic.hunks, undefined, { partial: true }));
  assert.equal(gaps[1].opaque, true);
  const parts = revealedParts(topic.hunks, gaps, { 1: { down: 20, up: 20 } }, topic.known);
  const between = parts.find((part) => part.kind === 'gap' && part.gap.index === 1);
  assert.ok(between?.kind === 'gap' && between.gap.opaque && between.hidden === 28);
  assert.equal(gapContaining(gaps, 'after', 20), undefined);
  // Overlapping saved hunks keep each line once.
  const overlap = reviewGapHunks([saved('@@ -1,3 +1,3 @@', ' a\n-b\n+B\n c'), saved('@@ -3,2 +3,2 @@', ' c\n-d\n+D')]);
  assert.deepEqual(overlap.hunks.map((hunk) => hunk.rows.map((row) => row.type + row.text).join('|')), [' a|-b|+B| c|-d|+D']);
  // Added files show whole, as in Changes.
  const added = reviewGapHunks([saved('@@ -0,0 +1,12 @@', Array.from({ length: 12 }, (_, i) => `+l${i}`).join('\n'))], { status: 'added' });
  assert.deepEqual(added.hunks.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.rows.length]), [[1, 1, 12]]);
});
