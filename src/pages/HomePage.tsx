import { normalizePrInactivityDays } from '../../lib/pr-inactivity';
import { GitHubSyncStatus } from '../../components/GitHubSyncStatus';
import { inspectionData } from '../../lib/inspection-cache';
import { PrMuteMenu } from '../../components/PrMuteMenu';
import { MutedPrs } from '../../components/MutedPrs';
import { isMutedReview } from '../../lib/muted-prs';
import { setDiscussionAccount } from '../../lib/review-discussion-cache';
import { explanationItem, matchesExplanation, type ExplanationDestination } from '../../lib/explanation-workspace';
import { GitHubAuthor } from '../../components/GitHubAuthor';
import { QueueMetadata, PrStateIcon } from '../../components/QueueMetadata';
import { rememberCommandDestination } from '../../lib/command-recents';
import { useCommandCenter, useCommandScope } from '../../lib/command-center';
import type { SearchDestination } from '../../lib/command-search';
import { useSessionDraft } from '../../lib/session-drafts';
import type { VirtualItem } from '@tanstack/react-virtual';
import { VirtualReviewQueue } from '../../components/VirtualReviewQueue';
import { GitHubIcon } from '../../lib/constants';
import { PrLabels } from '../../components/PrLabels';
import { PrStarButton } from '../../components/PrStarButton';
import { orderQueueItems, starredFirst } from '../../lib/starred-prs';
import { PrSummary, type PrReadingPosition } from '../../components/PrSummary';
import { publishQueueSignals } from '../../lib/use-queue-signals';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  Upload,
  X,
  FolderGit2,
  AlertCircle,
  Inbox,
  Clock,
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
import { SettingsDialog, type SettingsSection } from '../../components/SettingsDialog';
import { LocalRepoDialog } from '../../components/LocalRepoDialog';
import { UpdateBanner } from '../../components/UpdateBanner';
import { Button } from '../../components/ui/button';
import { Markdown } from '../../components/Markdown';
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
import type { Preferences, PrStatus, ReviewGuide, ReviewHistoryEntry, ModelId, Provider } from '../../lib/types';

interface Props {
  onReviewReady: (review: ReviewGuide) => void;
  explanationDestination?: ExplanationDestination;
  onShowActivity?: () => void;
  prefillPrUrl?: string;
  initialSubjectId?: string;
  commandDestination?: { destination: Extract<SearchDestination, { kind: 'home' }>; nonce: number };
}
const labels = {
  starred: 'Starred',
  updated: 'Changed since AI explanation',
  requested: 'Review requested',
  other: 'Other changes',
};

export function HomePage({ onReviewReady, prefillPrUrl, initialSubjectId, commandDestination, explanationDestination, onShowActivity }: Props) {
  const [overviewTab,setOverviewTab] = useState<'summary'|'changes'|'commits'|'explanation'>('summary');
  const commandCenter = useCommandCenter();
  const handledCommand = useRef<number>(0);
  const [auth, setAuth] = useState<{ authenticated: boolean; login: string | null } | null>(null);
  useEffect(() => { if (auth) setDiscussionAccount(auth.authenticated ? auth.login ?? '' : ''); }, [auth]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [queue, setQueue] = useState<WorkbenchQueue>({ items: [], warnings: [], remaining: 0 });
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_QUEUE_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savedQuery, setSavedQuery] = useState('');
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
  const [mutedOpen, setMutedOpen] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [muteError, setMuteError] = useState('');
  const muteBusyRef = useRef(false);
  const muteVersion = useRef(0);
  const [savedView, setSavedView] = useState(false);
  const [starBusy, setStarBusy] = useState(false);
  const [starError, setStarError] = useState('');
  const starBusyRef = useRef(false);
  const starVersion = useRef(0);
  const starredUrls = useMemo(
    () => new Set(queue.starredPrs?.map((entry) => entry.member.url) ?? []),
    [queue.starredPrs]
  );
  const changeStars = async (members: ReviewSubject['members'], starred: boolean) => {
    if (starBusyRef.current) return;
    starBusyRef.current = true;
    setStarBusy(true);
    setStarError('');
    starVersion.current++;
    try {
      const next = await enqueueWrite(() => window.electronAPI.workbenchStarPrs({ members, starred }));
      setQueue(next);
      setError('');
    } catch (error) {
      const message = `Could not save starred PRs: ${error instanceof Error ? error.message : String(error)}. Your stars have not changed. Try the star button again.`;
      setError(message);
      setStarError(message);
    } finally {
      starBusyRef.current = false;
      setStarBusy(false);
    }
  };
  const mutedUrls = useMemo(() => new Set(queue.mutedPrs?.map(entry => entry.member.url) ?? []), [queue.mutedPrs]);
  const visibleHistory = useMemo(() => history.filter(entry => !isMutedReview(entry, mutedUrls)), [history, mutedUrls]);
  const changeMutes = async (members: ReviewSubject['members'], muted: boolean) => {
    if (muteBusyRef.current) return;
    muteBusyRef.current = true; setMuteBusy(true); setMuteError(''); muteVersion.current++;
    try {
      const next = await enqueueWrite(() => window.electronAPI.workbenchMutePrs({ members, muted }));
      setQueue(next); setError('');
      if (muted) {
        setOpenedItem(null); setSelected(null);
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[title="Muted PRs"]')?.focus());
      } else {
        void window.electronAPI.listReviews().then(setHistory).catch(() => {});
      }
    } catch (error) {
      const message = `Could not ${muted ? 'mute' : 'unmute'} PRs: ${error instanceof Error ? error.message : String(error)}. Nothing changed. Try again.`;
      setMuteError(message); setError(message);
    } finally { muteBusyRef.current = false; setMuteBusy(false); }
  };
  const section = savedView
    ? 'saved'
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
    setFilters((current) => {
      const next = normalizeQueueFilters({ ...current, ...patch });
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
    try {
      const result = await enqueueWrite(async () => {
        if (pending) await window.electronAPI.workbenchSetFilters(pending);
        return window.electronAPI.workbenchViewAction(action);
      });
      setQueue(result);
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
      viewBusyRef.current = false;
      setViewBusy(false);
    }
  };
  const setQuery = (value: string) => (section === 'saved' ? setSavedQuery(value) : updateFilters({ query: value }));
  const setRepo = (value: string) => updateFilters({ repo: value });
  const resetFilters = () => {
    updateFilters({ ...DEFAULT_QUEUE_FILTERS, briefingScope: filters.briefingScope });
    setSavedView(false);
  };
  const [selected, setSelected] = useState<string | null>(
    () => initialSubjectId ?? localStorage.getItem('gnosis-queue-selection')
  );
  useEffect(() => {
    if (initialSubjectId) { setSelected(initialSubjectId); setOpenedItem(null); }
  }, [initialSubjectId]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('queue');
  const [showGettingStarted, setShowGettingStarted] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const connectionRequired = !!auth && !!prefs && !auth.authenticated && !prefs.guestMode;
  const [localOpen, setLocalOpen] = useState(false);
  const [url, setUrl] = useState(prefillPrUrl ?? '');
  const [showUrl, setShowUrl] = useState(!!prefillPrUrl);
  const [pendingStarts, setPendingStarts] = useState<Set<string>>(new Set());
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string>>({});
  const [openingPr, setOpeningPr] = useState(false);
  const [openedItem, setOpenedItem] = useState<QueueItem | null>(null);
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
  const queueScrollElement = useRef<HTMLElement>(null);
  const queueMeasurements = useRef<VirtualItem[]>([]);
  const [queueScrollOffset] = useSessionDraft('queue-scroll', () => ({ current: 0 }));
  const pendingRowFocus = useRef<string | null>(null);
  const attachQueueScroll = useCallback((element: HTMLElement | null) => {
    queueScrollElement.current = element;
    if (element) element.scrollTop = queueScrollOffset.current;
  }, []);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [statuses, setStatuses] = useState<Partial<Record<string, PrStatus>>>({});
  const cachedStatuses = useRef(new Map<string, PrStatus>());
  const lastStatusAttempt = useRef(0);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const alive = useRef(true);
  const selectedItem = [...queue.items, ...(queue.starredItems ?? [])].find(
    (i) => i.subject.id === selected && matchesQueueFilters(i, filters, Date.now(), auth?.login)
  );
  const summarySource =
    openedItem && ([...queue.items, ...(queue.starredItems ?? [])].find((item) => item.subject.id === openedItem.subject.id) ?? openedItem);
  const summaryItem = summarySource && {
    ...summarySource,
    review:
      visibleHistory.find((entry) => entry.id === requestedReviews[summarySource.subject.id]) ??
      visibleHistory.find(
        (entry) =>
          entry.snapshot?.subject.id === summarySource.subject.id ||
          (!entry.snapshot && entry.prUrl === summarySource.subject.members[0].url)
      ) ??
      summarySource.review,
  };
  useEffect(() => {
    if (!explanationDestination) return;
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

  const refresh = useCallback(async (force = false) => {
    const version = filterVersion.current;
    const starsVersion = starVersion.current;
    const mutesVersion = muteVersion.current;
    const applyQueue = (next: WorkbenchQueue) => {
          if (alive.current && version === filterVersion.current && starsVersion === starVersion.current && mutesVersion === muteVersion.current && !muteBusyRef.current && !starBusyRef.current && !viewBusyRef.current && !pendingFilters.current) {
            setQueue(next);
            if (!filtersLoaded.current) {
              const restored = normalizeQueueFilters(next.filters);
              setFilters(restored);
              filtersLoaded.current = true;
            }
            setQueueFailed(false);
          }
        };
    if (force) setRefreshing(true);
    try {
      await window.electronAPI.workbenchSnapshot().then(next => { applyQueue(next); if (alive.current && next.items.length) setLoading(false); }).catch(() => {});
      await Promise.all([
        window.electronAPI.workbenchQueue(force).then(applyQueue),
        window.electronAPI.listReviews().then((entries) => {
          if (alive.current) setHistory(entries);
        }),
      ]);
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
  useEffect(() => {
    alive.current = true;
    void Promise.all([window.electronAPI.getAuthState(), window.electronAPI.loadPreferences()])
      .then(([a, p]) => {
        if (alive.current) {
          setAuth(a);
          setPrefs(p);
          void refresh();
        }
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
    const poll = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const timer = setInterval(poll, 4000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);
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
          if (alive.current) setQueue(result);
        })
        .catch((e: unknown) => {
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
        void enqueueWrite(() => window.electronAPI.workbenchSetFilters(pending)).catch(() => {});
      }
    },
    []
  );
  useEffect(() => {
    if (selected) localStorage.setItem('gnosis-queue-selection', selected);
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
    lastStatusAttempt.current = statusAttempt;
    const refreshStatuses = () => {
      if (statusSubject && !refreshingStatus && document.visibilityState !== 'hidden') {
        refreshingStatus = true;
        setStatusRefreshing(true);
        const refreshNow = force;
        force = false;
        void Promise.allSettled(
          statusSubject.members.map(async (m) => ({
            url: m.url,
            status: await window.electronAPI.getPrStatus(m.url, refreshNow),
          }))
        ).then((results) => {
          refreshingStatus = false;
          if (!cancelled) {
            setStatusRefreshing(false);
            results.forEach((r, i) => {
              if (r.status !== 'fulfilled') return;
              const m = statusSubject.members[i];
              cachedStatuses.current.set(cacheKey(m.url, m.headSha), r.value.status);
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
                results.flatMap((r) => (r.status === 'fulfilled' ? [[r.value.url, r.value.status]] : []))
              ),
            }));
          }
        });
      }
    };
    refreshStatuses();
    const timer = setInterval(refreshStatuses, 120000);
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
    const signalTimer = setInterval(() => void refreshSignals(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(signalTimer);
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
  useEffect(() => {
    rowButtons.current.get(selected ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [selected, loading, section, filters]);
  const savePrefs = async (next: Preferences) => {
    await window.electronAPI.savePreferences(next);
    setPrefs(next);
    void refresh();
  };
  const start = async (target: string, subject?: ReviewSubject, localTools?: boolean, standalone = false) => {
    if (!prefs) return;
    const requestKey = subject?.id ?? openedItem?.subject.id ?? target;
    if (pendingStarts.has(requestKey)) return;
    setError('');
    setSummaryErrors((previous) => ({ ...previous, [requestKey]: '' }));
    setPendingStarts((previous) => new Set(previous).add(requestKey));
    try {
      const cli = await window.electronAPI.checkCliInstalled(prefs.provider);
      if (!cli.installed)
        throw new Error(`${PROVIDERS[prefs.provider].label} was not found. Open Settings → Integrations for AI setup.`);
      const result = await window.electronAPI.startReview({
        prUrl: target,
        subjectId: subject?.id,
        standalone,
        provider: prefs.provider,
        model: prefs.model,
        instructions: prefs.instructions,
        thinking: prefs.thinking,
        smartImports: prefs.smartImports,
        reviewSuggestions: prefs.reviewSuggestions,
        webResearch: prefs.enableWebResearch,
        educationMode: prefs.educationMode,
        claudeContext: prefs.claudeContext,
        localTools,
      });
      if (openedItem) setRequestedReviews((previous) => ({ ...previous, [openedItem.subject.id]: result.reviewId }));
      if (!prefs.firstRunSeen || showGettingStarted) void dismissGettingStarted();
      setShowUrl(false);
      setUrl('');
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (openedItem) setSummaryErrors((previous) => ({ ...previous, [requestKey]: message }));
      else setError(message);
    } finally {
      setPendingStarts((previous) => {
        const next = new Set(previous);
        next.delete(requestKey);
        return next;
      });
    }
  };
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
    if (nextAuth.authenticated) {
      const current = await window.electronAPI.loadPreferences();
      await savePrefs({ ...current, guestMode: false });
    }
    setAuthOpen(false);
    setError('');
    void refresh(true);
  };
  const queueItems = filters.starredOnly ? (queue.starredItems ?? []) : queue.items;
  const items = queueItems.filter((item) => matchesQueueFilters(item, filters, Date.now(), auth?.login));
  const repos = [
    ...new Set([...queueItems.flatMap((i) => i.subject.members.map((m) => m.repo)), ...(repo === 'all' ? [] : [repo])]),
  ].sort();
  const saved = useMemo(
    () =>
      starredFirst(
        visibleHistory.filter((h) => `${h.prTitle} ${h.prUrl}`.toLowerCase().includes(query.toLowerCase())),
        (entry) => (entry.snapshot?.subject.members ?? [{ url: entry.prUrl }]).some((m) => starredUrls.has(m.url))
      ),
    [visibleHistory, query, starredUrls]
  );
  const orderedItems = orderQueueItems(items);
  // The active PR, current view, then the remaining queue. Revision identity
  // prevents routine metadata/CI updates from repeating content downloads.
  const inspectionTargets = [...(statusSubject?.members ?? []),
    ...orderedItems.flatMap(item => item.subject.members), ...queue.items.flatMap(item => item.subject.members)];
  const inspectionKey = JSON.stringify(inspectionTargets.map(member => ({ url: member.url, baseSha: member.baseSha, headSha: member.headSha })));
  useEffect(() => {
    const preload = () => inspectionData.setTargets(auth?.authenticated ? auth.login : null,
      JSON.parse(inspectionKey) as { url: string; baseSha: string; headSha: string }[]);
    preload();
    document.addEventListener('visibilitychange', preload);
    return () => document.removeEventListener('visibilitychange', preload);
  }, [auth?.authenticated, auth?.login, inspectionKey]);
  useEffect(() => () => inspectionData.stop(), []);
  const summaryIndex = orderedItems.findIndex((item) => item.subject.id === summaryItem?.subject.id);
  const moveSummary = (direction: number) => {
    const nextIndex = summaryIndex + direction;
    if (summaryIndex < 0 || nextIndex < 0 || nextIndex >= orderedItems.length) return;
    const item = orderedItems[nextIndex];
    setSelected(item.subject.id);
    setOpenedItem(item);
    setError('');
  };
  const openSettings = (next: SettingsSection = 'queue') => {
    setSettingsSection(next);
    setSettings(true);
  };
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
  const activate = (item: QueueItem) => {
    const entry = item.review;
    if (entry?.status === 'completed' && entry.snapshot?.fingerprint === fingerprint(item.subject)) void open(entry);
    else {
      setError('');
      setOpenedItem(item);
    }
  };
  const openPrUrl = async () => {
    setError('');
    setOpeningPr(true);
    try {
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
      if (!match) throw new Error('Enter a GitHub PR URL, such as https://github.com/owner/repo/pull/123.');
      const canonical = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
      const cached = queue.items.find((item) =>
        item.subject.members.some((m) => m.url.toLowerCase() === canonical.toLowerCase())
      );
      if (cached) {
        setOpenedItem(cached);
        setSelected(cached.subject.id);
      } else {
        const meta = await window.electronAPI.getPrMetadata(canonical);
        const repo = `${match[1]}/${match[2]}`;
        setOpenedItem({
          attention: 'other',
          subject: {
            id: canonical,
            kind: 'pr',
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
    handledCommand.current = commandDestination.nonce;
    const target = commandDestination.destination;
    setMutedOpen(target.section === 'muted');
    setError('');
    if (target.subject) {
      setOpenedItem(target.subject);
      setSelected(target.subject.subject.id);
      return;
    }
    setOpenedItem(null);
    if (target.settings) {
      openSettings(target.settings as SettingsSection);
      return;
    }
    if (target.local) {
      setLocalOpen(true);
      return;
    }
    if (target.viewId) {
      setSavedView(false);
      void viewAction({ type: 'activate', id: target.viewId }).catch(() => {});
      return;
    }
    if (target.repo) {
      setSavedView(false);
      updateFilters({ ...DEFAULT_QUEUE_FILTERS, repo: target.repo });
      return;
    }
    if (target.section) {
      setMutedOpen(target.section === 'muted');
      setSavedView(target.section === 'saved');
      if (target.section !== 'saved' && target.section !== 'muted')
        updateFilters({
          starredOnly: target.section === 'starred',
          attention: target.section === 'updated' || target.section === 'requested' ? target.section : 'all',
          kind: target.section === 'stacks' ? 'stack' : 'all',
        });
    }
  }, [commandDestination, prefs, loading]);
  const commandItem = summaryItem ?? selectedItem;
  useCommandScope('home', [
    ...(commandItem && queue.items.some((item) => item.subject.id === commandItem.subject.id)
      ? [
          {
            id: 'context:briefing',
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
            label: `Generate AI review · ${commandItem.subject.title}`,
            group: 'Uses your selected model · tracked in Activity',
            perform: () =>
              start(
                commandItem.subject.members[0].url,
                [...queue.items, ...(queue.starredItems ?? [])].some((item) => item.subject.id === commandItem.subject.id)
                  ? commandItem.subject
                  : undefined,
                undefined,
                commandItem.subject.scope === 'single'
              ),
          },
        ]
      : []),
  ]);
  const moveSelection = (direction: number) => {
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
    setSelected(next.subject.id);
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
    { enabled: !mutedOpen && !settings && !localOpen && !openedItem && !authOpen && !connectionRequired && section !== 'saved' }
  );
  const correct = async (action: 'link' | 'unlink', parent = parentUrl, child = childUrl) => {
    setGrouping(true);
    setError('');
    try {
      setQueue(await window.electronAPI.workbenchGroup({ parent, child, action }));
      setParentUrl('');
      setChildUrl('');
    } catch (e) {
      setError(String(e));
    } finally {
      setGrouping(false);
    }
  };
  function row(item: QueueItem) {
    const s = item.subject,
      active = selected === s.id;
    return (
      <div key={s.id} className={`queue-item ${active ? 'is-selected' : ''}`}>
        <div className="queue-row">
          {s.kind !== 'stack' ? <span className="queue-pr-gutter"><PrStateIcon member={s.members[0]} /></span> : <button
            className="queue-disclosure"
            aria-label={`${expanded.has(s.id) ? 'Collapse' : 'Expand'} ${s.title}`}
            aria-expanded={expanded.has(s.id)}
            aria-controls={`members-${s.id}`}
            onClick={() =>
              setExpanded((prev) => {
                const n = new Set(prev);
                if (n.has(s.id)) n.delete(s.id);
                else n.add(s.id);
                return n;
              })
            }
          >
            {expanded.has(s.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>}
          <div className="queue-row-content"
            onClick={event=>{if((event.target as HTMLElement).closest('a,button'))return;setSelected(s.id);setStatuses({});}}
            onDoubleClick={event=>{if((event.target as HTMLElement).closest('a,button'))return;setError('');setOpenedItem(item);}}>
          <div className="queue-row-heading">
          <button
            className="queue-row-main"
            ref={(node) => {
              if (node) {
                rowButtons.current.set(s.id, node);
                if (pendingRowFocus.current === s.id) {
                  pendingRowFocus.current = null;
                  node.focus({ preventScroll: true });
                }
              } else rowButtons.current.delete(s.id);
            }}
            aria-pressed={active}
            tabIndex={
              active || (!items.some((i) => i.subject.id === selected) && orderedItems[0]?.subject.id === s.id) ? 0 : -1
            }
            aria-describedby="queue-keyboard-help"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveSelection(e.key === 'ArrowDown' ? 1 : -1);
              } else if (e.key === 'Enter' && active && !e.repeat) {
                e.preventDefault();
                activate(item);
              }
            }}
            onClick={() => {
              setSelected(s.id);
              setStatuses({});
            }}
            onDoubleClick={() => {
              setError('');
              setOpenedItem(item);
            }}
          >
            <span className="queue-title-line">
              {s.kind === 'stack' && <Layers size={16} aria-label="PR stack" className="queue-stack-icon" />}
              <span className="queue-title">{s.title}</span>
              <PrLabels members={s.members} limit={3} />
            </span>
          </button>
          <PrStarButton members={s.members} starredUrls={starredUrls} busy={starBusy} onChange={(members, value) => void changeStars(members, value)} />
          <PrMuteMenu members={s.members} busy={muteBusy} onMute={members => void changeMutes(members, true)} />
          {(item.review?.status === 'generating' ||
            item.review?.status === 'completed' ||
            item.briefing?.status === 'generating') && (
            <span className={`queue-state ${item.attention === 'updated' ? 'needs-attention' : ''}`}>
              {item.review?.status === 'generating' ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Generating explanation
                </>
              ) : item.review?.status === 'completed' ? (
                <>
                  <Check size={13} />
                  Explanation ready
                </>
              ) : item.briefing?.status === 'generating' ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Generating briefing
                </>
              ) : null}
            </span>
          )}
          </div>
            <QueueMetadata subject={s} account={auth?.login ?? null} />
            {item.briefing?.summary && <span className="queue-summary">{item.briefing.summary}</span>}
          </div>
        </div>
        {expanded.has(s.id) && (
          <div id={`members-${s.id}`}>
            {s.members.map((m) => (
              <div key={m.url} className="queue-member">
                <PrStateIcon member={m} />
                <div className="queue-member-content">
                  <button className="queue-member-title" onClick={() => setSelected(s.id)}>
                    <span className="truncate">{m.title}</span>
                    <PrLabels members={[m]} />
                  </button>
                  <QueueMetadata subject={{ id: m.url, kind: 'pr', title: m.title, members: [m], edges: [], warnings: [] }} account={auth?.login ?? null} />
                </div>
                <PrStarButton members={[m]} starredUrls={starredUrls} busy={starBusy} onChange={(members, value) => void changeStars(members, value)} />
          <PrMuteMenu members={[m]} busy={muteBusy} onMute={members => void changeMutes(members, true)} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  const replayGettingStarted = () => {
    setOpenedItem(null);
    resetFilters();
    setSelected(null);
    setShowGettingStarted(true);
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
    <div className="workbench-home">
      <header className="workbench-header">
        <a
          href="#"
          className="workbench-brand"
          onClick={(e) => {
            e.preventDefault();
            setOpenedItem(null);
            setSavedView(false);
            updateFilters({ attention: 'all', kind: 'all' });
          }}
        >
          Gnosis
        </a>
        <div className="ml-auto flex items-center gap-2">
          {prefs && (
            <select
              aria-label="Review model"
              title="Model for reviews and briefings"
              className="workbench-select model-select"
              value={`${prefs.provider}:${prefs.model}`}
              onChange={(e) => {
                const [provider, ...rest] = e.target.value.split(':');
                void savePrefs({
                  ...prefs,
                  provider: provider as Provider,
                  model: rest.join(':') as ModelId,
                  proactiveReviewOverrides: false,
                });
              }}
            >
              {Object.values(PROVIDERS).map((p) => (
                <optgroup key={p.label} label={p.label}>
                  {p.models.map((m) => (
                    <option
                      key={m.id}
                      value={`${p.label.toLowerCase().includes('codex') ? 'codex' : 'claude'}:${m.id}`}
                    >
                      {p.label} · {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          <GitHubSyncStatus sync={queue.sync} onRefresh={() => void refresh(true)} />
          <button
            className="workbench-command-trigger"
            onClick={() => commandCenter?.open()}
            title="Search and navigate (⌘K / Ctrl K)"
          >
            <Search size={15} />
            <span>Search</span>
            <kbd className="kbd">{window.electronAPI.platform === 'darwin' ? '⌘ K' : 'Ctrl K'}</kbd>
          </button>
          <WorkbenchHelp onGettingStarted={replayGettingStarted} />
          <button className="workbench-icon" title="Settings" aria-label="Settings" onClick={() => openSettings()}>
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
      {summaryItem ? (
        <PrSummary
        key={summaryItem.subject.id}
        item={summaryItem}
        starredUrls={starredUrls}
        starBusy={starBusy}
        starError={muteError || starError}
        muteBusy={muteBusy}
        onMute={members => void changeMutes(members, true)}
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
        shortcutsEnabled={!settings && !localOpen && !authOpen && !connectionRequired}
          navigation={{
            index: summaryIndex,
            total: orderedItems.length,
            viewName: activeQueueView?.name ?? 'Current filtered view',
          previous: summaryIndex > 0 ? orderedItems[summaryIndex - 1].subject.title : undefined,
            next: summaryIndex >= 0 ? orderedItems[summaryIndex + 1]?.subject.title : undefined,
            move: moveSummary,
          }}
        starting={pendingStarts.has(summaryItem.subject.id)}
        error={summaryErrors[summaryItem.subject.id] || error}
        statuses={statuses}
        statusErrors={statusErrors}
        onBack={() => {
          setOverviewTab('summary');
          setOpenedItem(null);
          requestAnimationFrame(() => rowButtons.current.get(selected ?? '')?.focus({ preventScroll: true }));
        }}
          onGenerate={() =>
            void start(
              summaryItem.subject.members[0].url,
          [...queue.items, ...(queue.starredItems ?? [])].some((item) => item.subject.id === summaryItem.subject.id) ? summaryItem.subject : undefined,
              undefined,
              summaryItem.subject.scope === 'single'
            )
          }
        onRetryStatus={() => { if (!statusRefreshing) setStatusAttempt((n) => n + 1); }}
        onAiSetup={() => openSettings('integrations')}
        onGitHubAuth={() => setAuthOpen(true)}
        />
      ) : (
        <div className="workbench-body">
        <nav className="workbench-sidebar" aria-label="Workspace">
          <p className="workbench-nav-heading">Reviews</p>
          {[
            ['all', 'Work queue', Inbox],
            ['starred', 'Starred', Star],
            ['requested', 'Review requests', GitPullRequest],
            ['updated', 'Updated PRs', RefreshCw],
            ['stacks', 'Stacks', Layers],
            ['saved', 'Saved reviews', Clock],
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof Inbox;
            return (
              <button
                key={id as string}
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
                      attention: id === 'stacks' || id === 'starred' ? 'all' : (id as QueueFilters['attention']),
                      kind: id === 'stacks' ? 'stack' : 'all',
                    };
                    if (activeQueueView)
                      void viewAction({ type: 'activate', id: null, filters: patch }).catch(() => {});
                    else updateFilters(patch);
                  }
                  setSelected(null);
                }}
              >
                <I size={16} />
                <span>{label as string}</span>
                <span className="nav-count">
                  {id === 'saved'
                    ? visibleHistory.length
                    : id === 'starred' ? queue.starredItems?.length ?? 0
                    : id === 'all'
                      ? queue.items.length
                      : id === 'stacks'
                        ? queue.items.filter((i) => i.subject.kind === 'stack').length
                        : queue.items.filter((i) => i.attention === id).length}
                </span>
              </button>
            );
          })}
          {auth?.authenticated && queue.savedViews && (
            <SavedViewsNav state={queue.savedViews} active={!savedView && !mutedOpen} busy={viewBusy} onAction={viewAction} />
          )}
          <div className="mt-auto flex flex-col gap-1">
            <button title="Muted PRs" className={mutedOpen ? 'active' : ''} aria-current={mutedOpen ? 'page' : undefined}
              onClick={() => { setMutedOpen(true); setSelected(null); setOpenedItem(null); setError(''); }}>
              <VolumeX size={16} /><span>Muted PRs</span><span className="nav-count">{queue.mutedPrs?.length ?? 0}</span>
            </button>
            <button title="Local changes" onClick={() => setLocalOpen(true)}>
              <FolderGit2 size={16} />
              Local changes
            </button>
            <button
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
              Import review
            </button>
          </div>
        </nav>
        <main className="workbench-main">
          {mutedOpen ? <MutedPrs entries={queue.mutedPrs ?? []} busy={muteBusy} error={muteError} onUnmute={members => void changeMutes(members, false)} /> : <>
          <div className="queue-toolbar">
            <div>
              <h1>
                {section === 'saved'
                  ? 'Saved reviews'
                  : activeQueueView
                    ? activeQueueView.name
                    : section === 'all'
                      ? 'Work queue'
                      : section === 'stacks'
                        ? 'Stacks'
                        : labels[section]}
              </h1>
              {section !== 'all' && (
                <p>
                  {section === 'saved'
                    ? 'Saved AI explanations, ready to resume.'
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
                {openingPr ? 'Opening…' : 'Open PR overview'}
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
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={14} />
              </button>
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
              <select
                aria-label="Filter repository"
                className="workbench-select"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              >
                <option value="all">All repositories</option>
                {repos.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
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
                    className="queue-filter-popover"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                    aria-label="Queue filters"
                  >
                    <div className="queue-filter-heading">
                      <strong>Filter PRs and stacks</strong>
                      <Popover.Close className="workbench-icon" aria-label="Close filters">
                        <X size={16} />
                      </Popover.Close>
                    </div>
                    <QueueFilterPanel filters={filters} items={queueItems} onChange={updateFilters} prInactivityDays={prefs?.prInactivityDays} onManageInactivity={() => { setFiltersOpen(false); openSettings('queue'); }} />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
            {section !== 'saved' && auth?.authenticated && queue.savedViews && (
              <SaveViewControls view={activeQueueView} filters={filters} busy={viewBusy} onAction={viewAction} />
            )}
            <span
              className="queue-count"
              aria-live="polite"
                title={
                  section === 'saved'
                ? 'AI explanations saved on this computer'
                    : 'Each stack counts as one item. Counts use loaded GitHub data; built-in sidebar totals do not apply your other filters.'
                }
            >
              {section === 'saved' ? `${saved.length} reviews` : `${items.length} of ${queueItems.length} items`}
            </span>
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
          {section !== 'saved' && (
            <p className="sr-only" id="queue-keyboard-help">
                <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> select · <kbd>Enter</kbd> open · <kbd>/</kbd>{' '}
                search
            </p>
          )}
          <div className="queue-content">
              <section
                className="queue-list"
                aria-label="Review queue"
                ref={attachQueueScroll}
                onScroll={(event) => {
                  queueScrollOffset.current = event.currentTarget.scrollTop;
                }}
              >
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
                  onRepositories={() => openSettings('queue')}
                  onOpenPr={() => setShowUrl(true)}
                  onLocal={() => setLocalOpen(true)}
                  onDismiss={() => void dismissGettingStarted()}
                />
              )}
              {loading ? (
                <div className="queue-empty">
                  <Loader2 className="animate-spin" size={22} />
                  <p>Loading your workspace…</p>
                </div>
              ) : section === 'saved' ? (
                saved.length ? (
                  saved.map((entry) => (
                    <div className="saved-row" key={entry.id}>
                      <div className="queue-row-content" onClick={event=>{if((event.target as HTMLElement).closest('a,button')||entry.status==='generating')return;void (entry.status==='failed' ? start(entry.prUrl) : open(entry));}}>
                      <button
                        className="queue-row-main"
                        disabled={entry.status === 'generating'}
                        onClick={() => (entry.status === 'failed' ? void start(entry.prUrl) : void open(entry))}
                      >
                        <span className="queue-title">{entry.prTitle}</span>
                      </button>
                        <span className="queue-meta">
                          {entry.snapshot?.subject.kind === 'stack'
                            ? `${entry.snapshot.subject.members.length} PR stack · `
                            : ''}
                          <GitHubAuthor login={entry.author}/> · {timeAgo(entry.savedAt)} ·{' '}
                          {entry.status === 'generating'
                            ? 'Generating explanation'
                            : entry.status === 'failed'
                              ? 'Generation failed'
                              : 'Explanation ready'}
                        </span>
                        {entry.error && <span className="text-xs text-destructive">{entry.error}</span>}
                      </div>
                      {!!entry.snapshot?.subject.members.length && <><PrStarButton members={entry.snapshot.subject.members} starredUrls={starredUrls} busy={starBusy} onChange={(members, value) => void changeStars(members, value)} /><PrMuteMenu members={entry.snapshot.subject.members} busy={muteBusy} onMute={members => void changeMutes(members, true)} /></>}
                      {entry.status !== 'generating' && (
                        <button
                          className="workbench-icon"
                          aria-label={`Export ${entry.prTitle}`}
                          onClick={() =>
                            void window.electronAPI.exportReview(entry.id).catch((e: unknown) => setError(String(e)))
                          }
                        >
                          <Download size={15} />
                        </button>
                      )}
                      <button
                        className="workbench-icon"
                        aria-label={`Delete ${entry.prTitle}`}
                        onClick={() => {
                          if (confirm('Delete this saved review?'))
                            void window.electronAPI.deleteReview(entry.id).then(() => refresh());
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="queue-empty">
                    <Clock size={24} />
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
                    labels={labels}
                    selected={selected}
                    scrollElement={queueScrollElement}
                    measurements={queueMeasurements}
                    initialOffset={queueScrollOffset.current}
                    renderRow={row}
                  />
              ) : gettingStartedVisible && !queueFailed ? null : (
                <div className="queue-empty">
                  <Inbox size={24} />
                  <h2>
                    {section === 'starred' && !queue.starredPrs?.length ? 'No starred PRs yet' : queueFailed
                      ? 'Queue could not be loaded'
                      : filterCount > 0
                        ? 'No PRs match these filters'
                        : !auth?.authenticated
                          ? 'Your GitHub queue is not connected'
                          : section !== 'all'
                            ? 'No PRs in this view'
                            : 'No pull requests in your queue'}
                  </h2>
                  <p>
                    {section === 'starred' && !queue.starredPrs?.length ? 'Star a PR from the work queue or its overview to keep it here and pin it above other PRs.' : queueFailed
                      ? 'Try loading the queue again. You can still open a PR by URL or a saved review.'
                      : filterCount > 0
                        ? 'Try fewer filters or a wider date range. One open PR must match every filter; its whole stack stays visible.'
                        : !auth?.authenticated
                          ? prefs?.guestMode
                            ? 'You are using local mode. Review a repository on this computer.'
                            : 'Connect GitHub above, or review local changes from the sidebar.'
                          : section !== 'all'
                            ? 'Try the full work queue to see other changes.'
                            : normalizePrInactivityDays(prefs?.prInactivityDays)
                              ? `No matching PRs were active within ${normalizePrInactivityDays(prefs?.prInactivityDays)} days. Starred PRs are included. Adjust the inactivity limit in Settings, or open a PR by URL.`
                              : 'Open a pull request by URL, or add repositories to follow in Settings. Dependabot PRs are hidden by default.'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (queueFailed) void refresh(true);
                      else if (filterCount > 0) {
                        resetFilters();
                      } else if (section !== 'all') resetFilters();
                      else if (!auth?.authenticated) setLocalOpen(true);
                      else openSettings();
                    }}
                  >
                    {queueFailed
                      ? 'Retry queue'
                      : filterCount > 0
                        ? 'Clear filters'
                        : section !== 'all'
                          ? 'Show work queue'
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
                  <span>
                    {selectedItem.subject.kind === 'stack' ? (
                      <>
                        <Layers size={15} />
                        {selectedItem.subject.members.length} PR stack
                      </>
                    ) : (
                      <>
                        <GitPullRequest size={15} />
                        Pull request
                      </>
                    )}
                  </span>
                  <button className="workbench-icon" aria-label="Close briefing" onClick={() => setSelected(null)}>
                    <X size={16} />
                  </button>
                </div>
                <h2>{selectedItem.subject.title}</h2>
                {briefingSelection && (
                  <p className="text-xs text-muted-foreground mb-3" aria-label="Briefing model">
                    Briefing model: {briefingModelLabel}
                    {prefs?.proactiveReviewOverrides ? ' (separate model selected in Settings)' : ''}
                  </p>
                )}
                <div className="briefing-actions">
                    <Button size="sm" onClick={() => activate(selectedItem)}>
                    {selectedItem.review?.status === 'completed' &&
                    selectedItem.review.snapshot?.fingerprint === fingerprint(selectedItem.subject)
                      ? 'Open AI explanation'
                      : 'Open PR overview'}
                    <ArrowRight size={14} />
                  </Button>
                    {selectedItem.review?.status === 'completed' && (
                      <button
                        onClick={() => {
                          setError('');
                          setOpenedItem(selectedItem);
                        }}
                      >
                        Author description
                      </button>
                    )}
                  {selectedItem.review?.status === 'completed' &&
                    selectedItem.review.snapshot?.fingerprint !== fingerprint(selectedItem.subject) && (
                      <button onClick={() => selectedItem.review && void open(selectedItem.review)}>
                        Open previous review
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
                    <h3>Affected systems</h3>
                    <div className="briefing-tags">
                      {selectedItem.briefing.systems?.map((s) => (
                        <span key={s}>{s}</span>
                      ))}
                    </div>
                    <h3>Where to focus</h3>
                    <ul>
                      {selectedItem.briefing.priorities?.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="briefing-status">
                    <p>
                      {selectedItem.briefing?.status === 'generating'
                        ? 'Generating an AI briefing… Track progress in Activity; you can keep browsing.'
                        : selectedItem.briefing?.status === 'failed'
                          ? 'The AI briefing failed. Retry below, or open the PR overview to read its description.'
                          : selectedItem.briefing?.status === 'cancelled'
                            ? 'Briefing cancelled. Retry it from Activity.'
                            : selectedItem.briefing?.status === 'paused'
                              ? selectedItem.briefing.pauseReason === 'filter'
                                ? 'Outside your current filters. Automatic briefings are limited to matching changes.'
                                : prefs?.autoBriefings === false
                                  ? 'Automatic briefings are off.'
                                  : queue.remaining <= 0
                                    ? 'Daily briefing attempt limit reached. Increase it in Settings or wait until tomorrow.'
                                    : 'Briefing is paused. Check Activity or briefing settings for details.'
                              : 'Waiting to generate an AI briefing. You can open the PR overview or generate an AI explanation now.'}
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
                            .then(setQueue)
                            .catch((e: unknown) => setError(String(e)))
                        }
                      >
                        Retry briefing
                      </button>
                    )}
                  </div>
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
                          #{m.number} {m.title}
                        </a>
                        <PrLabels members={[m]} />
                        <p>
                          {m.merged ? 'Merged' : m.isDraft ? 'Draft' : m.state} ·{' '}
                          {statuses[m.url]
                            ? `CI ${statuses[m.url]?.ciConclusion} · ${statuses[m.url]?.reviewSummary.approved} approvals`
                            : statusErrors[m.url]
                              ? 'Status unavailable'
                              : 'Loading status…'}
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
                              </a>{' '}
                              — this PR uses changes from that PR.
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
                                setOpenedItem({
                                  attention: selectedItem.attention,
                                  subject: {
                                    id: m.url,
                                    kind: 'pr',
                                    scope: 'single',
                                    title: m.title,
                                    members: [m],
                                    edges: [],
                                    warnings: [],
                                  },
                                });
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
                  <select aria-label="Dependent PR" value={childUrl} onChange={(e) => setChildUrl(e.target.value)}>
                    <option value="">Choose dependent PR</option>
                    {selectedItem.subject.members.map((m) => (
                      <option key={m.url} value={m.url}>
                        #{m.number} {m.title}
                      </option>
                    ))}
                  </select>
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
                Automatic briefings
              </label>
              {prefs.autoBriefings !== false && (
                <span>
                  {filters.briefingScope === 'matches' ? 'Matches only' : 'Matches first'}
                    {' · '}
                    {queue.remaining} attempts left today
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
      )}
      <GitHubAuthDialog
        open={authOpen || connectionRequired}
        connectionRequired={connectionRequired}
        onOpenChange={setAuthOpen}
        onConnected={syncAuth}
        onSignedOut={async () => {
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
      <SettingsDialog
        initialSection={settingsSection}
        onReplayOnboarding={replayGettingStarted}
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
      <LocalRepoDialog
        open={localOpen}
        onOpenChange={setLocalOpen}
        onSubmit={(localUrl, localTools) => {
          setLocalOpen(false);
          void start(localUrl, undefined, localTools.localTools);
        }}
      />
    </div>
  );
}
