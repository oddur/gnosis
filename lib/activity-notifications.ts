import type { ActivityTask } from './activity';

/** Ignore historical results on startup; include jobs that finish between polls. */
export function createActivityCompletionTracker() {
  let initialized = false;
  const announced = new Map<string, string>();
  return (tasks: ActivityTask[], activeConflict?: { url?: string; id?: string }): ActivityTask[] => {
    const completed = tasks.filter((task) =>
      task.kind === 'pr-action'
        ? task.status === 'completed' || task.status === 'failed'
        : task.status === 'completed' && (task.kind === 'review' || task.kind === 'exploration') && !!task.reviewId
    );
    const fresh = initialized ? completed.filter((task) => announced.get(task.id) !== task.updatedAt) : [];
    for (const task of completed) announced.set(task.id, task.updatedAt);
    initialized = true;
    // The active workspace already shows both success and failure inline.
    return fresh.filter(
      (task) =>
        !task.conflictTarget ||
        !activeConflict ||
        (task.conflictTarget !== activeConflict.url && task.conflictTarget !== activeConflict.id)
    );
  };
}
