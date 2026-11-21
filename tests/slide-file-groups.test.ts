import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elsewhereChanges, groupSlideHunks, resolveBlock, slideFiles } from '../lib/slide-file-groups';
import { diffGaps, markElsewhere, revealedParts } from '../lib/diff-gaps';
import { reviewGapHunks } from '../lib/review-gap-hunks';
import { estimateCodeColumnHeight, estimateFileBlockHeight } from '../lib/review-gap-hunks';
import { buildTopicContext } from '../lib/context-builder';
import { generateReviewGuide, generateSlide, planReview } from '../lib/agent';
import { claudeProvider } from '../lib/providers/claude';
import type { IndexedHunk } from '../lib/diff-parse';
import type { DiffHunk, TopicPlan } from '../lib/types';

const hunk = (filePath: string, start: number, count = 3): DiffHunk => ({
  filePath,
  hunkHeader: `@@ -${start},${count} +${start},${count} @@`,
  content: Array.from({ length: count }, (_, i) => ` line ${start + i}`).join('\n'),
  language: 'typescript',
  renderedHtml: '',
});
const order = (hunks: DiffHunk[]) => groupSlideHunks(hunks).map((g) => [g.filePath, g.hunks.map((h) => h.hunkHeader)]);

void test('a reading order that returns to a file gives the file another block', () => {
  const [a1, b1, a2] = [hunk('a.ts', 1), hunk('b.ts', 1), hunk('a.ts', 40)];
  const groups = groupSlideHunks([a1, b1, a2]);
  assert.deepEqual(
    groups.map((g) => [g.filePath, g.run, g.hunks]),
    [
      ['a.ts', 0, [a1]],
      ['b.ts', 0, [b1]],
      ['a.ts', 1, [a2]],
    ]
  );
  assert.equal(new Set(groups.map((g) => g.key)).size, 3, 'every block has its own key');
  assert.equal(groups[0].key, 'a.ts', 'the first block keeps the path as its key, as saved state did');
  assert.notEqual(groups[2].key, 'a.ts');
  assert.deepEqual(slideFiles(groups).get('a.ts')?.keys, [groups[0].key, groups[2].key]);
});

void test('consecutive hunks of one file share a block', () => {
  assert.deepEqual(order([hunk('a.ts', 1), hunk('a.ts', 40), hunk('b.ts', 1)]), [
    ['a.ts', ['@@ -1,3 +1,3 @@', '@@ -40,3 +40,3 @@']],
    ['b.ts', ['@@ -1,3 +1,3 @@']],
  ]);
});

void test('a hunk listed above the one before it in its file starts a new block, as each block shows line order', () => {
  const groups = groupSlideHunks([hunk('a.ts', 40), hunk('a.ts', 1)]);
  assert.deepEqual(
    groups.map((g) => [g.run, g.hunks[0].hunkHeader]),
    [
      [0, '@@ -40,3 +40,3 @@'],
      [1, '@@ -1,3 +1,3 @@'],
    ]
  );
});

void test('older explanations, saved sorted by file, group exactly as before', () => {
  const sorted = [hunk('a.ts', 1), hunk('a.ts', 20), hunk('b.ts', 5), hunk('c.ts', 1), hunk('c.ts', 9)];
  assert.deepEqual(
    groupSlideHunks(sorted).map((g) => [g.filePath, g.hunks.length, g.run, g.key]),
    [
      ['a.ts', 2, 0, 'a.ts'],
      ['b.ts', 1, 0, 'b.ts'],
      ['c.ts', 2, 0, 'c.ts'],
    ]
  );
});

/** A saved hunk that changes its middle line, with context around it. */
const changed = (filePath: string, start: number): DiffHunk => ({
  filePath,
  hunkHeader: `@@ -${start},5 +${start},5 @@`,
  content: [
    ` ctx ${start}`,
    ` ctx ${start + 1}`,
    `-old ${start + 2}`,
    `+new ${start + 2}`,
    ` ctx ${start + 3}`,
    ` ctx ${start + 4}`,
  ].join('\n'),
  language: 'typescript',
  renderedHtml: '',
});

void test('hunks of one file that overlap or touch share a block, wherever the order lists them', () => {
  const [a1, b, a2] = [changed('a.ts', 10), changed('b.ts', 1), changed('a.ts', 12)];
  const groups = groupSlideHunks([a1, b, a2]);
  assert.deepEqual(
    groups.map((g) => [g.filePath, g.run, g.hunks]),
    [
      ['a.ts', 0, [a1, a2]],
      ['b.ts', 0, [b]],
    ]
  );
  // Touching on the new side (10-14, then 15-19) also joins; one line apart does not.
  assert.equal(groupSlideHunks([changed('a.ts', 10), b, changed('a.ts', 15)]).length, 2);
  assert.equal(groupSlideHunks([changed('a.ts', 10), b, changed('a.ts', 16)]).length, 3);
  // Listed out of line order, overlapping hunks still share a block.
  assert.equal(groupSlideHunks([changed('a.ts', 12), changed('a.ts', 10)]).length, 1);
});

void test('in [A1, A3, B, A2], the gaps over A2 and over A1 and A3 stop before it and name the other block', () => {
  const [a1, a3, b, a2] = [changed('a.ts', 10), changed('a.ts', 100), changed('b.ts', 1), changed('a.ts', 50)];
  const groups = groupSlideHunks([a1, a3, b, a2]);
  assert.deepEqual(
    groups.map((g) => [g.filePath, g.run, g.hunks.length]),
    [
      ['a.ts', 0, 2],
      ['b.ts', 0, 1],
      ['a.ts', 1, 1],
    ]
  );
  const elsewhere = elsewhereChanges(groups);
  assert.equal(elsewhere.get('b.ts'), undefined, 'a file in one block has nothing elsewhere');
  const gapsOf = (key: string) => {
    const saved = reviewGapHunks(groups.find((g) => g.key === key)?.hunks ?? []);
    return markElsewhere(diffGaps(saved.hunks, 200, { partial: true }) ?? [], elsewhere.get(key));
  };
  const first = gapsOf(groups[0].key);
  // A1 shows 10-14 with three lines of context, A3 100-104: the gap between them holds A2's change at 52.
  const between = first.find((gap) => gap.newStart <= 52 && (gap.newEnd ?? Infinity) >= 52);
  assert.ok(between);
  // It reveals 15-51 from A1 and 53-99 from A3, at most: never A2's change at 52.
  assert.deepEqual(
    [between.opaque, between.elsewhere, between.elsewhereLine, between.revealDown, between.revealUp],
    [true, 1, 52, 37, 47]
  );
  assert.ok(
    first.filter((gap) => gap !== between).every((gap) => gap.elsewhere === undefined),
    'gaps that hold no other block’s change still reveal'
  );
  const second = gapsOf(groups[2].key);
  assert.deepEqual(
    second.map((gap) => gap.elsewhere),
    [0, 0],
    'A2’s gaps above and below cover A1 and A3'
  );
});

/** A saved hunk of `count` lines from `start` whose line `at` changes. */
const long = (filePath: string, start: number, count: number, at: number): DiffHunk => ({
  filePath,
  hunkHeader: `@@ -${start},${count} +${start},${count} @@`,
  content: Array.from({ length: count }, (_, i) =>
    start + i === at ? `-old ${at}\n+new ${at}` : ` ctx ${start + i}`
  ).join('\n'),
  language: 'typescript',
  renderedHtml: '',
});

void test('a block still reveals its own saved context up to the other block’s change', () => {
  // A@10-40 changes line 25, A@60-90 line 75: each block shows its change with three lines of context.
  const groups = groupSlideHunks([long('a.ts', 10, 31, 25), changed('b.ts', 1), long('a.ts', 60, 31, 75)]);
  const elsewhere = elsewhereChanges(groups);
  const shownAfterAll = (key: string) => {
    const saved = reviewGapHunks(groups.find((g) => g.key === key)?.hunks ?? []);
    const gaps = markElsewhere(diffGaps(saved.hunks, 200, { partial: true }) ?? [], elsewhere.get(key));
    const reveals = Object.fromEntries(gaps.map((gap) => [gap.index, { down: Infinity, up: Infinity }]));
    // The view has only the saved lines here, as before the after side is read.
    return revealedParts(saved.hunks, gaps, reveals, saved.known)
      .filter((part) => part.kind === 'gap')
      .map((part) => [part.start, part.end, part.gap.elsewhere]);
  };
  // Block 0 shows 22-28; above, it reveals its saved 10-21; below, its saved 29-40, then hides the rest, which holds
  // block 1's change.
  assert.deepEqual(shownAfterAll(groups[0].key), [
    [1, 9, undefined],
    [41, 200, 1],
  ]);
  // Block 1 shows 72-78; above, it reveals its saved 60-71 and hides 1-59, which holds block 0's change; below, its
  // saved 79-90.
  assert.deepEqual(shownAfterAll(groups[2].key), [
    [1, 59, 0],
    [91, 200, undefined],
  ]);
});

void test('a gap over changes of two other blocks names the nearest', () => {
  const groups = groupSlideHunks([
    changed('a.ts', 100),
    changed('b.ts', 1),
    changed('a.ts', 50),
    changed('c.ts', 1),
    changed('a.ts', 10),
  ]);
  assert.deepEqual(
    groups.filter((g) => g.filePath === 'a.ts').map((g) => [g.run, g.hunks[0].hunkHeader]),
    [
      [0, '@@ -100,5 +100,5 @@'],
      [1, '@@ -50,5 +50,5 @@'],
      [2, '@@ -10,5 +10,5 @@'],
    ]
  );
  const key = groups.find((g) => g.run === 2 && g.filePath === 'a.ts')?.key ?? '';
  const saved = reviewGapHunks(groups.find((g) => g.key === key)?.hunks ?? []);
  const gaps = markElsewhere(diffGaps(saved.hunks, 200, { partial: true }) ?? [], elsewhereChanges(groups).get(key));
  const below = gaps.at(-1);
  assert.deepEqual(
    [below?.elsewhere, below?.elsewhereLine],
    [1, 52],
    'block 1’s change at 52 is nearer than block 0’s'
  );
});

void test('changes are read from the rows the diff renders: a deletion with no new lines sits after its line', () => {
  const deletion: DiffHunk = {
    filePath: 'a.ts',
    hunkHeader: '@@ -5,2 +4,0 @@',
    content: '-gone 5\n-gone 6',
    language: 'typescript',
    renderedHtml: '',
  };
  const groups = groupSlideHunks([changed('a.ts', 40), changed('b.ts', 1), deletion]);
  assert.deepEqual(elsewhereChanges(groups).get(groups[0].key), [{ start: 5, end: 5, run: 1 }]);
  // A hunk saved without diff markers in an added file is all additions.
  const added: DiffHunk = { ...deletion, hunkHeader: '@@ -0,0 +1,3 @@', content: 'one\ntwo\nthree' };
  const fresh = groupSlideHunks([changed('a.ts', 40), changed('b.ts', 1), added]);
  assert.deepEqual(elsewhereChanges(fresh, () => 'added').get(fresh[0].key), [{ start: 1, end: 3, run: 1 }]);
});

void test('a jump lands in the block that shows the line, the new side first', () => {
  type Block = { name: string; shows: Partial<Record<'LEFT' | 'RIGHT', boolean>>; old?: string; new?: string };
  const blocks: Block[] = [
    { name: 'first', shows: { LEFT: true }, old: '40-45', new: '1-5' },
    { name: 'second', shows: { RIGHT: true }, old: '1-5', new: '40-45' },
  ];
  const resolve = (line: number | undefined, side?: 'LEFT' | 'RIGHT', list = blocks) =>
    resolveBlock(
      list,
      { line, side },
      (b, s) => !!b.shows[s],
      (b, s) => (s === 'LEFT' ? b.old : b.new)
    )?.name;
  assert.equal(resolve(42), 'second', 'the new side wins when both sides show the line number');
  assert.equal(resolve(42, 'LEFT'), 'first');
  // Collapsed blocks show no lines: their saved spans decide, the new side first.
  const collapsed = blocks.map((b) => ({ ...b, shows: {} }));
  assert.equal(resolve(42, undefined, collapsed), 'second');
  assert.equal(resolve(3, undefined, collapsed), 'first');
  assert.equal(resolve(3, 'LEFT', collapsed), 'second');
  assert.equal(resolve(400, undefined, collapsed), 'first', 'a line no block holds falls back to the first');
  assert.equal(resolve(undefined), 'first');
  // A saved new-side span wins over a rendered old-side line.
  const mixed: Block[] = [
    { name: 'old shown', shows: { LEFT: true }, old: '40-45', new: '1-5' },
    { name: 'new saved', shows: {}, old: '1-5', new: '40-45' },
  ];
  assert.equal(resolve(42, undefined, mixed), 'new saved');
});

void test('the code column estimate counts each block of a file', () => {
  const hunks = [hunk('a.ts', 1), hunk('b.ts', 1), hunk('a.ts', 40)];
  const blocks = 80 + 20 * 3 + hunks.reduce((sum, h) => sum + estimateFileBlockHeight([h]), 0);
  assert.equal(estimateCodeColumnHeight(hunks), Math.round(blocks));
});

const READING_RULE =
  /List each topic's hunk IDs in the order a reader should read them to build an understanding of the change/;

void test('the planner and the single-pass prompt ask for hunks in reading order', async (t) => {
  const prompts: string[] = [];
  t.mock.method(claudeProvider, 'generate', ({ systemPrompt }: { systemPrompt: string }) => {
    prompts.push(systemPrompt);
    return Promise.resolve(
      prompts.length === 1
        ? JSON.stringify({ summary: 'S', riskLevel: 'low', topics: [{ title: 'T', hunkIds: [] }] })
        : JSON.stringify({ prTitle: 'P', summary: 'S', riskLevel: 'low', slides: [] })
    );
  });
  await planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never);
  await generateReviewGuide({
    providerName: 'claude',
    model: 'claude-sonnet-5-5' as never,
    contextPackage: 'ctx',
    prUrl: '',
  });
  const [planner, single] = prompts;
  assert.match(planner, READING_RULE);
  assert.match(planner, /Lead with the core change, or with the definition the rest depends on/);
  assert.match(planner, /Within one file, keep line order unless reading it differently is clearly better/);
  assert.match(single, READING_RULE);
  assert.match(single, /Order IDs within each slide in reading order/);
  assert.doesNotMatch(single, /by file path \(alphabetical\)/);
});

void test('the writer sees its hunks in the planned order and is told to follow it', async (t) => {
  const prompts: string[] = [];
  t.mock.method(claudeProvider, 'generate', ({ systemPrompt }: { systemPrompt: string }) => {
    prompts.push(systemPrompt);
    return Promise.resolve(JSON.stringify({ title: 'T', narrative: 'N', reviewFocus: null }));
  });
  const indexed = (id: string, filePath: string) =>
    ({
      id,
      filePath,
      fileStatus: 'modified',
      expandedHunkHeader: `@@ ${id} @@`,
      expandedContent: `+${id}`,
    }) as unknown as IndexedHunk;
  const map = new Map([
    ['hunk-0', indexed('hunk-0', 'a.ts')],
    ['hunk-1', indexed('hunk-1', 'a.ts')],
    ['hunk-2', indexed('hunk-2', 'b.ts')],
  ]);
  const topic = {
    title: 'T',
    slideType: 'feature',
    importance: 'important',
    hunkIds: ['hunk-2', 'hunk-0', 'hunk-1'],
    dependsOn: [],
    order: 1,
    narrativeBrief: '',
  } as unknown as TopicPlan;
  const context = buildTopicContext(topic, map, {}, {}, {}, 'PR', '', 'arc', [topic]);
  const at = (id: string) => context.indexOf(`[${id}]`);
  assert.ok(at('hunk-2') < at('hunk-0') && at('hunk-0') < at('hunk-1'), 'hunks keep the planner order');
  await generateSlide({ providerName: 'claude', model: 'claude-sonnet-5-5' as never, topicContext: context });
  assert.match(prompts[0], /The <diff_hunks> arrive in reading order/);
  assert.match(prompts[0], /Follow the same order in the narrative/);
});
