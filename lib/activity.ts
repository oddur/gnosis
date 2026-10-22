export type ActivityStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface ActivityTask {
  id: string;
  kind: 'review' | 'briefing' | 'exploration' | 'github';
  title: string;
  detail: string;
  model?: string;
  status: ActivityStatus;
  progress?: { completed: number; total: number; unit?: string };
  warnings?: string[];
  updatedAt: string;
  reviewId?: string;
  slideId?: string;
  subjectId?: string;
  canCancel: boolean;
  canRetry: boolean;
}
export type ActivityAction = 'cancel' | 'retry' | 'dismiss';
export const ACTIVITY_RETENTION_MS = 5 * 60 * 1000;
export function isActiveTask(task: ActivityTask) {
  return task.status === 'running' || task.status === 'queued' || task.status === 'paused';
}
