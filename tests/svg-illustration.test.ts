import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSvgIllustration, SVG_ILLUSTRATION_DIRECTIVE } from '../lib/svg-illustration';
import { buildSvgIllustrationDocument } from '../lib/svg-illustration-document';
import { getProvider } from '../lib/provider';
import { generateSlide } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import generated from './fixtures/illustration-generated.json';

const sample = normalizeSvgIllustration(generated.find((example) => example.id === 'queue')?.slide.svgIllustration);
assert.ok(sample);
void test('authored compositions survive normalization without conversion into nodes', () => {
  assert.deepEqual(normalizeSvgIllustration(sample), sample);
  assert.ok(sample.plan.visualApproach);
  assert.match(sample.scenarios[0].frames[0].svg, /<svg/);
  assert.equal(normalizeSvgIllustration({ ...sample, plan: null }), null);
  assert.equal(normalizeSvgIllustration({ ...sample, scenarios: [] }), null);
  const invalid = structuredClone(sample);
  invalid.scenarios[0].frames[0].svg = 'x';
  assert.equal(normalizeSvgIllustration(invalid), null);
  const overflow = structuredClone(sample);
  overflow.scenarios[0].frames[0].svg = '<svg>' + 'x'.repeat(35000) + '</svg>';
  assert.equal(normalizeSvgIllustration(overflow), null);
});
void test('model markup is serialized inertly into a sandbox document', () => {
  const hostile = structuredClone(sample);
  hostile.title = '</script><script>alert(1)</script>';
  const html = buildSvgIllustrationDocument(hostile, 'test-token');
  assert.ok(!html.includes(hostile.title));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'nonce-test-token'/);
  assert.throws(() => buildSvgIllustrationDocument(sample, 'bad"token'));
});
void test('writer uses visual planning and retries browser feedback without imposing a layout', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  let calls = 0,
    checks = 0;
  try {
    provider.generate = (opts) => {
      assert.ok(opts.systemPrompt.includes(SVG_ILLUSTRATION_DIRECTIVE));
      assert.ok(!opts.systemPrompt.includes('Every event contains a COMPLETE states array'));
      if (calls++) {
        assert.match(opts.content, /Overlapping labels/);
        assert.ok(opts.content.includes(JSON.stringify(sample)), 'repair receives the prior composition');
      }
      return Promise.resolve(
        JSON.stringify({ narrative: 'One concise insight.', svgIllustration: sample, d2Diagram: { source: 'a -> b' } })
      );
    };
    const result = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: 'Source supplied.',
      validateIllustration: () => {
        if (!checks++) return Promise.reject(new Error('Overlapping labels'));
        return Promise.resolve(undefined);
      },
    });
    assert.equal(calls, 2);
    assert.equal(checks, 2);
    assert.deepEqual(result.svgIllustration, sample);
    assert.equal(result.d2Diagram, null);
  } finally {
    provider.generate = original;
  }
});
void test('a second invalid illustration cannot break the surrounding explanation', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  try {
    provider.generate = () =>
      Promise.resolve(JSON.stringify({ narrative: 'Still readable.', svgIllustration: sample }));
    const result = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: 'Source.',
      validateIllustration: () => Promise.reject(new Error('Clipped label')),
    });
    assert.equal(result.svgIllustration, null);
    assert.equal(result.narrative, 'Still readable.');
  } finally {
    provider.generate = original;
  }
});

void test('visual critique sees rendered images, repairs only the picture, and checks the repair again', async () => {
  const { reviewIllustration } = await import('../lib/illustration-review');
  const images = [{ mediaType: 'image/png' as const, base64: 'first-render' }];
  const repairedImages = [{ mediaType: 'image/png' as const, base64: 'repaired-render' }];
  let calls = 0,
    renders = 0;
  const result = await reviewIllustration({
    illustration: sample,
    render: { images },
    source: 'The authoritative code.',
    model: DEFAULT_CODEX_MODEL,
    generate: async (opts) => {
      await Promise.resolve();
      assert.equal(opts.isolated, true);
      assert.ok(opts.content.includes('The authoritative code.'));
      assert.deepEqual(opts.images, calls < 2 ? images : repairedImages);
      if (calls++ === 0)
        return JSON.stringify({ verdict: 'repair', findings: ['Frame 2 hides the blocking condition.'] });
      if (calls === 2) {
        assert.ok(opts.content.includes('Frame 2 hides the blocking condition.'));
        return JSON.stringify({ svgIllustration: sample });
      }
      return JSON.stringify({ verdict: 'accept', findings: [] });
    },
    renderIllustration: async () => {
      await Promise.resolve();
      renders++;
      return { images: repairedImages };
    },
  });
  assert.deepEqual(result, sample);
  assert.equal(calls, 3);
  assert.equal(renders, 1);
});

void test('visual review omits an unhelpful or unreviewed picture and never retries indefinitely', async () => {
  const { reviewIllustration } = await import('../lib/illustration-review');
  for (const mode of ['omit', 'repair', 'unavailable', 'invalid', 'empty-render']) {
    let calls = 0;
    const result = await reviewIllustration({
      illustration: sample,
      render: { images: mode === 'empty-render' ? [] : [{ mediaType: 'image/png', base64: 'png' }] },
      source: 'source',
      model: DEFAULT_CODEX_MODEL,
      generate: async () => {
        await Promise.resolve();
        calls++;
        if (mode === 'unavailable') throw new Error('Harness unavailable');
        if (mode === 'invalid') return '{}';
        if (calls === 2) return JSON.stringify({ svgIllustration: sample });
        return JSON.stringify({ verdict: mode, findings: ['The drawing hides the decisive relation.'] });
      },
      renderIllustration: () => Promise.resolve({ images: [{ mediaType: 'image/png', base64: 'repaired' }] }),
    });
    assert.equal(result, null);
    assert.equal(calls, mode === 'repair' ? 3 : mode === 'empty-render' ? 0 : 1);
  }
});

void test('cancelling during visual review propagates without silently keeping a partial slide', async () => {
  const { reviewIllustration } = await import('../lib/illustration-review');
  const controller = new AbortController();
  await assert.rejects(
    reviewIllustration({
      illustration: sample,
      render: { images: [{ mediaType: 'image/png', base64: 'png' }] },
      source: 'source',
      model: DEFAULT_CODEX_MODEL,
      signal: controller.signal,
      generate: async () => {
        await Promise.resolve();
        controller.abort();
        throw new Error('cancelled');
      },
      renderIllustration: async () => {
        await Promise.resolve();
        throw new Error('must not repair');
      },
    }),
    /abort/i
  );
});

void test('writer preserves prose when the rendered educational review omits the illustration', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  let calls = 0;
  try {
    provider.generate = () =>
      Promise.resolve(
        ++calls === 1
          ? JSON.stringify({ narrative: 'Keep this insight.', svgIllustration: sample })
          : JSON.stringify({ verdict: 'omit', findings: ['The prose is clearer than this redundant picture.'] })
      );
    const result = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: 'Source.',
      validateIllustration: () => Promise.resolve({ images: [{ mediaType: 'image/png', base64: 'rendered' }] }),
    });
    assert.equal(calls, 2);
    assert.equal(result.narrative, 'Keep this insight.');
    assert.equal(result.svgIllustration, null);
  } finally {
    provider.generate = original;
  }
});

void test('a slide that needs no diagram does not incur rendering or critic calls', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  let calls = 0;
  try {
    provider.generate = () => {
      calls++;
      return Promise.resolve(
        JSON.stringify({ narrative: 'The default timeout is now 30 seconds.', svgIllustration: null })
      );
    };
    const result = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: '-timeout = 10;\n+timeout = 30;',
      validateIllustration: () => Promise.reject(new Error('Must not render a missing diagram')),
    });
    assert.equal(calls, 1);
    assert.equal(result.svgIllustration, null);
  } finally {
    provider.generate = original;
  }
});
