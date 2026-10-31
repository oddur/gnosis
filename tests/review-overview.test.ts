import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeReviewOverview, generateReviewGuide, generateSlide, planReview } from '../lib/agent';
import { REVIEW_OVERVIEW_DIRECTIVE } from '../lib/review-overview';
import { getProvider, type GenerateOptions } from '../lib/provider';
import { DEFAULT_CODEX_MODEL } from '../lib/models';

void test('planner and whole-review generation share the overview contract and preserve Markdown', async (t) => {
  const simple = 'Renames Dismiss to Close without changing button behavior.';
  const grouped =
    'Bounds background work.\n\n- **Scheduling:** Prioritize visible requests.\n- **Capacity:** Limit concurrent jobs.';
  const calls: GenerateOptions[] = [];
  const responses = [
    { summary: simple, riskLevel: 'low', topics: [{ title: 'Button label', hunkIds: [] }] },
    { prTitle: 'Bound work', summary: grouped, riskLevel: 'medium', slides: [] },
  ];
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    calls.push(options);
    return Promise.resolve(JSON.stringify(responses.shift()));
  });
  const plan = await planReview('hunk-0', 'Change button label', 'codex', DEFAULT_CODEX_MODEL);
  const review = await generateReviewGuide({
    providerName: 'codex',
    model: DEFAULT_CODEX_MODEL,
    contextPackage: 'Synthetic diff',
    prUrl: 'https://github.com/example/repo/pull/1',
  });
  assert.equal(plan.summary, simple);
  assert.equal(review.summary, grouped);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(call.systemPrompt.includes(REVIEW_OVERVIEW_DIRECTIVE));
});

const input = {
  providerName: 'codex' as const,
  model: DEFAULT_CODEX_MODEL,
  title: 'Bound work',
  draft: 'Bounds the queue and makes cancellation instantaneous.',
  riskRationale: 'Check cancellation while a job is active.',
  topics: [
    {
      title: 'Capacity',
      narrative:
        'Jobs release slots on completion. Cancellation requests shutdown, but running work can continue until it observes the signal.',
    },
  ],
};

void test('final overview uses completed topics with selected model and keeps the draft on unusable output without retries', async (t) => {
  const calls: GenerateOptions[] = [];
  const final = 'Bounds concurrent work and releases capacity when jobs finish.';
  const outputs = [
    JSON.stringify({ summary: final }),
    'bad JSON',
    JSON.stringify({ summary: [] }),
    JSON.stringify({ summary: '   ' }),
  ];
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    calls.push(options);
    return Promise.resolve(outputs.shift() ?? '');
  });
  assert.equal(await finalizeReviewOverview(input), final);
  const supplied = JSON.parse(calls[0].content) as Record<string, unknown>;
  assert.deepEqual(supplied.completedTopics, input.topics);
  assert.equal(supplied.draft, input.draft);
  assert.equal(supplied.whereToFocus, input.riskRationale);
  assert.equal(calls[0].model, input.model);
  assert.equal(calls[0].isolated, true);
  assert.equal(calls[0].thinking, false);
  for (let i = 0; i < 3; i++) assert.equal(await finalizeReviewOverview(input), input.draft);
  assert.equal(calls.length, 4, 'invalid output does not retry a paid generation');
});

void test('overview failure preserves finished work but user cancellation still cancels the review', async (t) => {
  const controller = new AbortController();
  const generate = t.mock.method(getProvider('codex'), 'generate', () => Promise.reject(new Error('Unavailable')));
  assert.equal(await finalizeReviewOverview(input), input.draft);
  controller.abort();
  await assert.rejects(finalizeReviewOverview({ ...input, signal: controller.signal }));
  assert.equal(generate.mock.calls.length, 1, 'no request after cancellation');
  const during = new AbortController();
  generate.mock.mockImplementation(() => {
    during.abort();
    return Promise.resolve('{"summary":"Do not publish"}');
  });
  await assert.rejects(finalizeReviewOverview({ ...input, signal: during.signal }));
});

void test('slide writers can correct planner titles while retaining structured text and older output', async (t) => {
  const narrative =
    'Reject oversized responses.\n\n- Stop reading at the byte limit.\n- Enforce it without a size header.';
  const titles: unknown[] = ['  Bound response downloads  ', undefined, '   ', { unexpected: true }];
  t.mock.method(getProvider('codex'), 'generate', () =>
    Promise.resolve(JSON.stringify({ title: titles.shift(), narrative, reviewFocus: null }))
  );
  for (const expected of ['Bound response downloads', undefined, undefined, undefined]) {
    const slide = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: 'Planned title: Change storage ownership. Actual change: bound response downloads.',
    });
    assert.equal(slide.title, expected);
    assert.equal(slide.narrative, narrative);
    assert.equal(slide.reviewFocus, null);
  }
});

void test('disabled suggestions remove both model output formats without removing explanations', async (t) => {
  const result = {
    narrative: 'Only the current owner can finish the job.',
    reviewFocus: '- Check for stale ownership.',
    reviewChecks: [{ text: 'Check for stale ownership.', filePath: null, startLine: null }],
    inlineExplanations: [{ text: 'The generation check rejects an old owner.' }],
  };
  const calls: GenerateOptions[] = [];
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    calls.push(options);
    return Promise.resolve(
      JSON.stringify({
        ...result,
        prTitle: 'Ownership',
        summary: 'Guard ownership.',
        riskLevel: 'low',
        slides: [result],
      })
    );
  });
  for (const enabled of [false, true]) {
    const options = { providerName: 'codex' as const, model: DEFAULT_CODEX_MODEL, reviewSuggestions: enabled };
    const slide = await generateSlide({ ...options, topicContext: 'Synthetic ownership change' });
    const review = await generateReviewGuide({
      ...options,
      contextPackage: 'Synthetic ownership change',
      prUrl: 'https://github.com/example/repo/pull/1',
    });
    for (const output of [slide, review.slides[0]]) {
      assert.equal(output.reviewFocus, enabled ? result.reviewFocus : null);
      assert.deepEqual(output.reviewChecks, enabled ? result.reviewChecks : []);
      assert.equal(output.narrative, result.narrative);
      assert.deepEqual(output.inlineExplanations, result.inlineExplanations);
    }
  }
  for (const call of calls.slice(0, 2))
    assert.match(call.systemPrompt, /Set "reviewFocus" to null and "reviewChecks" to \[\]/);
});

void test('oversized writer context stays within the provider input budget and retries with less input', async (t) => {
  const calls: GenerateOptions[] = [];
  let writers = 0;
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    calls.push(options);
    assert.ok(
      options.content.length + options.systemPrompt.length < 900_000,
      'Provider input must be bounded before dispatch'
    );
    if (options.systemPrompt.includes('SOURCE EVIDENCE COMPACTION'))
      return Promise.resolve('Evidence: final_changed_function rejects stale writes.');
    if (++writers === 1) return Promise.reject(Error('input_too_large: maximum length of 1048576 characters'));
    return Promise.resolve(JSON.stringify({ narrative: '- Rejects stale writes.', reviewFocus: null }));
  });
  await generateSlide({
    providerName: 'codex',
    model: DEFAULT_CODEX_MODEL,
    topicContext: '<diff_hunks>\n' + 'changed code\n'.repeat(100_000) + 'final_changed_function\n</diff_hunks>',
  });
  assert.ok(calls.some((call) => call.content.includes('final_changed_function')));
  const writerCalls = calls.filter((call) => !call.systemPrompt.includes('SOURCE EVIDENCE COMPACTION'));
  assert.equal(writerCalls.length, 2);
  assert.ok(writerCalls[1].content.length < writerCalls[0].content.length, 'Size retries must shrink the actual input');
});

void test('prompt budgets remove optional context first and preserve all source across chunks', async () => {
  const { budgetReviewContext, sourceChunks } = await import('../lib/prompt-budget');
  const changed = '<diff_hunks>\n-important_before\n+important_after\n</diff_hunks>';
  const input = changed + '<neighbor_files>' + 'optional '.repeat(100_000) + '</neighbor_files>';
  const compact = await budgetReviewContext(input, 1000, () => {
    throw Error('No AI needed when the diff fits');
  });
  assert.ok(compact.includes(changed));
  assert.ok(compact.length < 1000);
  const source = ('first\n' + 'x'.repeat(300_000) + '😀last').repeat(2);
  const chunks = sourceChunks(source);
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.every((chunk) => chunk.length <= 180_000));
  assert.throws(() => sourceChunks(source, 0));
});

void test('checkpoint retry after restart reuses completed topics and retries only the failure', async () => {
  const { openReviewCheckpoint, collectReviewTopics } = await import('../src/review-checkpoint');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'gnosis-checkpoint-test-'));
  const identity = { revision: 'a', account: 'alice', model: 'model-a', instructions: 'brief' };
  const plan = {
    summary: 'Change',
    riskLevel: 'low',
    riskRationale: '',
    storyArc: '',
    topics: [
      {
        title: 'One',
        hunkIds: ['hunk-0'],
        dependsOn: [],
        order: 1,
        narrativeBrief: '',
        slideType: 'feature',
        importance: 'important',
      },
    ],
  } as import('../lib/types').PlannerOutput;
  try {
    const first = await openReviewCheckpoint(directory, identity);
    await first.setPlan(plan);
    await assert.rejects(
      collectReviewTopics(
        [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const output = {
              narrative: 'Saved after the other writer failed.',
              reviewFocus: null,
              contextSnippets: [],
            };
            await first.set('one', output);
            return output;
          },
          () => Promise.reject(Error('Failed writer')),
        ],
        new AbortController().signal
      ),
      /1 of 2 topics saved/
    );
    const resumed = await openReviewCheckpoint(directory, identity);
    assert.deepEqual(resumed.plan, plan);
    let generated = 0;
    const results = await collectReviewTopics(
      ['one', 'two'].map((key) => async () => {
        const saved = resumed.get(key);
        if (saved) return saved;
        generated++;
        const output = { narrative: 'Only the missing topic regenerated.', reviewFocus: null, contextSnippets: [] };
        await resumed.set(key, output);
        return output;
      }),
      new AbortController().signal
    );
    assert.equal(generated, 1);
    assert.equal(results.length, 2);
    for (const changed of [{ revision: 'b' }, { account: 'bob' }, { model: 'model-b' }, { instructions: 'detailed' }])
      assert.equal((await openReviewCheckpoint(directory, { ...identity, ...changed })).get('one'), undefined);
    await resumed.clear();
    assert.equal(
      (await openReviewCheckpoint(directory, identity)).plan,
      undefined,
      'Successful generations must not prevent a fresh regeneration'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('planner input includes the hunk index once', async (t) => {
  let content = '';
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    content = options.content;
    return Promise.resolve(
      JSON.stringify({ summary: 'Change', riskLevel: 'low', topics: [{ title: 'Topic', hunkIds: [] }] })
    );
  });
  const index = '<hunk_index>hunk-0</hunk_index>';
  await planReview(index, 'PR metadata\n' + index, 'codex', DEFAULT_CODEX_MODEL);
  assert.equal(content.split(index).length, 2);
});

void test('smart import extraction batches large files and keeps results from successful sections', async (t) => {
  const { extractImportsWithLLM } = await import('../lib/github');
  const calls: string[] = [];
  t.mock.method(getProvider('codex'), 'quick', (options: { content: string }) => {
    calls.push(options.content);
    assert.ok(options.content.length < 181_000);
    return calls.length === 2 ? Promise.reject(Error('Temporary failure')) : Promise.resolve('["src/shared.rs"]');
  });
  const results = await extractImportsWithLLM(
    { 'src/large.rs': 'use crate::shared;\n' + 'fn example() {}\n'.repeat(80_000) },
    ['src/large.rs'],
    'codex'
  );
  assert.ok(calls.length > 1);
  assert.ok(calls.every((call) => call.includes('src/large.rs')));
  assert.deepEqual(results, ['src/shared.rs']);
});

void test('surrounding source follows changed lines near the end of a large file', async () => {
  const { buildTopicContext } = await import('../lib/context-builder');
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}: surrounding source`);
  lines[899] = 'important_changed_function();';
  const hunk = {
    id: 'hunk-0',
    filePath: 'large.ts',
    fileStatus: 'modified',
    hunkHeader: '@@ -900 +900 @@',
    expandedHunkHeader: '@@ -900 +900 @@',
    expandedContent: '-before\n+after',
    content: '-before\n+after',
    additions: 1,
    deletions: 1,
    scopeName: null,
    language: 'typescript',
  } as import('../lib/diff-parse').IndexedHunk;
  const topic = {
    title: 'Change',
    hunkIds: ['hunk-0'],
    dependsOn: [],
    order: 1,
    narrativeBrief: '',
    slideType: 'feature',
    importance: 'important',
  } as import('../lib/types').TopicPlan;
  const context = buildTopicContext(
    topic,
    new Map([[hunk.id, hunk]]),
    {},
    { 'large.ts': lines.join('\n') },
    {},
    'PR',
    '',
    '',
    [topic]
  );
  assert.ok(context.includes('900: important_changed_function();'));
  assert.ok(context.length < 20_000);
});
