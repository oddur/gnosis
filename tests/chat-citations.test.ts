import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_CITATION_INSTRUCTION,
  citationFromIsland,
  citationLabel,
  hunkNewLines,
  parseChatCitation,
  resolveChatCitation,
  withChatCitations,
} from '../lib/chat-citations';
import { buildSlideChatSystemPrompt } from '../lib/chat-agent';

const files = ['src/queue.ts', 'src/worker.ts', 'lib/queue.ts', 'README.md', 'src/deep/path/retry-policy.config.json'];

void test('citations parse from the bracket text the prompt asks for', () => {
  assert.deepEqual(parseChatCitation('src/queue.ts:40-52'), {
    kind: 'file',
    path: 'src/queue.ts',
    startLine: 40,
    endLine: 52,
    raw: 'src/queue.ts:40-52',
  });
  assert.deepEqual(parseChatCitation('src/queue.ts:40–52'), parseChatCitation('src/queue.ts:40–52'));
  assert.equal(parseChatCitation('src/queue.ts:L40-L52')?.kind, 'file');
  assert.deepEqual(parseChatCitation('worker.ts:7'), {
    kind: 'file',
    path: 'worker.ts',
    startLine: 7,
    endLine: 7,
    raw: 'worker.ts:7',
  });
  assert.deepEqual(parseChatCitation('./README.md'), { kind: 'file', path: 'README.md', raw: './README.md' });
  assert.deepEqual(parseChatCitation('https://example.com/docs?a=1'), {
    kind: 'url',
    url: 'https://example.com/docs?a=1',
    raw: 'https://example.com/docs?a=1',
  });
  for (const prose of [
    'note',
    'x',
    ' ',
    'see above',
    'src/queue.ts:abc',
    '../etc/passwd',
    'src//a.ts',
    'javascript:alert(1)',
    'ftp://host/file',
  ])
    assert.equal(parseChatCitation(prose), undefined, prose);
});

void test('a citation resolves only to a file in the PR', () => {
  const resolve = (text: string) => resolveChatCitation(parseChatCitation(text), files);
  const pathOf = (c: ReturnType<typeof resolve>) => (c?.kind === 'file' ? c.path : undefined);
  assert.deepEqual(resolve('src/queue.ts:40-52'), {
    kind: 'file',
    path: 'src/queue.ts',
    startLine: 40,
    endLine: 52,
    raw: 'src/queue.ts:40-52',
    label: 'queue.ts:40–52',
  });
  assert.equal(
    pathOf(resolve('worker.ts:7')),
    'src/worker.ts',
    'A unique file name resolves to its path'
  );
  assert.equal(resolve('queue.ts:1'), undefined, 'Two PR files end in queue.ts: ambiguous, so plain text');
  assert.equal(resolve('src/missing.ts:3'), undefined, 'A file outside the PR is never cited');
  assert.equal(
    pathOf(resolve('b/src/queue.ts:4')),
    'src/queue.ts',
    'Diff prefixes are dropped'
  );
  assert.equal(resolve('src/queue.ts:52-40'), undefined, 'Lines out of order');
  assert.equal(resolve('src/queue.ts:0'), undefined, 'Lines start at 1');
  assert.equal(resolve('src/queue.ts:1-9000'), undefined, 'A range that is a whole file is not a line citation');
  assert.equal(resolve('README.md')?.label, 'README.md');
  assert.equal(resolveChatCitation(parseChatCitation('src/queue.ts:1'), []), undefined, 'No files, no citations');
  assert.deepEqual(resolve('https://www.example.com/a'), {
    kind: 'url',
    url: 'https://www.example.com/a',
    raw: 'https://www.example.com/a',
    host: 'example.com',
    label: 'example.com',
  });
});

void test('citations outside code become inline islands; code, links and prose stay', () => {
  assert.equal(
    withChatCitations('The slot is reserved first [src/queue.ts:40-52].'),
    'The slot is reserved first :cite[queue.ts:40–52]{path="src/queue.ts" start="40" end="52" raw="src/queue.ts:40-52"}.'
  );
  assert.equal(
    withChatCitations('Both sides [src/queue.ts:4, src/worker.ts:7-9].'),
    'Both sides :cite[queue.ts:4]{path="src/queue.ts" start="4" end="4" raw="src/queue.ts:4"} :cite[worker.ts:7–9]{path="src/worker.ts" start="7" end="9" raw="src/worker.ts:7-9"}.'
  );
  for (const unchanged of [
    'A [link](https://example.com) and a [ref][1] and ![img](a.png).',
    '- [ ] a task and [x] another',
    'An array `items[src/queue.ts:4]` in code.',
    '```ts\nconst a = map[src/queue.ts:4];\n```',
    '~~~\n[src/queue.ts:4]\n~~~',
    'Mixed [src/queue.ts:4, not a citation] stays.',
    '[note]: https://example.com',
  ])
    assert.equal(withChatCitations(unchanged), unchanged, unchanged);
  assert.equal(
    withChatCitations('```\n[src/a.ts:1]\n```\nAfter [src/a.ts:2]'),
    '```\n[src/a.ts:1]\n```\nAfter :cite[a.ts:2]{path="src/a.ts" start="2" end="2" raw="src/a.ts:2"}',
    'Only the citation after the fence changes'
  );
  // An unfinished bracket while the answer streams waits for its end.
  assert.equal(withChatCitations('Reserved first [src/que'), 'Reserved first [src/que');
});

void test('an island reads back as the citation it was written from', () => {
  assert.deepEqual(
    citationFromIsland({
      id: '1',
      label: 'queue.ts:40–52',
      path: 'src/queue.ts',
      start: '40',
      end: '52',
      raw: 'src/queue.ts:40-52',
    }),
    {
      kind: 'file',
      path: 'src/queue.ts',
      startLine: 40,
      endLine: 52,
      raw: 'src/queue.ts:40-52',
    }
  );
  // A model that writes the island itself goes through the same check.
  assert.equal(
    resolveChatCitation(citationFromIsland({ id: '2', path: 'src/secret.ts', start: '1' }), files),
    undefined
  );
  assert.equal(citationFromIsland({ id: '3', url: 'javascript:alert(1)' }), undefined);
  assert.equal(citationLabel({ kind: 'file', path: 'a/b/c.ts', startLine: 3, endLine: 3, raw: '' }), 'c.ts:3');
});

void test('a citation card previews the new lines of the hunk', () => {
  const lines = hunkNewLines(
    '@@ -38,3 +40,3 @@',
    ' await queue.dispatch(command);\n-old();\n+await worker.acknowledge(id);\n return command.result;'
  );
  assert.deepEqual(
    [...lines],
    [
      [40, 'await queue.dispatch(command);'],
      [41, 'await worker.acknowledge(id);'],
      [42, 'return command.result;'],
    ]
  );
  assert.equal(hunkNewLines('not a header', '+x').size, 0);
});

void test('chat prompts ask for the citation format the renderer reads', () => {
  assert.ok(buildSlideChatSystemPrompt().includes(CHAT_CITATION_INSTRUCTION));
  assert.match(CHAT_CITATION_INSTRUCTION, /\[path:start-end\]/);
  assert.match(CHAT_CITATION_INSTRUCTION, /Cite only files that appear/);
});
