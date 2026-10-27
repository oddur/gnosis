import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D2 } from '@d2lang/d2';
import { normalizeD2Diagram, diagramFrameCaption, normalizeDiagramBrief } from '../lib/diagram-spec';
import { D2_RECIPES } from '../lib/d2-recipes';
import generated from './fixtures/d2-generated.json';
import { prepareD2Source } from '../lib/d2-source';
import { compileD2Source } from '../lib/d2-compile';
import { namespaceSVG } from '../lib/svg-ids';
import { resolveD2Icons } from '../lib/d2-icons';
import { generateSlide, generateReviewGuide, planReview } from '../lib/agent';
import { getProvider, type GenerateOptions } from '../lib/provider';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { buildTopicContext } from '../lib/context-builder';
import type { Diagram } from '@d2lang/d2';
import { STABLE_D2_SOURCE } from './fixtures/d2-stable';
import { changedLabelRanges, markChangedLabel } from '../lib/d2-label-changes';

void test('changed label ranges identify values without marking unchanged words or repeated numbers', async () => {
  const changed = (before: string, after: string) =>
    changedLabelRanges(before, after).map((r) => after.slice(r.start, r.end));
  assert.deepEqual(changed('In flight: 1 / 2', 'In flight: 2 / 2'), ['2']);
  assert.deepEqual(changed('Version 7, owner A', 'Version 8, owner B'), ['8', 'B']);
  assert.deepEqual(changed('Pending: A, B, C', 'Pending: B, C'), []);
  assert.deepEqual(changed('Value: 1\nLimit: 2', 'Value: 1 Limit: 2'), []);
  assert.deepEqual(changed('État: prêt', 'État: fini'), ['fini']);
  const long = 'unchanged '.repeat(400);
  assert.deepEqual(changed(long + '1', long + '2'), ['2']);
  assert.deepEqual(changed(long + '😀', long + '😃'), ['😃']);

  const { JSDOM } = await import('jsdom');
  const doc = new JSDOM(
    `<svg xmlns="http://www.w3.org/2000/svg"><g data-d2-entity="slots"><rect x="10" y="20" width="240" height="100"/><text x="20" y="40"><tspan x="20" y="40">In flight: 2 / 2</tspan><tspan x="20" y="70">Next: C</tspan></text><g data-d2-entity="slots.child"><text>In flight: 2 / 2</text></g></g></svg>`,
    { contentType: 'image/svg+xml' }
  ).window.document;
  const group = doc.querySelector('[data-d2-entity="slots"]');
  assert.ok(group);
  const original = group.textContent;
  const label = 'In flight: 2 / 2\nNext: C';
  markChangedLabel(group, label, changedLabelRanges('In flight: 1 / 2\nNext: B', label));
  assert.deepEqual(
    [...group.querySelectorAll('[data-d2-updated]')].map((e) => e.textContent),
    ['2', 'C']
  );
  assert.equal(group.textContent, original, 'highlighting does not rewrite the label');
  assert.equal(group.querySelector('rect')?.getAttribute('width'), '240');
  assert.equal(group.querySelector('text > tspan')?.getAttribute('x'), '20');
  assert.equal(group.querySelector('[data-d2-entity="slots.child"] [data-d2-updated]'), null);
});

const geometry = (board: Diagram) => ({
  shapes: board.shapes
    .map(({ id, pos, width, height }) => ({ id, pos, width, height }))
    .sort((a, b) => a.id.localeCompare(b.id)),
  edges: board.connections
    .map(({ id, route, labelPosition, labelPercentage }) => ({ id, route, labelPosition, labelPercentage }))
    .sort((a, b) => a.id.localeCompare(b.id)),
});

void test('native steps reserve label space and retain node positions and edge routes', async () => {
  const d2 = new D2();
  const source = STABLE_D2_SOURCE;
  try {
    for (const dark of [false, true]) {
      const compiled = await compileD2Source(d2, source, dark);
      const boards = [compiled.diagram, ...(compiled.diagram.steps ?? []).filter((b): b is Diagram => !!b)];
      for (const board of boards.slice(1)) assert.deepEqual(geometry(board), geometry(boards[0]));
      const queue = boards[1].shapes.find((s) => s.id === 'queue');
      assert.ok(queue && 'label' in queue);
      assert.equal(queue.label, 'Pending: A, B, C\nWaiting for capacity');
      assert.equal(boards[1].shapes.find((s) => s.id === 'worker')?.strokeWidth, 4);
      for (const board of boards) {
        for (const shape of board.shapes) {
          assert.equal(shape.labelPosition, 'INSIDE_MIDDLE_CENTER', 'labels remain inside their nodes');
          if ('label' in shape) {
            assert.equal(shape.fontSize, 24, 'native steps retain the application font size');
            assert.ok(
              shape.width >= shape.labelWidth && shape.height >= shape.labelHeight,
              'reserve enough room for every state'
            );
          }
        }
        for (const edge of board.connections) assert.equal(edge.fontSize, 20);
        assert.match(await d2.render(board, { ...compiled.renderOptions, noXMLTag: true }), /<svg/);
      }
    }
  } finally {
    await d2.dispose();
  }
});

void test('stable layouts support containers, sequence notes and native scenarios without flattening real graph changes', async () => {
  const d2 = new D2();
  try {
    for (const source of [
      `direction: right
service: { handler: Handler { icon: gnosis:server }; jobs: "Pending: A"; handler -> jobs: enqueue }
worker: Worker
service.jobs -> worker: dispatch
scenarios: { busy: { service.jobs.label: "Pending: A, B, C\\nWait for capacity"; service.handler.style.stroke-width: 4 } }`,
      `shape: sequence_diagram
caller: Caller
api: API
store: Store
caller -> api.run: request
api.note: Check version
api.run -> store: write
store -> api.run: done
api.run -> caller: result
scenarios: { conflict: { api.note.label: "Version has changed\\nDo not write"; (store -> api.run)[0].label: "conflict: retry with current version" } }`,
    ]) {
      const result = await compileD2Source(d2, source, false);
      assert.ok(result.diagram.scenarios?.[0]);
      assert.deepEqual(geometry(result.diagram), geometry(result.diagram.scenarios[0]));
    }
    const changed = await compileD2Source(
      d2,
      `direction: right
a -> b: remote read
steps: {
  cached: { (a -> b)[0]: null; cache: Snapshot; a -> cache: local read; cache -> b: refresh }
  stale: { cache.label: "Stale snapshot\\nRefresh in progress" }
}`,
      false
    );
    const [cached, stale] = changed.diagram.steps ?? [];
    assert.ok(cached && stale);
    assert.deepEqual(geometry(cached), geometry(stale), 'matching later states share a layout too');
    assert.ok(
      !changed.diagram.shapes.some((s) => s.id === 'cache'),
      'do not introduce future entities into the initial state'
    );
    assert.deepEqual(
      changed.diagram.connections.map((e) => e.id),
      ['(a -> b)[0]']
    );
    assert.equal(cached.connections.length, 2);
  } finally {
    await d2.dispose();
  }
});

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
  const teachingGoal = {
    question: 'Why must C wait when both slots are occupied?',
    takeaway: 'A completion releases capacity before C can run.',
    assumedKnowledge: ['A queue holds pending work.'],
    essentialConcepts: ['pending', 'in flight', 'capacity'],
    omit: ['HTTP transport', 'logging'],
    visualApproach: 'Show a concrete full queue and the release condition.',
  };
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
          diagramBrief: teachingGoal,
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
  assert.deepEqual(plan.topics[0].diagramBrief, teachingGoal);
  assert.ok(context.includes(JSON.stringify(teachingGoal)));
  const sibling = {
    ...plan.topics[0],
    title: 'Retries',
    diagramBrief: {
      ...teachingGoal,
      question: 'When is a retry safe?',
      takeaway: 'A repeated job must not repeat its effect.',
    },
  };
  const shared = buildTopicContext(plan.topics[0], new Map(), {}, {}, {}, 'Bound work', '', plan.storyArc, [
    plan.topics[0],
    sibling,
  ]);
  assert.match(shared, /<diagram_coverage_plan>Planned coverage/);
  assert.ok(shared.includes('When is a retry safe?'));
  assert.equal(shared.split('When is a retry safe?').length, 2);
  assert.ok(!shared.includes('[object Object]'));
  const legacy = buildTopicContext(
    { ...plan.topics[0], diagramBrief: 'Show the state when both slots are occupied.' },
    new Map(),
    {},
    {},
    {},
    'Bound work',
    '',
    plan.storyArc,
    []
  );
  assert.match(legacy, /<diagram_brief>Show the state/);
  const noDiagram = buildTopicContext(
    { ...plan.topics[0], diagramBrief: null },
    new Map(),
    {},
    {},
    {},
    'Bound work',
    '',
    plan.storyArc,
    []
  );
  assert.match(noDiagram, /No diagram planned/);
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
    assert.match(call.systemPrompt, /HOW THE CHANGE WORKS/);
    assert.match(call.content, /"focus"/);
    assert.match(call.content, /"d2Diagram"/);
    assert.doesNotMatch(call.content, /"mermaidDiagram"/);
  }
});

void test('saved diagrams with literal SQL placeholders render without changing labels or D2 variables', async () => {
  const d2 = new D2();
  try {
    const source = [
      'vars: { name: expected }',
      'query: "WHERE id = $1 AND owner = $2"',
      'unicode: "Résumé 😀 costs $10"',
      "single: 'Literal $name and ${not_a_variable}'",
      'block: |md\nKeep $1 and ${code} literal\n|',
      'variable: "${name}"',
      'steps: { after: { query.label: "WHERE id = $1 (selected)" } }',
    ].join('\n');
    for (const dark of [false, true]) {
      const compiled = await compileD2Source(d2, source, dark);
      const labels = compiled.diagram.shapes.map((shape) => ('label' in shape ? shape.label : ''));
      assert.ok(labels.includes('WHERE id = $1 AND owner = $2'));
      assert.ok(labels.includes('Résumé 😀 costs $10'));
      assert.ok(labels.includes('Literal $name and ${not_a_variable}'));
      assert.ok(labels.includes('Keep $1 and ${code} literal'));
      assert.ok(labels.includes('expected'));
      const after = compiled.diagram.steps?.[0];
      assert.ok(after);
      assert.ok(after.shapes.some((shape) => 'label' in shape && shape.label === 'WHERE id = $1 (selected)'));
      assert.match(await d2.render(after, { ...compiled.renderOptions, noXMLTag: true }), /WHERE id = \$1/);
    }
    const alreadyEscaped = await compileD2Source(d2, 'query: "WHERE id = \\$1"', false);
    assert.ok(alreadyEscaped.diagram.shapes.some((shape) => 'label' in shape && shape.label === 'WHERE id = $1'));
    await assert.rejects(compileD2Source(d2, 'query: "${missing}"', false));
    await assert.rejects(compileD2Source(d2, 'query: {', false));
  } finally {
    await d2.dispose();
  }
});

void test('guided steps survive saved JSON and reuse one layout while identifying exact D2 entities', async () => {
  const { diagramViews, tagDiagramEntities } = await import('../lib/d2-presentation');
  const { JSDOM } = await import('jsdom');
  const d2 = new D2();
  try {
    const spec = normalizeD2Diagram(
      JSON.parse(
        JSON.stringify({
          kind: 'walkthrough',
          source:
            'client: Client\nservice: { handler: Handler; store: Store; handler -> store: write }\nclient -> service.handler: request',
          caption: 'Illustrative request.',
          steps: [
            { board: 'overview', title: 'Overview', description: 'See the exchange.' },
            {
              board: 'overview',
              title: 'Request',
              description: 'The handler receives the request.',
              change: 'Send the input.',
              focus: ['(client -> service.handler)[0]'],
              evidence: { filePath: 'api.ts', startLine: 12 },
            },
            {
              board: 'overview',
              title: 'Write',
              description: 'The store receives the write.',
              focus: ['service.(handler -> store)[0]'],
            },
          ],
        })
      )
    );
    assert.ok(spec);
    const compiled = await compileD2Source(d2, spec.source, false);
    const entities = [...compiled.diagram.shapes, ...compiled.diagram.connections].map((item) => ({
      id: item.id,
      label: 'label' in item ? item.label : item.id,
      emphasized: false,
    }));
    const svg = await d2.render(compiled.diagram, { ...compiled.renderOptions, noXMLTag: true });
    const root = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document.documentElement;
    tagDiagramEntities(root, entities);
    const tagged = [...root.querySelectorAll('[data-d2-entity]')].map((el) => el.getAttribute('data-d2-entity'));
    for (const step of spec.steps ?? []) for (const id of step.focus ?? []) assert.ok(tagged.includes(id), id);
    const frame = { id: 'overview', name: 'Overview', svg, entities, animated: false, notes: [] };
    const views = diagramViews(spec, [frame]);
    assert.equal(views.length, 3);
    assert.ok(
      views.every((view) => view.frame === frame),
      'focus views share the compiled drawing'
    );
    assert.deepEqual(views[1].evidence, { filePath: 'api.ts', startLine: 12 });
    assert.equal(views[1].change, 'Send the input.');
    assert.equal(views[2].differences.length, 0, 'focus does not falsely imply state changed');
    assert.deepEqual(
      diagramViews({ ...spec, steps: spec.steps?.slice(1) }, [frame]).map((view) => view.title),
      ['Request', 'Write'],
      'an explicit walkthrough starts at the first useful explanation, without an inserted overview'
    );
    const malformed = normalizeD2Diagram({
      source: spec.source,
      steps: [
        { board: 'missing', title: 'Bad reference', focus: ['missing'], evidence: { filePath: {}, startLine: -1 } },
      ],
    });
    assert.ok(malformed);
    assert.equal(diagramViews(malformed, [frame])[0].frame, frame, 'invalid references retain a usable diagram');
    assert.equal(malformed.steps?.[0].evidence, undefined);
  } finally {
    await d2.dispose();
  }
});

void test('optional diagram teaching goals reject malformed fields and retain legacy plans', () => {
  assert.equal(normalizeDiagramBrief(' Explain capacity. '), 'Explain capacity.');
  for (const value of [null, [], false, { question: 'Why?' }, { question: {}, takeaway: 'A' }]) {
    assert.equal(normalizeDiagramBrief(value), null);
  }
  assert.deepEqual(
    normalizeDiagramBrief({
      question: ' Why? ',
      takeaway: ' Because. ',
      assumedKnowledge: [null, 'queues', 'queues'],
      essentialConcepts: {},
      omit: ['logs', 1],
      visualApproach: false,
    }),
    {
      question: 'Why?',
      takeaway: 'Because.',
      assumedKnowledge: ['queues'],
      essentialConcepts: [],
      omit: ['logs'],
      visualApproach: '',
    }
  );
});
