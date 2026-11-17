/**
 * The Overview (#390): the morning page. It answers, in order, what happened since you left, what you can finish
 * now, who is blocked on you, where your PRs are stuck and on whom, and what to close or park.
 *
 * - The briefing sentence and a "Since yesterday" line (`lib/since-log.ts`).
 * - **Move forward now:** quick wins across lanes, cheapest first, each with one action and why it is quick.
 * - **Waiting on you** and **Waiting on others**, side by side: people, and your PRs by blocker, with Nudge.
 * - **Needs a decision:** your PRs failing, never approved or idle for over a week, with Close PR and Snooze.
 *
 * Sections come from `lib/morning.ts` over the lanes of `lib/overview.ts`. Each section is a labelled region with one
 * roving tab stop: Tab moves between sections, j/k and the arrows move within one, Enter opens (or expands a
 * person), A runs the row's action and Z snoozes. Rows describe themselves to assistive technology, and count
 * changes are announced once by a polite live region. Rows are memoized on their signature, so a sync tick that
 * changes nothing renders nothing, and a moved row gets its focus back without scrolling.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, ChevronRight, GitMerge, RefreshCw, Settings, X } from 'lucide-react';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useOverview } from '../lib/use-overview';
import { useMorningExtras } from '../lib/use-morning';
import { useStatusNow } from '../lib/status-clock';
import { publishOverviewCount } from '../lib/overview-count';
import { overviewBriefing, overviewRef, waitingLabel, spokenWaiting, type OverviewActionGroup, type OverviewModel, type OverviewRow } from '../lib/overview';
import {
  effortLabel,
  moveForward,
  moveMinutes,
  morningCount,
  needsDecision,
  waitingOnOthers,
  waitingOnYou,
  waitingOnYouCount,
  type DecisionItem,
  type MoveItem,
  type PersonGroup,
} from '../lib/morning';
import { sinceLine, sinceSummary } from '../lib/since-log';
import { openSnoozePicker } from '../lib/snooze-picker';
import { writeErrorDetail } from '../lib/write-failures';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { PrActions } from './PrActions';
import { PrFreshness } from './PrFreshness';
import { LoadingIndicator, LoadingState } from './LoadingState';
import { ClosePrDialog, NudgeDialog } from './OverviewWrites';
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
  /**
   * Asks main for a queue sync without forcing one: main starts discovery only when its last one is over 2 minutes
   * old. Called when the Overview shows, or stays shown, with a last sync older than `SYNC_STALE_MS`.
   */
  onSync?: () => void;
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
/**
 * A last sync older than this is behind: main finishes discovery every 2 to 5 minutes while a window is visible
 * (src/main.ts, `discoveryInterval`). The Overview then asks for a sync, at most once per `SYNC_STALE_MS`.
 */
export const SYNC_STALE_MS = 10 * 60_000;
const syncStale = (checkedAt: number | undefined) => checkedAt !== undefined && Date.now() - checkedAt > SYNC_STALE_MS;

type Section = 'move' | 'you' | 'others' | 'decide';
const SECTIONS: readonly Section[] = ['move', 'you', 'others', 'decide'];
const SECTION_LABEL: Readonly<Record<Section, string>> = {
  move: 'Move forward now',
  you: 'Waiting on you',
  others: 'Waiting on others',
  decide: 'Needs a decision',
};
/** Needs a decision lists this many before "Show all". */
const DECIDE_SHOWN = 6;
/** The section a row id belongs to: ids are `${section}|…`. */
const sectionOf = (id: string) => id.slice(0, id.indexOf('|')) as Section;
const prs = (n: number) => `${n} ${n === 1 ? 'PR' : 'PRs'}`;
const groupLabel = (group: PersonGroup) => (group.kind === 'you' ? 'You' : group.kind === 'review' ? 'Needs a reviewer' : group.label);

/** What a row is: how it opens, what it acts on, and how it snoozes. */
interface RowRef {
  row?: OverviewRow;
  members: ReviewMember[];
}

export function OverviewPage(props: OverviewPageProps) {
  const { queue, login, scope, authenticated, hasRepositories, loading, refreshing, visible, live, keyboard, teamRequests, excluded, error, onDismissError, setup, onRefresh, onRepositories, onConnect, onModel } = props;
  const view = useOverview({ items: queue.items, login: authenticated ? login : null, scope: authenticated ? scope : null, live, visible, ready: !loading, teamRequests, excluded });
  useEffect(() => { onModel?.(view); }, [view, onModel]);
  const account = authenticated ? login : null;
  const extras = useMorningExtras(view, account, visible);
  const now = useStatusNow() || Date.now();
  const navigation = useWorkspaceNavigation();
  // The home screen passes new callbacks on every render. Rows read them through this ref, so a home screen render
  // never renders the rows again.
  const callbacks = useRef(props);
  callbacks.current = props;
  // A last sync that is behind asks main for another while the Overview shows: on showing, and as the clock passes.
  const syncAsked = useRef(0);
  useEffect(() => {
    const sync = queue.sync;
    if (!visible || !authenticated || loading || !sync || sync.status === 'checking' || sync.status === 'paused') return;
    if (!syncStale(sync.checkedAt) || Date.now() - syncAsked.current < SYNC_STALE_MS) return;
    syncAsked.current = Date.now();
    callbacks.current.onSync?.();
  }, [visible, authenticated, loading, queue.sync, now]);

  // PRs closing on GitHub leave the page at once; a refusal brings them back.
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [nudged, setNudged] = useState<ReadonlySet<string>>(new Set());
  const morning = useMemo(() => {
    const input = { model: view, now, login: account ?? '', signals: view.statusOf, rereviewLines: extras.rereviewLines, replies: extras.replies };
    const move = moveForward(input);
    const you = waitingOnYou(input);
    const others = waitingOnOthers(input);
    const decide = needsDecision(input).filter((item) => !closing.has(item.member.url));
    return { move, you, others, decide, count: morningCount(move, you) };
  }, [view, now, account, extras.rereviewLines, extras.replies, closing]);
  // The tab title counts Move forward now and Waiting on you, each PR once (lib/morning.ts, `morningCount`).
  useEffect(() => {
    if (account && !loading) publishOverviewCount(account, morning.count);
  }, [account, loading, morning.count]);
  const briefing = useMemo(() => overviewBriefing(view), [view]);
  const since = useMemo(() => sinceLine(sinceSummary(extras.since.events, extras.since.from), extras.since.from, now), [extras.since, now]);

  // Expanded person and blocker groups, by row id.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allDecisions, setAllDecisions] = useState(false);
  const toggle = useCallback((id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  // Every row id per section in reading order, and what each row is.
  const { order, refs } = useMemo(() => {
    const refs = new Map<string, RowRef>();
    const order: Record<Section, string[]> = { move: [], you: [], others: [], decide: [] };
    for (const item of morning.move) {
      order.move.push(item.id);
      refs.set(item.id, { row: item.row, members: item.row.item.subject.members });
    }
    for (const [section, groups] of [['you', morning.you], ['others', morning.others]] as const)
      for (const group of groups) {
        const id = `${section}|${group.key}`;
        order[section].push(id);
        refs.set(id, { members: group.rows.flatMap((row) => row.entries.map((entry) => entry.member)) });
        if (expanded.has(id))
          for (const row of group.rows) {
            const child = `${id}|${row.id}`;
            order[section].push(child);
            refs.set(child, { row, members: row.item.subject.members });
          }
      }
    for (const item of allDecisions ? morning.decide : morning.decide.slice(0, DECIDE_SHOWN)) {
      order.decide.push(item.id);
      refs.set(item.id, { row: item.row, members: [item.member] });
    }
    return { order, refs };
  }, [morning, expanded, allDecisions]);
  const latest = useRef({ order, refs });
  latest.current = { order, refs };
  // One roving tab stop per section: the row last focused there, else its first.
  const [current, setCurrent] = useState<Partial<Record<Section, string>>>({});
  const tabStop = (section: Section) => {
    const id = current[section];
    return id && order[section].includes(id) ? id : order[section][0];
  };

  const root = useRef<HTMLDivElement>(null);
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
    setCurrent((value) => (value[sectionOf(id)] === id ? value : { ...value, [sectionOf(id)]: id }));
    const target = root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(id)}"]`);
    // A row a state change just added, such as an expanded group's PR, is in the document after this render.
    if (target) target.focus({ preventScroll: false });
    else requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));
  }, []);
  const move = useCallback(
    (direction: 1 | -1) => {
      const active = document.activeElement?.closest<HTMLElement>('[data-overview-row]')?.dataset.overviewRow;
      if (!active) {
        const all = SECTIONS.flatMap((section) => latest.current.order[section]);
        focusRow(direction > 0 ? all.at(0) : all.at(-1));
        return;
      }
      const rows = latest.current.order[sectionOf(active)];
      const index = rows.indexOf(active);
      focusRow(rows.at(Math.max(0, Math.min(rows.length - 1, index + direction))));
    },
    [focusRow]
  );
  const snooze = useCallback(
    (id: string) => {
      const ref = latest.current.refs.get(id);
      if (!ref?.members.length) return false;
      const rows = latest.current.order[sectionOf(id)];
      const index = rows.indexOf(id);
      const next = rows.at(index + 1) ?? (index > 0 ? rows.at(index - 1) : undefined);
      return openSnoozePicker({ groups: [ref.members], onSnoozed: () => requestAnimationFrame(() => focusRow(next)) });
    },
    [focusRow]
  );
  const activeRow = () => document.activeElement?.closest<HTMLElement>('[data-overview-row-item]')?.dataset.overviewRowItem;
  useKeyboardShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      // The row's one action: Merge, Re-review, Reply, Review, Nudge or Close PR.
      a: (event) => {
        const id = activeRow();
        if (!id || event.repeat) return false;
        const button = root.current?.querySelector<HTMLElement>(`[data-overview-row-item="${CSS.escape(id)}"] [data-quick-action]`);
        if (!button) return false;
        button.click();
      },
      z: (event) => {
        const id = activeRow();
        if (!id || event.repeat || !authenticated) return false;
        return snooze(id);
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
        const rows = id ? latest.current.order[sectionOf(id)] : [];
        focusRow(event.key === 'Home' ? rows[0] : rows.at(-1));
      }
    },
    [move, focusRow]
  );
  // A live update can move the focused row's element; React re-inserts it and the browser drops focus. Give it back
  // in place, without scrolling. A blur long after the last render is the reader moving on, and is left alone.
  const focused = useRef<{ id: string; at: number; blurredAt: number } | null>(null);
  useLayoutEffect(() => {
    const entry = focused.current;
    if (!entry || !visible || (document.activeElement && document.activeElement !== document.body)) return;
    if (entry.blurredAt > entry.at && performance.now() - entry.blurredAt > 50) return;
    root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(entry.id)}"]`)?.focus({ preventScroll: true });
  });

  const [nudging, setNudging] = useState<PersonGroup | null>(null);
  const [closingPr, setClosingPr] = useState<ReviewMember | null>(null);
  const actions = useMemo<RowActions>(
    () => ({
      open,
      focus: (id) => {
        focused.current = { id, at: performance.now(), blurredAt: 0 };
        setCurrent((value) => (value[sectionOf(id)] === id ? value : { ...value, [sectionOf(id)]: id }));
      },
      blur: () => {
        if (focused.current) focused.current.blurredAt = performance.now();
      },
      toggle,
      snooze: (id) => void snooze(id),
      markRead: (urls) => callbacks.current.onMarkRead(urls),
      refresh: () => callbacks.current.onRefresh(),
      show: (group) => callbacks.current.onShowLane(group),
      nudge: setNudging,
      close: setClosingPr,
      copy: (text, what) =>
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => toast.add({ type: 'success', title: `${what} copied`, description: text }),
            () => toast.add({ type: 'error', title: `Could not copy the ${what.toLowerCase()}`, description: 'Try again.' })
          ),
      keyDown: onRowKeyDown,
    }),
    [open, snooze, toggle, onRowKeyDown]
  );
  const confirmClose = useCallback((request: Parameters<typeof window.electronAPI.performPrAction>[0], member: ReviewMember) => {
    setClosingPr(null);
    setClosing((current) => new Set([...current, member.url]));
    window.electronAPI.performPrAction(request).then(
      (result) => {
        toast.add({ type: 'success', title: result.message });
        callbacks.current.onRefresh();
      },
      (cause: unknown) => {
        setClosing((current) => {
          const next = new Set(current);
          next.delete(member.url);
          return next;
        });
        toast.add({ type: 'error', title: `Could not close #${member.number}`, description: writeErrorDetail(cause) });
      }
    );
  }, []);

  const sync = queue.sync;
  const readStates = queue.readStates ?? {};
  const unread = (members: readonly ReviewMember[]) => members.some((member) => !!readStates[member.url]?.unread.length);
  const ready = authenticated && !(loading && !queue.items.length) && !(!queue.items.length && !hasRepositories);
  const counts: Counts = {
    move: morning.move.length,
    you: waitingOnYouCount(morning.you),
    others: new Set(morning.others.flatMap((group) => group.rows.map((row) => row.id.slice(row.id.indexOf('|'))))).size,
    decide: morning.decide.length,
  };
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
      <div className="morning">
        <MorningSection section="move" count={counts.move} summary={morning.move.length ? effortLabel(moveMinutes(morning.move)) : undefined}
          empty="Nothing quick right now. The rest of your work is below.">
          {morning.move.map((item) => (
            <MoveRow key={item.id} item={item} tabStop={tabStop('move') === item.id} unread={unread(item.row.entries.map((entry) => entry.member))} actions={actions} />
          ))}
        </MorningSection>
        <div className="morning-columns">
          <MorningSection section="you" count={counts.you} empty="Nobody is waiting on you.">
            {morning.you.map((group) => (
              <GroupRows key={group.key} section="you" group={group} now={now} expanded={expanded.has(`you|${group.key}`)} tabStop={tabStop('you')} actions={actions} />
            ))}
          </MorningSection>
          <MorningSection section="others" count={counts.others} empty="None of your PRs are waiting on anyone.">
            {morning.others.map((group) => (
              <GroupRows key={group.key} section="others" group={group} now={now} expanded={expanded.has(`others|${group.key}`)} tabStop={tabStop('others')}
                nudged={nudged.has(group.key)} actions={actions} />
            ))}
          </MorningSection>
        </div>
        <MorningSection section="decide" count={counts.decide} quiet empty="Nothing to decide. None of your PRs has been stuck for over a week.">
          {(allDecisions ? morning.decide : morning.decide.slice(0, DECIDE_SHOWN)).map((item) => (
            <DecisionRow key={item.id} item={item} tabStop={tabStop('decide') === item.id} actions={actions} />
          ))}
          {morning.decide.length > DECIDE_SHOWN && (
            <li className="morning-more">
              <button type="button" className="overview-tile-all" aria-expanded={allDecisions} data-overview-more onClick={() => setAllDecisions((value) => !value)}>
                {allDecisions ? 'Show fewer' : `Show all ${morning.decide.length}`}
              </button>
            </li>
          )}
        </MorningSection>
      </div>
      <p className="sr-only" id="overview-keyboard-help">
        <kbd>Tab</kbd> moves between sections · <kbd>j</kbd> <kbd>k</kbd> or arrows move within a section · <kbd>Enter</kbd> opens or expands ·{' '}
        <kbd>a</kbd> runs the row's action · <kbd>z</kbd> snoozes · <kbd>Shift</kbd>+<kbd>F10</kbd> opens its menu
      </p>
      <NudgeDialog
        group={nudging}
        onClose={() => setNudging(null)}
        onDone={({ sent, error }) => {
          const group = nudging;
          setNudging(null);
          if (!group) return;
          if (sent.length) {
            setNudged((current) => new Set([...current, group.key]));
            toast.add({ type: 'success', title: `Asked ${group.label} to review ${prs(sent.length)} again` });
            callbacks.current.onRefresh();
          }
          if (error) toast.add({ type: 'error', title: `Could not nudge ${group.label}`, description: error });
        }}
      />
      <ClosePrDialog member={closingPr} onClose={() => setClosingPr(null)} onConfirm={confirmClose} />
    </>
  );
  const announcement = useCountAnnouncement(counts, visible && authenticated && !loading);
  return (
    // The keyboard help is given once, on the region, not on every row.
    <div className="overview" ref={root} aria-labelledby="overview-title" aria-describedby="overview-keyboard-help" role="region">
      <div className="queue-toolbar overview-toolbar">
        <div>
          <h1 id="overview-title">Overview</h1>
          {/* A status region that is not live: count changes are announced once, by the region below. */}
          <p className="overview-briefing" role="status" aria-live="off" data-overview-briefing>
            {ready ? briefing : 'What you can act on now, across your repositories.'}
          </p>
          {ready && since && <p className="overview-since" data-overview-since>{since}</p>}
        </div>
        <div className="overview-freshness-group">
          {authenticated && view.checking > 0 ? (
            <span className="overview-unchecked" data-overview-checking title={`Reading the status of ${view.checking} PRs from GitHub. Each joins its section when GitHub answers.`}>
              Checking {view.checking}…
            </span>
          ) : authenticated && view.unchecked > 0 ? (
            <span className="overview-unchecked" data-overview-unchecked title={`Status not checked yet for ${view.unchecked} of your PRs. They join a section when GitHub reports it.`}>
              {view.unchecked} not checked
            </span>
          ) : null}
          {authenticated && sync?.status === 'checking' && syncStale(sync.checkedAt) ? (
            <span className="queue-freshness is-refreshing" data-overview-syncing title={`Gnosis last finished reading your pull requests from GitHub at ${new Date(sync.checkedAt ?? 0).toLocaleString()}. It is reading them again now.`}>
              <LoadingIndicator announce={false}>Updating…</LoadingIndicator>
            </span>
          ) : (
            <PrFreshness className="queue-freshness" queue checkedAt={sync?.checkedAt} refreshing={refreshing} />
          )}
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
type Counts = Readonly<Record<Section, number>>;
const countChange = (before: Counts, after: Counts) =>
  SECTIONS.filter((section) => before[section] !== after[section]).map((section) => `${SECTION_LABEL[section]} ${after[section]}, was ${before[section]}.`).join(' ');

/**
 * A short, polite announcement when section counts change while the Overview is shown: "Waiting on you 3, was 2."
 * The first counts after showing are the baseline, so opening the Overview or a sync that changes nothing says nothing.
 */
function useCountAnnouncement(counts: Counts, active: boolean): string {
  const [message, setMessage] = useState('');
  const baseline = useRef<Counts | null>(null);
  const shownAt = useRef(0);
  const latestCounts = useRef(counts);
  latestCounts.current = counts;
  const key = SECTIONS.map((section) => counts[section]).join(',');
  useEffect(() => {
    const now = latestCounts.current;
    if (!active) {
      baseline.current = null;
      return;
    }
    if (!baseline.current || performance.now() - shownAt.current < BASELINE_SETTLE_MS) {
      if (!baseline.current) shownAt.current = performance.now();
      baseline.current = now;
      return;
    }
    const before = baseline.current;
    if (!countChange(before, now)) return;
    const timer = window.setTimeout(() => {
      baseline.current = now;
      setMessage(countChange(before, now));
    }, ANNOUNCE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [key, active]);
  return active ? message : '';
}

interface RowActions {
  open: (row: OverviewRow) => void;
  focus: (id: string) => void;
  blur: () => void;
  toggle: (id: string) => void;
  snooze: (id: string) => void;
  markRead: (urls: string[]) => void;
  refresh: () => void;
  show: (group: OverviewActionGroup) => void;
  nudge: (group: PersonGroup) => void;
  close: (member: ReviewMember) => void;
  /** Copies `text`; `what` names it in the confirmation: "Link copied". */
  copy: (text: string, what: string) => void;
  keyDown: (event: ReactKeyboardEvent) => void;
}

function MorningSection({ section, count, summary, empty, quiet = false, children }: {
  section: Section;
  count: number;
  summary?: string;
  empty: string;
  quiet?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const label = SECTION_LABEL[section];
  return (
    <section className={`morning-section${quiet ? ' is-quiet' : ''}`} data-section={section} aria-labelledby={`${id}-heading`}>
      <div className="morning-section-head">
        <h2 id={`${id}-heading`}>
          {label}
          <span className="sr-only">{`, ${count}${summary ? `, about ${summary.slice(1)}` : ''}`}</span>
        </h2>
        <span className="morning-section-count" aria-hidden="true" data-section-count>{count}</span>
        {summary && <span className="morning-section-summary" aria-hidden="true" title="Estimated time for all of them">{summary}</span>}
      </div>
      {count === 0 ? <p className="morning-empty">{empty}</p> : <ul className="morning-rows" aria-label={label}>{children}</ul>}
    </section>
  );
}

const menuFor = (row: OverviewRow) => (row.kind === 'stack' ? `stack ${row.title}` : `PR #${row.focus.number}`);
/** The menu every PR row shares: open, snooze, mark read, copy, Open on GitHub. */
function prMenu(id: string, row: OverviewRow, actions: RowActions, unread: boolean): EntryActionGroups {
  const member = row.focus;
  const stack = row.kind === 'stack';
  return [
    [{ label: 'Open', run: () => actions.open(row) }],
    [
      { label: stack ? 'Snooze stack…' : 'Snooze PR…', run: () => actions.snooze(id) },
      { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(row.entries.map((entry) => entry.member.url)) },
    ],
    [
      { label: 'Copy link', run: () => actions.copy(member.url, 'Link') },
      { label: 'Copy repository', run: () => actions.copy(member.repo, 'Repository') },
      { label: 'Copy PR number', run: () => actions.copy(`#${member.number}`, 'PR number') },
    ],
    [{ label: 'Open on GitHub', run: () => void window.electronAPI.openExternal(member.url) }],
  ];
}

/** One line: the primary button (a title or a group), its detail, right-aligned meta, the actions and the menu. */
function RowShell({ id, tabStop, actions, label, title, detail, meta, quick, menu, menuLabel, description, expanded, nested = false, isNew = false, onActivate }: {
  id: string;
  tabStop: boolean;
  actions: RowActions;
  label: string;
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  quick?: ReactNode;
  menu?: EntryActionGroups;
  /** What the menu is for: "PR #312", "stack Billing". */
  menuLabel?: string;
  description: string;
  expanded?: boolean;
  nested?: boolean;
  isNew?: boolean;
  onActivate: () => void;
}) {
  if (window.__countRenders) { window.__overviewRowRenders = (window.__overviewRowRenders ?? 0) + 1; (window.__overviewRenderedRows ??= []).push(id); }
  const descriptionId = useId();
  const inner = (trigger: ReactNode) => (
    <div className="morning-row-inner">
      <span className="overview-row-gutter">
        {isNew && <span className="pr-unread-dot" role="img" aria-label="New since your last visit" title="New since your last visit" />}
        {expanded !== undefined && <ChevronRight size={14} aria-hidden="true" className="morning-chevron" />}
      </span>
      <button
        type="button"
        className="morning-title"
        data-overview-row={id}
        tabIndex={tabStop ? 0 : -1}
        aria-describedby={descriptionId}
        aria-expanded={expanded}
        title={label}
        onFocus={() => actions.focus(id)}
        onBlur={actions.blur}
        onKeyDown={actions.keyDown}
        onClick={(event) => {
          event.preventDefault();
          onActivate();
        }}
      >
        <span className="morning-title-text">{title}</span>
        {detail !== undefined && <span className="morning-detail">{detail}</span>}
      </button>
      <span className="sr-only" id={descriptionId} data-overview-description>{description}</span>
      {meta !== undefined && <span className="morning-meta">{meta}</span>}
      {(quick || trigger) && <span className="morning-actions">{quick}{trigger}</span>}
    </div>
  );
  return (
    <li className={`morning-row${nested ? ' is-nested' : ''}${isNew ? ' is-new' : ''}${expanded ? ' is-expanded' : ''}`} data-overview-row-item={id}>
      {menu ? (
        <EntryActions label={`Actions for ${menuLabel ?? label.split('\n')[0]}`} groups={menu} triggerTabIndex={-1}>
          {(trigger) => inner(trigger)}
        </EntryActions>
      ) : (
        inner(null)
      )}
    </li>
  );
}

/** Out of the tab order: Tab moves between sections, and A runs the focused row's action. */
const SHORTCUT = { 'data-quick-action': true, 'aria-keyshortcuts': 'A', tabIndex: -1 };
const MOVE_ACTION: Readonly<Record<MoveItem['kind'], string>> = { merge: 'Merge', rereview: 'Re-review', reply: 'Reply', review: 'Review' };

const MoveRow = memo(
  function MoveRow({ item, tabStop, unread, actions }: { item: MoveItem; tabStop: boolean; unread: boolean; actions: RowActions }) {
    const { row } = item;
    const ref = overviewRef(row);
    const quick =
      item.kind === 'merge' ? (
        <MergeAction row={row} actions={actions} />
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`${MOVE_ACTION[item.kind]} · A`} onClick={() => actions.open(row)}>
          {MOVE_ACTION[item.kind]}
        </Button>
      );
    return (
      <RowShell
        id={item.id}
        tabStop={tabStop}
        actions={actions}
        label={`${row.title}\n${ref.title} · ${item.why}`}
        title={row.title}
        detail={item.why}
        meta={<span title="Estimated time">{item.minutes} min</span>}
        quick={quick}
        menu={prMenu(item.id, row, actions, unread)}
        menuLabel={menuFor(row)}
        isNew={row.isNew}
        description={`${MOVE_ACTION[item.kind]}, ${item.why}, ${ref.repo} ${ref.number}, about ${item.minutes} ${item.minutes === 1 ? 'minute' : 'minutes'}`}
        onActivate={() => actions.open(row)}
      />
    );
  },
  (a, b) => a.item.row.signature === b.item.row.signature && a.item.why === b.item.why && a.item.minutes === b.item.minutes && a.item.kind === b.item.kind &&
    a.tabStop === b.tabStop && a.unread === b.unread && a.actions === b.actions
);

function MergeAction({ row, actions }: { row: OverviewRow; actions: RowActions }) {
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

/** A person or blocker and, when expanded, its PRs. */
const GroupRows = memo(
  function GroupRows({ section, group, now, expanded, tabStop, nudged = false, actions }: {
    section: 'you' | 'others';
    group: PersonGroup;
    now: number;
    expanded: boolean;
    tabStop: string | undefined;
    nudged?: boolean;
    actions: RowActions;
  }) {
    const id = `${section}|${group.key}`;
    const name = groupLabel(group);
    const quick = group.nudge ? (
      nudged ? (
        <span className="morning-done">Nudged</span>
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`Request ${group.nudge.reviewer}’s review again… · A`} onClick={() => actions.nudge(group)}>
          Nudge
        </Button>
      )
    ) : group.kind === 'you' ? (
      <Button size="xs" variant="ghost" {...SHORTCUT} title="Open Fix in the review queue · A" onClick={() => actions.show('fix')}>
        All {group.rows.length}
        <ChevronRight size={13} aria-hidden="true" />
      </Button>
    ) : undefined;
    const spoken = `${name}, ${group.detail.replace(/\b\d+ (m|h|d|w)\b/, (label) => spokenWaiting(label))}`;
    return (
      <>
        <RowShell
          id={id}
          tabStop={tabStop === id}
          actions={actions}
          label={`${name} · ${group.detail}`}
          title={name}
          detail={group.detail}
          quick={quick}
          expanded={expanded}
          description={`${spoken}. ${expanded ? 'Expanded' : 'Collapsed'}${group.nudge && !nudged ? '. A nudges' : ''}`}
          onActivate={() => actions.toggle(id)}
        />
        {expanded &&
          group.rows.map((row) => {
            const child = `${id}|${row.id}`;
            const ref = overviewRef(row);
            const age = waitingLabel(row.since, now);
            return (
              <RowShell
                key={child}
                id={child}
                tabStop={tabStop === child}
                actions={actions}
                nested
                label={`${row.title}\n${ref.title}`}
                title={row.title}
                meta={<time dateTime={new Date(row.since).toISOString()}>{age}</time>}
                menu={prMenu(child, row, actions, false)}
                menuLabel={menuFor(row)}
                isNew={row.isNew}
                description={`${ref.repo} ${ref.number}, waiting ${spokenWaiting(age)}`}
                onActivate={() => actions.open(row)}
              />
            );
          })}
      </>
    );
  },
  (a, b) => a.group.key === b.group.key && a.group.detail === b.group.detail && a.expanded === b.expanded && a.tabStop === b.tabStop && a.nudged === b.nudged &&
    a.actions === b.actions && (!a.expanded || a.now === b.now) && a.group.nudge?.members.length === b.group.nudge?.members.length &&
    a.group.rows.map((row) => row.signature).join() === b.group.rows.map((row) => row.signature).join()
);

const DecisionRow = memo(
  function DecisionRow({ item, tabStop, actions }: { item: DecisionItem; tabStop: boolean; actions: RowActions }) {
    const { row, member } = item;
    const ref = overviewRef(row);
    return (
      <RowShell
        id={item.id}
        tabStop={tabStop}
        actions={actions}
        label={`${row.title}\n${ref.title} · ${item.label}`}
        title={row.title}
        detail={item.label}
        quick={
          <>
            <Button size="xs" variant="outline" {...SHORTCUT} title="Close this PR… · A" onClick={() => actions.close(member)}>
              Close PR
            </Button>
            <Button size="xs" variant="ghost" tabIndex={-1} aria-keyshortcuts="Z" title="Snooze… · Z" onClick={() => actions.snooze(item.id)}>
              Snooze
            </Button>
          </>
        }
        description={`${item.label}, ${ref.repo} ${ref.number}. A closes, Z snoozes`}
        onActivate={() => actions.open(row)}
      />
    );
  },
  (a, b) => a.item.row.signature === b.item.row.signature && a.item.label === b.item.label && a.tabStop === b.tabStop && a.actions === b.actions
);

declare global {
  interface Window {
    /** Browser checks count Overview row renders when `__countRenders` is set. */
    __overviewRowRenders?: number;
    /** The rows those renders were for. */
    __overviewRenderedRows?: string[];
  }
}
