export type ActivityStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ActivityStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/** One stage of a task, such as "Write topics", with optional subtasks such as each topic. */
export interface ActivityStep {
  id: string;
  title: string;
  status: ActivityStepStatus;
  /** Short facts for the row's end, such as "48 files · 12 imports" or "4 of 6". */
  meta?: string;
  /** The real error for a failed step, shown inline. */
  error?: string;
  /** For explanation topics: the section a finished topic opens. */
  slideId?: string;
  subtasks?: ActivityStep[];
}
export interface ActivityTask {
  id: string;
  kind: 'review' | 'briefing' | 'exploration' | 'github' | 'file-chat' | 'pr-action' | 'preload';
  title: string;
  account?: string;
  detail: string;
  model?: string;
  status: ActivityStatus;
  progress?: { completed: number; total: number; unit?: string };
  /** Structured stages. `detail` and `progress` stay for readers that only show one line. */
  steps?: ActivityStep[];
  /** When the task started, so elapsed time survives reopening a view. */
  startedAt?: string;
  warnings?: string[];
  updatedAt: string;
  reviewId?: string;
  slideId?: string;
  subjectId?: string;
  /** Conflict workspace URL during preparation, session ID for later operations. */
  conflictTarget?: string;
  canCancel: boolean;
  canRetry: boolean;
}
export type ActivityAction = 'cancel' | 'retry' | 'dismiss';
export const ACTIVITY_RETENTION_MS = 5 * 60 * 1000;
export function isActiveTask(task: ActivityTask) {
  return task.status === 'running' || task.status === 'queued' || task.status === 'paused';
}

const STEP_STATUSES = new Set<ActivityStepStatus>(['queued', 'running', 'done', 'failed', 'cancelled']);
const text = (value: unknown, max: number) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
/**
 * Steps cross IPC and partly come from model output (topic titles), so keep only known
 * fields with bounded sizes. Malformed entries are dropped rather than shown.
 */
export function sanitizeSteps(value: unknown, depth = 0): ActivityStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: ActivityStep[] = [];
  for (const raw of value.slice(0, 100) as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const step = raw as Record<string, unknown>;
    const id = text(step.id, 120);
    const title = text(step.title, 300);
    if (!id || !title || !STEP_STATUSES.has(step.status as ActivityStepStatus)) continue;
    const meta = text(step.meta, 120);
    const error = text(step.error, 2000);
    const slideId = text(step.slideId, 120);
    const subtasks = depth === 0 ? sanitizeSteps(step.subtasks, 1) : undefined;
    steps.push({
      id,
      title,
      status: step.status as ActivityStepStatus,
      ...(meta ? { meta } : {}),
      ...(error ? { error } : {}),
      ...(slideId ? { slideId } : {}),
      ...(subtasks ? { subtasks } : {}),
    });
  }
  return steps;
}
