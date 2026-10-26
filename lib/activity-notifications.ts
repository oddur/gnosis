import type { ActivityTask } from './activity';

/** Ignore historical results on startup; include jobs that finish between polls. */
export function createActivityCompletionTracker() {
  let initialized = false;
  const announced = new Map<string, string>();
  return (tasks: ActivityTask[]): ActivityTask[] => {
    const completed = tasks.filter((task) =>
      task.kind === 'pr-action'
        ? task.status === 'completed' || task.status === 'failed'
        : task.status === 'completed' && (task.kind === 'review' || task.kind === 'exploration') && !!task.reviewId
    );
    const fresh = initialized ? completed.filter((task) => announced.get(task.id) !== task.updatedAt) : [];
    for (const task of completed) announced.set(task.id, task.updatedAt);
    initialized = true;
    return fresh;
  };
}
