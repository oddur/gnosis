import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupSlideHunks, slideFileKeys, slideFileRunOfLine } from '../lib/slide-file-groups';
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
  assert.deepEqual(slideFileKeys(groups, 'a.ts'), [groups[0].key, groups[2].key]);
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

void test('a jump to a line opens the block that holds it', () => {
  const hunks = [hunk('a.ts', 1), hunk('b.ts', 1), hunk('a.ts', 40)];
  assert.equal(slideFileRunOfLine(hunks, 'a.ts', 2), 0);
  assert.equal(slideFileRunOfLine(hunks, 'a.ts', 41), 1);
  assert.equal(slideFileRunOfLine(hunks, 'a.ts', 41, 'LEFT'), 1);
  assert.equal(slideFileRunOfLine(hunks, 'a.ts', 400), 0, 'a line outside every block falls back to the first');
  assert.equal(slideFileRunOfLine(hunks, 'b.ts', 2), 0);
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
