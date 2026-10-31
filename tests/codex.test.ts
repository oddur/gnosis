import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { codexProvider, createCodexEventHandler } from '../lib/providers/codex';
import { setBinaryOverride } from '../lib/providers/shared';
import { normalizeModelSelection, RETIRED_CLAUDE_MODELS } from '../lib/models';

setBinaryOverride('codex', path.resolve('tests/fixtures/codex.mjs'));
after(() => setBinaryOverride('codex', ''));
const options = { model: 'gpt-6.1-sol' as const, systemPrompt: 'Return only JSON.', thinking: true };

void test('runs Codex with isolated context and returns only the final answer', async () => {
  const chunks: [string, boolean][] = [];
  const result = await codexProvider.generate({
    ...options,
    content: JSON.stringify({ mode: 'success', diff: '+hello' }),
    cwd: process.cwd(),
    allowedTools: ['Bash'],
    onChunk: (text, thinking) => chunks.push([text, thinking]),
  });
  const answer = JSON.parse(result) as { args: string[]; cwd: string; instructions: string; input: { diff: string } };
  assert.equal(answer.instructions, options.systemPrompt);
  assert.equal(answer.input.diff, '+hello');
  assert.equal(answer.args[0], 'exec');
  assert.ok(answer.args.includes('--ignore-user-config'));
  assert.ok(answer.args.includes('--ephemeral'));
  assert.equal(answer.args[answer.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(answer.args.includes('model_reasoning_effort="high"'));
  assert.ok(answer.args.includes('web_search="disabled"'));
  assert.ok(answer.args.includes('shell_tool'));
  assert.notEqual(answer.cwd, process.cwd());
  assert.equal(existsSync(answer.cwd), false, 'temporary prompt and output removed');
  assert.deepEqual(chunks, [
    ['Considering changes', true],
    ['Preparing the answer', false],
    [`\n\n${result}`, false],
  ]);
});

void test('quick requests use low effort and parallel writers use separate directories', async () => {
  const results = await Promise.all(
    [1, 2].map((id) =>
      codexProvider.quick({
        ...options,
        content: JSON.stringify({ mode: 'success', id }),
      })
    )
  );
  const answers = results.map((r) => JSON.parse(r) as { cwd: string; args: string[]; input: { id: number } });
  assert.notEqual(answers[0].cwd, answers[1].cwd);
  assert.deepEqual(
    answers.map((r) => r.input.id),
    [1, 2]
  );
  assert.ok(answers[0].args.includes('model_reasoning_effort="low"'));
});

void test('preserves saved Terra selections and routes both reasoning modes to Codex', async () => {
  for (const thinking of [false, true]) {
    const selection = normalizeModelSelection('codex', 'gpt-6.1-terra', !thinking);
    assert.equal(selection.model, 'gpt-6.1-terra');
    const result = await codexProvider.generate({
      ...options,
      model: selection.model,
      thinking,
      content: JSON.stringify({ mode: 'success' }),
    });
    const { args } = JSON.parse(result) as { args: string[] };
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-terra');
    assert.ok(args.includes(`model_reasoning_effort="${thinking ? 'high' : 'low'}"`));
  }
});

void test('reports authentication errors, terminal failures and missing final output', async () => {
  for (const [mode, expected] of [
    ['fail', /session has expired/],
    ['zero-exit-failure', /Model unavailable/],
    ['empty', /no final response/],
  ] as const) {
    await assert.rejects(codexProvider.generate({ ...options, content: JSON.stringify({ mode }) }), expected);
  }
});

void test('cancels running and already-aborted generations', async () => {
  const controller = new AbortController();
  await assert.rejects(
    codexProvider.generate({
      ...options,
      content: JSON.stringify({ mode: 'wait' }),
      signal: controller.signal,
      onChunk: () => controller.abort(),
    }),
    /GNOSIS_CANCELLED/
  );
  await assert.rejects(
    codexProvider.generate({
      ...options,
      content: '{}',
      signal: controller.signal,
    }),
    /GNOSIS_CANCELLED/
  );
});

void test('ignores diagnostics, unknown events and recovered stream errors', () => {
  const chunks: string[] = [];
  const events = createCodexEventHandler((text) => chunks.push(text));
  for (const line of ['not JSON', 'null', '{"type":"error","message":"retrying"}', '{"type":"turn.completed"}']) {
    events.processLine(line);
  }
  assert.equal(events.getFailure(), undefined);
  assert.deepEqual(chunks, []);
});

void test('preserves Codex preferences and migrates retired or mismatched model IDs', () => {
  assert.deepEqual(normalizeModelSelection('codex', 'gpt-6-luna'), { provider: 'codex', model: 'gpt-6-luna' });
  assert.deepEqual(normalizeModelSelection('codex', 'claude-opus-5-5'), { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(normalizeModelSelection('claude', 'gpt-6-astra'), { provider: 'claude', model: 'claude-opus-5-5' });
  assert.deepEqual(normalizeModelSelection('claude', 'claude-opus-4-7'), {
    provider: 'claude',
    model: 'claude-opus-5-5',
  });
  assert.deepEqual(normalizeModelSelection('gemini', 'removed', true), {
    provider: 'claude',
    model: 'claude-sonnet-5-5',
  });
  assert.deepEqual(normalizeModelSelection(undefined, undefined), { provider: 'claude', model: 'claude-opus-5-5' });
});

void test('upgrades saved Claude preferences within each model family and preserves history labels', () => {
  for (const [previous, current, label] of [
    ['claude-fable-5', 'claude-fable-5-1', 'Claude Fable 5'],
    ['claude-opus-5', 'claude-opus-5-5', 'Claude Opus 5'],
    ['claude-sonnet-5', 'claude-sonnet-5-5', 'Claude Sonnet 5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'Claude Haiku 4.5'],
    ['claude-opus-4-6', 'claude-opus-5-5', 'Claude Opus 4.6'],
    ['claude-opus-4-7', 'claude-opus-5-5', 'Claude Opus 4.7'],
    ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'Claude Sonnet 4.6'],
  ]) {
    for (const proactive of [false, true]) {
      assert.deepEqual(normalizeModelSelection('claude', previous, proactive), { provider: 'claude', model: current });
      assert.deepEqual(normalizeModelSelection('claude', current, proactive), { provider: 'claude', model: current });
    }
    assert.equal(RETIRED_CLAUDE_MODELS[previous].label, label);
  }
});

void test('Codex receives private image attachments and removes them after generation', async () => {
  const base64 = Buffer.from('test png bytes').toString('base64');
  const answer = JSON.parse(
    await codexProvider.generate({
      ...options,
      content: JSON.stringify({ mode: 'success' }),
      images: [{ mediaType: 'image/png', base64 }],
    })
  ) as { images: string[]; args: string[] };
  assert.deepEqual(answer.images, [base64]);
  const file = answer.args[answer.args.indexOf('--image') + 1];
  assert.equal(existsSync(file), false);
});

void test('Codex receives explicit effort and clamps Ultra for Luna', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) {
    const { args } = JSON.parse(await codexProvider.generate({
      ...options, thinking: false, effort, content: JSON.stringify({ mode: 'success' }),
    })) as { args: string[] };
    assert.ok(args.includes(`model_reasoning_effort="${effort}"`));
  }
  const { args } = JSON.parse(await codexProvider.generate({
    ...options, model: 'gpt-6-luna', effort: 'ultra', content: JSON.stringify({ mode: 'success' }),
  })) as { args: string[] };
  assert.ok(args.includes('model_reasoning_effort="max"'));
});
