import type { ActivityTask } from './activity';

/**
 * The title bar shows Activity as a small capsule only while it has something to say: work is
 * running, or a failure or result has not been seen yet. Routine background work (preparing PRs
 * for instant opening, refreshing GitHub information) never brings it up on its own, and seeing
 * a result, by opening Activity, quiets it.
 */
export interface ActivityCapsule {
  visible: boolean;
  /** Running or paused work the person started or is waiting for. */
  running: number;
  /** Work waiting for its turn. */
  queued: number;
  unseenFailed: number;
  unseenReady: number;
  /** Failures already seen, shown muted beside running work. */
  seenFailed: number;
  tone: 'running' | 'failed' | 'ready' | 'idle';
  label: string;
}

/** A task's identity at its latest state, so a retried task that fails again is new. */
export const seenKey = (task: Pick<ActivityTask, 'id' | 'updatedAt'>) => `${task.id}@${task.updatedAt}`;

const quiet = (task: ActivityTask) => task.kind === 'preload' || task.kind === 'github';
const running = (task: ActivityTask) => task.status === 'running' || task.status === 'paused';
const unfinished = (task: ActivityTask) => running(task) || task.status === 'queued';
/** Results someone waits for. A GitHub refresh finishing is not news. */
const result = (task: ActivityTask) => task.status === 'completed' && !quiet(task);

export function activityCapsule(tasks: readonly ActivityTask[], seen: ReadonlySet<string>): ActivityCapsule {
  const active = tasks.filter((task) => running(task) && !quiet(task)).length;
  const queued = tasks.filter((task) => task.status === 'queued' && !quiet(task)).length;
  const failed = tasks.filter((task) => task.status === 'failed');
  const unseenFailed = failed.filter((task) => !seen.has(seenKey(task))).length;
  const unseenReady = tasks.filter((task) => result(task) && !seen.has(seenKey(task))).length;
  const seenFailed = failed.length - unseenFailed;
  const visible = active > 0 || queued > 0 || unseenFailed > 0 || unseenReady > 0;
  const tone = !visible ? 'idle' : active || queued ? 'running' : unseenFailed ? 'failed' : 'ready';
  const label = [
    active && `${active} running`,
    queued && `${queued} queued`,
    unseenFailed && `${unseenFailed} failed`,
    unseenReady && `${unseenReady} ready`,
  ]
    .filter(Boolean)
    .join(' · ');
  return { visible, running: active, queued, unseenFailed, unseenReady, seenFailed, tone, label };
}

/** Everything finished in the list, as seen keys; called when Activity is open. */
export function seenKeys(tasks: readonly ActivityTask[]) {
  return tasks.filter((task) => !unfinished(task)).map(seenKey);
}
