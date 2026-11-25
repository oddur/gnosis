import assert from 'node:assert/strict';
import { test } from 'node:test';

function must<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
import { isReviewStateKey } from '../lib/review-state';
import {
  explanationFileParts,
  partCheckbox,
  partsProgress,
  readViewedParts,
  togglePart,
  unitId,
  viewedPartsKey,
} from '../lib/viewed-parts';
import type { DiffHunk, ReviewGuide } from '../lib/types';

const entry = (filePath: string, sliceId?: string, hunkHeader = '@@ -1,3 +1,3 @@'): DiffHunk => ({
  filePath,
  hunkHeader,
  content: ' a\n-b\n+B\n c',
  language: 'typescript',
  renderedHtml: '',
  ...(sliceId ? { sliceId, lineRanges: [{ start: 1, end: 2 }] } : {}),
});
const review = (slides: DiffHunk[][], fs: ReviewGuide['focusedSections'] | null = { outside: [] }) => ({
  slides: slides.map((diffHunks, i) => ({ id: `s${i + 1}`, diffHunks })) as unknown as ReviewGuide['slides'],
  focusedSections: fs ?? undefined,
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
// a.ts shows in sections 1 and 3 (two slices in 1, one in 3); b.ts only in section 2, whole.
const SLIDES = [[entry('a.ts', 'a:1'), entry('a.ts', 'a:2')], [entry('b.ts')], [entry('a.ts', 'a:3')]];

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
  const file = explanationFileParts(review(SLIDES))?.get('a.ts');
  const first = togglePart(file, 1, true, new Set(), false);
  assert.deepEqual([...first.seen], ['a:1', 'a:2']);
  assert.equal(first.viewed, undefined, 'One part of two leaves the file unviewed');
  assert.deepEqual(partCheckbox(file, 1, first.seen, false), { checked: false, mixed: true, label: '1 of 2 parts seen', outside: undefined });
  assert.deepEqual(partCheckbox(file, 3, first.seen, false), { checked: false, mixed: false, label: '1 of 2 parts seen', outside: undefined });
  const second = togglePart(file, 3, true, first.seen, false);
  assert.equal(second.viewed, true, 'The last part views the file');
  assert.deepEqual(partCheckbox(file, 1, second.seen, true), { checked: true, mixed: false });
  assert.deepEqual(partsProgress(must(file), second.seen), { seen: 2, total: 2, complete: true });
});

void test('code left out of the explanation keeps the file unviewed, however many parts are seen', () => {
  const file = explanationFileParts(review(SLIDES, { outside: [outside('a.ts')] }))?.get('a.ts');
  const first = togglePart(file, 1, true, new Set(), false);
  const both = togglePart(file, 3, true, first.seen, false);
  assert.equal(both.viewed, undefined, 'Fail closed: the left-out code is finished in Changes');
  assert.deepEqual(partCheckbox(file, 3, both.seen, false), {
    checked: false,
    mixed: true,
    label: '2 of 2 parts seen, rest in Changes',
    outside: true,
  });
  // A file viewed in Changes reads as Viewed here.
  assert.deepEqual(partCheckbox(file, 3, both.seen, true), { checked: true, mixed: false });
  // A file with only left-out code and one part still uses parts.
  const single = explanationFileParts(review([[entry('c.ts', 'c:1')]], { outside: [outside('c.ts')] }))?.get('c.ts');
  assert.equal(togglePart(single, 1, true, new Set(), false).viewed, undefined);
});

void test('unchecking a part un-views a file viewed through parts, and keeps the other parts seen', () => {
  const file = explanationFileParts(review(SLIDES))?.get('a.ts');
  const seen = new Set(['a:1', 'a:2', 'a:3']);
  const off = togglePart(file, 3, false, seen, true);
  assert.equal(off.viewed, false);
  assert.deepEqual([...off.seen], ['a:1', 'a:2']);
  assert.deepEqual(partCheckbox(file, 1, off.seen, false).label, '1 of 2 parts seen');
  // Unchecking a part of an unviewed file changes only the parts.
  assert.equal(togglePart(file, 1, false, off.seen, false).viewed, undefined);
});

void test('a file in one section, whole, views and un-views as before', () => {
  const file = explanationFileParts(review(SLIDES))?.get('b.ts');
  assert.equal(togglePart(file, 2, true, new Set(), false).viewed, true);
  assert.equal(togglePart(file, 2, false, new Set(), true).viewed, false);
  assert.deepEqual(partCheckbox(file, 2, new Set(), false), { checked: false, mixed: false });
});

void test('Focused sections off, or an old explanation: no parts, and Viewed works as before', () => {
  assert.equal(explanationFileParts(review(SLIDES, null)), undefined);
  assert.equal(explanationFileParts(review(SLIDES, { outside: [], applied: false })), undefined);
  assert.deepEqual(togglePart(undefined, 1, true, new Set(), false), { seen: new Set(), viewed: true });
  assert.deepEqual(togglePart(undefined, 1, false, new Set(), true), { seen: new Set(), viewed: false });
  assert.deepEqual(togglePart(undefined, 1, true, new Set(), true).viewed, undefined);
  assert.deepEqual(partCheckbox(undefined, 1, new Set(), true), { checked: true, mixed: false });
});

void test('seen parts are kept per head: a new head starts with none', () => {
  const key = viewedPartsKey('https://github.com/o/r/pull/1', 'h1');
  assert.ok(isReviewStateKey(key), 'The key is saved review state');
  assert.notEqual(key, viewedPartsKey('https://github.com/o/r/pull/1', 'h2'));
  const saved = { revision: 'h1', units: ['a:1', 'a:2', 3] };
  assert.deepEqual([...readViewedParts(saved, 'h1')], ['a:1', 'a:2']);
  assert.deepEqual([...readViewedParts(saved, 'h2')], [], 'Parts saved for another head are dropped');
  assert.deepEqual([...readViewedParts(undefined, 'h1')], []);
});
