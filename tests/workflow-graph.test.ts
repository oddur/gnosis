import { workflowFailureInsight, workflowJobDetails } from '../lib/workflow-graph';
import {
  attentionJobs,
  nextAttentionJob,
  preferredWorkflow,
  workflowRunLabel,
  workflowJobCount,
  workflowSession,
} from '../lib/workflow-navigation';
import { withGitHubPriority } from '../lib/github-scheduler';
import { createWorkflowGraphPreloader } from '../src/workflow-graph-preloader';
import { stageWorkflow, focusWorkflow } from '../src/workflow-stages';
import { readableWorkflowViewport } from '../lib/workflow-viewport';
import { compactWorkflow } from '../src/workflow-visibility';
import { layoutWorkflow } from '../src/workflow-layout';
import { workflowEdgePath } from '../lib/workflow-edge-path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, assembleWorkflow } from '../src/workflow-definition';
import { readWorkflowGraph, readWorkflowRuns } from '../src/workflow-graph-service';
import { createGitHubClientPool, githubCacheFor } from './cache-test-pool';
import type { WorkflowJob } from '../lib/workflow-graph';
import type { PrChecks } from '../lib/pr-checks';

const source = `name: CI
on: pull_request
jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
  test:
    name: Test \${{ matrix.os }}
    needs: build
    strategy:
      matrix:
        os: [Linux, macOS]
  deploy:
    name: Deploy
    needs: [test]
`;
const job = (id: number, name: string, conclusion = 'success'): WorkflowJob => ({
  id,
  checkId: `check:${id}`,
  name,
  status: 'completed',
  conclusion,
  startedAt: null,
  completedAt: null,
  url: '',
  steps: [],
});
void test('declared dependencies survive matrix collapse and expansion', () => {
  const defs = parseWorkflow(source),
    jobs = [job(1, 'Build'), job(2, 'Test Linux'), job(3, 'Test macOS'), job(4, 'Deploy')];
  const collapsed = assembleWorkflow(defs, jobs, []);
  assert.equal(collapsed.nodes.length, 3);
  assert.equal(collapsed.nodes[1].jobs.length, 2);
  assert.equal(collapsed.edges.length, 2);
  const expanded = assembleWorkflow(defs, jobs, ['test']);
  assert.equal(expanded.nodes.length, 4);
  assert.deepEqual(
    expanded.edges.map((e) => [e.source, e.target]),
    [
      ['build', 'test/job:2'],
      ['build', 'test/job:3'],
      ['test/job:2', 'deploy'],
      ['test/job:3', 'deploy'],
    ]
  );
});
void test('failed matrix jobs stay individually visible without manual expansion', () => {
  const defs = parseWorkflow(source);
  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']) {
    const jobs = [job(1, 'Build'), job(2, 'Test Linux', conclusion), job(3, 'Test macOS'), job(4, 'Deploy')];
    const assembled = assembleWorkflow(defs, jobs, []);
    for (const grouping of ['adaptive', 'compact', 'off'] as const) {
      const staged = stageWorkflow(assembled.nodes, assembled.edges, [], grouping);
      const graph = compactWorkflow(staged.nodes, staged.edges, { showCompleted: false, showSkipped: false });
      const failed = graph.nodes.find((node) => node.jobs.some((j) => j.id === 2));
      assert.equal(failed?.jobs.length, 1, `${conclusion} must not hide inside a group`);
      assert.equal(failed?.name, 'Test Linux');
      assert.ok(!assembled.groups.some((group) => group.id === 'test'), 'Cannot offer collapse for a failed group');
      assert.ok(graph.edges.some((edge) => edge.target === failed?.id));
      assert.ok(graph.edges.some((edge) => edge.source === failed?.id));
    }
  }
});
void test('nested reusable workflows expose failed descendants and preserve dependency edges', () => {
  const defs = parseWorkflow(
    'jobs:\n  prepare: {}\n  native:\n    name: Native Bundle\n    needs: prepare\n    uses: ./native.yml\n  result:\n    needs: native\n'
  );
  defs[1].children = parseWorkflow('jobs:\n  build:\n    uses: ./build.yml\n  verify:\n    needs: build\n');
  defs[1].children[0].children = parseWorkflow('jobs:\n  compile: {}\n  package:\n    needs: compile\n');
  const graph = assembleWorkflow(
    defs,
    [
      job(1, 'prepare'),
      job(2, 'Native Bundle / build / compile'),
      job(3, 'Native Bundle / build / package', 'failure'),
      job(4, 'Native Bundle / verify', 'skipped'),
      job(5, 'result', 'failure'),
    ],
    []
  );
  assert.equal(graph.unmatched, 0);
  assert.equal(graph.nodes.find((node) => node.jobs.some((j) => j.id === 3))?.jobs.length, 1);
  assert.ok(
    graph.edges.some((edge) => edge.source === 'native/build/compile' && edge.target === 'native/build/package')
  );
  assert.ok(graph.edges.some((edge) => edge.source === 'native/build/package' && edge.target === 'native/verify'));
  assert.ok(!graph.groups.some((group) => group.id === 'native' || group.id === 'native/build'));
});
void test('duplicate job names never invent a mapping', () => {
  const graph = assembleWorkflow(
    parseWorkflow('jobs:\n  a:\n    name: Test\n  b:\n    name: Test\n    needs: a\n'),
    [job(1, 'Test')],
    []
  );
  assert.equal(graph.unmatched, 1);
  assert.equal(graph.nodes.find((n) => n.unmapped)?.jobs[0].id, 1);
  assert.ok(graph.edges.every((e) => !e.source.startsWith('unmapped:') && !e.target.startsWith('unmapped:')));
});
void test('dynamic expressions remain unknown and are never evaluated', () => {
  const defs = parseWorkflow(
    'jobs:\n  test:\n    name: Test ${{ matrix.os }}\n    strategy:\n      matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}\n'
  );
  assert.deepEqual(defs[0].names, []);
  assert.equal(assembleWorkflow(defs, [job(1, 'Test Linux')], []).unmatched, 1);
});
void test('include-only matrices expand every row; exclude happens before include', () => {
  const [only] = parseWorkflow(
    'jobs:\n  test:\n    name: Test ${{ matrix.os }}\n    strategy:\n      matrix:\n        include:\n          - os: Linux\n          - os: macOS\n'
  );
  assert.deepEqual(only.names, ['Test Linux', 'Test macOS']);
  const [included] = parseWorkflow(
    'jobs:\n  test:\n    name: Test ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [Linux, macOS]\n        exclude: [{os: macOS}]\n        include: [{os: macOS}]\n'
  );
  assert.deepEqual(included.names, ['Test Linux', 'Test macOS']);
});
void test('workflow_call input defaults and supplied inputs resolve names', () => {
  const source =
    'on:\n  workflow_call:\n    inputs:\n      platform:\n        default: Linux\njobs:\n  build:\n    name: Build ${{ inputs.platform }}\n';
  assert.deepEqual(parseWorkflow(source)[0].names, ['Build Linux']);
  assert.deepEqual(parseWorkflow(source, { platform: 'macOS' })[0].names, ['Build macOS']);
});
void test('reusable groups preserve internal and external dependencies', () => {
  const defs = parseWorkflow(
    'jobs:\n  prepare: {}\n  desktop:\n    name: Desktop\n    needs: prepare\n    uses: ./.github/workflows/desktop.yml\n  publish:\n    needs: desktop\n'
  );
  defs[1].children = parseWorkflow('jobs:\n  build: {}\n  verify:\n    needs: build\n');
  const jobs = [job(1, 'prepare'), job(2, 'Desktop / build'), job(3, 'Desktop / verify'), job(4, 'publish')];
  const graph = assembleWorkflow(defs, jobs, ['desktop']);
  assert.equal(graph.unmatched, 0);
  assert.deepEqual(
    graph.edges.map((e) => [e.source, e.target]),
    [
      ['desktop/build', 'desktop/verify'],
      ['prepare', 'desktop/build'],
      ['desktop/verify', 'publish'],
    ]
  );
});
void test('missing observed jobs retain definitions without claiming queued state', () => {
  const graph = assembleWorkflow(parseWorkflow(source), [job(1, 'Build')], []);
  assert.equal(graph.nodes.find((n) => n.id === 'deploy')?.jobs.length, 0);
});
void test('malformed, oversized, and duplicate-key YAML is rejected', () => {
  assert.throws(() => parseWorkflow('jobs: ['));
  assert.throws(() => parseWorkflow('jobs:\n  a: {}\n  a: {}'));
  assert.throws(() => parseWorkflow('x'.repeat(513_000)));
});
void test('large matrix products are bounded', () => {
  const defs = parseWorkflow(
    `jobs:\n  t:\n    strategy:\n      matrix:\n        a: [${Array.from({ length: 20 }, (_, i) => i).join(',')}]\n        b: [${Array.from({ length: 20 }, (_, i) => i).join(',')}]`
  );
  assert.deepEqual(defs[0].names, []);
});

const sha = 'a'.repeat(40),
  target = { url: 'https://github.com/o/r/pull/1', headSha: sha },
  input = { ...target, runId: 9 };
function harness(onRequest?: (url: URL) => Promise<void>) {
  let testConclusion = 'success';
  const calls: string[] = [];
  const run = {
    id: 9,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: sha,
    workflow_id: 5,
    event: 'pull_request',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/o/r/actions/runs/9',
    pull_requests: [{ number: 1 }],
    referenced_workflows: [] as { path: string; sha: string }[],
  };
  let files: Record<string, string> = {};
  let stepText = '';
  let workflow = source,
    failSource = false,
    pause: Promise<void> | undefined;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (address: string) => {
      calls.push(address);
      if (pause) await pause;
      const url = new URL(address);
      await onRequest?.(url);
      let data: unknown;
      let status = 200;
      if (url.pathname.endsWith('/actions/runs')) data = { total_count: 1, workflow_runs: [run] };
      else if (url.pathname.endsWith('/actions/runs/9')) data = run;
      else if (url.pathname.endsWith('/jobs'))
        data = {
          total_count: 4,
          jobs: [job(1, 'Build'), job(2, 'Test Linux', testConclusion), job(3, 'Test macOS'), job(4, 'Deploy')].map(
            (j) => ({
              ...j,
              check_run_url: `https://api.github.com/repos/o/r/check-runs/${j.id}`,
              started_at: j.startedAt,
              completed_at: j.completedAt,
              html_url: '',
              steps: stepText ? [{ number: 1, name: stepText, status: 'completed', conclusion: 'success' }] : [],
            })
          ),
        };
      else if (url.pathname.includes('/contents/')) {
        const body = files[decodeURIComponent(url.pathname.split('/contents/')[1])] ?? workflow;
        if (failSource) {
          status = 404;
          data = { message: 'Not found' };
        } else
          data = {
            type: 'file',
            size: body.length,
            encoding: 'base64',
            content: Buffer.from(body).toString('base64'),
          };
      } else throw Error(address);
      const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: address });
      return response;
    }) as typeof fetch,
  });
  return {
    failJob: () => {
      testConclusion = 'failure';
    },
    client: pool.client('account'),
    other: pool.client('another-account'),
    calls,
    run,
    pool,
    files: (value: Record<string, string>) => {
      files = value;
    },
    stepText: (value: string) => {
      stepText = value;
    },
    recover: () => {
      failSource = false;
    },
    source: (s: string) => {
      workflow = s;
    },
    fail: () => {
      failSource = true;
    },
    pause: (p: Promise<void>) => {
      pause = p;
    },
  };
}
void test('cold load reads workflow source at the run commit and jobs together, then reuses cache', async () => {
  const h = harness();
  assert.equal(await readWorkflowGraph(h.client, input, { cachedOnly: true }), undefined);
  assert.equal(h.calls.length, 0);
  const graph = await readWorkflowGraph(h.client, input);
  assert.equal(graph?.nodes.length, 3);
  assert.equal(graph?.edges.length, 2);
  assert.ok(h.calls.find((c) => c.includes('/contents/') && c.includes(`ref=${sha}`)));
  assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 1);
  const count = h.calls.length;
  await readWorkflowGraph(h.client, input);
  await readWorkflowGraph(h.client, { ...input, expanded: ['test'] });
  assert.equal(h.calls.length, count);
  assert.ok(graph?.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});
void test('concurrent reads coalesce and account caches are isolated', async () => {
  const h = harness();
  await Promise.all([readWorkflowGraph(h.client, input), readWorkflowGraph(h.client, input)]);
  assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 1);
  await readWorkflowGraph(h.other, input);
  assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 2);
});
void test('workflow job counts reuse per-attempt cache without fetching jobs for the list', async () => {
  const h = harness();
  assert.equal((await readWorkflowRuns(h.client, target))?.runs[0].jobCount, undefined);
  assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 0);
  const graph = await readWorkflowGraph(h.client, input);
  assert.equal(graph?.run.jobCount, 4);
  const before = h.calls.length;
  assert.equal((await readWorkflowRuns(h.client, target, { cachedOnly: true }))?.runs[0].jobCount, 4);
  assert.equal(h.calls.length, before);
  assert.equal((await readWorkflowRuns(h.other, target))?.runs[0].jobCount, undefined);
  h.run.run_attempt = 2;
  assert.equal((await readWorkflowRuns(h.client, target, { force: true }))?.runs[0].jobCount, undefined);
});
void test('a rerun invalidates completed jobs; layout stays stable', async () => {
  const h = harness();
  const first = await readWorkflowGraph(h.client, input);
  h.run.run_attempt = 2;
  await readWorkflowRuns(h.client, target, { force: true });
  const next = await readWorkflowGraph(h.client, input);
  assert.equal(next?.run.attempt, 2);
  assert.ok(h.calls.some((c) => c.includes('/attempts/2/jobs')));
  assert.deepEqual(
    next?.nodes.map((n) => [n.x, n.y]),
    first?.nodes.map((n) => [n.x, n.y])
  );
});
void test('wrong commit cannot be visualized as this PR revision', async () => {
  const h = harness();
  h.run.head_sha = 'b'.repeat(40);
  await assert.rejects(readWorkflowGraph(h.client, input), /another commit/);
  assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 0);
});
void test('missing source access preserves actual jobs with a clear warning and no guessed edges', async () => {
  const h = harness();
  h.fail();
  const graph = await readWorkflowGraph(h.client, input);
  assert.equal(graph?.nodes.length, 4);
  assert.equal(graph?.edges.length, 0);
  assert.ok(graph?.warnings.some((w) => w.includes('Dependencies unavailable')));
});
void test('cache clear during a request cannot repopulate its result', async () => {
  const h = harness();
  let release!: () => void;
  h.pause(
    new Promise<void>((r) => {
      release = r;
    })
  );
  const loading = readWorkflowGraph(h.client, input);
  githubCacheFor(h.client)!.clear();
  release();
  await loading;
  assert.equal(await readWorkflowRuns(h.client, target, { cachedOnly: true }), undefined);
  assert.equal(await readWorkflowGraph(h.client, input, { cachedOnly: true }), undefined);
});

void test('running jobs refresh after the freshness window without reloading definitions', async () => {
  const h = harness();
  h.run.status = 'in_progress';
  await readWorkflowGraph(h.client, input);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 30_000;
    await readWorkflowGraph(h.client, input);
    assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 2);
    assert.equal(h.calls.filter((c) => c.includes('/contents/')).length, 1);
  } finally {
    Date.now = realNow;
  }
});
void test('completed workflow data survives SQLite restart with no network requests', async () => {
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-workflow-cache-'));
  const first = harness(),
    second = harness();
  try {
    await first.pool.setStorage(path.join(dir, 'budget.json'));
    const before = await readWorkflowGraph(first.client, input);
    await first.pool.closeStorage();
    await second.pool.setStorage(path.join(dir, 'budget.json'));
    assert.deepEqual(await readWorkflowGraph(second.client, input), before);
    assert.equal(second.calls.length, 0);
  } finally {
    await first.pool.closeStorage();
    await second.pool.closeStorage();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('routed fan-in, fan-out and skip-layer dependencies avoid every unrelated card', async () => {
  const nodes = ['semantic-version', 'define-release-channel', 'build-macos', 'build-windows', 'publish'].map((id) => ({
    id,
  }));
  const edges = [
    ['semantic-version', 'build-macos'],
    ['semantic-version', 'build-windows'],
    ['define-release-channel', 'build-macos'],
    ['define-release-channel', 'build-windows'],
    ['build-macos', 'publish'],
    ['build-windows', 'publish'],
    ['semantic-version', 'publish'],
  ].map(([source, target]) => ({ id: source + '->' + target, source, target }));
  const routed = await layoutWorkflow(nodes, edges);
  for (const edge of edges) {
    const points = routed.edges.find((e) => e.id === edge.id)!.points;
    const source = routed.nodes.find((n) => n.id === edge.source)!;
    const target = routed.nodes.find((n) => n.id === edge.target)!;
    const start = source.ports.find((p) => p.id === 'source:' + edge.id)!;
    const end = target.ports.find((p) => p.id === 'target:' + edge.id)!;
    assert.deepEqual(points[0], { x: source.x + start.x, y: source.y + start.y });
    assert.deepEqual(points.at(-1), { x: target.x + end.x, y: target.y + end.y });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      assert.ok(a.x === b.x || a.y === b.y, 'Orthogonal segments');
      for (const node of routed.nodes.filter((n) => n.id !== edge.source && n.id !== edge.target)) {
        const crosses =
          a.x === b.x
            ? a.x > node.x - 4 &&
              a.x < node.x + 248 &&
              Math.max(a.y, b.y) > node.y - 4 &&
              Math.min(a.y, b.y) < node.y + 116
            : a.y > node.y - 4 &&
              a.y < node.y + 116 &&
              Math.max(a.x, b.x) > node.x - 4 &&
              Math.min(a.x, b.x) < node.x + 248;
        assert.equal(crosses, false, edge.id + ' crosses ' + node.id);
      }
    }
    assert.ok(workflowEdgePath(points).startsWith('M '));
  }
  for (const node of routed.nodes)
    assert.equal(
      new Set(node.ports.map((p) => `${p.x},${p.y}`)).size,
      node.ports.length,
      'Each dependency has its own endpoint'
    );
  assert.deepEqual(await layoutWorkflow(nodes, edges), routed, 'Layout is stable');
});

void test('visibility groups equivalent jobs without losing dependencies or hiding failures', async () => {
  const nodes = ['start', 'a', 'b', 'failed', 'cancelled', 'unknown', 'end'].map((id, i) => ({
    id,
    name: id,
    x: 0,
    y: 0,
    jobs:
      id === 'unknown'
        ? []
        : [
            job(
              i,
              id,
              id === 'failed'
                ? 'failure'
                : id === 'cancelled'
                  ? 'cancelled'
                  : id === 'a' || id === 'b'
                    ? 'skipped'
                    : 'success'
            ),
          ],
  }));
  const edges = [
    ['start', 'a'],
    ['start', 'b'],
    ['a', 'end'],
    ['b', 'end'],
    ['failed', 'end'],
  ].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
  const result = compactWorkflow(nodes, edges, { showSkipped: false, showCompleted: false });
  const skipped = result.nodes.find((n) => n.collapsed === 'skipped')!;
  assert.equal(skipped.jobs.length, 2);
  assert.equal(skipped.height, 48);
  assert.ok(result.nodes.find((n) => n.id === 'failed' && !n.collapsed));
  assert.ok(result.nodes.find((n) => n.id === 'cancelled' && !n.collapsed));
  assert.ok(result.nodes.find((n) => n.id === 'unknown' && !n.collapsed));
  assert.equal(result.edges.filter((e) => e.target === skipped.id).length, 1);
  assert.equal(result.edges.filter((e) => e.source === skipped.id).length, 1);
  assert.equal(result.nodes.flatMap((n) => n.jobs).length, nodes.flatMap((n) => n.jobs).length);
  const layout = await layoutWorkflow(result.nodes, result.edges);
  for (const node of layout.nodes)
    for (const port of node.ports)
      assert.ok(port.y > 0 && port.y < (result.nodes.find((n) => n.id === node.id)?.height ?? 112));
  assert.deepEqual(compactWorkflow(nodes, edges, {}), { nodes, edges });
});
void test('visibility does not merge different dependency paths or collapse mixed active groups', () => {
  const nodes = ['a', 'b', 'c', 'd', 'mixed', 'neutral'].map((id, i) => ({
    id,
    name: id,
    x: 0,
    y: 0,
    jobs: [job(i, id, id === 'neutral' ? 'neutral' : 'skipped')],
  }));
  nodes.find((n) => n.id === 'mixed')!.jobs.push({ ...job(10, 'running'), status: 'in_progress', conclusion: null });
  const edges = [
    ['a', 'b'],
    ['c', 'd'],
  ].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
  const result = compactWorkflow(nodes, edges, { showSkipped: false });
  assert.equal(result.nodes.filter((n) => n.collapsed).length, 4);
  assert.ok(result.nodes.find((n) => n.id === 'mixed' && !n.collapsed));
  assert.ok(result.nodes.find((n) => n.id === 'neutral' && !n.collapsed));
  assert.equal(
    compactWorkflow(nodes, edges, { showCompleted: false }).nodes.find((n) => n.collapsed)?.jobs[0].name,
    'neutral'
  );
});
void test('visibility toggles reuse saved run data and cached routing without GitHub requests', async () => {
  const h = harness();
  const full = await readWorkflowGraph(h.client, input);
  const count = h.calls.length;
  const collapsed = await readWorkflowGraph(h.client, { ...input, showCompleted: false }, { cachedOnly: true });
  assert.ok(collapsed?.nodes.some((n) => n.collapsed));
  assert.equal(h.calls.length, count);
  const restored = await readWorkflowGraph(h.client, input, { cachedOnly: true });
  assert.deepEqual(restored, full);
});

void test('skipped reusable workflow is reported once at its caller, without empty child placeholders', () => {
  const definitions = parseWorkflow(
    'jobs:\n  prepare: {}\n  service:\n    name: Service build\n    needs: prepare\n    uses: ./.github/workflows/service.yml\n  publish:\n    needs: service\n'
  );
  definitions[1].children = parseWorkflow(
    'jobs:\n  compile:\n    name: Compile\n  upload:\n    needs: compile\n    name: Upload\n'
  );
  const jobs = [job(1, 'prepare'), job(2, 'Service build', 'skipped'), job(3, 'publish')];
  for (const expanded of [[], ['service']]) {
    const graph = assembleWorkflow(definitions, jobs, expanded);
    assert.equal(graph.unmatched, 0);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.nodes.find((n) => n.id === 'service')?.jobs[0].conclusion, 'skipped');
    assert.ok(!graph.nodes.find((n) => n.id === 'service')?.expandable);
    assert.equal(graph.edges.length, 2);
  }
});

void test('parallel stages retain status and edges, expand deterministically, and never merge different needs', () => {
  const nodes = ['start', 'a', 'b', 'c', 'different', 'end'].map((id, i) => ({
    id,
    name: id,
    x: 0,
    y: 0,
    jobs: [job(i, id, 'success')],
  }));
  const edges = [
    ['start', 'a'],
    ['start', 'b'],
    ['start', 'c'],
    ['a', 'end'],
    ['b', 'end'],
    ['c', 'end'],
    ['different', 'end'],
  ].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
  const stage = stageWorkflow(nodes, edges, [], 'compact');
  assert.equal(stage.nodes.length, 4);
  const group = stage.nodes.find((n) => n.stage)!;
  assert.equal(group.stage?.count, 3);
  assert.equal(group.jobs.length, 3);
  assert.equal(stage.edges.length, 3);
  assert.ok(stage.nodes.some((n) => n.id === 'different'));
  const expanded = stageWorkflow(nodes, edges, [group.id], 'compact');
  assert.deepEqual(expanded.nodes, nodes);
  assert.deepEqual(expanded.edges, edges);
  assert.equal(
    stageWorkflow(
      nodes.map((n) => ({ ...n, jobs: n.jobs.map((j) => ({ ...j, conclusion: 'success' })) })),
      edges,
      [],
      'compact'
    ).groups[0].id,
    group.id
  );
  assert.equal(stageWorkflow(nodes, [], []).nodes.length, nodes.length);
});
void test('dependency focus includes ancestors and descendants without siblings, and protects focused jobs from collapse', () => {
  const nodes = ['root', 'a', 'b', 'end'].map((id, i) => ({ id, name: id, x: 0, y: 0, jobs: [job(i, id)] }));
  const edges = [
    ['root', 'a'],
    ['root', 'b'],
    ['a', 'end'],
    ['b', 'end'],
  ].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
  const focused = focusWorkflow(nodes, edges, 'a');
  assert.deepEqual(
    focused.nodes.map((n) => n.id),
    ['root', 'a', 'end']
  );
  assert.equal(focused.edges.length, 2);
  assert.equal(focused.focus?.name, 'a');
  assert.equal(focused.nodes.find((n) => n.id === 'end')?.outsidePrerequisites?.[0].name, 'b');
  assert.equal('outsidePrerequisites' in nodes[3], false, 'Focus must not mutate cached source nodes');
  const compact = compactWorkflow(focused.nodes, focused.edges, { showCompleted: false, focusNodeId: 'a' });
  assert.ok(compact.nodes.some((n) => n.id === 'a' && !n.collapsed));
  assert.ok(
    compact.nodes.some((n) => n.id === 'end' && n.outsidePrerequisites?.length && !n.collapsed),
    'A compact view retains external prerequisite context'
  );
  assert.deepEqual(focusWorkflow(nodes, edges, 'missing'), { nodes, edges });
});
void test('readable viewport never scales text down and anchors a large graph at its connected entry', () => {
  const graph = {
    nodes: [
      { id: 'entry', name: 'entry', jobs: [], x: 20, y: 2000 },
      { id: 'next', name: 'next', jobs: [], x: 330, y: 4000 },
    ],
    edges: [{ id: 'edge', source: 'entry', target: 'next' }],
  } as Parameters<typeof readableWorkflowViewport>[0];
  const viewport = readableWorkflowViewport(graph, 900, 500);
  assert.equal(viewport.zoom, 1);
  assert.ok(viewport.x + graph.nodes[0].x >= 0);
  assert.ok(viewport.y + graph.nodes[0].y >= 0 && viewport.y + graph.nodes[0].y + 112 <= 500);
  graph.focus = { id: 'next', name: 'next' };
  const focused = readableWorkflowViewport(graph, 900, 500);
  assert.ok(focused.y + graph.nodes[1].y >= 0 && focused.y + graph.nodes[1].y + 112 <= 500);
});
void test('a skipped caller with an ambiguous name still stays disconnected', () => {
  const defs = parseWorkflow(
    'jobs:\n  caller:\n    name: Same\n    uses: ./.github/workflows/child.yml\n  leaf:\n    name: Same\n'
  );
  defs[0].children = parseWorkflow('jobs:\n  child: {}\n');
  assert.equal(assembleWorkflow(defs, [job(1, 'Same', 'skipped')], []).unmatched, 1);
});

void test('expanded reusable matrix preserves skipped callers alongside executed children', () => {
  const defs = parseWorkflow(
    'jobs:\n  call:\n    name: Call (${{ matrix.os }})\n    uses: ./.github/workflows/child.yml\n    strategy:\n      matrix:\n        os: [a, b]\n'
  );
  defs[0].children = parseWorkflow('jobs:\n  child:\n    name: Child\n');
  for (const jobs of [
    [job(1, 'Call (a)', 'skipped'), job(2, 'Call (b) / Child')],
    [job(1, 'Call (a)', 'skipped'), job(2, 'Call (b)', 'skipped')],
  ]) {
    const graph = assembleWorkflow(defs, jobs, ['call']);
    assert.equal(graph.unmatched, 0);
    assert.deepEqual(graph.nodes.flatMap((n) => n.jobs.map((j) => j.id)).sort(), [1, 2]);
    assert.equal(graph.nodes.filter((n) => !n.jobs.length).length, 0);
  }
});
void test('unreported stage members cannot disappear through status compaction', () => {
  const nodes = ['a', 'b', 'c', 'end'].map((id, i) => ({
    id,
    name: id,
    x: 0,
    y: 0,
    jobs: id === 'b' ? [] : [job(i, id)],
  }));
  const edges = ['a', 'b', 'c'].map((source) => ({ id: source, source, target: 'end' }));
  const stage = stageWorkflow(nodes, edges, []);
  const compact = compactWorkflow(stage.nodes, stage.edges, { showCompleted: false, showSkipped: false });
  assert.ok(compact.nodes.some((n) => n.id === 'b' && !n.collapsed));
});

void test('focus keeps upstream jobs visible on axes that fit, even when another axis overflows', () => {
  const graph: Parameters<typeof readableWorkflowViewport>[0] = {
    nodes: [
      { id: 'root', name: 'root', jobs: [], x: 12, y: 12 },
      { id: 'focus', name: 'focus', jobs: [], x: 330, y: 300 },
      { id: 'end', name: 'end', jobs: [], x: 640, y: 500 },
    ],
    edges: [],
    focus: { id: 'focus', name: 'focus' },
  };
  const view = readableWorkflowViewport(graph, 1280, 250);
  assert.ok(view.x + graph.nodes[0].x >= 0);
  assert.ok(view.x + graph.nodes[2].x + 244 <= 1280);
  assert.equal(view.zoom, 1);
});

void test('repeated reusable calls count distinct files, reuse parses, and isolate caller inputs', async () => {
  const h = harness();
  h.files({
    '.github/workflows/ci.yml':
      'jobs:\n' +
      Array.from(
        { length: 30 },
        (_, i) => `  call${i}:\n    uses: ./.github/workflows/child.yml\n    with:\n      label: Job${i}\n`
      ).join(''),
    '.github/workflows/child.yml': 'jobs:\n  work:\n    name: ${{ inputs.label }}\n',
  });
  const graph = await readWorkflowGraph(h.client, input);
  assert.ok(graph);
  assert.ok(!graph.warnings.some((w) => /limit|nesting|distinct/.test(w)), graph.warnings.join('\n'));
  assert.equal(h.calls.filter((c) => c.includes('/contents/')).length, 2);
  const expanded = await readWorkflowGraph(h.client, { ...input, expanded: ['call0', 'call29'] }, { cachedOnly: true });
  assert.ok(expanded?.nodes.some((n) => n.name === 'Job0'));
  assert.ok(expanded?.nodes.some((n) => n.name === 'Job29'));
  const parsed = githubCacheFor(h.client)!.values(
    (v): v is { value: unknown[] } => !!v && typeof v === 'object' && 'value' in v && Array.isArray(v.value)
  );
  assert.ok(parsed.length >= 2);
  assert.ok(
    parsed.every((p) => p.value.every((n) => !n || typeof n !== 'object' || !('children' in n))),
    'Resolution must not mutate cached parses'
  );
  const before = h.calls.length;
  await readWorkflowGraph(h.client, input, { force: true });
  assert.equal(h.calls.slice(before).filter((c) => c.includes('/contents/')).length, 0);
});
void test('permanent definition warnings do not refetch completed jobs while transient failures recover', async () => {
  const h = harness();
  h.files({ '.github/workflows/ci.yml': 'jobs:\n  call:\n    uses: ./.github/workflows/ci.yml\n' });
  const first = await readWorkflowGraph(h.client, input);
  assert.ok(first?.warnings.some((w) => w.includes('cycle')));
  const now = Date.now;
  try {
    Date.now = () => now() + 30_000;
    await readWorkflowGraph(h.client, input);
    assert.equal(h.calls.filter((c) => c.includes('/jobs')).length, 1);
  } finally {
    Date.now = now;
  }
  const transient = harness();
  transient.fail();
  assert.ok((await readWorkflowGraph(transient.client, input))?.warnings.length);
  transient.recover();
  try {
    Date.now = () => now() + 30_000;
    assert.equal((await readWorkflowGraph(transient.client, input))?.warnings.length, 0);
  } finally {
    Date.now = now;
  }
});
void test('oversized workflow data survives restart in the configurable disk cache', async () => {
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-workflow-large-'));
  const first = harness(),
    second = harness();
  first.stepText('step'.repeat(90_000));
  try {
    await first.pool.setStorage(path.join(dir, 'budget.json'));
    const before = await readWorkflowGraph(first.client, input);
    await first.pool.closeStorage();
    await second.pool.setStorage(path.join(dir, 'budget.json'));
    assert.deepEqual(await readWorkflowGraph(second.client, input, { cachedOnly: true }), before);
    assert.equal(second.calls.length, 0);
  } finally {
    await first.pool.closeStorage();
    await second.pool.closeStorage();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('distinct-file limit does not block reuse of an already resolved source', async () => {
  const h = harness();
  const files: Record<string, string> = {
    '.github/workflows/ci.yml':
      'jobs:\n' +
      Array.from({ length: 50 }, (_, i) => `  call${i}:\n    uses: ./.github/workflows/child${i}.yml\n`).join('') +
      '  again:\n    uses: ./.github/workflows/child0.yml\n',
  };
  for (let i = 0; i < 50; i++) files[`.github/workflows/child${i}.yml`] = 'jobs:\n  leaf: {}\n';
  h.files(files);
  const graph = await readWorkflowGraph(h.client, input);
  assert.equal(graph?.warnings.filter((w) => w.includes('distinct source files')).length, 1);
  assert.ok(!graph?.warnings.some((w) => w.startsWith('again:')));
  assert.equal(h.calls.filter((c) => c.includes('/contents/')).length, 50);
});
void test('resolved definitions honor changed reusable-workflow pins at the same caller revision', async () => {
  const h = harness(),
    reference = 'external/shared/.github/workflows/reuse.yml@main';
  const files = {
    '.github/workflows/ci.yml': `jobs:\n  call:\n    uses: ${reference}\n`,
    '.github/workflows/reuse.yml': 'jobs:\n  leaf:\n    name: First\n',
  };
  h.files(files);
  h.run.referenced_workflows = [{ path: reference, sha: 'b'.repeat(40) }];
  assert.ok(
    (await readWorkflowGraph(h.client, { ...input, expanded: ['call'] }))?.nodes.some((n) => n.name === 'First')
  );
  h.run.referenced_workflows = [{ path: reference, sha: 'c'.repeat(40) }];
  h.files({ ...files, '.github/workflows/reuse.yml': 'jobs:\n  leaf:\n    name: Second\n' });
  assert.ok(
    (await readWorkflowGraph(h.client, { ...input, expanded: ['call'] }, { force: true }))?.nodes.some(
      (n) => n.name === 'Second'
    )
  );
});

void test('interactive graph loads jobs and independent reusable sources concurrently', { timeout: 5000 }, async () => {
  let releaseJobs!: () => void, releaseLeft!: () => void;
  const jobsGate = new Promise<void>((r) => {
    releaseJobs = r;
  });
  const leftGate = new Promise<void>((r) => {
    releaseLeft = r;
  });
  let jobsStarted = false,
    leftStarted = false,
    jobsFinished = false,
    leftFinished = false;
  let jobsOverlap = false,
    sourcesOverlap = false;
  const timeout = setTimeout(() => {
    releaseJobs();
    releaseLeft();
  }, 500);
  const h = harness(async (url) => {
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith('/jobs')) {
      jobsStarted = true;
      await jobsGate;
      jobsFinished = true;
    }
    if (path.endsWith('/ci.yml')) {
      jobsOverlap = jobsStarted && !jobsFinished;
      releaseJobs();
    }
    if (path.endsWith('/left.yml')) {
      leftStarted = true;
      await leftGate;
      leftFinished = true;
    }
    if (path.endsWith('/right.yml')) {
      sourcesOverlap = leftStarted && !leftFinished;
      releaseLeft();
    }
  });
  h.source('jobs:\n  left:\n    uses: ./.github/workflows/left.yml\n  right:\n    uses: ./.github/workflows/right.yml');
  h.files({
    '.github/workflows/left.yml': 'jobs:\n  build:\n    name: Build',
    '.github/workflows/right.yml': 'jobs:\n  deploy:\n    name: Deploy',
  });
  const graph = await withGitHubPriority('interactive', () => readWorkflowGraph(h.client, input)).finally(() =>
    clearTimeout(timeout)
  );
  assert.ok(graph);
  assert.ok(!graph.warnings.some((warning) => warning.includes('unavailable')));
  assert.ok(jobsOverlap, 'Jobs and root definition must overlap at the HTTP layer');
  assert.ok(sourcesOverlap, 'Independent reusable sources must overlap at the HTTP layer');
});

void test('graph warming replaces obsolete targets, stops on leaving Checks, and respects backoff', async () => {
  let allowed = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started: string[] = [],
    prepared: string[] = [];
  const warm = createWorkflowGraphPreloader({
    canRun: () => allowed,
    prepare: async (target, stillWanted) => {
      started.push(target.url);
      if (target.url === 'first') await gate;
      if (!stillWanted()) return false;
      prepared.push(target.url);
      return true;
    },
  });
  warm.setTarget({ url: 'first', headSha: sha });
  await warm.tick();
  assert.deepEqual(started, []);
  allowed = true;
  const first = warm.tick();
  warm.setTarget({ url: 'obsolete', headSha: sha });
  warm.setTarget({ url: 'latest', headSha: sha });
  await warm.tick();
  release();
  await first;
  await warm.tick();
  await warm.tick();
  assert.deepEqual(started, ['first', 'latest']);
  assert.deepEqual(prepared, ['latest']);
  warm.setTarget({ url: 'cancelled', headSha: sha });
  warm.setTarget(undefined);
  await warm.tick();
  assert.deepEqual(started, ['first', 'latest']);
});

void test('adaptive grouping reduces only large crowded fans and respects manual expansion', () => {
  const names = [
    'root',
    'end-a',
    'end-b',
    ...Array.from({ length: 10 }, (_, i) => `a${i}`),
    ...Array.from({ length: 6 }, (_, i) => `b${i}`),
  ];
  const nodes = names.map((id, i) => ({ id, name: id, x: 0, y: 0, jobs: [job(i, id)] }));
  const edges = names
    .filter((id) => /^[ab]\d/.test(id))
    .flatMap((id) => [
      { id: `root-${id}`, source: 'root', target: id },
      { id: `${id}-end`, source: id, target: id.startsWith('a') ? 'end-a' : 'end-b' },
    ]);
  const result = stageWorkflow(nodes, edges, []);
  assert.equal(result.nodes.length, 10);
  assert.equal(result.groups.length, 1, 'Stop after reducing the crowded graph');
  assert.equal(result.nodes.find((n) => n.stage)?.stage?.count, 10);
  const expanded = stageWorkflow(nodes, edges, [result.groups[0].id]);
  assert.equal(expanded.nodes.length, nodes.length, 'Expansion must not collapse another fan');
  assert.deepEqual(expanded.groups, result.groups);
  assert.equal(stageWorkflow(nodes, edges, [], 'compact').groups.length, 2);
  assert.deepEqual(stageWorkflow(nodes, edges, [], 'off'), { nodes, edges, groups: [] });
  const small = nodes.filter((n) => !n.id.startsWith('a'));
  assert.equal(
    stageWorkflow(
      small,
      edges.filter((e) => !e.target.startsWith('a') && !e.source.startsWith('a')),
      []
    ).groups.length,
    0
  );
});

void test('parallel grouping never hides active, failing, cancelled, mixed, or unknown jobs', () => {
  const nodes = ['a', 'b', 'c', 'failed', 'cancelled', 'running', 'unknown', 'mixed', 'end'].map((id, i) => ({
    id,
    name: id,
    x: 0,
    y: 0,
    jobs:
      id === 'unknown'
        ? []
        : id === 'mixed'
          ? [job(i, id), job(100, id, 'failure')]
          : [
              {
                ...job(i, id, id === 'failed' ? 'failure' : id === 'cancelled' ? 'cancelled' : 'success'),
                status: id === 'running' ? 'in_progress' : 'completed',
              },
            ],
  }));
  const edges = nodes.filter((n) => n.id !== 'end').map((n) => ({ id: n.id, source: n.id, target: 'end' }));
  const result = stageWorkflow(nodes, edges, [], 'compact');
  assert.equal(result.groups.length, 1);
  assert.equal(result.nodes.find((n) => n.stage)?.stage?.count, 3);
  for (const id of ['failed', 'cancelled', 'running', 'unknown', 'mixed'])
    assert.ok(result.nodes.some((n) => n.id === id));
});

void test('grouping modes project cached workflow data without additional GitHub requests', async () => {
  const h = harness();
  h.source(
    'jobs:\n  a:\n    name: Build\n  b:\n    name: Test Linux\n  c:\n    name: Test macOS\n  end:\n    name: Deploy\n    needs: [a,b,c]'
  );
  const initial = await readWorkflowGraph(h.client, input);
  assert.equal(initial?.nodes.length, 4);
  const requests = h.calls.length;
  const compact = await readWorkflowGraph(h.client, { ...input, grouping: 'compact' }, { cachedOnly: true });
  assert.equal(compact?.nodes.length, 2);
  assert.equal(
    (await readWorkflowGraph(h.client, { ...input, grouping: 'off' }, { cachedOnly: true }))?.nodes.length,
    4
  );
  assert.equal(h.calls.length, requests);
});

void test('attention navigation includes failures inside groups, deduplicates jobs, and cycles through issues', () => {
  const failing = job(1, 'Type check', 'failure'),
    cancelled = job(2, 'Tests', 'cancelled');
  const nodes = [
    { id: 'matrix', name: 'Matrix', x: 0, y: 0, jobs: [failing, job(3, 'Passing'), cancelled] },
    { id: 'duplicate', name: 'Duplicate', x: 0, y: 0, jobs: [failing] },
  ];
  const issues = attentionJobs(nodes);
  assert.deepEqual(
    issues.map((item) => item.job.id),
    [1, 2]
  );
  assert.equal(nextAttentionJob(issues)?.job.id, 1);
  assert.equal(nextAttentionJob(issues, 'check:1')?.job.id, 2);
  assert.equal(nextAttentionJob(issues, 'check:2')?.job.id, 1);
  assert.equal(nextAttentionJob(issues, 'check:1', -1)?.job.id, 2);
  assert.equal(nextAttentionJob(issues, 'missing', -1)?.job.id, 2);
  assert.equal(nextAttentionJob([], undefined, -1), undefined);
  assert.equal(nextAttentionJob([]), undefined);
});
void test('workflow selection prioritizes reported failure, then running, without inventing job counts', () => {
  const base = {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    sha,
    attempt: 2,
    status: 'completed',
    conclusion: 'success',
    url: '',
  };
  const failure = { ...base, id: 2, conclusion: 'failure' };
  const running = { ...base, id: 3, status: 'in_progress', conclusion: null };
  assert.equal(preferredWorkflow([base, running, failure])?.id, 2);
  assert.equal(preferredWorkflow([base, running])?.id, 3);
  assert.equal(preferredWorkflow([]), undefined);
  assert.equal(workflowRunLabel(failure), 'CI · Failed · Attempt 2');
});
void test('graph exploration memory is scoped by account and revision', () => {
  const state = workflowSession('alice:pr1:head1');
  state.expanded = ['matrix'];
  state.runId = 9;
  state.viewport = { x: 12, y: 23, zoom: 0.8 };
  assert.deepEqual(workflowSession('alice:pr1:head1').expanded, ['matrix']);
  assert.deepEqual(workflowSession('bob:pr1:head1').expanded, []);
  assert.deepEqual(workflowSession('alice:pr1:head2').expanded, []);
});
void test('workflow counts distinguish reported jobs, exact totals, and unknown reruns', () => {
  const run = {
    id: 9,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    sha,
    attempt: 1,
    status: 'in_progress',
    conclusion: null,
    url: 'https://github.com/o/r/actions/runs/9',
  };
  const snapshot: PrChecks = {
    ...target,
    checkedAt: Date.now(),
    checks: [
      {
        id: 'check:1',
        databaseId: 1,
        kind: 'check',
        provider: 'GitHub Actions',
        required: null,
        name: 'Build',
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
        url: `${run.url}/job/1`,
      },
    ],
  };
  assert.deepEqual(workflowJobCount(run, snapshot), { count: 1, exact: false });
  assert.deepEqual(workflowJobCount({ ...run, jobCount: 7 }, snapshot), { count: 7, exact: true });
  assert.deepEqual(workflowJobCount({ ...run, jobCount: 0 }, snapshot), { count: 1, exact: false });
  assert.equal(workflowJobCount({ ...run, attempt: 2 }, snapshot), undefined);
  assert.equal(workflowJobCount({ ...run, id: 90, url: run.url + '0' }, snapshot), undefined);
  assert.equal(workflowJobCount(run, { ...snapshot, headSha: 'b'.repeat(40) }), undefined);
  snapshot.details = {
    'check:1': {
      ...target,
      id: 'check:1',
      title: '',
      summary: '',
      text: '',
      annotations: [],
      job: { id: 1, runId: 9, attempt: 2, status: 'in_progress', canRerun: false, steps: [] },
    },
  };
  assert.deepEqual(workflowJobCount({ ...run, attempt: 2 }, snapshot), { count: 1, exact: false });
});

void test('graph failure insights use failure annotations only and reject other attempts', () => {
  const run = {
    id: 9,
    attempt: 2,
    sha: 'a'.repeat(40),
    name: 'CI',
    path: 'ci.yml',
    status: 'completed',
    conclusion: 'failure',
    url: '',
  };
  const failed = job(1, 'Native Bundle / trim-ios', 'cancelled');
  const annotation = {
    path: '.github',
    startLine: 1,
    endLine: 1,
    level: 'failure',
    title: 'failure',
    message: 'The job was not acquired by a runner after multiple attempts.',
  };
  const detail = {
    url: 'https://github.com/o/r/pull/1',
    headSha: run.sha,
    id: 'check:1',
    title: '',
    summary: '',
    text: '',
    annotations: [{ ...annotation, level: 'notice' }, annotation, annotation],
    job: { id: 1, runId: 9, attempt: 2, status: 'completed', canRerun: true, steps: [] },
  };
  assert.equal(workflowJobDetails(failed, run, detail), detail);
  assert.equal(workflowJobDetails(failed, { ...run, attempt: 3 }, detail), undefined);
  assert.equal(workflowJobDetails(failed, { ...run, sha: 'b'.repeat(40) }, detail), undefined);
  assert.equal(workflowJobDetails({ ...failed, id: 2 }, run, detail), undefined);
  assert.deepEqual(workflowFailureInsight(failed, detail), {
    annotation,
    annotations: [annotation],
    count: 1,
    step: undefined,
  });
  assert.equal(workflowFailureInsight(job(1, 'Passed'), detail), undefined);
  assert.equal(
    workflowFailureInsight(failed, {
      ...detail,
      job: {
        ...detail.job,
        steps: [{ name: 'Build native bundle', number: 1, status: 'completed', conclusion: 'failure' }],
      },
    })?.step,
    'Build native bundle'
  );
});

void test('expanding inline annotations reroutes cached graph without GitHub requests', async () => {
  const h = harness();
  h.failJob();
  const initial = await readWorkflowGraph(h.client, input);
  const count = h.calls.length;
  const id = 'test/job:2';
  assert.equal(initial?.nodes.find((n) => n.id === id)?.height, 232);
  const expanded = await readWorkflowGraph(h.client, { ...input, expandedAnnotations: [id] }, { cachedOnly: true });
  assert.equal(expanded?.nodes.find((n) => n.id === id)?.height, 440);
  assert.equal(expanded?.nodes.find((n) => n.id === id)?.annotationsExpanded, true);
  assert.ok(expanded?.edges.every((edge) => edge.points?.length));
  const collapsed = await readWorkflowGraph(h.client, input, { cachedOnly: true });
  assert.equal(collapsed?.nodes.find((n) => n.id === id)?.height, 232);
  assert.equal(h.calls.length, count);
});

void test('fan-in port ordering avoids crossed final dependencies regardless of edge declaration order', async () => {
  const nodes = ['check', 'detect', 'parallel', 'stage', 'trim', 'publish', 'result'].map((id) => ({
    id,
    height: id === 'result' ? 232 : 112,
  }));
  const edges = [
    ['check', 'detect'],
    ['detect', 'parallel'],
    ['detect', 'stage'],
    ['stage', 'trim'],
    ['trim', 'publish'],
    ['parallel', 'result'],
    ['publish', 'result'],
    ['check', 'result'],
    ['detect', 'result'],
  ].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
  type Point = { x: number; y: number };
  const crosses = (a: Point, b: Point, c: Point, d: Point) =>
    a.x === b.x &&
    c.y === d.y &&
    a.x > Math.min(c.x, d.x) &&
    a.x < Math.max(c.x, d.x) &&
    c.y > Math.min(a.y, b.y) &&
    c.y < Math.max(a.y, b.y);
  for (const input of [edges, [...edges].reverse()]) {
    const result = await layoutWorkflow(nodes, input);
    for (let i = 0; i < result.edges.length; i++)
      for (let j = i + 1; j < result.edges.length; j++) {
        const left = result.edges[i],
          right = result.edges[j];
        for (let a = 1; a < left.points.length; a++)
          for (let b = 1; b < right.points.length; b++)
            assert.ok(
              !crosses(left.points[a - 1], left.points[a], right.points[b - 1], right.points[b]) &&
                !crosses(right.points[b - 1], right.points[b], left.points[a - 1], left.points[a]),
              `${left.id} crosses ${right.id}`
            );
      }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'Coordinates survive persisted cache without drift');
    assert.deepEqual(await layoutWorkflow(nodes, input), result, 'Ordering remains deterministic');
  }
});
