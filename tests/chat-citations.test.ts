import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_CITATION_INSTRUCTION,
  citationFromIsland,
  citationLabel,
  hunkNewLines,
  hunkNewRange,
  patchBounds,
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
  const resolve = (text: string) => resolveChatCitation(parseChatCitation(text), files, () => ({ max: 1000 }));
  const pathOf = (c: ReturnType<typeof resolve>) => (c?.kind === 'file' ? c.path : undefined);
  assert.deepEqual(resolve('src/queue.ts:40-52'), {
    kind: 'file',
    path: 'src/queue.ts',
    startLine: 40,
    endLine: 52,
    raw: 'src/queue.ts:40-52',
    label: 'queue.ts:40–52',
  });
  assert.equal(pathOf(resolve('worker.ts:7')), 'src/worker.ts', 'A unique file name resolves to its path');
  assert.equal(resolve('queue.ts:1'), undefined, 'Two PR files end in queue.ts: ambiguous, so plain text');
  assert.equal(resolve('src/missing.ts:3'), undefined, 'A file outside the PR is never cited');
  assert.equal(pathOf(resolve('b/src/queue.ts:4')), 'src/queue.ts', 'Diff prefixes are dropped');
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

void test('the instruction cites new-file lines only, and removed code without lines', () => {
  assert.match(CHAT_CITATION_INSTRUCTION, /Line numbers always mean the new version/);
  assert.match(CHAT_CITATION_INSTRUCTION, /for code the PR removes, cite the file without lines, as \[path\]/);
  assert.doesNotMatch(CHAT_CITATION_INSTRUCTION, /old version for removed code/);
});

void test('citations in a fence inside a list item stay code', () => {
  const markdown =
    '1. Change the queue:\n\n    ```ts\n    const a = map[src/queue.ts:4];\n    ```\n\n2. See [src/queue.ts:5].';
  const out = withChatCitations(markdown);
  assert.match(out, /const a = map\[src\/queue\.ts:4\];/, out);
  assert.match(out, /See :cite\[queue\.ts:5\]/, out);
  // A paragraph indented under a list item is prose, and an indented code block runs past its first line.
  assert.match(withChatCitations('- Item\n\n    See [src/a.ts:1].'), /:cite\[a\.ts:1\]/);
  assert.equal(
    withChatCitations('Text\n\n    code();\n    map[src/a.ts:2];'),
    'Text\n\n    code();\n    map[src/a.ts:2];'
  );
});

void test('line 0 is not a line, and never a whole-file citation', () => {
  const zero = parseChatCitation('src/queue.ts:0');
  assert.equal(
    resolveChatCitation(zero, files, () => ({ max: 100 })),
    undefined
  );
  assert.equal(
    resolveChatCitation(parseChatCitation('src/queue.ts:0-3'), files, () => ({ max: 100 })),
    undefined
  );
  assert.match(
    withChatCitations('[src/queue.ts:0]'),
    /start="0" end="0"/,
    'The island keeps the 0, so it fails to resolve'
  );
  assert.deepEqual(citationFromIsland({ id: '1', path: 'src/queue.ts', start: '0', end: '0' }), {
    kind: 'file',
    path: 'src/queue.ts',
    startLine: 0,
    endLine: 0,
    raw: '',
  });
});

void test('lines must fall within what the PR shows of the file', () => {
  const cite = (text: string, bounds?: Parameters<typeof resolveChatCitation>[2]) =>
    resolveChatCitation(parseChatCitation(text), files, bounds);
  assert.equal(
    cite('src/queue.ts:9000-9001', () => ({ max: 120 })),
    undefined,
    'A made-up 9000-line citation'
  );
  assert.equal(cite('src/queue.ts:40-41'), undefined, 'No known length: plain text');
  assert.ok(cite('src/queue.ts:40-41', () => ({ max: 120 })));
  assert.ok(
    cite('src/queue.ts:40-41', () => ({ ranges: [[38, 45]] })),
    'Within a topic hunk'
  );
  assert.equal(
    cite('src/queue.ts:44-50', () => ({ ranges: [[38, 45]] })),
    undefined,
    'Past the hunk'
  );
  assert.ok(cite('src/queue.ts'), 'A file without lines needs no bounds');
  assert.deepEqual(patchBounds({ status: 'added', additions: 90 }), { max: 90 });
  assert.deepEqual(
    patchBounds({ status: 'modified', additions: 1, patch: '@@ -1,3 +1,4 @@\n a\n+b\n@@ -40,2 +41,3 @@ fn\n x' }),
    { max: 43 }
  );
  assert.equal(patchBounds({ status: 'deleted', additions: 0 }), undefined);
  assert.equal(patchBounds({ status: 'modified', additions: 1 }), undefined, 'No patch, no known length');
  assert.deepEqual(hunkNewRange('@@ -3 +3 @@'), [3, 3]);
  assert.equal(hunkNewRange('@@ -3,2 +2,0 @@'), undefined);
});

void test('an exact path wins over a stripped or suffix match', () => {
  const both = ['x.ts', 'b/x.ts'];
  const pathOf = (text: string) => {
    const c = resolveChatCitation(parseChatCitation(text), both);
    return c?.kind === 'file' ? c.path : undefined;
  };
  assert.equal(pathOf('b/x.ts'), 'b/x.ts');
  assert.equal(pathOf('x.ts'), 'x.ts');
  assert.equal(pathOf('a/x.ts'), 'x.ts', 'A diff prefix is stripped when nothing matches exactly');
});
