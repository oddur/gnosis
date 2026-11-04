import { layoutWorkflow } from '../src/workflow-layout';
import { workflowEdgePath } from '../lib/workflow-edge-path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, assembleWorkflow } from '../src/workflow-definition';
import { readWorkflowGraph, readWorkflowRuns } from '../src/workflow-graph-service';
import { createGitHubClientPool, githubCacheFor } from './cache-test-pool';
import type { WorkflowJob } from '../lib/workflow-graph';

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
function harness() {
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
  let workflow = source,
    failSource = false,
    pause: Promise<void> | undefined;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (address: string) => {
      calls.push(address);
      if (pause) await pause;
      const url = new URL(address);
      let data: unknown;
      let status = 200;
      if (url.pathname.endsWith('/actions/runs')) data = { total_count: 1, workflow_runs: [run] };
      else if (url.pathname.endsWith('/actions/runs/9')) data = run;
      else if (url.pathname.endsWith('/jobs'))
        data = {
          total_count: 4,
          jobs: [job(1, 'Build'), job(2, 'Test Linux'), job(3, 'Test macOS'), job(4, 'Deploy')].map((j) => ({
            ...j,
            check_run_url: `https://api.github.com/repos/o/r/check-runs/${j.id}`,
            started_at: j.startedAt,
            completed_at: j.completedAt,
            html_url: '',
          })),
        };
      else if (url.pathname.includes('/contents/')) {
        if (failSource) {
          status = 404;
          data = { message: 'Not found' };
        } else
          data = {
            type: 'file',
            size: workflow.length,
            encoding: 'base64',
            content: Buffer.from(workflow).toString('base64'),
          };
      } else throw Error(address);
      const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: address });
      return response;
    }) as typeof fetch,
  });
  return {
    client: pool.client('account'),
    other: pool.client('another-account'),
    calls,
    run,
    pool,
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
