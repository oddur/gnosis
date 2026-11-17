/**
 * The Overview (#390): a front page for what you can act on now, across every repository. A briefing sentence says
 * who is waiting on you and what is ready; four lane tiles (Answer, Review / Merge, Fix) show each lane's count, its
 * summary and its three oldest items. A tile, its count or "All N" opens the queue grouped by Action at that lane.
 * Lanes, tiles and the sentence come from `lib/overview.ts` over the window's queue snapshot.
 *
 * Items are title links with their age. Repository, PR and reason show on hover or focus, at the foot of the tile,
 * and in each item's accessible description. The quick action (Merge, Rerun failed, Review, Open thread) and the item
 * menu appear on hover and focus; A and Z work on the focused item. Quick actions reuse the merge confirmation
 * (`PrActions`), the rerun path (`BulkCheckRerun`) and the notification targets.
 *
 * Items are memoized on their `signature`, so a sync tick renders only the items it changed. Live updates keep focus:
 * items keep their keys, and an item that React moved gets its focus back without scrolling.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { AlertCircle, ChevronRight, GitMerge, RefreshCw, RotateCcw, Settings, X } from 'lucide-react';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useOverview } from '../lib/use-overview';
import { publishOverviewCount } from '../lib/overview-count';
import {
  OVERVIEW_ACTION_GROUP_LABEL,
  OVERVIEW_EMPTY,
  OVERVIEW_LANE_LABEL,
  OVERVIEW_SINCE_LABEL,
  overviewBriefing,
  overviewCountChange,
  overviewRowDescription,
  overviewRowDetail,
  overviewTiles,
  type OverviewActionGroup,
  type OverviewLane,
  type OverviewModel,
  type OverviewRow,
  type OverviewTile,
} from '../lib/overview';
import { openSnoozePicker } from '../lib/snooze-picker';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import type { PrChecks } from '../lib/pr-checks';
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
  /** Status stays current: shown, or resolving the queue's lane filter or Action grouping. */
  live: boolean;
  /** Keys move through items. Off while a dialog, setup or another surface owns the keyboard. */
  keyboard: boolean;
  teamRequests?: boolean;
  excluded?: ReadonlySet<string>;
  /** The home screen's error, such as a failed Mark as read. */
  error?: string;
  onDismissError?: () => void;
  /** Getting started has not been dismissed: offer it, since it lives in the queue. */
  setup?: () => void;
  onRefresh: () => void;
  /** Opens the queue grouped by Action, at this group. */
  onShowLane: (group: OverviewActionGroup) => void;
  onMarkRead: (urls: string[]) => void;
  /** Opens an item in this window when no workspace tabs are available. */
  onOpenItem: (item: QueueItem) => void;
  onRepositories: () => void;
  onConnect: () => void;
  /** The lanes, for the queue's lane filter and Action grouping. */
  onModel?: (model: OverviewModel) => void;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** The lane an item id belongs to: ids are `${lane}|${subject}`. */
const laneOf = (id: string) => id.slice(0, id.indexOf('|')) as OverviewLane;

export function OverviewPage(props: OverviewPageProps) {
  const { queue, login, scope, authenticated, hasRepositories, loading, refreshing, visible, live, keyboard, teamRequests, excluded, error, onDismissError, setup, onRefresh, onShowLane, onRepositories, onConnect, onModel } = props;
  const model = useOverview({ items: queue.items, login: authenticated ? login : null, scope: authenticated ? scope : null, live, visible, ready: !loading, teamRequests, excluded });
  useEffect(() => { onModel?.(model); }, [model, onModel]);
  // The tab title counts the four action lanes, Ready merges only (lib/overview-count.ts).
  const account = authenticated ? login : null;
  useEffect(() => {
    if (account && !loading) publishOverviewCount(account, model.actionable);
  }, [account, loading, model.actionable]);
  const navigation = useWorkspaceNavigation();
  // The home screen passes new callbacks on every render. Items read them through this ref, so a home screen render
  // never renders the items again.
  const callbacks = useRef(props);
  callbacks.current = props;
  const root = useRef<HTMLDivElement>(null);
  const tiles = useMemo(() => overviewTiles(model), [model]);
  const briefing = useMemo(() => overviewBriefing(model), [model]);
  // One roving tab stop per tile: the item last focused there, else its first.
  const [current, setCurrent] = useState<Partial<Record<OverviewLane, string>>>({});
  const latestTiles = useRef(tiles);
  latestTiles.current = tiles;
  const tileRows = (lane: OverviewLane) => latestTiles.current.find((tile) => tile.lane === lane)?.rows ?? [];

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
    setCurrent((value) => (value[laneOf(id)] === id ? value : { ...value, [laneOf(id)]: id }));
    root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
  }, []);
  // j/k and the arrows move within the focused tile. With nothing focused, they start at the first (or last) item.
  const move = useCallback(
    (direction: 1 | -1) => {
      const active = document.activeElement?.closest<HTMLElement>('[data-overview-row]')?.dataset.overviewRow;
      if (!active) {
        const all = latestTiles.current.flatMap((tile) => tile.rows);
        focusRow((direction > 0 ? all.at(0) : all.at(-1))?.id);
        return;
      }
      const rows = tileRows(laneOf(active));
      const index = rows.findIndex((row) => row.id === active);
      focusRow(rows.at(Math.max(0, Math.min(rows.length - 1, index + direction)))?.id);
    },
    [focusRow]
  );
  const snooze = useCallback(
    (row: OverviewRow) => {
      const rows = tileRows(row.lane);
      const index = rows.findIndex((entry) => entry.id === row.id);
      const next = rows.at(index + 1) ?? (index > 0 ? rows.at(index - 1) : undefined);
      return openSnoozePicker({
        groups: [row.item.subject.members],
        onSnoozed: () => requestAnimationFrame(() => focusRow(next?.id ?? latestTiles.current.find((tile) => tile.lane === row.lane)?.rows[0]?.id)),
      });
    },
    [focusRow]
  );
  const currentRow = () => {
    const id = document.activeElement?.closest<HTMLElement>('[data-overview-row-item]')?.dataset.overviewRowItem;
    return id ? tileRows(laneOf(id)).find((row) => row.id === id) : undefined;
  };
  useKeyboardShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      // The item's one quick action: Merge, Rerun failed, Review or Open thread.
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
        const id = (event.currentTarget as HTMLElement).dataset.overviewRow;
        const rows = id ? tileRows(laneOf(id)) : [];
        focusRow(event.key === 'Home' ? rows[0]?.id : rows.at(-1)?.id);
      }
    },
    [move, focusRow]
  );
  // A live update can move the focused item's element; React re-inserts it and the browser drops focus. Give it back
  // in place, without scrolling.
  // A blur long after the last render is the reader moving on (a click elsewhere), and is left alone. An item removed
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
        setCurrent((value) => (value[laneOf(id)] === id ? value : { ...value, [laneOf(id)]: id }));
      },
      blur: () => {
        if (focused.current) focused.current.blurredAt = performance.now();
      },
      snooze: (row) => void snooze(row),
      markRead: (row) => callbacks.current.onMarkRead(row.entries.map((entry) => entry.member.url)),
      refresh: () => callbacks.current.onRefresh(),
      copy: (text, what) =>
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => toast.add({ type: 'success', title: `${what} copied`, description: text }),
            () => toast.add({ type: 'error', title: `Could not copy the ${what.toLowerCase()}`, description: 'Try again.' })
          ),
      keyDown: onRowKeyDown,
    }),
    [open, snooze, onRowKeyDown]
  );
  const showGroup = useCallback((group: OverviewActionGroup) => callbacks.current.onShowLane(group), []);

  const sync = queue.sync;
  const readStates = queue.readStates ?? {};
  const unread = (row: OverviewRow) => row.entries.some((entry) => !!readStates[entry.member.url]?.unread.length);
  const ready = authenticated && !(loading && !queue.items.length) && !(!queue.items.length && !hasRepositories);
  const others = [
    { group: 'waiting' as const, count: model.counts.waiting },
    { group: 'parked' as const, count: model.parked },
  ].filter((entry) => entry.count > 0);
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
      <div className="overview-tiles">
        {tiles.map((tile) => (
          <Tile key={tile.lane} tile={tile} tabStop={tile.rows.some((row) => row.id === current[tile.lane]) ? current[tile.lane] : tile.rows[0]?.id}
            actions={actions} unread={unread} onShow={showGroup} />
        ))}
      </div>
      {others.length > 0 && (
        <p className="overview-others">
          {others.map(({ group, count }, index) => (
            <span key={group}>
              {index > 0 && <span className="overview-others-separator" aria-hidden="true">·</span>}
              <button type="button" className="overview-others-link" data-group={group} onClick={() => showGroup(group)}
                aria-label={`${OVERVIEW_ACTION_GROUP_LABEL[group]}: ${count}. Open in the review queue, grouped by action`}>
                {OVERVIEW_ACTION_GROUP_LABEL[group]} <span className="overview-others-count">{count}</span>
              </button>
            </span>
          ))}
        </p>
      )}
      <p className="sr-only" id="overview-keyboard-help">
        <kbd>Tab</kbd> moves between tiles · <kbd>j</kbd> <kbd>k</kbd> or arrows move within a tile · <kbd>Enter</kbd> opens · <kbd>a</kbd> runs the
        item's action · <kbd>z</kbd> snoozes · <kbd>Shift</kbd>+<kbd>F10</kbd> opens its menu
      </p>
    </>
  );
  const announcement = useCountAnnouncement(model.counts, visible && authenticated && !loading);
  return (
    // The keyboard help is given once, on the region, not on every item.
    <div className="overview" ref={root} aria-labelledby="overview-title" aria-describedby="overview-keyboard-help" role="region">
      <div className="queue-toolbar overview-toolbar">
        <div>
          <h1 id="overview-title">Overview</h1>
          {/* A status region that is not live: count changes are announced once, by the region below. */}
          <p className="overview-briefing" role="status" aria-live="off" data-overview-briefing>
            {ready ? briefing : 'What you can act on now, across your repositories.'}
          </p>
        </div>
        <div className="overview-freshness-group">
          {authenticated && model.unchecked > 0 && (
            <span className="overview-unchecked" title={`Status not checked yet for ${model.unchecked} of your PRs. They join a lane when GitHub reports it.`}>
              {model.unchecked} not checked
            </span>
          )}
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
      <p className="sr-only" role="status" aria-live="polite" data-overview-announcement>{announcement}</p>
    </div>
  );
}

/** Settles this long before a count change is announced, so a burst of sync updates is one announcement. */
const ANNOUNCE_SETTLE_MS = 1200;
/** Count changes this soon after the Overview shows are status loading, and only move the baseline. */
const BASELINE_SETTLE_MS = 3000;

/**
 * A short, polite announcement when lane counts change while the Overview is shown: "Fix 3, was 2." The first counts
 * after showing are the baseline, so opening the Overview or a sync that changes nothing says nothing.
 */
function useCountAnnouncement(counts: OverviewModel['counts'], active: boolean): string {
  const [message, setMessage] = useState('');
  const baseline = useRef<OverviewModel['counts'] | null>(null);
  const shownAt = useRef(0);
  useEffect(() => {
    if (!active) {
      baseline.current = null;
      return;
    }
    // Saved status arrives just after the Overview shows: counts settling then are the baseline, not news.
    if (!baseline.current || performance.now() - shownAt.current < BASELINE_SETTLE_MS) {
      if (!baseline.current) shownAt.current = performance.now();
      baseline.current = counts;
      return;
    }
    const before = baseline.current;
    if (!overviewCountChange(before, counts)) return;
    const timer = window.setTimeout(() => {
      baseline.current = counts;
      setMessage(overviewCountChange(before, counts));
    }, ANNOUNCE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [counts, active]);
  return active ? message : '';
}

interface RowActions {
  open: (row: OverviewRow) => void;
  focus: (id: string) => void;
  blur: () => void;
  snooze: (row: OverviewRow) => void;
  markRead: (row: OverviewRow) => void;
  refresh: () => void;
  /** Copies `text`; `what` names it in the confirmation: "Link copied". */
  copy: (text: string, what: string) => void;
  keyDown: (event: ReactKeyboardEvent) => void;
}

/**
 * One lane: its count, name and summary, its three oldest items, and "All N". An empty tile keeps its place in the
 * grid with a count of 0 and one line, so the layout never moves.
 */
function Tile({ tile, tabStop, actions, unread, onShow }: {
  tile: OverviewTile;
  tabStop: string | undefined;
  actions: RowActions;
  unread: (row: OverviewRow) => boolean;
  onShow: (group: OverviewActionGroup) => void;
}) {
  const id = useId();
  const { lane, count, rows, summary } = tile;
  const label = OVERVIEW_LANE_LABEL[lane];
  const empty = count === 0;
  // The item the pointer rests on, else the focused one, names its details at the foot of the tile.
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const detailRow = rows.find((row) => row.id === (hovered ?? focusedId));
  return (
    <section id={`overview-lane-${lane}`} className="overview-tile" data-lane={lane} data-empty={empty ? '' : undefined} aria-labelledby={`${id}-heading`}
      onClick={(event: ReactMouseEvent) => {
        // The tile itself opens the lane; its items, actions and menus do their own thing.
        if (empty || (event.target as HTMLElement).closest('button, a, input, [role=menu], .overview-tile-item')) return;
        onShow(lane);
      }}>
      <div className="overview-tile-head">
        <span className="overview-tile-count" aria-hidden="true">{count}</span>
        <div className="overview-tile-titles">
          <h2 id={`${id}-heading`}>
            {label}
            <span className="sr-only">{`, ${count}${summary.length ? `, ${summary.join(', ')}` : ''}`}</span>
          </h2>
          {(empty || summary.length > 0) && (
            <p className="overview-tile-summary" aria-hidden={empty ? undefined : true}>{empty ? OVERVIEW_EMPTY[lane] : summary.join(' · ')}</p>
          )}
        </div>
      </div>
      {rows.length > 0 && (
        <ul className="overview-tile-items" aria-label={`${label}, oldest first`}>
          {rows.map((row) => (
            <TileItem key={row.id} row={row} tabStop={row.id === tabStop} unread={unread(row)} actions={actions} onHover={setHovered} onFocusItem={setFocusedId} />
          ))}
        </ul>
      )}
      {!empty && (
        <div className="overview-tile-foot">
          <span className="overview-tile-detail" aria-hidden="true" data-overview-detail>{detailRow ? overviewRowDetail(detailRow) : ''}</span>
          <button type="button" className="overview-tile-all" onClick={() => onShow(lane)} aria-label={`All ${count} in ${label}. Open in the review queue, grouped by action`}>
            All {count}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

const TileItem = memo(
  function TileItem({ row, tabStop, unread, actions, onHover, onFocusItem }: {
    row: OverviewRow;
    tabStop: boolean;
    unread: boolean;
    actions: RowActions;
    onHover: (id: string | null) => void;
    onFocusItem: (id: string | null) => void;
  }) {
    if (window.__countRenders) { window.__overviewRowRenders = (window.__overviewRowRenders ?? 0) + 1; (window.__overviewRenderedRows ??= []).push(row.id); }
    const member = row.focus;
    const stack = row.kind === 'stack';
    const numbers = row.item.subject.members.filter((candidate) => row.entries.some((entry) => entry.member.url === candidate.url)).map((candidate) => `#${candidate.number}`);
    const groups: EntryActionGroups = [
      [{ label: 'Open', run: () => actions.open(row) }],
      [
        { label: stack ? 'Snooze stack…' : 'Snooze PR…', run: () => actions.snooze(row) },
        { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(row) },
      ],
      // The item shows only its title; copying lives here.
      [
        { label: 'Copy link', run: () => actions.copy(member.url, 'Link') },
        { label: 'Copy repository', run: () => actions.copy(member.repo, 'Repository') },
        { label: numbers.length > 1 ? 'Copy PR numbers' : 'Copy PR number', run: () => actions.copy(numbers.length > 1 ? numbers.join(', ') : `#${member.number}`, numbers.length > 1 ? 'PR numbers' : 'PR number') },
      ],
      [{ label: 'Open on GitHub', run: () => void window.electronAPI.openExternal(member.url) }],
    ];
    const since = new Date(row.since);
    const descriptionId = useId();
    const detail = overviewRowDetail(row);
    return (
      <li className={`overview-tile-item${row.isNew ? ' is-new' : ''}`} data-overview-row-item={row.id}
        onPointerEnter={() => onHover(row.id)} onPointerLeave={() => onHover(null)}>
        <EntryActions label={stack ? `Actions for stack ${row.title}` : `Actions for PR #${member.number}`} groups={groups} triggerTabIndex={-1}>
          {(menu) => (
            <div className="overview-tile-item-inner">
              <span className="overview-row-gutter">
                {row.isNew && <span className="pr-unread-dot" role="img" aria-label="New since your last visit" title="New since your last visit" />}
              </span>
              <button
                type="button"
                className="overview-tile-title"
                data-overview-row={row.id}
                tabIndex={tabStop ? 0 : -1}
                aria-describedby={descriptionId}
                title={`${row.title}\n${detail}`}
                onFocus={() => {
                  actions.focus(row.id);
                  onFocusItem(row.id);
                }}
                onBlur={() => {
                  actions.blur();
                  onFocusItem(null);
                }}
                onKeyDown={actions.keyDown}
                onClick={(event: ReactMouseEvent) => {
                  event.preventDefault();
                  actions.open(row);
                }}
              >
                {row.title}
              </button>
              <span className="sr-only" id={descriptionId} data-overview-description>{overviewRowDescription(row)}</span>
              <time className="overview-tile-age" dateTime={since.toISOString()} title={`Waiting ${OVERVIEW_SINCE_LABEL[row.source]}, ${since.toLocaleString()}`}>
                {row.waiting}
              </time>
              <span className="overview-tile-actions">
                <QuickAction row={row} actions={actions} />
                {menu}
              </span>
            </div>
          )}
        </EntryActions>
      </li>
    );
  },
  (a, b) => a.row.signature === b.row.signature && a.tabStop === b.tabStop && a.unread === b.unread && a.actions === b.actions && a.onHover === b.onHover && a.onFocusItem === b.onFocusItem
);

/** Out of the tab order: Tab moves between tiles, and A runs the focused item's action. */
const SHORTCUT = { 'data-quick-action': true, 'aria-keyshortcuts': 'A', tabIndex: -1 };

function QuickAction({ row, actions }: { row: OverviewRow; actions: RowActions }) {
  if (row.lane === 'merge') {
    // Base first: in a stack, the lowest PR in the lane merges first (`OverviewMerge.member`).
    const member = row.merge?.member ?? row.focus;
    return (
      <PrActions
        member={member}
        compact
        onChanged={actions.refresh}
        onResult={(message) => toast.add({ type: 'success', title: message })}
        trigger={(open, busy) => (
          <Button size="xs" variant="outline" {...SHORTCUT} title={`Merge #${member.number}… · A`} disabled={busy} onClick={() => open('merge')}>
            <GitMerge size={13} aria-hidden="true" />
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
    <Button size="xs" variant="outline" {...SHORTCUT} title={`${label} · A`} onClick={() => actions.open(row)}>
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
        <Button size="xs" variant="outline" {...SHORTCUT} title="Re-run failed jobs… · A" disabled={busy} onClick={open}>
          <RotateCcw size={13} aria-hidden="true" />
          {busy ? 'Reading checks…' : 'Rerun failed'}
        </Button>
      )}
    />
  );
}

declare global {
  interface Window {
    /** Browser checks count Overview item renders when `__countRenders` is set. */
    __overviewRowRenders?: number;
    /** The items those renders were for. */
    __overviewRenderedRows?: string[];
  }
}
