import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChatPrContext,
  CHAT_CONTEXT_BUDGETS,
  chatContextItemDetail,
  DEFAULT_CHAT_CONTEXT_BUDGET,
  estimateTokens,
  mentionedFiles,
  normalizeChatContextBudget,
  relateToAnchor,
  type ChatContextFile,
  type ChatContextInput,
} from '../lib/chat-pr-context';
import { chatContextTrace, traceCountText } from '../lib/chat-trace';

const diff = (lines: string[], start = 1) =>
  `@@ -${start},${lines.length} +${start},${lines.length} @@ function scope()\n${lines.map((l) => `+${l}`).join('\n')}`;
const file = (path: string, lines: string[], extra: Partial<ChatContextFile> = {}): ChatContextFile => ({
  path,
  status: 'modified',
  additions: lines.length,
  deletions: 0,
  patch: diff(lines),
  ...extra,
});

// The anchor imports scope.ts; worker.ts sits in its directory; retry.ts defines a name the anchor's change uses;
// config.ts is named in the question; big.ts is large and unrelated.
const files = [
  // The import is an unchanged line: an import edge, not a symbol the change uses.
  file('src/queue.ts', [], {
    additions: 1,
    patch: "@@ -1,1 +1,2 @@\n import { scope } from './lib/scope';\n+const next = backoffDelay(attempt);",
  }),
  file('src/lib/scope.ts', ['export function scope() {', '  return 1;', '}']),
  file('src/worker.ts', ['export const worker = 1;']),
  file('src/retry.ts', ['export function backoffDelay(attempt: number) {', '  return attempt * 2;', '}']),
  file('config/config.ts', ['export const limit = 5;']),
  file(
    'docs/big.ts',
    Array.from({ length: 400 }, (_, i) => `export const filler${i} = ${i}; // padding line`)
  ),
];
const input = (over: Partial<ChatContextInput> = {}): ChatContextInput => ({
  title: 'Bound the queue',
  description: 'Keeps queue order.',
  files,
  anchor: ['src/queue.ts'],
  question: 'What does config.ts change?',
  budgetTokens: 64_000,
  ...over,
});

void test('tokens are estimated at four characters each, and budgets come from the presets', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.deepEqual([...CHAT_CONTEXT_BUDGETS], [32_000, 64_000, 128_000]);
  assert.equal(DEFAULT_CHAT_CONTEXT_BUDGET, 64_000);
  assert.equal(normalizeChatContextBudget(128_000), 128_000);
  assert.equal(normalizeChatContextBudget(999), 64_000, 'Anything else is the default');
});

void test('related files rank by edge: a symbol, then an import, then the same directory', () => {
  const related = relateToAnchor(input());
  assert.deepEqual(
    related.map((r) => [r.path, r.strength, r.reason]),
    [
      ['src/retry.ts', 3, 'defines `backoffDelay`, which queue.ts uses'],
      ['src/lib/scope.ts', 2, 'imported by queue.ts'],
      ['src/worker.ts', 1, 'in the same directory as queue.ts'],
    ]
  );
  // A file that imports the anchor counts too.
  const importer = file('src/main.ts', ["import { queue } from './queue';"]);
  assert.deepEqual(
    relateToAnchor(input({ files: [...files, importer] })).find((r) => r.path === 'src/main.ts'),
    { path: 'src/main.ts', strength: 2, reason: 'imports queue.ts' }
  );
  // Tree-sitter definitions, when given, name what a file defines.
  const parsed = relateToAnchor(
    input({ definitions: { 'src/worker.ts': [{ name: 'backoffDelay', start: 1, end: 3 }] } })
  ).find((r) => r.path === 'src/worker.ts');
  assert.equal(parsed?.strength, 3);
});

void test('a file named in the question or the conversation is pulled in', () => {
  assert.deepEqual(mentionedFiles(input()), [{ path: 'config/config.ts', reason: 'named in your question' }]);
  assert.deepEqual(mentionedFiles(input({ question: 'And now?', history: [{ content: 'Look at docs/big.ts' }] })), [
    { path: 'docs/big.ts', reason: 'named earlier in the conversation' },
  ]);
  assert.deepEqual(mentionedFiles(input({ question: 'Why does backoffDelay double?' })), [
    { path: 'src/retry.ts', reason: 'defines `backoffDelay`, named in your question' },
  ]);
});

void test('the context fills in order: PR, selection, anchor, related, mentioned, the rest', () => {
  const context = buildChatPrContext(
    input({ selection: 'After line 2 of src/queue.ts:\nconst next = backoffDelay(attempt);' })
  );
  assert.deepEqual(
    context.items.map((i) => [i.kind, i.path ?? '', i.reason]),
    [
      ['pr', '', 'the PR: title, description and file list'],
      ['selection', '', 'the code you selected'],
      ['anchor', 'src/queue.ts', 'the file you asked about'],
      ['related', 'src/retry.ts', 'defines `backoffDelay`, which queue.ts uses'],
      ['related', 'src/lib/scope.ts', 'imported by queue.ts'],
      ['related', 'src/worker.ts', 'in the same directory as queue.ts'],
      ['mentioned', 'config/config.ts', 'named in your question'],
      ['diff', 'docs/big.ts', 'another change in this PR'],
    ]
  );
  assert.deepEqual(context.leftOut, []);
  assert.ok(context.tokens <= context.budget);
  assert.match(
    context.text,
    /<file path="src\/lib\/scope.ts" status="modified" changes="\+3 -0" included="imported by queue.ts">/
  );
  assert.ok(
    context.text.indexOf('<selected_code>') < context.text.indexOf('<file path="src/queue.ts"'),
    'The selection comes first'
  );
});

void test('a small budget cuts off at the least relevant files and lists them', () => {
  const context = buildChatPrContext(input({ budgetTokens: 1000 }));
  const kinds = context.items.map((i) => i.path ?? i.kind);
  assert.ok(kinds.includes('src/queue.ts') && kinds.includes('src/retry.ts'), kinds.join());
  assert.ok(context.leftOut.includes('docs/big.ts'), context.leftOut.join());
  assert.ok(context.tokens <= 1000, `${context.tokens}`);
  assert.match(context.text, /<not_included reason="context budget">[\s\S]*- docs\/big\.ts/);
  // A large diff that does not fit whole goes in hunk by hunk.
  const hunky: ChatContextFile = {
    path: 'src/many.ts',
    status: 'modified',
    additions: 300,
    deletions: 0,
    patch: Array.from({ length: 6 }, (_, h) =>
      diff(
        Array.from({ length: 50 }, (_, i) => `const h${h}_${i} = ${i};`),
        h * 100 + 1
      )
    ).join('\n'),
  };
  const partial = buildChatPrContext(input({ files: [hunky], anchor: ['src/many.ts'], budgetTokens: 1500 }));
  const anchor = partial.items.find((i) => i.path === 'src/many.ts');
  assert.ok(anchor?.partial && anchor.partial.hunks < 6 && anchor.partial.of === 6, JSON.stringify(anchor));
});

void test('the anchor source fills what is left, its changed definitions first', () => {
  const source = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n');
  const context = buildChatPrContext(
    input({
      files: [file('src/queue.ts', ['changed'], { patch: '@@ -10,1 +10,1 @@\n+changed' })],
      sources: { 'src/queue.ts': source },
      definitions: { 'src/queue.ts': [{ name: 'run', label: 'run()', start: 5, end: 20 }] },
      budgetTokens: 4000,
    })
  );
  const item = context.items.find((i) => i.kind === 'source');
  assert.equal(item?.reason, 'the source of `run()`, which the change touches');
  assert.match(context.text, /<source path="src\/queue.ts" revision="head" lines="5-20"/);
});

void test('the trace lists each item with its reason and size, and what was left out', () => {
  const context = buildChatPrContext(input({ budgetTokens: 1000 }));
  const trace = chatContextTrace(context, 2);
  const steps = trace.steps.map((s) => [s.kind, s.label]);
  assert.deepEqual(steps[0], ['pr', 'PR description']);
  assert.deepEqual(steps[1], ['diff', 'queue.ts']);
  assert.match(
    trace.steps[2].detail ?? '',
    /^src\/retry\.ts: defines `backoffDelay`, which queue\.ts uses · \d+ tokens$/
  );
  const omitted = trace.steps.find((s) => s.kind === 'omitted');
  assert.match(omitted?.label ?? '', /^\d+ changed files?$/);
  assert.match(omitted?.detail ?? '', /docs\/big\.ts/);
  assert.match(traceCountText(trace), /sources, \d+ left out$/);
  assert.equal(
    chatContextItemDetail({
      kind: 'related',
      path: 'a.ts',
      reason: 'imports scope.ts',
      tokens: 1234,
      partial: { hunks: 2, of: 5 },
    }),
    'imports scope.ts · 2 of 5 hunks · 1.2k tokens'
  );
});
