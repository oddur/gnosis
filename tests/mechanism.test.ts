import { SVG_ILLUSTRATION_DIRECTIVE } from '../lib/svg-illustration';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mechanismFrame, normalizeMechanism } from '../lib/mechanism';
import { layoutMechanism, pointOnRoute } from '../lib/mechanism-layout';
import { QUEUE_SCENE } from './fixtures/mechanism-examples';
import { getProvider } from '../lib/provider';
import { generateSlide, generateReviewGuide } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';

void test('complete snapshots restore exact queue contents after seeking backward', () => {
  const events = QUEUE_SCENE.scenarios[0].events;
  assert.deepEqual(mechanismFrame(events, 2).event.states[0].items, ['5', '3']);
  assert.deepEqual(mechanismFrame(events, 0).event.states[0].items, ['8', '5', '3']);
  assert.deepEqual(mechanismFrame(events, 1).event.states[1].items, ['8']);
  assert.equal(mechanismFrame(events, -1).index, 0);
  assert.equal(mechanismFrame(events, Infinity).index, 0);
  assert.equal(mechanismFrame(events, 100).index, 2);
});
void test('arrival precedes state changes and reduced motion retains every state', () => {
  const events = QUEUE_SCENE.scenarios[0].events;
  const moving = mechanismFrame(events, 0.4);
  assert.equal(moving.transfer?.label, '8');
  assert.deepEqual(moving.event.states[1].items, []);
  const arrived = mechanismFrame(events, 0.8);
  assert.equal(arrived.transfer, undefined);
  assert.deepEqual(arrived.event.states[1].items, ['8']);
  assert.equal(mechanismFrame(events, 0.4, true).transfer, undefined);
  assert.deepEqual(mechanismFrame(events, 0.8, true).event, arrived.event);
});
void test('layout is identical across scenarios and every event', () => {
  const layout = layoutMechanism(QUEUE_SCENE);
  for (const scenario of QUEUE_SCENE.scenarios)
    for (const event of scenario.events) {
      assert.ok(event.states.every((s) => layout.nodes.some((n) => n.id === s.id)));
      assert.deepEqual(layoutMechanism({ ...QUEUE_SCENE, scenarios: [scenario] }), layout);
    }
  assert.deepEqual(
    pointOnRoute(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 20 },
      ],
      0.5
    ),
    { x: 10, y: 5 }
  );
});
void test('reject broken references, incomplete snapshots, and oversized input without truncating', () => {
  assert.deepEqual(normalizeMechanism(QUEUE_SCENE), QUEUE_SCENE);
  for (const mutate of [
    (s: typeof QUEUE_SCENE) => {
      s.edges[0].to = 'missing';
    },
    (s: typeof QUEUE_SCENE) => {
      s.nodes[1].id = s.nodes[0].id;
    },
    (s: typeof QUEUE_SCENE) => {
      s.nodes[1].column = 0;
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[1].states.pop();
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[1].transfer = { edge: 'missing', label: '8' };
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[0].transfer = { edge: 'take', label: 'bad' };
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[0].states[0].items = ['1', '2', '3', '4', '5'];
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[0].evidence = { filePath: 'batch.ts', startLine: -1 };
    },
    (s: typeof QUEUE_SCENE) => {
      s.scenarios[0].events[0].caption = 'x'.repeat(261);
    },
  ]) {
    const bad = structuredClone(QUEUE_SCENE);
    mutate(bad);
    assert.equal(normalizeMechanism(bad), null);
  }
  assert.equal(normalizeMechanism(null), null);
  assert.equal(normalizeMechanism('<script>alert(1)</script>'), null);
});
void test('writer and legacy generation preserve scenes and prefer them over D2', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  try {
    provider.generate = (opts) => {
      assert.ok(opts.systemPrompt.includes(SVG_ILLUSTRATION_DIRECTIVE));
      return Promise.resolve(
        JSON.stringify({ narrative: 'Keep order.', mechanism: QUEUE_SCENE, d2Diagram: { source: 'a -> b' } })
      );
    };
    const slide = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: 'fixture' });
    assert.deepEqual(slide.mechanism, QUEUE_SCENE);
    assert.equal(slide.d2Diagram, null);
    provider.generate = () =>
      Promise.resolve(
        JSON.stringify({
          prTitle: 'Queue',
          summary: 'Summary',
          riskLevel: 'low',
          riskRationale: 'Small',
          slides: [
            {
              id: 's',
              slideNumber: 1,
              title: 'Queue',
              slideType: 'logic',
              narrative: 'Keep order.',
              diffHunkIds: [],
              affectedFiles: [],
              dependsOn: [],
              mechanism: QUEUE_SCENE,
            },
          ],
        })
      );
    const result = await generateReviewGuide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      contextPackage: 'fixture',
      prUrl: 'https://github.com/example/repo/pull/1',
    });
    assert.deepEqual(result.slides[0].mechanism, QUEUE_SCENE);
  } finally {
    provider.generate = original;
  }
});

void test('writer repairs a malformed scene once without discarding an otherwise useful explanation', async () => {
  const provider = getProvider('codex');
  const original = provider.generate.bind(provider);
  let attempts = 0;
  try {
    provider.generate = (opts) => {
      attempts++;
      if (attempts === 2) assert.match(opts.content, /Repair the animated scene/);
      return Promise.resolve(
        JSON.stringify({
          narrative: 'Keep order.',
          mechanism: attempts === 1 ? { version: 1, nodes: [] } : QUEUE_SCENE,
        })
      );
    };
    const slide = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: 'fixture' });
    assert.equal(attempts, 2);
    assert.deepEqual(slide.mechanism, QUEUE_SCENE);
    attempts = 0;
    provider.generate = () => {
      attempts++;
      return Promise.resolve(JSON.stringify({ narrative: 'Still useful.', mechanism: { version: 1 } }));
    };
    const fallback = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: 'fixture',
    });
    assert.equal(attempts, 2);
    assert.equal(fallback.mechanism, null);
    assert.equal(fallback.narrative, 'Still useful.');
  } finally {
    provider.generate = original;
  }
});
