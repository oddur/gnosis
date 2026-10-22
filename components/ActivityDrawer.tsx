import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ChevronUp, X, Loader2, Check, AlertCircle } from 'lucide-react';
import { isActiveTask, type ActivityAction, type ActivityTask } from '../lib/activity';
import { PROVIDERS } from '../lib/models';

const kindLabels = { review: 'Review', briefing: 'Briefing', exploration: 'Exploration' };
const order = { running: 0, failed: 1, paused: 2, queued: 3, completed: 4, cancelled: 5 };
function Progress({ task }: { task: ActivityTask }) {
  const progress = task.progress;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.max(0, (progress.completed / progress.total) * 100))
      : undefined;
  return (
    <div
      className={`activity-progress ${percent === undefined ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-label={`${task.title}: ${task.detail}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={progress ? `${progress.completed} of ${progress.total} sections complete` : task.detail}
    >
      <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
  );
}
export function ActivityDrawer({ onOpen }: { onOpen: (task: ActivityTask) => Promise<void> }) {
  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const alive = useRef(true);
  const refreshFailed = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI.listActivity();
      if (alive.current) {
        setTasks(next);
        if (refreshFailed.current) {
          setError('');
          refreshFailed.current = false;
        }
      }
    } catch {
      if (alive.current) {
        refreshFailed.current = true;
        setError('Could not refresh activity. Retrying…');
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);
  async function act(task: ActivityTask, action: ActivityAction | 'open') {
    setPending(task.id);
    setError('');
    try {
      if (action === 'open') {
        await onOpen(task);
        close();
      } else {
        await window.electronAPI.activityAction(task.id, action);
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }
  const running = tasks.filter((t) => t.status === 'running');
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const ready = tasks.filter((t) => t.status === 'completed').length;
  const paused = tasks.filter((t) => t.status === 'paused').length;
  const summary =
    [
      running.length && `${running.length} running`,
      queued && `${queued} queued`,
      paused && `${paused} paused`,
      failed && `${failed} failed`,
      ready && `${ready} ready`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No active tasks';
  return (
    <div className="activity-shell">
      <button
        ref={trigger}
        className="activity-trigger"
        aria-expanded={open}
        aria-controls="activity-drawer"
        onClick={() => setOpen(!open)}
      >
        <Activity size={14} />
        <span>Activity</span>
        <span className="activity-summary" aria-live="polite">
          {summary}
        </span>
        {running.length > 0 && (
          <span className="activity-mini-progress">
            <Progress task={running[0]} />
          </span>
        )}
        <ChevronUp size={13} className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <section
          id="activity-drawer"
          className="activity-drawer"
          aria-label="Background activity"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <h2>Activity</h2>
            <span>{summary}</span>
            <button ref={closeButton} className="workbench-icon" aria-label="Close activity" onClick={close}>
              <X size={15} />
            </button>
          </header>
          {error && (
            <p className="activity-error" role="alert">
              {error}
            </p>
          )}
          <div className="activity-list">
            {!tasks.length && (
              <p className="activity-empty">
                Reviews, briefings, and explorations appear here while they work. You can keep browsing.
              </p>
            )}
            {[...tasks]
              .sort((a, b) => order[a.status] - order[b.status] || b.updatedAt.localeCompare(a.updatedAt))
              .map((task) => {
                const label =
                  Object.values(PROVIDERS)
                    .flatMap((p) => p.models.map((m) => ({ id: m.id, label: `${p.label} · ${m.label}` })))
                    .find((m) => m.id === task.model)?.label ?? task.model;
                return (
                  <article className="activity-task" key={task.id} data-status={task.status}>
                    <div className="activity-task-meta">
                      <span>{kindLabels[task.kind]}</span>
                      {label && <span>{label}</span>}
                      {!isActiveTask(task) && (
                        <button
                          className="workbench-icon"
                          disabled={pending === task.id}
                          aria-label={`Dismiss ${task.title}`}
                          onClick={() => void act(task, 'dismiss')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <h3>{task.title}</h3>
                    <div className="activity-task-status">
                      {task.status === 'running' ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : task.status === 'completed' ? (
                        <Check size={13} />
                      ) : task.status === 'failed' ? (
                        <AlertCircle size={13} />
                      ) : null}
                      <span>
                        {task.status === 'failed' ? 'Failed' : task.detail}
                        {task.status === 'running' && task.progress
                          ? ` · ${task.progress.completed} of ${task.progress.total} complete`
                          : ''}
                      </span>
                    </div>
                    {task.status === 'failed' && (
                      <details className="activity-failure">
                        <summary>Error details</summary>
                        <p>{task.detail}</p>
                      </details>
                    )}
                    {task.status === 'running' && <Progress task={task} />}
                    <div className="activity-actions">
                      {task.canCancel && (
                        <button disabled={pending === task.id} onClick={() => void act(task, 'cancel')}>
                          Cancel
                        </button>
                      )}
                      {task.canRetry && (
                        <button disabled={pending === task.id} onClick={() => void act(task, 'retry')}>
                          Retry
                        </button>
                      )}
                      {task.status === 'completed' && (
                        <button disabled={pending === task.id} onClick={() => void act(task, 'open')}>
                          Open {task.kind === 'exploration' ? 'exploration' : task.kind}
                        </button>
                      )}
                      {pending === task.id && <Loader2 size={12} className="animate-spin" />}
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      )}
    </div>
  );
}
