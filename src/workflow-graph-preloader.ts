import type { CheckTarget } from '../lib/pr-checks';

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
