import test from 'node:test';
import assert from 'node:assert/strict';
import { warmWorkflowGraph } from '../src/workflow-graph-preloader';
import type { WorkflowRunInfo } from '../lib/workflow-graph';

const run = (id: number, status: string, conclusion: string | null) => ({ id, status, conclusion }) as unknown as WorkflowRunInfo;

void test('the graph is warmed for the run the Checks graph opens on: failed, then running, then the newest', async () => {
  const target = { url: 'https://github.com/o/r/pull/1', headSha: 'a'.repeat(40) };
  const warmed = async (runs: WorkflowRunInfo[]) => {
    const graphs: number[] = [];
    await warmWorkflowGraph(target, { runs: () => Promise.resolve({ runs }), graph: (input) => { graphs.push(input.runId); return Promise.resolve(); } });
    return graphs;
  };
  assert.deepEqual(await warmed([run(1, 'completed', 'success'), run(2, 'completed', 'failure')]), [2]);
  assert.deepEqual(await warmed([run(1, 'completed', 'success'), run(3, 'in_progress', null)]), [3]);
  assert.deepEqual(await warmed([run(1, 'completed', 'success'), run(4, 'completed', 'success')]), [1]);
  assert.deepEqual(await warmed([]), []);
  const graphs: number[] = [];
  assert.equal(await warmWorkflowGraph(target, { runs: () => Promise.resolve({ runs: [run(5, 'completed', 'failure')] }),
    graph: (input) => { graphs.push(input.runId); return Promise.resolve(); } }, () => false), false);
  assert.deepEqual(graphs, [], 'A target that is no longer wanted reads no graph');
});

void test('Eager reads the failing job logs of the run the graph opens on, after its graph', async () => {
  const target = { url: 'https://github.com/o/r/pull/1', headSha: 'a'.repeat(40) };
  const order: string[] = [];
  await warmWorkflowGraph(target, {
    runs: () => Promise.resolve({ runs: [run(1, 'completed', 'success'), run(2, 'completed', 'failure')] }),
    graph: (input) => { order.push(`graph ${input.runId}`); return Promise.resolve(); },
    logs: (_target, preferred) => { order.push(`logs ${preferred.id}`); return Promise.resolve(); },
  });
  assert.deepEqual(order, ['graph 2', 'logs 2']);
  order.length = 0;
  let wanted = true;
  await warmWorkflowGraph(target, {
    runs: () => Promise.resolve({ runs: [run(3, 'completed', 'failure')] }),
    graph: () => { order.push('graph'); wanted = false; return Promise.resolve(); },
    logs: () => { order.push('logs'); return Promise.resolve(); },
  }, () => wanted);
  assert.deepEqual(order, ['graph'], 'No logs once the PR is no longer wanted');
});
