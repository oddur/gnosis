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
