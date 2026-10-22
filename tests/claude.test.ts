import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { CLAUDE_MODELS } from '../lib/models';
import { claudeProvider } from '../lib/providers/claude';
import { setBinaryOverride } from '../lib/providers/shared';

setBinaryOverride('claude', path.resolve('tests/fixtures/claude.mjs'));
after(() => setBinaryOverride('claude', ''));

void test('isolated Claude requests disable tools, MCP discovery, and settings sources', async () => {
  const result = JSON.parse(
    await claudeProvider.generate({
      model: 'claude-opus-5-5',
      thinking: true,
      content: 'Explain the supplied code.',
      systemPrompt: 'Return JSON.',
      isolated: true,
      allowedTools: ['Bash'],
      nonStrictMcp: true,
      mcpConfigPath: 'must-not-load.json',
    })
  ) as Invocation;
  assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  assert.ok(result.args.includes('--strict-mcp-config'));
  assert.equal(result.args[result.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(result.args[result.args.indexOf('--setting-sources') + 1], '');
  assert.ok(!result.args.includes('--allowedTools') && !result.args.includes('must-not-load.json'));
});

interface Invocation {
  args: string[];
  input: string;
  effortOverride: string | null;
  thinkingBudget: string | null;
}

for (const thinking of [false, true]) {
  void test(`Claude reviews request ${thinking ? 'high' : 'low'} effort despite inherited settings`, async (t) => {
    const inheritedEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    const inheritedBudget = process.env.MAX_THINKING_TOKENS;
    t.after(() => {
      if (inheritedEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = inheritedEffort;
      if (inheritedBudget === undefined) delete process.env.MAX_THINKING_TOKENS;
      else process.env.MAX_THINKING_TOKENS = inheritedBudget;
    });
    process.env.CLAUDE_CODE_EFFORT_LEVEL = thinking ? 'low' : 'high';
    process.env.MAX_THINKING_TOKENS = '0';

    for (const { id: model } of CLAUDE_MODELS) {
      const output = await claudeProvider.generate({
        model,
        thinking,
        systemPrompt: 'Review the diff.',
        content: '+hello',
      });
      const invocation = JSON.parse(output) as Invocation;
      assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], model);
      assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], thinking ? 'high' : 'low');
      assert.equal(invocation.effortOverride, null);
      assert.equal(invocation.thinkingBudget, null);
      assert.equal(invocation.input, '+hello');
    }
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, thinking ? 'low' : 'high');
    assert.equal(process.env.MAX_THINKING_TOKENS, '0');
  });
}

void test('Claude smart imports request low effort despite an inherited high effort level', async (t) => {
  const inheritedEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  t.after(() => {
    if (inheritedEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = inheritedEffort;
  });
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
  const quickModel = CLAUDE_MODELS.find((m) => m.quick);
  assert.ok(quickModel);
  const model = quickModel.id;
  const output = await claudeProvider.quick({ model, systemPrompt: 'Find imports.', content: '+hello' });
  const invocation = JSON.parse(output) as Invocation;
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], model);
  assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'low');
  assert.equal(invocation.effortOverride, null);
  assert.equal(invocation.thinkingBudget, null);
  assert.equal(invocation.input, '+hello');
});
