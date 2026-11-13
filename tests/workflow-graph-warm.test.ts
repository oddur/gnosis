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
