import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReviewStateKey } from '../lib/review-state';
import {
  clearUnviewed,
  explanationFileParts,
  movedUnitId,
  partCheckbox,
  partsProgress,
  readViewedParts,
  reconcileParts,
  sectionPartSeen,
  togglePart,
  unitId,
  viewedPartsKey,
  viewedPartsValue,
} from '../lib/viewed-parts';
import type { DiffHunk, ReviewGuide } from '../lib/types';

function must<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

const entry = (filePath: string, sliceId?: string, hunkHeader = '@@ -1,3 +1,3 @@'): DiffHunk => ({
  filePath,
  hunkHeader,
  content: ' a\n-b\n+B\n c',
  language: 'typescript',
  renderedHtml: '',
  ...(sliceId ? { sliceId, lineRanges: [{ start: 1, end: 2 }] } : {}),
});
const review = (
  slides: DiffHunk[][],
  fs: ReviewGuide['focusedSections'] | null = { outside: [] },
  noiseReduction?: ReviewGuide['noiseReduction']
) => ({
  slides: slides.map((diffHunks, i) => ({ id: `s${i + 1}`, diffHunks })) as unknown as ReviewGuide['slides'],
  focusedSections: fs ?? undefined,
  noiseReduction,
});
const outside = (filePath: string) => ({
  filePath,
  id: `${filePath}:left`,
  label: 'fn left',
  oldLines: [{ start: 9, end: 9 }],
  newLines: [],
  additions: 0,
  deletions: 1,
});
const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
// a.ts shows in sections 1 and 3 (two slices in 1, one in 3); b.ts only in section 2, whole.
const SLIDES = [[entry('a.ts', 'a:1'), entry('a.ts', 'a:2')], [entry('b.ts')], [entry('a.ts', 'a:3')]];
const marks = (result: { viewed: Map<string, boolean> }) => Object.fromEntries(result.viewed);

void test("each file's parts are its sections' units", () => {
  const parts = explanationFileParts(review(SLIDES));
  assert.deepEqual(parts?.get('a.ts'), {
    sections: [
      { section: 1, units: ['a:1', 'a:2'] },
      { section: 3, units: ['a:3'] },
    ],
    outside: false,
  });
  assert.deepEqual(must(parts).get('b.ts')?.sections, [{ section: 2, units: [unitId(entry('b.ts'))] }]);
});

void test('every part seen views the file; until then it reads "1 of 2 parts seen", mixed in the seen section', () => {
  const parts = explanationFileParts(review(SLIDES));
  const file = parts?.get('a.ts');
  const first = togglePart(parts, 'a.ts', 1, true, new Set(), none);
  assert.deepEqual([...first.seen], ['a:1', 'a:2']);
  assert.deepEqual(marks(first), {}, 'One part of two leaves the file unviewed');
  assert.deepEqual(partCheckbox(file, 1, first.seen, false), { checked: false, mixed: true, label: '1 of 2 parts seen', outside: undefined });
  assert.deepEqual(partCheckbox(file, 3, first.seen, false), { checked: false, mixed: false, label: '1 of 2 parts seen', outside: undefined });
  assert.equal(sectionPartSeen(file, 1, first.seen, false), true);
  assert.equal(sectionPartSeen(file, 3, first.seen, false), false);
  const second = togglePart(parts, 'a.ts', 3, true, first.seen, none);
  assert.deepEqual(marks(second), { 'a.ts': true }, 'The last part views the file');
  assert.deepEqual(partCheckbox(file, 1, second.seen, true), { checked: true, mixed: false });
  assert.deepEqual(partsProgress(must(file), second.seen), { seen: 2, total: 2, complete: true });
});

void test('code left out of the explanation keeps the file unviewed, however many parts are seen', () => {
  const parts = explanationFileParts(review(SLIDES, { outside: [outside('a.ts')] }));
  const first = togglePart(parts, 'a.ts', 1, true, new Set(), none);
  const both = togglePart(parts, 'a.ts', 3, true, first.seen, none);
  assert.deepEqual(marks(both), {}, 'Fail closed: the left-out code is finished in Changes');
  assert.deepEqual(partCheckbox(parts?.get('a.ts'), 3, both.seen, false), {
    checked: false,
    mixed: true,
    label: '2 of 2 parts seen, rest in Changes',
    outside: true,
  });
  // A file viewed in Changes reads as Viewed here.
  assert.deepEqual(partCheckbox(parts?.get('a.ts'), 3, both.seen, true), { checked: true, mixed: false });
  // A file with only left-out code and one part still uses parts.
  const single = explanationFileParts(review([[entry('c.ts', 'c:1')]], { outside: [outside('c.ts')] }));
  assert.deepEqual(marks(togglePart(single, 'c.ts', 1, true, new Set(), none)), {});
});

void test('a hunk cut as noise keeps its file unviewed, as left-out code does', () => {
  const noise = {
    level: 'conservative' as const,
    leftOut: [{ filePath: 'b.ts', side: 'after' as const, startLine: 20, endLine: 22, reason: 'import only', source: 'rules' as const }],
  };
  const parts = explanationFileParts(review(SLIDES, { outside: [] }, noise));
  assert.equal(parts?.get('b.ts')?.outside, true);
  const seen = togglePart(parts, 'b.ts', 2, true, new Set(), none);
  assert.deepEqual(marks(seen), {}, 'Its one part seen does not view it');
  assert.equal(partCheckbox(must(parts).get('b.ts'), 2, seen.seen, false).label, '1 of 1 part seen, rest in Changes');
  // A file whose every change was cut as noise has no part here: it is finished in Changes.
  const cut = explanationFileParts(review(SLIDES, { outside: [] }, { ...noise, leftOut: [{ ...noise.leftOut[0], filePath: 'n.ts' }] }));
  assert.deepEqual(cut?.get('n.ts'), { sections: [], outside: true });
});

void test("a moved definition's old copy is a part of its old file, seen with the section that shows the new copy", () => {
  // a.ts: bar shows in section 1, and foo moved from a.ts (old lines 40-52) to b.ts, shown in section 2.
  const foo: DiffHunk = {
    ...entry('b.ts', 'b:foo'),
    label: 'fn foo',
    movedFrom: { filePath: 'a.ts', startLine: 40, endLine: 52, body: 'identical' },
  };
  const parts = explanationFileParts(review([[entry('a.ts', 'a:bar')], [foo]]));
  const old = movedUnitId({ filePath: 'a.ts', startLine: 40, endLine: 52 });
  assert.deepEqual(parts?.get('a.ts')?.sections, [
    { section: 1, units: ['a:bar'] },
    { section: 2, units: [old] },
  ]);
  assert.deepEqual(must(parts).get('b.ts')?.sections, [{ section: 2, units: ['b:foo'], linked: [{ filePath: 'a.ts', unit: old }] }]);
  // Section 1 alone leaves a.ts unviewed.
  const bar = togglePart(parts, 'a.ts', 1, true, new Set(), none);
  assert.deepEqual(marks(bar), {});
  assert.equal(partCheckbox(must(parts).get('a.ts'), 1, bar.seen, false).label, '1 of 2 parts seen');
  // Section 2's part of b.ts sees foo's old copy too: both files are Viewed.
  const both = togglePart(parts, 'b.ts', 2, true, bar.seen, none);
  assert.deepEqual(marks(both), { 'b.ts': true, 'a.ts': true });
  // Unchecking it un-views both.
  const off = togglePart(parts, 'b.ts', 2, false, both.seen, only('a.ts', 'b.ts'));
  assert.deepEqual(marks(off), { 'b.ts': false, 'a.ts': false });
  assert.deepEqual([...off.seen], ['a:bar']);
  // In the other order, section 2 first, a.ts waits for section 1.
  assert.deepEqual(marks(togglePart(parts, 'b.ts', 2, true, new Set(), none)), { 'b.ts': true });
});

void test('unchecking a part un-views a file viewed through parts, and keeps the other parts seen', () => {
  const parts = explanationFileParts(review(SLIDES));
  const seen = new Set(['a:1', 'a:2', 'a:3']);
  const off = togglePart(parts, 'a.ts', 3, false, seen, only('a.ts'));
  assert.deepEqual(marks(off), { 'a.ts': false });
  assert.deepEqual([...off.seen], ['a:1', 'a:2']);
  assert.deepEqual(partCheckbox(parts?.get('a.ts'), 1, off.seen, false).label, '1 of 2 parts seen');
  // Unchecking a part of an unviewed file changes only the parts.
  assert.deepEqual(marks(togglePart(parts, 'a.ts', 1, false, off.seen, none)), {});
});

void test('a file un-viewed in Changes or on GitHub loses its seen parts', () => {
  const parts = explanationFileParts(review(SLIDES));
  const seen = new Set(['a:1', 'a:2', 'a:3', unitId(entry('b.ts'))]);
  const cleared = clearUnviewed(parts, seen, ['a.ts']);
  assert.deepEqual([...cleared], [unitId(entry('b.ts'))]);
  assert.equal(partCheckbox(parts?.get('a.ts'), 1, cleared, false).mixed, false, 'No "2 of 2" mixed box');
});

void test('a section that owns no part of a file shows its Viewed mark read-only', () => {
  const parts = explanationFileParts(review(SLIDES));
  assert.deepEqual(partCheckbox(parts?.get('a.ts'), 2, new Set(), false), { checked: false, mixed: false, readOnly: true });
  assert.deepEqual(partCheckbox(parts?.get('a.ts'), 2, new Set(), true), { checked: true, mixed: false, readOnly: true });
});

void test('a file in one section, whole, views and un-views as before', () => {
  const parts = explanationFileParts(review(SLIDES));
  assert.deepEqual(marks(togglePart(parts, 'b.ts', 2, true, new Set(), none)), { 'b.ts': true });
  assert.deepEqual(marks(togglePart(parts, 'b.ts', 2, false, new Set(), only('b.ts'))), { 'b.ts': false });
  assert.deepEqual(partCheckbox(parts?.get('b.ts'), 2, new Set(), false), { checked: false, mixed: false });
});

void test('Focused sections off, or an old explanation: no parts, and Viewed works as before', () => {
  assert.equal(explanationFileParts(review(SLIDES, null)), undefined);
  assert.equal(explanationFileParts(review(SLIDES, { outside: [], applied: false })), undefined);
  assert.deepEqual(togglePart(undefined, 'a.ts', 1, true, new Set(), none), { seen: new Set(), viewed: new Map([['a.ts', true]]) });
  assert.deepEqual(marks(togglePart(undefined, 'a.ts', 1, false, new Set(), only('a.ts'))), { 'a.ts': false });
  assert.deepEqual(marks(togglePart(undefined, 'a.ts', 1, true, new Set(), only('a.ts'))), {});
  assert.deepEqual(partCheckbox(undefined, 1, new Set(), true), { checked: true, mixed: false });
  assert.deepEqual([...clearUnviewed(undefined, new Set(['x']), ['a.ts'])], ['x']);
});

void test('seen parts are kept per head: a new head starts with none', () => {
  const key = viewedPartsKey('https://github.com/o/r/pull/1', 'h1');
  assert.ok(isReviewStateKey(key), 'The key is saved review state');
  assert.notEqual(key, viewedPartsKey('https://github.com/o/r/pull/1', 'h2'));
  const saved = { revision: 'h1', units: ['a:1', 'a:2', 3], viewed: ['a.ts'] };
  assert.deepEqual(readViewedParts(saved, 'h1'), { seen: new Set(['a:1', 'a:2']), viewed: new Set(['a.ts']) });
  assert.deepEqual(readViewedParts(saved, 'h2'), { seen: new Set(), viewed: new Set() }, 'Parts saved for another head are dropped');
  assert.deepEqual(readViewedParts(undefined, 'h1'), { seen: new Set(), viewed: new Set() });
  // Saved before Viewed was kept with them: no files to compare against.
  assert.deepEqual(readViewedParts({ revision: 'h1', units: ['a:1'] }, 'h1').viewed, new Set());
});

void test('a file un-viewed while the Explanation was closed loses its seen parts on load', () => {
  const parts = explanationFileParts(review(SLIDES));
  // Saved with a.ts Viewed through both of its parts.
  const value = viewedPartsValue('h1', { seen: new Set(['a:1', 'a:2', 'a:3']), viewed: new Set(['a.ts']) });
  const loaded = readViewedParts(value, 'h1');
  // a.ts was un-viewed in Changes, on GitHub or before a restart.
  const now = reconcileParts(parts, loaded, new Set());
  assert.deepEqual([...now.seen], [], 'Both parts are unseen');
  assert.deepEqual([...now.viewed], []);
  // One re-check does not view it.
  assert.deepEqual(marks(togglePart(parts, 'a.ts', 1, true, now.seen, none)), {});
  // Still Viewed: its parts stay seen.
  assert.deepEqual(reconcileParts(parts, loaded, new Set(['a.ts'])).seen, loaded.seen);
  // This page's own un-view, not applied yet, is not an un-view from elsewhere.
  const own = reconcileParts(parts, { seen: new Set(['a:1', 'a:2']), viewed: new Set() }, new Set(['a.ts']), new Map([['a.ts', false]]));
  assert.deepEqual([...own.seen], ['a:1', 'a:2']);
  assert.deepEqual([...own.viewed], []);
  // A file viewed since the save is recorded, so a later un-view is caught.
  assert.deepEqual([...reconcileParts(parts, { seen: new Set(['a:1']), viewed: new Set() }, new Set(['b.ts'])).viewed], ['b.ts']);
});
