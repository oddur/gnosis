import { ACTIVITY_RETENTION_MS, isActiveTask, type ActivityAction, type ActivityTask } from '../lib/activity';

interface Actions {
  cancel?: () => void;
  retry?: () => Promise<unknown>;
}
export function createActivityService(now = () => Date.now(), changed: () => void = () => {}) {
  const tasks = new Map<string, { task: ActivityTask; actions: Actions }>();
  const stamp = () => new Date(now()).toISOString();
  return {
    start(task: Omit<ActivityTask, 'status' | 'updatedAt' | 'canCancel' | 'canRetry'>, actions: Actions) {
      changed();
      tasks.set(task.id, {
        task: { ...task, status: 'running', updatedAt: stamp(), canCancel: !!actions.cancel, canRetry: false },
        actions,
      });
    },
    update(id: string, detail: string, progress?: ActivityTask['progress']) {
      changed();
      const entry = tasks.get(id);
      if (entry?.task.status === 'running') Object.assign(entry.task, { detail, progress, updatedAt: stamp() });
    },
    finish(id: string, status: 'completed' | 'failed' | 'cancelled', detail: string, warnings?: string[]) {
      changed();
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
    pause(id: string, detail: string) {
      changed();
      const entry = tasks.get(id);
      if (entry)
        Object.assign(entry.task, {
          status: 'paused',
          detail,
          progress: undefined,
          updatedAt: stamp(),
          canCancel: false,
          canRetry: false,
        });
    },
    /** An automatic retry keeps completed work and the user's cancel action. */
    wait(id: string, detail: string) {
      changed();
      const entry = tasks.get(id);
      if (entry && isActiveTask(entry.task))
        Object.assign(entry.task, { status: 'paused', detail, updatedAt: stamp(), canCancel: !!entry.actions.cancel });
    },
    resume(id: string) {
      changed();
      const entry = tasks.get(id);
      if (entry?.task.status === 'paused')
        Object.assign(entry.task, { status: 'running', updatedAt: stamp(), canCancel: !!entry.actions.cancel });
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
      changed();
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
