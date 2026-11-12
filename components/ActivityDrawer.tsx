import { GitHubSyncStatus, type GitHubSyncStatusProps } from './GitHubSyncStatus';
import { inspectionData } from '../lib/inspection-cache';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { isActiveTask, type ActivityAction, type ActivityTask } from '../lib/activity';
import { activityCapsule, seenKeys } from '../lib/activity-capsule';
import { TaskRows, TaskStatusGlyph, type TaskRowModel } from './TaskRows';
import { explanationRows, taskRowStatus, useElapsed } from './ExplanationBuild';
import { PROVIDERS } from '../lib/models';
import { createActivityCompletionTracker } from '../lib/activity-notifications';
import { toast } from './ui/toast';

const kindLabels = {
  review: 'Explanation',
  briefing: 'Briefing',
  exploration: 'Interactive explanation',
  github: 'GitHub update',
  preload: 'Preloading',
  'file-chat': 'File question',
  'pr-action': 'GitHub action',
};
const completedLabels = {
  review: 'Explanation ready',
  briefing: 'Briefing ready',
  exploration: 'Interactive explanation ready',
  'file-chat': 'Answer ready',
};
const openLabels = {
  review: 'Open guided review',
  briefing: 'Open briefing',
  exploration: 'Open interactive explanation',
};
/** Task fields the drawer shows. Equal tasks keep their previous objects, so idle updates render nothing. */
function sameTask(a: ActivityTask | undefined, b: ActivityTask | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.status === b.status && a.title === b.title && a.detail === b.detail && a.updatedAt === b.updatedAt &&
    a.progress?.completed === b.progress?.completed && a.progress?.total === b.progress?.total && a.progress?.unit === b.progress?.unit &&
    JSON.stringify(a) === JSON.stringify(b);
}
const sameTasks = (a: ActivityTask[], b: ActivityTask[]) => a.length === b.length && a.every((task, index) => sameTask(task, b[index]));
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
      aria-valuetext={
        progress ? `${progress.completed} of ${progress.total} ${progress.unit ?? 'topics'} complete` : task.detail
      }
    >
      <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
  );
}
const SEEN_KEY = 'gnosis-activity-seen';
function readSeen() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set<string>();
  }
}
const mac = () => window.electronAPI.platform === 'darwin';
export const ACTIVITY_SHORTCUT = { keys: () => (mac() ? '⌘⇧A' : 'Ctrl+Shift+A'), aria: () => (mac() ? 'Meta+Shift+A' : 'Control+Shift+A') };
const isActivityShortcut = (event: KeyboardEvent) =>
  event.shiftKey && !event.altKey && (mac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && event.key.toLowerCase() === 'a';

/** An explanation's elapsed time, which keeps ticking only while it runs. */
function Elapsed({ task }: { task: ActivityTask }) {
  const elapsed = useElapsed(task);
  return elapsed ? <span className="activity-elapsed">{elapsed}</span> : null;
}

/**
 * Background work, shown as a capsule in the title bar while something runs or a result is unseen,
 * and as Task Rows in a panel below it. The panel opens from the capsule, the account menu,
 * ⌘⇧A / Ctrl+Shift+A, and every "View activity" action.
 */
export const ActivityDrawer = memo(function ActivityDrawer({
  syncStatus,
  onOpen,
  open,
  onOpenChange: setOpen,
  capsuleTarget,
}: {
  syncStatus?: GitHubSyncStatusProps;
  onOpen: (task: ActivityTask) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The title bar's trailing cluster; the capsule renders there, before Search. */
  capsuleTarget?: HTMLElement | null;
}) {
  const [remoteTasks, setRemoteTasks] = useState<ActivityTask[]>([]);
  const [preloadTask, setPreloadState] = useState<ActivityTask>();
  const setTasks = useCallback((next: ActivityTask[]) => setRemoteTasks(previous => sameTasks(previous, next) ? previous : next), []);
  const setPreloadTask = useCallback((next: ActivityTask | undefined) => setPreloadState(previous => sameTask(previous, next) ? previous : next), []);
  const openRef = useRef(open);
  openRef.current = open;
  const tasks = preloadTask ? [...remoteTasks, preloadTask] : remoteTasks;
  const [newCompletions] = useState(createActivityCompletionTracker);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingActions = useRef(new Set<string>());
  const refreshRequest = useRef<Promise<void> | null>(null);
  const refreshVersion = useRef(0);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const [seen, setSeen] = useState(readSeen);
  const refresh = useCallback(
    (force = false): Promise<void> => {
      // Local preparation stays observable even while backend activity is busy.
      if (alive.current) setPreloadTask(inspectionData.activity());
      if (refreshRequest.current && !force) return refreshRequest.current;
      const version = ++refreshVersion.current;
      const request = (async () => {
        try {
          const next = await window.electronAPI.listActivity();
          if (alive.current && version === refreshVersion.current) {
            setTasks(next);
            const conflictWorkspace = document.querySelector<HTMLElement>('.conflict-workspace');
            const activeConflict = conflictWorkspace ? { url: conflictWorkspace.dataset.conflictUrl, id: conflictWorkspace.dataset.conflictId } : undefined;
            for (const task of newCompletions(next, activeConflict)) {
              if (task.kind === 'pr-action') {
                toast.add({ title: task.title, description: task.detail, type: task.status === 'failed' ? 'error' : 'success' });
                continue;
              }
              const id = toast.add({
                title: task.kind === 'exploration' ? 'Interactive explanation ready' : 'Review ready',
                description: task.kind === 'exploration' ? `${task.title} · ${task.detail}` : task.title,
                type: 'success',
                actionProps: {
                  children: task.kind === 'exploration' ? 'Open interactive explanation' : 'Open review',
                  onClick: () => {
                    toast.update(id, { actionProps: { children: 'Opening…', disabled: true } });
                    void onOpenRef
                      .current(task)
                      .then(() => toast.close(id))
                      .catch((e: unknown) => {
                        toast.update(id, {
                          type: 'error',
                          title: 'Could not open result',
                          description: e instanceof Error ? e.message : String(e),
                          actionProps: { children: undefined },
                        });
                      });
                  },
                },
              });
            }
            setRefreshError('');
          }
        } catch {
          if (alive.current && version === refreshVersion.current)
            setRefreshError('Could not refresh activity. Retrying…');
        }
      })().finally(() => {
        if (refreshRequest.current === request) refreshRequest.current = null;
      });
      refreshRequest.current = request;
      return request;
    },
    [newCompletions, setTasks, setPreloadTask]
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    // Preload progress arrives often. Show it at most four times a second while open, once a second while closed.
    let preloadTimer: ReturnType<typeof setTimeout> | undefined;
    const stopPreload = inspectionData.subscribe(() => {
      preloadTimer ??= setTimeout(() => {
        preloadTimer = undefined;
        setPreloadTask(inspectionData.activity());
      }, openRef.current ? 250 : 1000);
    });
    const stop = window.electronAPI.githubSyncVersion === 1 ? window.electronAPI.onActivityChanged?.(() => void refresh()) : undefined;
    const timer = setInterval(() => void refresh(), stop ? 60_000 : 2000);
    return () => {
      alive.current = false;
      refreshVersion.current++;
      refreshRequest.current = null;
      clearInterval(timer);
      clearTimeout(preloadTimer);
      stop?.();
      stopPreload();
    };
  }, [refresh, setPreloadTask]);
  const close = useCallback(() => {
    setOpen(false);
    const target = trigger.current ?? returnFocus.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [setOpen]);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      closeButton.current?.focus();
      void refresh();
    }
  }, [open, refresh]);
  // Opening Activity is seeing its results, which quiets the capsule.
  useEffect(() => {
    if (!open) return;
    const keys = seenKeys(tasks);
    setSeen((previous) => {
      if (keys.every((key) => previous.has(key))) return previous;
      // Keep only keys for tasks still listed, so the set stays small.
      const next = new Set([...previous].filter((key) => tasks.some((task) => key.startsWith(task.id + '@'))));
      for (const key of keys) next.add(key);
      try {
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...next]));
      } catch {
        /* Seen state is a courtesy; the capsule still works without storage. */
      }
      return next;
    });
  }, [open, tasks]);
  // A click elsewhere closes the panel, like other popovers in the title bar.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panel.current?.contains(target) || trigger.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper], [role=dialog], .app-toasts')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, setOpen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!isActivityShortcut(event) || event.isComposing) return;
      event.preventDefault();
      if (openRef.current) close();
      else setOpen(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close, setOpen]);
  async function act(task: ActivityTask, action: ActivityAction | 'open') {
    if (pendingActions.current.has(task.id)) return;
    pendingActions.current.add(task.id);
    setPending(new Set(pendingActions.current));
    setError('');
    try {
      if (action === 'open') {
        await onOpen(task);
        if (alive.current) close();
      } else {
        await window.electronAPI.activityAction(task.id, action);
        if (alive.current) await refresh(true);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pendingActions.current.delete(task.id);
      if (alive.current) setPending(new Set(pendingActions.current));
    }
  }
  const running = tasks.filter((t) => t.status === 'running');
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const ready = tasks.filter((t) => t.status === 'completed' && t.kind !== 'github').length;
  const updated = tasks.filter((t) => t.status === 'completed' && t.kind === 'github' && !t.warnings?.length).length;
  const warnings = tasks.filter((t) => !!t.warnings?.length).length;
  const paused = tasks.filter((t) => t.status === 'paused').length;
  const summary =
    [
      running.length && `${running.length} running`,
      queued && `${queued} queued`,
      paused && `${paused} paused`,
      failed && `${failed} failed`,
      ready && `${ready} ready`,
      updated && `GitHub updated`,
      warnings && `${warnings} with warnings`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No active tasks';
  const capsule = useMemo(() => activityCapsule(tasks, seen), [tasks, seen]);
  const models = useMemo(
    () =>
      new Map(
        Object.values(PROVIDERS).flatMap((p) => p.models.map((m) => [m.id as string, `${p.label} · ${m.label}`] as const))
      ),
    []
  );
  const rows = [...tasks]
    .sort(
      (a, b) =>
        Number(a.kind === 'preload') - Number(b.kind === 'preload') ||
        order[a.status] - order[b.status] ||
        b.updatedAt.localeCompare(a.updatedAt)
    )
    .map((task): TaskRowModel => {
      const explanation = task.kind === 'review' && (!!task.steps?.length || isActiveTask(task));
      const steps = explanation
        ? explanationRows(task, { onRetry: () => void act(task, 'retry'), pending: pending.has(task.id) })
        : undefined;
      const stepError = steps?.some((step) => step.error || step.subtasks?.some((topic) => topic.error));
      const model = task.model && (models.get(task.model) ?? task.model);
      const status =
        task.status === 'failed'
          ? 'Failed'
          : task.status === 'completed' && task.kind !== 'github' && task.kind !== 'pr-action' && task.kind !== 'preload'
            ? completedLabels[task.kind]
            : task.detail;
      const progress =
        task.kind !== 'preload' && task.status === 'running' && task.progress && !explanation
          ? ` · ${task.progress.completed} of ${task.progress.total} ${task.progress.unit ?? 'topics'} complete`
          : '';
      return {
        id: task.id,
        className: 'activity-task',
        dataStatus: task.warnings?.length ? 'warning' : task.status,
        status: taskRowStatus(task),
        title: (
          <>
            <span className="activity-kind">
              {kindLabels[task.kind]}
              {model && <span className="activity-model"> · {model}</span>}
            </span>
            <h3 title={task.title}>{task.title}</h3>
          </>
        ),
        meta: explanation ? <Elapsed task={task} /> : undefined,
        error: task.status === 'failed' && !stepError ? task.detail : undefined,
        subtasks: steps,
        collapsed: task.status === 'completed' && !!steps,
        collapsedLabel: steps && `${steps.length} steps`,
        footer: (
          <>
            {!(explanation && task.status === 'running') && (
              <p className="activity-task-status">
                {status}
                {progress}
              </p>
            )}
            {!!task.warnings?.length && (
              <details className="activity-failure">
                <summary>What could not be updated</summary>
                {task.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </details>
            )}
            {task.kind === 'preload' && task.progress && (
              <p className="activity-task-status tabular-nums">
                {task.progress.completed} prepared · {task.progress.total - task.progress.completed} pending
              </p>
            )}
            {((task.status === 'running' && !explanation) || (task.kind === 'preload' && task.status === 'paused')) && (
              <Progress task={task} />
            )}
          </>
        ),
        actions: (
          <span className="activity-actions">
            {task.canCancel && (
              <button disabled={pending.has(task.id)} onClick={() => void act(task, 'cancel')}>
                Cancel
              </button>
            )}
            {task.canRetry && (
              <button disabled={pending.has(task.id)} onClick={() => void act(task, 'retry')}>
                Retry
              </button>
            )}
            {task.status === 'completed' &&
              task.kind !== 'github' &&
              task.kind !== 'file-chat' &&
              task.kind !== 'pr-action' &&
              task.kind !== 'preload' && (
                <button disabled={pending.has(task.id)} onClick={() => void act(task, 'open')}>
                  {openLabels[task.kind]}
                </button>
              )}
            {pending.has(task.id) && <Loader2 size={12} className="animate-spin" aria-label="Working" />}
            {!isActiveTask(task) && (
              <button
                className="activity-dismiss"
                disabled={pending.has(task.id)}
                aria-label={`Dismiss ${task.title}`}
                title="Dismiss"
                onClick={() => void act(task, 'dismiss')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        ),
      };
    });
  const capsuleLabel = `Activity: ${capsule.label || summary}`;
  return (
    <>
      {capsuleTarget &&
        (capsule.visible || open) &&
        createPortal(
          <button
            ref={trigger}
            className="activity-trigger activity-capsule"
            data-tone={capsule.visible ? capsule.tone : 'idle'}
            aria-expanded={open}
            aria-controls="activity-drawer"
            aria-label={capsuleLabel}
            aria-keyshortcuts={ACTIVITY_SHORTCUT.aria()}
            title={`${capsuleLabel} (${ACTIVITY_SHORTCUT.keys()})`}
            onClick={() => (open ? close() : setOpen(true))}
          >
            {capsule.running > 0 && (
              <span className="activity-capsule-part" data-tone="running">
                <TaskStatusGlyph status="running" />
                {capsule.running} running
              </span>
            )}
            {capsule.queued > 0 && (
              <span className="activity-capsule-part" data-tone={capsule.running ? 'muted' : 'running'}>
                {!capsule.running && <TaskStatusGlyph status="queued" />}
                {capsule.queued} queued
              </span>
            )}
            {capsule.unseenFailed > 0 && (
              <span className="activity-capsule-part" data-tone="failed">
                <TaskStatusGlyph status="failed" />
                {capsule.running || capsule.queued ? capsule.unseenFailed : `${capsule.unseenFailed} failed`}
              </span>
            )}
            {capsule.unseenReady > 0 && (
              <span className="activity-capsule-part" data-tone="ready">
                <TaskStatusGlyph status="done" />
                {capsule.running || capsule.queued || capsule.unseenFailed ? capsule.unseenReady : `${capsule.unseenReady} ready`}
              </span>
            )}
            {capsule.running > 0 && capsule.seenFailed > 0 && !capsule.unseenFailed && (
              <span className="activity-capsule-part" data-tone="muted">
                {capsule.seenFailed} failed
              </span>
            )}
            {!capsule.visible && <span className="activity-capsule-part">Activity</span>}
          </button>,
          capsuleTarget
        )}
      {/* Phase changes and results are announced once, never each progress tick. */}
      <span className="sr-only" role="status">
        {capsule.visible ? capsule.label : ''}
      </span>
      {open && (
        <section
          ref={panel}
          id="activity-drawer"
          className="activity-drawer"
          aria-labelledby={headingId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <h2 id={headingId}>Activity</h2>
            <span className="activity-summary">{summary}</span>
            <button ref={closeButton} className="workbench-icon" aria-label="Close activity" onClick={close}>
              <X size={15} />
            </button>
          </header>
          {syncStatus && <GitHubSyncStatus {...syncStatus} />}
          {(error || refreshError) && (
            <p className="activity-error" role="alert">
              {error || refreshError}
            </p>
          )}
          <div className="activity-list">
            {!tasks.length ? (
              <p className="activity-empty">No activity yet. GitHub updates and AI generation appear here.</p>
            ) : (
              <TaskRows rows={rows} label="Background tasks" className="activity-rows" />
            )}
          </div>
        </section>
      )}
    </>
  );
});
