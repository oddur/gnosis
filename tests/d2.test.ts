import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D2 } from '@d2lang/d2';
import { normalizeD2Diagram, diagramFrameCaption } from '../lib/diagram-spec';
import { D2_RECIPES } from '../lib/d2-recipes';
import generated from './fixtures/d2-generated.json';
import { prepareD2Source } from '../lib/d2-source';
import { namespaceSVG } from '../lib/svg-ids';
import { resolveD2Icons } from '../lib/d2-icons';
import { generateSlide, generateReviewGuide, planReview } from '../lib/agent';
import { getProvider, type GenerateOptions } from '../lib/provider';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { buildTopicContext } from '../lib/context-builder';

void test('malformed optional diagrams cannot break the review, and old positional captions stay aligned', () => {
  for (const invalid of [
    undefined,
    null,
    [],
    'a -> b',
    {},
    { source: {} },
    { source: ' ' },
    { source: 'a'.repeat(40001) },
  ]) {
    assert.equal(normalizeD2Diagram(invalid), null);
  }
  const diagram = normalizeD2Diagram({
    source: '```d2\na -> b\n```',
    caption: { bad: true },
    steps: [null, { title: ' After ', description: ' Changed ' }],
  });
  assert.ok(diagram);
  assert.equal(diagram.source, 'a -> b');
  assert.equal(diagram.caption, undefined);
  assert.equal(diagramFrameCaption(diagram, 'steps.after', 1)?.title, 'After');
  const named = normalizeD2Diagram({
    source: 'a -> b',
    steps: [
      { board: 'steps.after', title: 'After', description: 'Why' },
      { board: 'overview', title: 'Overview' },
    ],
  });
  assert.ok(named);
  assert.equal(diagramFrameCaption(named, 'overview', 0)?.title, 'Overview');
  assert.equal(diagramFrameCaption(named, 'steps.missing', 1), undefined);
  assert.deepEqual(normalizeD2Diagram(JSON.parse(JSON.stringify(named))), named);
});

void test('repeated SVGs keep markers and styles scoped without rewriting labels or overlapping IDs', () => {
  const svg =
    '<svg id="a"><style>#a .x {clip-path:url(#a-long)}</style><defs><clipPath id="a-long" /></defs><use href="#a-long"/><text>a and a-long</text></svg>';
  const first = namespaceSVG(svg, 'one');
  const second = namespaceSVG(svg, 'two');
  assert.match(first, /id="a-one"/);
  assert.match(first, /id="a-long-one"/);
  assert.match(first, /#a-one \.x/);
  assert.match(first, /url\(#a-long-one\)/);
  assert.match(first, /href="#a-long-one"/);
  assert.match(first, /<text>a and a-long<\/text>/);
  assert.doesNotMatch(second, /a-long-one/);
});

void test('every prompt recipe compiles with TALA and renders all boards in both themes', async () => {
  const d2 = new D2();
  try {
    for (const recipe of [
      ...D2_RECIPES,
      ...generated.map((item) => ({ name: item.title, source: item.diagram.source })),
    ]) {
      for (const dark of [false, true]) {
        const result = await d2.compile(prepareD2Source(recipe.source, dark), { layout: 'tala' });
        const boards = [result.diagram, ...(result.diagram.steps ?? []), ...(result.diagram.scenarios ?? [])];
        assert.ok(boards.length > 0 && boards.length <= 12);
        for (const board of boards) {
          assert.ok(board, recipe.name);
          const svg = await d2.render(board, {
            ...result.renderOptions,
            themeID: dark ? 201 : 0,
            pad: 24,
            noXMLTag: true,
          });
          assert.match(svg, /data-d2-version="v0\.9\.0"/, recipe.name);
          assert.match(svg, /viewBox="[-\d. ]+"/, recipe.name);
          for (const href of svg.matchAll(/(?:href|xlink:href)="([^"]+)"/g)) {
            assert.ok(href[1].startsWith('#') || href[1].startsWith('data:'), 'no remote image references');
          }
        }
      }
    }
  } finally {
    await d2.dispose();
  }
});

void test('diagram resources stay local', () => {
  assert.match(prepareD2Source('data: Payload\nfile: Source', false), /Payload/);
  for (const source of [
    'a.icon: https://example.com/x.svg',
    'a.icon: data:image/svg+xml,bad',
    '...@remote',
    'a.icon: file:///secret',
  ]) {
    assert.throws(() => prepareD2Source(source, false), /external resources/);
  }
  assert.throws(() => prepareD2Source('a: { icon: gnosis:unknown }', false), /Unknown diagram icon/);
  assert.throws(() => prepareD2Source('a: { icon: gnosis:constructor }', false), /Unknown diagram icon/);
  assert.match(resolveD2Icons('api.icon: gnosis:server', false), /api\.icon\.near: center-left; api\.label\.near/);
});

void test('planner, whole-review and topic writer share the diagram contract and retain usable output', async (t) => {
  const diagram = { source: 'a -> b', caption: 'A hands work to B.', steps: [] };
  const responses = [
    {
      summary: 'Bound work.',
      riskLevel: 'medium',
      storyArc: 'Bound work.',
      topics: [
        {
          title: 'Capacity',
          slideType: 'feature',
          importance: 'important',
          hunkIds: [],
          dependsOn: [],
          order: 1,
          narrativeBrief: 'Explain the bound.',
          diagramBrief: 'Show the state when both slots are occupied.',
        },
      ],
    },
    {
      prTitle: 'Bound work',
      summary: 'Bound work.',
      riskLevel: 'medium',
      slides: [{ narrative: 'Bound work.', d2Diagram: diagram }],
    },
    { narrative: 'Bound work.', d2Diagram: diagram },
    { narrative: 'Still readable.', d2Diagram: { source: 42, steps: [false] } },
  ];
  const calls: GenerateOptions[] = [];
  t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    calls.push(options);
    return Promise.resolve(JSON.stringify(responses.shift()));
  });
  const plan = await planReview('hunk index', 'PR', 'codex', DEFAULT_CODEX_MODEL);
  assert.match(calls[0].systemPrompt, /DIAGRAM PLAN/);
  const context = buildTopicContext(
    plan.topics[0],
    new Map(),
    {},
    {},
    {},
    'Bound work',
    '',
    plan.storyArc,
    plan.topics
  );
  assert.match(context, /<diagram_brief>Show the state/);
  const whole = await generateReviewGuide({
    providerName: 'codex',
    model: DEFAULT_CODEX_MODEL,
    contextPackage: context,
    prUrl: 'https://github.com/example/repo/pull/1',
  });
  const slide = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: context });
  const invalid = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: context });
  assert.equal(whole.slides[0].d2Diagram?.source, diagram.source);
  assert.equal(slide.d2Diagram?.source, diagram.source);
  assert.equal(invalid.d2Diagram, null);
  assert.equal(invalid.narrative, 'Still readable.');
  assert.equal(calls.length, 4, 'invalid optional diagram does not retry the whole paid generation');
  for (const call of calls.slice(1)) {
    assert.match(call.systemPrompt, /COMPILER-CHECKED SYNTAX RECIPES/);
    assert.match(call.systemPrompt, /exactly-once/);
    assert.match(call.systemPrompt, /scenarios\.compare/);
    assert.match(call.content, /"d2Diagram"/);
    assert.doesNotMatch(call.content, /"mermaidDiagram"/);
  }
});
