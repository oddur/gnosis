/**
 * The Overview (#390): the morning page. It answers, in order, what happened since you left, what to do next, who is
 * blocked on you, where your PRs are stuck and on whom, and what to close or park.
 *
 * - The briefing sentence, counted from the sections, each number a link that marks and focuses the rows it counts
 *   (`morningBriefing`), a "Since yesterday" line (`lib/since-log.ts`), and one freshness line: "Up to date · 2m ago",
 *   or the one thing that is not, with a quiet note while the PR list is re-read in the background ("Refreshing PR
 *   list · 120 of 273"). See lib/overview-freshness.ts.
 * - **Next up:** up to five things to do, people blocked on you first, then approved merges, then fixes, each with one
 *   action. A merge nobody reviewed is never a row: the quiet line under it counts them.
 * - **Waiting on you** and **Waiting on others**, full width one above the other: people, and your PRs by blocker,
 *   with Nudge. Stacks are one line each, with the step that moves them; Enter or a click expands the chain in merge
 *   order, base first, and expanded stacks are remembered per account (`overviewStacksKey`).
 * - **Needs a decision:** your PRs failing, never approved or idle for over a week, with Close PR (Snooze in the menu).
 * - **Starred**, first, above them all, only when something is starred: the PRs and stacks the user starred as their
 *   top work, most actionable first, each with its state and one action (lib/overview-starred.ts). A starred PR is
 *   listed there and nowhere else on the page. A stack lists its PRs under it in merge order, on the chain the stacks
 *   in Waiting on others use. Like every section, it lists only open PRs, drafts included: a starred PR that merged or
 *   closed stays starred but leaves the page, and the section hides when nothing is left. Eight show, then "Show all N". Every row menu can star or unstar its PRs; an unstarred row leaves the section.
 *
 * Each PR is listed once on the page (`lib/morning.ts`, "Each PR once"), except in a stack's chain, which shows every PR
 * of the stack as a full line and links to the section that also lists one ("↑ Next up"). Every heading counts what it
 * lists, each PR once: Next up its rows, the others their PRs. Waiting on you names the Next up rows that hold its PRs.
 * Every PR line leads with its state icon (`PrStateIcon`; a row for several PRs of a stack, the stack icon) and its
 * number, then its title, which takes the room; one compact status cell (check state, then comments above 0) and how
 * long it has waited sit in fixed columns that
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
import { AlertCircle, ArrowDown, ArrowUp, ChevronRight, ListChecks, MessageSquare, Play, RefreshCw, Settings, UserRound, UsersRound, X } from 'lucide-react';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useOverview } from '../lib/use-overview';
import { useMorningExtras } from '../lib/use-morning';
import { useStatusNow } from '../lib/status-clock';
import { overviewFreshness, type FreshnessLine, type OverviewFreshness } from '../lib/overview-freshness';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey } from '../lib/repository-settings';
import { prTarget, type DeepLinkTarget } from '../lib/deep-link';
import { publishOverviewCount } from '../lib/overview-count';
import { actionIcons, checkSummaryIcons, conflictIcon as ConflictIcon, subjectIcons, waitingIcon as WaitingIcon } from '../lib/interface-icons';
import { githubAvatarUrl } from '../lib/github-profile';
import type { CheckView } from '../lib/check-summary';
import type { PrChecks } from '../lib/pr-checks';
import { OVERVIEW_SINCE_LABEL, waitingLabel, spokenWaiting, type OverviewActionGroup, type OverviewModel, type OverviewRow, type OverviewSinceSource } from '../lib/overview';
import {
  CHAIN_STATUS_LABEL,
  FIX_LABEL,
  PLACE_LABEL,
  chainNumber,
  morningPage,
  qualifyChains,
  stackLine,
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
  type BriefingCount,
  type ChainNode,
  type DecisionItem,
  type GroupLine,
  type NextItem,
  type PageLink,
  type PersonGroup,
} from '../lib/morning';
import { sinceLabel, sinceLine, sinceSummary } from '../lib/since-log';
import { STARRED_SHOWN, starredSection, type StarredAction, type StarredEntry, type StarredLine, type StarredSection } from '../lib/overview-starred';
import { openSnoozePicker } from '../lib/snooze-picker';
import { writeErrorDetail } from '../lib/write-failures';
import { TeamRequestsNote } from './TeamRequestsNote';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { starAction } from './PrEntryActions';
import { PrPreviewTooltip } from './EntityBadge';
import { PrActions } from './PrActions';
import { MergeSplit } from './PrActionControls';
import { PrStateIcon } from './PrStateIcon';
import { BulkCheckRerun } from './BulkCheckRerun';
import { LoadingIndicator, LoadingState } from './LoadingState';
import { ClosePrDialog, NudgeDialog } from './OverviewWrites';
import { RepositoryIcon } from './RepositoryAppearance';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { Button } from './ui/button';
import { GuidedSession, type SessionOpen, type StepAbout } from './GuidedSession';
import { heldForkRuns, plainText, sessionSteps, settlePark, type DepthContext, type Park, type ParkAction, type ParkResult, type SessionStep, type StepOutcome } from '../lib/guided-session';
import { answerSessionRequests, peekSessionState, publishSession, takeSessionRequest, type SessionRequest } from '../lib/session-store';
import { toast } from './ui/toast';

export interface OverviewPageProps {
  queue: Pick<WorkbenchQueue, 'items' | 'sync' | 'readStates' | 'starredItems' | 'starredPrs'>;
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
  /** Opens the queue grouped by Action, at this group. */
  onShowLane: (group: OverviewActionGroup) => void;
  onMarkRead: (urls: string[]) => void;
  /** Stars or unstars PRs, as the queue's star toggle does. Without it, row menus offer no star. */
  onStarChange?: (members: ReviewMember[], starred: boolean) => void;
  /** Mute PRs: they leave every list until unmuted. Resolves true once saved; the page shows the toast and its Undo. */
  onMute?: (members: ReviewMember[]) => Promise<boolean>;
  /** A star change is being saved: the star toggle waits, as in the queue. */
  starBusy?: boolean;
  /** Opens an item in this window when no workspace tabs are available. */
  onOpenItem: (item: QueueItem) => void;
  onRepositories: () => void;
  onConnect: () => void;
  /** The lanes, for the queue's lane filter and Action grouping. */
  onModel?: (model: OverviewModel) => void;
}

/**
 * After Refresh, the spinner waits this long at most for main to answer with the pass's state. Main broadcasts the
 * pass as it starts, so this only bridges the click and that broadcast.
 */
const ASKED_MS = 5_000;

type Section = 'starred' | 'next' | 'you' | 'others' | 'decide';
const SECTIONS: readonly Section[] = ['starred', 'next', 'you', 'others', 'decide'];
const SECTION_LABEL: Readonly<Record<Section, string>> = {
  starred: 'Starred',
  next: 'Next up',
  you: 'Waiting on you',
  others: 'Waiting on others',
  decide: 'Needs a decision',
};
/** Needs a decision lists this many before "Show N more". */
const DECIDE_SHOWN = 6;
/** The section a row id belongs to: ids are `${section}|…`. */
const sectionOf = (id: string) => id.slice(0, id.indexOf('|')) as Section;
/** Starred's "Show all N", by its id in the opened set. A starred stack's own id there means it is collapsed. */
const STARRED_MORE = 'starred|more';
/** The starred entries shown: `STARRED_SHOWN`, or all of them after "Show all N". */
const starredShown = (section: Pick<StarredSection, 'entries'>, open: Open) => (open.has(STARRED_MORE) ? section.entries : section.entries.slice(0, STARRED_SHOWN));
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
  /** A chain's line for a PR another section lists: that section's row is the one that counts it. */
  also?: boolean;
}

/** A guided session's run (#596): its steps as they were when it started, where it is, and what happened to each. */
interface GuidedRun {
  steps: SessionStep[];
  index: number;
  outcomes: Partial<Record<string, StepOutcome>>;
  open: boolean;
  /** Steps parked while a slow action runs, by id; each leaves once it resolves. */
  parked?: Partial<Record<string, Park>>;
  /** What each resolved park came to, by id. */
  results?: Partial<Record<string, ParkResult>>;
}
/** The run outlives the page: the app keeps one Overview, but bringing its tab back can mount the page anew. */
let keptSession: GuidedRun | null = null;
/**
 * Back or Next from a PR's session bar, applied to a run: back to the PR's step, or on to the one after it. A PR
 * finished where it was opened (a review, or every change viewed) moved on in this run.
 */
function answerRequest(run: GuidedRun | null, request: SessionRequest, url: string): GuidedRun | null {
  if (!run) return run;
  const at = run.steps.findIndex((step) => step.member.url === url);
  if (at < 0) return run;
  const finished = peekSessionState()?.finished.has(url);
  const outcomes = finished ? { ...run.outcomes, [run.steps[at].id]: 'done' as const } : run.outcomes;
  return { ...run, outcomes, open: true, index: request === 'next' ? at + 1 : at };
}

export function OverviewPage(props: OverviewPageProps) {
  const { queue, login, scope, authenticated, hasRepositories, loading, refreshing, visible, live, keyboard, teamRequests, excluded, error, onDismissError, setup, onRepositories, onConnect, onModel } = props;
  // Starred work: main's starred entries. The section lists only their open PRs (lib/overview-starred.ts).
  const starredItems = useMemo(() => queue.starredItems ?? queue.items.filter((item) => item.starred), [queue.starredItems, queue.items]);
  const view = useOverview({ items: queue.items, starred: starredItems, login: authenticated ? login : null, scope: authenticated ? scope : null, live, visible, ready: !loading, teamRequests, excluded });
  useEffect(() => { onModel?.(view); }, [view, onModel]);
  const account = authenticated ? login : null;
  const extras = useMorningExtras(view, account, visible);
  const now = useStatusNow() || Date.now();
  const navigation = useWorkspaceNavigation();
  // The home screen passes new callbacks on every render. Rows read them through this ref, so a home screen render
  // never renders the rows again.
  const callbacks = useRef(props);
  callbacks.current = props;
  // The Overview never asks main for a sync on its own: discovery runs on main's schedule (src/main.ts,
  // `discoveryInterval`, every 2 to 5 minutes after the last pass, and within 10 s of a window showing again). Asking
  // more often only piled requests onto a pass that is already paced. Refresh is the reader's way to ask.
  // After Refresh, a spinner until main answers with a new sync state (`ASKED_MS` at most).
  const syncKey = JSON.stringify(queue.sync ?? null);
  const [asked, setAsked] = useState<{ at: number; key: string } | null>(null);
  useEffect(() => {
    if (!asked) return;
    if (asked.key !== syncKey) { setAsked(null); return; }
    const timer = setTimeout(() => setAsked(null), Math.max(0, asked.at + ASKED_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [asked, syncKey]);
  const refreshNow = useCallback(() => {
    setAsked({ at: Date.now(), key: syncKey });
    callbacks.current.onRefresh();
  }, [syncKey]);

  // PRs closing on GitHub leave the page at once; a refusal brings them back.
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const [nudged, setNudged] = useState<ReadonlySet<string>>(new Set());
  const starred = useMemo(
    () => starredSection({ items: account ? starredItems : [], model: view, now, login: account ?? '', signals: view.statusOf, hidden: closing, excluded }),
    [starredItems, view, now, account, closing, excluded]
  );
  const morning = useMemo(
    () => morningPage({ model: view, now, login: account ?? '', signals: view.statusOf, rereviewLines: extras.rereviewLines, replies: extras.replies, hidden: closing, starred }),
    [view, now, account, extras.rereviewLines, extras.replies, closing, starred]
  );
  // A guided session (#596): one run through Next up, then the decisions. It walks the steps as they were when it
  // started; the page's live steps say which have moved on (they left the page).
  const liveSteps = useMemo(() => sessionSteps(morning), [morning]);
  const liveById = useMemo(() => new Map(liveSteps.map((step) => [step.id, step])), [liveSteps]);
  // Kept outside the page too (`keptSession`): bringing the Overview tab back can mount the page anew.
  const [session, setSessionState] = useState<GuidedRun | null>(() => {
    // A Back or Next that came while the page was not mounted: the bar brought this tab forward to answer it.
    const waiting = takeSessionRequest();
    if (waiting) keptSession = answerRequest(keptSession, waiting.request, waiting.url);
    return keptSession;
  });
  const setSession = useCallback((update: GuidedRun | null | ((value: GuidedRun | null) => GuidedRun | null)) => {
    keptSession = typeof update === 'function' ? update(keptSession) : update;
    setSessionState(keptSession);
  }, []);
  // A PR the session opened shows where it is in the run, and its way back and on (components/SessionBar.tsx).
  const running = session && session.index < session.steps.length ? session : null;
  const sessionKey = running ? `${running.index}|${running.steps.map((step) => step.id).join(' ')}` : '';
  useEffect(() => {
    if (!running) {
      publishSession(null);
      return;
    }
    publishSession({
      index: running.index,
      steps: running.steps.map((step) => ({ id: step.id, url: step.member.url, number: step.member.number, title: step.title, why: step.why })),
    });
    // `sessionKey` is what the published steps depend on: a status tick that changes no step publishes nothing.
  }, [sessionKey]);
  useEffect(
    () =>
      // Back and Next from a PR's session bar while the page is mounted, applied to the kept run at once.
      answerSessionRequests((request, url) => setSession((value) => answerRequest(value, request, url))),
    [setSession]
  );
  // A slow action started from the session (rerun failed checks, update the branch) parks its step: the session
  // moves on at once, and the step comes back, with its result, once GitHub shows one (`settlePark`).
  const parkStep = useCallback(
    (step: SessionStep, action: ParkAction) =>
      setSession((value) => {
        if (!value || !value.steps.some((each) => each.id === step.id)) return value;
        const head = liveById.get(step.id)?.member.headSha ?? step.member.headSha;
        // A park started again drops the result of the last one.
        const results = Object.fromEntries(Object.entries(value.results ?? {}).filter(([id]) => id !== step.id));
        const here = value.steps[value.index]?.id === step.id;
        return {
          ...value,
          outcomes: { ...value.outcomes, [step.id]: 'parked' },
          parked: { ...value.parked, [step.id]: { action, headSha: head, at: Date.now() } },
          results,
          index: here ? value.index + 1 : value.index,
        };
      }),
    [setSession, liveById]
  );
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const parked = session?.parked;
    if (!parked || !Object.keys(parked).length) return;
    const settled: Partial<Record<string, ParkResult>> = {};
    const going: Partial<Record<string, Park>> = {};
    let changed = false;
    for (const [id, park] of Object.entries(parked)) {
      if (!park) continue;
      const step = liveById.get(id);
      // A step that left the page moved on: its park has nothing left to wait for.
      if (!step) {
        changed = true;
        continue;
      }
      const next = settlePark(park, step.member.headSha, view.statusOf(step.member), now);
      if ('result' in next) {
        settled[id] = next.result;
        changed = true;
      } else {
        going[id] = next.park;
        if (next.park !== park) changed = true;
      }
    }
    if (!changed) return;
    setSession((value) => {
      if (!value) return value;
      // A resolved step is back on your list, or moved on when its action came to that.
      const outcomes = Object.fromEntries(
        Object.entries(value.outcomes).flatMap(([id, outcome]): [string, StepOutcome][] => {
          if (!(id in parked) || going[id]) return outcome ? [[id, outcome]] : [];
          return settled[id]?.outcome === 'done' ? [[id, 'done']] : [];
        })
      );
      return { ...value, outcomes, parked: going, results: { ...value.results, ...settled } };
    });
    // The step comes back: a toast says what its action came to, with the way back to it.
    for (const [id, result] of Object.entries(settled)) {
      const at = session.steps.findIndex((step) => step.id === id);
      const key = `${id}@${parked[id]?.at}`;
      if (!result || at < 0 || announced.current.has(key)) continue;
      announced.current.add(key);
      const toastId = toast.add({
        type: result.tone === 'success' ? 'success' : result.tone === 'danger' ? 'error' : 'info',
        title: `#${session.steps[at].member.number}: ${result.text}`,
        actionProps: { children: 'Show', onClick: () => { toast.close(toastId); setSession((value) => value && { ...value, index: at, open: true }); } },
      });
    }
  }, [session?.parked, liveById, view, now, setSession]);
  // What the depth rules read beyond the step: the PR's paths, read once per head for a PR you review, and its author's
  // association from the status read.
  const [sessionPaths, setSessionPaths] = useState<Partial<Record<string, readonly string[] | null>>>({});
  const currentStep = session?.open && session.index < session.steps.length ? (liveById.get(session.steps[session.index].id) ?? session.steps[session.index]) : undefined;
  const pathsKey = currentStep && (currentStep.kind === 'review' || currentStep.kind === 'rereview') ? `${currentStep.member.url}@${currentStep.member.headSha}` : undefined;
  useEffect(() => {
    if (!pathsKey || !currentStep || sessionPaths[pathsKey] !== undefined) return;
    // Optional in test fixtures that mock no file list: then no path rule fires.
    if (typeof window.electronAPI.getPrFiles !== 'function') return;
    let cancelled = false;
    void window.electronAPI
      .getPrFiles(currentStep.member.url)
      .then((files) => files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))
      // Unread paths make no rule fire; the next step that needs them tries again.
      .catch(() => null)
      .then((paths) => {
        if (!cancelled) setSessionPaths((value) => ({ ...value, [pathsKey]: paths }));
      });
    return () => {
      cancelled = true;
    };
  }, [pathsKey]);
  const sessionDepthContext = (step: SessionStep): DepthContext => {
    const paths = sessionPaths[`${step.member.url}@${step.member.headSha}`];
    const association = view.statusOf(step.member)?.authorAssociation;
    return { ...(paths ? { paths } : {}), ...(association ? { authorAssociation: association } : {}) };
  };
  const startSession = () =>
    setSession((value) => (value && value.index < value.steps.length ? { ...value, open: true } : { steps: liveSteps, index: 0, outcomes: {}, open: true }));
  // Which PRs are starred, for the row menus' Star and Unstar: one string, so a sync tick that changes no star keeps
  // the row actions, and with them every memoized row, as they were.
  const starKey = (queue.starredPrs ?? []).map((entry) => entry.member.url).sort().join(' ');
  const starredUrls = useMemo(() => new Set(starKey ? starKey.split(' ') : []), [starKey]);
  // The tab title counts Next up and Waiting on you, each PR once (lib/morning.ts, `morningCount`).
  useEffect(() => {
    if (account && !loading) publishOverviewCount(account, morning.count);
  }, [account, loading, morning.count]);
  // Repositories by their short name, or owner/repo where two share one.
  const repoKey = [...new Set(queue.items.flatMap((item) => item.subject.members.map((member) => member.repo)))].sort().join(',');
  const repoNames = useMemo(() => repositoryNames(repoKey ? repoKey.split(',') : []), [repoKey]);
  const since = useMemo(() => sinceLine(sinceSummary(extras.since.events, extras.since.from), extras.since.from, now), [extras.since, now]);

  // Stacks are one line each until expanded; the expanded ones are remembered per account on this computer.
  const stacksKey = account ? overviewStacksKey(account) : null;
  const [opened, setOpened] = useState<Open>(() => new Set(readExpandedStacks(stacksKey)));
  const restored = useRef(stacksKey);
  useEffect(() => {
    if (restored.current === stacksKey) return;
    restored.current = stacksKey;
    const saved = readExpandedStacks(stacksKey);
    if (saved.length) setOpened((value) => new Set([...value, ...saved]));
  }, [stacksKey]);
  useEffect(() => {
    if (stacksKey && restored.current === stacksKey) saveExpandedStacks(stacksKey, opened);
  }, [stacksKey, opened]);
  const [allDecisions, setAllDecisions] = useState(false);
  const toggle = useCallback((id: string) => setOpened((value) => {
    const next = new Set(value);
    if (!next.delete(id)) next.add(id);
    return next;
  }), []);
  // Every row id per section in reading order, and what each row is.
  const { order, refs } = useMemo(() => {
    const refs = new Map<string, RowRef>();
    const order: Record<Section, string[]> = { starred: [], next: [], you: [], others: [], decide: [] };
    const push = (section: Section, id: string, ref: RowRef) => {
      order[section].push(id);
      refs.set(id, ref);
    };
    // Starred first: each entry, then a stack's PRs while it is expanded, as it is by default.
    for (const entry of starredShown(starred, opened)) {
      push('starred', entry.id, { row: entry.lead.row, members: entry.lines.map((line) => line.member) });
      if (entry.kind === 'stack' && !opened.has(entry.id))
        for (const line of entry.lines) push('starred', `${entry.id}|${line.id}`, { row: line.row, members: [line.member] });
    }
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
            if (!opened.has(sid)) continue;
            for (const step of chainView(stack, sid, opened)) {
              if (step.kind === 'line') {
                lines(section, sid, [step.line]);
                if (step.also) refs.set(`${sid}|${step.line.id}`, { row: step.line.row, members: [step.line.member], also: true });
              }
              else push(section, `${sid}|more`, { members: [] });
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
  }, [morning, starred, opened, allDecisions]);
  const latest = useRef({ order, refs });
  latest.current = { order, refs };
  // One roving tab stop per section: the row last focused there, else its first.
  const [current, setCurrent] = useState<Partial<Record<Section, string>>>({});
  const tabStop = (section: Section) => {
    const id = current[section];
    return id && order[section].includes(id) ? id : order[section][0];
  };

  const root = useRef<HTMLDivElement>(null);
  /** Opens `target` in a workspace tab, else the item in this window. */
  const openItem = useCallback(
    (item: QueueItem, target: DeepLinkTarget) => {
      if (navigation?.openTarget)
        void navigation.openTarget(target).catch((error: unknown) =>
          toast.add({ type: 'error', title: 'Could not open this PR', description: error instanceof Error ? error.message : String(error) })
        );
      else callbacks.current.onOpenItem(item);
    },
    [navigation]
  );
  const open = useCallback((row: OverviewRow, target: DeepLinkTarget = row.target) => openItem(row.item, target), [openItem]);
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
  // The rows that list `urls`: a briefing number, a pointer ("#377 is in Next up") or a chain line's "↑ Next up".
  // Groups that hold them open first; then the rows are marked for a moment, scrolled to, and the first is focused.
  const latestMorning = useRef(morning);
  latestMorning.current = morning;
  const latestStarred = useRef(starred);
  latestStarred.current = starred;
  const marked = useRef<{ timer: number; ids: string[] }>({ timer: 0, ids: [] });
  const showRows = useCallback(
    (urls: readonly string[], given: { place?: Section; line?: boolean } = {}) => {
      // Merges: Next up's rows and its quiet line count them; a stack's base line that names one is not the count.
      const options = given.line ? { ...given, place: 'next' as const } : given;
      const wanted = new Set(urls);
      const page = latestMorning.current;
      const holds = (lines: readonly GroupLine[]) => lines.some((line) => wanted.has(line.id));
      const stars = latestStarred.current.entries;
      setOpened((value) => {
        const next = new Set(value);
        // Starred: a collapsed stack that holds them expands, and so does the list when they are past its cap.
        if (!options.place || options.place === 'starred' || given.line) {
          for (const entry of stars) if (entry.kind === 'stack' && entry.urls.some((url) => wanted.has(url))) next.delete(entry.id);
          if (stars.slice(STARRED_SHOWN).some((entry) => entry.urls.some((url) => wanted.has(url)))) next.add(STARRED_MORE);
        }
        for (const [section, groups] of [['you', page.you], ['others', page.others]] as const) {
          if (options.place && options.place !== section) continue;
          for (const group of groups) {
            const id = `${section}|${group.key}`;
            if (group.kind === 'stacks') {
              const children = group.children ?? [];
              const holding = children.filter((child) => holds(child.lines));
              if (!holding.length) continue;
              next.delete(id);
              if (children.some((child, i) => i >= STACKS_SHOWN && holds(child.lines))) next.add(`${id}|more`);
              // A stack's PRs are its chain's lines: the stacks that hold them expand.
              for (const child of holding) {
                next.add(`${id}|${child.key}`);
                if ((child.chain ?? []).length > CHAIN_SHOWN) next.add(`${id}|${child.key}|more`);
              }
              continue;
            }
            if (!holds(group.lines) || group.lines.length <= INLINE_LIMIT) continue;
            next.add(id);
            if (group.lines.some((line, i) => i >= GROUP_SHOWN && wanted.has(line.id))) next.add(`${id}|more`);
          }
        }
        return next;
      });
      if ((!options.place || options.place === 'decide') && page.decide.slice(DECIDE_SHOWN).some((item) => wanted.has(item.member.url))) setAllDecisions(true);
      // After the groups have opened.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const { order: rows, refs: known } = latest.current;
        // A merge count's rows: Next up's and its quiet line, and the starred merges it counts too.
        const sections: readonly Section[] = given.line ? ['starred', 'next'] : options.place ? [options.place] : SECTIONS;
        let ids = sections.flatMap((section) => rows[section]).filter((id) => {
          if (id === MORE_UNREVIEWED) return !!options.line;
          const ref = known.get(id);
          return !!ref && !ref.also && ref.members.length > 0 && ref.members.every((member) => wanted.has(member.url));
        });
        // A group's own lines stand for it when they are shown.
        ids = ids.filter((id) => !ids.some((other) => other !== id && other.startsWith(`${id}|`)));
        const find = (id: string) => root.current?.querySelector<HTMLElement>(`[data-overview-row-item="${CSS.escape(id)}"]`);
        window.clearTimeout(marked.current.timer);
        for (const id of marked.current.ids) find(id)?.removeAttribute('data-overview-highlight');
        for (const id of ids) find(id)?.setAttribute('data-overview-highlight', '');
        marked.current = {
          ids,
          timer: window.setTimeout(() => {
            for (const id of ids) find(id)?.removeAttribute('data-overview-highlight');
            marked.current.ids = [];
          }, HIGHLIGHT_MS),
        };
        const first = ids[0];
        if (!first) return;
        focusRow(first);
        root.current?.querySelector<HTMLElement>(`[data-overview-row="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' });
      }));
    },
    [focusRow]
  );
  useEffect(() => () => window.clearTimeout(marked.current.timer), []);
  const reveal = useCallback((urls: readonly string[], place: AlsoPlace) => showRows(urls, { place }), [showRows]);
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

  const starrable = !!props.onStarChange && authenticated;
  const starBusy = !!props.starBusy;
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
      openItem,
      ...(starrable
        ? {
            star: {
              has: (members: readonly ReviewMember[]) => members.some((member) => starredUrls.has(member.url)),
              busy: starBusy,
              change: (members: readonly ReviewMember[], value: boolean) => callbacks.current.onStarChange?.([...members], value),
            },
          }
        : {}),
    }),
    // `starredUrls` changes only when a star does, so a sync tick keeps these actions.
    [open, openItem, snooze, toggle, onRowKeyDown, reveal, starredUrls, starrable, starBusy]
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
        toast.add({ type: 'error', title: `Could not close #${member.number}`, description: `${writeErrorDetail(cause)} The PR is still open. Try again, or close it on GitHub.` });
      }
    );
  }, []);


  const sync = queue.sync;
  const openActivity = navigation?.openTarget;
  // Nothing to vouch for while the first snapshot loads: the body says "Loading your work…".
  const freshness = authenticated && !(loading && !queue.items.length) ? overviewFreshness({ sync, status: view.status, now, asked: !!asked, saved: refreshing }) : {};
  const readStates = queue.readStates ?? {};
  const unread = (members: readonly ReviewMember[]) => members.some((member) => !!readStates[member.url]?.unread.length);
  const unreadOf = useCallback((members: readonly ReviewMember[]) => members.some((member) => !!readStates[member.url]?.unread.length), [readStates]);
  const ready = authenticated && !(loading && !queue.items.length) && !(!queue.items.length && !hasRepositories);
  // Next up counts its rows; the other headings count the PRs they list (lib/morning.ts, "Counts").
  const counts: Counts = {
    starred: starred.entries.length,
    next: nextCount(morning.next.items),
    you: sectionCount(morning.you),
    others: sectionCount(morning.others),
    decide: morning.decide.length,
  };
  const more = nextMoreLine(morning.next);
  const youNote = waitingOnYouNote(counts.you, morning.youElsewhere);
  const youPointer = youNote.parts.length ? <p className="morning-more-note" data-overview-you-elsewhere><Sentence parts={youNote.parts} onLink={(link) => showRows(link.urls, { place: link.place })} /></p> : null;
  const group = (section: 'you' | 'others', value: PersonGroup) => {
    const id = `${section}|${value.key}`;
    const inside = openWithin(opened, id);
    return value.kind === 'stacks' ? (
      <StacksRows key={value.key} id={id} group={value} now={now} open={inside} tabStop={tabStop(section)} nudged={nudged} actions={actions} />
    ) : (
      <GroupRows key={value.key} id={id} group={value} now={now} open={inside} tabStop={tabStop(section)} nudged={nudged.has(value.key)} actions={actions} />
    );
  };
  // The session's step card draws its primary action as Next up's row does: Merge and Rerun act in place; anything
  // else opens the PR, at the depth the step suggests.
  const sessionAction = (step: SessionStep): ReactNode | undefined => {
    if (step.kind === 'merge') return <MergeAction row={step.row} actions={actions} session />;
    // A decision: merge it when it can merge (the Overview's merge rule, unchanged); closing is the step's other way.
    if (step.kind === 'decide' && step.row.merge) return <MergeAction row={step.row} actions={actions} session />;
    if (step.kind === 'fix' && step.next?.fix === 'failing') {
      // Fork runs held for approval are not failures a rerun can clear (#595): a PR with only those has no Rerun.
      const failing = step.row.entries
        .filter((entry) => entry.reasons.includes('checks-failed') && step.urls.includes(entry.member.url))
        .map((entry) => entry.member)
        .filter((member) => {
          const signals = view.statusOf(member);
          return !signals || (signals.checks.failed ?? 0) > heldForkRuns(member, signals);
        });
      if (failing.length) return <RerunFailed members={failing} onChanged={actions.refresh} onRequested={() => parkStep(step, 'rerun-failed')} />;
    }
    return undefined;
  };
  // Mute from the session: a PR you no longer follow leaves every list, the queue's Mute (with its Undo toast).
  const sessionMute = props.onMute
    ? (step: SessionStep) => {
        const members = step.row.item.subject.members.filter((member) => step.urls.includes(member.url));
        return props.onMute?.(members.length ? members : [step.member]) ?? Promise.resolve(false);
      }
    : undefined;
  // Snooze from the session: the same picker as a row's Z, for the step's PRs (a stack's lane, or one PR).
  const sessionSnooze = (step: SessionStep, snoozed: () => void) => {
    const members = step.row.item.subject.members.filter((member) => step.urls.includes(member.url));
    return openSnoozePicker({ groups: [members.length ? members : [step.member]], onSnoozed: () => snoozed() });
  };
  const sessionSecondary = (step: SessionStep): ReactNode | undefined =>
    step.kind === 'decide' ? (
      <Button size="sm" variant="outline" title={`Close #${step.member.number}… · C`} data-session-close onClick={() => actions.close(step.member)}>
        <CloseIcon size={14} aria-hidden="true" />
        Close PR
        <kbd>C</kbd>
      </Button>
    ) : undefined;
  const sessionIdentity = (step: SessionStep): ReactNode => (
    <span className="guided-step-id">
      <PrIcon member={step.member} />
      <span>{repositoryLabel(repoNames, step.member.repo)}</span>
      <span className="guided-step-number">#{step.member.number}</span>
    </span>
  );
  // What the PR is about, under its title: its briefing's summary when one is ready, else the start of its description.
  const sessionAbout = (step: SessionStep): StepAbout | undefined => {
    const briefing = step.row.item.briefing;
    if (briefing?.status === 'ready' && briefing.summary?.trim()) return { text: briefing.summary.trim(), generated: true };
    const text = plainText(step.member.description);
    if (!text) return undefined;
    return { text: text.length > 280 ? `${text.slice(0, 279).replace(/\s+\S*$/, '')}…` : text, generated: false };
  };
  // Update branch and Mark ready from the card, through the PR header's actions: the same confirmations and refresh.
  const sessionPrAction = (step: SessionStep, kind: 'update-branch' | 'mark-ready'): ReactNode => (
    <PrActions
      member={step.member}
      onChanged={() => {
        actions.refresh();
        // GitHub took the update: its new head and checks come later, so the step parks and the session goes on.
        if (kind === 'update-branch') parkStep(step, 'update-branch');
      }}
      onResult={(message) => toast.add({ type: 'success', title: message })}
      trigger={(open, busy) => (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => open(kind === 'update-branch' ? 'update-merge' : 'mark-ready')}>
          {kind === 'update-branch' ? 'Update branch' : 'Mark ready'}
        </Button>
      )}
    />
  );
  const sessionReply = async (step: SessionStep, threadId: string, body: string, resolve: boolean) => {
    await window.electronAPI.reviewThreadAction({ prUrl: step.member.url, threadId, action: 'reply', body });
    if (resolve) await window.electronAPI.reviewThreadAction({ prUrl: step.member.url, threadId, action: 'resolve' });
    actions.refresh();
  };
  const sessionApprove = async (step: SessionStep, body: string) => {
    const { member } = step;
    await window.electronAPI.submitReview({ prUrl: member.url, headSha: member.headSha, baseSha: member.baseSha, baseBranch: member.baseBranch, event: 'APPROVE', body, comments: [] });
    actions.refresh();
  };
  const openFromSession = (step: SessionStep, where: SessionOpen) => {
    if (where === 'github' || where === 'github-checks') {
      void window.electronAPI.openExternal(where === 'github' ? step.member.url : `${step.member.url}/checks`);
      return;
    }
    // A deep review opens Changes; a summary, conflicts and threads open the PR's Summary, where readiness and its
    // actions are.
    const target = prTarget(step.member.url, where === 'review' ? 'changes' : 'summary') ?? step.row.target;
    actions.open(step.row, target);
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
      {session?.open ? (
        <GuidedSession
          steps={session.steps}
          live={liveById}
          index={session.index}
          outcomes={session.outcomes}
          parked={session.parked ?? {}}
          results={session.results ?? {}}
          depthContext={sessionDepthContext}
          login={account ?? ''}
          now={now}
          statusOf={view.statusOf}
          since={extras.since.events}
          rereviewLines={extras.rereviewLines}
          replies={extras.replies}
          renderAction={sessionAction}
          renderSecondary={sessionSecondary}
          snooze={sessionSnooze}
          mute={sessionMute}
          renderPrAction={sessionPrAction}
          about={sessionAbout}
          reply={sessionReply}
          approve={sessionApprove}
          renderIdentity={sessionIdentity}
          onOpen={openFromSession}
          onIndex={(index) => setSession((value) => value && { ...value, index })}
          onOutcome={(id, outcome) => setSession((value) => value && { ...value, outcomes: { ...value.outcomes, [id]: outcome } })}
          onExit={() => setSession((value) => value && (value.index >= value.steps.length ? null : { ...value, open: false }))}
        />
      ) : (
      <div className="morning">
        {/* Only when something is starred: with no stars, the page starts at Next up. */}
        {starred.entries.length > 0 && (
          <MorningSection section="starred" count={counts.starred} empty={null}
            footer={starred.entries.length > STARRED_SHOWN && (
              <button type="button" className="overview-tile-all" aria-expanded={opened.has(STARRED_MORE)} data-overview-more="starred" onClick={() => toggle(STARRED_MORE)}>
                {opened.has(STARRED_MORE) ? 'Show fewer' : `Show all ${starred.entries.length}`}
              </button>
            )}>
            {starredShown(starred, opened).map((entry) => (
              <StarredRows key={entry.id} entry={entry} now={now} collapsed={opened.has(entry.id)} tabStop={tabStop('starred')} actions={actions} />
            ))}
          </MorningSection>
        )}
        <MorningSection section="next" count={counts.next}
          action={liveSteps.length > 0 && (
            <Button size="xs" variant="outline" className="morning-session-start" data-session-start onClick={startSession}
              title={session && session.index < session.steps.length ? 'Go on with the session where you left it' : 'Go through these one at a time: what changed, what blocks each, and the next step'}>
              <Play size={12} aria-hidden="true" />
              {session && session.index < session.steps.length ? `Resume · ${session.index + 1} of ${session.steps.length}` : `Start · ${liveSteps.length}`}
            </Button>
          )}
          empty={morning.starredHolds.next ? 'Nothing else needs you right now.' : 'Nothing needs you right now.'}
          footer={more && (
            // The rest of the unreviewed merges wait in the queue, grouped by Action at Merge.
            <button type="button" className="morning-more-quiet" data-overview-more-unreviewed data-overview-row={MORE_UNREVIEWED} data-overview-row-item={MORE_UNREVIEWED} tabIndex={tabStop('next') === MORE_UNREVIEWED ? 0 : -1}
              title="Open Merge in the review queue, grouped by Action" onFocus={() => actions.focus(MORE_UNREVIEWED)} onBlur={actions.blur} onKeyDown={actions.keyDown} onClick={() => actions.show('merge')}>
              {more}
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          )}>
          {morning.next.items.map((item) => (
            <NextRow key={item.id} item={item} waited={waitingLabel(item.since, now)} tabStop={tabStop('next') === item.id} unread={unread(item.row.entries.map((entry) => entry.member).filter((entry) => item.urls.includes(entry.url)))} actions={actions} />
          ))}
        </MorningSection>
        <MorningSection section="you" count={counts.you} empty={youPointer}
          note={<TeamRequestsNote surface="overview" showsTeamRequests={!!teamRequests} />}
          footer={counts.you > 0 ? youPointer : null}>
          {morning.you.map((value) => group('you', value))}
        </MorningSection>
        <MorningSection section="others" count={counts.others} empty={morning.starredHolds.others ? 'None of your other PRs are waiting on anyone.' : 'None of your PRs are waiting on anyone.'}>
          {morning.others.map((value) => group('others', value))}
        </MorningSection>
        <MorningSection section="decide" count={counts.decide} quiet empty={morning.starredHolds.decide ? 'Nothing else to decide.' : 'Nothing to decide. None of your PRs has been stuck for over a week.'}>
          {(allDecisions ? morning.decide : morning.decide.slice(0, DECIDE_SHOWN)).map((item) => (
            <DecisionRow key={item.id} item={item} waited={waitingLabel(item.since, now)} tabStop={tabStop('decide') === item.id} actions={actions} />
          ))}
          {morning.decide.length > DECIDE_SHOWN && (
            <li className="morning-more">
              <button type="button" className="overview-tile-all" aria-expanded={allDecisions} data-overview-more onClick={() => setAllDecisions((value) => !value)}>
                {allDecisions ? 'Show fewer' : `Show ${morning.decide.length - DECIDE_SHOWN} more`}
              </button>
            </li>
          )}
        </MorningSection>
      </div>
      )}
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
            toast.add({ type: 'success', title: `Reminded ${value.label} to review ${prs(sent.length)}` });
            callbacks.current.onRefresh();
          }
          if (error) toast.add({ type: 'error', title: `Could not remind ${value.label}`, description: `${error} Try again, or ask for the review on GitHub.` });
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
          {/* Plain text with links: count changes are announced once, by the polite region below. */}
          <p className="overview-briefing" data-overview-briefing>
            {ready ? (
              <Sentence parts={morning.briefing.parts} onCount={(count) => showRows(count.urls, { line: count.line })} />
            ) : (
              'What you can act on now, across your repositories.'
            )}
          </p>
          {ready && (since || extras.since.from > 0) && (
            <p className="overview-since" data-overview-since>{since || `Nothing new ${sinceLabel(extras.since.from, now).toLowerCase()}`}</p>
          )}
        </div>
        <div className="overview-freshness-group">
          {/* One freshness line: up to date, or the one thing that is not, and the background refresh as a quiet note
              (lib/overview-freshness.ts). */}
          <FreshnessStatus freshness={freshness} now={now} onRetry={refreshNow} onActivity={openActivity && (() => void openActivity({ kind: 'activity' }))} />
          <button className="workbench-icon" aria-label="Refresh overview" title="Read every pull request from GitHub again now. Follow progress in Activity." onClick={refreshNow}>
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
      <RepoNames.Provider value={repoNames}>
        <Viewer.Provider value={account ?? ''}>
          <Unread.Provider value={unreadOf}>
            <Nudged.Provider value={nudged}>
              <div className="overview-body">{body}</div>
            </Nudged.Provider>
          </Unread.Provider>
        </Viewer.Provider>
      </RepoNames.Provider>
      <p className="sr-only" role="status" aria-live="polite" data-overview-announcement>{announcement}</p>
    </div>
  );
}

const FRESHNESS_ACTION: Readonly<Record<NonNullable<FreshnessLine['action']>, string>> = { retry: 'Retry', refresh: 'Refresh', activity: 'Open Activity' };
/**
 * The freshness line in the header's caption style: plain text, a spinner only for the reader's own refresh, the
 * background refresh as a muted note, and a link where one fixes the problem.
 */
function FreshnessStatus({ freshness, now, onRetry, onActivity }: { freshness: OverviewFreshness; now: number; onRetry: () => void; onActivity?: () => void }) {
  const { line, progress } = freshness;
  const action = line?.action === 'activity' ? onActivity : line?.action ? onRetry : undefined;
  return (
    <span className="overview-status-line" data-overview-status-line>
      {line && (
        <span className={line.spinner ? 'is-refreshing' : line.problem ? 'is-problem' : undefined} data-overview-freshness={line.kind}
          title={line.title} {...(line.problem ? { role: 'status' } : {})}>
          {line.spinner ? (
            <LoadingIndicator announce={false}>{line.text}</LoadingIndicator>
          ) : line.at !== undefined ? (
            <time dateTime={new Date(Math.min(line.at, now)).toISOString()}>{line.text}</time>
          ) : (
            line.text
          )}
        </span>
      )}
      {line?.action && action && (
        <span>
          <button type="button" className="overview-status-action" data-overview-freshness-action={line.action} onClick={action}>{FRESHNESS_ACTION[line.action]}</button>
        </span>
      )}
      {progress && <span className="overview-status-note" data-overview-progress title={progress.title}>{progress.text}</span>}
    </span>
  );
}

/** The stacks expanded to their chains, per account, on this computer. */
export const overviewStacksKey = (account: string) => `gnosis-overview-stacks:v1:${account}`;
const STACK_ID = /^others\|stacks\|stack:[^|]+$/;
function readExpandedStacks(key: string | null): string[] {
  if (!key) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && STACK_ID.test(id)).slice(0, 200) : [];
  } catch {
    return [];
  }
}
function saveExpandedStacks(key: string, open: Open) {
  try {
    localStorage.setItem(key, JSON.stringify([...open].filter((id) => STACK_ID.test(id)).slice(0, 200)));
  } catch {
    // Storage may be full or unavailable; stacks then open as one line next time.
  }
}

/** A briefing number's rows stay marked this long after it is followed. */
const HIGHLIGHT_MS = 2400;

/**
 * A sentence with links: the briefing's numbers (`BriefingCount`) and Waiting on you's pointers (`PageLink`). Each link
 * scrolls to and focuses the rows it counts; a pointer carries the arrow of where they are.
 */
function Sentence({ parts, onCount, onLink }: { parts: readonly (string | BriefingCount | PageLink)[]; onCount?: (count: BriefingCount) => void; onLink?: (link: PageLink) => void }) {
  const link = (part: BriefingCount | PageLink, i: number) => {
    if ('key' in part)
      return (
        <button key={i} type="button" className="overview-count-link" data-briefing-count={part.key} data-count={part.count} title={`Show ${part.count === 1 ? 'it' : `these ${part.count}`} on the page`} onClick={() => onCount?.(part)}>
          {part.text}
        </button>
      );
    const Arrow = ALSO_UP[part.place] ? ArrowUp : ArrowDown;
    return (
      <button key={i} type="button" className="overview-count-link" data-overview-pointer={part.place} onClick={() => onLink?.(part)}>
        {part.text}
        <Arrow size={12} aria-hidden="true" />
      </button>
    );
  };
  // A link keeps the word after it on its line, so "14" never ends a line apart from "have failing checks".
  const out: ReactNode[] = [];
  let skip = 0;
  parts.forEach((part, i) => {
    if (typeof part === 'string') {
      if (part.length > skip) out.push(<span key={i}>{part.slice(skip)}</span>);
      skip = 0;
      return;
    }
    const next = parts[i + 1];
    const glue = typeof next === 'string' ? (/^\s*\S*/.exec(next)?.[0] ?? '') : '';
    skip = glue.length;
    out.push(
      glue ? (
        <span key={i} className="overview-keep">
          {link(part, i)}
          {glue}
        </span>
      ) : (
        link(part, i)
      )
    );
  });
  return <>{out}</>;
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
  /** Scrolls to and focuses the rows that list `urls` in `place`: a chain line's "↑ Next up", a stack's next step. */
  reveal: (urls: readonly string[], place: AlsoPlace) => void;
  /** Opens a PR that has no row in the lanes, such as a quiet starred PR. */
  openItem: (item: QueueItem, target: DeepLinkTarget) => void;
  /** Which PRs are starred, and the queue's star toggle. Absent where stars cannot change. */
  star?: { has: (members: readonly ReviewMember[]) => boolean; busy: boolean; change: (members: readonly ReviewMember[], starred: boolean) => void };
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
/** The reminders sent from this page, by key: a starred line's Remind then says "Reminded". */
const Nudged = createContext<ReadonlySet<string>>(new Set());
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

function MorningSection({ section, count, empty, quiet = false, note, footer, action, children }: {
  section: Section;
  /** A control at the end of the heading, such as Next up's Start. */
  action?: ReactNode;
  count: number;
  empty: ReactNode;
  quiet?: boolean;
  /** A quiet line under the heading, such as the team-request note. */
  note?: ReactNode;
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
          <span className="morning-section-count" data-section-count>{count}</span>
        </h2>
        {action}
      </div>
      {note}
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
function RowShell({ id, tabStop, actions, label, title, number, numberLabel, preview, prs: listed, repos, detail, check, comments, status, waited, meta, quick, menu, menuLabel, description, expanded, depth = 0, isNew = false, unread = false, as: Tag = 'li', className = '', icon, onActivate }: {
  id: string;
  tabStop: boolean;
  actions: RowActions;
  label: string;
  title: ReactNode;
  /** The PR number, in its own column. */
  number?: number;
  /** What the number column says instead of "#N": "seed-launcher#384" where numbers repeat across repositories. */
  numberLabel?: string;
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
  /** Unread activity on the PR, as the queue row marks it: the same dot, when the row is not new. */
  unread?: boolean;
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
        {number !== undefined && <span className={`morning-number${numberLabel ? ' is-qualified' : ''}`}>{numberLabel ?? `#${number}`}</span>}
        {title ? <span className="morning-title-text">{typeof title === 'string' ? <Words text={title} /> : title}</span> : null}
      </span>
      {(repos?.length || detail !== undefined) && (
        <span className="morning-sub">
          {repos && <RepoName repos={repos} />}
          {detail !== undefined && <span className="morning-detail">{typeof detail === 'string' ? <Words text={detail} /> : detail}</span>}
        </span>
      )}
    </button>
  );
  const inner = (trigger: ReactNode) => (
    <div className="morning-row-inner">
      <span className="overview-row-gutter">
        {isNew ? (
          <span className="pr-unread-dot" role="img" aria-label="New since your last visit" title="New since your last visit" />
        ) : unread ? (
          <span className="pr-unread-dot" role="img" aria-label="Unread activity" title="Unread activity" data-overview-unread />
        ) : null}
        {expanded !== undefined && <ChevronRight size={14} aria-hidden="true" className="morning-chevron" />}
      </span>
      {icon}
      {preview ? <PrPreviewTooltip url={preview.url} number={preview.number} title={preview.title}>{button}</PrPreviewTooltip> : button}
      <span className="sr-only" id={descriptionId} data-overview-description>{description}</span>
      {/* One compact status cell: the check state, then the comments. */}
      {check && (
        <span className="morning-status-cell">
          <CheckState check={check} />
          <CommentCount count={comments} />
        </span>
      )}
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

/**
 * Text whose ellipsis falls between words: each word after the first is an inline block (`.morning-word`), which a
 * truncated line hides whole, so "#35390" or "+42 lines" is never cut. The first word, and any word too long to hide
 * whole, stay plain text so a narrow line still shows something.
 */
function Words({ text }: { text: string }) {
  return <>{text.split(/(\s+)/).map((part, i) => (i === 0 || part.length > 24 || !part.trim() ? part : <span key={i} className="morning-word">{part}</span>))}</>;
}

/** Out of the tab order: Tab moves between sections, and A runs the focused row's action. */
const SHORTCUT = { 'data-quick-action': true, 'aria-keyshortcuts': 'A', tabIndex: -1 };
const NEXT_ACTION: Readonly<Record<NextItem['kind'], string>> = { merge: 'Merge', rereview: 'Review again', reply: 'Reply', changes: 'Open', review: 'Review', fix: 'Open' };
/** The words a row's description adds for its comments and its wait: ", 3 comments, waiting 4 days". */
const extrasSpoken = (comments: number | undefined, waited: string) => [commentsSpoken(comments), `waiting ${spokenWaiting(waited)}`].filter(Boolean).join(', ');
/** Buttons that change something carry their icon (`actionIcons`); buttons that only open a PR carry none. */
const MergeIcon = actionIcons.merge;
const RerunIcon = actionIcons.rerun;
const NudgeIcon = actionIcons.nudge;
const CloseIcon = actionIcons.close;

const NextRow = memo(
  function NextRow({ item, waited, tabStop, unread, actions }: { item: NextItem; waited: string; tabStop: boolean; unread: boolean; actions: RowActions }) {
    const { row, member } = item;
    const label = useRepoLabel();
    const members = row.entries.map((entry) => entry.member).filter((entry) => item.urls.includes(entry.url));
    const repos = [...new Set(members.map((entry) => entry.repo))];
    const single = item.urls.length === 1;
    const failing = item.kind === 'fix' && item.fix === 'failing' ? row.entries.filter((entry) => entry.reasons.includes('checks-failed')).map((entry) => entry.member) : [];
    const action = failing.length ? 'Rerun failed checks' : NEXT_ACTION[item.kind];
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
        isNew={!!item.isNew}
        // One PR leads with its state; a row for several PRs of a stack with the stack icon, as in the queue.
        icon={single ? <PrIcon member={member} /> : <GroupIcon group={{ kind: 'stack', label: row.title }} />}
        description={`${action}, ${item.why}, ${reposSpoken(repos, label)} #${member.number}${single ? '' : ` and ${item.urls.length - 1} more`}, ${item.check.spoken}, ${extrasSpoken(item.comments, waited)}`}
        onActivate={() => actions.open(row, target)}
      />
    );
  },
  (a, b) => a.item.row.signature === b.item.row.signature && a.item.why === b.item.why && a.item.kind === b.item.kind && a.item.isNew === b.item.isNew &&
    a.item.check.label === b.item.check.label && a.item.title === b.item.title && a.item.member.url === b.item.member.url && a.item.comments === b.item.comments &&
    a.item.since === b.item.since && a.waited === b.waited && a.tabStop === b.tabStop && a.unread === b.unread && a.actions === b.actions
);

function RerunFailed({ members, onChanged, onRequested, reveal = false }: { members: ReviewMember[]; onChanged: () => void; onRequested?: () => void; reveal?: boolean }) {
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
      onRequested={onRequested}
      load={load}
      trigger={(open, busy) => (
        <Button size="xs" variant={reveal ? 'ghost' : 'outline'} {...SHORTCUT} {...(reveal ? { 'data-reveal': true } : {})} title="Rerun failed checks… · A" disabled={busy} onClick={open}>
          <RerunIcon size={13} aria-hidden="true" />
          {busy ? 'Reading…' : 'Rerun'}
        </Button>
      )}
    />
  );
}

/** The age of a line, or the words for it. */
const age = (since: number, now: number) => waitingLabel(since, now);
const lineSig = (line: GroupLine, now: number) =>
  [line.id, line.title, line.row.signature, line.check.label, line.status ?? '', line.reason ?? '', age(line.since, now), line.source, line.comments ?? '', line.description, line.isNew ? 'new' : '', line.bare ? 'bare' : ''].join('~');
const groupSig = (group: PersonGroup, now: number): string =>
  [
    group.key, group.label, group.detail, group.repos.join(), group.check?.label ?? '', group.nudge?.members.length ?? 0, group.step?.text ?? '', group.step?.action ?? '',
    group.step?.row?.signature ?? '', group.step?.inNext ? 'in-next' : group.step?.inStarred ? 'in-starred' : '', group.rows.map((row) => row.signature).join(),
    ...group.lines.map((line) => lineSig(line, now)),
    ...(group.chain ?? []).map((node) => `${lineSig(node.line, now)}:${node.also ?? ''}`),
    ...(group.children ?? []).map((child) => groupSig(child, now)),
  ].join('|');

/**
 * One PR under a group: its state, number, title, comments, check state and how long it has waited. Under You, its own
 * reason and action (Rerun failed, Open), shown on hover and focus. In a chain, its node on the connector and its
 * status word.
 */
function LineRow({ id, line, now, depth, tabStop, actions, showRepo, qualify = false, chain = false, node, also }: {
  id: string;
  line: GroupLine;
  now: number;
  depth: number;
  tabStop: boolean;
  actions: RowActions;
  /** The group spans repositories: each PR names its own. */
  showRepo: boolean;
  /** Stacks from several repositories are on the page: the number says its repository, "seed-launcher#384". */
  qualify?: boolean;
  chain?: boolean;
  /** In a chain: the node on the connector, in place of the row's icon. */
  node?: ReactNode;
  /** In a chain: another section lists the PR too; the line ends in a link to it. */
  also?: AlsoPlace;
}) {
  const label = useRepoLabel();
  const names = useContext(RepoNames);
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
      title={line.bare ? '' : line.title}
      number={member.number}
      numberLabel={qualify ? chainNumber(member, true, names) : undefined}
      preview={{ url: member.url, number: member.number, title: member.title }}
      prs={[member.url]}
      repos={showRepo ? [member.repo] : undefined}
      detail={line.reason === 'conflicts' ? <Conflicts>{FIX_LABEL.conflicts}</Conflicts> : line.reason ? (line.reasonText ?? FIX_LABEL[line.reason]) : undefined}
      check={line.check}
      comments={line.comments}
      status={status}
      waited={{ since: line.since, source: line.source, label: waited }}
      quick={quick}
      menu={prMenu(id, row, actions, unread([member]), member, [member], line.target)}
      menuLabel={`PR #${member.number}`}
      isNew={!!line.isNew}
      description={[line.description, line.bare ? line.title : '', showRepo ? label(member.repo) : '', line.check.spoken, extrasSpoken(line.comments, waited), also ? `also listed in ${PLACE_LABEL[also]}. A goes there` : ''].filter(Boolean).join(', ')}
      onActivate={() => actions.open(row, line.target)}
    />
  );
}

/** The sections above Waiting on others, and the one below it. */
const ALSO_UP: Readonly<Record<AlsoPlace, boolean>> = { starred: true, next: true, you: true, decide: false };
/**
 * The end of a chain line whose PR another section lists: "↑ Next up", "↓ Needs a decision". It scrolls to that row
 * and focuses it. It is the line's action, so A on the line follows it too.
 */
function AlsoLink({ url, place, actions }: { url: string; place: AlsoPlace; actions: RowActions }) {
  const Arrow = ALSO_UP[place] ? ArrowUp : ArrowDown;
  return (
    <button type="button" className="morning-more-quiet morning-also" {...SHORTCUT} data-overview-also={place} aria-label={`Also listed in ${PLACE_LABEL[place]}`}
      title={`Also listed in ${PLACE_LABEL[place]} · A`} onClick={() => actions.reveal([url], place)}>
      <Arrow size={12} aria-hidden="true" />
      {PLACE_LABEL[place]}
    </button>
  );
}

/**
 * "3 more", "2 more stacks", "+4 more": shows the rest of a list. A row in the section's keyboard order. Its name is
 * the visible words, then `more` for assistive technology: "+4 more PRs in this stack".
 */
function MoreRow({ id, label, more = '', tabStop, actions, depth, chain = false }: { id: string; label: string; more?: string; tabStop: boolean; actions: RowActions; depth: number; chain?: boolean }) {
  return (
    <li className={`morning-row morning-more-row is-nested depth-${depth}${chain ? ' is-chain is-gap' : ''}`} data-overview-row-item={id}>
      <div className="morning-row-inner">
        <span className="overview-row-gutter" />
        {chain && <span className="stack-chain-node" aria-hidden="true" />}
        <button type="button" className="morning-more-quiet" data-overview-row={id} data-overview-more-row tabIndex={tabStop ? 0 : -1}
          onFocus={() => actions.focus(id)} onBlur={actions.blur} onKeyDown={actions.keyDown} onClick={() => actions.toggle(id)}>
          {label}
          {more && <span className="sr-only">{more}</span>}
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
        <span className="morning-done">Reminded</span>
      ) : (
        <Button size="xs" variant="outline" {...SHORTCUT} title={`Remind ${group.nudge.reviewer} to review… · A`} onClick={() => actions.nudge(group)}>
          <NudgeIcon size={13} aria-hidden="true" />
          Remind
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
          className="is-group"
          icon={<GroupIcon group={group} />}
          repos={group.repos}
          detail={group.detail}
          check={group.check}
          quick={quick}
          expanded={view.disclosure ? view.expanded : undefined}
          description={`${spoken}${view.disclosure ? `. ${view.expanded ? 'Expanded' : 'Collapsed'}` : ''}${group.nudge && !nudged ? `. A reminds ${group.nudge.reviewer}` : ''}`}
          onActivate={() => (view.disclosure ? actions.toggle(id) : first && actions.open(first.row, first.target))}
        />
        {view.lines.map((line) => {
          const child = `${id}|${line.id}`;
          return <LineRow key={child} id={child} line={line} now={now} depth={1} tabStop={tabStop === child} actions={actions} showRepo={group.repos.length > 1} />;
        })}
        {view.more > 0 && <MoreRow id={`${id}|more`} label={`${view.more} more`} more={` PRs of ${name}`} tabStop={tabStop === `${id}|more`} actions={actions} depth={1} />}
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
          className="is-group"
          icon={<GroupIcon group={group} />}
          repos={group.repos}
          detail={group.detail}
          expanded={view.expanded}
          description={`${group.label}, ${reposSpoken(group.repos, label)}, ${group.detail}. ${view.expanded ? 'Expanded' : 'Collapsed'}`}
          onActivate={() => actions.toggle(id)}
        />
        {view.children.map((stack) => (
          <StackChain key={stack.key} id={`${id}|${stack.key}`} stack={stack} now={now} open={set} tabStop={tabStop} nudged={nudged.has(`nudge:${stack.key}`)} actions={actions} qualify={qualifyChains(group)} />
        ))}
        {view.more > 0 && (
          <MoreRow id={`${id}|more`} label={`${view.more} more ${view.more === 1 ? 'stack' : 'stacks'}`} tabStop={tabStop === `${id}|more`} actions={actions} depth={1} />
        )}
      </>
    );
  },
  (a, b) => groupSig(a.group, a.now) === groupSig(b.group, b.now) && a.open === b.open && a.tabStop === b.tabStop && a.actions === b.actions &&
    [...a.nudged].join() === [...b.nudged].join()
);

/**
 * One stack, one line by default: the stack icon, its name (its base's title when it has none), its repository, how
 * many PRs, the step that moves it, and one action (Merge, Nudge, Review or Open). Enter or a click expands it to its
 * chain in merge order, base first, on a thin connector as on the stack page (`StackDependencyChain`); the expanded
 * stacks are remembered. When the step is a Next up row already, the line points there ("next step in Next up ↑")
 * and has no action of its own. A merge step says what it goes ahead without: "Merge #376 (not reviewed, no checks)
 * to unblock 3 PRs". Every PR of the chain is a full line; one another section lists too ends in a link there.
 */
function StackChain({ id, stack, now, open, tabStop, nudged, actions, qualify }: { id: string; stack: PersonGroup; now: number; open: Open; tabStop: string | undefined; nudged: boolean; actions: RowActions; qualify: boolean }) {
  const names = useContext(RepoNames);
  const unread = useContext(Unread);
  const step = stack.step;
  if (!step) return null;
  const expanded = open.has(id);
  const size = stack.chain?.length ?? stack.urls.length;
  const spoken = `Stack ${stackLine(stack, names)}`;
  const stepUrls = step.action === 'review' && step.row ? step.row.entries.map((entry) => entry.member.url) : [step.member.url];
  const elsewhere = step.inNext ? 'next' : step.inStarred ? 'starred' : undefined;
  const quick = elsewhere ? (
    <button type="button" className="morning-more-quiet morning-also" {...SHORTCUT} data-overview-also={elsewhere} data-overview-next-step
      title={`The next step is a row in ${PLACE_LABEL[elsewhere]} · A`} onClick={() => actions.reveal(stepUrls, elsewhere)}>
      next step in {PLACE_LABEL[elsewhere]}
      <ArrowUp size={12} aria-hidden="true" />
    </button>
  ) : step.action === 'merge' && step.row ? (
    <MergeAction row={step.row} actions={actions} caveats={step.caveats} />
  ) : step.action === 'review' && step.row ? (
    <Button size="xs" variant="outline" {...SHORTCUT} title={`${reviewVerb(step.row)} first · A`} onClick={() => step.row && actions.open(step.row)}>
      {reviewVerb(step.row)}
    </Button>
  ) : step.action === 'nudge' && step.reviewer ? (
    nudged ? (
      <span className="morning-done">Reminded</span>
    ) : (
      <Button size="xs" variant="outline" {...SHORTCUT} title={`Remind ${step.reviewer} to review #${step.member.number}… · A`}
        onClick={() => actions.nudge({ key: `nudge:${stack.key}`, kind: 'person', label: step.reviewer ?? '', detail: '', rows: [], urls: [], repos: [], lines: [], oldest: 0, nudge: { reviewer: step.reviewer ?? '', members: [step.member] } })}>
        <NudgeIcon size={13} aria-hidden="true" />
        Remind
      </Button>
    )
  ) : (
    <Button size="xs" variant="ghost" {...SHORTCUT} title={`Open #${step.member.number}, ${step.member.title}${step.caveats?.length ? ` (${step.caveats.join(', ')})` : ''} · A`} onClick={() => actions.open(step.row ?? stack.rows[0], prTarget(step.member.url))}>
      Open #{step.member.number}
    </Button>
  );
  const openBase = () => actions.open(step.row ?? stack.rows[0], prTarget(step.member.url));
  const node = (member: ReviewMember) => (
    <span className="stack-chain-node" data-overview-icon="pr" aria-hidden="true">
      <PrStateIcon pr={member} size={14} decorative />
    </span>
  );
  const what = step.action === 'merge' ? `A merges #${step.member.number}` : step.action === 'review' ? 'A opens the review' : step.action === 'nudge' && !nudged ? `A reminds ${step.reviewer}` : `A opens #${step.member.number}`;
  return (
    <li className={`morning-stack depth-1${expanded ? ' is-expanded' : ''}`} data-overview-stack={stack.key}>
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
        detail={
          elsewhere ? (
            prs(size)
          ) : (
            <>
              {prs(size)}
              {' · '}
              {step.conflicts ? <Conflicts>{step.text}</Conflicts> : <span className="morning-step"><Words text={step.text} /></span>}
            </>
          )
        }
        quick={quick}
        expanded={expanded}
        menu={stackMenu(id, stack.lines.map((line) => line.member), actions, unread(stack.lines.map((line) => line.member)), openBase, { members: (step.row ?? stack.rows[0]).item.subject.members })}
        menuLabel={`stack ${stack.label}`}
        description={`${spoken}. ${expanded ? 'Expanded' : 'Collapsed'}. ${elsewhere ? `The next step is in ${PLACE_LABEL[elsewhere]}; A goes there` : what}`}
        onActivate={() => actions.toggle(id)}
      />
      {expanded && (
        <ul className="morning-chain" aria-label={spoken}>
          {chainView(stack, id, open).map((entry) => {
            if (entry.kind === 'gap')
              return <MoreRow key="gap" id={`${id}|more`} label={`+${entry.count} more`} more=" PRs in this stack" tabStop={tabStop === `${id}|more`} actions={actions} depth={2} chain />;
            const child = `${id}|${entry.line.id}`;
            return <LineRow key={child} id={child} line={entry.line} now={now} depth={2} tabStop={tabStop === child} actions={actions} showRepo={false} qualify={qualify} chain node={node(entry.line.member)} also={entry.also} />;
          })}
        </ul>
      )}
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

/** A starred line's one action, in Next up's words. */
const STARRED_ACTION: Readonly<Record<StarredAction, string>> = { merge: 'Merge', review: 'Review', rereview: 'Review again', reply: 'Reply', rerun: 'Rerun', open: 'Open', nudge: 'Remind' };
/** The key a starred line's Remind is remembered by once sent: it then says "Reminded". */
const starredNudgeKey = (line: Pick<StarredLine, 'id'>) => `nudge:starred:${line.id}`;
/** Where a starred line opens: its lane row's target, else the PR. */
const openStarred = (line: StarredLine, item: QueueItem, actions: RowActions) => (line.row ? actions.open(line.row, line.target) : actions.openItem(item, line.target));

/** The line's action: Merge, Rerun, or an open in Next up's words. A stack's PRs show theirs on hover and focus. */
function StarredQuick({ line, item, actions, reveal = false }: { line: StarredLine; item: QueueItem; actions: RowActions; reveal?: boolean }) {
  const nudged = useContext(Nudged);
  const { member, row, action } = line;
  if (!action) return null;
  if (action === 'merge' && row?.merge) return <MergeAction row={row} actions={actions} />;
  if (action === 'rerun') return <RerunFailed members={[member]} onChanged={actions.refresh} reveal={reveal} />;
  if (action === 'nudge' && line.reviewer) {
    const reviewer = line.reviewer;
    const key = starredNudgeKey(line);
    if (nudged.has(key)) return <span className="morning-done">Reminded</span>;
    return (
      <Button size="xs" variant={reveal ? 'ghost' : 'outline'} {...SHORTCUT} {...(reveal ? { 'data-reveal': true } : {})} title={`Remind ${reviewer} to review #${member.number}… · A`}
        onClick={() => actions.nudge({ key, kind: 'person', label: reviewer, detail: '', rows: [], urls: [], repos: [], lines: [], oldest: 0, nudge: { reviewer, members: [member] } })}>
        <NudgeIcon size={13} aria-hidden="true" />
        Remind
      </Button>
    );
  }
  const words = STARRED_ACTION[action];
  // An owed line's Review opens the owed review, and says which PR; the line itself opens its own PR.
  const onAction = () => (line.actionRow ? actions.open(line.actionRow, line.actionTarget) : openStarred(line, item, actions));
  return (
    <Button size="xs" variant={reveal ? 'ghost' : 'outline'} {...SHORTCUT} {...(reveal ? { 'data-reveal': true } : {})} title={`${words} #${line.actionNumber ?? member.number} · A`} onClick={onAction}>
      {words}
    </Button>
  );
}
/** A starred line read aloud: "Review requested, engine #321, checks passing, waiting 5 days". A draft's why says "Draft". */
const starredSpoken = (line: StarredLine, repo: string, waited: string) =>
  [line.why, `${repo} #${line.member.number}`, line.check?.spoken ?? '', extrasSpoken(line.comments, waited)].filter(Boolean).join(', ');
const starredLineSig = (line: StarredLine, now: number) =>
  [line.id, line.tier, line.why, line.member.title, line.member.isDraft, line.member.state, line.member.merged, line.check?.label, line.comments, line.since, age(line.since, now), line.isNew, line.action, line.reviewer, line.row?.signature, line.target.kind].join('~');
const starredSig = (entry: StarredEntry, now: number) =>
  [entry.id, entry.title, entry.why, entry.tier, entry.check?.label, entry.comments, entry.isNew, entry.lead.id, ...entry.lines.map((line) => starredLineSig(line, now))].join('|');

/**
 * One starred entry. A PR is one line, as in Next up: its state, number, title, repository, why, check state,
 * comments, age and one action. A stack is a header with its name, how many PRs and its most actionable PR's state,
 * then, until it is collapsed, its PRs in merge order on the chain the stacks in Waiting on others use.
 */
/**
 * One starred PR line: a PR entry's own row, or one PR in a starred stack's chain (`chain`), where its action shows on
 * hover and focus. `star`: what the menu's star toggle acts on, when it is not the PR alone.
 */
function StarredLineRow({ id, line, item, now, tabStop, actions, chain = false, lead = false, star }: {
  id: string;
  line: StarredLine;
  item: QueueItem;
  now: number;
  tabStop: boolean;
  actions: RowActions;
  chain?: boolean;
  lead?: boolean;
  star?: { members: readonly ReviewMember[]; starred: boolean };
}) {
  const label = useRepoLabel();
  const unread = useContext(Unread);
  const { member } = line;
  const waited = age(line.since, now);
  const opens = () => openStarred(line, item, actions);
  return (
    <RowShell
      id={id}
      tabStop={tabStop}
      actions={actions}
      depth={chain ? 1 : 0}
      className={[chain ? 'is-chain' : '', chain && lead ? 'is-next' : ''].filter(Boolean).join(' ')}
      icon={
        chain ? (
          <span className="stack-chain-node" data-overview-icon="pr" aria-hidden="true">
            <PrStateIcon pr={member} size={14} decorative />
          </span>
        ) : (
          <PrIcon member={member} />
        )
      }
      label={chain ? member.title : `${member.title}\n${line.why}`}
      title={member.title}
      number={member.number}
      preview={{ url: member.url, number: member.number, title: member.title }}
      prs={[member.url]}
      repos={chain ? undefined : [member.repo]}
      detail={line.conflicts ? <Conflicts>{line.why}</Conflicts> : line.why}
      check={line.check}
      comments={line.comments}
      waited={{ since: line.since, source: line.source, label: waited }}
      quick={<StarredQuick line={line} item={item} actions={actions} reveal={chain} />}
      menu={prMenu(id, opens, actions, unread([member]), member, [member], undefined, star ? { star } : {})}
      menuLabel={`PR #${member.number}`}
      isNew={!!line.isNew}
      unread={unread([member])}
      description={starredSpoken(line, label(member.repo), waited)}
      onActivate={opens}
    />
  );
}

/**
 * One starred entry. A PR is one line, as in Next up: its state, number, title, repository, why, check state,
 * comments, age and one action. A stack is a header with its name, how many PRs and its most actionable PR's state,
 * then, until it is collapsed, its PRs in merge order on the chain the stacks in Waiting on others use.
 *
 * The entry is starred, so its menu always offers Unstar: for a stack, every PR of it, the ones hidden from the page
 * (snoozed, muted or closing) included, so a stack whose starred PR is hidden can still be unstarred.
 */
const StarredRows = memo(
  function StarredRows({ entry, now, collapsed, tabStop, actions }: { entry: StarredEntry; now: number; collapsed: boolean; tabStop: string | undefined; actions: RowActions }) {
    const label = useRepoLabel();
    const unread = useContext(Unread);
    const { lead, item } = entry;
    const subject = item.subject.members;
    const star = { members: subject, starred: true };
    if (entry.kind === 'pr') return <StarredLineRow id={entry.id} line={lead} item={item} now={now} tabStop={tabStop === entry.id} actions={actions} star={star} />;
    const members = entry.lines.map((line) => line.member);
    const repos = [...new Set(members.map((member) => member.repo))];
    const expanded = !collapsed;
    const waited = age(entry.since, now);
    const spoken = `Stack ${entry.title}, ${reposSpoken(repos, label)}, ${entry.why}`;
    return (
      <li className={`morning-stack${expanded ? ' is-expanded' : ''}`} data-overview-stack={entry.id}>
        <RowShell
          as="div"
          id={entry.id}
          tabStop={tabStop === entry.id}
          actions={actions}
          className="morning-stack-head"
          label={`${entry.title}\n${entry.why}`}
          title={entry.title}
          icon={<GroupIcon group={{ kind: 'stack', label: entry.title }} />}
          repos={repos}
          detail={entry.why}
          check={entry.check}
          comments={entry.comments}
          waited={{ since: entry.since, source: entry.source, label: waited }}
          quick={<StarredQuick line={lead} item={item} actions={actions} />}
          expanded={expanded}
          menu={stackMenu(entry.id, members, actions, unread(members), () => openStarred(lead, item, actions), { members: subject, starred: true })}
          menuLabel={`stack ${entry.title}`}
          unread={!expanded && unread(members)}
          description={`${spoken}${entry.check ? `, ${entry.check.spoken}` : ''}, waiting ${spokenWaiting(waited)}. ${expanded ? 'Expanded' : 'Collapsed'}`}
          onActivate={() => actions.toggle(entry.id)}
        />
        {expanded && (
          <ul className="morning-chain" aria-label={spoken}>
            {entry.lines.map((line) => {
              const id = `${entry.id}|${line.id}`;
              return <StarredLineRow key={id} id={id} line={line} item={item} now={now} tabStop={tabStop === id} actions={actions} chain lead={line === lead} />;
            })}
          </ul>
        )}
      </li>
    );
  },
  (a, b) => starredSig(a.entry, a.now) === starredSig(b.entry, b.now) && a.collapsed === b.collapsed && a.tabStop === b.tabStop && a.actions === b.actions
);

declare global {
  interface Window {
    /** Browser checks count Overview row renders when `__countRenders` is set. */
    __overviewRowRenders?: number;
    /** The rows those renders were for. */
    __overviewRenderedRows?: string[];
  }
}
const reviewVerb = (row: OverviewRow) => (row.reasons.includes('updated-since-review') ? 'Review again' : 'Review');
const menuFor = (row: OverviewRow) => (row.kind === 'stack' ? `stack ${row.title}` : `PR #${row.focus.number}`);
/**
 * The menu every PR row shares: open, snooze, mark read, copy, Open on GitHub. `members`: the PRs the row stands for,
 * which Snooze and Mark as read act on; one PR's row says "Snooze PR…", a row for several of a stack "Snooze stack…".
 */
function prMenu(id: string, row: OverviewRow | (() => void), actions: RowActions, unread: boolean, member: ReviewMember, members: readonly ReviewMember[], target?: DeepLinkTarget, options: { star?: { members: readonly ReviewMember[]; starred: boolean } } = {}): EntryActionGroups {
  const open = typeof row === 'function' ? row : () => actions.open(row, target);
  return [
    [{ label: 'Open', run: open }],
    [
      { label: members.length > 1 ? 'Snooze stack…' : 'Snooze PR…', run: () => actions.snooze(id) },
      { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(members.map((entry) => entry.url)) },
      ...(options.star ? starItem(actions, options.star.members, options.star.starred) : starItem(actions, members)),
    ],
    [
      { label: 'Copy link', run: () => actions.copy(member.url, 'Link') },
      { label: 'Copy repository', run: () => actions.copy(member.repo, 'Repository') },
      { label: 'Copy PR number', run: () => actions.copy(`#${member.number}`, 'PR number') },
    ],
    [{ label: 'Open on GitHub', run: () => void window.electronAPI.openExternal(member.url) }],
  ];
}
/**
 * The queue's star toggle, in the queue's words (`prEntryActionGroups`): "Star PR #312" and "Unstar PR #312", and for
 * a stack "Star all PRs in this stack" and "Unstar PRs in this stack". Unstarring a stack unstars every PR of it.
 */
function starItem(actions: RowActions, members: readonly ReviewMember[], starred?: boolean): EntryActionGroups[number] {
  const star = actions.star;
  if (!star || !members.length) return [];
  return [starAction({ members, starred: starred ?? star.has(members), busy: star.busy, onStarChange: star.change })];
}
/** A stack header's menu: the stack's part of `prMenu` (open its base, snooze the stack, mark it read, star it). */
function stackMenu(id: string, listed: readonly ReviewMember[], actions: RowActions, unread: boolean, open: () => void, options: { members?: readonly ReviewMember[]; starred?: boolean } = {}): EntryActionGroups {
  return [
    [{ label: 'Open', run: open }],
    [
      { label: 'Snooze stack…', run: () => actions.snooze(id) },
      { label: 'Mark as read', disabled: !unread, run: () => actions.markRead(listed.map((member) => member.url)) },
      ...starItem(actions, options.members ?? listed, options.starred),
    ],
  ];
}
/** Merge, with its confirmation (`PrActions`). `caveats`: what the merge goes ahead without, for the tooltip. */
function MergeAction({ row, actions, caveats = [], session = false }: { row: OverviewRow; actions: RowActions; caveats?: readonly string[]; session?: boolean }) {
  // Base first: in a stack, the lowest PR in the lane merges first (`OverviewMerge.member`).
  const member = row.merge?.member ?? row.focus;
  return (
    <PrActions
      member={member}
      onChanged={actions.refresh}
      onResult={(message) => toast.add({ type: 'success', title: message })}
      trigger={(open, busy, _quick, methods) => (
        // The same split button as the PR header's (#542): Merge opens its confirmation, the chevron picks the method.
        // In a guided session it is the step's primary action, at the card's size, pressed with Enter.
        <MergeSplit size={session ? 'sm' : 'xs'} label="Merge" primary={session} busy={busy}
          extra={{ ...(session ? {} : SHORTCUT), title: `Merge #${member.number}${caveats.length ? ` (${caveats.join(', ')})` : ''}… · ${session ? '↵' : 'A'}` }}
          icon={<MergeIcon size={13} aria-hidden="true" />} methods={['SQUASH', 'MERGE', 'REBASE']} allowed={methods.allowed} onMethods={methods.load} onMerge={(method) => open('merge', method)} />
      )}
    />
  );
}
