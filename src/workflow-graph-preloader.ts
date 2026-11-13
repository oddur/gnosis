import type { CheckTarget } from '../lib/pr-checks';
import type { WorkflowRunInfo } from '../lib/workflow-graph';
import { preferredWorkflow } from '../lib/workflow-navigation';

/** Warm only the open Checks workspace. Selection changes replace queued work. */
export function createWorkflowGraphPreloader(deps: {
  canRun: () => boolean;
  prepare: (target: CheckTarget, stillWanted: () => boolean) => Promise<boolean>;
  now?: () => number;
}) {
  let target: CheckTarget | undefined;
  let epoch = 0;
  let running = false;
  let done = false;
  let retryAt = 0;
  const now = deps.now ?? Date.now;
  return {
    setTarget(next?: CheckTarget) {
      if (target?.url === next?.url && target?.headSha === next?.headSha) return;
      target = next;
      epoch++;
      done = false;
      retryAt = 0;
    },
    async tick() {
      if (running || !target || done || now() < retryAt || !deps.canRun()) return;
      running = true;
      const generation = epoch;
      try {
        const prepared = await deps.prepare(target, () => generation === epoch && deps.canRun());
        if (generation === epoch) done = prepared;
      } catch {
        if (generation === epoch) retryAt = now() + 60_000;
      } finally {
        running = false;
      }
    },
  };
}

/**
 * Prepares the graph the Checks graph view opens on: the preferred run of the PR's runs (failed first, then running,
 * as `WorkflowGraphView` chooses), not simply the newest. Returns false when `stillWanted` turned false.
 */
export async function warmWorkflowGraph(
  target: CheckTarget,
  reads: {
    runs: (target: CheckTarget) => Promise<{ runs: WorkflowRunInfo[] } | undefined>;
    graph: (input: CheckTarget & { runId: number }) => Promise<unknown>;
  },
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  const runs = await reads.runs(target);
  if (!stillWanted()) return false;
  const run = runs && preferredWorkflow(runs.runs);
  if (run) await reads.graph({ ...target, runId: run.id });
  return true;
}
