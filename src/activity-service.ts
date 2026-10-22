import { ACTIVITY_RETENTION_MS, isActiveTask, type ActivityAction, type ActivityTask } from '../lib/activity';

interface Actions {
  cancel?: () => void;
  retry?: () => Promise<unknown>;
}
export function createActivityService(now = () => Date.now()) {
  const tasks = new Map<string, { task: ActivityTask; actions: Actions }>();
  const stamp = () => new Date(now()).toISOString();
  return {
    start(task: Omit<ActivityTask, 'status' | 'updatedAt' | 'canCancel' | 'canRetry'>, actions: Actions) {
      tasks.set(task.id, {
        task: { ...task, status: 'running', updatedAt: stamp(), canCancel: !!actions.cancel, canRetry: false },
        actions,
      });
    },
    update(id: string, detail: string, progress?: ActivityTask['progress']) {
      const entry = tasks.get(id);
      if (entry?.task.status === 'running') Object.assign(entry.task, { detail, progress, updatedAt: stamp() });
    },
    finish(id: string, status: 'completed' | 'failed' | 'cancelled', detail: string, warnings?: string[]) {
      const entry = tasks.get(id);
      if (entry)
        Object.assign(entry.task, {
          status,
          detail,
          warnings,
          progress: undefined,
          updatedAt: stamp(),
          canCancel: false,
          canRetry: (status !== 'completed' || !!warnings?.length) && !!entry.actions.retry,
        });
    },
    list(): ActivityTask[] {
      for (const [id, { task }] of tasks)
        if (
          (task.status === 'completed' || task.status === 'cancelled') &&
          now() - Date.parse(task.updatedAt) > ACTIVITY_RETENTION_MS
        )
          tasks.delete(id);
      return [...tasks.values()].map(({ task }) => ({ ...task }));
    },
    async act(id: string, action: ActivityAction) {
      const entry = tasks.get(id);
      if (!entry) throw new Error('This task is no longer available.');
      if (action === 'dismiss' && !isActiveTask(entry.task)) {
        tasks.delete(id);
        return;
      }
      if (action === 'cancel' && entry.task.canCancel) {
        entry.actions.cancel?.();
        return;
      }
      if (action === 'retry' && entry.task.canRetry && entry.actions.retry) {
        entry.task.canRetry = false;
        try {
          await entry.actions.retry();
          if (tasks.get(id) === entry) tasks.delete(id);
        } catch (error) {
          entry.task.canRetry = true;
          throw error;
        }
        return;
      }
      throw new Error('This action is no longer available for this task.');
    },
  };
}
export type ActivityService = ReturnType<typeof createActivityService>;
