import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatDiff, withDiffIslands } from '../lib/chat-diffs';

const gitPatch = [
  'diff --git a/src/queue.ts b/src/queue.ts',
  'index 1111111..2222222 100644',
  '--- a/src/queue.ts',
  '+++ b/src/queue.ts',
  '@@ -10,3 +10,3 @@ export class Queue {',
  '   dispatch(command) {',
  '-    this.send(command);',
  '+    await this.send(command);',
  '',
  '@@ -40,2 +40,3 @@',
  '   ack(id) {',
  '+    this.release(id);',
  '   }',
].join('\n');

void test('parseChatDiff reads files and hunks from a git patch', () => {
  const files = parseChatDiff(gitPatch);
  assert.ok(files);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/queue.ts');
  assert.deepEqual(
    files[0].hunks.map((h) => [h.filePath, h.hunkHeader]),
    [
      ['src/queue.ts', '@@ -10,3 +10,3 @@'],
      ['src/queue.ts', '@@ -40,2 +40,3 @@'],
    ]
  );
  // A model drops the space of an empty context line; it reads as context.
  assert.equal(files[0].hunks[0].content.split('\n').at(-1), ' ');
});

void test('parseChatDiff reads several files, and a bare hunk without file names', () => {
  const two = parseChatDiff(
    '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/b.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone'
  );
  assert.deepEqual(
    two?.map((f) => [f.path, f.hunks.length]),
    [
      ['a.ts', 1],
      ['b.ts', 1],
    ]
  );
  assert.deepEqual(
    parseChatDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c')?.map((f) => f.path),
    ['']
  );
});

void test('parseChatDiff refuses what is not a readable patch', () => {
  // A "diff" fence without hunk headers: plus and minus lines alone have no line numbers.
  assert.equal(parseChatDiff('-old\n+new'), undefined);
  // Prose inside a hunk.
  assert.equal(parseChatDiff('@@ -1 +1 @@\n-a\nthen this changes\n+b'), undefined);
  assert.equal(parseChatDiff(''), undefined);
});

void test('withDiffIslands turns closed, readable diff fences into numbered islands', () => {
  const markdown = `Change it so:\n\n\`\`\`diff\n${gitPatch}\n\`\`\`\n\nThen this:\n\n\`\`\`diff\n-old\n+new\n\`\`\`\n\nAnd:\n\n~~~patch\n@@ -1 +1 @@\n-a\n+b\n~~~\n`;
  const out = withDiffIslands(markdown);
  const islands = [...out.matchAll(/```island-diff\n(.*)\n```/g)].map(
    (m) => JSON.parse(m[1]) as { id: string; patch: string }
  );
  assert.deepEqual(
    islands.map((i) => i.id),
    ['diff-0', 'diff-2'],
    'Each diff fence has its place in the count, so later islands keep their ids'
  );
  assert.equal(islands[0].patch, gitPatch);
  assert.match(out, /```diff\n-old\n\+new\n```/, 'An unreadable diff stays a code block');
  assert.match(out, /^Change it so:\n\n/);
  assert.match(out, /\n\nAnd:\n\n```island-diff/);
});

void test('withDiffIslands leaves a fence that is still streaming, and other languages, as they are', () => {
  const streaming = `Here:\n\n\`\`\`diff\n${gitPatch}`;
  assert.equal(withDiffIslands(streaming), streaming);
  const other = '```ts\nconst diff = 1;\n```\n\n````md\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n````';
  assert.equal(withDiffIslands(other), other, 'A diff fence quoted inside another fence is text');
  assert.equal(withDiffIslands('No code here.'), 'No code here.');
});
