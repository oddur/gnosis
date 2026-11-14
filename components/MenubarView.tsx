/**
 * The menu bar panel (#308 section 4). A pure function of `MenubarState` and the `window.gnosisMenubar` API, so the
 * browser fixture mounts it with a fake API and named states.
 *
 * Markup is labelled groups of buttons, not `role="menu"`: a screen reader reads "To review, 2 items". The list
 * is one Tab stop with a roving tabindex; arrows or j/k move across groups. The panel never writes to GitHub.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  Eye,
  GitCompareArrows,
  GitMerge,
  Layers,
  LoaderCircle,
  MessageSquareWarning,
  MessagesSquare,
  RefreshCw,
  Settings,
  Sparkles,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { AttentionKind } from '../lib/attention';
import type { MenubarApi, MenubarGroup, MenubarRow, MenubarState, MenubarTask } from '../lib/menubar-state';
import { useStatusNow } from '../lib/status-clock';

/** ↻ stays disabled for 10 seconds after a refresh. */
export const REFRESH_COOLDOWN_MS = 10_000;

const KIND_ICON: Record<AttentionKind, { icon: LucideIcon; tone: string }> = {
  'review-requested': { icon: Eye, tone: 'review' },
  'updated-since-review': { icon: GitCompareArrows, tone: 'review' },
  'changes-requested': { icon: MessageSquareWarning, tone: 'danger' },
  'checks-failed': { icon: CircleX, tone: 'danger' },
  conflicts: { icon: TriangleAlert, tone: 'warning' },
  replies: { icon: MessagesSquare, tone: 'warning' },
  restack: { icon: Layers, tone: 'warning' },
  'ready-to-merge': { icon: GitMerge, tone: 'success' },
  'explanation-ready': { icon: Sparkles, tone: 'info' },
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** "just now", "3 min ago", "2 h ago", "yesterday". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return hours < 48 ? 'yesterday' : `${Math.floor(hours / 24)} days ago`;
}

/** The muted second header line: the data's age, or the connection state with an icon and words. */
function StateLine({ state, now, onRetry }: { state: MenubarState; now: number; onRetry: () => void }) {
  const last = state.checkedAt ? ` · last updated ${clock(state.checkedAt)}` : '';
  if (state.connection === 'offline')
    return <Line icon={WifiOff} tone="warning">Offline{last}</Line>;
  if (state.connection === 'paused' && state.retryAt)
    return <Line icon={CirclePause} tone="warning">GitHub updates paused until {clock(state.retryAt)}</Line>;
  if (state.connection === 'error')
    return (
      <Line icon={CircleAlert} tone="danger">
        Could not reach GitHub ·{' '}
        <button type="button" className="menubar-inline-button" onClick={onRetry}>
          Retry
        </button>
      </Line>
    );
  if (state.refreshing) return <Line>Checking…</Line>;
  return <Line>{state.checkedAt ? `Updated ${ago(state.checkedAt, now)}` : 'Not updated yet'}</Line>;
}
function Line({ icon: Icon, tone, children }: { icon?: LucideIcon; tone?: string; children: ReactNode }) {
  return (
    <p className="menubar-state-line" data-tone={tone}>
      {Icon && <Icon aria-hidden="true" className="menubar-state-icon" />}
      <span>{children}</span>
    </p>
  );
}

function rowDetail(row: MenubarRow, group: MenubarGroup['group'], now: number): string {
  const where = row.stackSize ? `Stack · ${row.stackSize} PRs` : `${row.repo} #${row.number}`;
  const author = group === 'review' && !row.own ? row.author : '';
  const checked = row.kinds[0] === 'ready-to-merge' && row.checkedAt ? `checked ${ago(row.checkedAt, now)}` : '';
  return [where, author, ...row.labels, checked].filter(Boolean).join(' · ');
}

function Row({
  row,
  group,
  now,
  current,
  onOpen,
  onFocus,
  setRef,
}: {
  row: MenubarRow;
  group: MenubarGroup['group'];
  now: number;
  current: boolean;
  onOpen: () => void;
  onFocus: () => void;
  setRef: (element: HTMLButtonElement | null) => void;
}) {
  const { icon: Icon, tone } = KIND_ICON[row.kinds[0]];
  return (
    <li>
      <button
        ref={setRef}
        type="button"
        className="menubar-row"
        data-row-id={row.id}
        data-current={current || undefined}
        tabIndex={current ? 0 : -1}
        onClick={onOpen}
        onFocus={onFocus}
      >
        <span className="menubar-row-dot" data-new={row.isNew || undefined}>
          {row.isNew && <span className="sr-only">New</span>}
        </span>
        <Icon aria-hidden="true" className="menubar-row-icon" data-tone={tone} />
        <span className="menubar-row-text">
          <span className="menubar-row-title">{row.title}</span>
          <span className="menubar-row-detail">{rowDetail(row, group, now)}</span>
        </span>
        <span className="menubar-row-hint" aria-hidden="true">
          Open ↵
        </span>
      </button>
    </li>
  );
}

function Task({ task }: { task: MenubarTask }) {
  const failed = task.status === 'failed';
  const Icon = failed ? CircleX : LoaderCircle;
  return (
    <li className="menubar-task" data-status={task.status}>
      <Icon aria-hidden="true" className="menubar-row-icon" data-tone={failed ? 'danger' : 'muted'} data-spin={task.status === 'running' || undefined} />
      <span className="menubar-task-text">
        {task.title}
        {task.detail ? ` · ${task.detail}` : ''}
        {failed ? ' · Failed' : task.status === 'queued' ? ' · Queued' : task.status === 'paused' ? ' · Paused' : ''}
      </span>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="menubar-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="menubar-skeleton-row">
          <span style={{ width: `${[78, 64, 84, 58][i]}%` }} />
          <span style={{ width: `${[52, 40, 46, 36][i]}%` }} />
        </div>
      ))}
    </div>
  );
}

export function MenubarView({ state, api, now: fixedNow }: { state: MenubarState | null; api: MenubarApi; now?: number }) {
  const clockNow = useStatusNow();
  const now = fixedNow ?? (clockNow || Date.now());
  const rows = state && !state.loading && state.connection !== 'signed-out' ? state.groups.flatMap((group) => group.rows.map((row) => ({ row, group: group.group }))) : [];
  const ids = rows.map(({ row }) => row.id);
  const [currentId, setCurrentId] = useState<string | undefined>(undefined);
  const current: string | undefined = currentId && ids.includes(currentId) ? currentId : ids.at(0);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const root = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooling, setCooling] = useState(false);

  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return;
    setCurrentId(id);
    buttons.current.get(id)?.focus();
  }, []);
  const refresh = useCallback(() => {
    if (state?.refreshing || Date.now() < cooldownUntil) return;
    setCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS);
    setCooling(true);
    void api.refresh().catch(() => {});
  }, [api, state?.refreshing, cooldownUntil]);
  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(() => setCooling(false), Math.max(0, cooldownUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [cooling, cooldownUntil]);

  // On open the list takes focus with the first row current.
  const first = ids[0];
  useEffect(
    () =>
      api.onShown(() => {
        if (first) focusRow(first);
        else root.current?.focus();
      }),
    [api, first, focusRow]
  );

  // The window fits its content, up to 560 pt; then the list scrolls between the fixed header and footer.
  useLayoutEffect(() => {
    const measure = () => {
      const height = (header.current?.offsetHeight ?? 0) + (body.current?.scrollHeight ?? 0) + (footer.current?.offsetHeight ?? 0);
      if (height > 0) api.resize(height);
    };
    measure();
    const content = body.current?.firstElementChild;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [api, state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        api.close();
        return;
      }
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o') api.openApp();
      else if (key === ',') api.openSettings();
      else if (key === 'r') refresh();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, refresh]);

  const onListKey = (event: ReactKeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !ids.length) return;
    const index = Math.max(0, ids.indexOf(current ?? ''));
    const next =
      event.key === 'ArrowDown' || event.key === 'j'
        ? Math.min(ids.length - 1, index + 1)
        : event.key === 'ArrowUp' || event.key === 'k'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? ids.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    focusRow(ids[next]);
  };

  const signedOut = state?.connection === 'signed-out';
  const loading = !state || state.loading;
  const clear = !!state && !loading && !signedOut && state.groups.length === 0;
  const title = signedOut ? 'Not connected to GitHub' : loading ? 'Checking your PRs…' : clear ? 'All clear' : state.summary.line;
  const refreshDisabled = !!state?.refreshing || cooling;

  return (
    <div ref={root} className="menubar" tabIndex={-1} aria-label="Gnosis">
      <header ref={header} className="menubar-header">
        <div className="menubar-header-text">
          <h1 className="menubar-title" aria-live="polite">
            {title}
          </h1>
          {state && !loading && !signedOut && <StateLine state={state} now={now} onRetry={refresh} />}
        </div>
        <div className="menubar-header-actions">
          {!signedOut && (
            <button type="button" className="menubar-icon-button" aria-label="Refresh" title="Refresh (⌘R)" disabled={refreshDisabled} onClick={refresh}>
              <RefreshCw aria-hidden="true" data-spin={state?.refreshing || undefined} />
            </button>
          )}
          <button type="button" className="menubar-icon-button" aria-label="Settings" title="Settings (⌘,)" onClick={() => api.openSettings()}>
            <Settings aria-hidden="true" />
          </button>
        </div>
      </header>
      <div ref={body} className="menubar-body">
        <div className="menubar-content">
          {loading ? (
            <Skeleton />
          ) : signedOut ? (
            <div className="menubar-message">
              <p>Connect GitHub to see what needs you.</p>
              <button type="button" className="menubar-button" onClick={() => api.openApp()}>
                Connect GitHub
              </button>
            </div>
          ) : (
            <>
              {clear && (
                <div className="menubar-message menubar-clear">
                  <CircleCheck aria-hidden="true" className="menubar-clear-icon" />
                  <p>
                    Nothing needs you.
                    {state.queueSize > 0 && (
                      <span className="menubar-muted">
                        {' '}
                        {state.queueSize} open {state.queueSize === 1 ? 'PR' : 'PRs'} in your queue.
                      </span>
                    )}
                  </p>
                </div>
              )}
              {state.groups.length > 0 && (
                <div className="menubar-list" role="presentation" onKeyDown={onListKey}>
                  {state.groups.map((group) => (
                    <section key={group.group} className="menubar-group" aria-labelledby={`menubar-group-${group.group}`}>
                      <h2 id={`menubar-group-${group.group}`} className="menubar-group-label">
                        <span>{group.label}</span>
                        <span className="menubar-group-count" aria-label={`${group.count} ${group.count === 1 ? 'item' : 'items'}`}>
                          {group.count}
                        </span>
                      </h2>
                      <ul className="menubar-rows" aria-labelledby={`menubar-group-${group.group}`}>
                        {group.rows.map((row) => (
                          <Row
                            key={row.id}
                            row={row}
                            group={group.group}
                            now={now}
                            current={row.id === current}
                            onOpen={() => api.open(row.id)}
                            onFocus={() => setCurrentId(row.id)}
                            setRef={(element) => {
                              if (element) buttons.current.set(row.id, element);
                              else buttons.current.delete(row.id);
                            }}
                          />
                        ))}
                      </ul>
                      {group.count > group.rows.length && (
                        <button type="button" className="menubar-more" onClick={() => api.openApp()}>
                          {group.count - group.rows.length} more in Gnosis
                        </button>
                      )}
                    </section>
                  ))}
                </div>
              )}
              {state.tasks.length > 0 && (
                <section className="menubar-group" aria-labelledby="menubar-group-progress">
                  <h2 id="menubar-group-progress" className="menubar-group-label">
                    <span>In progress</span>
                    <span className="menubar-group-count">{state.tasks.length}</span>
                  </h2>
                  <ul className="menubar-rows">
                    {state.tasks.map((task) => (
                      <Task key={task.id} task={task} />
                    ))}
                  </ul>
                </section>
              )}
              {state.unchecked > 0 && (
                <p className="menubar-note">
                  {state.unchecked} {state.unchecked === 1 ? 'PR' : 'PRs'} not checked recently
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <footer ref={footer} className="menubar-footer">
        <button type="button" className="menubar-footer-button" onClick={() => api.openApp()}>
          <span>Open Gnosis</span>
          <kbd aria-hidden="true">⌘O</kbd>
        </button>
      </footer>
    </div>
  );
}

/** Holds the latest pushed state: read once on load, then every push from main. */
export function useMenubarState(api: MenubarApi): MenubarState | null {
  const [state, setState] = useState<MenubarState | null>(null);
  useEffect(() => {
    let live = true;
    const stop = api.onState((next) => setState(next));
    void api.get().then((value) => {
      if (live && value) setState((current) => current ?? value);
    });
    return () => {
      live = false;
      stop();
    };
  }, [api]);
  return state;
}
