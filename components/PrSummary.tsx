import { hasVisibleNavigationOverlay } from '../lib/workspace-navigation';
import { feedbackCodeContext, type FeedbackRequest, type ResponseIntent } from '../lib/feedback';
import { PrFeedbackView } from './PrFeedbackView';
import { ConversationSidebar } from './ConversationSidebar';
import { PrReadiness } from './PrReadiness';
import { WorkspaceIcon, conflictsTab, workspaceTabs } from './WorkspaceIcon';
import { SubjectIcon } from './SubjectIcon';
import { stackMergePlan } from '../lib/stack-merge-plan';
import { ReviewEvidence } from './ReviewEvidence';
import { StackChecksFreshness } from './StackMergePlan';
import { StackChangesView } from './StackChangesView';
import { StackBriefing } from './StackBriefing';
import { StackContext } from './StackContext';
import { StackOverview } from './StackOverview';
import { SearchableSelect } from './SearchableSelect';
import { stackScopeChoices } from '../lib/stack-workspace';
import { Button } from './ui/button';
import { PrChecksView, type CheckFocus } from './PrChecksView';
import { usePrChecks } from '../lib/use-pr-checks';
import { checkCounts, checkGroup, checkLabel, type PrChecks } from '../lib/pr-checks';
import { RepositoryBadge, PrBadge } from './EntityBadge';
import { usePrReadVisit } from '../lib/pr-read-context';
import { PrActions, isShortcut, shortcutLabel } from './PrActions';
import type { EntryActionGroups } from './EntryActions';
import { PrHeaderReviewContext, useChangesHeaderReview, type HeaderReview } from '../lib/pr-header-review';
import { WorkbenchIcon } from './WorkbenchIcon';
import { ReviewBreadcrumbProvider, useReviewBreadcrumbs } from '../lib/review-breadcrumbs';
import { ReviewBreadcrumbs } from './ReviewBreadcrumbs';
import { Activity, Suspense, type ComponentProps, type ReactNode, type Ref, type UIEvent } from 'react';
import { lazyScreen } from '../lib/lazy-screen';
import { LoadingState } from './LoadingState';
import { PrEntryActions, PrStarMarker, type PrGenerationActionsFor } from './PrEntryActions';
import { PrExplanation } from './PrExplanation';
import { loadExplanation, peekExplanation, type ExplanationDestination } from '../lib/explanation-workspace';
import { ExplainedChangesContext, explainedChanges } from '../lib/explained-changes';
import type { ReviewGuide, ReviewHistoryEntry } from '../lib/types';
import { Tabs } from 'radix-ui';
import { PrCommitsView } from './PrCommitsView';
import { PrChangesView, type ChangesInitialFile } from './PrChangesView';
import { AgentBriefView } from './AgentBriefView';
import { useAgentBrief, type AgentBriefComment } from '../lib/agent-brief';
import type { WorkspaceTab } from '../lib/navigation-history';
import type { Preferences } from '../lib/types';
import { GitHubAuthor } from './GitHubAuthor';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MoveNavigation, type MoveTarget } from '../lib/use-moved-symbols';
import { usePrMoves } from '../lib/use-pr-moves';
import type { PrFocus } from '../lib/deep-link';
import { AlarmClock, ChevronLeft, ChevronRight, Layers, MessageSquareReply, Pencil, UserPlus } from 'lucide-react';
import { canSnooze, openSnoozePicker } from '../lib/snooze-picker';
import { backLine } from '../lib/snooze';
import { Markdown } from './Markdown';
import { type QueueItem, type ReviewSubject } from '../lib/workbench';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from '../lib/queue-signals';
import { statusClock, useStatusNow } from '../lib/status-clock';
import { countRender } from '../lib/render-count';
import type { PrStatus } from '../lib/types';
import { timeAgo } from '../lib/utils';
import { useQueueSignals } from '../lib/use-queue-signals';
import { conflictStateFrom } from '../lib/merge-conflicts';
import { stackMergeStatus } from '../lib/stack-merge-status';
import { mergeReadiness } from '../lib/merge-readiness';
import { useGitHubAccess } from '../lib/use-github-access';
import { useWorkflowFiles } from '../lib/use-workflow-files';
import { ReadinessChip, ReadinessCheckedAt } from './MergeReadiness';
import { SubjectReviewStatus } from './PrReviewStatus';
import { useChangesComments } from './useChangesComments';
import { ArrivalProbe, contentMarkers, useIntent, usePredictions } from '../lib/use-predictions';
import { predictableMembers, prOpenPredictions, tabIntent } from '../lib/navigation-graph';
import { needsResponse } from '../lib/response-needed';
import type { ReviewMember } from '../lib/workbench';
import { PrFreshness, subjectCheckedAt } from './PrFreshness';

/**
 * Restores scroll positions inside a kept tab. Hidden content has no layout, so Chromium can reset
 * its scroll offsets; positions are recorded as the reader scrolls and reapplied on reveal.
 */
function ScrollKeeper() {
  const marker = useRef<HTMLSpanElement>(null);
  const positions = useRef(new Map<Element, [number, number]>());
  useLayoutEffect(() => {
    const panel = marker.current?.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    const saved = [...positions.current].filter(([element]) => panel.contains(element));
    // Content can lay out again after it is shown, so keep applying the saved offsets for a moment
    // until they hold, unless the reader scrolls first.
    let restoring = saved.length > 0;
    const apply = () => {
      if (!restoring) return;
      let held = true;
      for (const [element, [top, left]] of saved) {
        if (element.scrollTop !== top) element.scrollTop = top;
        if (element.scrollLeft !== left) element.scrollLeft = left;
        held &&= Math.abs(element.scrollTop - top) < 1 && Math.abs(element.scrollLeft - left) < 1;
      }
      return held;
    };
    let frames = 0;
    let frame = 0;
    const settle = () => {
      if (apply() && ++frames >= 2) restoring = false;
      else if (restoring) frame = requestAnimationFrame(settle);
    };
    apply();
    if (restoring) frame = requestAnimationFrame(settle);
    const timer = setTimeout(() => { restoring = false; }, 1000);
    const stop = () => { restoring = false; };
    const record = (event: Event) => {
      const element = event.target;
      if (!restoring && element instanceof Element) positions.current.set(element, [element.scrollTop, element.scrollLeft]);
    };
    // Scroll events inside shadow roots, such as a diff's sideways code scroll, do not reach the panel. Listen in each
    // shadow root the reader's input reaches. Reading every offset as the tab hides would force a layout of both tabs
    // inside the switch and walk every element: about 300 ms on a PR with a 3,000-line file (#346).
    const shadows = new Set<ShadowRoot>();
    const watch = (event: Event) => {
      for (const node of event.composedPath())
        if (node instanceof ShadowRoot && !shadows.has(node) && panel.contains(node.host)) {
          shadows.add(node);
          node.addEventListener('scroll', record, { capture: true, passive: true });
        }
    };
    panel.addEventListener('scroll', record, { capture: true, passive: true });
    panel.addEventListener('wheel', stop, { capture: true, passive: true });
    panel.addEventListener('pointerdown', stop, { capture: true });
    panel.addEventListener('keydown', stop, { capture: true });
    for (const type of ['wheel', 'pointerdown', 'keydown', 'focusin'])
      panel.addEventListener(type, watch, { capture: true, passive: true });
    return () => {
      restoring = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      panel.removeEventListener('scroll', record, { capture: true });
      panel.removeEventListener('wheel', stop, { capture: true });
      panel.removeEventListener('pointerdown', stop, { capture: true });
      panel.removeEventListener('keydown', stop, { capture: true });
      for (const type of ['wheel', 'pointerdown', 'keydown', 'focusin']) panel.removeEventListener(type, watch, { capture: true });
      for (const shadow of shadows) shadow.removeEventListener('scroll', record, { capture: true });
      // Forget rows the virtualized lists have unmounted.
      for (const element of positions.current.keys()) if (!element.isConnected) positions.current.delete(element);
    };
  }, []);
  return <span ref={marker} hidden />;
}

/**
 * A PR tab that stays mounted after its first visit. While another tab is shown, Activity hides it
 * and pauses its effects, including polling.
 */
function KeptTab({ value, tab, visited, className, children, ref, onScroll, arrival }: {
  value: WorkspaceTab;
  tab: WorkspaceTab;
  visited: ReadonlySet<WorkspaceTab>;
  className: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  /** Measures time to content for each visit. The first visit of the PR's first tab is the PR open. */
  arrival?: { subjectId: string; opened: boolean };
}) {
  if (!visited.has(value)) return null;
  const tabKey = arrival && `pr-tab:${value}:${arrival.subjectId}`;
  return (
    <Tabs.Content value={value} className={className} forceMount ref={ref} onScroll={onScroll}>
      <Activity mode={tab === value ? 'visible' : 'hidden'}>
        <ScrollKeeper />
        {children}
        {arrival && tabKey && value in contentMarkers && (
          <ArrivalProbe firstKey={arrival.opened ? `pr-open:${arrival.subjectId}` : tabKey} revisitKey={tabKey} marker={value} />
        )}
      </Activity>
    </Tabs.Content>
  );
}

/**
 * The Changes view skips renders whose props did not change. Activity re-renders a hidden tab whenever the page
 * renders, and the page renders on every tab switch: on a large PR, rendering the hidden Changes view again after each
 * switch kept the main thread busy around the next tab's paint, and again when Changes showed (#352).
 */
const KeptChangesView = memo(PrChangesView);
/** Resolve conflicts (#445 item 8), loaded with the code editor on first use. */
const ConflictWorkspace = lazyScreen(() => import('./ConflictWorkspace').then((module) => module.ConflictWorkspace));

export interface PrReviewRequest {
  id: string;
  member: ReviewMember;
}

const handledLandings = new Set<number>();
/** Where a deep link or notification lands inside the PR. A new `nonce` lands again. */
export interface PrLanding {
  nonce: number;
  /** A Feedback item: a review thread, a review or a conversation comment. */
  threadId?: string;
  check?: string;
  focus?: PrFocus;
}

export interface PrReadingPosition {
  memberUrl: string;
  scroll: Record<string, number>;
}

function PrSummaryContent({
  item,
  feedbackRequest,
  landing,
  starredUrls,
  starBusy,
  starError,
  onStarChange,
  onMute,
  muteBusy,
  account,
  statusRefreshing,
  revalidating,
  tab,
  onTabChange,
  preferences,
  starting,
  error,
  statuses,
  statusErrors,
  onBack,
  onQueue,
  onScopeChange,
  onRenameStack,
  matchingUrls,
  onGenerate,
  generationActions,
  onReview,
  reviewRequest,
  onReviewRequestHandled,
  explanationDestination,
  explanations,
  onShowActivity,
  onRetryStatus,
  onAiSetup,
  onGitHubAuth,
  navigation,
  positions,
  shortcutsEnabled = true,
}: {
  item: QueueItem;
  feedbackRequest?: FeedbackRequest;
  landing?: PrLanding;
  starredUrls: ReadonlySet<string>;
  starBusy: boolean;
  muteBusy: boolean;
  onMute: (members: QueueItem['subject']['members']) => void;
  starError: string;
  onStarChange: (members: QueueItem['subject']['members'], starred: boolean) => void;
  account: string | null;
  statusRefreshing: boolean;
  /** The PR comes from the queue saved at the end of the last session; main has not confirmed it yet. */
  revalidating?: boolean;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  preferences: Preferences | null;
  starting: boolean;
  error: string;
  statuses: Partial<Record<string, PrStatus>>;
  statusErrors: Record<string, string>;
  onBack: () => void;
  onQueue?: () => void;
  onScopeChange?: (id: string) => void;
  onRenameStack?: (name: string) => Promise<void>;
  matchingUrls?: string[];
  onGenerate: (previousReviewId?: string) => void;
  generationActions?: PrGenerationActionsFor;
  onReview?: (member: ReviewMember) => void;
  reviewRequest?: PrReviewRequest;
  onReviewRequestHandled?: () => void;
  explanationDestination?: ExplanationDestination;
  explanations: ReviewHistoryEntry[];
  onShowActivity: () => void;
  onRetryStatus: () => void;
  onAiSetup?: () => void;
  onGitHubAuth?: () => void;
  navigation: {
    index: number;
    total: number;
    viewName: string;
    previous?: string;
    next?: string;
    move: (direction: number) => void;
    choices: { value: string; label: string }[];
    select: (id: string) => void;
  };
  positions: Map<string, PrReadingPosition>;
  shortcutsEnabled?: boolean;
}) {
  countRender('PrSummaryContent');
  usePrReadVisit(item.subject.members, tab === 'summary' && item.subject.kind === 'pr', 'summary');
  // Tabs stay mounted once visited. The set only grows while this PR is shown.
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const currentTab = useRef(tab);
  currentTab.current = tab;
  // The tab shown when the PR opened. Its first visit measures the PR open itself.
  const [openedTab] = useState(tab);
  const arrival = (value: WorkspaceTab) => ({ subjectId: item.subject.id, opened: value === openedTab });
  // While this PR is hidden for a minute, behind a saved review or another workspace tab, drop its other tabs.
  const evict = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(evict.current);
    return () => { evict.current = scheduleEviction(setVisited, currentTab); };
  }, []);
  // Programmatic jumps remount Feedback, which reads its initial thread and intent once.
  const [feedbackJump, setFeedbackJump] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.subject.name ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [feedbackPr, setFeedbackPr] = useState<string>();
  const [feedbackThread, setFeedbackThread] = useState<string>();
  const [feedbackIntent, setFeedbackIntent] = useState<'address' | 'request' | ResponseIntent | undefined>(feedbackRequest?.intent);
  useEffect(() => { if (feedbackRequest) { setFeedbackPr(undefined); setFeedbackThread(undefined); setFeedbackIntent(feedbackRequest.intent); } }, [feedbackRequest?.id]);
  const [initialFile, setInitialFile] = useState<ChangesInitialFile>();
  // A jump happens once. Returning to Changes later restores where the reviewer left off.
  useEffect(() => {
    if (tab !== 'changes') setInitialFile(undefined);
  }, [tab]);
  // Focused sections (#564): Changes marks which section of the PR's current explanation shows each part of a file,
  // and a marker opens that section here. An explanation made with Focused sections is read when Changes shows; any
  // other is used only once the Explanation has loaded it.
  const currentExplanation =
    explanations.find((e) => !e.status || e.status === 'completed') ?? (item.review?.status === 'completed' ? item.review : undefined);
  const currentExplanationId = currentExplanation?.id;
  const readExplanation = tab === 'changes' && !!currentExplanationId && !!currentExplanation?.explanationOptions?.focusedSections;
  const [loadedExplanation, setLoadedExplanation] = useState<ReviewGuide>();
  useEffect(() => {
    if (!readExplanation || !currentExplanationId || peekExplanation(currentExplanationId)) return;
    let live = true;
    void loadExplanation(currentExplanationId).then((next) => { if (live) setLoadedExplanation(next); }).catch(() => {});
    return () => { live = false; };
  }, [readExplanation, currentExplanationId]);
  const changesExplanation = currentExplanationId
    ? (peekExplanation(currentExplanationId) ?? (loadedExplanation?.reviewId === currentExplanationId ? loadedExplanation : undefined))
    : undefined;
  const [explanationJump, setExplanationJump] = useState<ExplanationDestination>();
  // A destination from outside the PR replaces a marker's jump.
  useEffect(() => setExplanationJump(undefined), [explanationDestination]);
  const changeTab = useRef(onTabChange);
  changeTab.current = onTabChange;
  // Kept per explanation, so Changes renders again only when the explanation does.
  const explained = useMemo(
    () => explainedChanges(changesExplanation, (destination) => { setExplanationJump(destination); changeTab.current('explanation'); }),
    [changesExplanation]
  );
  // Stable, so the memoized Changes view does not render again while hidden (see KeptChangesView).
  const openFeedback = useCallback((url?: string, threadId?: string) => {
    setFeedbackPr(url);
    setFeedbackThread(threadId);
    setFeedbackIntent('address');
    setFeedbackJump(n => n + 1);
    onTabChange('summary');
  }, [onTabChange]);
  const openBrief = useCallback(() => onTabChange('brief'), [onTabChange]);
  const brief = useAgentBrief(item.subject.id);
  const openBriefComment = (comment: AgentBriefComment) => {
    setInitialFile({
      url: comment.url,
      path: comment.path,
      line: comment.line,
      headSha: comment.headSha,
      side: comment.side === 'LEFT' ? 'before' : 'after',
      view: comment.view,
    });
    onTabChange('changes');
  };
  const checks = usePrChecks(item.subject, account, tab === 'summary' || tab === 'checks', statuses, tab === 'checks');
  const [checkFocus, setCheckFocus] = useState<CheckFocus>();
  const checkTotals = checkCounts(item.subject.members.flatMap(m => checks.values[m.url]?.checks ?? []));
  const openChecks = (url: string, id?: string) => { setCheckFocus({ url, id, nonce: Date.now() }); onTabChange('checks'); };
  // A PR back from snooze says why, as its queue row does, until it is read.
  const snoozeBack = Object.values(item.back ?? {}).find((value) => !!value);
  // A notification or link lands on its thread, check, first unviewed file or merge action, once per nonce.
  const [unviewedLanding, setUnviewedLanding] = useState<number>();
  const [mergeLanding, setMergeLanding] = useState<number>();
  useEffect(() => {
    // Once per landing, even when this PR is opened again later from the queue.
    if (!landing || handledLandings.has(landing.nonce)) return;
    handledLandings.add(landing.nonce);
    if (landing.threadId) {
      setFeedbackPr(undefined);
      setFeedbackThread(landing.threadId);
      setFeedbackIntent('address');
      setFeedbackJump(n => n + 1);
    }
    if (landing.check) setCheckFocus({ url: item.subject.members[0].url, id: landing.check, nonce: landing.nonce });
    if (landing.focus === 'unviewed-file') setUnviewedLanding(landing.nonce);
    if (landing.focus === 'merge') setMergeLanding(landing.nonce);
  }, [landing?.nonce]);
  useEffect(() => {
    if (mergeLanding === undefined) return;
    // The merge action renders in the header once its state loads: wait for it, then focus it.
    let tries = 0;
    const timer = setInterval(() => {
      const button = heading.current?.closest('main')?.querySelector<HTMLButtonElement>('.pr-workspace-navigation [data-merge-action]');
      if (button || ++tries > 50) {
        clearInterval(timer);
        setMergeLanding(undefined);
        button?.scrollIntoView({ block: 'center' });
        button?.focus({ preventScroll: true });
      }
    }, 100);
    return () => clearInterval(timer);
  }, [mergeLanding]);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const restoring = useRef(false);
  const [position] = useState(() => {
    const saved = positions.get(item.subject.id) ?? { memberUrl: item.subject.members[0].url, scroll: {} };
    positions.set(item.subject.id, saved);
    return saved;
  });
  const [memberUrl, setMemberUrl] = useState(position.memberUrl);
  const activeUrl = item.subject.members.find((m) => m.url === memberUrl)?.url ?? item.subject.members[0].url;
  const stacked = item.subject.kind === 'stack';
  const parentStack = item.parentStack;
  const scopeStack = stacked ? item.subject : parentStack;
  const first = item.subject.members[0];
  const activeMember = item.subject.members.find(m => m.url === activeUrl) ?? first;
  // Capture the revision the menu targeted, even if discovery advances while opening the dialog.
  const reviewMember = reviewRequest?.member.url === activeUrl ? reviewRequest.member : activeMember;
  const summaryReview = useChangesComments({
    snapshot: { version: 1, url: reviewMember.url, metadata: reviewMember, comparisonBase: reviewMember.baseSha, files: [], fetchedAt: 0 },
    activeKey: `summary:${reviewMember.url}`,
    inline: [],
    replaceThread: () => {},
    refresh: () => { onRetryStatus(); return Promise.resolve(); },
    onOpenChanges: (path) => {
      setInitialFile({ url: reviewMember.url, path });
      onTabChange('changes');
    },
  });
  const handledReviewRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reviewRequest && item.subject.members.some(m => m.url === reviewRequest.member.url)) {
      setMemberUrl(reviewRequest.member.url);
    }
  }, [reviewRequest?.id]);
  useEffect(() => {
    if (!reviewRequest || handledReviewRequest.current === reviewRequest.id ||
      reviewRequest.member.url !== activeUrl || !summaryReview.ready) return;
    handledReviewRequest.current = reviewRequest.id;
    summaryReview.openReview();
    onReviewRequestHandled?.();
  }, [reviewRequest, activeUrl, summaryReview.ready, summaryReview.openReview, onReviewRequestHandled]);
  const { ref: statusRef, values: signals, loaded: signalsLoaded } = useQueueSignals(
    account,
    item.subject.members.map((m) => ({ url: m.url, headSha: m.headSha }))
  );
  // Opening a PR warms the tabs the reader is likely to open next: Changes, then Checks or Feedback when they need attention.
  const predictMembers = account ? predictableMembers(item.subject.members) : [];
  usePredictions(`pr:${item.subject.id}`, prOpenPredictions({
    subjectId: item.subject.id,
    members: predictMembers,
    attention: checkTotals.attention,
    running: checkTotals.running,
    checks: checkTotals.attention + checkTotals.running + checkTotals.passed + checkTotals.skipped,
    unresolved: signals.reduce((total, signal) => total + (signal.threads?.unresolved.length ?? signal.comments), 0),
    responseNeeded: item.subject.members.some((member) => needsResponse(item.responses?.[member.url])),
    explanationReady: !!item.review && (item.review.status ?? 'completed') === 'completed',
  }));
  // Resting on a tab prepares it, even when Summary did not predict it.
  const tabRest = useIntent(`pr-tabs:${item.subject.id}`);
  const tabIntentHandlers = (value: WorkspaceTab) =>
    tabRest.handlers(value === tab ? null : tabIntent(item.subject.id, value, predictMembers, checkTotals.attention));
  // Status ages on the shared status clock in lib/status-clock.ts. Only the components that show
  // status read it, so a tick re-renders them and not this page, its kept tabs or the explanation.
  // New status, or a failed refresh, is aged at once: every status component reads the new time.
  useEffect(() => statusClock.tick(), [statuses, statusErrors]);
  const commonRepo = stacked && new Set(item.subject.members.map(m => m.repo)).size === 1 ? first.repo : undefined;
  const state = first.merged ? 'Merged' : first.state === 'closed' ? 'Closed' : first.isDraft ? 'Draft' : 'Open';
  // When Gnosis last read each PR from GitHub: its signals for the shown head, or its status core.
  const checkedAt = subjectCheckedAt(item.subject.members.map((member) => {
    const status = statuses[member.url];
    const reads = [
      ...signals.filter((value) => value.url === member.url && value.headSha === member.headSha).map((value) => value.checkedAt),
      ...(status?.checkedAt !== undefined && !status.stale ? [status.checkedAt] : []),
    ];
    return reads.length ? Math.max(...reads) : undefined;
  }));
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  // Summary keeps a stable scrollbar gutter. Its right padding gives that width back, so the
  // content's right edge lines up with the header's on classic and overlay scrollbars alike.
  useLayoutEffect(() => {
    const element = page.current;
    if (!element || tab !== 'summary') return;
    const measure = () => element.style.setProperty('--scrollbar-gutter', `${element.offsetWidth - element.clientWidth}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tab]);
  useLayoutEffect(() => {
    const element = page.current;
    // The kept summary is hidden on other tabs; restore it only when shown.
    if (!element || tab !== 'summary') return;
    position.memberUrl = activeUrl;
    const desired = position.scroll[activeUrl] ?? 0;
    restoring.current = desired > 0;
    const content = element.querySelector('.pr-summary-body');
    const observer = new ResizeObserver(() => restore());
    const stop = () => {
      restoring.current = false;
      observer.disconnect();
    };
    const restore = () => {
      if (!restoring.current) return;
      element.scrollTop = desired;
      if (Math.abs(element.scrollTop - desired) < 2) stop();
    };
    element.scrollTop = desired;
    if (content && restoring.current) observer.observe(content);
    const frame = requestAnimationFrame(restore);
    const timer = setTimeout(stop, 5000);
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('pointerdown', stop);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      element.removeEventListener('wheel', stop);
      element.removeEventListener('pointerdown', stop);
    };
  }, [activeUrl, position, tab]);
  const remember = () => {
    // A hidden summary has no layout, so its scroll offset would read as zero.
    if (tab === 'summary' && page.current && !restoring.current) position.scroll[activeUrl] = page.current.scrollTop;
  };
  const move = (direction: number) => {
    remember();
    navigation.move(direction);
  };
  const back = () => {
    remember();
    onBack();
  };
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (tab === 'explanation' && event.key !== 'Escape') return;
      // The Conflicts view owns J, K and Escape, wherever focus is.
      if (tab === 'conflicts') return;
      if (event.composedPath().some((node) => node instanceof Element && node.matches('.pr-changes, .pr-checks-workspace, .conflict-workspace'))) return;
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.isContentEditable ||
        target?.closest(
          'input, textarea, select, summary, [role="combobox"], [role="dialog"], [role="menu"], .review-breadcrumbs, .activity-drawer, .activity-capsule, .workbench-help'
        )
      )
        return;
      if (hasVisibleNavigationOverlay()) return;
      if (event.key === 'j' && navigation.next) {
        event.preventDefault();
        move(1);
      }
      if (event.key === 'k' && navigation.previous) {
        event.preventDefault();
        move(-1);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [navigation, onBack, shortcutsEnabled, activeUrl, position, tab]);
  useReviewBreadcrumbs('summary', []);
  const changeScope = (id: string) => { remember(); onScopeChange?.(id); };
  const evidence = (
    <ReviewEvidence onFeedback={url => { setFeedbackPr(url); setFeedbackJump(n => n + 1); onTabChange('summary'); }}
      compact={!stacked}
      key={`${account}:${item.subject.id}`}
      subject={item.subject}
      account={account}
      signals={[...signals, ...item.subject.members.flatMap(member => statuses[member.url]?.signals ?? [])]}
      checks={checks.values}
      checkErrors={checks.errors}
      onChecks={openChecks}
      onRefresh={onRetryStatus}
      refreshBusy={statusRefreshing}
      refreshError={Object.values(statusErrors)[0]}
    />
  );
  // The header's actions (#542): GitHub's actions, then Drafts and the review action, in one place on every tab.
  const [overflow, setOverflow] = useState<EntryActionGroups>([]);
  const [actionsRefresh, setActionsRefresh] = useState(0);
  const [notes, setNotes] = useState<HTMLDivElement | null>(null);
  const [changesReview, setChangesReview] = useChangesHeaderReview(tab === 'changes');
  const headerReview: HeaderReview = tab === 'changes' && changesReview ? changesReview : summaryReview.header;
  const navigationRow = useRef<HTMLDivElement>(null);
  // Measured again only when the row's contents change; a tab switch never forces a layout read here.
  const collapse = useCollapsedActions(navigationRow, `${item.subject.id}:${!stacked && visited.has('conflicts')}`);
  const openPr = !first.merged && first.state === 'open';
  const own = !!account && first.author.toLowerCase() === account.toLowerCase();
  const unresolved = signals.find((signal) => signal.url === first.url)?.threads?.unresolved.length ?? 0;
  const requestReview = () => { setFeedbackPr(first.url); setFeedbackIntent('request'); setFeedbackJump(n => n + 1); onTabChange('summary'); };
  // One review action: reply when threads wait for you, ask for review on your own PR, otherwise review it. A merged
  // or closed PR keeps it while threads are unresolved.
  const reviewAction = stacked || (!openPr && !unresolved) ? undefined
    : !openPr ? { label: 'Review PR', icon: <WorkbenchIcon name="review" />, run: () => openFeedback(first.url) }
    : needsResponse(item.responses?.[first.url]) ? { label: 'Reply to feedback', icon: <MessageSquareReply size={14} aria-hidden="true" />, run: () => openFeedback(first.url) }
    : own ? { label: 'Request review…', icon: <UserPlus size={14} aria-hidden="true" />, run: requestReview }
    : { label: 'Review PR', icon: <WorkbenchIcon name="review" />, run: headerReview.openReview, blocked: headerReview.reviewBlocked, count: headerReview.draftCount };
  const reviewShortcut = useRef(reviewAction);
  reviewShortcut.current = reviewAction;
  useEffect(() => {
    if (!shortcutsEnabled || stacked) return;
    const keydown = (event: KeyboardEvent) => {
      if (!isShortcut(event, 'v') || event.defaultPrevented) return;
      // In a text field, Cmd+Shift+V pastes as it always does.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || target?.closest('input, textarea, select, [role=dialog], [role=menu]')) return;
      event.preventDefault();
      const action = reviewShortcut.current;
      if (action && !action.blocked) action.run();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [shortcutsEnabled, stacked]);
  const draftsLabel = `Drafts${headerReview.draftCount ? ` (${headerReview.draftCount})` : ''}`;
  const headerActions = !stacked && (
    <HeaderPrActions key={first.url} member={first} signals={signals} statusSignals={statuses[first.url]?.signals} onChanged={onRetryStatus}
      refreshKey={actionsRefresh} collapse={collapse} onOverflow={setOverflow} notes={notes} shortcuts={shortcutsEnabled}
      review={(primary) => <>
        {openPr && collapse < 2 && <Button data-collapse-at="2" variant="outline" size="sm" disabled={headerReview.draftsDisabled} onClick={headerReview.toggleDrafts}>{draftsLabel}</Button>}
        {reviewAction && (
          <Button size="sm" variant={primary ? 'default' : 'outline'} className="pr-review-action" aria-disabled={reviewAction.blocked ? true : undefined} data-unavailable={reviewAction.blocked ? '' : undefined}
            title={reviewAction.blocked ?? `${reviewAction.label} (${shortcutLabel('V')})`} onClick={() => { if (!reviewAction.blocked) reviewAction.run(); }}>
            {reviewAction.icon}<span>{reviewAction.label}{reviewAction.label === 'Review PR' && <span className="toolbar-label-extra-narrow"> #{first.number}</span>}{reviewAction.count ? ` (${reviewAction.count})` : ''}</span>
          </Button>
        )}
      </>} />
  );
  const menuExtra: EntryActionGroups = collapse > 1 && openPr && !stacked
    ? [[{ label: draftsLabel, disabled: headerReview.draftsDisabled, run: headerReview.toggleDrafts }, ...(overflow[0] ?? [])]]
    : overflow;
  // The Conflicts view is a tab while it is open: Close leaves it, and its drafts are saved (ConflictWorkspace).
  const conflictsOpen = !stacked && visited.has('conflicts');
  const tabs = conflictsOpen ? [...workspaceTabs, conflictsTab] : workspaceTabs;
  // A whole stack has no Conflicts view: each PR resolves its own.
  useEffect(() => {
    if (stacked && tab === 'conflicts') onTabChange('summary');
  }, [stacked, tab, onTabChange]);
  const closeConflicts = useCallback(() => {
    setVisited((previous) => new Set([...previous].filter((value) => value !== 'conflicts')));
    if (currentTab.current === 'conflicts') onTabChange('summary');
  }, [onTabChange]);
  // Moved and renamed symbols (#398) are the PR's, for whichever tab shows its diffs: from the first time Changes or
  // Explanation opens, never for Summary alone.
  usePrMoves(item.subject.members, preferences, visited.has('changes') || visited.has('explanation'));
  // A moved symbol's note in an Explanation topic or a code thread opens its other end in Changes (#398). Changes
  // provides its own, which stays in the view.
  const openMove = useCallback((target: MoveTarget) => {
    setInitialFile({ url: target.url, path: target.path, headSha: target.headSha, line: target.line, endLine: target.endLine, side: target.side });
    onTabChange('changes');
  }, [onTabChange]);
  return (
    <MoveNavigation.Provider value={openMove}>
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (tab === 'summary') remember();
        onTabChange(value as WorkspaceTab);
      }}
      asChild
    >
      <main className={`pr-summary-page ${stacked ? 'is-stack' : ''} ${tab !== 'summary' ? 'showing-changes' : ''} ${tab === 'conflicts' ? 'is-resolving' : ''}`}>
        <div className="pr-summary-toolbar">
          <div className="pr-summary-toolbar-inner">
            <ReviewBreadcrumbs scope={tab} base={[
              { id: 'origin', label: navigation.viewName, navigate: () => { remember(); (onQueue ?? onBack)(); } },
              ...(parentStack ? [{ id: 'parent-stack', kind: 'stack' as const, label: parentStack.title, title: 'Stack', navigate: () => changeScope(parentStack.id) }] : []),
              { id: 'subject', kind: stacked ? 'stack' : 'pr', pr: stacked ? undefined : first, label: stacked ? item.subject.title : `${first.repo} #${first.number}`,
                title: item.subject.title, navigate: () => { remember(); onTabChange('summary'); },
                pickerLabel: parentStack ? 'PR in stack' : 'PR or stack', value: item.subject.id, options: parentStack ? stackScopeChoices(parentStack).slice(1) : navigation.choices,
                select: id => { remember(); if (parentStack) changeScope(id); else navigation.select(id); } },
              { id: 'tab', workspaceTab: tab, label: tabs.find(t => t.value === tab)?.label ?? 'Summary',
                pickerLabel: 'Review tab', value: tab, options: tabs,
                select: value => { remember(); onTabChange(value as typeof tab); } },
            ]} />
            <nav className="pr-queue-navigation" aria-label="Changes in current view">
              <button
                aria-label="Previous change"
                disabled={!navigation.previous}
                title={navigation.previous ? `Previous: ${navigation.previous} (k)` : 'First change in this view'}
                onClick={() => move(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span title={navigation.viewName}>
                {navigation.index < 0 ? 'Outside current view' : `${navigation.index + 1} / ${navigation.total}`}
              </span>
              <button
                aria-label="Next change"
                disabled={!navigation.next}
                title={navigation.next ? `Next: ${navigation.next} (j)` : 'Last change in this view'}
                onClick={() => move(1)}
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </div>
        </div>
        <PrEntryActions {...generationActions?.(item.subject.members)} onReview={onReview} reviewDisabled={!account} members={item.subject.members} starredUrls={starredUrls}
          busy={starBusy || muteBusy || statusRefreshing} onStarChange={onStarChange} onMute={onMute} extra={menuExtra}
          conflictState={conflictStateFrom([...signals, ...item.subject.members.map((m) => statuses[m.url]?.signals)])}
          onRefresh={() => { onRetryStatus(); setActionsRefresh((n) => n + 1); }}>{actions => <header className="pr-overview-heading">
          <div className="pr-heading-row">
            <div className="pr-title-with-star">
              <h1 ref={heading} tabIndex={-1} title={item.subject.title}>
                <SubjectIcon kind={stacked ? 'stack' : 'pr'} pr={stacked ? undefined : item.subject.members[0]} decorative /><span className="pr-title-text">{item.subject.title}</span>
              </h1>
              <PrStarMarker members={item.subject.members} starredUrls={starredUrls} />
              {stacked && onRenameStack && !renaming && <button className="workbench-icon" aria-label="Rename stack" title="Rename stack on this computer" onClick={() => { setName(item.subject.name ?? item.subject.title); setNameError(''); setRenaming(true); }}><Pencil size={15} /></button>}
              {account && canSnooze(item.subject.members) && <button className="workbench-icon pr-snooze-button" aria-label={stacked ? 'Snooze stack' : 'Snooze PR'} title={stacked ? 'Snooze stack' : 'Snooze PR'} onClick={() => openSnoozePicker({ groups: [item.subject.members] })}><AlarmClock size={15} /></button>}
              {actions}
              {stacked && <StackMergeActions subject={item.subject} signals={signals} checks={checks.values} onChanged={onRetryStatus} />}
            </div>
            <div ref={statusRef} className="pr-heading-meta" data-tour="summary" aria-label={stacked ? 'Stack status' : 'PR status'}>
              <span className="pr-summary-context">
                {stacked ? (
                  <>
                    <Layers size={14} aria-hidden="true" />
                    {item.subject.members.length} PRs{commonRepo && <RepositoryBadge repo={commonRepo} />}
                  </>
                ) : (
                  <>
                    <RepositoryBadge repo={first.repo} /> <PrBadge url={first.url} number={first.number} title={first.title} /> ·{' '}
                    <span className={`pr-state pr-state-${state.toLowerCase()}`}>{state}</span> · by{' '}
                    <GitHubAuthor login={first.author} /> · updated{' '}
                    <time dateTime={first.updatedAt}>{timeAgo(first.updatedAt)}</time>
                  </>
                )}
              </span>
              {revalidating && <PrFreshness className="pr-freshness" refreshing />}
              <PrStatusLine subject={item.subject} signals={signals} statusSignals={statuses[first.url]?.signals} checking={!signalsLoaded && !!account} checks={checks.values} checkErrors={checks.errors}
                updating={item.subject.members.some(member => statuses[member.url]?.stale && !statusErrors[member.url])}
                freshness={<PrFreshness className="pr-freshness" checkedAt={checkedAt} />} onChecks={() => onTabChange('checks')} />
            </div>
          </div>
          {snoozeBack && <p className="queue-snooze-back pr-snooze-back"><AlarmClock size={13} aria-hidden="true" />{backLine(snoozeBack)}</p>}
          {renaming && <form className="stack-name-form" onSubmit={event => {
            event.preventDefault(); if (!onRenameStack || nameBusy) return;
            setNameBusy(true); setNameError('');
            void onRenameStack(name).then(() => setRenaming(false)).catch((error: unknown) => setNameError(`Could not save the stack name. ${error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'Try again.'}`)).finally(() => setNameBusy(false));
          }}>
            <label htmlFor="stack-name">Stack name <span>Only in Gnosis on this computer</span></label>
            <div><input id="stack-name" value={name} maxLength={120} autoFocus disabled={nameBusy} onChange={e => setName(e.target.value)} placeholder="Use the first PR title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); } }} /><Button size="sm" disabled={nameBusy} type="submit">{nameBusy ? 'Saving…' : 'Save'}</Button><Button size="sm" type="button" variant="ghost" disabled={nameBusy} onClick={() => setRenaming(false)}>Cancel</Button></div>
            {nameError && <p role="alert">{nameError}</p>}
          </form>}
          {starError && (
            <p role="alert" className="text-sm text-destructive">
              {starError}
            </p>
          )}
        </header>}</PrEntryActions>
        <div className="pr-workspace-navigation" ref={navigationRow}>
        {scopeStack && onScopeChange && <nav className="stack-scope-bar" aria-label="Stack navigation">
          {parentStack ? <Button variant="ghost" size="sm" className="stack-back" aria-label="Back to stack" onClick={() => changeScope(parentStack.id)}><ChevronLeft size={15} aria-hidden="true" /><SubjectIcon kind="stack" />Stack</Button> : null}
          <SearchableSelect label="Review scope" value={item.subject.id} triggerLabel={stacked ? 'Whole stack' : `#${first.number} · ${scopeStack.members.findIndex(m => m.url === first.url) + 1} of ${scopeStack.members.length}`} options={stackScopeChoices(scopeStack)} onValueChange={changeScope} popupBoundary="viewport" popupClassName="stack-scope-popup" />
        </nav>}
        <Tabs.List className="pr-overview-tabs" aria-label="PR overview">
          <Tabs.Trigger value="summary"><WorkspaceIcon tab="summary" /><PrTabLabel>Summary</PrTabLabel></Tabs.Trigger>
          <Tabs.Trigger value="changes" data-tour="changes" {...tabIntentHandlers('changes')}><WorkspaceIcon tab="changes" /><PrTabLabel>Changes</PrTabLabel></Tabs.Trigger>
          <Tabs.Trigger value="commits" {...tabIntentHandlers('commits')}><WorkspaceIcon tab="commits" /><PrTabLabel>Commits</PrTabLabel></Tabs.Trigger>
          <Tabs.Trigger value="checks" {...tabIntentHandlers('checks')}><WorkspaceIcon tab="checks" /><PrTabLabel>Checks</PrTabLabel>{checkTotals.attention > 0 && <span className="checks-tab-count">{checkTotals.attention}</span>}</Tabs.Trigger>
          <Tabs.Trigger value="explanation" data-tour="explanation"><WorkspaceIcon tab="explanation" /><PrTabLabel>Explanation</PrTabLabel></Tabs.Trigger>
          <Tabs.Trigger value="brief"><WorkspaceIcon tab="brief" /><PrTabLabel>Local notes</PrTabLabel>{brief.comments.length > 0 && <span className="brief-tab-count">{brief.comments.length}</span>}</Tabs.Trigger>
          {conflictsOpen && <Tabs.Trigger value="conflicts"><WorkspaceIcon tab="conflicts" /><PrTabLabel>Conflicts</PrTabLabel></Tabs.Trigger>}
        </Tabs.List>
        {headerActions}
        </div>
        <div className="pr-header-notes" ref={setNotes} />
        {/* The header's Drafts and Review PR open here on every other section; Summary shows them in its body. */}
        {!stacked && tab !== 'summary' && tab !== 'changes' && tab !== 'conflicts' && <div className="pr-header-review-panel">{summaryReview.panel}</div>}
        {conflictsOpen && (
          <KeptTab value="conflicts" tab={tab} visited={visited} className="pr-changes-tab pr-conflicts-tab">
            <Suspense fallback={<LoadingState title="Opening Resolve conflicts…" />}>
              <ConflictWorkspace key={first.url} url={first.url} onClose={closeConflicts} preferences={preferences} />
            </Suspense>
          </KeptTab>
        )}
        <KeptTab value="changes" tab={tab} visited={visited} arrival={arrival('changes')} className="pr-changes-tab">
          <ExplainedChangesContext.Provider value={explained}>
          <PrHeaderReviewContext.Provider value={stacked ? undefined : setChangesReview}>
          {preferences && (stacked ? <StackChangesView key={`${account}:${item.subject.id}`} subject={item.subject} preferences={preferences} account={account ?? ''} initialFile={initialFile} onOpenFeedback={openFeedback} onOpenPr={changeScope} onOpenBrief={openBrief} /> :
            <KeptChangesView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              account={account ?? ''}
              onOpenFeedback={openFeedback}
              initialFile={initialFile}
              landOnUnviewed={unviewedLanding}
              onOpenBrief={openBrief}
            />
          )}
          </PrHeaderReviewContext.Provider>
          </ExplainedChangesContext.Provider>
        </KeptTab>
        <KeptTab value="brief" tab={tab} visited={visited} className="pr-changes-tab">
          <AgentBriefView key={item.subject.id} subject={item.subject} parentStack={parentStack} onOpenScope={onScopeChange ? changeScope : undefined} onOpenComment={openBriefComment} onOpenChanges={() => onTabChange('changes')} />
        </KeptTab>
        <KeptTab value="checks" tab={tab} visited={visited} arrival={arrival('checks')} className="pr-changes-tab">
          <PrChecksView key={`${account}:${item.subject.id}`} stateKey={`${account}:${item.subject.id}`} subject={item.subject} {...checks} focus={checkFocus}
            onSource={(url, path, line, headSha) => {
              setInitialFile({ url, path, line, headSha }); onTabChange('changes');
            }} />
        </KeptTab>
        <KeptTab value="commits" tab={tab} visited={visited} arrival={arrival('commits')} className="pr-changes-tab">
          {preferences && (
            <PrCommitsView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              onOpenCurrentFile={(url, path) => {
                setInitialFile({ url, path });
                onTabChange('changes');
              }}
            />
          )}
        </KeptTab>
        <Tabs.Content value="explanation" className="pr-changes-tab" forceMount>
          <PrExplanation
            item={item}
            entries={explanations}
            destination={explanationJump ?? explanationDestination}
            active={tab === 'explanation' && shortcutsEnabled}
            preferences={preferences}
            starting={starting}
            error={error}
            onGenerate={onGenerate}
            onAiSetup={onAiSetup}
            onGitHubAuth={onGitHubAuth}
            onShowActivity={onShowActivity}
            onBack={back}
            onOpenChanges={() => onTabChange('changes')}
            onOpenChangesFile={(target) => {
              const member = item.subject.members.find((m) => m.url === target.url) ?? activeMember;
              // Lines only apply to the revision the answer read; a newer head opens just the file.
              const current = !!target.headSha && member.headSha === target.headSha;
              setInitialFile({
                url: member.url,
                path: target.path,
                headSha: current ? target.headSha : undefined,
                line: current ? target.line : undefined,
                endLine: current ? target.endLine : undefined,
                side: target.side,
              });
              onTabChange('changes');
            }}
          />
        </Tabs.Content>
        <KeptTab value="summary" tab={tab} visited={visited} arrival={arrival('summary')} className="pr-summary-content conversation-page" ref={page} onScroll={remember}>
          {/* The Conversation page (#418): the briefing and merge readiness, then the PR's timeline beside its details.
              Feedback lives here; links and saved tabs that name Feedback open this page at their thread. */}
          <div className="pr-summary-body">
            <PrFeedbackView
              key={`${account}:${item.subject.id}:${feedbackPr ?? ''}:${feedbackRequest?.id ?? ''}:${feedbackJump}`}
              subject={item.subject}
              account={account}
              initialPrUrl={feedbackPr}
              initialThreadId={feedbackThread}
              preferences={preferences ?? undefined}
              intent={feedbackIntent}
              scroller={page}
              onOpenChanges={() => onTabChange('changes')}
              onIntentHandled={() => { setFeedbackIntent(undefined); setFeedbackThread(undefined); }}
              onSource={feedbackItem => {
                if (!feedbackItem.thread) return;
                setInitialFile({ url: feedbackItem.member.url, headSha: feedbackItem.member.headSha, path: feedbackItem.thread.path, line: feedbackCodeContext(feedbackItem.thread, feedbackItem.headSha ? { headSha: feedbackItem.headSha, baseSha: feedbackItem.baseSha ?? '' } : undefined, feedbackItem.member) === 'current' ? feedbackItem.thread.line ?? undefined : undefined, side: feedbackItem.thread.diffSide === 'LEFT' ? 'before' : 'after' }); onTabChange('changes');
              }}
              band={<>
                {tab === 'summary' && summaryReview.panel}
                {item.subject.warnings.map((warning) => (
                  <p key={warning} className="workbench-notice" role="status">
                    {warning}
                  </p>
                ))}
                {stacked ? <>
                  <StackOverview account={account} checking={!signalsLoaded && !!account} onRefresh={onRetryStatus} refreshBusy={statusRefreshing || !account} item={item} signals={signals} checks={checks.values} checkErrors={checks.errors} checksBusy={checks.busy} matchingUrls={matchingUrls}
                  onFeedback={member => { setFeedbackPr(member.url); setFeedbackIntent('address'); setFeedbackJump(n => n + 1); onTabChange('summary'); }} onOpen={member => changeScope(member.url)} onChecks={(member, id) => { setCheckFocus({ url: member.url, id, nonce: Date.now() }); changeScope(member.url); onTabChange('checks'); }} />
                  {evidence}
                  <StackBriefing briefing={item.briefing} actions={generationActions?.(item.subject.members)} onActivity={onShowActivity} onSetup={onGitHubAuth} connected={!!account} />
                </> : <>
                  <BandReadiness reveal={mergeLanding !== undefined}><PrReadiness compact member={activeMember} status={statuses[activeMember.url]} signals={signals.find((s) => s.url === activeMember.url)} error={statusErrors[activeMember.url]} onRetry={onRetryStatus} /></BandReadiness>
                  {item.briefing?.status === 'ready' && <details className="pr-briefing"><summary>AI briefing</summary><Markdown>{item.briefing.summary ?? ''}</Markdown></details>}
                </>}
              </>}
              sidebar={stacked ? undefined : (values) => (
                <ConversationSidebar evidence={evidence} context={parentStack && <StackContext subject={parentStack} currentUrl={first.url} account={account} onOpen={changeScope} onStack={() => changeScope(parentStack.id)} compact />} member={activeMember} status={statuses[activeMember.url]} snapshot={values[activeMember.url]} checks={checks.values[activeMember.url]} onChecks={() => openChecks(activeMember.url)} />
              )}
            />
          </div>
        </KeptTab>
      </main>
    </Tabs.Root>
    </MoveNavigation.Provider>
  );
}

/**
 * Merge readiness in the Conversation band (#418): the verdict and its reasons on one line, so the description and
 * the first feedback start above a laptop's fold. The PR's actions stay on that line, never behind a toggle; Details
 * opens the full reasons and the actions' notes.
 */
function BandReadiness({ children, reveal }: { children: ReactNode; /** A merge landing shows the actions. */ reveal?: boolean }) {
  const [opened, setOpen] = useState(false);
  const open = opened || !!reveal;
  return (
    <div className="band-readiness" data-open={open || undefined}>
      {children}
      <Button variant="ghost" size="sm" className="band-readiness-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Less' : 'Details'}
      </Button>
    </div>
  );
}

/** A tab label that reserves its selected (semibold) width, so selection never shifts the tabs. */
function PrTabLabel({ children }: { children: string }) {
  return <span className="pr-tab-label" data-label={children}>{children}</span>;
}

/** Review status and merge readiness in the page header, on every tab. It re-renders on each status clock tick. */
function PrStatusLine({ subject, signals, statusSignals, checking, checks, checkErrors, updating, freshness, onChecks }: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  /** The PR's signals from its status read, which Summary's readiness also reads. */
  statusSignals?: QueueSignals;
  checking: boolean;
  checks: Partial<Record<string, PrChecks>>;
  checkErrors: Partial<Record<string, string>>;
  updating: boolean;
  /** "Checked just now": when Gnosis last read the PR from GitHub. */
  freshness: ReactNode;
  onChecks: () => void;
}) {
  countRender('PrStatusLine');
  const now = useStatusNow();
  const stacked = subject.kind === 'stack';
  const stackStatus = stacked ? stackMergeStatus(subject, signals, checks, now) : undefined;
  const mergePlan = stacked ? stackMergePlan(subject, signals, checks, now) : undefined;
  const member = subject.members[0];
  // A PR's chip is Summary's readiness verdict, from the same reads: the most urgent blocker, the rest in its popover.
  const { readiness: prReadiness, signal } = usePrReadiness(member, signals, statusSignals, now);
  const readiness = stackStatus?.summary ?? prReadiness;
  const delayed = Object.values(checkErrors).some(Boolean);
  const iso = (time: number) => new Date(time).toISOString();
  const rollup = !stacked && signal?.headSha === member.headSha ? signal.checks : undefined;
  const chip = stackStatus?.blocked ? { ...readiness, label: 'Not ready to merge' } : readiness;
  const unfinished = (checks[member.url]?.checks ?? []).filter((check) => ['attention', 'running'].includes(checkGroup(check)));
  // When merge requirements and check results were read at the same time, one freshness note says so.
  const together =
    mergePlan && readiness.checkedAt !== undefined && mergePlan.checksCheckedAt !== undefined &&
    !updating && !delayed && now - mergePlan.checksCheckedAt < QUEUE_SIGNALS_TTL &&
    timeAgo(iso(readiness.checkedAt)) === timeAgo(iso(mergePlan.checksCheckedAt))
      ? { requirements: readiness.checkedAt, checks: mergePlan.checksCheckedAt }
      : undefined;
  return <>
    {!stacked && <SubjectReviewStatus subject={subject} signals={signals} checking={checking} now={now} />}
    {(stacked || !['Merged', 'Closed'].includes(chip.label)) && <ReadinessChip readiness={chip} reviewStatusShown={stacked} staleLabel={stacked ? 'Status needs refresh' : undefined}>
      {rollup && rollup.total > 0 && (
        <div className="readiness-popover-checks">
          <p>
            {rollup.passed} of {rollup.total} checks passed
            {rollup.running ? ` · ${rollup.running} running` : ''}
            {rollup.failed ? ` · ${rollup.failed} failed` : ''}
          </p>
          {unfinished.length > 0 && (
            <ul>
              {unfinished.slice(0, 5).map((check) => (
                <li key={check.id}><span>{check.name}</span><span>{checkLabel(check)}</span></li>
              ))}
              {unfinished.length > 5 && <li>{unfinished.length - 5} more</li>}
            </ul>
          )}
          <Button variant="link" size="sm" onClick={onChecks}>Open Checks</Button>
        </div>
      )}
      <p className="readiness-popover-freshness">
        {together ? (
          <span className="merge-readiness-checked stack-checks-freshness" title={`Merge requirements checked ${new Date(together.requirements).toLocaleString()}. Check results checked ${new Date(together.checks).toLocaleString()}.`}>
            Merge status checked <time dateTime={iso(together.requirements)}>{timeAgo(iso(together.requirements))}</time>
          </span>
        ) : <>
          {!stacked ? freshness : readiness.checkedAt === undefined ? <span className="merge-readiness-checked">Merge requirements not confirmed for all PRs</span> : <ReadinessCheckedAt readiness={readiness} label="Merge requirements checked" updating={updating} />}
          {mergePlan && <StackChecksFreshness plan={mergePlan} now={now} delayed={delayed} />}
        </>}
      </p>
      {!stacked && <a className="readiness-popover-link" href={member.url} target="_blank" rel="noopener noreferrer">Merge requirements on GitHub</a>}
    </ReadinessChip>}
  </>;
}

/**
 * How many of the header's actions move to ⋯ (#542): none, the toggles (1), or Update and Drafts too (2). The widths are
 * read while every action shows, so collapsing never undoes itself. A stack member's picker takes room, so it collapses
 * earlier; Merge and the review action always stay.
 */
function useCollapsedActions(row: RefObject<HTMLDivElement | null>, key: string): 0 | 1 | 2 {
  const [collapse, setCollapse] = useState<0 | 1 | 2>(0);
  const widths = useRef({ full: 0, 1: 0, 2: 0 });
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const actions = element.querySelector<HTMLElement>('.pr-header-actions');
      const tabs = element.querySelector<HTMLElement>('.pr-overview-tabs');
      if (!actions || !tabs) {
        setCollapse(0);
        return;
      }
      const actionGap = parseFloat(getComputedStyle(actions).columnGap) || 0;
      const room = (level: '1' | '2') =>
        [...actions.querySelectorAll<HTMLElement>(`[data-collapse-at="${level}"]`)].reduce((total, part) => total + part.offsetWidth + actionGap, 0);
      // With every action showing, read each group's width. Collapsed, the visible part is measured again and the
      // groups in ⋯ keep their last width, so a label that changes while collapsed still counts.
      const level = Number(actions.dataset.collapse ?? 0);
      if (level === 0) widths.current = { full: actions.scrollWidth, 1: room('1'), 2: room('2') };
      else widths.current.full = actions.scrollWidth + widths.current[1] + (level > 1 ? widths.current[2] : 0);
      const { full, 1: first } = widths.current;
      const gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
      const tabsWidth = [...tabs.children].reduce((total, tab) => total + (tab as HTMLElement).offsetWidth + gap, 0);
      const available = element.clientWidth - (element.querySelector<HTMLElement>('.stack-scope-bar')?.offsetWidth ?? 0) - tabsWidth - 32;
      setCollapse(full <= available ? 0 : full - first <= available ? 1 : 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const actions = element.querySelector('.pr-header-actions');
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [key]);
  // The groups in ⋯ keep the width they had when they last showed. Measured before the interface font had loaded, in
  // a wider fallback, they read too wide, and the header could stay collapsed in a window wide enough for every
  // action. Once the fonts in use have loaded, every action shows again for one measure, with the real font. Fonts
  // that load later, such as code fonts or other weights, don't move the header.
  useEffect(() => {
    let alive = true;
    void (document.fonts as FontFaceSet | undefined)?.ready.then(() => {
      if (alive) setCollapse(0);
    });
    return () => {
      alive = false;
    };
  }, []);
  return collapse;
}

/**
 * A PR's merge readiness as Summary shows it: its newest signals for this head, GitHub access and workflow files. The
 * header's chip and its actions (Merge primary, Resolve conflicts) read this one verdict.
 */
function usePrReadiness(member: ReviewMember, signals: QueueSignals[], statusSignals: QueueSignals | undefined, now: number) {
  const access = useGitHubAccess();
  const workflowFiles = useWorkflowFiles(member);
  const queueSignal = signals.find((value) => value.url === member.url);
  const signal = queueSignal && (!statusSignals || queueSignal.checkedAt >= statusSignals.checkedAt) ? queueSignal : statusSignals;
  return { readiness: mergeReadiness(member, signal, now, access, workflowFiles), signal };
}

/** The PR header's actions, with Merge primary and Resolve conflicts from the readiness the chip shows. */
function HeaderPrActions({ signals, statusSignals, ...props }: ComponentProps<typeof PrActions> & { signals: QueueSignals[]; statusSignals?: QueueSignals }) {
  const { readiness } = usePrReadiness(props.member, signals, statusSignals, useStatusNow());
  return <PrActions {...props} mergeReady={readiness.ready} hasConflicts={readiness.label === 'Merge conflicts'} />;
}

/** Merge actions for a whole stack. Whether it can merge depends on the status clock. */
function StackMergeActions({ subject, signals, checks, onChanged }: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checks: Partial<Record<string, PrChecks>>;
  onChanged: () => void;
}) {
  const now = useStatusNow();
  const ready = stackMergeStatus(subject, signals, checks, now).summary.ready;
  return <PrActions member={subject.members[subject.members.length - 1]} stackMembers={subject.members} mergeReady={ready} onChanged={onChanged} />;
}

/**
 * Drops a hidden PR's other tabs after a minute. Built outside the component on purpose: a closure made inside it
 * would share its scope, and a pending timer would then keep the whole page alive, the queue's DOM included, for a
 * minute after its workspace tab closed (found from a heap snapshot, #345).
 */
function scheduleEviction(
  setVisited: (update: (previous: ReadonlySet<WorkspaceTab>) => ReadonlySet<WorkspaceTab>) => void,
  tab: { current: WorkspaceTab }
) {
  // An open Conflicts view is never dropped: it holds your choices until you close it.
  return setTimeout(
    () => setVisited((previous) => new Set([tab.current, ...(previous.has('conflicts') ? ['conflicts' as const] : [])])),
    60_000
  );
}

export function PrSummary(props: ComponentProps<typeof PrSummaryContent>) {
  return <ReviewBreadcrumbProvider><PrSummaryContent {...props} /></ReviewBreadcrumbProvider>;
}
