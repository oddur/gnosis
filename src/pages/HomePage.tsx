import { useWorkspaceNavigation, activeWorkspaceRoot } from '../../lib/workspace-navigation';
import { ExplanationSetupDialog } from '../../components/ExplanationSetupDialog';
import type { GenerateReviewRequest } from '../../lib/types';
import type { FeedbackRequest, ResponseIntent } from '../../lib/feedback';
import { ResponseFilterStatus } from '../../components/ResponseFilterStatus';
import { needsResponse } from '../../lib/response-needed';
import { LoadingState, LoadingIndicator } from '../../components/LoadingState';
import { SubjectIcon } from '../../components/SubjectIcon';
import { useSettingsShortcut } from '../../lib/use-settings-shortcut';
import { preferencesUpdated } from '../../lib/use-repository-settings';
import { ModelEffortSelect } from '../../components/ModelEffortSelect';
import { normalizeEffort } from '../../lib/effort';
import { mergePrStatus } from '../../lib/merge-pr-status';
import { useEntrySelection } from '../../lib/use-entry-selection';
import { runSelectionTasks, type SelectionModifiers } from '../../lib/entry-selection';
import { queueSelectionGroups } from '../../components/QueueSelectionActions';
import { toast } from '../../components/ui/toast';
import { watchGitHub } from '../../lib/watch-github';
import { useOnboarding } from '../../lib/use-onboarding';
import { OnboardingSetup } from '../../components/OnboardingSetup';
import { GuidedTour } from '../../components/GuidedTour';
import { focusStackPr, resolveWorkspace, matchingStackMembers } from '../../lib/stack-workspace';
import { RecentlyViewed } from '../../components/RecentlyViewed';
import { PrListSortControl } from '../../components/PrListSortControl';
import { normalizePrListSort, sortQueueItems, sortSavedReviews, type PrListSort } from '../../lib/pr-list-sort';
import { useListOrder, useListScrollAnchor } from '../../lib/use-list-order';
import { useCachedQueueSignals } from '../../lib/use-queue-signals';
import { PrReadContext, type ViewedPr } from '../../lib/pr-read-context';
import { SearchableSelect } from '../../components/SearchableSelect';
import { applyTheme } from '../../lib/theme';
import { normalizePrInactivityDays } from '../../lib/pr-inactivity';
import type { GitHubSyncStatusProps } from '../../components/GitHubSyncStatus';
import { inspectionData } from '../../lib/inspection-cache';
import { createRowIntent, type RowIntent } from '../../lib/row-intent';
import { openRows, type OpenTarget } from '../../lib/pr-open-targets';
import { EntryActions } from '../../components/EntryActions';
import { prEntryActionGroups, type PrGenerationActionsFor } from '../../components/PrEntryActions';
import { MutedPrs } from '../../components/MutedPrs';
import { isMutedReview, type MutePrRequest } from '../../lib/muted-prs';
import { setDiscussionAccount } from '../../lib/review-discussion-cache';
import { explanationItem, matchesExplanation, type ExplanationDestination } from '../../lib/explanation-workspace';
import { rememberCommandDestination } from '../../lib/command-recents';
import { useCommandCenter, useCommandScope } from '../../lib/command-center';
import type { SearchDestination } from '../../lib/command-search';
import { useSessionDraft } from '../../lib/session-drafts';
import type { VirtualItem } from '@tanstack/react-virtual';
import { VirtualReviewQueue, VirtualSavedReviews, SavedRow, type SavedRowActions } from '../../components/VirtualReviewQueue';
import { QueueRow, type QueueRowActions } from '../../components/QueueRow';
import { useReviewHistory, useWorkbenchQueue, useWorkbenchStatus, workbenchStore } from '../../lib/workbench-store';
import { GitHubIcon } from '../../lib/constants';
import { workbenchIcons, workspaceSections } from '../../lib/interface-icons';
import { WorkbenchIcon } from '../../components/WorkbenchIcon';
import { PrLabels } from '../../components/PrLabels';
import type { PrReadingPosition, PrReviewRequest } from '../../components/PrSummary';
import { PrSummary, SettingsDialog, prefetchScreens } from '../lazy-screens';
import { publishQueueSignals } from '../../lib/use-queue-signals';
import { QueueSidebar, SidebarDestination } from '../../components/QueueSidebar';
import { SavedViewsNav, SaveViewControls } from '../../components/SavedQueueViews';
import type { QueueViewAction } from '../../lib/saved-views';
import { Popover } from 'radix-ui';
import { QueueFilterPanel } from '../../components/QueueFilterPanel';
import {
  DEFAULT_QUEUE_FILTERS,
  normalizeQueueFilters,
  matchesQueueFilters,
  activeQueueFilterCount,
  describeQueueFilters,
  type QueueFilters,
} from '../../lib/queue-filters';
import { Activity, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HomeLocation, WorkspaceTab } from '../../lib/navigation-history';
import {
  ArrowRight,
  Plus,
  GitPullRequest,
  Layers,
  RefreshCw,
  Search,
  Settings,
  Upload,
  X,
  FolderGit2,
  AlertCircle,
  Inbox,
  Trash2,
  Download,
  Link2,
  SlidersHorizontal,
  Star,
  VolumeX,
} from 'lucide-react';
import { GitHubAuthDialog } from '../../components/GitHubAuthDialog';
import { GettingStarted } from '../../components/GettingStarted';
import { WorkbenchHelp } from '../../components/WorkbenchHelp';
import type { SettingsSection } from '../../components/SettingsDialog';
import { applyCodeFont } from '../../lib/code-font';
import { initialPreferences } from '../../lib/startup-preferences';
import { LocalRepoDialog } from '../../components/LocalRepoDialog';
import { UpdateBanner } from '../../components/UpdateBanner';
import { Button } from '../../components/ui/button';
import { LazyMarkdown as Markdown } from '../../components/LazyMarkdown';
import { PROVIDERS } from '../../lib/models';
import { timeAgo } from '../../lib/utils';
import { githubFailureMessage } from '../../lib/github-feedback';
import { useKeyboardShortcuts } from '../../lib/use-keyboard-shortcuts';
import {
  briefingModel,
  fingerprint,
  type QueueItem,
  type ReviewSubject,
  type WorkbenchQueue,
} from '../../lib/workbench';
import type { Preferences, PrStatus, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';

interface Props {
  onAccount?: (account: string, resumeSetup?: boolean) => void;
  navigationRestoration?: { location: HomeLocation; nonce: number };
  onNavigationChange?: (location: HomeLocation, mutedUrls?: Set<string>) => void;
  onReviewReady: (review: ReviewGuide) => void;
  onReviewOriginChange?: (origin: { name: string; reviews: { id: string; title: string }[] }) => void;
  explanationDestination?: ExplanationDestination;
  onShowActivity?: () => void;
  onSyncStatus?: (status: GitHubSyncStatusProps | undefined) => void;
  prefillPrUrl?: string;
  prefillReviewId?: string;
  initialSubjectId?: string;
  commandDestination?: { destination: Extract<SearchDestination, { kind: 'home' }>; nonce: number };
}
/** Each workspace tab shows its own saved view over the shared queue. */
function withOwnView(queue: WorkbenchQueue, own: string | null | undefined): WorkbenchQueue {
  if (!queue.savedViews || own === undefined) return queue;
  const id = queue.savedViews.views.some(view => view.id === own) ? own : null;
  return id === (queue.savedViews.activeId ?? null) ? queue : { ...queue, savedViews: { ...queue.savedViews, activeId: id } };
}
const NO_READ_STATES: NonNullable<WorkbenchQueue['readStates']> = {};
const labels = {
  starred: 'Starred',
  updated: 'Changed since AI explanation',
  requested: 'Review requested',
  other: 'Other changes',
};

let queuePainted = false;
/** The first frame that shows queue rows or the empty state. Other screens load after it. */
function markQueuePainted() {
  if (queuePainted) return;
  queuePainted = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.electronAPI.perfMark?.('queue-painted');
    prefetchScreens();
  }));
}
export function HomePage({ onAccount, navigationRestoration, onNavigationChange, onReviewOriginChange, onReviewReady, prefillPrUrl, prefillReviewId, initialSubjectId, commandDestination, explanationDestination, onShowActivity, onSyncStatus }: Props) {
  const tabs = useWorkspaceNavigation();
  const [feedbackRequest, setFeedbackRequest] = useState<FeedbackRequest>();
  const [responseUnavailable, setResponseUnavailable] = useState(0);
  const [overviewTab,setOverviewTab] = useState<WorkspaceTab>('summary');
  const [reviewRequest, setReviewRequest] = useState<PrReviewRequest>();
  const commandCenter = useCommandCenter();
  const handledCommand = useRef<number>(0);
  const [auth, setAuth] = useState<{ authenticated: boolean; login: string | null } | null>(null);
  useEffect(() => { if (auth) setDiscussionAccount(auth.authenticated ? auth.login ?? '' : ''); }, [auth]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const storeQueue = useWorkbenchQueue();
  const history = useReviewHistory();
  const storeStatus = useWorkbenchStatus();
  // The saved view this tab shows. It starts from the view that was active when the queue first loaded.
  const [ownViewState, setOwnViewId] = useState<string | null | undefined>(undefined);
  const ownViewId = ownViewState === undefined ? storeQueue.savedViews?.activeId : ownViewState;
  useEffect(() => {
    if (ownViewState === undefined && storeQueue.savedViews) setOwnViewId(storeQueue.savedViews.activeId ?? null);
  }, [ownViewState, storeQueue.savedViews]);
  const queue = useMemo(() => withOwnView(storeQueue, ownViewId), [storeQueue, ownViewId]);
  const [loading, setLoading] = useState(() => !(workbenchStore.getStatus().loaded && workbenchStore.getQueue().items.length));
  useEffect(() => { if (storeStatus.loaded && storeQueue.items.length) setLoading(false); }, [storeStatus.loaded, storeQueue.items.length]);
  useEffect(() => { if (!loading) markQueuePainted(); }, [loading]);
  const [refreshing, setRefreshing] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const onboarding = useOnboarding(!loading && !initializing ? prefs : null, auth?.login ?? null, queue.savedViews, history.length === 0);
  const initializationPending = useRef(false);
  const initialized = useRef(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_QUEUE_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savedSortOverride, setSavedSortOverride] = useState<PrListSort>();
  const [savedQuery, setSavedQuery] = useSessionDraft('queue-saved-query', '');
  const [viewBusy, setViewBusy] = useState(false);
  const viewBusyRef = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueWrite = <T,>(task: () => Promise<T>): Promise<T> => {
    const result = writes.current.then(task);
    writes.current = result.catch(() => {});
    return result;
  };
  const activeQueueView = queue.savedViews?.views.find((view) => view.id === queue.savedViews?.activeId);
  const filtersLoaded = useRef(false);
  const pendingFilters = useRef<QueueFilters | null>(null);
  const filterVersion = useRef(0);
  // Unsaved filter edits hold the shared store, so a read from before the edit cannot replace it.
  const filterHold = useRef<(() => void) | null>(null);
  const holdForFilters = () => { filterHold.current ??= workbenchStore.hold(); };
  const releaseFilters = () => { filterHold.current?.(); filterHold.current = null; };
  useEffect(() => {
    if (filtersLoaded.current || !storeStatus.loaded) return;
    setFilters(normalizeQueueFilters(storeQueue.filters));
    filtersLoaded.current = true;
  }, [storeStatus.loaded, storeQueue.filters]);
  const [mutedOpen, setMutedOpen] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [muteError, setMuteError] = useState('');
  const muteBusyRef = useRef(false);
  const [savedView, setSavedView] = useSessionDraft('queue-saved-view', false);
  const [starBusy, setStarBusy] = useState(false);
  const [starError, setStarError] = useState('');
  const starBusyRef = useRef(false);
  const starredUrls = useMemo(
    () => new Set(queue.starredPrs?.map((entry) => entry.member.url) ?? []),
    [queue.starredPrs]
  );
  const changeStars = async (members: ReviewSubject['members'], starred: boolean) => {
    if (starBusyRef.current) return;
    starBusyRef.current = true;
    setStarBusy(true);
    setStarError('');
    const release = workbenchStore.hold();
    try {
      const next = await enqueueWrite(() => window.electronAPI.workbenchStarPrs({ members, starred }));
      workbenchStore.apply(next);
      setError('');
    } catch (error) {
      const message = `Could not save starred PRs: ${error instanceof Error ? error.message : String(error)}. Your stars have not changed. Try the star action again.`;
      setError(message);
      setStarError(message);
    } finally {
      release();
      starBusyRef.current = false;
      setStarBusy(false);
    }
  };
  const mutedUrls = useMemo(() => new Set(queue.mutedPrs?.map(entry => entry.member.url) ?? []), [queue.mutedPrs]);
  const visibleHistory = useMemo(() => history.filter(entry => !isMutedReview(entry, mutedUrls)), [history, mutedUrls]);
  // Muting saves the full PRs. Unmuting sends URLs; the main process restores the saved PRs.
  const changeMutes = async (request: MutePrRequest) => {
    const muted = request.muted;
    if (muteBusyRef.current) return;
    muteBusyRef.current = true; setMuteBusy(true); setMuteError('');
    const release = workbenchStore.hold();
    try {
      const next = await enqueueWrite(() => window.electronAPI.workbenchMutePrs(request));
      // Unmuting changes the saved-review revision, so the store reads saved reviews again.
      workbenchStore.apply(next); setError('');
      if (muted) {
        setOpenedItem(null); setSelected(null);
        requestAnimationFrame(() => activeWorkspaceRoot().querySelector<HTMLButtonElement>('[title="Muted PRs"]')?.focus());
      }
    } catch (error) {
      const message = `Could not ${muted ? 'mute' : 'unmute'} PRs: ${error instanceof Error ? error.message : String(error)}. Nothing changed. Try again.`;
      setMuteError(message); setError(message);
    } finally { release(); muteBusyRef.current = false; setMuteBusy(false); }
  };
  const section = savedView
    ? 'saved'
    : filters.involvement === 'response' ? 'response'
    : filters.starredOnly
      ? 'starred'
      : filters.attention !== 'all'
        ? filters.attention
        : filters.kind === 'stack'
          ? 'stacks'
          : 'all';
  const query = section === 'saved' ? savedQuery : filters.query;
  const repo = filters.repo;
  const filterCount = activeQueueFilterCount(filters);
  const updateFilters = (patch: Partial<QueueFilters>) => {
    if (viewBusyRef.current) return;
    filterVersion.current++;
    filtersLoaded.current = true;
    holdForFilters();
    setFilters((current) => {
      const next = normalizeQueueFilters({ ...current, ...('repo' in patch ? { repos: undefined } : {}), ...patch });
      pendingFilters.current = next;
      return next;
    });
  };
  const viewAction = async (action: QueueViewAction) => {
    if (viewBusyRef.current) return;
    viewBusyRef.current = true;
    setViewBusy(true);
    filterVersion.current++;
    const pending = pendingFilters.current;
    pendingFilters.current = null;
    const release = workbenchStore.hold();
    try {
      const result = await enqueueWrite(async () => {
        if (pending) await window.electronAPI.workbenchSetFilters(pending);
        return window.electronAPI.workbenchViewAction(action);
      });
      setOwnViewId(result.savedViews?.activeId ?? null);
      workbenchStore.apply(result);
      releaseFilters();
      setFilters(normalizeQueueFilters(result.filters));
      filtersLoaded.current = true;
      if (
        action.type === 'activate' ||
        action.type === 'create' ||
        action.type === 'duplicate' ||
        (action.type === 'delete' && action.id === queue.savedViews?.activeId)
      ) {
        setSavedView(false);
        setMutedOpen(false);
        setSelected(null);
      }
      setError('');
    } catch (error) {
      if (pending) pendingFilters.current = pending;
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      release();
      viewBusyRef.current = false;
      setViewBusy(false);
    }
  };
  const setQuery = (value: string) => (section === 'saved' ? setSavedQuery(value) : updateFilters({ query: value }));
  const setRepo = (value: string) => updateFilters({ repo: value });
  const resetFilters = () => {
    updateFilters({ ...DEFAULT_QUEUE_FILTERS, sort: filters.sort, briefingScope: filters.briefingScope });
    setSavedView(false);
  };
  const [selected, setSelected] = useState<string | null>(
    () => {
      if (initialSubjectId) return initialSubjectId;
      try { return localStorage.getItem('gnosis-queue-selection'); } catch { return null; }
    }
  );
  const appliedInitialSubject = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialSubjectId && appliedInitialSubject.current !== initialSubjectId) { appliedInitialSubject.current = initialSubjectId; setSelected(initialSubjectId); setOpenedItem(null); }
  }, [initialSubjectId]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  // The dialog loads on first open and then stays mounted, so closing it keeps its exit animation.
  const [settingsMounted, setSettingsMounted] = useState(false);
  useEffect(() => { if (settings) setSettingsMounted(true); }, [settings]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('queue');
  const [showGettingStarted, setShowGettingStarted] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const connectionRequired = !!auth && !!prefs && prefs.firstRunSeen && !auth.authenticated && !prefs.guestMode && !onboarding.open;
  const [localOpen, setLocalOpen] = useState(false);
  const [url, setUrl] = useState(prefillPrUrl ?? '');
  const [showUrl, setShowUrl] = useState(!!prefillPrUrl);
  // The page stays mounted behind saved reviews, so a later re-review must apply its URL here.
  const appliedPrefill = useRef(prefillPrUrl);
  useEffect(() => {
    if (appliedPrefill.current === prefillPrUrl) return;
    appliedPrefill.current = prefillPrUrl;
    if (prefillPrUrl) { setUrl(prefillPrUrl); setShowUrl(true); }
  }, [prefillPrUrl]);
  const [pendingStarts, setPendingStarts] = useState<Set<string>>(new Set());
  const startingReviews = useRef(new Set<string>());
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string>>({});
  const [openingPr, setOpeningPr] = useState(false);
  const [openedItem, setOpenedItem] = useState<QueueItem | null>(null);
  // Activity does not hide portaled content, and updates to the hidden queue wait until it is shown.
  // So when a PR opens, hide the open filter popover at once and close it.
  if (filtersOpen && openedItem) setFiltersOpen(false);
  const filterPopover = useRef<HTMLElement | null>(null);
  const hasOpenedItem = !!openedItem;
  useLayoutEffect(() => {
    if (filterPopover.current?.isConnected) filterPopover.current.style.display = hasOpenedItem ? 'none' : '';
  }, [hasOpenedItem]);
  useEffect(() => { if (!openedItem) setFeedbackRequest(undefined); }, [openedItem?.subject.id]);
  const [readBusy, setReadBusy] = useState(false);
  const readAccount = useRef(auth?.login);
  readAccount.current = auth?.login;
  const readVisit = useRef<{ id: string | undefined; manual: Set<string> }>({ id: undefined, manual: new Set() });
  const visitId = openedItem ? `${auth?.login}:${openedItem.subject.id}` : undefined;
  if (readVisit.current.id !== visitId) readVisit.current = { id: visitId, manual: new Set() };
  const changeRead = async (urls: string[], read: boolean, displayed?: ViewedPr[]) => {
    const account = auth?.login;
    if (!account) return;
    const receipts = urls.flatMap(url => {
      const receipt = queue.readStates?.[url];
      return receipt ? [{ ...receipt, headSha: displayed?.find(pr => pr.url === url)?.headSha ?? receipt.headSha }] : [];
    });
    if (!receipts.length) return;
    // Reserve manual intent before the asynchronous write, so content loading
    // later in this visit cannot undo it.
    if (!read) urls.forEach(url => readVisit.current.manual.add(url));
    setReadBusy(true);
    try {
      const result = await enqueueWrite(() => window.electronAPI.workbenchMarkPrRead({ account, receipts, read }));
      if (alive.current && readAccount.current === account && result.readStates) workbenchStore.patch(previous => ({ ...previous, readStates: result.readStates, savedViews: result.savedViews,
        items: previous.items.map(item => ({ ...item, unreadUrls: item.subject.members.filter(m => result.readStates?.[m.url]?.unread.length).map(m => m.url) })),
        starredItems: previous.starredItems?.map(item => ({ ...item, unreadUrls: item.subject.members.filter(m => result.readStates?.[m.url]?.unread.length).map(m => m.url) })),
      }));
    } catch (error) {
      setError(`Could not save unread progress: ${error instanceof Error ? error.message : String(error)}. Try marking the PR again.`);
    } finally { setReadBusy(false); }
  };
  const [positions] = useSessionDraft('queue-reading-positions', () => new Map<string, PrReadingPosition>());
  useEffect(() => {
    if (openedItem) rememberCommandDestination(auth?.login ?? 'local', `subject:${openedItem.subject.id}`);
  }, [openedItem?.subject.id, auth?.login]);
  const readingPositions = useRef(positions);
  const [requestedReviews, setRequestedReviews] = useState<Record<string, string>>({});
  const [parentUrl, setParentUrl] = useState('');
  const [childUrl, setChildUrl] = useState('');
  const [grouping, setGrouping] = useState(false);
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [savedSummary, setSavedSummary] = useState<{ id: string; summary: string; focus: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Publish attachment so the virtualizer measures the remounted queue before paint.
  const [queueScrollElement, setQueueScrollElement] = useState<HTMLElement | null>(null);
  const queueMeasurements = useRef<VirtualItem[]>([]);
  const [visibleQueueIds, setVisibleQueueIds] = useState<string[]>([]);
  const updateVisibleQueueIds = useCallback((ids: string[]) => {
    setVisibleQueueIds(previous => previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids);
  }, []);
  const [queueScrollOffset] = useSessionDraft('queue-scroll', () => ({ current: 0 }));
  const pendingRowFocus = useRef<string | null>(null);
  const attachedQueue = useRef<HTMLElement | null>(null);
  const attachQueueScroll = useCallback((element: HTMLElement | null) => {
    // Activity detaches refs before hiding a tab. Capture even a pending scroll event.
    if (!element && attachedQueue.current) queueScrollOffset.current = attachedQueue.current.scrollTop;
    attachedQueue.current = element;
    setQueueScrollElement(element);
    if (element) element.scrollTop = queueScrollOffset.current;
  }, []);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [statuses, setStatuses] = useState<Partial<Record<string, PrStatus>>>({});
  const cachedStatuses = useRef(new Map<string, PrStatus>());
  const lastStatusAttempt = useRef(0);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const alive = useRef(true);
  // Filters that depend on age use one clock per minute, so memoized lists stay stable between ticks.
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const login = auth?.login;
  const allItems = useMemo(() => [...queue.items, ...(queue.starredItems ?? [])], [queue.items, queue.starredItems]);
  const itemsById = useMemo(() => {
    const byId = new Map<string, QueueItem>();
    for (const item of allItems) if (!byId.has(item.subject.id)) byId.set(item.subject.id, item);
    return byId;
  }, [allItems]);
  const selectedItem = useMemo(() => {
    const item = selected ? itemsById.get(selected) : undefined;
    return item && matchesQueueFilters(item, filters, clock, login) ? item : undefined;
  }, [itemsById, selected, filters, login, clock]);
  const workspaceItems = useMemo(() => {
    const result = [...allItems];
    const ids = new Set(result.map(item => item.subject.id));
    for (const stack of queue.stacks ?? []) if (!ids.has(stack.id)) { ids.add(stack.id); result.push({ subject: stack, attention: 'other' }); }
    for (const entry of visibleHistory) if (entry.snapshot?.subject.kind === 'stack' && !ids.has(entry.snapshot.subject.id)) {
      ids.add(entry.snapshot.subject.id);
      result.push({ subject: entry.snapshot.subject, attention: 'other', review: entry });
    }
    return result;
  }, [allItems, queue.stacks, visibleHistory]);
  const summaryItem = useMemo(() => {
    const summarySource = openedItem && resolveWorkspace(openedItem, workspaceItems);
    return summarySource && {
      ...summarySource,
      review:
        visibleHistory.find((entry) => entry.id === requestedReviews[summarySource.subject.id]) ??
        visibleHistory.find(
          (entry) =>
            entry.snapshot?.subject.id === summarySource.subject.id ||
            (!entry.snapshot && entry.prUrl === summarySource.subject.members[0].url)
        ) ??
        (summarySource.review && matchesExplanation(summarySource.review, summarySource.subject) ? summarySource.review : undefined),
    };
  }, [openedItem, workspaceItems, visibleHistory, requestedReviews]);
  const appliedExplanation = useRef<ExplanationDestination | undefined>(undefined);
  useEffect(() => {
    if (!explanationDestination || appliedExplanation.current === explanationDestination) return;
    appliedExplanation.current = explanationDestination;
    const item = explanationItem(explanationDestination.review);
    setOpenedItem(item);
    setSelected(item.subject.id);
    setOverviewTab('explanation');
  }, [explanationDestination]);
  const statusSubject = summaryItem?.subject ?? selectedItem?.subject;
  const briefingSelection = prefs ? briefingModel(prefs) : undefined;
  const briefingModelLabel = briefingSelection
    ? `${PROVIDERS[briefingSelection.provider].label} · ${PROVIDERS[briefingSelection.provider].models.find((m) => m.id === briefingSelection.model)?.label ?? briefingSelection.model}`
    : '';

  // The store reads and dedupes; this adds the pending-filter save, the spinner and errors.
  const refresh = useCallback(async (force = false, cachedOnly = false): Promise<void> => {
    if (force) setRefreshing(true);
    try {
      // A failed filter save leaves local edits pending. An explicit retry saves them before reloading.
      if (force && pendingFilters.current) {
        const pending = pendingFilters.current;
        const version = filterVersion.current;
        await enqueueWrite(() => window.electronAPI.workbenchSetFilters(pending));
        if (version === filterVersion.current) { pendingFilters.current = null; releaseFilters(); }
      }
      await workbenchStore.refresh({ discover: !cachedOnly, force });
      if (alive.current) setQueueFailed(false);
    } catch (e) {
      if (alive.current) {
        setError(String(e));
        setQueueFailed(true);
      }
    } finally {
      if (alive.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);
  const forceRefresh = useCallback(() => void refresh(true), [refresh]);
  const syncStatus = queue.sync?.status, syncCheckedAt = queue.sync?.checkedAt, syncRetryAt = queue.sync?.retryAt;
  useEffect(() => {
    onSyncStatus?.({ sync: syncStatus && { status: syncStatus, checkedAt: syncCheckedAt, retryAt: syncRetryAt }, onRefresh: forceRefresh });
  }, [syncStatus, syncCheckedAt, syncRetryAt, forceRefresh, onSyncStatus]);
  useEffect(() => () => onSyncStatus?.(undefined), [onSyncStatus]);
  const initialize = useCallback(async () => {
    if (initializationPending.current) return;
    initializationPending.current = true;
    const resuming = initialized.current;
    if (!resuming) setInitializing(true);
    try {
      // The first page shares the preferences read at startup; revealing a kept page reads them again.
      const [a, p] = await Promise.all([window.electronAPI.getAuthState(), resuming ? window.electronAPI.loadPreferences() : initialPreferences()]);
      if (!alive.current) return;
      // Revealing a kept page initializes again; unchanged values keep their identity.
      setAuth(previous => previous?.authenticated === a.authenticated && previous.login === a.login ? previous : a);
      onAccount?.(a.authenticated ? a.login ?? 'local' : 'local');
      setPrefs(previous => previous && JSON.stringify(previous) === JSON.stringify(p) ? previous : p);
      if (p.codeFont) applyCodeFont(p.codeFont);
      applyTheme(p.theme);
      initialized.current = true;
      setInitializationFailed(false);
      setError('');
      void refresh(false, resuming);
    } catch (e) {
      if (alive.current) {
        setError(`Could not load your account and settings. ${e instanceof Error ? e.message : String(e)}`);
        setInitializationFailed(true);
        setLoading(false);
      }
    } finally {
      initializationPending.current = false;
      if (alive.current) setInitializing(false);
    }
  }, [refresh, onAccount]);
  useEffect(() => {
    alive.current = true;
    void initialize();
    const poll = () => { if (initialized.current && document.visibilityState !== 'hidden') void refresh(); };
    // The shared store applies pushed changes. Without pushes, poll GitHub discovery instead.
    const pushes = window.electronAPI.githubSyncVersion === 1 && !!window.electronAPI.onWorkbenchChanged;
    const timer = pushes ? undefined : setInterval(poll, 4000);
    document.addEventListener('visibilitychange', poll);
    const afterPrAction = () => { void refresh(); setStatusAttempt(n => n + 1); };
    window.addEventListener('gnosis-pr-action-completed', afterPrAction);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('gnosis-pr-action-completed', afterPrAction);
    };
  }, [refresh, initialize]);
  useEffect(() => {
    if (!pendingFilters.current || !auth?.authenticated) return;
    const version = filterVersion.current;
    const timer = setTimeout(() => {
      const next = pendingFilters.current;
      if (!next) return;
      void enqueueWrite(() => window.electronAPI.workbenchSetFilters(next))
        .then((result) => {
          if (version !== filterVersion.current) return;
          pendingFilters.current = null;
          releaseFilters();
          if (alive.current) workbenchStore.apply(result);
        })
        .catch((e: unknown) => {
          // Keep the edits pending for an explicit retry, but let other tabs keep updating.
          if (version === filterVersion.current) releaseFilters();
          if (alive.current) setError(`Could not save queue filters: ${String(e)}`);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, auth?.authenticated]);
  useEffect(
    () => () => {
      if (pendingFilters.current) {
        const pending = pendingFilters.current;
        pendingFilters.current = null;
        void enqueueWrite(() => window.electronAPI.workbenchSetFilters(pending)).catch(() => {}).finally(releaseFilters);
      } else releaseFilters();
    },
    []
  );
  // Holding an arrow key must not write storage on every row; write once the selection settles.
  const unsavedSelection = useRef<string | null>(null);
  const saveSelection = useCallback(() => {
    const value = unsavedSelection.current;
    unsavedSelection.current = null;
    try {
      if (value) localStorage.setItem('gnosis-queue-selection', value);
    } catch { /* Remembering selection is optional; keep the queue usable if storage is unavailable. */ }
  }, []);
  useEffect(() => {
    if (!selected) return;
    unsavedSelection.current = selected;
    const timer = setTimeout(saveSelection, 300);
    return () => clearTimeout(timer);
  }, [selected, saveSelection]);
  useEffect(() => {
    window.addEventListener('pagehide', saveSelection);
    return () => { window.removeEventListener('pagehide', saveSelection); saveSelection(); };
  }, [saveSelection]);
  useEffect(() => {
    let cancelled = false;
    const cacheKey = (url: string, sha: string) => `${auth?.login}:${url}@${sha}`;
    setStatuses(
      Object.fromEntries(
        (statusSubject?.members ?? []).flatMap((m) => {
          const saved = cachedStatuses.current.get(cacheKey(m.url, m.headSha));
          return saved ? [[m.url, saved]] : [];
        })
      )
    );
    setStatusErrors({});
    let force = lastStatusAttempt.current !== statusAttempt;
    let refreshingStatus = false;
    let opened = true;
    lastStatusAttempt.current = statusAttempt;
    const refreshStatuses = () => {
      if (statusSubject && !refreshingStatus && document.visibilityState !== 'hidden') {
        refreshingStatus = true;
        if (force || !statusSubject.members.every(member => cachedStatuses.current.has(cacheKey(member.url, member.headSha)))) setStatusRefreshing(true);
        const refreshNow = force;
        const firstRead = opened;
        force = false;
        opened = false;
        // Show the saved status for this head revision while GitHub is read again.
        if (firstRead && window.electronAPI.githubSyncVersion === 1)
          for (const m of statusSubject.members) {
            if (cachedStatuses.current.has(cacheKey(m.url, m.headSha))) continue;
            void window.electronAPI.getPrStatus(m.url, false, { cachedOnly: true, headSha: m.headSha })
              .then(status => {
                if (!cancelled && status) setStatuses(previous => ({ ...previous, [m.url]: mergePrStatus(previous[m.url], status) }));
              })
              .catch(() => { /* A missing saved copy just means waiting for GitHub. */ });
          }
        void Promise.allSettled(
          statusSubject.members.map(async (m) => ({
            url: m.url,
            status: await (firstRead
              ? window.electronAPI.getPrStatus(m.url, refreshNow, { opened: true, headSha: m.headSha })
              : window.electronAPI.getPrStatus(m.url, refreshNow)),
          }))
        ).then((results) => {
          refreshingStatus = false;
          if (!cancelled) {
            setStatusRefreshing(false);
            results.forEach((r, i) => {
              if (r.status !== 'fulfilled') return;
              const m = statusSubject.members[i];
              if (!r.value.status.stale) cachedStatuses.current.set(cacheKey(m.url, m.headSha), r.value.status);
              if (auth?.login && r.value.status.signals) publishQueueSignals(auth.login, [r.value.status.signals]);
            });
            setStatusErrors(
              Object.fromEntries(
                results.flatMap((r, i) =>
                  r.status === 'rejected' ? [[statusSubject.members[i].url, String(r.reason)]] : []
                )
              )
            );
            setStatuses((previous) => ({
              ...previous,
              ...Object.fromEntries(
                results.flatMap((r) => (r.status === 'fulfilled' ? [[r.value.url, mergePrStatus(previous[r.value.url], r.value.status)]] : []))
              ),
            }));
          }
        });
      }
    };
    refreshStatuses();
    const stopMetadata = statusSubject && watchGitHub({ kind: 'metadata', priority: 'active', targets: statusSubject.members.map(member => ({ url: member.url })) }, () => refreshStatuses());
    const timer = stopMetadata ? undefined : setInterval(refreshStatuses, 120000);
    document.addEventListener('visibilitychange', refreshStatuses);
    let refreshingSignals = false;
    const refreshSignals = async () => {
      if (!statusSubject || refreshingSignals || document.visibilityState === 'hidden') return;
      refreshingSignals = true;
      try {
        for (let i = 0; i < statusSubject.members.length && !cancelled; i += 25) {
          const values = await window.electronAPI.getQueueSignals(
            statusSubject.members.slice(i, i + 25).map(m => ({ url: m.url, headSha: m.headSha })), { active: true });
          // Cleanup can run while the IPC request above is pending.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (cancelled) return;
          if (auth?.login) publishQueueSignals(auth.login, values);
          setStatuses(previous => {
            const next = { ...previous };
            for (const signals of values) {
              const status = next[signals.url];
              if (status) next[signals.url] = { ...status, signals, ciConclusion: signals.checks.state };
            }
            return next;
          });
        }
      } catch { /* Keep the last checked status; the shared client owns backoff. */ }
      finally { refreshingSignals = false; }
    };
    const stopSignals = statusSubject && watchGitHub({ kind: 'signals', priority: 'active', targets: statusSubject.members.map(member => ({ url: member.url, headSha: member.headSha })) }, update => {
      if (update.kind !== 'signals' || !auth?.login) return;
      const signals = update.value;
      publishQueueSignals(auth.login, [signals]);
      setStatuses(previous => {
        const status = previous[signals.url];
        return status ? { ...previous, [signals.url]: mergePrStatus(status, { ...status, signals, ciConclusion: signals.checks.state }) } : previous;
      });
    });
    const stopChecks = statusSubject && watchGitHub({ kind: 'checks', priority: 'active', targets: statusSubject.members.map(member => ({ url: member.url, headSha: member.headSha })) }, update => {
      if (update.kind !== 'checks') return;
      setStatuses(previous => {
        const status = previous[update.url];
        return status ? { ...previous, [update.url]: mergePrStatus(status, { ...status, checkSnapshot: update.value, ciChecks: update.value.checks, ciError: undefined }) } : previous;
      });
    });
    const signalTimer = stopSignals ? undefined : setInterval(() => void refreshSignals(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(signalTimer);
      if (stopMetadata) stopMetadata();
      if (stopSignals) stopSignals();
      if (stopChecks) stopChecks();
      document.removeEventListener('visibilitychange', refreshStatuses);
    };
  }, [
    selected,
    auth?.login,
    statusSubject?.id,
    statusSubject?.members.map((m) => `${m.url}@${m.headSha}`).join(','),
    statusAttempt,
  ]);
  const fallbackReview =
    selectedItem?.review?.status === 'completed' && selectedItem.briefing?.status !== 'ready'
      ? selectedItem.review
      : undefined;
  useEffect(() => {
    let cancelled = false;
    setSavedSummary(null);
    if (fallbackReview) {
      void window.electronAPI
        .loadReview(fallbackReview.id)
        .then((review) => {
          if (!cancelled)
            setSavedSummary({ id: fallbackReview.id, summary: review.summary, focus: review.riskRationale });
        })
        .catch(() => {
          /* The indexed excerpt remains available if the saved file cannot be read. */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [fallbackReview?.id, fallbackReview?.savedAt]);
  const selectionFilterKey = useMemo(() => JSON.stringify({ ...filters, sort: undefined }), [filters]);
  const lastSelectionScroll = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = JSON.stringify([selected, loading, section, selectionFilterKey]);
    if (lastSelectionScroll.current === key) return;
    lastSelectionScroll.current = key;
    rowButtons.current.get(selected ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [selected, loading, section, selectionFilterKey]);
  useEffect(() => {
    const listener = (event: Event) => { setPrefs((event as CustomEvent<Preferences>).detail); void refresh(); };
    window.addEventListener('gnosis-preferences-changed', listener);
    return () => window.removeEventListener('gnosis-preferences-changed', listener);
  }, [refresh]);
  const savePrefs = async (next: Preferences) => {
    await window.electronAPI.savePreferences(next);
    preferencesUpdated(next);
    setPrefs(next);
    void refresh();
  };
  const [explanationSetup, setExplanationSetup] = useState<{
    requests: GenerateReviewRequest[];
    resolve: (started: boolean) => void;
  }>();
  const setupOpen = useRef(false);
  const setupResolver = useRef<((started: boolean) => void) | undefined>(undefined);
  useEffect(() => () => setupResolver.current?.(false), []);
  const explanationRequest = (
    target: string,
    subject?: ReviewSubject,
    localTools?: boolean,
    standalone = false,
    restore = true,
  ): GenerateReviewRequest | undefined => {
    if (!prefs) return;
    const previous = restore
      ? visibleHistory.find((entry) =>
          subject
            ? entry.snapshot?.subject.id === subject.id ||
              (!entry.snapshot && subject.members.length === 1 && entry.prUrl === target)
            : entry.prUrl === target,
        )
      : undefined;
    return {
      prUrl: target,
      subjectId: subject?.id,
      standalone,
      provider: prefs.provider,
      model: prefs.model,
      instructions: prefs.instructions,
      thinking: prefs.thinking,
      effort: prefs.effort,
      smartImports: prefs.smartImports,
      reviewSuggestions: prefs.reviewSuggestions,
      webResearch: prefs.enableWebResearch,
      claudeContext: prefs.claudeContext,
      localTools,
      previousReviewId: restore && target === prefillPrUrl && prefillReviewId ? prefillReviewId : previous?.id,
    };
  };
  const configureExplanations = (requests: GenerateReviewRequest[]): Promise<boolean> => {
    if (!requests.length || setupOpen.current) return Promise.resolve(false);
    setupOpen.current = true;
    return new Promise((resolve) => {
      setupResolver.current = resolve;
      setExplanationSetup({ requests, resolve });
    });
  };
  const start = (
    target: string,
    subject?: ReviewSubject,
    localTools?: boolean,
    standalone = false,
    previousReviewId?: string,
  ) => {
    const request = explanationRequest(target, subject, localTools, standalone);
    if (request && previousReviewId) request.previousReviewId = previousReviewId;
    return request ? configureExplanations([request]) : Promise.resolve(false);
  };

  const runExplanation = async (request: GenerateReviewRequest) => {
    const target = request.prUrl;
    if (!prefs) throw new Error('Settings are still loading. Try again.');
    const requestKey = request.subjectId ?? target;
    if (startingReviews.current.has(requestKey)) throw new Error('An explanation is already starting for this PR.');
    startingReviews.current.add(requestKey);
    setError('');
    setSummaryErrors((previous) => ({ ...previous, [requestKey]: '' }));
    setPendingStarts((previous) => new Set(previous).add(requestKey));
    try {
      const cli = await window.electronAPI.checkCliInstalled(request.provider);
      if (!cli.installed)
        throw new Error(`${PROVIDERS[request.provider].label} was not found. Open Settings → Integrations for AI setup.`);
      const result = await window.electronAPI.startReview(request);
      if (openedItem) setRequestedReviews((previous) => ({ ...previous, [requestKey]: result.reviewId }));
      if (!prefs.firstRunSeen || showGettingStarted) void dismissGettingStarted();
      setShowUrl(false);
      setUrl('');
      await refresh();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (openedItem?.subject.id === requestKey) setSummaryErrors((previous) => ({ ...previous, [requestKey]: message }));
      else setError(message);
      throw e;
    } finally {
      startingReviews.current.delete(requestKey);
      setPendingStarts((previous) => {
        const next = new Set(previous);
        next.delete(requestKey);
        return next;
      });
    }
  };
  const restoredSetup = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prefillReviewId || !prefillPrUrl || !prefs || loading || setupOpen.current) return;
    const key = `${prefillReviewId}:${prefillPrUrl}`;
    if (restoredSetup.current === key) return;
    restoredSetup.current = key;
    const previous = visibleHistory.find(entry => entry.id === prefillReviewId);
    const subject = previous?.snapshot?.subject;
    setShowUrl(false);
    void start(prefillPrUrl, subject, undefined, subject?.scope === 'single', prefillReviewId);
  }, [prefillReviewId, prefillPrUrl, prefs, loading, visibleHistory]);
  const open = async (entry: ReviewHistoryEntry) => {
    try {
      await window.electronAPI.markReviewRead(entry.id);
      onReviewReady(await window.electronAPI.loadReview(entry.id));
    } catch (e) {
      setError(String(e));
    }
  };
  const syncAuth = async () => {
    const nextAuth = await window.electronAPI.getAuthState();
    setAuth(nextAuth);
    const resumeSetup = nextAuth.authenticated && onboarding.open;
    if (resumeSetup && onboarding.state.draft) {
      await window.electronAPI.saveOnboarding({ ...onboarding.state, paused: false, completed: false }, nextAuth.login);
    }
    onAccount?.(nextAuth.authenticated ? nextAuth.login ?? 'local' : 'local', resumeSetup);
    if (nextAuth.authenticated) {
      const current = await window.electronAPI.loadPreferences();
      await savePrefs({ ...current, guestMode: false });
    }
    setAuthOpen(false);
    setError('');
    void refresh(true);
  };
  const queueItems = useMemo(() => filters.starredOnly ? (queue.starredItems ?? []) : queue.items, [filters.starredOnly, queue.items, queue.starredItems]);
  const { responseMembers, responseIncomplete } = useMemo(() => {
    const candidates = filters.involvement === 'response' ? queueItems.flatMap(item => item.subject.members
      .filter(member => member.state === 'open' && !member.merged && matchesQueueFilters({ ...item, subject: { ...item.subject, members: [member] } }, { ...filters, involvement: 'authored' }, clock, login))
      .map(member => ({ member, response: item.responses?.[member.url] }))) : [];
    return { responseMembers: candidates.map(candidate => candidate.member), responseIncomplete: candidates.filter(candidate => !candidate.response?.complete).length };
  }, [queueItems, filters, clock, login]);
  const refreshResponseQueue = useCallback(() => { void refresh(false, true); }, [refresh]);
  const openedId = openedItem?.subject.id;
  const items = useMemo(() => queueItems.filter((item) => matchesQueueFilters(item,
    filters.readStatus !== 'all' && openedId === item.subject.id ? { ...filters, readStatus: 'all' } : filters,
    clock, login)), [queueItems, filters, openedId, login, clock]);
  const itemIds = useMemo(() => new Set(items.map(item => item.subject.id)), [items]);
  const repos = useMemo(() => [
    ...new Set([...queueItems.flatMap((i) => i.subject.members.map((m) => m.repo)), ...(repo === 'all' ? [] : [repo])]),
  ].sort(), [queueItems, repo]);
  const savedSort = savedSortOverride ?? normalizePrListSort(prefs?.savedReviewSort, true);
  const statusSort = (savedView ? savedSort : filters.sort).key === 'status';
  const signalMembers = useMemo(() => statusSort
    ? [...queueItems.flatMap(item => item.subject.members), ...(savedView ? visibleHistory.flatMap(entry => entry.snapshot?.subject.members ?? []) : [])]
    : [], [statusSort, queueItems, savedView, visibleHistory]);
  const sortSignals = useCachedQueueSignals(auth?.login ?? null, signalMembers, statusSort);
  const sortedSaved = useMemo(() => sortSavedReviews(
    visibleHistory.filter(h => `${h.prTitle} ${h.prUrl}`.toLowerCase().includes(query.toLowerCase())), savedSort, starredUrls, sortSignals),
  [visibleHistory, query, savedSort, starredUrls, sortSignals]);
  const saved = useListOrder(sortedSaved, entry => entry.id);
  const sortedItems = useMemo(() => sortQueueItems(items, filters.sort, sortSignals), [items, filters.sort, sortSignals]);
  const orderedItems = useListOrder(sortedItems, item => item.subject.id);
  const orderedIds = useMemo(() => orderedItems.map(item => item.subject.id), [orderedItems]);
  const selectionScope = useMemo(() => JSON.stringify([auth?.login, section, mutedOpen, openedId, filters, queue.savedViews?.activeId]),
    [auth?.login, section, mutedOpen, openedId, filters, queue.savedViews?.activeId]);
  const selection = useEntrySelection(orderedIds, selectionScope, selected);
  const selectionSignature = [...selection.keys].join('\n');
  const selectedItems = useMemo(() => orderedItems.filter(item => selection.keys.has(item.subject.id)),
    // The selection hook returns a new Set every render; its content is the signature.
    [orderedItems, selectionSignature]);
  const multiple = selectedItems.length > 1;
  const [batchBusy, setBatchBusy] = useState(false);
  const batchRunning = useRef(false);
  useListScrollAnchor(section === 'saved' ? queueScrollElement : null, saved.map(entry => entry.id));
  const changeSort = (sort: PrListSort) => {
    if (section !== 'saved') { updateFilters({ sort }); return; }
    setSavedSortOverride(sort);
    void enqueueWrite(async () => {
      const current = await window.electronAPI.loadPreferences();
      await window.electronAPI.savePreferences({ ...current, savedReviewSort: sort });
      setPrefs(previous => previous ? { ...previous, savedReviewSort: sort } : previous);
    }).catch(() => setError('Could not save the sort order. Choose it again to retry.'));
  };
  // Active and visible PRs, unread work, current view, then the remaining queue. Revision identity
  // prevents routine metadata/CI updates from repeating content downloads.
  const orderedBacklog = useMemo(() => sortQueueItems(queue.items, filters.sort, sortSignals), [queue.items, filters.sort, sortSignals]);
  const inspectionKey = useMemo(() => {
    const visible = new Set(visibleQueueIds);
    const targets = [...(statusSubject?.members ?? []),
      ...orderedItems.flatMap(item => item.subject.members), ...orderedBacklog.flatMap(item => item.subject.members)];
    return JSON.stringify({
      targets: targets.map(member => ({ url: member.url, baseSha: member.baseSha, headSha: member.headSha })),
      intent: {
        active: statusSubject?.members.map(member => member.url) ?? [],
        visible: orderedItems.filter(item => visible.has(item.subject.id)).flatMap(item => item.subject.members.map(member => member.url)),
        unread: [...new Set([...orderedItems, ...orderedBacklog].flatMap(item => item.unreadUrls ?? []))],
        view: orderedItems.flatMap(item => item.subject.members.map(member => member.url)),
      },
      rows: [...new Map([...(statusSubject ? [statusSubject] : []), ...[...orderedItems, ...orderedBacklog].map(item => item.subject)]
        .map(subject => [subject.id, { id: subject.id, members: subject.members.map(({ url, headSha, baseSha, updatedAt }) => ({ url, headSha, baseSha, updatedAt })) }])).values()],
    });
  }, [statusSubject, orderedItems, orderedBacklog, visibleQueueIds]);
  // Status, checks and discussions are saved ahead of opening. Hover and focus intent lives in a ref, so it never re-renders.
  const openIntent = useRef<{ rows: Map<string, OpenTarget[]>; intent: RowIntent } | null>(null);
  // Stable, so the memoized queue list does not re-render for hover wiring.
  const onQueueIntent = useCallback((id: string | null) => { if (id) openIntent.current?.intent.enter(id); else openIntent.current?.intent.leave(); }, []);
  useEffect(() => {
    if (!auth) return;
    const preload = () => {
      const { targets, intent, rows } = JSON.parse(inspectionKey) as { targets: Parameters<typeof inspectionData.setTargets>[1]; intent: Parameters<typeof inspectionData.setTargets>[2]; rows: Parameters<typeof openRows>[0] };
      inspectionData.setTargets(auth.authenticated ? auth.login : null, targets, intent);
      const open = openRows(rows, intent ?? {});
      window.electronAPI.prOpenPreload?.(auth.authenticated ? open.targets.slice(0, 200) : []);
      openIntent.current ??= { rows: open.rows, intent: createRowIntent({
        fire: id => {
          const members = openIntent.current?.rows.get(id) ?? [];
          if (!members.length) return;
          inspectionData.setIntent(members.map(member => member.url));
          window.electronAPI.prOpenIntent?.(members);
          void PrSummary.preload();
        },
        clear: () => { inspectionData.setIntent([]); window.electronAPI.prOpenIntent?.(null); },
      }) };
      openIntent.current.rows = open.rows;
    };
    preload();
    document.addEventListener('visibilitychange', preload);
    return () => document.removeEventListener('visibilitychange', preload);
  }, [auth?.authenticated, auth?.login, inspectionKey]);

  const originName = savedView ? 'Saved reviews' : activeQueueView?.name ??
    ({ saved: 'Saved reviews', all: 'Review queue', starred: 'Starred', requested: 'Review requests', updated: 'Updated PRs', stacks: 'Stacks', other: 'Other changes', response: 'Needs my response' }[section]);
  const originSignature = useMemo(() => JSON.stringify({ name: originName, reviews: savedView ? saved.map(entry => ({ id: entry.id, title: entry.prTitle })) : [] }), [originName, savedView, saved]);
  useEffect(() => { onReviewOriginChange?.(JSON.parse(originSignature) as { name: string; reviews: { id: string; title: string }[] }); }, [originSignature, onReviewOriginChange]);
  const summaryChoices = useMemo(() => savedView
    ? [...new Map(saved.map(entry => [entry.snapshot?.subject.id ?? entry.prUrl,
      { value: entry.snapshot?.subject.id ?? entry.prUrl, label: entry.prTitle, kind: entry.snapshot?.subject.kind === 'stack' ? 'stack' as const : entry.prUrl.startsWith('local:') ? undefined : 'pr' as const }])).values()]
    : orderedItems.map(item => ({ value: item.subject.id, kind: item.subject.kind === 'stack' ? 'stack' as const : 'pr' as const, label: item.subject.kind === 'stack'
      ? `Stack · ${item.subject.title}` : `${item.subject.members[0].repo} #${item.subject.members[0].number} · ${item.subject.title}` })), [savedView, saved, orderedItems]);
  const summaryNavigation = useRef(0);
  const restoredNavigation = useRef(0);
  const historyLocation = useRef<HomeLocation | undefined>(undefined);
  useLayoutEffect(() => {
    if (initializing || loading || !prefs || viewBusy) return;
    if (navigationRestoration && restoredNavigation.current !== navigationRestoration.nonce) {
      restoredNavigation.current = navigationRestoration.nonce;
      const next = navigationRestoration.location;
      if (next.account !== (auth?.login ?? 'local')) return;
      summaryNavigation.current++;
      const viewId = queue.savedViews?.views.some(view => view.id === next.viewId) ? next.viewId : null;
      const viewChanged = viewId !== (queue.savedViews?.activeId ?? null);
      setOwnViewId(viewId);
      // Tab/PR history must not leave a pending filter write when filters did not change.
      if (viewChanged || JSON.stringify(filters) !== JSON.stringify(next.filters)) {
        filterVersion.current++;
        filtersLoaded.current = true;
        const restoredFilters = normalizeQueueFilters(next.filters);
        pendingFilters.current = restoredFilters;
        holdForFilters();
        setFilters(restoredFilters);
      }
      const version = filterVersion.current;
      setSavedView(next.savedView);
      setSavedQuery(next.savedQuery);
      setMutedOpen(next.muted);
      setOpenedItem(next.item);
      setSelected(next.selected);
      setOverviewTab(next.tab);
      queueScrollOffset.current = next.scroll;
      if (queueScrollElement) queueScrollElement.scrollTop = next.scroll;
      // Restore the active saved view through the local store, in the same write queue as filters.
      if (viewChanged) {
        void enqueueWrite(() => window.electronAPI.workbenchViewAction({ type: 'activate', id: viewId }))
          .catch((error: unknown) => { if (version === filterVersion.current) setError(`Could not restore saved view: ${String(error)}`); });
      }
      return;
    }
    const location: HomeLocation = {
      account: auth?.login ?? 'local', filters, savedView, savedQuery,
      viewId: queue.savedViews?.activeId ?? null, viewName: originName, muted: mutedOpen, item: openedItem,
      tab: overviewTab, selected, scroll: queueScrollOffset.current,
    };
    historyLocation.current = location;
    onNavigationChange?.(location, mutedUrls);
  });
  useEffect(() => { summaryNavigation.current++; }, [openedItem?.subject.id, savedView, commandDestination]);
  const summaryIndex = summaryChoices.findIndex(choice => choice.value === (summaryItem?.parentStack?.id ?? summaryItem?.subject.id));
  const selectScope = (id: string) => {
    if (!summaryItem) return;
    const stack = summaryItem.subject.kind === 'stack' ? summaryItem.subject : summaryItem.parentStack;
    if (!stack) return;
    const parent = workspaceItems.find(item => item.subject.id === stack.id) ?? { subject: stack, attention: 'other' as const };
    const member = parent.subject.members.find(member => member.url === id);
    if (id !== stack.id && !member) return;
    setOpenedItem(id === stack.id ? parent : focusStackPr(parent, member!));
    setSelected(stack.id);
  };
  const selectSummary = async (id: string) => {
    const version = ++summaryNavigation.current;
    setError('');
    if (savedView) {
      const entry = saved.find(entry => (entry.snapshot?.subject.id ?? entry.prUrl) === id);
      if (!entry) return;
      try {
        const review = await window.electronAPI.loadReview(entry.id);
        if (!alive.current || summaryNavigation.current !== version) return;
        if (review.prUrl.startsWith('local:')) { onReviewReady(review); return; }
        setSelected(id);
        setOpenedItem({ ...explanationItem(review), review: entry });
      } catch (e) { if (summaryNavigation.current === version) setError(String(e)); }
    } else {
      const item = orderedItems.find(item => item.subject.id === id);
      if (item) { setSelected(id); setOpenedItem(item); }
    }
  };
  const moveSummary = (direction: number) => {
    const next = summaryChoices[summaryIndex + direction];
    if (summaryIndex >= 0 && summaryIndex + direction >= 0 && summaryIndex + direction < summaryChoices.length) void selectSummary(next.value);
  };
  const openSettings = (next: SettingsSection = 'queue') => {
    setSettingsSection(next);
    setSettings(true);
  };
  useSettingsShortcut(() => openSettings());
  const dismissGettingStarted = async () => {
    setShowGettingStarted(false);
    try {
      const current = await window.electronAPI.loadPreferences();
      const next = { ...current, firstRunSeen: true };
      await window.electronAPI.savePreferences(next);
      setPrefs(next);
    } catch {
      setError('Could not save your getting-started preference. Try dismissing it again.');
    }
  };
  const openResponse = (item: QueueItem, intent: ResponseIntent = 'response') => {
    setError(''); setFeedbackRequest({ id: crypto.randomUUID(), subjectId: item.subject.id, intent });
    setOverviewTab('feedback'); setOpenedItem(item);
  };
  const activate = (item: QueueItem) => { if (filters.involvement === 'response') { const member = item.subject.members.find(member => matchingStackMembers(item, filters, auth?.login).includes(member.url) && needsResponse(item.responses?.[member.url])); openResponse(member ? focusStackPr(item, member) : item); } else { setError(''); setFeedbackRequest(undefined); setOpenedItem(item); } };
  const openPrUrl = async () => {
    setError('');
    setOpeningPr(true);
    try {
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
      if (!match) throw new Error('Enter a GitHub PR URL, such as https://github.com/owner/repo/pull/123.');
      const canonical = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
      const cached = workspaceItems.find((item) =>
        item.subject.members.some((m) => m.url.toLowerCase() === canonical.toLowerCase())
      );
      if (cached) {
        setOpenedItem(focusStackPr(cached, cached.subject.members.find(m => m.url.toLowerCase() === canonical.toLowerCase())!));
        setSelected(cached.subject.id);
      } else {
        const meta = await window.electronAPI.getPrMetadata(canonical);
        const repo = `${match[1]}/${match[2]}`;
        setOpenedItem({
          attention: 'other',
          subject: {
            id: canonical,
            kind: 'pr',
            scope: 'single',
            title: meta.title,
            edges: [],
            warnings: [],
            members: [
              {
                ...meta,
                number: Number(match[3]),
                repo,
                headRepo: meta.headRepo ?? repo,
                baseRepo: meta.baseRepo ?? repo,
                role: 'watched',
              },
            ],
          },
        });
      }
      setShowUrl(false);
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningPr(false);
    }
  };
  useEffect(() => {
    if (!commandDestination || !prefs || loading || handledCommand.current === commandDestination.nonce) return;
    if (commandDestination.destination.onboarding === 'setup' && !onboarding.ready) return;
    handledCommand.current = commandDestination.nonce;
    const target = commandDestination.destination;
    setMutedOpen(target.section === 'muted');
    setError('');
    if (target.subject) {
      setOpenedItem(target.subject);
      setSelected(target.subject.subject.id);
      return;
    }
    if (target.onboarding) {
      if (target.onboarding === 'setup') onboarding.start(); else onboarding.startTour();
      return;
    }
    if (target.settings) {
      openSettings(target.settings as SettingsSection);
      return;
    }
    if (target.local) {
      setLocalOpen(true);
      return;
    }
    setOpenedItem(null);
    if (target.viewId) {
      setSavedView(false);
      void viewAction({ type: 'activate', id: target.viewId }).catch(() => {});
      return;
    }
    if (target.repo) {
      setSavedView(false);
      updateFilters({ ...DEFAULT_QUEUE_FILTERS, sort: filters.sort, repo: target.repo });
      return;
    }
    if (target.section) {
      setMutedOpen(target.section === 'muted');
      setSavedView(target.section === 'saved');
      if (target.section !== 'saved' && target.section !== 'muted')
        updateFilters({
          involvement: target.section === 'response' ? 'response' : filters.involvement === 'response' ? 'all' : filters.involvement,
          starredOnly: target.section === 'starred',
          attention: target.section === 'updated' || target.section === 'requested' ? target.section : 'all',
          kind: target.section === 'stacks' ? 'stack' : 'all',
        });
    }
  }, [commandDestination, prefs, loading, onboarding.ready]);
  const commandItem = summaryItem ?? selectedItem;
  useCommandScope('home', [
    ...(commandItem && queue.items.some((item) => item.subject.id === commandItem.subject.id)
      ? [
          {
            id: 'context:briefing',
            icon: workbenchIcons.briefing,
            label: `Create briefing · ${commandItem.subject.title}`,
            group: 'Uses your briefing model · tracked in Activity',
            perform: async () => {
              await window.electronAPI.workbenchBriefing(commandItem.subject.id);
              await refresh();
            },
          },
        ]
      : []),
    ...(commandItem
      ? [
          {
            id: 'context:review',
            icon: workspaceSections.explanation.icon,
            label: `Generate AI review · ${commandItem.subject.title}`,
            group: 'Uses your selected model · tracked in Activity',
            perform: async () => {
              await start(
                commandItem.subject.members[0].url,
                [...queue.items, ...(queue.starredItems ?? [])].some((item) => item.subject.id === commandItem.subject.id)
                  ? commandItem.subject
                  : undefined,
                undefined,
                commandItem.subject.scope === 'single'
              );
            },
          },
        ]
      : []),
  ]);
  const selectQueueEntry = (id: string, modifiers?: SelectionModifiers) => {
    selection.select(id, modifiers);
    setSelected(id);
    if (!modifiers?.shiftKey && !modifiers?.metaKey && !modifiers?.ctrlKey) setStatuses({});
  };
  const moveSelection = (direction: number, modifiers?: SelectionModifiers) => {
    const index = orderedItems.findIndex((item) => item.subject.id === selected);
    const next = orderedItems.at(
      index < 0
        ? direction > 0
          ? 0
          : orderedItems.length - 1
        : Math.max(0, Math.min(orderedItems.length - 1, index + direction))
    );
    if (!next) return;
    pendingRowFocus.current = next.subject.id;
    selectQueueEntry(next.subject.id, modifiers);
    rowButtons.current.get(next.subject.id)?.focus({ preventScroll: true });
  };
  useKeyboardShortcuts(
    {
      '/': () => searchInput.current?.focus(),
      j: (e) => {
        if (!(e.target instanceof HTMLElement) || !e.target.closest('.activity-shell')) moveSelection(1);
      },
      k: (e) => {
        if (!(e.target instanceof HTMLElement) || !e.target.closest('.activity-shell')) moveSelection(-1);
      },
    },
    { enabled: !mutedOpen && !onboarding.open && !onboarding.tourOpen && !settings && !localOpen && !openedItem && !authOpen && !connectionRequired && section !== 'saved' }
  );
  const correct = async (action: 'link' | 'unlink', parent = parentUrl, child = childUrl) => {
    setGrouping(true);
    setError('');
    try {
      workbenchStore.apply(await window.electronAPI.workbenchGroup({ parent, child, action }));
      setParentUrl('');
      setChildUrl('');
    } catch (e) {
      setError(String(e));
    } finally {
      setGrouping(false);
    }
  };
  const generationActions: PrGenerationActionsFor = (members) => {
    const candidates = [...queue.items, ...(queue.starredItems ?? [])];
    const exact = candidates.find(item => item.subject.members.length === members.length &&
      item.subject.members.every(member => members.some(m => m.url === member.url)));
    // Briefings belong to queue entries. A member of a stack shares its stack briefing.
    const briefingItem = queue.items.find(item => item.subject.id === exact?.subject.id) ??
      (members.length === 1 ? queue.items.find(item => item.subject.members.some(m => m.url === members[0].url)) : undefined);
    const requestKey = exact?.subject.id ?? members[0]?.url;
    const explanationRunning = visibleHistory.some(entry => entry.status === 'generating' &&
      (exact ? matchesExplanation(entry, exact.subject) : entry.prUrl === members[0]?.url));
    return {
      onGenerateExplanation: () => start(members[0].url, exact?.subject, undefined, !exact && members.length === 1),
      explanationDisabled: !prefs || !members.length || pendingStarts.has(requestKey) || explanationRunning,
      onGenerateBriefing: async () => {
        if (!briefingItem) return;
        await window.electronAPI.workbenchBriefing(briefingItem.subject.id);
        await refresh();
      },
      briefingDisabled: !auth?.authenticated || !briefingItem || briefingItem.briefing?.status === 'generating',
      stackBriefing: members.length === 1 && (briefingItem?.subject.members.length ?? 0) > 1,
    };
  };
  const requestPrReview = (member: QueueItem['subject']['members'][number]) => {
    const parent = [...queue.items, ...(queue.starredItems ?? []), ...(openedItem ? [openedItem] : [])]
      .find(item => item.subject.members.some(m => m.url === member.url));
    const item: QueueItem = parent ? focusStackPr(parent, member) : {
      attention: 'other',
      subject: { id: member.url, kind: 'pr', title: member.title, members: [member], edges: [], warnings: [] },
    };
    setSelected(item.subject.id);
    setOpenedItem(item);
    setOverviewTab('summary');
    setReviewRequest({ id: crypto.randomUUID(), member: { ...member } });
  };
  const entryActions = (members: QueueItem['subject']['members']) => ({
    members, starredUrls, busy: starBusy || muteBusy || readBusy || batchBusy,
    ...generationActions(members),
    unread: members.some(member => queue.readStates?.[member.url]?.unread.length),
    onReadChange: auth?.login && members.some(member => queue.readStates?.[member.url]) ? (read: boolean) => changeRead(members.map(member => member.url), read) : undefined,
    onReview: requestPrReview,
    reviewDisabled: !auth?.authenticated,
    onStarChange: changeStars,
    onMute: (members: QueueItem['subject']['members']) => changeMutes({ muted: true, members }),
    onRefresh: async () => {
      const results = await Promise.allSettled(members.map(async member => {
        const status = await window.electronAPI.getPrStatus(member.url, true);
        if (readAccount.current !== auth?.login) throw new Error('GitHub account changed. Select the PRs again.');
        cachedStatuses.current.set(`${auth?.login}:${member.url}@${member.headSha}`, status);
        if (auth?.login && status.signals) publishQueueSignals(auth.login, [status.signals]);
        setStatuses(previous => ({ ...previous, [member.url]: status }));
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  });
  const selectedMembers = [...new Map(selectedItems.flatMap(item => item.subject.members).map(member => [member.url, member])).values()];
  const selectionDescription = <>
    <div className="entry-menu-selection-title">
      <strong>{selectedItems.length} entries selected</strong>
      <span>{selectedMembers.length} PRs</span>
    </div>
    {selectedItems.some(item => item.subject.kind === 'stack') &&
      <p className="entry-menu-selection-note">Includes every PR in selected stacks.</p>}
  </>;
  const runBatch = async <T,>(targets: T[], run: (target: T) => Promise<unknown>, name: (target: T) => string, complete: string) => {
    if (batchRunning.current) return;
    batchRunning.current = true; setBatchBusy(true);
    const account = auth?.login;
    try {
      const result = await runSelectionTasks(targets, target => {
        if (readAccount.current !== account) throw new Error('GitHub account changed. Select the entries again.');
        return run(target);
      });
      toast.add({
        type: result.failed.length ? 'error' : 'success',
        title: `${result.succeeded.length} of ${targets.length} ${complete}`,
        description: result.failed.length
          ? `Could not complete: ${result.failed.slice(0, 3).map(failure => name(failure.target)).join(', ')}${result.failed.length > 3 ? ` and ${result.failed.length - 3} more` : ''}. Select those entries to retry.`
          : complete.includes('requested') ? 'Follow progress in Activity.' : undefined,
      });
    } finally { batchRunning.current = false; setBatchBusy(false); }
  };
  const selectionGroups = queueSelectionGroups({
    members: selectedMembers, starredUrls, readStates: queue.readStates ?? {},
    explanations: selectedItems.filter(item => !generationActions(item.subject.members).explanationDisabled),
    briefings: selectedItems.filter(item => !generationActions(item.subject.members).briefingDisabled),
    busy: batchBusy || readBusy || starBusy || muteBusy, authenticated: !!auth?.authenticated,
    onRead: changeRead, onStar: changeStars, onMute: members => changeMutes({ muted: true, members }),
    onRefresh: members => runBatch(members, member => entryActions([member]).onRefresh(), member => `#${member.number}`, 'PR statuses refreshed'),
    onExplain: targets => configureExplanations(
      targets.map(item => explanationRequest(item.subject.members[0].url, item.subject, undefined, item.subject.scope === 'single', false))
        .filter((request): request is GenerateReviewRequest => !!request)
    ),
    onBrief: targets => runBatch(targets, async item => {
      await window.electronAPI.workbenchBriefing(item.subject.id);
      await refresh();
    }, item => item.subject.title, 'briefings requested'),
  });
  const latestSaved = useRef({ open, start, entryActions, tabs });
  // Rows receive one stable action object. Each call reads this render's state.
  const latest = useRef({ selectQueueEntry, moveSelection, activate, openResponse, selection, setOpenedItem, setOverviewTab, entryActions, tabs });
  latest.current = { selectQueueEntry, moveSelection, activate, openResponse, selection, setOpenedItem, setOverviewTab, entryActions, tabs };
  const rowActions = useMemo<QueueRowActions>(() => ({
    select: (id, modifiers) => latest.current.selectQueueEntry(id, modifiers),
    move: (direction, modifiers) => latest.current.moveSelection(direction, modifiers),
    activate: item => latest.current.activate(item),
    openMember: (item, member, modifiers) => {
      if (modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey) { latest.current.selectQueueEntry(item.subject.id, modifiers); return; }
      setSelected(item.subject.id);
      latest.current.activate(focusStackPr(item, member));
    },
    openChecks: item => { setOpenedItem(item); setOverviewTab('checks'); },
    openResponse: (item, intent) => latest.current.openResponse(item, intent),
    toggleExpanded: id => setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
    selectAll: () => latest.current.selection.all(),
    toggleSelect: (id, modifiers) => latest.current.selection.select(id, modifiers),
    clearSelection: () => {
      if (!latest.current.selection.keys.size) return false;
      latest.current.selection.clear();
      return true;
    },
    contextSelect: id => latest.current.selection.context(id),
    menuGroups: item => {
      const { tabs: navigation, entryActions: actionsFor } = latest.current;
      return [
        ...(navigation ? [[{ label: 'Open in new tab', dismissBeforeRun: true, icon: <Plus size={15} />, run: () => navigation.open({ kind: 'home', subject: item }) }]] : []),
        ...prEntryActionGroups(actionsFor(item.subject.members)),
      ];
    },
    memberMenu: member => ({ ...latest.current.entryActions([member]), onBeforeOpen: () => latest.current.selection.clear() }),
    registerButton: (id, node) => {
      if (node) {
        rowButtons.current.set(id, node);
        if (pendingRowFocus.current === id) {
          pendingRowFocus.current = null;
          node.focus({ preventScroll: true });
        }
      } else rowButtons.current.delete(id);
    },
  }), []);
  // Inputs to menu content that are not row props. Changing them re-renders rows with open menus correct.
  const menuKey = JSON.stringify([starBusy, muteBusy, readBusy, batchBusy, auth?.authenticated, auth?.login, !!prefs, pendingStarts.size]);
  const readStates = queue.readStates ?? NO_READ_STATES;
  const fallbackTabStop = selected && itemIds.has(selected) ? undefined : orderedItems[0]?.subject.id;
  const bulkMenu = multiple ? { groups: selectionGroups, description: selectionDescription } : undefined;
  const row = useCallback((item: QueueItem) => {
    const id = item.subject.id, focused = selected === id;
    const active = selection.keys.size ? selection.keys.has(id) : focused;
    const bulk = multiple && active;
    return <QueueRow key={id} item={item} focused={focused} active={active} multiple={multiple} bulk={bulk}
      tabStop={focused || fallbackTabStop === id} expanded={expanded.has(id)} selectedCount={selectedItems.length}
      account={auth?.login ?? null} filters={filters} starredUrls={starredUrls} readStates={readStates}
      menuKey={menuKey} bulkMenu={bulk ? bulkMenu : undefined} actions={rowActions} />;
  // Selection keys are compared by content.
  }, [selected, selectionSignature, multiple, fallbackTabStop, expanded, selectedItems.length, auth?.login, filters, starredUrls, readStates, menuKey, bulkMenu, rowActions]);
  const sidebarCounts = useMemo(() => ({
    response: queue.items.filter(item => matchesQueueFilters(item, { ...DEFAULT_QUEUE_FILTERS, involvement: 'response' }, clock, login)).length,
    stacks: queue.items.filter(item => item.subject.kind === 'stack').length,
    updated: queue.items.filter(item => item.attention === 'updated').length,
    requested: queue.items.filter(item => item.attention === 'requested').length,
    other: queue.items.filter(item => item.attention === 'other').length,
  }), [queue.items, clock, login]);
  latestSaved.current = { open, start, entryActions, tabs };
  const savedActions = useMemo<SavedRowActions>(() => ({
    open: entry => void latestSaved.current.open(entry),
    retry: entry => void latestSaved.current.start(entry.prUrl),
    menuGroups: entry => {
      const { tabs: navigation, entryActions: actionsFor } = latestSaved.current;
      return [
        ...(navigation && entry.status === 'completed' ? [[{ label: 'Open in new tab', dismissBeforeRun: true, icon: <Plus size={15} />, run: () => navigation.open({ kind: 'review', reviewId: entry.id }) }]] : []),
        ...prEntryActionGroups(actionsFor(entry.snapshot?.subject.members ?? [])),
        [{ label: 'Export review', icon: <Download size={15} />, disabled: entry.status === 'generating',
          run: () => window.electronAPI.exportReview(entry.id) }],
        [{ label: 'Delete saved review', icon: <Trash2 size={15} />, destructive: true,
          disabled: entry.status === 'generating', run: async () => {
            if (confirm('Delete this saved review?')) {
              await window.electronAPI.deleteReview(entry.id);
              await workbenchStore.refresh({ history: true });
            }
          } }],
      ];
    },
  }), []);
  const savedRow = useCallback((entry: ReviewHistoryEntry) =>
    <SavedRow key={entry.id} entry={entry} starredUrls={starredUrls} menuKey={menuKey} actions={savedActions} />,
  [starredUrls, menuKey, savedActions]);
  const changeReadRef = useRef(changeRead);
  changeReadRef.current = changeRead;
  // Every unread marker reads this context; keep its identity until read state changes.
  const readContext = useMemo(() => ({
    states: readStates, busy: readBusy,
    change: (urls: string[], read: boolean, displayed?: ViewedPr[]) => changeReadRef.current(urls, read, displayed),
    viewed: (revisions: ViewedPr[]) => { const eligible = revisions.filter(pr => !readVisit.current.manual.has(pr.url)); void changeReadRef.current(eligible.map(pr => pr.url), true, eligible); },
  }), [readStates, readBusy]);
  const replayGettingStarted = () => {
    setSettings(false);
    onboarding.start();
  };
  const gettingStartedVisible =
    !loading &&
    !!prefs &&
    section === 'all' &&
    filterCount === 0 &&
    (showGettingStarted || (!prefs.firstRunSeen && history.length === 0));
  const githubConnection =
    !loading && section !== 'saved' && auth && !auth.authenticated ? (
      <section className="workbench-connect">
        <h2>Connect GitHub</h2>
        <p>Sign in to load your GitHub review requests. Local reviews work without a GitHub connection.</p>
        <Button size="sm" onClick={() => setAuthOpen(true)}>
          Sign in to GitHub
        </Button>
        <p>Use browser sign-in, a sign-in code, or a personal access token.</p>
      </section>
    ) : null;

  return (
    <PrReadContext.Provider value={readContext}>
    <div className="workbench-home">
      <header className="workbench-header">
        <a
          href="#"
          className="workbench-brand"
          onClick={(e) => {
            e.preventDefault();
            setOpenedItem(null);
            setSavedView(false);
            updateFilters({ attention: 'all', kind: 'all', involvement: filters.involvement === 'response' ? 'all' : filters.involvement });
          }}
        >
          Gnosis
        </a>
        <RecentlyViewed />
        <div className="workbench-header-controls ml-auto flex items-center gap-2">
          {prefs && (
            <ModelEffortSelect provider={prefs.provider} model={prefs.model}
              effort={normalizeEffort(prefs.provider, prefs.model, prefs.effort, prefs.thinking)}
              onChange={selection => { void savePrefs({ ...prefs, ...selection }); }} />
          )}
          <button
            className="workbench-command-trigger"
            onClick={() => commandCenter?.open()}
            title="Search and navigate (⌘K / Ctrl K)"
          >
            <Search size={15} />
            <span>Search</span>
            <kbd className="kbd">{window.electronAPI.platform === 'darwin' ? '⌘ K' : 'Ctrl K'}</kbd>
          </button>
          <WorkbenchHelp onGettingStarted={replayGettingStarted} onWalkthrough={() => onboarding.startTour()} />
          <button className="workbench-icon" title={window.electronAPI.platform === 'darwin' ? 'Settings (⌘,)' : 'Settings (Ctrl+,)'} aria-label="Settings" onClick={() => openSettings()}>
            <Settings size={17} />
          </button>
          <button
            className="workbench-help-trigger"
            aria-label={auth?.login ? `GitHub account: ${auth.login}` : 'Connect GitHub'}
            data-github-account
            title={auth?.login ? `GitHub: ${auth.login}` : 'Connect GitHub'}
            onClick={() => setAuthOpen(true)}
          >
            <GitHubIcon width={16} height={16} />
            <span className="account-name">{auth?.login ?? 'Connect GitHub'}</span>
          </button>
        </div>
      </header>
      <UpdateBanner />
      {summaryItem && (
        <Suspense fallback={<LoadingState title="Opening pull request…" />}>
        <PrSummary
        key={summaryItem.subject.id}
        item={summaryItem}
        feedbackRequest={feedbackRequest?.subjectId === summaryItem.subject.id ? feedbackRequest : undefined}
        matchingUrls={matchingStackMembers(summaryItem, filters, auth?.login)}
        onScopeChange={selectScope}
        onRenameStack={async name => {
          const next = await enqueueWrite(() => window.electronAPI.workbenchRenameStack(summaryItem.subject.id, name, auth?.login ?? undefined));
          if (alive.current && readAccount.current === auth?.login) {
            workbenchStore.apply(next);
            setOpenedItem(current => current ? resolveWorkspace(current, [...next.items, ...(next.starredItems ?? []), ...(next.stacks ?? []).map(subject => ({ subject, attention: 'other' as const }))]) : current);
          }
        }}
        onQueue={() => {
          summaryNavigation.current++; setOverviewTab('summary'); setOpenedItem(null);
          requestAnimationFrame(() => rowButtons.current.get(selected ?? '')?.focus({ preventScroll: true }));
        }}
        generationActions={generationActions}
        onReview={requestPrReview}
        reviewRequest={reviewRequest}
        onReviewRequestHandled={() => setReviewRequest(undefined)}
        starredUrls={starredUrls}
        starBusy={starBusy}
        starError={muteError || starError}
        muteBusy={muteBusy}
        onMute={members => void changeMutes({ muted: true, members })}
        onStarChange={(members, value) => void changeStars(members, value)}
        account={auth?.login ?? null}
        statusRefreshing={statusRefreshing}
        tab={overviewTab}
        onTabChange={setOverviewTab}
        preferences={prefs}
        positions={readingPositions.current}
        explanationDestination={explanationDestination}
        explanations={visibleHistory.filter(entry => matchesExplanation(entry, summaryItem.subject))}
        onShowActivity={onShowActivity ?? (() => {})}
        shortcutsEnabled={!explanationSetup && !settings && !localOpen && !authOpen && !connectionRequired && !onboarding.open && !onboarding.tourOpen}
          navigation={{
            index: summaryIndex,
            total: summaryChoices.length,
            viewName: originName,
            choices: summaryChoices,
            select: id => void selectSummary(id),
            previous: summaryIndex > 0 ? summaryChoices[summaryIndex - 1].label : undefined,
            next: summaryIndex >= 0 ? summaryChoices[summaryIndex + 1]?.label : undefined,
            move: moveSummary,
          }}
        starting={pendingStarts.has(summaryItem.subject.id)}
        error={summaryErrors[summaryItem.subject.id] || error}
        statuses={statuses}
        statusErrors={statusErrors}
        onBack={() => {
          if (summaryItem.parentStack) { selectScope(summaryItem.parentStack.id); return; }
          summaryNavigation.current++;
          setOverviewTab('summary');
          setOpenedItem(null);
          requestAnimationFrame(() => rowButtons.current.get(selected ?? '')?.focus({ preventScroll: true }));
        }}
          onGenerate={previousReviewId =>
            void start(
              summaryItem.subject.members[0].url,
              summaryItem.subject,
              undefined,
              summaryItem.subject.scope === 'single',
              previousReviewId
            )
          }
        onRetryStatus={() => { if (!statusRefreshing) setStatusAttempt((n) => n + 1); }}
        onAiSetup={() => openSettings('integrations')}
        onGitHubAuth={() => setAuthOpen(true)}
        />
        </Suspense>
      )}
      {/* The queue stays mounted behind a PR, so returning keeps its rows, scroll and focus target. */}
      <Activity mode={summaryItem ? 'hidden' : 'visible'}>
        <div className="workbench-body">
        <QueueSidebar
          currentReview={
            !mutedOpen && (savedView || !activeQueueView)
              ? section === 'saved'
                ? 'Saved reviews'
                : section === 'all'
                  ? 'Review queue'
                  : section === 'response'
                    ? 'Needs my response'
                    : section === 'stacks'
                      ? 'Stacks'
                      : labels[section]
              : undefined
          }
          currentView={!savedView && !mutedOpen ? activeQueueView?.name : undefined}
          currentTool={mutedOpen ? 'Muted PRs' : undefined}
          reviews={
            <>
              {[
                ['all', 'Review queue', Inbox],
                ['starred', 'Starred', Star],
                ['requested', 'Review requests', GitPullRequest],
                ['response', 'Needs my response', workspaceSections.feedback.icon],
                ['updated', 'Updated PRs', RefreshCw],
                ['stacks', 'Stacks', Layers],
                ['saved', 'Saved reviews', workbenchIcons.history],
              ].map(([id, label, Icon]) => {
                const I = Icon as typeof Inbox;
                return (
                  <SidebarDestination key={id as string} destination={{kind:'home',section:id as Extract<SearchDestination,{kind:'home'}>['section']}}>
                    <button
                      data-sidebar-group-start={id === 'stacks' || undefined}
                      data-sidebar-destination
                      aria-label={label as string}
                      data-tour={id === 'all' ? 'queue-fallback' : undefined}
                      title={
                        id === 'stacks'
                          ? 'Stacks of PRs that build on each other'
                          : id === 'requested'
                            ? 'Your review requests; changes since a saved AI explanation appear under Updated PRs'
                            : id === 'updated'
                              ? 'PR content or stack changes since a saved AI explanation'
                              : (label as string)
                      }
                      aria-current={!mutedOpen && section === id && (id === 'saved' || !activeQueueView) ? 'page' : undefined}
                      className={!mutedOpen && section === id && (id === 'saved' || !activeQueueView) ? 'active' : ''}
                      disabled={viewBusy}
                      onClick={() => {
                        setMutedOpen(false);
                        setSavedView(id === 'saved');
                        if (id !== 'saved') {
                          const patch: Partial<QueueFilters> = {
                            starredOnly: id === 'starred',
                            attention:
                              id === 'stacks' || id === 'starred' || id === 'response'
                                ? 'all'
                                : (id as QueueFilters['attention']),
                            involvement:
                              id === 'response' ? 'response' : filters.involvement === 'response' ? 'all' : filters.involvement,
                            kind: id === 'stacks' ? 'stack' : 'all',
                          };
                          if (activeQueueView) void viewAction({ type: 'activate', id: null, filters: patch }).catch(() => {});
                          else updateFilters(patch);
                        }
                        setSelected(null);
                      }}
                    >
                      <I size={16} aria-hidden="true" />
                      <span className="sidebar-label">{label as string}</span>
                      <span className="nav-count">
                        {id === 'saved'
                          ? visibleHistory.length
                          : id === 'starred'
                            ? (queue.starredItems?.length ?? 0)
                            : id === 'response'
                              ? sidebarCounts.response
                              : id === 'all'
                                ? queue.items.length
                                : id === 'stacks'
                                  ? sidebarCounts.stacks
                                  : sidebarCounts[id as QueueItem['attention']]}
                      </span>
                    </button>
                  </SidebarDestination>
                );
              })}
            </>
          }
          views={
            auth?.authenticated && queue.savedViews ? (
              <div data-tour="queue">
                <SavedViewsNav
                  heading={false}
                  state={queue.savedViews}
                  active={!savedView && !mutedOpen}
                  busy={viewBusy}
                  onAction={viewAction}
                />
              </div>
            ) : undefined
          }
          tools={
            <>
              <SidebarDestination>
                <button
                  data-sidebar-destination
                  aria-label="Muted PRs"
                  title="Muted PRs"
                  className={mutedOpen ? 'active' : ''}
                  aria-current={mutedOpen ? 'page' : undefined}
                  onClick={() => {
                    setMutedOpen(true);
                    setSelected(null);
                    setOpenedItem(null);
                    setError('');
                  }}
                >
                  <VolumeX size={16} />
                  <span className="sidebar-label">Muted PRs</span>
                  <span className="nav-count">{queue.mutedPrs?.length ?? 0}</span>
                </button>
              </SidebarDestination>
              <SidebarDestination>
                <button
                  data-sidebar-destination
                  aria-label="Local changes"
                  data-tour="local"
                  title="Local changes"
                  onClick={() => setLocalOpen(true)}
                >
                  <FolderGit2 size={16} />
                  <span className="sidebar-label">Local changes</span>
                </button>
              </SidebarDestination>
              <SidebarDestination>
                <button
                  data-sidebar-destination
                  aria-label="Import review"
                  title="Import review"
                  onClick={() =>
                    void window.electronAPI
                      .importReview()
                      .then((entry) => {
                        if (entry) void open(entry);
                        void refresh();
                      })
                      .catch((e: unknown) => setError(String(e)))
                  }
                >
                  <Upload size={16} />
                  <span className="sidebar-label">Import review</span>
                </button>
              </SidebarDestination>
            </>
          }
        />
        <main className="workbench-main">
          {mutedOpen ? <MutedPrs entries={queue.mutedPrs ?? []} busy={muteBusy} error={muteError} onUnmute={members => void changeMutes({ muted: false, urls: members.map(member => member.url) })} /> : <>
          <div className="queue-toolbar">
            <div>
              <h1>
                {section === 'saved'
                  ? 'Saved reviews'
                  : activeQueueView
                    ? activeQueueView.name
                    : section === 'all'
                      ? 'Review queue'
                      : section === 'stacks'
                        ? 'Stacks'
                        : section === 'response' ? 'Needs my response' : labels[section]}
              </h1>
              {section !== 'all' && (
                <p>
                  {section === 'saved'
                    ? 'Saved AI explanations, ready to resume.'
                    : section === 'response' ? 'Your PRs with changes requested or unresolved feedback from others.'
                    : section === 'starred' ? 'Your starred PRs, saved on this computer. Stacks stay together.'
                    : section === 'stacks'
                      ? 'PRs that build on each other.'
                      : section === 'requested'
                        ? 'Your review requests. Changed PRs appear under Updated PRs.'
                        : 'PR content or stack changes since your saved AI explanation.'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="workbench-icon"
                aria-label="Refresh queue"
                title="Update the queue from GitHub. Follow progress in Activity."
                disabled={refreshing}
                onClick={() => void refresh(true)}
              >
                <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              </button>
              <Button size="sm" onClick={() => setShowUrl((v) => !v)}>
                Open PR <ArrowRight size={14} />
              </Button>
            </div>
          </div>
          {showUrl && (
            <form
              className="queue-url"
              onSubmit={(e) => {
                e.preventDefault();
                void openPrUrl();
              }}
            >
              <label className="queue-url-field">
                GitHub pull request URL
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/pull/123"
                  aria-label="Pull request URL"
                />
              </label>
              <Button size="sm" disabled={openingPr || !url.trim()} type="submit">
                {openingPr ? <LoadingIndicator>Opening…</LoadingIndicator> : 'Open PR overview'}
              </Button>
              <button
                type="button"
                className="workbench-icon"
                aria-label="Close URL field"
                onClick={() => setShowUrl(false)}
              >
                <X size={16} />
              </button>
            </form>
          )}
          {error && (
            <div className="workbench-notice error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
                {/GitHub.*(?:access|sign.in)|token|Resource not accessible/i.test(error) && (
                  <button onClick={() => setAuthOpen(true)}>Check GitHub access</button>
                )}
              {initializationFailed ? (
                <button disabled={initializing} onClick={() => void initialize()}>
                  {initializing ? 'Loading account and settings…' : 'Retry loading Gnosis'}
                </button>
              ) : (
                <button aria-label="Dismiss error" onClick={() => setError('')}>
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div className="queue-filters">
            <label className="queue-search">
              <Search size={15} />
              <input
                ref={searchInput}
                aria-label={section === 'saved' ? 'Search saved reviews' : 'Search PRs and stacks'}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'Enter') {
                    e.preventDefault();
                    const first = orderedItems.at(0);
                    if (first) {
                      pendingRowFocus.current = first.subject.id;
                      setSelected(first.subject.id);
                      rowButtons.current.get(first.subject.id)?.focus();
                    }
                  } else if (e.key === 'Escape') {
                    setQuery('');
                    searchInput.current?.blur();
                  }
                }}
                placeholder={section === 'saved' ? 'Search saved reviews…' : 'Title, #number, author, or repo…'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {section !== 'saved' && (
              <SearchableSelect
                label="Filter repository"
                repositoryOptions
                value={repo}
                onValueChange={setRepo}
                options={[{ value: 'all', label: 'All repositories' }, ...repos.map(r => ({ value: r, label: r }))]}
              />
            )}
            {section !== 'saved' && (
              <Popover.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
                <Popover.Trigger asChild>
                  <button className="queue-filter-toggle">
                    <SlidersHorizontal size={14} /> Filters{filterCount ? ` (${filterCount})` : ''}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    // Activity detaches refs while hidden, so keep the last element.
                    ref={element => { if (element) filterPopover.current = element; }}
                    className="queue-filter-popover"
                    data-combobox-container="inside"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                    aria-label="Queue filters"
                    onEscapeKeyDown={event => {
                      if (event.target instanceof Element && event.target.closest('[data-slot="combobox-content"]'))
                        event.preventDefault();
                    }}
                  >
                    <div className="queue-filter-heading">
                      <strong>Filter PRs and stacks</strong>
                      <Popover.Close className="workbench-icon" aria-label="Close filters">
                        <X size={16} />
                      </Popover.Close>
                    </div>
                    <QueueFilterPanel filters={filters} items={queueItems} onChange={updateFilters} prInactivityDays={prefs?.prInactivityDays} hasRepositoryOverrides={Object.values(prefs?.repositorySettings ?? {}).some(s => s.prInactivityDays !== undefined)} onManageInactivity={() => { setFiltersOpen(false); openSettings('queue'); }} />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
            <PrListSortControl value={section === 'saved' ? savedSort : filters.sort} onChange={changeSort} savedReviews={section === 'saved'} disabled={viewBusy} />
            {section !== 'saved' && auth?.authenticated && (
              <EntryActions label="Review queue actions" groups={[[{
                label: 'Mark visible PRs as read',
                disabled: readBusy || !items.some(item => item.unreadUrls?.length),
                run: () => changeRead([...new Set(items.flatMap(item => item.subject.members
                  .filter(member => matchesQueueFilters({ ...item, subject: { ...item.subject, members: [member] } }, filters, Date.now(), auth.login))
                  .map(member => member.url)))], true),
              }]]} />
            )}
            {section !== 'saved' && auth?.authenticated && queue.savedViews && (
              <SaveViewControls view={activeQueueView} filters={filters} busy={viewBusy} onAction={viewAction} />
            )}
            {multiple && section !== 'saved' ? <div className="queue-selection-summary">
              <span role="status">{selectedItems.length} selected</span>
              <EntryActions label="Selected entry actions" groups={selectionGroups} description={selectionDescription} />
              <button type="button" className="workbench-icon" aria-label="Clear entry selection" title="Clear selection · Escape"
                onClick={() => { selection.clear(); rowButtons.current.get(selected ?? '')?.focus({ preventScroll: true }); }}><X size={15} /></button>
            </div> : <span
              className="queue-count"
              aria-live="polite"
                title={
                  section === 'saved'
                ? 'AI explanations saved on this computer'
                    : 'Each stack counts as one item. Counts use loaded GitHub data; built-in sidebar totals do not apply your other filters.'
                }
            >
              {section === 'saved' ? `${saved.length} reviews` : `${items.length} of ${queueItems.length} items`}
            </span>}
          </div>
          {section !== 'saved' && filterCount > 0 && (
            <div className="queue-active-filters">
              {describeQueueFilters(filters).map(({ key, label }) => (
                <button
                  key={key}
                  className="queue-filter-chip"
                  aria-label={`Remove ${label} filter`}
                  onClick={() => updateFilters({ [key]: DEFAULT_QUEUE_FILTERS[key] })}
                >
                  {label}
                  <X size={12} />
                </button>
              ))}
              <button onClick={resetFilters}>Clear filters</button>
            </div>
          )}
          {section !== 'saved' && filters.involvement === 'response' && auth?.login && <ResponseFilterStatus account={auth.login} members={responseMembers} incomplete={responseIncomplete} onUpdated={refreshResponseQueue} onUnavailableChange={setResponseUnavailable} />}
          {section !== 'saved' && (
            <p className="sr-only" id="queue-keyboard-help">
                <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> select · <kbd>Enter</kbd> open · <kbd>/</kbd>{' '}
                search · Shift-click or Shift+arrows select a range · Command/Control-click titles opens tabs; click row backgrounds to toggle selection · Command/Control+A selects all · Escape clears selection
            </p>
          )}
          <div className="queue-content">
              <section
                className="queue-list"
                aria-label="Review queue"
                ref={attachQueueScroll}
                onScroll={(event) => {
                  if (!attachedQueue.current) return;
                  queueScrollOffset.current = event.currentTarget.scrollTop;
                  if (historyLocation.current) {
                    historyLocation.current = { ...historyLocation.current, scroll: event.currentTarget.scrollTop };
                    onNavigationChange?.(historyLocation.current);
                  }
                }}
              >
              {onboarding.error && !onboarding.open && <p role="alert" className="setup-error">{onboarding.error}</p>}
              {onboarding.state.paused && !onboarding.open && !onboarding.state.completed && <div className="setup-resume"><span>Finish setting up your review queue.</span><Button size="sm" variant="outline" onClick={onboarding.start}>Resume setup</Button></div>}
              {onboarding.offerTour && <div className="setup-resume"><span>Your setup is ready. Take a quick look around.</span><Button size="sm" onClick={onboarding.startTour}>Show walkthrough</Button><Button size="sm" variant="ghost" onClick={() => onboarding.setOfferTour(false)}>Not now</Button></div>}
              {!gettingStartedVisible && githubConnection}
              {gettingStartedVisible && (
                <GettingStarted
                  provider={prefs.provider}
                  focusOnMount={showGettingStarted}
                  settingsOpen={settings}
                  githubConnection={githubConnection}
                  githubLogin={auth?.authenticated ? auth.login : null}
                  hasQueueItems={queue.items.length > 0}
                  onSettings={() => openSettings('integrations')}
                  onRepositories={() => openSettings('repositories')}
                  onOpenPr={() => setShowUrl(true)}
                  onLocal={() => setLocalOpen(true)}
                  onDismiss={() => void dismissGettingStarted()}
                />
              )}
              {loading ? (
                <LoadingState title="Loading review queue…" />
              ) : section === 'saved' ? (
                saved.length ? (
                  <VirtualSavedReviews entries={saved} scrollElement={queueScrollElement} renderRow={savedRow} />
                ) : (
                  <div className="queue-empty" role={filters.involvement === 'response' ? 'status' : undefined}>
                    <WorkbenchIcon name="history" size={24} />
                    <h2>{query ? 'No matching saved reviews' : 'No saved reviews yet'}</h2>
                    <p>
                      {query
                        ? 'Try another title or clear the search.'
                        : 'Guided reviews are saved on this computer so you can return to them.'}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => (query ? setQuery('') : setShowUrl(true))}>
                      {query ? 'Clear search' : 'Open a pull request'}
                    </Button>
                  </div>
                )
              ) : items.length ? (
                  <VirtualReviewQueue
                    items={orderedItems}
                    grouped={filters.sort.key === 'priority'}
                    starredFirst={filters.sort.starredFirst}
                    labels={labels}
                    selected={selected}
                    scrollElement={queueScrollElement}
                    onVisibleItemsChange={updateVisibleQueueIds}
                    onIntent={onQueueIntent}
                    measurements={queueMeasurements}
                    initialOffset={queueScrollOffset.current}
                    renderRow={row}
                  />
              ) : gettingStartedVisible && !queueFailed ? null : (
                <div className="queue-empty" role={filters.involvement === 'response' ? 'status' : undefined}>
                  <Inbox size={24} />
                  <h2>
                    {initializationFailed ? 'Gnosis could not finish starting' : section === 'starred' && !queue.starredPrs?.length ? 'No starred PRs yet' : queueFailed
                      ? 'Queue could not be loaded'
                      : filters.involvement === 'response' ? (responseIncomplete > 0 || responseUnavailable > 0 ? 'Feedback is not fully checked' : 'No PRs need your response in this view') : filterCount > 0
                        ? 'No PRs match these filters'
                        : !auth?.authenticated
                          ? 'Your GitHub queue is not connected'
                          : section !== 'all'
                            ? 'No PRs in this view'
                            : 'No pull requests in your queue'}
                  </h2>
                  <p>
                    {initializationFailed ? 'Your account and settings could not be read. Retry loading them to restore your review queue.' : section === 'starred' && !queue.starredPrs?.length ? 'Star a PR from the review queue or its overview to keep it here and pin it above other PRs.' : queueFailed
                      ? 'Try loading the queue again. You can still open a PR by URL or a saved review.'
                      : filters.involvement === 'response' ? (responseIncomplete > 0 || responseUnavailable > 0 ? 'Showing known matches. More may appear when the remaining PRs are checked.' : 'The checked PRs have no changes requested or unresolved feedback from others.') : filterCount > 0
                        ? 'Try fewer filters or a wider date range. One open PR must match every filter; its whole stack stays visible.'
                        : !auth?.authenticated
                          ? prefs?.guestMode
                            ? 'You are using local mode. Review a repository on this computer.'
                            : 'Connect GitHub above, or review local changes from the sidebar.'
                          : section !== 'all'
                            ? 'Try the full review queue to see other changes.'
                            : normalizePrInactivityDays(prefs?.prInactivityDays)
                              ? 'No PRs match your filters and repository inactivity settings. Starred PRs are included. Adjust Settings, or open a PR by URL.'
                              : 'Open a pull request by URL, or add repositories to follow in Settings. Dependabot PRs are hidden by default.'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={initializationFailed && initializing}
                    onClick={() => {
                      if (initializationFailed) void initialize();
                      else if (queueFailed) void refresh(true);
                      else if (filterCount > 0) {
                        resetFilters();
                      } else if (section !== 'all') resetFilters();
                      else if (!auth?.authenticated) setLocalOpen(true);
                      else openSettings();
                    }}
                  >
                    {initializationFailed ? 'Retry loading account and settings' : queueFailed
                      ? 'Retry queue'
                      : filters.involvement === 'response' ? 'Back to review queue' : filterCount > 0
                        ? 'Clear filters'
                        : section !== 'all'
                          ? 'Show review queue'
                          : !auth?.authenticated
                            ? 'Review local changes'
                            : 'Queue settings'}
                  </Button>
                </div>
              )}
              {queue.warnings.length > 0 && (
                <details className="queue-warnings">
                  <summary>
                    <AlertCircle size={14} />
                    Your queue may be incomplete ({queue.warnings.length})
                  </summary>
                  {queue.warnings.map((w, i) => (
                    <p key={i}>{w}</p>
                  ))}
                </details>
              )}
            </section>
            {selectedItem && items.some((i) => i.subject.id === selected) && section !== 'saved' && (
              <aside className="briefing-panel" aria-label="Change briefing">
                <div className="briefing-top">
                  <h2><SubjectIcon kind={selectedItem.subject.kind === 'stack' ? 'stack' : 'pr'} />{selectedItem.subject.title}</h2>
                  <button className="workbench-icon" aria-label="Close briefing" onClick={() => setSelected(null)}>
                    <X size={16} />
                  </button>
                </div>
                <div className="briefing-actions">
                    <Button size="sm" onClick={() => activate(selectedItem)}>
                    {selectedItem.subject.kind === 'stack' ? 'Open stack overview' : 'Open PR overview'}
                    <ArrowRight size={14} />
                  </Button>
                    {selectedItem.review?.status === 'completed' && (
                      <button
                        onClick={() => {
                          if (selectedItem.review) void open(selectedItem.review);
                        }}
                      >
                        {selectedItem.review.snapshot?.fingerprint !== fingerprint(selectedItem.subject)
                          ? 'Open previous explanation'
                          : 'Open AI explanation'}
                      </button>
                    )}
                </div>
                {fallbackReview && (savedSummary?.id === fallbackReview.id || fallbackReview.summary) && (
                  <section className="saved-briefing" aria-label="Saved review summary">
                    <h3>From saved review</h3>
                    <p className="text-xs text-muted-foreground">
                      Saved {timeAgo(fallbackReview.savedAt)} ·{' '}
                      {fallbackReview.snapshot
                        ? fallbackReview.snapshot.fingerprint === fingerprint(selectedItem.subject)
                          ? 'Matches the last queue update; latest changes are not verified.'
                          : 'The queue has changed since this review.'
                        : 'Could not check whether this explanation includes the latest changes.'}
                    </p>
                    <Markdown className="briefing-summary">
                      {savedSummary?.id === fallbackReview.id ? savedSummary.summary : (fallbackReview.summary ?? '')}
                    </Markdown>
                    {savedSummary?.id === fallbackReview.id && savedSummary.focus && (
                      <>
                        <h3>Where to focus</h3>
                        <Markdown className="briefing-summary">{savedSummary.focus}</Markdown>
                      </>
                    )}
                  </section>
                )}
                {selectedItem.briefing?.status === 'ready' ? (
                  <>
                    <Markdown className="briefing-summary">{selectedItem.briefing.summary ?? ''}</Markdown>
                    {!!selectedItem.briefing.systems?.length && (
                      <>
                        <h3>Affected systems</h3>
                        <div className="briefing-tags">
                          {selectedItem.briefing.systems.map((s) => (
                            <span key={s}>{s}</span>
                          ))}
                        </div>
                      </>
                    )}
                    {!!selectedItem.briefing.priorities?.length && (
                      <>
                        <h3>Where to focus</h3>
                        <ul>
                          {selectedItem.briefing.priorities.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <div className="briefing-status">
                    <p>
                      {selectedItem.briefing?.status === 'generating'
                        ? 'Generating briefing…'
                        : selectedItem.briefing?.status === 'failed'
                          ? 'Briefing failed.'
                          : selectedItem.briefing?.status === 'cancelled'
                            ? 'Briefing cancelled. Retry it from Activity.'
                            : selectedItem.briefing?.status === 'paused'
                              ? selectedItem.briefing.pauseReason === 'filter'
                                ? 'Automatic briefing paused: outside your current filters.'
                                : selectedItem.briefing.pauseDetail ?? 'Briefing is paused. Check Activity or briefing settings for details.'
                              : selectedItem.briefing?.status === 'queued' ? 'Briefing queued.' : 'No briefing yet.'}
                    </p>
                    {selectedItem.briefing?.status === 'failed' && selectedItem.briefing.error && (
                      <details className="status-diagnostics">
                        <summary>Technical details</summary>
                        <p>{selectedItem.briefing.error}</p>
                      </details>
                    )}
                    {selectedItem.briefing?.status === 'paused' && (
                      <button onClick={() => openSettings()}>Manage briefings</button>
                    )}
                    {selectedItem.briefing?.status === 'failed' && (
                      <button
                        onClick={() =>
                          void window.electronAPI
                            .workbenchBriefing(selectedItem.subject.id)
                            .then(next => workbenchStore.apply(next))
                            .catch((e: unknown) => setError(String(e)))
                        }
                      >
                        Retry briefing
                      </button>
                    )}
                  </div>
                )}
                {briefingSelection && (
                  <p className="briefing-model" aria-label="Briefing model">
                    Briefing model: {briefingModelLabel}
                  </p>
                )}
                <h3>{selectedItem.subject.kind === 'stack' ? 'PRs in this stack' : 'Pull request'}</h3>
                <div className="stack-members">
                  {selectedItem.subject.members.map((m, i) => (
                    <div key={m.url} className="stack-member">
                      <span className="stack-step">{i + 1}</span>
                      <div>
                        <a
                          href={m.url}
                          onClick={(e) => {
                            e.preventDefault();
                            void window.electronAPI.openExternal(m.url);
                          }}
                        >
                          <SubjectIcon kind="pr" />#{m.number} {m.title}
                        </a>
                        <PrLabels members={[m]} />
                        <p>
                          {m.merged ? 'Merged' : m.isDraft ? 'Draft' : m.state} ·{' '}
                          {statuses[m.url]
                            ? `CI ${statuses[m.url]?.ciConclusion} · ${statuses[m.url]?.reviewSummary.approved} approvals`
                            : statusErrors[m.url]
                              ? 'Status unavailable'
                              : <LoadingIndicator>Loading status…</LoadingIndicator>}
                        </p>
                        {selectedItem.subject.edges
                          .filter((edge) => edge.child === m.url)
                          .map((edge) => (
                            <p key={edge.parent} className="stack-dependency">
                              Builds on{' '}
                              <a
                                href={edge.parent}
                                onClick={(event) => {
                                  event.preventDefault();
                                  void window.electronAPI.openExternal(edge.parent);
                                }}
                              >
                                #{edge.parent.split('/').at(-1)}
                              </a>
                            </p>
                          ))}
                        {statusErrors[m.url] && (
                          <div className="member-status-error" role="status">
                            <p>{githubFailureMessage(statusErrors[m.url])}</p>
                            <button onClick={() => setStatusAttempt((n) => n + 1)}>Retry status</button>
                            <details className="status-diagnostics">
                              <summary>Technical details</summary>
                              <p>{statusErrors[m.url]}</p>
                            </details>
                          </div>
                        )}
                        {selectedItem.subject.kind === 'stack' && (
                            <button
                              onClick={() => {
                            setError('');
                                setOpenedItem(focusStackPr(selectedItem, m));
                              }}
                            >
                            Open this PR
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {selectedItem.subject.warnings.map((w) => (
                  <p className="workbench-notice" key={w}>
                    {w}
                  </p>
                ))}
                <details className="grouping-controls">
                  <summary>
                    <Link2 size={14} />
                    Correct stack grouping
                  </summary>
                  <p>
                      A parent PR contains work that another PR builds on. Choose the dependent PR and paste its
                      parent’s full GitHub URL.
                  </p>
                  <input
                    aria-label="Parent PR URL"
                    placeholder="Parent PR URL"
                    value={parentUrl}
                    onChange={(e) => setParentUrl(e.target.value)}
                  />
                  <SearchableSelect label="Dependent PR" value={childUrl} onValueChange={setChildUrl}
                    placeholder="Choose dependent PR"
                    options={selectedItem.subject.members.map(m => ({ value: m.url, kind: 'pr' as const, label: `#${m.number} ${m.title}` }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={grouping || !parentUrl || !childUrl}
                    onClick={() => void correct('link')}
                  >
                    Link parent
                  </Button>
                  {selectedItem.subject.edges.map((e) => (
                      <button
                        key={e.child}
                        disabled={grouping}
                        onClick={() => void correct('unlink', e.parent, e.child)}
                      >
                      Separate #{e.child.split('/').at(-1)} from #{e.parent.split('/').at(-1)}
                    </button>
                  ))}
                </details>
              </aside>
            )}
          </div>
          {prefs && (
            <footer className="workbench-footer">
              <label>
                <input
                  type="checkbox"
                  checked={prefs.autoBriefings !== false}
                  onChange={(e) => void savePrefs({ ...prefs, autoBriefings: e.target.checked })}
                />
                Automatic briefings by default
              </label>
              {(prefs.autoBriefings !== false || Object.values(prefs.repositorySettings ?? {}).some(s => s.autoBriefings)) && (
                <span>
                  {filters.briefingScope === 'matches' ? 'Matches only' : 'Matches first'}
                    {' · '}
                    {queue.remaining} automatic attempts left overall · Resets at midnight
                </span>
              )}
              <button className="workbench-help-link ml-auto" onClick={() => openSettings('queue')}>
                Briefing settings
              </button>
            </footer>
          )}
          </>}
        </main>
        </div>
      </Activity>
      {onboarding.open && onboarding.state.draft && <OnboardingSetup draft={onboarding.state.draft} onChange={onboarding.change}
        onPause={() => void onboarding.pause()} onApply={() => { void onboarding.apply().then(next => {
          if (!next) return;
          setPrefs(next); setOpenedItem(null); setSavedView(false); setMutedOpen(false); setSelected(null);
          filtersLoaded.current = false; pendingFilters.current = null; releaseFilters();
          void refresh().then(() => {
            if (filtersLoaded.current) return;
            setFilters(normalizeQueueFilters(workbenchStore.getQueue().filters));
            filtersLoaded.current = true;
          });
        }); }} onConnect={() => setAuthOpen(true)} login={auth?.authenticated ? auth.login : null}
        items={queue.items} saving={onboarding.saving} saveError={onboarding.error} />}
      {onboarding.tourOpen && <GuidedTour step={onboarding.state.tourStep ?? 0} stacked={summaryItem?.subject.kind === 'stack'} local={prefs?.guestMode || !auth?.authenticated}
        onStep={onboarding.tourStep} onClose={onboarding.endTour} prepare={step => {
          if (step === 0) { setOpenedItem(null); setSavedView(false); setMutedOpen(false); return true; }
          const item = summaryItem ?? orderedItems[0];
          if (!item) return false;
          setOpenedItem(item);
          setOverviewTab(step === 1 ? 'summary' : step === 2 ? 'changes' : 'explanation');
          return true;
        }} />}
      <GitHubAuthDialog
        open={authOpen || connectionRequired}
        connectionRequired={connectionRequired}
        onOpenChange={setAuthOpen}
        onConnected={syncAuth}
        onSignedOut={async () => {
          onAccount?.('local');
          setAuth({ authenticated: false, login: null });
          setOpenedItem(null);
          setSelected(null);
          setFiltersOpen(false);
          setAuthOpen(true);
          if (prefs) {
            const next = { ...prefs, guestMode: false };
            setPrefs(next);
            await savePrefs(next);
          }
          void refresh();
        }}
        onContinueLocally={async () => {
          const current = await window.electronAPI.loadPreferences();
          await savePrefs({ ...current, guestMode: true });
          setAuthOpen(false);
        }}
        login={auth?.login}
        prUrl={summaryItem?.subject.members[0].url ?? (url.trim() || undefined)}
      />
      {(settings || settingsMounted) && (
      <Suspense fallback={null}>
      <SettingsDialog
        initialSection={settingsSection}
        onReplayOnboarding={replayGettingStarted}
        onShowWalkthrough={() => { setSettings(false); onboarding.startTour(); }}
        open={settings}
        onOpenChange={(open) => {
          setSettings(open);
          if (!open)
            void window.electronAPI.loadPreferences().then((p) => {
              setPrefs(p);
              void refresh();
            });
        }}
      />
      </Suspense>
      )}
      {explanationSetup && (
        <ExplanationSetupDialog
          requests={explanationSetup.requests}
          onGenerate={async request => { await runExplanation(request); }}
          onClose={started => {
            setupOpen.current = false;
            setupResolver.current = undefined;
            setExplanationSetup(undefined);
            explanationSetup.resolve(started);
          }}
        />
      )}
      <LocalRepoDialog
        open={localOpen}
        onOpenChange={setLocalOpen}
        onSubmit={(localUrl, localTools) => {
          setLocalOpen(false);
          void start(localUrl, undefined, localTools.localTools);
        }}
      />
    </div>
    </PrReadContext.Provider>
  );
}
