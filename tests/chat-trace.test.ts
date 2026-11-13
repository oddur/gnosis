import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendTraceSteps,
  fileChatTrace,
  hunkLineRange,
  lineRangeText,
  parseChatTrace,
  slideChatTrace,
  toolCallStep,
  traceCountText,
  traceLabel,
  type AgentToolCall,
} from '../lib/chat-trace';
import { createClaudeEventHandler } from '../lib/providers/claude';
import { createCodexEventHandler } from '../lib/providers/codex';

const lines = (file: string) => fs.readFileSync(path.resolve('tests/fixtures', file), 'utf8').split('\n');

void test('hunk headers become the line ranges a chip opens', () => {
  assert.deepEqual(hunkLineRange('@@ -38,6 +40,81 @@ function retry()'), {
    startLine: 40,
    endLine: 120,
    side: 'after',
  });
  assert.deepEqual(hunkLineRange('@@ -7 +7 @@'), { startLine: 7, endLine: 7, side: 'after' });
  assert.deepEqual(
    hunkLineRange('@@ -12,3 +11,0 @@'),
    { startLine: 12, endLine: 14, side: 'before' },
    'Deletions point at old lines'
  );
  assert.equal(hunkLineRange('not a hunk'), undefined);
  assert.equal(lineRangeText({ startLine: 40, endLine: 120 }), 'L40–120');
  assert.equal(lineRangeText({ startLine: 7, endLine: 7 }), 'L7');
});

void test('topic chat trace lists exactly the context the prompt contains', () => {
  const hunks = [
    { filePath: 'src/retry.ts', hunkHeader: '@@ -38,6 +40,81 @@' },
    { filePath: 'config/config.go', hunkHeader: '@@ -1,2 +1,3 @@' },
  ];
  const trace = slideChatTrace(
    {
      prDescription: 'Adds retries',
      summary: '',
      diffContent: 'non-empty',
      history: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    },
    hunks,
    'await retry();'
  );
  assert.deepEqual(
    trace.steps.map((s) => [s.source, s.kind, s.label, lineRangeText(s)]),
    [
      ['context', 'selection', 'Selected code', ''],
      ['context', 'diff', 'retry.ts', 'L40–120'],
      ['context', 'diff', 'config.go', 'L1–3'],
      ['context', 'pr', 'PR description', ''],
      ['context', 'history', '2 earlier messages', ''],
    ]
  );
  assert.equal(trace.steps[1].path, 'src/retry.ts');
  assert.equal(trace.steps[0].path, undefined, 'Topic selections have no known location');
  assert.equal(traceLabel(trace), 'Context used', 'Assembled context is never labelled as AI reading');
  assert.equal(traceCountText(trace), '5 sources');
  const bare = slideChatTrace({ prDescription: ' ', summary: '', diffContent: '', history: [] }, hunks);
  assert.deepEqual(bare.steps, [], 'Hunks absent from the prompt are not claimed');
});

void test('file chat trace reflects sides, truncation and the located selection', () => {
  const trace = fileChatTrace({
    path: 'src/queue.ts',
    before: 'text',
    after: 'text',
    truncated: true,
    selection: 'After lines 52–40:\nreturn command.result;',
    description: '',
    historyCount: 1,
  });
  assert.deepEqual(
    trace.steps.map((s) => [s.kind, s.path, s.startLine, s.endLine, s.side]),
    [
      ['selection', 'src/queue.ts', 40, 52, 'after'],
      ['file', 'src/queue.ts', undefined, undefined, undefined],
      ['history', undefined, undefined, undefined, undefined],
    ]
  );
  assert.match(trace.steps[1].detail ?? '', /before and after \(first 120,000 characters/);
  assert.match(
    fileChatTrace({ path: 'a.png', before: 'image', after: 'text', truncated: false, description: '', historyCount: 0 })
      .steps[0].detail ?? '',
    /after only$/
  );
});

void test('recorded Claude stream-json tool_use blocks become ordered agent steps', () => {
  const calls: AgentToolCall[] = [];
  const names: string[] = [];
  const text: string[] = [];
  const events = createClaudeEventHandler({
    onChunk: (chunk, thinking) => !thinking && text.push(chunk),
    onToolUse: (name) => names.push(name),
    onToolCall: (call) => calls.push(call),
  });
  for (const line of lines('claude-tool-stream.jsonl')) events.processLine(line);
  assert.deepEqual(names, ['Read', 'Grep'], 'Partial block starts still report tool names');
  assert.deepEqual(
    calls.map((c) => c.id),
    ['toolu_01Read', 'toolu_02Grep', 'toolu_03Mcp'],
    'Each complete tool call is reported once, with input'
  );
  const steps = calls.map((call, i) => toolCallStep(call, i));
  assert.deepEqual(
    steps.map((s) => [s.source, s.kind, s.label, lineRangeText(s), s.path]),
    [
      ['agent', 'read', 'retry.ts', 'L40–120', 'src/retry.ts'],
      ['agent', 'search', '“maxDeliver”', '', undefined],
      ['agent', 'tool', 'github · get_file_contents', '', undefined],
    ]
  );
  assert.equal(events.getText(), 'Retries stop after maxDeliver attempts.', 'The result event stays authoritative');
  assert.equal(text.join(''), 'Let me check the retry loop.Retries stop after maxDeliver attempts.');
  const trace = {
    steps: [
      ...fileChatTrace({
        path: 'src/retry.ts',
        before: 'text',
        after: 'text',
        truncated: false,
        description: '',
        historyCount: 0,
      }).steps,
      ...steps,
    ],
  };
  assert.equal(traceLabel(trace), 'What the AI looked at');
  assert.equal(traceCountText(trace), '3 tool calls, 1 source');
});

void test('recorded Codex exec items become agent steps once, at start', () => {
  const calls: AgentToolCall[] = [];
  const events = createCodexEventHandler(undefined, (call) => calls.push(call));
  for (const line of lines('codex-tool-stream.jsonl')) events.processLine(line);
  assert.deepEqual(
    calls.map((c, i) => [toolCallStep(c, i).kind, toolCallStep(c, i).label]),
    [
      ['command', "bash -lc 'rg -n maxDeliver src'"],
      ['tool', 'github · get_file_contents'],
      ['web', '“NATS maxDeliver semantics”'],
      ['edit', 'retry.ts'],
    ]
  );
});

void test('agent paths outside the repository are not offered as PR files', () => {
  const step = toolCallStep({ id: '1', name: 'Read', input: { file_path: '/Users/me/repo/src/retry.ts' } });
  assert.equal(step.path, undefined);
  assert.equal(step.label, 'retry.ts');
  assert.equal(toolCallStep({ name: 'Unknown', input: {} }, 4).id, 'agent:4:Unknown', 'Unknown tools keep their name');
});

void test('traces merge without duplicates and survive a storage round trip', () => {
  const read = toolCallStep({ id: 'a', name: 'Read', input: { file_path: 'x.ts', offset: 3, limit: 1 } });
  const first = appendTraceSteps(undefined, [read]);
  assert.equal(appendTraceSteps(first, [read]), first, 'Repeated events do not re-render');
  const stored = JSON.parse(JSON.stringify(first)) as unknown;
  assert.deepEqual(parseChatTrace(stored), first);
  assert.deepEqual(
    parseChatTrace({
      steps: [
        { id: 'bad', source: 'agent', kind: 'teleport', label: 'x' },
        { id: 'ok', source: 'context', kind: 'file', label: 'a.ts', startLine: -3, side: 'middle' },
      ],
    }),
    { steps: [{ id: 'ok', source: 'context', kind: 'file', label: 'a.ts' }] }
  );
  assert.equal(parseChatTrace({ steps: [] }), undefined);
  assert.equal(parseChatTrace('nope'), undefined);
});
