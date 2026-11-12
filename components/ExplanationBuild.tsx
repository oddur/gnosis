import { useEffect, useId, useMemo, useState } from 'react';
import { isActiveTask, type ActivityStep, type ActivityTask } from '../lib/activity';
import { explanationStepsFromDetail, formatElapsed } from '../lib/explanation-progress';
import { TaskRows, TaskStatusGlyph, type TaskRowModel, type TaskRowStatus } from './TaskRows';

const runningPhrases: Record<string, string> = {
  context: 'Reading PR and context',
  plan: 'Planning topics',
  topics: 'Writing topics',
  generate: 'Writing explanation',
  check: 'Checking explanation text',
  overview: 'Writing overview',
  render: 'Rendering code',
};

/** The task's steps, or rows rebuilt from its single progress line. */
export function taskSteps(task: ActivityTask): ActivityStep[] {
  return task.steps?.length ? task.steps : explanationStepsFromDetail(task.detail, task.progress);
}

export function taskRowStatus(task: ActivityTask): TaskRowStatus {
  if (task.warnings?.length) return 'warning';
  return task.status === 'completed' ? 'done' : task.status;
}

/** Ticks once a second while running; stops at the task's last update once it has ended. */
export function useElapsed(task: ActivityTask | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const active = !!task && isActiveTask(task);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  const started = task?.startedAt ? Date.parse(task.startedAt) : NaN;
  if (!task || Number.isNaN(started)) return undefined;
  return formatElapsed((active ? now : Date.parse(task.updatedAt)) - started);
}

export interface ExplanationRowActions {
  /** Opens a finished topic while the rest are written. */
  onRead?: (slideId: string) => void;
  /** The whole explanation's retry, which reuses topics that were already written. */
  onRetry?: () => void;
  pending?: boolean;
}

/** "2 of 5 · 1 failed": the failure count takes the failure color, so it stands out from progress. */
function failedCount(meta?: string) {
  const match = meta && /^(.*) · (\d+ failed)$/.exec(meta);
  return match ? (
    <>
      {match[1]} · <span className="task-row-meta-failed">{match[2]}</span>
    </>
  ) : (
    meta
  );
}

/** Explanation stages as Task Rows; topics carry Read and Retry actions. */
export function explanationRows(task: ActivityTask, { onRead, onRetry, pending }: ExplanationRowActions): TaskRowModel[] {
  const running = isActiveTask(task);
  return taskSteps(task).map((step) => {
    const subtasks = step.subtasks?.map(
      (topic): TaskRowModel => {
        const slideId = topic.slideId;
        return {
        id: topic.id,
        title: topic.title,
        status: topic.status,
        meta: topic.status === 'failed' ? 'failed' : topic.meta,
        error: topic.error,
        actions:
          topic.status === 'done' && running && onRead && slideId ? (
            <button
              type="button"
              className="task-row-action"
              aria-label={`Read ${topic.title}`}
              onClick={() => onRead(slideId)}
            >
              Read
            </button>
          ) : topic.status === 'failed' && task.canRetry && onRetry ? (
            <button
              type="button"
              className="task-row-action"
              disabled={pending}
              aria-label={`Retry ${topic.title}. Topics already written are reused.`}
              title="Retries the explanation. Topics already written are reused."
              onClick={onRetry}
            >
              Retry
            </button>
          ) : undefined,
        };
      }
    );
    return {
      id: step.id,
      title: step.title,
      status: step.status,
      meta: failedCount(step.meta),
      error: step.error,
      subtasks,
      // A finished group folds into one line; its topics stay one click away for Read.
      collapsed: step.status === 'done' && !!subtasks?.length,
      collapsedLabel: subtasks && `${subtasks.length} ${subtasks.length === 1 ? 'topic' : 'topics'}`,
    };
  });
}

/** What a screen reader hears: each phase change and the outcome, never each tick. */
export function explanationAnnouncement(task: ActivityTask) {
  if (task.status === 'completed') return 'Explanation ready';
  if (task.status === 'cancelled') return 'Explanation cancelled';
  const steps = taskSteps(task);
  if (task.status === 'failed') {
    const failed = steps.find((step) => step.status === 'failed');
    return `Explanation failed${failed ? ` at ${failed.title}` : ''}`;
  }
  const current = steps.find((step) => step.status === 'running');
  return current ? (runningPhrases[current.id] ?? current.title) : task.detail;
}

/** The Explanation tab's build view: header with elapsed time, then the stages. */
export function ExplanationBuild({
  task,
  subject,
  actions,
  notice,
  children,
}: {
  task: ActivityTask;
  subject: string;
  actions: ExplanationRowActions;
  notice?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const elapsed = useElapsed(task);
  const titleId = useId();
  const rows = useMemo(() => explanationRows(task, actions), [task, actions]);
  const status = taskRowStatus(task);
  const verb =
    task.status === 'failed'
      ? 'Explanation failed'
      : task.status === 'cancelled'
        ? 'Explanation cancelled'
        : task.status === 'completed'
          ? 'Explained'
          : 'Explaining';
  return (
    <section className="explanation-build" aria-labelledby={titleId} data-status={task.status}>
      <header className="explanation-build-header">
        <TaskStatusGlyph status={status} />
        <h2 id={titleId}>
          <span>{verb}</span> <span className="explanation-build-subject">{subject}</span>
        </h2>
        {elapsed && (
          <span className="explanation-build-elapsed" title="Elapsed time">
            {elapsed}
          </span>
        )}
      </header>
      <p className="sr-only" role="status" aria-atomic="true">
        {explanationAnnouncement(task)}
      </p>
      {notice}
      <TaskRows rows={rows} label="Explanation steps" className="explanation-build-rows" />
      {children && <div className="explanation-build-actions">{children}</div>}
    </section>
  );
}
