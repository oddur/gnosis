// Focused sections (#562): the planner and writers work on slices (lib/explanation-focus.ts). Synthetic slices and a
// stub plan; no model, no worker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { buildTopicContext } from '../lib/context-builder';
import { formatHunkIndexForPrompt, type IndexedHunk } from '../lib/diff-parse';
import {
  cutHunk,
  focusFileWindows,
  focusMovedNoise,
  focusCheckpointKey,
  writerCheckpointKey,
  focusCutUnits,
  focusDiffHunks,
  focusIndex,
  focusLeftovers,
  focusPlannerIndex,
  focusPlannerNoise,
  focusedTopicDiff,
  unitHunkIds,
  validateFocusTopics,
} from '../lib/explanation-focus';
import {
  DEFAULT_EXPLANATION_PREFERENCES,
  normalizeExplanationPreferences,
} from '../lib/explanation-options';
import type { HunkSlice, HunkSlices } from '../lib/explanation-slices';
import { hunkOwners, ownedHunkIds, ownerSections, resolveDiffHunks, shownElsewhere } from '../lib/hunk-ownership';
import type { TopicPlan } from '../lib/types';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function hunk(id: string, filePath: string, fileStatus: IndexedHunk['fileStatus'], header: string, lines: string[]): IndexedHunk {
  const content = lines.join('\n');
  return {
    id,
    filePath,
    fileStatus,
    hunkHeader: header,
    content,
    expandedHunkHeader: header,
    expandedContent: content,
    additions: lines.filter((l) => l.startsWith('+')).length,
    deletions: lines.filter((l) => l.startsWith('-')).length,
    scopeName: null,
    language: 'typescript',
  };
}

// A new file of 30 lines in three functions; beta is the edited new copy of a definition deleted from old.ts.
const NEW_LINES = Array.from({ length: 30 }, (_, i) =>
  i === 0 ? '+function alpha() {' : i === 10 ? '+function beta() {' : i === 20 ? '+function gamma() {' : `+  line ${i + 1}`
);
const OLD_LINES = [' keep', '-function beta() {', ...Array.from({ length: 9 }, (_, i) => `-  old ${i}`), ' end'];
const HUNKS = [
  hunk('hunk-0', 'src/queue.ts', 'added', '@@ -0,0 +1,30 @@', NEW_LINES),
  hunk('hunk-1', 'src/small.ts', 'modified', '@@ -1,3 +1,3 @@', [' a', '-b', '+B']),
  hunk('hunk-2', 'src/old.ts', 'modified', '@@ -1,12 +1,2 @@', OLD_LINES),
];
const BASE: Record<string, string> = {
  'src/old.ts': ['keep', 'function beta() {', ...Array.from({ length: 9 }, (_, i) => `  old ${i}`), 'end'].join('\n'),
  'src/small.ts': 'a\nb\nc',
};
const HEAD: Record<string, string> = {
  'src/queue.ts': NEW_LINES.map((l) => l.slice(1)).join('\n'),
  'src/small.ts': 'a\nB\nc',
};

function slice(id: string, label: string, start: number, end: number, extra: Partial<HunkSlice> = {}): HunkSlice {
  return {
    id,
    label,
    symbols: [
      { side: 'after', kind: 'function', name: label.slice(3), label, start: start + 1, end: end + 1, span: { start: start + 1, end: end + 1 } },
    ],
    lines: [{ start, end }],
    oldLines: [],
    newLines: [{ start: start + 1, end: end + 1 }],
    removed: [],
    added: [{ start: start + 1, end: end + 1 }],
    additions: end - start + 1,
    deletions: 0,
    ...extra,
  };
}
function sliced(moves = true): HunkSlices[] {
  return [
    {
      hunkId: 'hunk-0',
      filePath: 'src/queue.ts',
      slices: [
        slice('hunk-0:a', 'fn alpha', 0, 9),
        slice('hunk-0:b', 'fn beta', 10, 19, moves ? { movedFrom: 'hunk-2:m', moveBody: 'edited' } : {}),
        slice('hunk-0:c', 'fn gamma', 20, 29),
      ],
    },
    {
      hunkId: 'hunk-1',
      filePath: 'src/small.ts',
      whole: 'small',
      slices: [{ ...slice('hunk-1:w', 'small.ts', 0, 2), symbols: [], additions: 1, deletions: 1, oldLines: [{ start: 2, end: 2 }], newLines: [{ start: 2, end: 2 }], removed: [{ start: 2, end: 2 }], added: [{ start: 2, end: 2 }] }],
    },
    {
      hunkId: 'hunk-2',
      filePath: 'src/old.ts',
      slices: [
        {
          id: 'hunk-2:m',
          label: 'fn beta',
          symbols: [{ side: 'before', kind: 'function', name: 'beta', label: 'fn beta', start: 2, end: 11, span: { start: 2, end: 11 } }],
          lines: [{ start: 1, end: 10 }],
          oldLines: [{ start: 2, end: 11 }],
          newLines: [],
          removed: [{ start: 2, end: 11 }],
          added: [],
          additions: 0,
          deletions: 10,
          ...(moves ? { movedTo: 'hunk-0:b', moveBody: 'edited' as const } : {}),
        },
      ],
    },
  ];
}
const topic = (title: string, hunkIds: string[], order: number) =>
  ({ title, slideType: 'feature', importance: 'important', hunkIds, dependsOn: [], order, narrativeBrief: '' }) as unknown as TopicPlan;
const hunkMap = new Map(HUNKS.map((h) => [h.id, h]));
const pick = ({ other, outside }: { other: string[]; outside: unknown[] }) => ({ other, outside });

void describe('focused sections', () => {
  void test('units: a sliced hunk is its slices, a whole hunk keeps its hunk ID, a moved deletion is covered', () => {
    const index = focusIndex(HUNKS, sliced());
    assert.deepEqual([...index.units.keys()], ['hunk-0:a', 'hunk-0:b', 'hunk-0:c', 'hunk-1', 'hunk-2']);
    assert.deepEqual(index.aliases.get('hunk-0'), ['hunk-0:a', 'hunk-0:b', 'hunk-0:c']);
    assert.deepEqual(index.aliases.get('hunk-1:w'), ['hunk-1']);
    assert.equal(index.movedAway.get('hunk-2'), 'hunk-0:b');
    // A hunk the slicer didn't answer for is one whole unit.
    const unanswered = focusIndex(HUNKS, []);
    assert.deepEqual([...unanswered.units.keys()], ['hunk-0', 'hunk-1', 'hunk-2']);
    assert.equal(unanswered.movedAway.size, 0);
  });

  void test('planner input: slices with labels, counts and excerpts; whole hunks as today; the moved deletion not listed', () => {
    const index = focusIndex(HUNKS, sliced());
    const prompt = focusPlannerIndex(HUNKS, index);
    assert.match(prompt, /<slices_note>/);
    assert.match(prompt, /<slice id="hunk-0:a" file="src\/queue.ts" label="fn alpha" lines="\+1-10" additions="10" deletions="0">\n\+function alpha\(\) \{/);
    assert.match(prompt, /<slice id="hunk-0:b"[^>]*movedFrom="src\/old.ts:2-11 \(edited\)"/);
    // A whole hunk keeps the hunk index's own entry.
    assert.ok(prompt.includes(formatHunkIndexForPrompt([HUNKS[1]]).split('\n')[1]));
    assert.doesNotMatch(prompt, /hunk-2/, 'the moved deletion is explained with its new copy');
    assert.doesNotMatch(prompt, /id="hunk-0"/, 'a sliced hunk is listed only as its slices');
    assert.doesNotMatch(prompt, /hunk="/, 'a slice never names its hunk ID for the planner to copy');
    // An excerpt never carries markup.
    const tricky = hunk('hunk-9', 'a.ts', 'added', '@@ -0,0 +1,2 @@', ['+<b>"x"</b>', '+y']);
    const trickyIndex = focusIndex([tricky], [{ hunkId: 'hunk-9', filePath: 'a.ts', slices: [slice('hunk-9:a', 'fn a', 0, 0), slice('hunk-9:b', 'fn b', 1, 1)] }]);
    assert.match(focusPlannerIndex([tricky], trickyIndex), /\+&lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
  });

  void test('ID validation: unknown IDs are dropped and aliases resolve, once each in planner order', () => {
    const index = focusIndex(HUNKS, sliced());
    const [checked] = validateFocusTopics(
      [topic('T', ['hunk-0:c', 'nope', 'hunk-1:w', 'hunk-2', 'hunk-0', 'hunk-0:c', 7 as unknown as string], 1)],
      index
    );
    assert.deepEqual(checked.hunkIds, ['hunk-0:c', 'hunk-1', 'hunk-0:b', 'hunk-0:a']);
    const [missing] = validateFocusTopics([{ ...topic('U', [], 2), hunkIds: undefined as unknown as string[] }], index);
    assert.deepEqual(missing.hunkIds, []);
    // The planner can't cut a hunk as noise when a topic lists part of it.
    const noise = focusPlannerNoise(
      [{ hunkId: 'hunk-0', reason: 'x' }, { hunkId: 'hunk-1', reason: 'y' }],
      [topic('T', ['hunk-0:a'], 1)],
      index
    );
    assert.deepEqual(noise, [{ hunkId: 'hunk-1', reason: 'y' }]);
  });

  void test('ownership over slices: the first section in planner order owns a slice, later ones reference it', () => {
    const index = focusIndex(HUNKS, sliced());
    const topics = validateFocusTopics([topic('A', ['hunk-0:a', 'hunk-0:b'], 1), topic('B', ['hunk-0:b', 'hunk-0:c', 'hunk-1'], 2)], index);
    const owners = hunkOwners(topics.map((t) => t.hunkIds), index.units, new Set());
    assert.deepEqual(ownedHunkIds(topics[0].hunkIds, owners, 0), ['hunk-0:a', 'hunk-0:b']);
    assert.deepEqual(ownedHunkIds(topics[1].hunkIds, owners, 1), ['hunk-0:c', 'hunk-1']);
    assert.deepEqual([...shownElsewhere(topics[1].hunkIds, owners, 1)], [['hunk-0:b', 1]]);
    assert.deepEqual(ownerSections(topics[1].hunkIds, owners, 1), [1]);
    // The slide entries: a slice is its whole hunk with its range, ID and label; a whole hunk as today.
    const entries = focusDiffHunks(ownedHunkIds(topics[1].hunkIds, owners, 1), index, hunkMap);
    const [whole] = resolveDiffHunks(['hunk-0'], hunkMap);
    assert.deepEqual(entries[0], { ...whole, lineRanges: [{ start: 20, end: 29 }], sliceId: 'hunk-0:c', label: 'fn gamma' });
    assert.deepEqual(entries[1], resolveDiffHunks(['hunk-1'], hunkMap)[0]);
    // File contents and noise context follow the units' hunks.
    assert.deepEqual(unitHunkIds(topics[1].hunkIds, index), ['hunk-0', 'hunk-1']);
  });

  void test('writers: told exactly which code they show, with references read-only and definitions around slices', () => {
    const index = focusIndex(HUNKS, sliced());
    const topics = validateFocusTopics([topic('A', ['hunk-0:a'], 1), topic('B', ['hunk-0:a', 'hunk-0:c'], 2)], index);
    const owners = hunkOwners(topics.map((t) => t.hunkIds), index.units, new Set());
    const block = focusedTopicDiff(ownedHunkIds(topics[1].hunkIds, owners, 1), shownElsewhere(topics[1].hunkIds, owners, 1), index, hunkMap, BASE, HEAD);
    const shows = /<diff_hunks>([\s\S]*?)<\/diff_hunks>/.exec(block)?.[1] ?? '';
    assert.match(shows, /displays exactly the code below/);
    assert.match(shows, /--- src\/queue.ts \(added\) \[hunk-0:c\] fn gamma\nDefinitions:\n- fn gamma: `function gamma\(\) \{`\n@@ -0,0 \+21,10 @@\n\+function gamma\(\) \{/);
    assert.doesNotMatch(shows, /alpha/);
    assert.match(block, /<shown_in_other_sections>[\s\S]*\[hunk-0:a\] fn alpha \(shown in section 1\)\n@@ -0,0 \+1,10 @@\n\+function alpha/);
    // The writer context uses the block in place of the hunk blocks.
    const t = { ...topics[1], hunkIds: unitHunkIds(topics[1].hunkIds, index) };
    const ctx = buildTopicContext(t, hunkMap, BASE, HEAD, {}, 'PR', '', 'arc', topics, null, [], new Map(), block);
    assert.equal((ctx.match(/<diff_hunks>\n/g) ?? []).length, 1);
    assert.ok(ctx.includes(block));
    assert.match(ctx, /<file_contents_after>\n {2}<file path="src\/queue.ts">/);
  });

  void test('cutHunk gives each range its own header on both sides', () => {
    const [part] = cutHunk('@@ -1,12 +1,2 @@', OLD_LINES.join('\n'), [{ start: 1, end: 10 }]);
    // A side with no lines is numbered with the line before it.
    assert.equal(part.header, '@@ -2,10 +1,0 @@');
    assert.equal(cutHunk('@@ -0,0 +1,30 @@', NEW_LINES.join('\n'), [{ start: 20, end: 29 }])[0].header, '@@ -0,0 +21,10 @@');
    assert.equal(part.content.split('\n').length, 10);
  });

  void test('moves: the new copy records where it came from; the deleted slice is covered, not shown or left out', () => {
    const index = focusIndex(HUNKS, sliced());
    const [entry] = focusDiffHunks(['hunk-0:b'], index, hunkMap);
    assert.deepEqual(entry.movedFrom, { filePath: 'src/old.ts', startLine: 2, endLine: 11, body: 'edited' });
    const block = focusedTopicDiff(['hunk-0:b'], new Map(), index, hunkMap, BASE, HEAD);
    assert.match(block, /Moved from src\/old.ts \(old lines 2-11\)/);
    assert.match(block, /edited during the move[\s\S]*- {2}old 0[\s\S]*\+ {2}line 12/);
    // Identical moves say so, with no diff.
    const identical = sliced().map((h) => ({ ...h, slices: h.slices.map((s) => (s.moveBody ? { ...s, moveBody: 'identical' as const } : s)) }));
    assert.match(focusedTopicDiff(['hunk-0:b'], new Map(), focusIndex(HUNKS, identical), hunkMap, BASE, HEAD), /Its body is unchanged\.\n/);
    // Covered: no section lists hunk-2, and it is neither left out nor in Other changes.
    const owners = hunkOwners([['hunk-0:a', 'hunk-0:b', 'hunk-0:c', 'hunk-1']], index.units, new Set());
    assert.deepEqual(pick(focusLeftovers(index, owners, new Set())), { other: [], outside: [] });
    // A deletion that adds lines is never treated as moved (fail closed).
    const adds = sliced().map((h) => (h.hunkId === 'hunk-2' ? { ...h, slices: [{ ...h.slices[0], additions: 1 }] } : h));
    assert.equal(focusIndex(HUNKS, adds).movedAway.size, 0);
    // Nor is the "(part)" of a larger definition, at either end.
    const part = sliced().map((h) =>
      h.hunkId === 'hunk-0' ? { ...h, slices: h.slices.map((s) => (s.movedFrom ? { ...s, symbols: s.symbols.map((y) => ({ ...y, part: true as const })) } : s)) } : h
    );
    assert.equal(focusIndex(HUNKS, part).movedAway.size, 0);
    // A move that renamed the definition carries the names into movedFrom and the writer block.
    const renamed = sliced().map((h) => ({ ...h, slices: h.slices.map((s) => (s.moveBody ? { ...s, renamed: { from: 'beta', to: 'betaNext' } } : s)) }));
    const renamedIndex = focusIndex(HUNKS, renamed);
    assert.deepEqual(focusDiffHunks(['hunk-0:b'], renamedIndex, hunkMap)[0].movedFrom?.renamed, { from: 'beta', to: 'betaNext' });
    assert.match(focusedTopicDiff(['hunk-0:b'], new Map(), renamedIndex, hunkMap, BASE, HEAD), /renamed from beta to betaNext/);
  });

  void test('left out: units no section lists, unless under 20 changed lines together, which go to Other changes', () => {
    const index = focusIndex(HUNKS, sliced());
    // gamma (10) and small.ts (2) are left: 12 lines, under the limit.
    const small = hunkOwners([['hunk-0:a', 'hunk-0:b']], index.units, new Set());
    assert.deepEqual(pick(focusLeftovers(index, small, new Set())), { other: ['hunk-0:c', 'hunk-1'], outside: [] });
    // alpha, gamma and small.ts: 22 lines (FOCUS_OTHER_CHANGES_LINES is 20), left out and listed per file with line ranges.
    const big = hunkOwners([['hunk-0:b']], index.units, new Set());
    const { other, outside } = focusLeftovers(index, big, new Set());
    assert.deepEqual(other, []);
    assert.deepEqual(
      outside.map((o) => [o.filePath, o.id, o.label, o.newLines, o.oldLines, o.additions, o.deletions]),
      [
        ['src/queue.ts', 'hunk-0:a', 'fn alpha', [{ start: 1, end: 10 }], [], 10, 0],
        ['src/queue.ts', 'hunk-0:c', 'fn gamma', [{ start: 21, end: 30 }], [], 10, 0],
        ['src/small.ts', 'hunk-1', 'small.ts', [{ start: 2, end: 2 }], [{ start: 2, end: 2 }], 1, 1],
      ]
    );
    // Units of hunks cut as noise are neither.
    const cut = focusCutUnits(index, new Map([['hunk-0', { reason: 'noise' }]]));
    assert.deepEqual([...cut], ['hunk-0:a', 'hunk-0:b', 'hunk-0:c']);
    assert.deepEqual(pick(focusLeftovers(index, new Map(), cut)), { other: ['hunk-1'], outside: [] });
  });

  void test('a stub plan end to end: slice IDs in, ownership, left-out and slide entries out', () => {
    const index = focusIndex(HUNKS, sliced());
    const plan = { topics: [topic('Queue', ['hunk-0:b', 'bogus'], 1), topic('Small', ['hunk-1', 'hunk-0:b'], 2)] };
    const topics = validateFocusTopics(plan.topics, index);
    const owners = hunkOwners(topics.map((t) => t.hunkIds), index.units, new Set());
    const slides = topics.map((t, i) => focusDiffHunks(ownedHunkIds(t.hunkIds, owners, i), index, hunkMap));
    assert.deepEqual(slides.map((s) => s.map((h) => h.sliceId ?? h.filePath)), [['hunk-0:b'], ['src/small.ts']]);
    assert.deepEqual(ownerSections(topics[1].hunkIds, owners, 1), [1]);
    assert.deepEqual(focusLeftovers(index, owners, new Set()).outside.map((o) => o.id), ['hunk-0:a', 'hunk-0:c']);
  });
});

void describe('setting off', () => {
  void test('the setting is off by default', () => {
    assert.equal(DEFAULT_EXPLANATION_PREFERENCES.focusedSections, false);
    assert.equal(normalizeExplanationPreferences(null).focusedSections, false);
    assert.equal(normalizeExplanationPreferences({ focusedSections: 'yes' }).focusedSections, false);
    assert.equal(normalizeExplanationPreferences({ focusedSections: true }).focusedSections, true);
  });

  void test('a writer checkpoint key changes with the model and effort (#573)', () => {
    const identity = { topicCtx: 'context', topic: { title: 'T' } };
    const key = (model: string, effort: string) => fingerprint(writerCheckpointKey(identity, { model, effort }, undefined));
    assert.equal(key('claude-opus-5-5', 'high'), key('claude-opus-5-5', 'high'));
    assert.notEqual(key('claude-opus-5-5', 'high'), key('claude-sonnet-5-5', 'high'));
    assert.notEqual(key('claude-opus-5-5', 'high'), key('claude-opus-5-5', 'low'));
  });

  void test('the planner index, checkpoint keys and writer context are unchanged', () => {
    assert.equal(focusPlannerIndex(HUNKS, undefined), formatHunkIndexForPrompt(HUNKS));
    const identity = { version: 9, hunkIndex: 'x', reduceNoise: 'conservative' };
    assert.equal(focusCheckpointKey(identity, undefined), identity);
    assert.equal(fingerprint(focusCheckpointKey(identity, undefined)), fingerprint({ version: 9, hunkIndex: 'x', reduceNoise: 'conservative' }));
    // The writer's hunk blocks as #560 wrote them.
    const t = topic('T', ['hunk-1', 'hunk-0'], 1);
    const ctx = buildTopicContext(t, hunkMap, BASE, HEAD, {}, 'PR', '', 'arc', [t], null, [], new Map([['hunk-0', 1]]));
    assert.equal(ctx, buildTopicContext(t, hunkMap, BASE, HEAD, {}, 'PR', '', 'arc', [t], null, [], new Map([['hunk-0', 1]]), undefined));
    assert.ok(
      ctx.includes(
        `</topic>\n\n<diff_hunks>\n--- src/small.ts (modified) [hunk-1]\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n\n</diff_hunks>\n\n<shown_in_other_sections>\n`
      )
    );
    assert.ok(ctx.includes(`--- src/queue.ts [hunk-0] (shown in section 1)\n@@ -0,0 +1,30 @@\n+function alpha() {`));
  });

});

void describe('checkpoint keys', () => {
  void test('the slices content hash feeds the keys and changes with the slices', () => {
    const identity = { version: 9, plannerContext: 'same' };
    const a = focusIndex(HUNKS, sliced());
    const again = focusIndex(HUNKS, sliced());
    const noMoves = focusIndex(HUNKS, sliced(false));
    const whole = focusIndex(HUNKS, []);
    const resliced = focusIndex(
      HUNKS,
      sliced().map((h) =>
        h.hunkId === 'hunk-0' ? { ...h, slices: [slice('hunk-0:x', 'fn alpha', 0, 14), slice('hunk-0:y', 'fn beta', 15, 29)] } : h
      )
    );
    assert.equal(a.hash, again.hash);
    assert.notEqual(a.hash, noMoves.hash);
    assert.notEqual(a.hash, whole.hash);
    assert.notEqual(a.hash, resliced.hash);
    const key = (index: typeof a | undefined) => fingerprint(focusCheckpointKey(identity, index));
    assert.notEqual(key(a), key(undefined));
    assert.notEqual(key(a), key(resliced));
    assert.equal(key(a), key(again));
  });
});

void describe('review fixes', () => {
  void test('a moved old copy follows its new copy: cut with it, or left out next to it, never lost', () => {
    const index = focusIndex(HUNKS, sliced());
    // The new copy is cut as noise: the old copy is cut too, with where it moved.
    const cut = focusCutUnits(index, new Map([['hunk-0', { reason: 'noise' }]]));
    const owners = hunkOwners([['hunk-1']], index.units, cut);
    const cutCase = focusLeftovers(index, owners, cut);
    assert.deepEqual(cutCase.cutMoves, [{ id: 'hunk-2', to: 'hunk-0:b' }]);
    assert.deepEqual(cutCase.other, []);
    assert.deepEqual([...cutCase.placed].sort(), ['hunk-0', 'hunk-1', 'hunk-2']);
    assert.deepEqual(focusMovedNoise(index, cutCase.cutMoves, new Map([['hunk-0', { reason: 'formatting', source: 'planner' as const }]])), [
      { filePath: 'src/old.ts', side: 'before', startLine: 2, endLine: 11, reason: 'moved to src/queue.ts: formatting', source: 'planner' },
    ]);
    // The new copy is left out: the old copy is listed right after it, saying where it moved.
    const left = focusLeftovers(index, hunkOwners([['hunk-1']], index.units, new Set()), new Set());
    assert.deepEqual(
      left.outside.map((o) => [o.id, o.movedTo?.id]),
      [['hunk-0:a', undefined], ['hunk-0:b', undefined], ['hunk-2', 'hunk-0:b'], ['hunk-0:c', undefined]]
    );
    assert.deepEqual([...left.placed].sort(), ['hunk-0', 'hunk-1', 'hunk-2']);
    // Only an owned new copy covers its old copy.
    const covered = focusLeftovers(index, hunkOwners([['hunk-0:b']], index.units, new Set()), new Set());
    assert.ok(!covered.outside.some((o) => o.id === 'hunk-2'));
  });

  void test("a move's source is the symbol that holds the slice's changed lines", () => {
    const withOther = sliced().map((h) =>
      h.hunkId === 'hunk-2'
        ? {
            ...h,
            slices: [
              {
                ...h.slices[0],
                symbols: [
                  { side: 'before' as const, kind: 'function' as const, name: 'keep', label: 'fn keep', start: 1, end: 1, span: { start: 1, end: 1 } },
                  ...h.slices[0].symbols,
                ],
              },
            ],
          }
        : h
    );
    const index = focusIndex(HUNKS, withOther);
    assert.deepEqual(focusDiffHunks(['hunk-0:b'], index, hunkMap)[0].movedFrom, { filePath: 'src/old.ts', startLine: 2, endLine: 11, body: 'edited' });
    // No symbol holds all the removed lines: not a move (fail closed).
    const loose = sliced().map((h) =>
      h.hunkId === 'hunk-2' ? { ...h, slices: [{ ...h.slices[0], removed: [{ start: 1, end: 11 }] }] } : h
    );
    assert.equal(focusIndex(HUNKS, loose).movedAway.size, 0);
  });

  void test("a focused writer's file contents show only lines around its own code", () => {
    const index = focusIndex(HUNKS, sliced());
    const windows = focusFileWindows(['hunk-0:c'], index);
    assert.deepEqual([...windows.keys()], ['src/queue.ts']);
    const t = topic('B', ['hunk-0', 'hunk-1'], 1);
    const ctx = buildTopicContext(t, hunkMap, BASE, HEAD, {}, 'PR', '', 'arc', [t], null, [], new Map(), '<diff_hunks>\n</diff_hunks>', windows);
    const after = /<file_contents_after>([\s\S]*?)<\/file_contents_after>/.exec(ctx)?.[1] ?? '';
    assert.match(after, /21: function gamma\(\) \{/);
    assert.doesNotMatch(after, /function alpha|function beta/, 'other sections\' code is not plain source');
    assert.doesNotMatch(ctx, /<file path="src\/small.ts">/, 'a file the section shows no code of is omitted');
  });
});

void describe('review fixes, round 2', () => {
  void test('the planner cannot cut a moved old copy as noise while a topic lists its new copy', () => {
    const index = focusIndex(HUNKS, sliced());
    const noise = [{ hunkId: 'hunk-2', reason: 'deleted' }, { hunkId: 'hunk-1', reason: 'y' }];
    assert.deepEqual(focusPlannerNoise(noise, [topic('T', ['hunk-0:b'], 1)], index), [{ hunkId: 'hunk-1', reason: 'y' }]);
    assert.deepEqual(focusPlannerNoise(noise, [topic('T', ['hunk-0:a'], 1)], index), noise);
  });

  void test("an enclosing signature line comes alone, without another section's code around it", () => {
    // A slice deep inside a large definition: its signature is far above, next to code another section shows.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    lines[0] = 'impl Big {';
    const head = { 'src/queue.ts': lines.join('\n') };
    const deep = sliced().map((h) =>
      h.hunkId === 'hunk-0'
        ? {
            ...h,
            slices: h.slices.map((sl) =>
              sl.id === 'hunk-0:c'
                ? { ...sl, newLines: [{ start: 50, end: 55 }], symbols: [{ ...sl.symbols[0], start: 1, end: 60, span: { start: 1, end: 60 } }] }
                : sl
            ),
          }
        : h
    );
    const windows = focusFileWindows(['hunk-0:c'], focusIndex(HUNKS, deep));
    assert.deepEqual(windows.get('src/queue.ts')?.head, [{ start: 50, end: 55 }, { start: 1, end: 1, pad: 0 }]);
    const t = topic('B', ['hunk-0'], 1);
    const ctx = buildTopicContext(t, hunkMap, {}, head, {}, 'PR', '', 'arc', [t], null, [], new Map(), '<diff_hunks>\n</diff_hunks>', windows);
    const after = /<file_contents_after>([\s\S]*?)<\/file_contents_after>/.exec(ctx)?.[1] ?? '';
    assert.match(after, /\n1: impl Big \{\n/);
    assert.doesNotMatch(after, /\n2: line 2\n/, 'no padding around the signature');
    assert.match(after, /\n42: line 42\n/);
  });
});
