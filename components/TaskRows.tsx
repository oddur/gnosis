import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Pause, TriangleAlert, X } from 'lucide-react';
import type { ActivityStepStatus } from '../lib/activity';

/*
 * Task Rows: a parent task with a status and a short summary, and its subtasks with their own
 * status and count. The pattern follows "Task Rows" in Beautiful UI (beautifului.dev, MIT,
 * Turbo / Shane Levine); this implementation is Gnosis's own and uses its tokens.
 */
export type TaskRowStatus = ActivityStepStatus | 'paused' | 'warning';
export interface TaskRowModel {
  id: string;
  title: ReactNode;
  status: TaskRowStatus;
  /** Facts at the row's end: a count, "4 of 6", "writing". */
  meta?: ReactNode;
  /** A failure, shown in full under the row. */
  error?: string;
  /** Row actions, such as Read or Retry. Buttons stay keyboard reachable. */
  actions?: ReactNode;
  subtasks?: TaskRowModel[];
  /** Hide the subtasks behind a toggle, for finished groups. */
  collapsed?: boolean;
  /** The toggle's text, such as "6 topics". */
  collapsedLabel?: string;
  /** Extra content under the row, such as a progress bar or disclosed details. */
  footer?: ReactNode;
  className?: string;
  /** Overrides `data-status`, for styles and tests keyed to a task's own status. */
  dataStatus?: string;
}

const statusLabels: Record<TaskRowStatus, string> = {
  queued: 'Waiting',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
  warning: 'Needs attention',
};

/** A status mark that is never color alone: each shape differs and carries a text label. */
export function TaskStatusGlyph({ status }: { status: TaskRowStatus }) {
  return (
    <span className="task-glyph" data-status={status}>
      {status === 'done' ? (
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      ) : status === 'failed' ? (
        <X size={11} strokeWidth={3} aria-hidden="true" />
      ) : status === 'paused' ? (
        <Pause size={9} strokeWidth={3} aria-hidden="true" />
      ) : status === 'warning' ? (
        <TriangleAlert size={11} strokeWidth={2.5} aria-hidden="true" />
      ) : null}
      <span className="sr-only">{statusLabels[status]}: </span>
    </span>
  );
}

function TaskRow({ row, depth }: { row: TaskRowModel; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const subtasks = row.subtasks?.length && (!row.collapsed || expanded) ? row.subtasks : undefined;
  return (
    <li
      className={['task-row', row.className].filter(Boolean).join(' ')}
      data-status={row.dataStatus ?? row.status}
      data-depth={depth}
    >
      <div className="task-row-line">
        <TaskStatusGlyph status={row.status} />
        <div className="task-row-title">{row.title}</div>
        {row.collapsed && !!row.subtasks?.length && (
          <button
            type="button"
            className="task-row-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((open) => !open)}
          >
            <ChevronRight size={13} aria-hidden="true" />
            <span className="sr-only">{expanded ? 'Hide' : 'Show'} </span>
            {row.collapsedLabel ?? `${row.subtasks.length} ${row.subtasks.length === 1 ? 'item' : 'items'}`}
          </button>
        )}
        {row.meta !== undefined && row.meta !== '' && <span className="task-row-meta">{row.meta}</span>}
        {row.actions && <span className="task-row-actions">{row.actions}</span>}
      </div>
      {row.error && <p className="task-row-error">{row.error}</p>}
      {row.footer}
      {subtasks && (
        <ol className="task-rows task-subrows" id={listId}>
          {subtasks.map((subtask) => (
            <TaskRow key={subtask.id} row={subtask} depth={depth + 1} />
          ))}
        </ol>
      )}
    </li>
  );
}

export function TaskRows({ rows, label, className }: { rows: TaskRowModel[]; label?: string; className?: string }) {
  return (
    <ol className={['task-rows', className].filter(Boolean).join(' ')} aria-label={label}>
      {rows.map((row) => (
        <TaskRow key={row.id} row={row} depth={0} />
      ))}
    </ol>
  );
}
