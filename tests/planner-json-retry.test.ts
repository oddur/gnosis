import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReview } from '../lib/agent';
import { claudeProvider } from '../lib/providers/claude';

const plan = { summary: 'S', riskLevel: 'low', topics: [{ title: 'T', hunks: [] }] };

void test('the planner retries once with the parse error when it returns invalid JSON', async (t) => {
  const prompts: string[] = [];
  const replies = ['{"summary": "S", "riskLevel": "low", "n": 1 "topics": []}', JSON.stringify(plan)];
  t.mock.method(claudeProvider, 'generate', async ({ content }: { content: string }) => {
    prompts.push(content);
    return replies.shift()!;
  });
  const out = await planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never);
  assert.equal(out.summary, 'S');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Your previous response was not valid JSON/);
});

void test('a second invalid reply fails with the parse error', async (t) => {
  let calls = 0;
  t.mock.method(claudeProvider, 'generate', async () => (calls++, '{"summary": 1 2}'));
  await assert.rejects(planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never), /Planner JSON parse failed/);
  assert.equal(calls, 2);
});

void test('a cancelled run does not retry', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(claudeProvider, 'generate', async () => {
    calls++;
    controller.abort();
    return '{"summary": 1 2}';
  });
  await assert.rejects(
    planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never, undefined, false, controller.signal)
  );
  assert.equal(calls, 1);
});
