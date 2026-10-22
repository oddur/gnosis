import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFileSummaries } from '../lib/file-summaries';
import { generateReviewGuide, generateSlide } from '../lib/agent';
import { getProvider, type GenerateOptions } from '../lib/provider';
import { DEFAULT_CODEX_MODEL } from '../lib/models';

void test('file summaries keep exact stack source identity and tolerate old or malformed reviews', () => {
  const hunks = [{ filePath: 'PR-121/src/queue.ts' }, { filePath: 'PR-122/src/queue.ts' }];
  assert.deepEqual(normalizeFileSummaries(undefined, hunks), []);
  assert.deepEqual(normalizeFileSummaries({ filePath: hunks[0].filePath, summary: 'wrong shape' }, hunks), []);
  assert.deepEqual(
    normalizeFileSummaries(
      [
        null,
        {},
        { filePath: hunks[0].filePath, summary: 123 },
        { filePath: 'src/queue.ts', summary: 'Missing stack prefix' },
        { filePath: 'unrelated.ts', summary: 'Not shown here' },
        { filePath: hunks[0].filePath, summary: '  Bounds queue size.\n Releases cancelled slots.  ' },
        { filePath: hunks[0].filePath, summary: 'Duplicate' },
        { filePath: hunks[1].filePath, summary: 'Adjusts batch sizes.' },
      ],
      hunks
    ),
    [
      { filePath: hunks[0].filePath, summary: 'Bounds queue size. Releases cancelled slots.' },
      { filePath: hunks[1].filePath, summary: 'Adjusts batch sizes.' },
    ]
  );
  const [long] = normalizeFileSummaries([{ filePath: hunks[0].filePath, summary: '界'.repeat(240) }], hunks);
  assert.ok(long.summary.length <= 200);
});

void test('both review generation paths request and retain file header summaries without extra calls', async (t) => {
  const fileSummaries = [
    { filePath: 'PR-121/src/queue.ts', summary: 'Bounds pending work and releases cancelled queue slots.' },
  ];
  const writer = { narrative: 'Bound the queue.', reviewFocus: null, contextSnippets: [], fileSummaries };
  const responses = [
    {
      prTitle: 'Bound queue',
      summary: 'Prevent overload.',
      riskLevel: 'medium',
      slides: [{ ...writer, diffHunkIds: ['hunk-1'] }],
    },
    writer,
  ];
  const generate = t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    assert.match(options.systemPrompt, /FILE HEADER SUMMARIES/);
    assert.match(options.systemPrompt, /THIS topic/);
    assert.match(options.content, /"fileSummaries"/);
    return Promise.resolve(JSON.stringify(responses.shift()));
  });
  const review = await generateReviewGuide({
    providerName: 'codex',
    model: DEFAULT_CODEX_MODEL,
    contextPackage: 'Selected patch',
    prUrl: 'https://github.com/example/repo/pull/121',
  });
  assert.deepEqual(review.slides[0].fileSummaries, fileSummaries);
  const slide = await generateSlide({
    providerName: 'codex',
    model: DEFAULT_CODEX_MODEL,
    topicContext: 'Selected patch',
  });
  assert.deepEqual(slide.fileSummaries, fileSummaries);
  assert.equal(generate.mock.calls.length, 2);
});
