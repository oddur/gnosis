/**
 * The Overview (#390): the morning page. It answers, in order, what happened since you left, what to do next, who is
 * blocked on you, where your PRs are stuck and on whom, and what to close or park.
 *
 * - The briefing sentence and a "Since yesterday" line (`lib/since-log.ts`).
 * - **Next up:** up to five things to do, cheapest first, each with one action.
 * - **Waiting on you** and **Waiting on others**, full width one above the other: people, and your PRs by blocker,
 *   with Nudge. Stacks are chains in merge order, base first, with the step that moves them.
 * - **Needs a decision:** your PRs failing, never approved or idle for over a week, with Close PR and Snooze.
 *
 * Each PR is listed once on the page (`lib/morning.ts`, "Each PR once"), except in a stack's chain, which shows every PR
 * of the stack as a full line and links to the section that also lists one ("↑ Next up"). Every heading counts what it
 * lists, each PR once: Next up its rows, the others their PRs. Waiting on you says where its PRs went when Next up lists them.
 * Every PR line leads with its state icon (`PrStateIcon`; a row for several PRs of a stack, the stack icon) and its
 * number, shows the queue row's comment badge above 0 and its check state, and how long it has waited, in a column that
 * lines up down the page; the tooltip names the timestamp (`lib/overview.ts`, "Waiting time"). The page shows no time
 * estimates: Next up's order (`effortRank`) stays internal. A PR's title previews the PR on hover or focus with the PR
 * badge's tooltip. Buttons that change something carry their icon (`actionIcons`); buttons that only open a PR carry none. Every PR line, in every section and
 * chain, has the same "…" row menu (`prMenu`), shown on hover and focus, at the end of the action column, so the menus
 * form one column down the page; a stack header has the stack's part of it (`stackMenu`). Shift+F10 opens it. Repositories are plain muted
 * text, with their icon or colour from Settings › Repositories, named once per group when the group has one repository.
 *
 * Each section is a labelled region with one roving tab stop: Tab moves between sections, j/k and the arrows move
 * within one, Enter opens (or expands a group), A runs the row's action and Z snoozes. Rows describe themselves to
 * assistive technology, and count changes are announced once by a polite live region. Rows are memoized on what they
 * show, so a sync tick that changes nothing renders nothing, and a moved row gets its focus back without scrolling.
 */
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ChevronRight, ListChecks, MessageSquare, RefreshCw, Settings, UserRound, UsersRound, X } from 'lucide-react';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useOverview } from '../lib/use-overview';
import { useMorningExtras } from '../lib/use-morning';
import { useStatusNow } from '../lib/status-clock';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey } from '../lib/repository-settings';
import { prTarget, type DeepLinkTarget } from '../lib/deep-link';
import { publishOverviewCount } from '../lib/overview-count';
import { actionIcons, checkSummaryIcons, conflictIcon as ConflictIcon, subjectIcons, waitingIcon as WaitingIcon } from '../lib/interface-icons';
import { githubAvatarUrl } from '../lib/github-profile';
import type { CheckView } from '../lib/check-summary';
import type { PrChecks } from '../lib/pr-checks';
import { OVERVIEW_SINCE_LABEL, overviewBriefing, waitingLabel, spokenWaiting, type OverviewActionGroup, type OverviewModel, type OverviewRow, type OverviewSinceSource } from '../lib/overview';
import {
  CHAIN_STATUS_LABEL,
  FIX_LABEL,
  PLACE_LABEL,
  morningPage,
  nextCount,
  nextMoreLine,
  repositoryLabel,
  repositoryNames,
  sectionCount,
  waitingOnYouNote,
  CHAIN_HEAD,
  CHAIN_SHOWN,
  GROUP_SHOWN,
  INLINE_LIMIT,
  STACKS_SHOWN,
  type AlsoPlace,
  type ChainNode,
  type DecisionItem,
  type GroupLine,
  type NextItem,
  type PersonGroup,
} from '../lib/morning';
import { sinceLine, sinceSummary } from '../lib/since-log';
import { openSnoozePicker } from '../lib/snooze-picker';
import { writeErrorDetail } from '../lib/write-failures';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { PrPreviewTooltip } from './EntityBadge';
import { PrActions } from './PrActions';
import { PrFreshness } from './PrFreshness';
import { PrStateIcon } from './PrStateIcon';
import { BulkCheckRerun } from './BulkCheckRerun';
import { LoadingIndicator, LoadingState } from './LoadingState';
import { ClosePrDialog, NudgeDialog } from './OverviewWrites';
import { RepositoryIcon } from './RepositoryAppearance';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
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

type Section = 'next' | 'you' | 'others' | 'decide';
const SECTIONS: readonly Section[] = ['next', 'you', 'others', 'decide'];
const SECTION_LABEL: Readonly<Record<Section, string>> = {
  next: 'Next up',
  you: 'Waiting on you',
  others: 'Waiting on others',
  decide: 'Needs a decision',
};
/** Needs a decision lists this many before "Show all". */
const DECIDE_SHOWN = 6;
/** The section a row id belongs to: ids are `${section}|…`. */
const sectionOf = (id: string) => id.slice(0, id.indexOf('|')) as Section;
/** The quiet line under Next up: the rest of the merges nobody reviewed. */
const MORE_UNREVIEWED = 'next|more-unreviewed';
const prs = (n: number) => `${n} ${n === 1 ? 'PR' : 'PRs'}`;
const groupLabel = (group: PersonGroup) => (group.kind === 'you' ? 'You' : group.kind === 'review' ? 'Needs a reviewer' : group.label);
const lineMembers = (group: PersonGroup) => group.lines.map((line) => line.member);

/**
 * What the toggles have opened, by row id: an expanded group, `…|more` for a list shown in full. The stacks group is
 * open by default, so its own id there means collapsed.
 */
type Open = ReadonlySet<string>;
/** A group's disclosure: inline up to `INLINE_LIMIT` PRs; else a chevron, and `GROUP_SHOWN` PRs then "N more". */
function groupView(group: PersonGroup, id: string, open: Open) {
  const disclosure = group.lines.length > INLINE_LIMIT;
  const expanded = !disclosure || open.has(id);
  const lines = !expanded ? [] : disclosure && !open.has(`${id}|more`) ? group.lines.slice(0, GROUP_SHOWN) : group.lines;
  return { disclosure, expanded, lines, more: expanded ? group.lines.length - lines.length : 0 };
}
/** The stacks group: open by default, the first `STACKS_SHOWN` stacks, then "N more stacks". */
function stacksView(group: PersonGroup, id: string, open: Open) {
  const expanded = !open.has(id);
  const all = group.children ?? [];
  const children = !expanded ? [] : open.has(`${id}|more`) ? all : all.slice(0, STACKS_SHOWN);
  return { expanded, children, more: expanded ? all.length - children.length : 0 };
}
type ChainStep = ChainNode | { kind: 'gap'; count: number };
/** A chain over `CHAIN_SHOWN` PRs shows its first `CHAIN_HEAD` and its last, with "+N more" between. */
function chainView(stack: PersonGroup, id: string, open: Open): ChainStep[] {
  const chain = stack.chain ?? [];
  if (chain.length <= CHAIN_SHOWN || open.has(`${id}|more`)) return chain;
  return [...chain.slice(0, CHAIN_HEAD), { kind: 'gap', count: chain.length - CHAIN_HEAD - 1 }, chain[chain.length - 1]];
}

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
  const morning = useMemo(
    () => morningPage({ model: view, now, login: account ?? '', signals: view.statusOf, rereviewLines: extras.rereviewLines, replies: extras.replies, hidden: closing }),
    [view, now, account, extras.rereviewLines, extras.replies, closing]
  );
  // The tab title counts Next up and Waiting on you, each PR once (lib/morning.ts, `morningCount`).
  useEffect(() => {
    if (account && !loading) publishOverviewCount(account, morning.count);
  }, [account, loading, morning.count]);
  const briefing = useMemo(() => overviewBriefing(view), [view]);
  // Repositories by their short name, or owner/repo where two share one.
  const repoKey = [...new Set(queue.items.flatMap((item) => item.subject.members.map((member) => member.repo)))].sort().join(',');
  const repoNames = useMemo(() => repositoryNames(repoKey ? repoKey.split(',') : []), [repoKey]);
  const since = useMemo(() => sinceLine(sinceSummary(extras.since.events, extras.since.from), extras.since.from, now), [extras.since, now]);

  const [opened, setOpened] = useState<Open>(new Set());
  const [allDecisions, setAllDecisions] = useState(false);
  const toggle = useCallback((id: string) => setOpened((value) => {
    const next = new Set(value);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  // Every row id per section in reading order, and what each row is.
  const { order, refs } = useMemo(() => {
    const refs = new Map<string, RowRef>();
    const order: Record<Section, string[]> = { next: [], you: [], others: [], decide: [] };
    const push = (section: Section, id: string, ref: RowRef) => {
      order[section].push(id);
      refs.set(id, ref);
    };
    for (const item of morning.next.items) push('next', item.id, { row: item.row, members: item.row.entries.map((entry) => entry.member).filter((member) => item.urls.includes(member.url)) });
    // The quiet line under Next up is the section's last stop: j/k and Tab reach it like a row.
    if (nextMoreLine(morning.next)) push('next', MORE_UNREVIEWED, { members: [] });
    const lines = (section: Section, id: string, list: readonly GroupLine[]) => {
      for (const line of list) push(section, `${id}|${line.id}`, { row: line.row, members: [line.member] });
    };
    for (const [section, groups] of [['you', morning.you], ['others', morning.others]] as const)
      for (const group of groups) {
        const id = `${section}|${group.key}`;
        if (group.kind === 'stacks') {
          push(section, id, { members: (group.children ?? []).flatMap(lineMembers) });
          const stacks = stacksView(group, id, opened);
          for (const stack of stacks.children) {
            const sid = `${id}|${stack.key}`;
            push(section, sid, { row: stack.step?.row ?? stack.rows[0], members: lineMembers(stack) });
            for (const step of chainView(stack, sid, opened)) {
              if (step.kind === 'line') lines(section, sid, [step.line]);
              else if (step.kind === 'gap') push(section, `${sid}|more`, { members: [] });
            }
          }
          if (stacks.more) push(section, `${id}|more`, { members: [] });
          continue;
        }
        push(section, id, { members: lineMembers(group) });
        const shown = groupView(group, id, opened);
        lines(section, id, shown.lines);
        if (shown.more) push(section, `${id}|more`, { members: [] });
      }
    for (const item of allDecisions ? morning.decide : morning.decide.slice(0, DECIDE_SHOWN)) push('decide', item.id, { row: item.row, members: [item.member] });
    return { order, refs };
  }, [morning, opened, allDecisions]);
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
    (row: OverviewRow, target: DeepLinkTarget = row.target) => {
      if (navigation?.openTarget)
        void navigation.openTarget(target).catch((error: unknown) =>
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
  // A chain line's link: the row in `place` that lists the PR. A PR's own line before a group that holds it, so a
  // collapsed group in Waiting on you takes the focus in its line's place.
  const reveal = useCallback(
    (url: string, place: AlsoPlace) => {
      const { order: rows, refs: known } = latest.current;
      const listing = rows[place].filter((id) => known.get(id)?.members.some((member) => member.url === url));
      const id = listing.find((candidate) => known.get(candidate)?.members.length === 1) ?? listing[0];
      if (!id) return;
      focusRow(id);
      root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
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
      reveal,
    }),
    [open, snooze, toggle, onRowKeyDown, reveal]
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
  // Main is reading the PR list again and the last finished read is behind (`SYNC_STALE_MS`).
  const syncing = authenticated && sync?.status === 'checking' && syncStale(sync.checkedAt);
  const readStates = queue.readStates ?? {};
  const unread = (members: readonly ReviewMember[]) => members.some((member) => !!readStates[member.url]?.unread.length);
  const unreadOf = useCallback((members: readonly ReviewMember[]) => members.some((member) => !!readStates[member.url]?.unread.length), [readStates]);
  const ready = authenticated && !(loading && !queue.items.length) && !(!queue.items.length && !hasRepositories);
  // Next up counts its rows; the other headings count the PRs they list (lib/morning.ts, "Counts").
  const counts: Counts = {
    next: nextCount(morning.next.items),
    you: sectionCount(morning.you),
    others: sectionCount(morning.others),
    decide: morning.decide.length,
  };
  const more = nextMoreLine(morning.next);
  const youNote = waitingOnYouNote(counts.you, morning.youElsewhere);
  const group = (section: 'you' | 'others', value: PersonGroup) => {
    const id = `${section}|${value.key}`;
    const inside = openWithin(opened, id);
    return value.kind === 'stacks' ? (
      <StacksRows key={value.key} id={id} group={value} now={now} open={inside} tabStop={tabStop(section)} nudged={nudged} actions={actions} />
    ) : (
      <GroupRows key={value.key} id={id} group={value} now={now} open={inside} tabStop={tabStop(section)} nudged={nudged.has(value.key)} actions={actions} />
    );
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
        <MorningSection section="next" count={counts.next}
          empty="Nothing needs you right now."
          footer={more && (
            // The rest of the unreviewed merges wait in the queue, grouped by Action at Merge.
            <button type="button" className="morning-more-quiet" data-overview-more-unreviewed data-overview-row={MORE_UNREVIEWED} tabIndex={tabStop('next') === MORE_UNREVIEWED ? 0 : -1}
              title="Open Merge in the review queue, grouped by Action" onFocus={() => actions.focus(MORE_UNREVIEWED)} onBlur={actions.blur} onKeyDown={actions.keyDown} onClick={() => actions.show('merge')}>
              {more}
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          )}>
          {morning.next.items.map((item) => (
            <NextRow key={item.id} item={item} waited={waitingLabel(item.since, now)} tabStop={tabStop('next') === item.id} unread={unread(item.row.entries.map((entry) => entry.member).filter((entry) => item.urls.includes(entry.url)))} actions={actions} />
          ))}
        </MorningSection>
        <MorningSection section="you" count={counts.you} empty={youNote.empty}
          footer={youNote.more && <p className="morning-more-note" data-overview-you-elsewhere>{youNote.more}</p>}>
          {morning.you.map((value) => group('you', value))}
        </MorningSection>
        <MorningSection section="others" count={counts.others} empty="None of your PRs are waiting on anyone.">
          {morning.others.map((value) => group('others', value))}
        </MorningSection>
        <MorningSection section="decide" count={counts.decide} quiet empty="Nothing to decide. None of your PRs has been stuck for over a week.">
          {(allDecisions ? morning.decide : morning.decide.slice(0, DECIDE_SHOWN)).map((item) => (
            <DecisionRow key={item.id} item={item} waited={waitingLabel(item.since, now)} tabStop={tabStop('decide') === item.id} actions={actions} />
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
          const value = nudging;
          setNudging(null);
          if (!value) return;
          if (sent.length) {
            setNudged((current) => new Set([...current, value.key]));
            toast.add({ type: 'success', title: `Asked ${value.label} to review ${prs(sent.length)} again` });
            callbacks.current.onRefresh();
          }
          if (error) toast.add({ type: 'error', title: `Could not nudge ${value.label}`, description: error });
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
          {/* One indicator at a time: while Gnosis reads your PRs again, the status reads still to come are in its tooltip. */}
          {syncing ? null : authenticated && view.checking > 0 ? (
            <span className="overview-unchecked" data-overview-checking title={`Reading the status of ${view.checking} PRs from GitHub. Each joins its section when GitHub answers.`}>
              Checking {view.checking}…
            </span>
          ) : authenticated && view.unchecked > 0 ? (
            <span className="overview-unchecked" data-overview-unchecked title={`Status not checked yet for ${view.unchecked} of your PRs. They join a section when GitHub reports it.`}>
              {view.unchecked} not checked
            </span>
          ) : null}
          {syncing ? (
            <span className="queue-freshness is-refreshing" data-overview-syncing
              title={`Gnosis last finished reading your pull requests from GitHub at ${new Date(sync?.checkedAt ?? 0).toLocaleString()}. It is reading them again now.${view.checking > 0 ? ` The status of ${view.checking} PRs is still to come; each joins its section when GitHub answers.` : ''}`}>
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
      <RepoNames.Provider value={repoNames}>
        <Viewer.Provider value={account ?? ''}>
          <Unread.Provider value={unreadOf}>
            <div className="overview-body">{body}</div>
          </Unread.Provider>
        </Viewer.Provider>
      </RepoNames.Provider>
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
  /** Opens the row where its notification would land, or `target` (one PR of a stack, a stack's base). */
  open: (row: OverviewRow, target?: DeepLinkTarget) => void;
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
  /** Scrolls to and focuses the row that lists `url` in `place`: a chain line's "↑ Next up". */
  reveal: (url: string, place: AlsoPlace) => void;
}

/** The opened ids under a group (itself included), as one key, so a group renders again only when its own change. */
function openWithin(open: Open, id: string): string {
  return [...open].filter((entry) => entry === id || entry.startsWith(`${id}|`)).sort().join('\n');
}
const openSet = (open: string): Open => new Set(open ? open.split('\n') : []);

/** How repositories are named on the page (`repositoryNames`): short, or owner/repo where two share a short name. */
const RepoNames = createContext<ReadonlyMap<string, string>>(new Map());
const useRepoLabel = () => {
  const names = useContext(RepoNames);
  return useCallback((repo: string) => repositoryLabel(names, repo), [names]);
};
/** The signed-in account: the You group shows its avatar. */
const Viewer = createContext('');
/** Whether any of these PRs has unread activity: every PR line's menu enables Mark as read from it. */
const Unread = createContext<(members: readonly ReviewMember[]) => boolean>(() => false);

/**
 * Every row leads with what it is, in the icons the queue and sidebar use: a PR its GitHub state (`PrStateIcon`: open,
 * draft, merged, closed), a stack Layers, a person their avatar, a team or an unnamed reviewer the user icons, CI the
 * Checks icon. Decorative: the row's description says what it is.
 */
function PrIcon({ member }: { member: ReviewMember }) {
  return (
    <span className="morning-icon" data-overview-icon="pr" aria-hidden="true">
      <PrStateIcon pr={member} size={14} decorative />
    </span>
  );
}
const StackIcon = subjectIcons.stack;
function GroupIcon({ group }: { group: Pick<PersonGroup, 'kind' | 'label'> }) {
  const viewer = useContext(Viewer);
  const login = group.kind === 'person' ? group.label : group.kind === 'you' ? viewer : '';
  if (login)
    return (
      <span className="morning-icon is-avatar" data-overview-icon="person" aria-hidden="true">
        <Avatar size="sm" className="morning-avatar">
          <AvatarImage src={githubAvatarUrl(login)} alt="" loading="lazy" referrerPolicy="no-referrer" />
          <AvatarFallback>{login.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      </span>
    );
  const Icon = group.kind === 'stack' || group.kind === 'stacks' ? StackIcon : group.kind === 'team' ? UsersRound : group.kind === 'ci' ? ListChecks : UserRound;
  return (
    <span className="morning-icon" data-overview-icon={group.kind === 'stack' || group.kind === 'stacks' ? 'stack' : group.kind} aria-hidden="true">
      <Icon size={14} aria-hidden="true" />
    </span>
  );
}

/** "seed-launcher", "klang/web", or "2 repos": in words, for row descriptions. */
const reposSpoken = (repos: readonly string[], label: (repo: string) => string) => (repos.length > 1 ? `${repos.length} repositories` : repos.length ? label(repos[0]) : '');

/**
 * A row's repository as plain muted text: its icon (or colour dot) when Settings › Repositories gives it one, then
 * its name. Several repositories read "2 repos"; each PR names its own when the group is expanded.
 */
function RepoName({ repos }: { repos: readonly string[] }) {
  const label = useRepoLabel();
  const { settings } = useRepositorySettings();
  if (!repos.length) return null;
  if (repos.length > 1)
    return (
      <span className="morning-repo" data-overview-repo={`${repos.length} repos`} title={repos.join(', ')}>
        {repos.length} repos
      </span>
    );
  const repo = repos[0];
  const appearance = settings[repositoryKey(repo)] ?? {};
  return (
    <span className={`morning-repo repository-color-${appearance.color ?? 'default'}`} data-overview-repo={label(repo)} title={repo}>
      {appearance.icon ? <RepositoryIcon settings={appearance} /> : appearance.color ? <span className="morning-repo-dot" aria-hidden="true" /> : null}
      {label(repo)}
    </span>
  );
}

function MorningSection({ section, count, empty, quiet = false, footer, children }: {
  section: Section;
  count: number;
  empty: string;
  quiet?: boolean;
  /** A quiet line under the rows, such as "2 more ready, not reviewed". */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const label = SECTION_LABEL[section];
  return (
    <section className={`morning-section${quiet ? ' is-quiet' : ''}`} data-section={section} aria-labelledby={`${id}-heading`}>
      <div className="morning-section-head">
        <h2 id={`${id}-heading`}>
          {label}
          <span className="sr-only">{`, ${count}`}</span>
        </h2>
        <span className="morning-section-count" aria-hidden="true" data-section-count>{count}</span>
      </div>
      {count === 0 ? <p className="morning-empty" data-overview-empty>{empty}</p> : <ul className="morning-rows" aria-label={label}>{children}</ul>}
      {footer && <div className="morning-footer">{footer}</div>}
    </section>
  );
}

/** A PR's check state as the queue row shows it (`queue-checks`): an icon and a short word, never colour alone. */
function CheckState({ check }: { check: CheckView }) {
  const Icon = checkSummaryIcons[check.state];
  return (
    <span className={`queue-checks morning-checks is-${check.state === 'unknown' ? 'unknown' : check.state}`} data-overview-check={check.state} title={check.spoken} aria-hidden="true">
      <Icon size={13} aria-hidden="true" />
      {check.label}
    </span>
  );
}

/** "3 comments", for a row's description. */
export const commentsSpoken = (count: number | undefined) => (count ? `${count} ${count === 1 ? 'comment' : 'comments'}` : '');
/**
 * The queue row's comment badge (`QueueMetadata`, `.queue-comments`): the comment icon and the count, inline review
 * comments included. Shown only above 0; its column is always held, so check states line up down a section.
 */
function CommentCount({ count }: { count?: number }) {
  return (
    <span className="queue-comments morning-comments" aria-hidden="true" {...(count ? { 'data-overview-comments': count, title: `${commentsSpoken(count)}, including inline review comments` } : {})}>
      {!!count && (
        <>
          <MessageSquare size={13} aria-hidden="true" />
          {count}
        </>
      )}
    </span>
  );
}

/** How long a PR has waited in its current state, and since what: one right-aligned column on every PR row. */
interface Waited {
  since: number;
  source: OverviewSinceSource;
  /** `waitingLabel`: "4 d", "3 h". */
  label: string;
}
/** "Waiting since your last review, 14 Nov 2026, 09:12": the source of a waiting time (`lib/overview.ts`). */
export const waitingTitle = (since: number, source: OverviewSinceSource) => `Waiting ${OVERVIEW_SINCE_LABEL[source]}, ${new Date(since).toLocaleString()}`;
function Age({ waited }: { waited: Waited }) {
  return (
    <span className="morning-age" data-overview-age={waited.label} data-overview-age-source={waited.source} title={waitingTitle(waited.since, waited.source)} aria-hidden="true">
      <WaitingIcon size={12} aria-hidden="true" />
      <time dateTime={new Date(waited.since).toISOString()}>{waited.label}</time>
    </span>
  );
}
/** "Conflicts", with the app's conflict icon: a PR that has merge conflicts with its base. */
function Conflicts({ children = 'Conflicts' }: { children?: ReactNode }) {
  return (
    <span className="morning-conflicts" data-overview-conflicts>
      <ConflictIcon size={13} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * One line: what it is (its icon), the primary button (the PR number, the title, then its repository and detail), the
 * comments, the check state, a status word, how long it has waited (or a header's count), the actions and the menu.
 * Comments, check, age and actions hold their columns, so they line up down the page.
 * The number, check and status never truncate; the title truncates first, at its end. A PR's title previews the PR
 * on hover and focus (`PrPreviewTooltip`).
 */
function RowShell({ id, tabStop, actions, label, title, number, preview, prs: listed, repos, detail, check, comments, status, waited, meta, quick, menu, menuLabel, description, expanded, depth = 0, isNew = false, as: Tag = 'li', className = '', icon, onActivate }: {
  id: string;
  tabStop: boolean;
  actions: RowActions;
  label: string;
  title: ReactNode;
  /** The PR number, in its own column. */
  number?: number;
  /** The PR the title previews. */
  preview?: { url: string; number: number; title: string };
  /** The PRs the row lists, for the page's each-PR-once check. */
  prs?: readonly string[];
  /** The repositories of the row's PRs: one is named, several read "2 repos". */
  repos?: readonly string[];
  detail?: ReactNode;
  check?: CheckView;
  /** Rows with a check state hold the comment column; the badge shows above 0. */
  comments?: number;
  status?: ReactNode;
  /** A PR row: how long it has waited. */
  waited?: Waited;
  /** A header row: what it holds, "4 PRs", in the age column. */
  meta?: ReactNode;
  quick?: ReactNode;
  menu?: EntryActionGroups;
  /** What the menu is for: "PR #312", "stack Billing". */
  menuLabel?: string;
  description: string;
  expanded?: boolean;
  /** 1 for a group's PRs, 2 for a stack's chain inside the stacks group. */
  depth?: number;
  isNew?: boolean;
  as?: 'li' | 'div';
  className?: string;
  /** Before the title: the row's icon (`PrIcon`, `GroupIcon`), or a stack chain's node. */
  icon?: ReactNode;
  onActivate: () => void;
}) {
  if (window.__countRenders) { window.__overviewRowRenders = (window.__overviewRowRenders ?? 0) + 1; (window.__overviewRenderedRows ??= []).push(id); }
  const descriptionId = useId();
  const button = (
    <button
      type="button"
      className="morning-title"
      data-overview-row={id}
      tabIndex={tabStop ? 0 : -1}
      aria-describedby={descriptionId}
      aria-expanded={expanded}
      // A PR's title has the PR preview; a native tooltip would cover it.
      title={preview ? undefined : label}
      onFocus={() => actions.focus(id)}
      onBlur={actions.blur}
      onKeyDown={actions.keyDown}
      onClick={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      <span className="morning-head">
        {number !== undefined && <span className="morning-number">#{number}</span>}
        <span className="morning-title-text">{title}</span>
      </span>
      {(repos?.length || detail !== undefined) && (
        <span className="morning-sub">
          {repos && <RepoName repos={repos} />}
          {detail !== undefined && <span className="morning-detail">{detail}</span>}
        </span>
      )}
    </button>
  );
  const inner = (trigger: ReactNode) => (
    <div className="morning-row-inner">
      <span className="overview-row-gutter">
        {isNew && <span className="pr-unread-dot" role="img" aria-label="New since your last visit" title="New since your last visit" />}
        {expanded !== undefined && <ChevronRight size={14} aria-hidden="true" className="morning-chevron" />}
      </span>
      {icon}
      {preview ? <PrPreviewTooltip url={preview.url} number={preview.number} title={preview.title}>{button}</PrPreviewTooltip> : button}
      <span className="sr-only" id={descriptionId} data-overview-description>{description}</span>
      {check && <CommentCount count={comments} />}
      {check && <CheckState check={check} />}
      {status}
      {/* The age (or a header's count) and the actions always hold their columns, so ages line up down the page. */}
      {waited ? <Age waited={waited} /> : <span className="morning-meta">{meta}</span>}
      <span className="morning-actions">{quick}{trigger}</span>
    </div>
  );
  return (
    <Tag className={`morning-row${depth ? ` is-nested depth-${depth}` : ''}${isNew ? ' is-new' : ''}${expanded ? ' is-expanded' : ''}${className ? ` ${className}` : ''}`} data-overview-row-item={id} data-overview-prs={listed?.join(' ')}>
      {menu ? (
        <EntryActions label={`Actions for ${menuLabel ?? label.split('\n')[0]}`} groups={menu} triggerTabIndex={-1}>
          {(trigger) => inner(trigger)}
        </EntryActions>
      ) : (
        inner(null)
      )}
    </Tag>
  );
}

/** Out of the tab order: Tab moves between sections, and A runs the focused row's action. */
const SHORTCUT = { 'data-quick-action': true, 'aria-keyshortcuts': 'A', tabIndex: -1 };
const NEXT_ACTION: Readonly<Record<NextItem['kind'], string>> = { merge: 'Merge', rereview: 'Re-review', reply: 'Reply', changes: 'Open', review: 'Review', fix: 'Open' };
/** The words a row's description adds for its comments and its wait: ", 3 comments, waiting 4 days". */
const extrasSpoken = (comments: number | undefined, waited: string) => [commentsSpoken(comments), `waiting ${spokenWaiting(waited)}`].filter(Boolean).join(', ');
/** Buttons that change something carry their icon (`actionIcons`); buttons that only open a PR carry none. */
const MergeIcon = actionIcons.merge;
const RerunIcon = actionIcons.rerun;
const NudgeIcon = actionIcons.nudge;
const CloseIcon = actionIcons.close;
const SnoozeIcon = actionIcons.snooze;

const NextRow = memo(
  function NextRow({ item, waited, tabStop, unread, actions }: { item: NextItem; waited: string; tabStop: boolean; unread: boolean; actions: RowActions }) {
    const { row, member } = item;
    const label = useRepoLabel();
    const members = row.entries.map((entry) => entry.member).filter((entry) => item.urls.includes(entry.url));
    const repos = [...new Set(members.map((entry) => entry.repo))];
    const single = item.urls.length === 1;
    const failing = item.kind === 'fix' && item.fix === 'failing' ? row.entries.filter((entry) => entry.reasons.includes('checks-failed')).map((entry) => entry.member) : [];
    const action = failing.length ? 'Rerun failed' : NEXT_ACTION[item.kind];
    // A stack row opens where its row does (the stack's review); a single PR opens that PR.
    const target = !single || member.url === row.focus.url ? row.target : (prTarget(member.url) ?? row.target);
    const quick =
      item.kind === 'merge' ? (
        <MergeAction row={row} actions={actions} />
      ) : failing.length ? (
        <RerunFailed members={failing} onChanged={actions.refresh} />
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`${action} · A`} onClick={() => actions.open(row, target)}>
          {action}
        </Button>
      );
    return (
      <RowShell
        id={item.id}
        tabStop={tabStop}
        actions={actions}
        label={`${item.title}\n${item.why}`}
        title={item.title}
        number={member.number}
        preview={single ? { url: member.url, number: member.number, title: member.title } : undefined}
        prs={item.urls}
        repos={repos}
        detail={item.fix === 'conflicts' ? <Conflicts>{item.why}</Conflicts> : item.why}
        check={item.check}
        comments={item.comments}
        waited={{ since: item.since, source: item.source, label: waited }}
        quick={quick}
        menu={prMenu(item.id, row, actions, unread, member, members, single ? target : undefined)}
        menuLabel={single ? `PR #${member.number}` : menuFor(row)}
        isNew={row.isNew}
        // One PR leads with its state; a row for several PRs of a stack with the stack icon, as in the queue.
        icon={single ? <PrIcon member={member} /> : <GroupIcon group={{ kind: 'stack', label: row.title }} />}
        description={`${action}, ${item.why}, ${reposSpoken(repos, label)} #${member.number}${single ? '' : ` and ${item.urls.length - 1} more`}, ${item.check.spoken}, ${extrasSpoken(item.comments, waited)}`}
        onActivate={() => actions.open(row, target)}
      />
    );
  },
  (a, b) => a.item.row.signature === b.item.row.signature && a.item.why === b.item.why && a.item.kind === b.item.kind &&
    a.item.check.label === b.item.check.label && a.item.title === b.item.title && a.item.member.url === b.item.member.url && a.item.comments === b.item.comments &&
    a.item.since === b.item.since && a.waited === b.waited && a.tabStop === b.tabStop && a.unread === b.unread && a.actions === b.actions
);

function RerunFailed({ members, onChanged, reveal = false }: { members: ReviewMember[]; onChanged: () => void; reveal?: boolean }) {
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
        <Button size="xs" variant={reveal ? 'ghost' : 'outline'} {...SHORTCUT} {...(reveal ? { 'data-reveal': true } : {})} title="Re-run failed jobs… · A" disabled={busy} onClick={open}>
          <RerunIcon size={13} aria-hidden="true" />
          {busy ? 'Reading checks…' : 'Rerun failed'}
        </Button>
      )}
    />
  );
}

/** The age of a line, or the words for it. */
const age = (since: number, now: number) => waitingLabel(since, now);
const lineSig = (line: GroupLine, now: number) =>
  [line.id, line.title, line.row.signature, line.check.label, line.status ?? '', line.reason ?? '', age(line.since, now), line.source, line.comments ?? '', line.description].join('~');
const groupSig = (group: PersonGroup, now: number): string =>
  [
    group.key, group.label, group.detail, group.repos.join(), group.check?.label ?? '', group.nudge?.members.length ?? 0, group.step?.text ?? '', group.step?.action ?? '',
    group.step?.row?.signature ?? '', group.rows.map((row) => row.signature).join(),
    ...group.lines.map((line) => lineSig(line, now)),
    ...(group.chain ?? []).map((node) => `${lineSig(node.line, now)}:${node.also ?? ''}`),
    ...(group.children ?? []).map((child) => groupSig(child, now)),
  ].join('|');

/**
 * One PR under a group: its state, number, title, comments, check state and how long it has waited. Under You, its own
 * reason and action (Rerun failed, Open), shown on hover and focus. In a chain, its node on the connector and its
 * status word.
 */
function LineRow({ id, line, now, depth, tabStop, actions, showRepo, chain = false, node, also }: {
  id: string;
  line: GroupLine;
  now: number;
  depth: number;
  tabStop: boolean;
  actions: RowActions;
  /** The group spans repositories: each PR names its own. */
  showRepo: boolean;
  chain?: boolean;
  /** In a chain: the node on the connector, in place of the row's icon. */
  node?: ReactNode;
  /** In a chain: another section lists the PR too; the line ends in a link to it. */
  also?: AlsoPlace;
}) {
  const label = useRepoLabel();
  const unread = useContext(Unread);
  const { row, member } = line;
  const waited = age(line.since, now);
  const quick = line.reason === 'failing' ? (
    <RerunFailed members={[member]} onChanged={actions.refresh} reveal />
  ) : line.reason ? (
    <Button size="xs" variant="ghost" {...SHORTCUT} data-reveal title={`Open #${member.number} · A`} onClick={() => actions.open(row, line.target)}>
      Open
    </Button>
  ) : also ? (
    <AlsoLink url={member.url} place={also} actions={actions} />
  ) : undefined;
  const status = line.status ? (
    <span className={`morning-status is-${line.status}`} data-overview-status={line.status}>
      {line.status === 'conflicts' && <ConflictIcon size={13} aria-hidden="true" />}
      {CHAIN_STATUS_LABEL[line.status]}
    </span>
  ) : undefined;
  return (
    <RowShell
      id={id}
      tabStop={tabStop}
      actions={actions}
      depth={depth}
      className={chain ? `is-chain${line.status === 'next' ? ' is-next' : ''}` : ''}
      icon={node ?? <PrIcon member={member} />}
      label={line.title}
      title={line.title}
      number={member.number}
      preview={{ url: member.url, number: member.number, title: member.title }}
      prs={[member.url]}
      repos={showRepo ? [member.repo] : undefined}
      detail={line.reason === 'conflicts' ? <Conflicts>{FIX_LABEL.conflicts}</Conflicts> : line.reason ? FIX_LABEL[line.reason] : undefined}
      check={line.check}
      comments={line.comments}
      status={status}
      waited={{ since: line.since, source: line.source, label: waited }}
      quick={quick}
      menu={prMenu(id, row, actions, unread([member]), member, [member], line.target)}
      menuLabel={`PR #${member.number}`}
      isNew={row.isNew}
      description={[line.description, showRepo ? label(member.repo) : '', line.check.spoken, extrasSpoken(line.comments, waited), also ? `also listed in ${PLACE_LABEL[also]}. A goes there` : ''].filter(Boolean).join(', ')}
      onActivate={() => actions.open(row, line.target)}
    />
  );
}

/** The sections above Waiting on others, and the one below it. */
const ALSO_UP: Readonly<Record<AlsoPlace, boolean>> = { next: true, you: true, decide: false };
/**
 * The end of a chain line whose PR another section lists: "↑ Next up", "↓ Needs a decision". It scrolls to that row
 * and focuses it. It is the line's action, so A on the line follows it too.
 */
function AlsoLink({ url, place, actions }: { url: string; place: AlsoPlace; actions: RowActions }) {
  const Arrow = ALSO_UP[place] ? ArrowUp : ArrowDown;
  return (
    <button type="button" className="morning-more-quiet morning-also" {...SHORTCUT} data-overview-also={place} aria-label={`Also listed in ${PLACE_LABEL[place]}`}
      title={`Also listed in ${PLACE_LABEL[place]} · A`} onClick={() => actions.reveal(url, place)}>
      <Arrow size={12} aria-hidden="true" />
      {PLACE_LABEL[place]}
    </button>
  );
}

/** "3 more", "2 more stacks", "+4 more": shows the rest of a list. A row in the section's keyboard order. */
function MoreRow({ id, label, spoken, tabStop, actions, depth, chain = false }: { id: string; label: string; spoken: string; tabStop: boolean; actions: RowActions; depth: number; chain?: boolean }) {
  return (
    <li className={`morning-row morning-more-row is-nested depth-${depth}${chain ? ' is-chain is-gap' : ''}`} data-overview-row-item={id}>
      <div className="morning-row-inner">
        <span className="overview-row-gutter" />
        {chain && <span className="stack-chain-node" aria-hidden="true" />}
        <button type="button" className="morning-more-quiet" data-overview-row={id} data-overview-more-row tabIndex={tabStop ? 0 : -1} aria-label={spoken}
          onFocus={() => actions.focus(id)} onBlur={actions.blur} onKeyDown={actions.keyDown} onClick={() => actions.toggle(id)}>
          {label}
          {!chain && <ChevronRight size={13} aria-hidden="true" />}
        </button>
      </div>
    </li>
  );
}

/** A person or blocker and its PRs: inline when there are few, else behind a chevron, `GROUP_SHOWN` at a time. */
const GroupRows = memo(
  function GroupRows({ id, group, now, open, tabStop, nudged = false, actions }: {
    id: string;
    group: PersonGroup;
    now: number;
    /** The opened ids within this group (`openWithin`). */
    open: string;
    tabStop: string | undefined;
    nudged?: boolean;
    actions: RowActions;
  }) {
    const label = useRepoLabel();
    const view = groupView(group, id, openSet(open));
    const name = groupLabel(group);
    const quick = group.nudge ? (
      nudged ? (
        <span className="morning-done">Nudged</span>
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`Request ${group.nudge.reviewer}’s review again… · A`} onClick={() => actions.nudge(group)}>
          <NudgeIcon size={13} aria-hidden="true" />
          Nudge
        </Button>
      )
    ) : group.kind === 'you' ? (
      <Button size="xs" variant="ghost" {...SHORTCUT} title="Open Fix in the review queue · A" onClick={() => actions.show('fix')}>
        All {group.urls.length}
        <ChevronRight size={13} aria-hidden="true" />
      </Button>
    ) : undefined;
    const spoken = `${name}, ${reposSpoken(group.repos, label)}, ${group.detail.replace(/\b\d+ (m|h|d|w)\b/, (value) => spokenWaiting(value))}${group.check ? `, ${group.check.spoken}` : ''}`;
    const first = group.lines.at(0);
    return (
      <>
        <RowShell
          id={id}
          tabStop={tabStop === id}
          actions={actions}
          label={`${name} · ${group.detail}`}
          title={name}
          icon={<GroupIcon group={group} />}
          repos={group.repos}
          detail={group.detail}
          check={group.check}
          quick={quick}
          expanded={view.disclosure ? view.expanded : undefined}
          description={`${spoken}${view.disclosure ? `. ${view.expanded ? 'Expanded' : 'Collapsed'}` : ''}${group.nudge && !nudged ? '. A nudges' : ''}`}
          onActivate={() => (view.disclosure ? actions.toggle(id) : first && actions.open(first.row, first.target))}
        />
        {view.lines.map((line) => {
          const child = `${id}|${line.id}`;
          return <LineRow key={child} id={child} line={line} now={now} depth={1} tabStop={tabStop === child} actions={actions} showRepo={group.repos.length > 1} />;
        })}
        {view.more > 0 && <MoreRow id={`${id}|more`} label={`${view.more} more`} spoken={`Show ${view.more} more PRs of ${name}`} tabStop={tabStop === `${id}|more`} actions={actions} depth={1} />}
      </>
    );
  },
  (a, b) => groupSig(a.group, a.now) === groupSig(b.group, b.now) && a.open === b.open && a.tabStop === b.tabStop && a.nudged === b.nudged && a.actions === b.actions
);

/** "Waiting for earlier PRs in a stack to merge": open by default, a chain per stack, the most actionable first. */
const StacksRows = memo(
  function StacksRows({ id, group, now, open, tabStop, nudged, actions }: {
    id: string;
    group: PersonGroup;
    now: number;
    open: string;
    tabStop: string | undefined;
    nudged: ReadonlySet<string>;
    actions: RowActions;
  }) {
    const label = useRepoLabel();
    const set = openSet(open);
    const view = stacksView(group, id, set);
    return (
      <>
        <RowShell
          id={id}
          tabStop={tabStop === id}
          actions={actions}
          label={`${group.label} · ${group.detail}`}
          title={group.label}
          icon={<GroupIcon group={group} />}
          repos={group.repos}
          detail={group.detail}
          expanded={view.expanded}
          description={`${group.label}, ${reposSpoken(group.repos, label)}, ${group.detail}. ${view.expanded ? 'Expanded' : 'Collapsed'}`}
          onActivate={() => actions.toggle(id)}
        />
        {view.children.map((stack) => (
          <StackChain key={stack.key} id={`${id}|${stack.key}`} stack={stack} now={now} open={set} tabStop={tabStop} nudged={nudged.has(`nudge:${stack.key}`)} actions={actions} />
        ))}
        {view.more > 0 && (
          <MoreRow id={`${id}|more`} label={`${view.more} more ${view.more === 1 ? 'stack' : 'stacks'}`} spoken={`Show ${view.more} more stacks`} tabStop={tabStop === `${id}|more`} actions={actions} depth={1} />
        )}
      </>
    );
  },
  (a, b) => groupSig(a.group, a.now) === groupSig(b.group, b.now) && a.open === b.open && a.tabStop === b.tabStop && a.actions === b.actions &&
    [...a.nudged].join() === [...b.nudged].join()
);

/**
 * One stack: a header with the stack icon, its name, its repository once, and the step that moves it (Merge, Nudge or
 * Open), then its chain in merge order, base first, on a thin connector as on the stack page (`StackDependencyChain`).
 * A merge step says what it goes ahead without, as Next up does: "Merge #376 (not reviewed, no checks) to unblock 3
 * PRs". Every PR of the chain is a full line; one another section lists too ends in a link there ("↑ Next up").
 */
function StackChain({ id, stack, now, open, tabStop, nudged, actions }: { id: string; stack: PersonGroup; now: number; open: Open; tabStop: string | undefined; nudged: boolean; actions: RowActions }) {
  const label = useRepoLabel();
  const unread = useContext(Unread);
  const step = stack.step;
  if (!step) return null;
  const size = stack.chain?.length ?? stack.urls.length;
  const spoken = `Stack ${stack.label}, ${prs(size)}, next: ${step.text}`;
  const quick =
    step.action === 'merge' && step.row ? (
      <MergeAction row={step.row} actions={actions} caveats={step.caveats} />
    ) : step.action === 'review' && step.row ? (
      <Button size="xs" variant="outline" {...SHORTCUT} title={`${reviewVerb(step.row)} first · A`} onClick={() => step.row && actions.open(step.row)}>
        {reviewVerb(step.row)}
      </Button>
    ) : step.action === 'nudge' && step.reviewer ? (
      nudged ? (
        <span className="morning-done">Nudged</span>
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`Request ${step.reviewer}’s review of #${step.member.number} again… · A`}
          onClick={() => actions.nudge({ key: `nudge:${stack.key}`, kind: 'person', label: step.reviewer ?? '', detail: '', rows: [], urls: [], repos: [], lines: [], oldest: 0, nudge: { reviewer: step.reviewer ?? '', members: [step.member] } })}>
          <NudgeIcon size={13} aria-hidden="true" />
          Nudge
        </Button>
      )
    ) : (
      <Button size="xs" variant="ghost" {...SHORTCUT} data-reveal title={`Open #${step.member.number}, ${step.member.title} · A`} onClick={() => actions.open(step.row ?? stack.rows[0], prTarget(step.member.url))}>
        Open #{step.member.number}
      </Button>
    );
  const openBase = () => actions.open(step.row ?? stack.rows[0], prTarget(step.member.url));
  const node = (member: ReviewMember) => (
    <span className="stack-chain-node" data-overview-icon="pr" aria-hidden="true">
      <PrStateIcon pr={member} size={14} decorative />
    </span>
  );
  return (
    <li className="morning-stack depth-1" data-overview-stack={stack.key}>
      <RowShell
        as="div"
        id={id}
        tabStop={tabStop === id}
        actions={actions}
        depth={1}
        className="morning-stack-head"
        label={`${stack.label}\n${step.text}`}
        title={stack.label}
        icon={<GroupIcon group={stack} />}
        repos={stack.repos}
        detail={step.conflicts ? <Conflicts>{step.text}</Conflicts> : step.text}
        meta={prs(size)}
        quick={quick}
        menu={stackMenu(id, stack, actions, unread(stack.lines.map((line) => line.member)), openBase)}
        menuLabel={`stack ${stack.label}`}
        description={`${spoken}. ${reposSpoken(stack.repos, label)}${step.action === 'merge' ? `. A merges #${step.member.number}` : step.action === 'review' ? `. A opens the ${step.row ? reviewVerb(step.row).toLowerCase() : 'review'}` : step.action === 'nudge' && !nudged ? '. A nudges' : `. A opens #${step.member.number}`}`}
        onActivate={openBase}
      />
      <ul className="morning-chain" aria-label={spoken}>
        {chainView(stack, id, open).map((entry) => {
          if (entry.kind === 'gap')
            return <MoreRow key="gap" id={`${id}|more`} label={`+${entry.count} more`} spoken={`Show ${entry.count} more PRs of this stack`} tabStop={tabStop === `${id}|more`} actions={actions} depth={2} chain />;
          const child = `${id}|${entry.line.id}`;
          return <LineRow key={child} id={child} line={entry.line} now={now} depth={2} tabStop={tabStop === child} actions={actions} showRepo={false} chain node={node(entry.line.member)} also={entry.also} />;
        })}
      </ul>
    </li>
  );
}

const DecisionRow = memo(
  function DecisionRow({ item, waited, tabStop, actions }: { item: DecisionItem; waited: string; tabStop: boolean; actions: RowActions }) {
    const { row, member } = item;
    const label = useRepoLabel();
    const unread = useContext(Unread);
    return (
      <RowShell
        id={item.id}
        tabStop={tabStop}
        actions={actions}
        label={`${member.title}\n${item.label}`}
        title={member.title}
        number={member.number}
        preview={{ url: member.url, number: member.number, title: member.title }}
        prs={[member.url]}
        repos={[member.repo]}
        detail={item.conflicts ? <>{item.label} · <Conflicts /></> : item.label}
        check={item.check}
        comments={item.comments}
        waited={{ since: item.since, source: item.source, label: waited }}
        icon={<PrIcon member={member} />}
        quick={
          <>
            <Button size="xs" variant="outline" {...SHORTCUT} title="Close this PR… · A" onClick={() => actions.close(member)}>
              <CloseIcon size={13} aria-hidden="true" />
              Close PR
            </Button>
            <Button size="icon-xs" variant="ghost" tabIndex={-1} aria-keyshortcuts="Z" aria-label="Snooze" title="Snooze… · Z" onClick={() => actions.snooze(item.id)}>
              <SnoozeIcon size={13} aria-hidden="true" />
            </Button>
          </>
        }
        menu={prMenu(item.id, row, actions, unread([member]), member, [member], prTarget(member.url) ?? row.target)}
        menuLabel={`PR #${member.number}`}
        description={`${item.label}${item.conflicts ? ', conflicts' : ''}, ${label(member.repo)} #${member.number}, ${item.check.spoken}, ${extrasSpoken(item.comments, waited)}. A closes, Z snoozes`}
        onActivate={() => actions.open(row)}
      />
    );
  },
  (a, b) => a.item.row.signature === b.item.row.signature && a.item.label === b.item.label && a.item.check.label === b.item.check.label && a.item.comments === b.item.comments &&
    a.item.conflicts === b.item.conflicts && a.item.since === b.item.since && a.waited === b.waited && a.tabStop === b.tabStop && a.actions === b.actions
);

declare global {
  interface Window {
    /** Browser checks count Overview row renders when `__countRenders` is set. */
    __overviewRowRenders?: number;
    /** The rows those renders were for. */
    __overviewRenderedRows?: string[];
  }
}
const reviewVerb = (row: OverviewRow) => (row.reasons.includes('updated-since-review') ? 'Re-review' : 'Review');
const menuFor = (row: OverviewRow) => (row.kind === 'stack' ? `stack ${row.title}` : `PR #${row.focus.number}`);
/**
 * The menu every PR row shares: open, snooze, mark read, copy, Open on GitHub. `members`: the PRs the row stands for,
 * which Snooze and Mark as read act on; one PR's row says "Snooze PR…", a row for several of a stack "Snooze stack…".
 */
function prMenu(id: string, row: OverviewRow, actions: RowActions, unread: boolean, member: ReviewMember, members: readonly ReviewMember[], target?: DeepLinkTarget): EntryActionGroups {
  return [
    [{ label: 'Open', run: () => actions.open(row, target) }],
    [
      { label: members.length > 1 ? 'Snooze stack…' : 'Snooze PR…', run: () => actions.snooze(id) },
      { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(members.map((entry) => entry.url)) },
    ],
    [
      { label: 'Copy link', run: () => actions.copy(member.url, 'Link') },
      { label: 'Copy repository', run: () => actions.copy(member.repo, 'Repository') },
      { label: 'Copy PR number', run: () => actions.copy(`#${member.number}`, 'PR number') },
    ],
    [{ label: 'Open on GitHub', run: () => void window.electronAPI.openExternal(member.url) }],
  ];
}
/** A stack header's menu: the stack's part of `prMenu` (open its base, snooze the stack, mark it read). */
function stackMenu(id: string, stack: PersonGroup, actions: RowActions, unread: boolean, open: () => void): EntryActionGroups {
  return [
    [{ label: 'Open', run: open }],
    [
      { label: 'Snooze stack…', run: () => actions.snooze(id) },
      { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(stack.lines.map((line) => line.member.url)) },
    ],
  ];
}
/** Merge, with its confirmation (`PrActions`). `caveats`: what the merge goes ahead without, for the tooltip. */
function MergeAction({ row, actions, caveats = [] }: { row: OverviewRow; actions: RowActions; caveats?: readonly string[] }) {
  // Base first: in a stack, the lowest PR in the lane merges first (`OverviewMerge.member`).
  const member = row.merge?.member ?? row.focus;
  return (
    <PrActions
      member={member}
      compact
      onChanged={actions.refresh}
      onResult={(message) => toast.add({ type: 'success', title: message })}
      trigger={(open, busy) => (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`Merge #${member.number}${caveats.length ? ` (${caveats.join(', ')})` : ''}… · A`} disabled={busy} onClick={() => open('merge')}>
          <MergeIcon size={13} aria-hidden="true" />
          Merge
        </Button>
      )}
    />
  );
}
