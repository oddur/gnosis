import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyExplanationEdits, buildExplanationSource, refineExplanationText } from '../lib/review-refinement';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { buildIndexedHunks } from '../lib/diff-parse';
import type { GenerateOptions } from '../lib/provider';

const source = '+const key = `${user}:${promptHash}`;\n // Client entries remain until the session ends.';
const anchor = {
  filePath: 'cache.ts',
  line: 5,
  side: 'RIGHT' as const,
  code: 'const key = `${user}:${promptHash}`;',
  text: 'Creates the key.',
};
const draft = {
  title: 'Cache translations',
  narrative: 'Changing the prompt clears all cached translations.',
  inlineExplanations: [anchor],
  diffHunkIds: ['hunk-0'],
  svgIllustration: { source: 'untouched' },
  reviewChecks: [],
};
const edit = {
  chapter: 0,
  evidence: ['// Client entries remain until the session ends.'],
  narrative: 'The service uses a new key when the prompt changes. The client session cache is unchanged.',
  annotations: [
    { index: 0, text: 'A prompt change selects a different service entry. It does not delete the old entry.' },
  ],
};

void test('source-supported edits replace prose while preserving coverage, anchors and illustrations', () => {
  const [result] = applyExplanationEdits(
    [draft],
    { edits: [{ ...edit, diffHunkIds: [], svgIllustration: null }] },
    source
  );
  assert.equal(result.narrative, edit.narrative);
  assert.equal(result.diffHunkIds, draft.diffHunkIds);
  assert.equal(result.svgIllustration, draft.svgIllustration);
  assert.equal(result.reviewChecks, draft.reviewChecks);
  assert.deepEqual(result.inlineExplanations[0], { ...anchor, text: edit.annotations[0].text });
  assert.equal(draft.inlineExplanations[0].text, 'Creates the key.', 'input remains unchanged');
  assert.equal(applyExplanationEdits([draft], { edits: [] }, source)[0], draft);
  const [pruned] = applyExplanationEdits([draft], { edits: [{ ...edit, annotations: [] }] }, source);
  assert.deepEqual(pruned.inlineExplanations, []);
});

void test('invalid citations, chapter mappings and annotation anchors cannot replace finished work', () => {
  const invalid = [
    { ...edit, evidence: ['invented evidence absent from the supplied code'] },
    { ...edit, evidence: [] },
    { ...edit, chapter: 1 },
    { ...edit, chapter: -1 },
    { ...edit, narrative: '' },
    { ...edit, annotations: [{ index: 1, text: 'New unsupported anchor' }] },
    { ...edit, annotations: [edit.annotations[0], edit.annotations[0]] },
    { ...edit, annotations: [{ index: 0, text: 'word '.repeat(46) }] },
  ];
  for (const candidate of invalid)
    assert.equal(applyExplanationEdits([draft], { edits: [candidate] }, source)[0], draft);
  assert.equal(applyExplanationEdits([draft], { edits: [edit, edit] }, source)[0], draft);
  assert.equal(draft.narrative, 'Changing the prompt clears all cached translations.');
});

void test('edit call uses selected model and source in isolation, never sends diagrams or changes reviewer preferences', async () => {
  const calls: GenerateOptions[] = [];
  const result = await refineExplanationText({
    drafts: [draft],
    source,
    model: DEFAULT_CODEX_MODEL,
    effort: 'high',
    instructions: 'Use short bullets.',
    generate: (options) => {
      calls.push(options);
      return Promise.resolve(JSON.stringify({ edits: [edit] }));
    },
  });
  assert.equal(result[0].narrative, edit.narrative);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, DEFAULT_CODEX_MODEL);
  assert.equal(calls[0].effort, 'high');
  assert.equal(calls[0].isolated, true);
  assert.equal(calls[0].allowedTools, undefined);
  for (const line of source.split('\n')) assert.ok(calls[0].content.includes(line));
  assert.ok(calls[0].content.includes('[S2]'));
  assert.ok(!calls[0].content.includes('svgIllustration'));
  assert.ok(calls[0].systemPrompt.includes('Use short bullets.'));
});

void test('failed or invalid optional edits retain drafts without retry; oversized source is not silently truncated', async () => {
  const drafts = [draft];
  let calls = 0;
  for (const response of [
    'invalid JSON',
    JSON.stringify({ edits: [{ ...edit, evidence: ['not present in source'] }] }),
    'throw',
  ]) {
    const result = await refineExplanationText({
      drafts,
      source,
      model: DEFAULT_CODEX_MODEL,
      generate: () => {
        calls++;
        if (response === 'throw') throw Error('Unavailable');
        return Promise.resolve(response);
      },
    });
    assert.equal(result, drafts);
  }
  assert.equal(calls, 3);
  const result = await refineExplanationText({
    drafts,
    source: source.repeat(10_000),
    model: DEFAULT_CODEX_MODEL,
    generate: () => {
      calls++;
      return Promise.resolve('{"edits":[]}');
    },
  });
  assert.equal(result, drafts);
  assert.equal(calls, 3);
});

void test('cancellation before and during editing cancels instead of publishing a fallback', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    refineExplanationText({
      drafts: [draft],
      source,
      model: DEFAULT_CODEX_MODEL,
      signal: before.signal,
      generate: () => {
        calls++;
        return Promise.resolve('{"edits":[]}');
      },
    })
  );
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(
    refineExplanationText({
      drafts: [draft],
      source,
      model: DEFAULT_CODEX_MODEL,
      signal: during.signal,
      generate: () => {
        during.abort();
        return Promise.resolve(JSON.stringify({ edits: [edit] }));
      },
    })
  );
});

void test('malformed optional model notes cannot make the edit pass fail generation', async () => {
  for (const notes of [null, {}, [null], [{ text: 'missing anchor' }]]) {
    const drafts = [{ ...draft, inlineExplanations: notes }] as unknown as (typeof draft)[];
    let calls = 0;
    const result = await refineExplanationText({
      drafts,
      source,
      model: DEFAULT_CODEX_MODEL,
      generate: () => {
        calls++;
        return Promise.resolve('{"edits":[]}');
      },
    });
    assert.equal(result, drafts);
    assert.equal(calls, 0);
  }
});

void test('source citations tolerate diff indentation but reject changed code and empty evidence', () => {
  const code = '+    if (entry.generation !== generation) return false;\n+    save(entry);';
  const correction = { ...edit, evidence: ['if (entry.generation !== generation) return false;\n    save(entry);'] };
  assert.equal(applyExplanationEdits([draft], { edits: [correction] }, code)[0].narrative, edit.narrative);
  for (const quote of ['if (entry.generation === generation) return false;', ' '.repeat(20)]) {
    assert.equal(applyExplanationEdits([draft], { edits: [{ ...edit, evidence: [quote] }] }, code)[0], draft);
  }
});

void test('planner assumptions and PR descriptions cannot serve as evidence for an edit', async () => {
  const assumption = 'All client cache entries are now deleted.';
  const drafts = [draft];
  const result = await refineExplanationText({
    drafts,
    model: DEFAULT_CODEX_MODEL,
    source: `<story_arc>${assumption}</story_arc>\n<diff_hunks>${source}</diff_hunks>`,
    generate: (options) => {
      assert.ok(!options.content.includes(assumption));
      return Promise.resolve(JSON.stringify({ edits: [{ ...edit, evidence: [assumption] }] }));
    },
  });
  assert.equal(result, drafts);
});

void test('whole-review editing preserves each chapter mapping and can restore a boundary found in another chapter', () => {
  const drafts = [draft, { ...draft, title: 'Client', narrative: 'The client caches results for the session.' }];
  const result = applyExplanationEdits(drafts, { edits: [{ ...edit, chapter: 0 }] }, source);
  assert.equal(result[0].narrative, edit.narrative);
  assert.equal(result[1], drafts[1]);
  assert.equal(result[0].diffHunkIds, drafts[0].diffHunkIds);
});

void test('whole-review source includes every hunk or explicitly declines an oversized edit', () => {
  const hunks = buildIndexedHunks(
    'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1 +1 @@\n-oldValue();\n+newValue();\n',
    {},
    {}
  );
  const evidence = buildExplanationSource(hunks);
  assert.ok(evidence?.includes('newValue();'));
  assert.ok(evidence?.includes(hunks[0].id));
  assert.equal(buildExplanationSource([{ ...hunks[0], expandedContent: 'x'.repeat(450_000) }]), null);
});

void test('a bad citation or anchor preserves that whole chapter but does not discard independent valid edits', () => {
  const drafts = [draft, { ...draft, title: 'Another chapter' }];
  for (const invalid of [
    { ...edit, chapter: 1, evidence: ['invented source quotation'] },
    { ...edit, chapter: 1, annotations: [{ index: 3, text: 'Invalid anchor' }] },
  ]) {
    for (const edits of [
      [edit, invalid],
      [invalid, edit],
    ]) {
      const rejected: (number | null)[] = [];
      const result = applyExplanationEdits(drafts, { edits }, source, (chapter) => rejected.push(chapter));
      assert.equal(result[0].narrative, edit.narrative);
      assert.equal(result[1], drafts[1], 'Neither narrative nor annotations of the rejected chapter change');
      assert.deepEqual(rejected, [1]);
    }
  }
});

void test('ambiguous duplicate chapter edits are all rejected while unrelated edits still apply', () => {
  const drafts = [draft, { ...draft, title: 'Another chapter' }];
  const result = applyExplanationEdits(
    drafts,
    { edits: [edit, { ...edit, narrative: 'Contradictory edit' }, { ...edit, chapter: 1 }, null, { chapter: 99 }] },
    source
  );
  assert.equal(result[0], draft, 'Do not pick an arbitrary duplicate');
  assert.equal(result[1].narrative, edit.narrative);
  assert.throws(() => applyExplanationEdits(drafts, { edits: {} }, source));
});

void test('numbered source citations accept real evidence and reject missing or non-source lines', () => {
  const evidence = `<diff_hunks>\n--- cache.ts (modified) [hunk-0]\n${source}\n</diff_hunks>`;
  const drafts = [draft];
  assert.equal(
    applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: [3, 4] }] }, evidence)[0].narrative,
    edit.narrative
  );
  for (const bad of [0, -1, 1, 2, 5, 100, 3.5, NaN]) {
    assert.equal(applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: [bad] }] }, evidence), drafts);
  }
});

void test('numbered evidence is stable after non-source context is removed and still preserves quote compatibility', async () => {
  const drafts = [draft];
  const result = await refineExplanationText({
    drafts,
    source: `<story_arc>Unsupported planner claim</story_arc>\n<diff_hunks>\n${source}\n</diff_hunks>`,
    model: DEFAULT_CODEX_MODEL,
    generate: (options) => {
      assert.ok(options.content.includes('[S3]  // Client entries remain until the session ends.'));
      assert.ok(!options.content.includes('Unsupported planner claim'));
      return Promise.resolve(JSON.stringify({ edits: [{ ...edit, evidence: [3] }] }));
    },
  });
  assert.equal(result[0].narrative, edit.narrative);
  assert.equal(applyExplanationEdits(drafts, { edits: [edit] }, source)[0].narrative, edit.narrative);
});

void test('cross-file edits can cite several short source references without accepting unknown evidence or oversized quotations', () => {
  const evidence = Array.from({ length: 12 }, (_, index) => `+establishBoundary${index}();`).join('\n');
  const references = Array.from({ length: 12 }, (_, index) => index + 1);
  const drafts = [draft];
  assert.equal(
    applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: references }] }, evidence)[0].narrative,
    edit.narrative
  );
  assert.equal(
    applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: [...references, 999] }] }, evidence),
    drafts
  );
  assert.equal(applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: Array(513).fill(1) }] }, evidence), drafts);
  const longQuote = 'meaningful_source_'.repeat(20);
  assert.equal(
    applyExplanationEdits(drafts, { edits: [{ ...edit, evidence: Array(10).fill(longQuote) }] }, longQuote),
    drafts
  );
});
