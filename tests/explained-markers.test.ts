import assert from 'node:assert/strict';
import { test } from 'node:test';

function must<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
import { explainedMarkers, markerWords } from '../lib/explained-markers';
import { explainedChanges } from '../lib/explained-changes';
import type { DiffHunk, ReviewGuide } from '../lib/types';

// One hunk of a.ts from old and new line 10: a (rows 2-3, old/new 12), b (rows 9-10, old/new 18), D (row 17, new 25),
// e (row 24, old 31).
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
const B = slice(9, 10, 'fn b (impl S)');
const E = slice(24, 24, 'fn e');
const D = {
  filePath: 'a.ts',
  id: 'h1:D',
  label: 'const D',
  oldLines: [],
  newLines: [{ start: 25, end: 25 }],
  additions: 1,
  deletions: 0,
};
type Review = Pick<ReviewGuide, 'slides' | 'focusedSections'>;
const review = (slides: DiffHunk[][], fs: ReviewGuide['focusedSections'] | null = { outside: [] }): Review => ({
  slides: slides.map((diffHunks, i) => ({ id: `s${i + 1}`, diffHunks })) as unknown as ReviewGuide['slides'],
  focusedSections: fs ?? undefined,
});
const brief = (markers: ReturnType<typeof explainedMarkers>, file = 'a.ts') =>
  markers?.get(file)?.map((m) => [m.kind, m.side, m.start, m.section ?? null, m.names.join(',')]);

void test('owned slices are marked with their section at their first changed line', () => {
  const markers = explainedMarkers(review([[A, E], [B]]));
  assert.deepEqual(brief(markers), [
    ['section', 'before', 12, 1, 'fn a'],
    ['section', 'before', 18, 2, 'fn b'],
    ['section', 'before', 31, 1, 'fn e'],
  ]);
  const a = must(markers?.get('a.ts')?.[0]);
  assert.equal(a.slideId, 's1');
  // The jump lands on the slice's first added line, or its first deleted line when it only deletes.
  assert.deepEqual(a.target, { filePath: 'a.ts', line: 12, side: 'RIGHT' });
  assert.deepEqual(markers?.get('a.ts')?.[2].target, { filePath: 'a.ts', line: 31, side: 'LEFT' });
  assert.deepEqual(markerWords(a), { text: 'Explained in section 1 ↗', name: 'Explained in section 1: fn a', detail: 'fn a' });
});

void test('code left out of the explanation is marked, and has no jump', () => {
  const markers = explainedMarkers(review([[A, E], [B]], { outside: [D] }));
  const left = markers?.get('a.ts')?.find((m) => m.kind === 'outside');
  assert.deepEqual([left?.side, left?.start, left?.section], ['after', 25, undefined]);
  assert.equal(left?.target, undefined);
  assert.equal(markerWords(must(left)).text, 'Left out of the explanation');
  // A left-out change that deletes lines is marked at its first deleted line, above its added ones.
  const edit = { ...D, id: 'h1:edit', oldLines: [{ start: 31, end: 31 }], newLines: [{ start: 30, end: 30 }], deletions: 1 };
  const marked = explainedMarkers(review([[A], [B]], { outside: [edit] }))?.get('a.ts')?.find((m) => m.kind === 'outside');
  assert.deepEqual([marked?.side, marked?.start], ['before', 31]);
});

void test("a moved definition's old copy says which section explains its new copy", () => {
  const moved = slice(2, 3, 'fn a (impl S)', {
    movedFrom: { filePath: 'old.ts', startLine: 40, endLine: 52, body: 'identical' },
  });
  const markers = explainedMarkers(review([[B], [moved]]));
  assert.deepEqual(brief(markers, 'old.ts'), [['moved', 'before', 40, 2, 'fn a']]);
  const old = markers?.get('old.ts')?.[0];
  // The jump goes to the new copy, in the section that shows it.
  assert.deepEqual(old?.target, { filePath: 'a.ts', line: 12, side: 'RIGHT' });
  assert.deepEqual(markerWords(must(old)), { text: 'Moved: explained with fn a ↗', name: 'Moved: explained with fn a, in section 2' });
  // The new copy is marked as its section's too.
  assert.deepEqual(brief(markers), [
    ['section', 'before', 12, 2, 'fn a'],
    ['section', 'before', 18, 1, 'fn b'],
  ]);
});

void test('several sections and whole hunks: one marker per place, slices first', () => {
  const other: DiffHunk = { ...HUNK, filePath: 'b.ts', hunkHeader: '@@ -1,2 +1,2 @@', content: '-x\n+y' };
  // Section 3 lists a's whole hunk again (an older listing of the same code), and b.ts whole.
  const markers = explainedMarkers(review([[A], [B, E], [HUNK, other]], { outside: [D] }));
  assert.deepEqual(brief(markers), [
    ['section', 'before', 12, 1, 'fn a'],
    ['section', 'before', 18, 2, 'fn b'],
    ['outside', 'after', 25, null, 'const D'],
    ['section', 'before', 31, 2, 'fn e'],
  ]);
  assert.deepEqual(brief(markers, 'b.ts'), [['section', 'before', 1, 3, '']]);
  // A unit listed twice keeps its first section.
  assert.deepEqual(brief(explainedMarkers(review([[A], [A]]))), [['section', 'before', 12, 1, 'fn a']]);
});

void test('a hunk cut as noise is marked as left out, unless a marker already names that code', () => {
  const r = {
    ...review([[A], [B]]),
    noiseReduction: {
      level: 'conservative' as const,
      leftOut: [
        { filePath: 'a.ts', side: 'before' as const, startLine: 31, endLine: 31, reason: 'comments only', source: 'rules' as const },
        { filePath: 'a.ts', side: 'before' as const, startLine: 18, endLine: 18, reason: 'formatting', source: 'rules' as const },
      ],
    },
  };
  const markers = explainedMarkers(r);
  assert.deepEqual(brief(markers), [
    ['section', 'before', 12, 1, 'fn a'],
    ['section', 'before', 18, 2, 'fn b'],
    ['outside', 'before', 31, null, 'comments only'],
  ]);
  const noise = must(markers?.get('a.ts')?.find((m) => m.noise));
  assert.deepEqual(markerWords(noise), {
    text: 'Left out of the explanation (noise)',
    name: 'Left out of the explanation (noise): comments only',
    detail: 'comments only',
  });
});

void test('a noise marker is hidden only by a marker on its own side of the diff', () => {
  const r = {
    ...review([[A]]),
    noiseReduction: {
      level: 'conservative' as const,
      // New line 12 is fn a's added line, but fn a is marked on its old side: the noise marker still shows.
      leftOut: [{ filePath: 'a.ts', side: 'after' as const, startLine: 12, endLine: 12, reason: 'formatting', source: 'rules' as const }],
    },
  };
  assert.deepEqual(brief(explainedMarkers(r)), [
    ['outside', 'after', 12, null, 'formatting'],
    ['section', 'before', 12, 1, 'fn a'],
  ]);
});

void test('no Focused sections, or not applied: no markers', () => {
  assert.equal(explainedMarkers(review([[A]], null)), undefined);
  assert.equal(explainedMarkers(review([[A]], { outside: [], applied: false })), undefined);
  assert.equal(explainedMarkers(undefined), undefined);
});

void test('markers are computed once per explanation', () => {
  const r = review([[A, E], [B]]);
  assert.equal(explainedMarkers(r), explainedMarkers(r));
});

void test("Changes reads a file's markers by its PR, path and head; another head reads none", () => {
  const r = {
    ...review([[A]]),
    reviewId: 'r1',
    prUrl: 'https://github.com/o/r/pull/1',
    headSha: 'h1',
  } as ReviewGuide;
  const opened: unknown[] = [];
  const changes = must(explainedChanges(r, (destination) => opened.push(destination.command.destination)));
  const marker = must(changes.markersFor('https://github.com/o/r/pull/1', 'a.ts', 'h1')?.[0]);
  assert.equal(changes.markersFor('https://github.com/o/r/pull/1', 'a.ts', 'h1')?.length, 1);
  assert.equal(changes.markersFor('https://github.com/o/r/pull/1', 'a.ts', 'h2'), undefined);
  assert.equal(changes.markersFor('https://github.com/o/r/pull/2', 'a.ts', 'h1'), undefined);
  changes.open(marker);
  assert.deepEqual(opened, [{ kind: 'review', reviewId: 'r1', slideId: 's1', filePath: 'a.ts', line: 12, side: 'RIGHT' }]);
  assert.equal(explainedChanges({ ...r, focusedSections: undefined }, () => {}), undefined);
});
