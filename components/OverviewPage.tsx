/**
 * The Overview (#390): what you can act on right now, across every repository. Lanes come from `lib/overview.ts`
 * over the window's queue snapshot. Rows reuse the queue's vocabulary: the PR state icon, title, repository and PR
 * badges, the GitHub author, the unread dot for "new", and the row menu. Quick actions reuse the existing merge
 * confirmation (`PrActions`), the existing rerun path (`BulkCheckRerun`) and the notification targets.
 *
 * Rows are memoized on their `signature`, so a sync tick renders only the rows it changed. Live updates keep focus:
 * rows keep their keys, and a row that React moved gets its focus back without scrolling.
 */
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { AlertCircle, ArrowRight, BookOpen, ChevronRight, CircleCheck, Clock3, GitMerge, Layers, RefreshCw, RotateCcw, Settings, X } from 'lucide-react';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useOverview } from '../lib/use-overview';
import { publishOverviewCount } from '../lib/overview-count';
import {
  ACTION_LANES,
  OVERVIEW_COUNT_LABEL,
  OVERVIEW_EMPTY,
  OVERVIEW_LANE_LABEL,
  OVERVIEW_LANE_LIMIT,
  OVERVIEW_REASON_LABEL,
  OVERVIEW_SINCE_LABEL,
  rowReasons,
  type OverviewLane,
  type OverviewModel,
  type OverviewReason,
  type OverviewRow,
} from '../lib/overview';
import { attentionIcons } from '../lib/interface-icons';
import { openSnoozePicker } from '../lib/snooze-picker';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import type { PrChecks } from '../lib/pr-checks';
import { PrStateIcon } from './PrStateIcon';
import { GitHubAuthor } from './GitHubAuthor';
import { PrBadge, RepositoryBadge } from './EntityBadge';
import { DiffStats } from './DiffStats';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { PrActions } from './PrActions';
import { BulkCheckRerun } from './BulkCheckRerun';
import { PrFreshness } from './PrFreshness';
import { LoadingState } from './LoadingState';
import { Button } from './ui/button';
import { toast } from './ui/toast';

export interface OverviewPageProps {
  queue: Pick<WorkbenchQueue, 'items' | 'sync' | 'readStates'>;
  login: string | null;
  /** The status store scope, the signed-in account. */
  scope: string | null;
  authenticated: boolean;
  /** Settings › Repositories has at least one repository. */
  hasRepositories: boolean;
  loading: boolean;
  /** The snapshot saved last session is on screen while main reads GitHub again. */
  refreshing: boolean;
  visible: boolean;
  /** Status stays current: shown, or resolving the queue's lane filter. */
  live: boolean;
  /** Keys move through rows. Off while a dialog, setup or another surface owns the keyboard. */
  keyboard: boolean;
  teamRequests?: boolean;
  excluded?: ReadonlySet<string>;
  /** The home screen's error, such as a failed Mark as read. */
  error?: string;
  onDismissError?: () => void;
  /** Getting started has not been dismissed: offer it, since it lives in the queue. */
  setup?: () => void;
  onRefresh: () => void;
  onShowLane: (lane: OverviewLane) => void;
  onMarkRead: (urls: string[]) => void;
  /** Opens a row in this window when no workspace tabs are available. */
  onOpenItem: (item: QueueItem) => void;
  onRepositories: () => void;
  onConnect: () => void;
  /** Each lane's PRs, for the queue's lane filter. */
  onModel?: (model: OverviewModel) => void;
}

const reasonIcon = (reason: OverviewReason) =>
  reason === 'review-pending' || reason === 'checks-pending' ? { icon: Clock3, tone: 'warning' as const } : attentionIcons[reason];
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function OverviewPage(props: OverviewPageProps) {
  const { queue, login, scope, authenticated, hasRepositories, loading, refreshing, visible, live, keyboard, teamRequests, excluded, error, onDismissError, setup, onRefresh, onShowLane, onRepositories, onConnect, onModel } = props;
  const model = useOverview({ items: queue.items, login: authenticated ? login : null, scope: authenticated ? scope : null, live, visible, ready: !loading, teamRequests, excluded });
  useEffect(() => { onModel?.(model); }, [model, onModel]);
  // The tab title counts the four action lanes, as the strip does (lib/overview-count.ts).
  const account = authenticated ? login : null;
  useEffect(() => {
    if (account && !loading) publishOverviewCount(account, model.actionable);
  }, [account, loading, model.actionable]);
  const navigation = useWorkspaceNavigation();
  // The home screen passes new callbacks on every render. Rows read them through this ref, so a home screen render
  // never renders the rows again.
  const callbacks = useRef(props);
  callbacks.current = props;
  const root = useRef<HTMLDivElement>(null);
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const rows = useMemo(
    () => model.lanes.flatMap((state) => (state.lane === 'waiting' && !waitingOpen ? [] : state.rows.slice(0, OVERVIEW_LANE_LIMIT))),
    [model, waitingOpen]
  );
  const tabStop = rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null);
  const latestRows = useRef(rows);
  latestRows.current = rows;

  const open = useCallback(
    (row: OverviewRow) => {
      if (navigation?.openTarget)
        void navigation.openTarget(row.target).catch((error: unknown) =>
          toast.add({ type: 'error', title: 'Could not open this PR', description: error instanceof Error ? error.message : String(error) })
        );
      else callbacks.current.onOpenItem(row.item);
    },
    [navigation]
  );
  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return;
    setCurrent(id);
    root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
  }, []);
  const move = useCallback(
    (direction: 1 | -1) => {
      const list = latestRows.current;
      const active = document.activeElement?.closest<HTMLElement>('[data-overview-row]')?.dataset.overviewRow;
      const index = list.findIndex((row) => row.id === active);
      const next = index < 0 ? list.at(direction > 0 ? 0 : -1) : list.at(Math.max(0, Math.min(list.length - 1, index + direction)));
      focusRow(next?.id);
    },
    [focusRow]
  );
  const snooze = useCallback(
    (row: OverviewRow) => {
      const index = latestRows.current.findIndex((entry) => entry.id === row.id);
      const next = latestRows.current.at(index + 1) ?? (index > 0 ? latestRows.current.at(index - 1) : undefined);
      return openSnoozePicker({
        groups: [row.item.subject.members],
        onSnoozed: () => requestAnimationFrame(() => focusRow(next?.id)),
      });
    },
    [focusRow]
  );
  const currentRow = () => {
    const id = document.activeElement?.closest<HTMLElement>('[data-overview-row-item]')?.dataset.overviewRowItem;
    return latestRows.current.find((row) => row.id === id);
  };
  useKeyboardShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      // The row's one quick action: Merge, Rerun failed, Review or Open thread.
      a: (event) => {
        const row = currentRow();
        if (!row || event.repeat) return false;
        root.current?.querySelector<HTMLElement>(`[data-overview-row-item="${CSS.escape(row.id)}"] [data-quick-action]`)?.click();
      },
      z: (event) => {
        const row = currentRow();
        if (!row || event.repeat || !authenticated) return false;
        return snooze(row);
      },
    },
    { enabled: visible && keyboard }
  );
  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusRow(event.key === 'Home' ? latestRows.current[0]?.id : latestRows.current.at(-1)?.id);
      }
    },
    [move, focusRow]
  );
  // A live update can move the focused row's element; React re-inserts it and the browser drops focus. Give it back
  // in place, without scrolling.
  // A blur long after the last render is the reader moving on (a click elsewhere), and is left alone. A row removed
  // and re-inserted by a render either fires no blur, or fires it during that render's commit.
  const focused = useRef<{ id: string; at: number; blurredAt: number } | null>(null);
  useLayoutEffect(() => {
    const entry = focused.current;
    if (!entry || !visible || (document.activeElement && document.activeElement !== document.body)) return;
    if (entry.blurredAt > entry.at && performance.now() - entry.blurredAt > 50) return;
    root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(entry.id)}"]`)?.focus({ preventScroll: true });
  });
  const actions = useMemo<RowActions>(
    () => ({
      open,
      focus: (id) => {
        focused.current = { id, at: performance.now(), blurredAt: 0 };
        setCurrent(id);
      },
      blur: () => {
        if (focused.current) focused.current.blurredAt = performance.now();
      },
      snooze: (row) => void snooze(row),
      markRead: (row) => callbacks.current.onMarkRead(row.entries.map((entry) => entry.member.url)),
      refresh: () => callbacks.current.onRefresh(),
      keyDown: onRowKeyDown,
    }),
    [open, snooze, onRowKeyDown]
  );
  const jump = (lane: OverviewLane) => {
    if (lane === 'waiting') setWaitingOpen(true);
    requestAnimationFrame(() => {
      const heading = root.current?.querySelector<HTMLElement>(`#overview-lane-${lane} [data-lane-heading]`);
      // Scroll only the Overview's own list: scrollIntoView would also move the window's fixed layout.
      const body = root.current?.querySelector<HTMLElement>('.overview-body');
      const section = heading?.closest<HTMLElement>('.overview-lane');
      if (body && section) body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
      heading?.focus({ preventScroll: true });
    });
  };

  const sync = queue.sync;
  const allClear = ACTION_LANES.every((lane) => !model.counts[lane]);
  const readStates = queue.readStates ?? {};
  const unread = (row: OverviewRow) => row.entries.some((entry) => !!readStates[entry.member.url]?.unread.length);
  const body = !authenticated ? (
    <div className="overview-state">
      <p>Connect GitHub to see what needs you across your repositories.</p>
      <Button size="sm" variant="outline" onClick={onConnect}>Connect GitHub</Button>
    </div>
  ) : loading && !queue.items.length ? (
    <LoadingState title="Loading your work…" compact />
  ) : !queue.items.length && !hasRepositories ? (
    <div className="overview-state">
      <p>No repositories yet. Add the repositories you work in, and their PRs show up here.</p>
      <Button size="sm" variant="outline" onClick={onRepositories}>
        <Settings size={14} aria-hidden="true" />
        Settings › Repositories
      </Button>
    </div>
  ) : (
    <>
      {setup && (
        <div className="setup-resume">
          <span>Finish setting up Gnosis. Getting started is in the review queue.</span>
          <Button size="sm" variant="outline" onClick={setup}>Getting started</Button>
        </div>
      )}
      <nav className="overview-counts" aria-label="Lanes">
        {model.lanes.map(({ lane }, index) => (
          <Fragment key={lane}>
            {index > 0 && <span className="overview-count-separator" aria-hidden="true">·</span>}
            <button type="button" className="overview-count" data-lane={lane} data-empty={model.counts[lane] ? undefined : ''} onClick={() => jump(lane)}
              aria-label={`${OVERVIEW_LANE_LABEL[lane]}: ${model.counts[lane]}. Go to the lane.`}>
              <span>{OVERVIEW_COUNT_LABEL[lane]}</span>
              <span className="overview-count-value">{model.counts[lane]}</span>
            </button>
          </Fragment>
        ))}
      </nav>
      {allClear ? (
        <p className="overview-clear" role="status">
          <CircleCheck size={16} aria-hidden="true" />
          All clear. Nothing needs you right now.
        </p>
      ) : (
        ACTION_LANES.map((lane) => (
          <Lane key={lane} lane={lane} rows={model.lanes.find((state) => state.lane === lane)?.rows ?? []} tabStop={tabStop} actions={actions} unread={unread} onShowLane={onShowLane} />
        ))
      )}
      <Lane lane="waiting" rows={model.lanes.find((state) => state.lane === 'waiting')?.rows ?? []} tabStop={tabStop} actions={actions} unread={unread}
        onShowLane={onShowLane} collapsed={!waitingOpen} onToggle={() => setWaitingOpen((value) => !value)} />
      {model.unchecked > 0 && (
        <p className="overview-caption">
          Status not checked yet for {model.unchecked} of your PRs. They join a lane when GitHub reports it.
        </p>
      )}
      <p className="sr-only" id="overview-keyboard-help">
        <kbd>j</kbd> <kbd>k</kbd> or arrows move · <kbd>Enter</kbd> opens · <kbd>a</kbd> runs the row action · <kbd>z</kbd> snoozes
      </p>
    </>
  );
  return (
    <div className="overview" ref={root} aria-labelledby="overview-title" role="region">
      <div className="queue-toolbar overview-toolbar">
        <div>
          <h1 id="overview-title">Overview</h1>
          <p>What you can act on now, across your repositories.</p>
        </div>
        <div className="flex items-center gap-2">
          <PrFreshness className="queue-freshness" queue checkedAt={sync?.checkedAt} refreshing={refreshing} />
          <button className="workbench-icon" aria-label="Refresh overview" title="Update from GitHub. Follow progress in Activity." onClick={onRefresh}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && (
        <div className="workbench-notice error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
          {onDismissError && (
            <button aria-label="Dismiss error" onClick={onDismissError}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {authenticated && sync && (sync.status === 'paused' || sync.status === 'error') && (
        <div className="workbench-notice overview-notice" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <span>
            {sync.status === 'paused'
              ? `GitHub is rate-limited. Showing saved data${sync.retryAt ? `; updates resume at ${clock(sync.retryAt)}` : ''}.`
              : 'Could not reach GitHub. Showing saved data.'}
          </span>
          {sync.status === 'error' && <button onClick={onRefresh}>Retry</button>}
        </div>
      )}
      <div className="overview-body">{body}</div>
    </div>
  );
}

interface RowActions {
  open: (row: OverviewRow) => void;
  focus: (id: string) => void;
  blur: () => void;
  snooze: (row: OverviewRow) => void;
  markRead: (row: OverviewRow) => void;
  refresh: () => void;
  keyDown: (event: ReactKeyboardEvent) => void;
}

function Lane({ lane, rows, tabStop, actions, unread, onShowLane, collapsed, onToggle }: {
  lane: OverviewLane;
  rows: OverviewRow[];
  tabStop: string | null;
  actions: RowActions;
  unread: (row: OverviewRow) => boolean;
  onShowLane: (lane: OverviewLane) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const id = useId();
  const listId = `${id}-rows`;
  const empty = !rows.length;
  const shown = rows.slice(0, OVERVIEW_LANE_LIMIT);
  const label = OVERVIEW_LANE_LABEL[lane];
  return (
    <section id={`overview-lane-${lane}`} className={`overview-lane${empty ? ' is-empty' : ''}`} aria-labelledby={`${id}-heading`} data-lane={lane}>
      <div className="overview-lane-heading">
        <h2 id={`${id}-heading`}>
          {onToggle && !empty ? (
            <button type="button" className="overview-lane-toggle" data-lane-heading aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
              <ChevronRight size={14} aria-hidden="true" />
              {label}
            </button>
          ) : (
            <span tabIndex={-1} data-lane-heading>{label}</span>
          )}
        </h2>
        {empty ? (
          <span className="overview-empty">{OVERVIEW_EMPTY[lane]}</span>
        ) : (
          <button type="button" className="overview-lane-total" onClick={() => onShowLane(lane)}
            title={`Open the ${rows.length} ${rows.length === 1 ? 'item' : 'items'} in ${label} in the review queue`}
            aria-label={`${label}: open all ${rows.length} in the review queue`}>
            {rows.length}
          </button>
        )}
      </div>
      {!empty && !collapsed && (
        <ul className="overview-rows" id={listId}>
          {shown.map((row) => (
            <OverviewRowView key={row.id} row={row} tabStop={row.id === tabStop} unread={unread(row)} actions={actions} />
          ))}
        </ul>
      )}
      {!empty && !collapsed && rows.length > OVERVIEW_LANE_LIMIT && (
        <button type="button" className="overview-show-all" onClick={() => onShowLane(lane)}>
          Show all {rows.length}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

const OverviewRowView = memo(
  function OverviewRowView({ row, tabStop, unread, actions }: { row: OverviewRow; tabStop: boolean; unread: boolean; actions: RowActions }) {
    if (window.__countRenders) window.__overviewRowRenders = (window.__overviewRowRenders ?? 0) + 1;
    const reasons = rowReasons(row);
    const member = row.focus;
    const stack = row.kind === 'stack';
    const groups: EntryActionGroups = [
      [{ label: 'Open', run: () => actions.open(row) }],
      [
        { label: stack ? 'Snooze stack…' : 'Snooze PR…', run: () => actions.snooze(row) },
        { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(row) },
      ],
      [{ label: 'Open on GitHub', run: () => void window.electronAPI.openExternal(member.url) }],
    ];
    const since = new Date(row.since);
    return (
      <li className={`overview-row${row.isNew ? ' is-new' : ''}`} data-overview-row-item={row.id}>
        <EntryActions label={stack ? `Actions for stack ${row.title}` : `Actions for PR #${member.number}`} groups={groups}>
          {(menu) => (
            <div className="overview-row-inner">
              <span className="overview-row-gutter">
                {row.isNew && <span className="pr-unread-dot" role="img" aria-label="New since your last visit" title="New since your last visit" />}
              </span>
              <span className="overview-row-icon">
                {stack ? <Layers size={16} aria-label="PR stack" className="queue-stack-icon" /> : <PrStateIcon pr={member} size={16} />}
              </span>
              <div className="overview-row-content">
                <button
                  type="button"
                  className="overview-row-main"
                  data-overview-row={row.id}
                  tabIndex={tabStop ? 0 : -1}
                  aria-describedby="overview-keyboard-help"
                  onFocus={() => actions.focus(row.id)}
                  onBlur={actions.blur}
                  onKeyDown={actions.keyDown}
                  onClick={(event: ReactMouseEvent) => {
                    event.preventDefault();
                    actions.open(row);
                  }}
                >
                  <span className="overview-title">{row.title}</span>
                  {stack && row.stackSize && (
                    <span className="overview-stack-count">
                      {row.entries.length === row.stackSize ? `${row.stackSize} PRs` : `${row.entries.length} of ${row.stackSize} PRs`}
                    </span>
                  )}
                </button>
                <div className="overview-row-meta">
                  {reasons.map((reason) => {
                    const { icon: Icon, tone } = reasonIcon(reason);
                    return (
                      <span key={reason} className="overview-reason" data-tone={tone}>
                        <Icon size={13} aria-hidden="true" />
                        {OVERVIEW_REASON_LABEL[reason]}
                      </span>
                    );
                  })}
                  <RepositoryBadge repo={member.repo} />
                  {stack ? (
                    <span className="overview-numbers">{row.entries.map((entry) => `#${entry.member.number}`).join(', ')}</span>
                  ) : (
                    <PrBadge url={member.url} number={member.number} title={member.title} />
                  )}
                  <GitHubAuthor login={row.person} />
                  {row.additions !== undefined && row.deletions !== undefined && (
                    <span className="overview-size" title={`${row.additions} lines added, ${row.deletions} removed${row.files !== undefined ? `, ${row.files} files` : ''}`}>
                      <DiffStats additions={row.additions} deletions={row.deletions} />
                      {row.files !== undefined && <span>{row.files} {row.files === 1 ? 'file' : 'files'}</span>}
                    </span>
                  )}
                  {row.explanation && (
                    <span className="overview-explanation">
                      <BookOpen size={13} aria-hidden="true" />
                      Explanation ready
                    </span>
                  )}
                </div>
              </div>
              <span className={`overview-wait${row.stale ? ' is-stale' : ''}`}
                title={`Waiting ${OVERVIEW_SINCE_LABEL[row.source]}, ${since.toLocaleString()}`}>
                <Clock3 size={13} aria-hidden="true" />
                <time dateTime={since.toISOString()}>{row.waiting}</time>
                {row.stale && <span className="overview-stale">Stale</span>}
              </span>
              <span className="overview-row-action">
                <QuickAction row={row} actions={actions} />
              </span>
              {menu}
            </div>
          )}
        </EntryActions>
      </li>
    );
  },
  (a, b) => a.row.signature === b.row.signature && a.tabStop === b.tabStop && a.unread === b.unread && a.actions === b.actions
);

function QuickAction({ row, actions }: { row: OverviewRow; actions: RowActions }) {
  const shortcut = { 'data-quick-action': true, 'aria-keyshortcuts': 'A' };
  if (row.lane === 'merge') {
    // Base first: in a stack, the lowest ready PR merges first.
    const member = row.item.subject.members.find((candidate) => row.entries.some((entry) => entry.member.url === candidate.url)) ?? row.focus;
    return (
      <PrActions
        member={member}
        compact
        onChanged={actions.refresh}
        onResult={(message) => toast.add({ type: 'success', title: message })}
        trigger={(open, busy) => (
          <Button size="sm" variant="outline" {...shortcut} title={`Merge #${member.number}… · A`} disabled={busy} onClick={() => open('merge')}>
            <GitMerge size={14} aria-hidden="true" />
            Merge
          </Button>
        )}
      />
    );
  }
  const failed = row.lane === 'fix' ? row.entries.filter((entry) => entry.reasons.includes('checks-failed')).map((entry) => entry.member) : [];
  if (failed.length) return <RerunFailed members={failed} onChanged={actions.refresh} />;
  const label = row.lane === 'review' ? 'Review' : row.lane === 'answer' ? 'Open thread' : 'Open';
  return (
    <Button size="sm" variant="outline" {...shortcut} title={`${label} · A`} onClick={() => actions.open(row)}>
      {label}
    </Button>
  );
}

function RerunFailed({ members, onChanged }: { members: ReviewMember[]; onChanged: () => void }) {
  const load = useCallback(async () => {
    const values: Partial<Record<string, PrChecks>> = {};
    await Promise.all(
      members.map(async (member) => {
        const value = await window.electronAPI.getPrChecks({ url: member.url, headSha: member.headSha }, { opened: true });
        if (value) values[member.url] = value;
      })
    );
    return values;
  }, [members]);
  return (
    <BulkCheckRerun
      members={members}
      values={{}}
      onChanged={onChanged}
      load={load}
      trigger={(open, busy) => (
        <Button size="sm" variant="outline" data-quick-action aria-keyshortcuts="A" title="Re-run failed jobs… · A" disabled={busy} onClick={open}>
          <RotateCcw size={14} aria-hidden="true" />
          {busy ? 'Reading checks…' : 'Rerun failed'}
        </Button>
      )}
    />
  );
}

declare global {
  interface Window {
    /** Browser checks count Overview row renders when `__countRenders` is set. */
    __overviewRowRenders?: number;
  }
}
