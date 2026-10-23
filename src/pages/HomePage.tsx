import { PrLabels } from '../../components/PrLabels';
import { PrSummary, type PrReadingPosition } from '../../components/PrSummary';
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
  GitBranch,
  Github,
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
  prefillPrUrl?: string;
  initialSubjectId?: string;
}
const labels = {
  updated: 'Changed since AI explanation',
  requested: 'Review requested',
  other: 'Other changes',
};

export function HomePage({ onReviewReady, prefillPrUrl, initialSubjectId }: Props) {
  const [auth, setAuth] = useState<{ authenticated: boolean; login: string | null } | null>(null);
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
  const [savedView, setSavedView] = useState(false);
  const section = savedView
    ? 'saved'
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('queue');
  const [showGettingStarted, setShowGettingStarted] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [url, setUrl] = useState(prefillPrUrl ?? '');
  const [showUrl, setShowUrl] = useState(!!prefillPrUrl);
  const [pendingStarts, setPendingStarts] = useState<Set<string>>(new Set());
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string>>({});
  const [openingPr, setOpeningPr] = useState(false);
  const [openedItem, setOpenedItem] = useState<QueueItem | null>(null);
  const readingPositions = useRef(new Map<string, PrReadingPosition>());
  const [requestedReviews, setRequestedReviews] = useState<Record<string, string>>({});
  const [parentUrl, setParentUrl] = useState('');
  const [childUrl, setChildUrl] = useState('');
  const [grouping, setGrouping] = useState(false);
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [savedSummary, setSavedSummary] = useState<{ id: string; summary: string; focus: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [statuses, setStatuses] = useState<Partial<Record<string, PrStatus>>>({});
  const alive = useRef(true);
  const selectedItem = queue.items.find(
    (i) => i.subject.id === selected && matchesQueueFilters(i, filters, Date.now(), auth?.login)
  );
  const summarySource = openedItem && (queue.items.find((item) => item.subject.id === openedItem.subject.id) ?? openedItem);
  const summaryItem = summarySource && {
    ...summarySource,
    review: history.find((entry) => entry.id === requestedReviews[summarySource.subject.id]) ??
      history.find((entry) => entry.snapshot?.subject.id === summarySource.subject.id ||
      (!entry.snapshot && entry.prUrl === summarySource.subject.members[0].url)) ?? summarySource.review,
  };
  const statusSubject = summaryItem?.subject ?? selectedItem?.subject;
  const briefingSelection = prefs ? briefingModel(prefs) : undefined;
  const briefingModelLabel = briefingSelection
    ? `${PROVIDERS[briefingSelection.provider].label} · ${PROVIDERS[briefingSelection.provider].models.find((m) => m.id === briefingSelection.model)?.label ?? briefingSelection.model}`
    : '';

  const refresh = useCallback(async (force = false) => {
    const version = filterVersion.current;
    if (force) setRefreshing(true);
    try {
      await Promise.all([
        window.electronAPI.workbenchQueue(force).then((next) => {
          if (alive.current && version === filterVersion.current && !viewBusyRef.current && !pendingFilters.current) {
            setQueue(next);
            if (!filtersLoaded.current) {
              const restored = normalizeQueueFilters(next.filters);
              setFilters(restored);
              filtersLoaded.current = true;
            }
            setQueueFailed(false);
          }
        }),
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
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      alive.current = false;
      clearInterval(timer);
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
    setStatuses({});
    setStatusErrors({});
    const refreshStatuses = () => {
      if (statusSubject)
        void Promise.allSettled(
          statusSubject.members.map(async (m) => ({
            url: m.url,
            status: await window.electronAPI.getPrStatus(m.url),
          }))
        ).then((results) => {
          if (!cancelled) {
            setStatusErrors(
              Object.fromEntries(
                results.flatMap((r, i) =>
                  r.status === 'rejected' ? [[statusSubject.members[i].url, String(r.reason)]] : []
                )
              )
            );
            setStatuses(
              Object.fromEntries(
                results.flatMap((r) => (r.status === 'fulfilled' ? [[r.value.url, r.value.status]] : []))
              )
            );
          }
        });
    };
    refreshStatuses();
    const timer = setInterval(refreshStatuses, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, statusSubject?.id, statusSubject?.members.map((m) => m.url).join(','), statusAttempt]);
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
      setPendingStarts((previous) => { const next = new Set(previous); next.delete(requestKey); return next; });
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
    setAuth(await window.electronAPI.getAuthState());
    setError('');
    void refresh(true);
  };
  const items = queue.items.filter((item) => matchesQueueFilters(item, filters, Date.now(), auth?.login));
  const repos = [
    ...new Set([
      ...queue.items.flatMap((i) => i.subject.members.filter((m) => m.state === 'open').map((m) => m.repo)),
      ...(repo === 'all' ? [] : [repo]),
    ]),
  ].sort();
  const saved = useMemo(
    () => history.filter((h) => `${h.prTitle} ${h.prUrl}`.toLowerCase().includes(query.toLowerCase())),
    [history, query]
  );
  const orderedItems = (['updated', 'requested', 'other'] as const).flatMap((category) =>
    items.filter((item) => item.attention === category)
  );
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
      const cached = queue.items.find((item) => item.subject.members.some((m) => m.url.toLowerCase() === canonical.toLowerCase()));
      if (cached) {
        setOpenedItem(cached);
        setSelected(cached.subject.id);
      } else {
        const meta = await window.electronAPI.getPrMetadata(canonical);
        const repo = `${match[1]}/${match[2]}`;
        setOpenedItem({ attention: 'other', subject: {
          id: canonical, kind: 'pr', title: meta.title, edges: [], warnings: [],
          members: [{ ...meta, number: Number(match[3]), repo, headRepo: meta.headRepo ?? repo, baseRepo: meta.baseRepo ?? repo, role: 'watched' }],
        } });
      }
      setShowUrl(false);
      setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningPr(false);
    }
  };
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
    { enabled: !settings && !localOpen && !openedItem && section !== 'saved' }
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
          <button
            className="queue-disclosure"
            aria-label={`${expanded.has(s.id) ? 'Collapse' : 'Expand'} ${s.title}`}
            disabled={s.kind !== 'stack'}
            aria-expanded={s.kind === 'stack' ? expanded.has(s.id) : undefined}
            aria-controls={s.kind === 'stack' ? `members-${s.id}` : undefined}
            onClick={() =>
              setExpanded((prev) => {
                const n = new Set(prev);
                if (n.has(s.id)) n.delete(s.id);
                else n.add(s.id);
                return n;
              })
            }
          >
            {s.kind === 'stack' ? (
              expanded.has(s.id) ? (
                <ChevronDown size={15} />
              ) : (
                <ChevronRight size={15} />
              )
            ) : (
              <GitPullRequest size={15} />
            )}
          </button>
          <button
            className="queue-row-main"
            ref={(node) => {
              if (node) rowButtons.current.set(s.id, node);
              else rowButtons.current.delete(s.id);
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
            onDoubleClick={() => { setError(''); setOpenedItem(item); }}
          >
            <span className="queue-title-line">
              <span className="queue-title">{s.title}</span>
              <PrLabels members={s.members} limit={3} />
            </span>
            <span className="queue-meta">
              <span>{s.members[0].repo}</span>
              <span>{s.kind === 'stack' ? `${s.members.length} PRs in stack` : `#${s.members[0].number}`}</span>
              <span>{s.members[0].author}</span>
              <span>{timeAgo(s.members[0].updatedAt)}</span>
            </span>
            {item.briefing?.summary && <span className="queue-summary">{item.briefing.summary}</span>}
          </button>
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
            ) : s.kind === 'stack' ? (
              <>
                <Layers size={13} />
                Stack
              </>
            ) : (
              'PR'
            )}
          </span>
        </div>
        {expanded.has(s.id) && (
          <div id={`members-${s.id}`}>
            {s.members.map((m) => (
              <button key={m.url} className="queue-member" onClick={() => setSelected(s.id)}>
                <GitBranch size={13} />
                <span>#{m.number}</span>
                <span className="queue-member-content">
                  <span className="truncate">{m.title}</span>
                  <PrLabels members={[m]} />
                </span>
                <span className="ml-auto">{m.merged ? 'Merged' : m.isDraft ? 'Draft' : m.state}</span>
              </button>
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
    !loading && section !== 'saved' && auth && !auth.authenticated && !prefs?.guestMode ? (
      <section className="workbench-connect">
        <h2>Connect GitHub</h2>
        <p>Sign in to load your GitHub review requests. Local reviews work without a GitHub connection.</p>
        <Button size="sm" onClick={() => setAuthOpen(true)}>Sign in to GitHub</Button>
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
          <WorkbenchHelp onGettingStarted={replayGettingStarted} />
          <button className="workbench-icon" title="Settings" aria-label="Settings" onClick={() => openSettings()}>
            <Settings size={17} />
          </button>
          <button className="workbench-help-trigger" aria-label="GitHub account" title={auth?.login ? `GitHub: ${auth.login}` : 'Connect GitHub'} onClick={() => setAuthOpen(true)}><Github size={16} /><span className="account-name">{auth?.login ?? 'Connect GitHub'}</span></button>
        </div>
      </header>
      <UpdateBanner />
      {summaryItem ? <PrSummary
        key={summaryItem.subject.id}
        item={summaryItem}
        positions={readingPositions.current}
        shortcutsEnabled={!settings && !localOpen && !authOpen}
        navigation={{ index: summaryIndex, total: orderedItems.length, viewName: activeQueueView?.name ?? 'Current filtered view',
          previous: summaryIndex > 0 ? orderedItems[summaryIndex - 1].subject.title : undefined,
          next: summaryIndex >= 0 ? orderedItems[summaryIndex + 1]?.subject.title : undefined, move: moveSummary }}
        starting={pendingStarts.has(summaryItem.subject.id)}
        error={summaryErrors[summaryItem.subject.id] || error}
        statuses={statuses}
        statusErrors={statusErrors}
        onBack={() => {
          setOpenedItem(null);
          requestAnimationFrame(() => rowButtons.current.get(selected ?? '')?.focus({ preventScroll: true }));
        }}
        onGenerate={() => void start(summaryItem.subject.members[0].url,
          queue.items.some((item) => item.subject.id === summaryItem.subject.id) ? summaryItem.subject : undefined,
          undefined, summaryItem.subject.scope === 'single')}
        onOpenReview={() => { if (summaryItem.review) void open(summaryItem.review); }}
        onRetryStatus={() => setStatusAttempt((n) => n + 1)}
        onAiSetup={() => openSettings('integrations')}
        onGitHubAuth={() => setAuthOpen(true)}
      /> : <div className="workbench-body">
        <nav className="workbench-sidebar" aria-label="Workspace">
          <p className="workbench-nav-heading">Reviews</p>
          {[
            ['all', 'Work queue', Inbox],
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
                aria-current={section === id && (id === 'saved' || !activeQueueView) ? 'page' : undefined}
                className={section === id && (id === 'saved' || !activeQueueView) ? 'active' : ''}
                disabled={viewBusy}
                onClick={() => {
                  setSavedView(id === 'saved');
                  if (id !== 'saved') {
                    const patch: Partial<QueueFilters> = {
                      attention: id === 'stacks' ? 'all' : (id as QueueFilters['attention']),
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
                    ? history.length
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
            <SavedViewsNav state={queue.savedViews} active={!savedView} busy={viewBusy} onAction={viewAction} />
          )}
          <div className="mt-auto flex flex-col gap-1">
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
              <p>
                {section === 'saved'
                  ? 'AI explanations saved on this computer. Reopen one to continue reviewing.'
                  : section === 'stacks'
                    ? 'PRs that build on one another, grouped for review. All your other filters still apply.'
                    : section === 'requested'
                      ? 'PRs you were asked to review. Those changed since a saved AI explanation appear under Updated PRs.'
                      : section === 'updated'
                        ? 'PR content or stack changes since your saved AI explanation. This does not track when you last reviewed on GitHub.'
                        : 'Select a PR or stack for its briefing. Double-click to read its description and GitHub status.'}
              </p>
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
              {/GitHub.*(?:access|sign.in)|token|Resource not accessible/i.test(error) && <button onClick={() => setAuthOpen(true)}>Check GitHub access</button>}
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
                    <QueueFilterPanel filters={filters} items={queue.items} onChange={updateFilters} />
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
              title={section === 'saved'
                ? 'AI explanations saved on this computer'
                : 'Each stack counts as one item. Counts use loaded GitHub data; built-in sidebar totals do not apply your other filters.'}
            >
              {section === 'saved' ? `${saved.length} reviews` : `${items.length} of ${queue.items.length} items`}
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
              <span>
                {prefs?.autoBriefings === false
                  ? 'Automatic briefings are off.'
                  : filters.briefingScope === 'matches'
                    ? 'Brief matching PRs and stacks only.'
                    : 'Brief matches first, then the rest.'}
              </span>
              <button onClick={resetFilters}>Clear filters</button>
            </div>
          )}
          {section !== 'saved' && (
            <p className="queue-keyboard-help" id="queue-keyboard-help">
              <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> select · <kbd>Enter</kbd> open ·{' '}
              <kbd>/</kbd> search
            </p>
          )}
          <div className="queue-content">
            <section className="queue-list" aria-label="Review queue">
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
                      <button
                        className="queue-row-main"
                        disabled={entry.status === 'generating'}
                        onClick={() => (entry.status === 'failed' ? void start(entry.prUrl) : void open(entry))}
                      >
                        <span className="queue-title">{entry.prTitle}</span>
                        <span className="queue-meta">
                          {entry.snapshot?.subject.kind === 'stack'
                            ? `${entry.snapshot.subject.members.length} PR stack · `
                            : ''}
                          {entry.author} · {timeAgo(entry.savedAt)} ·{' '}
                          {entry.status === 'generating'
                            ? 'Generating explanation'
                            : entry.status === 'failed'
                              ? 'Generation failed'
                              : 'Explanation ready'}
                        </span>
                        {entry.error && <span className="text-xs text-destructive">{entry.error}</span>}
                      </button>
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
                (['updated', 'requested', 'other'] as const).map((category) => {
                  const group = items.filter((i) => i.attention === category);
                  return group.length ? (
                    <div key={category}>
                      <h2 className="queue-section-title">
                        {labels[category]} <span>{group.length}</span>
                      </h2>
                      {group.map(row)}
                    </div>
                  ) : null;
                })
              ) : gettingStartedVisible && !queueFailed ? null : (
                <div className="queue-empty">
                  <Inbox size={24} />
                  <h2>
                    {queueFailed
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
                    {queueFailed
                      ? 'Try loading the queue again. You can still open a PR by URL or a saved review.'
                      : filterCount > 0
                        ? 'Try fewer filters or a wider date range. One open PR must match every filter; its whole stack stays visible.'
                        : !auth?.authenticated
                          ? prefs?.guestMode
                            ? 'You are using local mode. Review a repository on this computer.'
                            : 'Connect GitHub above, or review local changes from the sidebar.'
                          : section !== 'all'
                            ? 'Try the full work queue to see other changes.'
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
                            : 'Manage repositories'}
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
                <p className="briefing-definition">
                  An AI briefing is a short summary. Open the PR overview to read the author description, or generate an AI explanation alongside the code.
                </p>
                {briefingSelection && (
                  <p className="text-xs text-muted-foreground mb-3" aria-label="Briefing model">
                    Briefing model: {briefingModelLabel}
                    {prefs?.proactiveReviewOverrides ? ' (separate model selected in Settings)' : ''}
                  </p>
                )}
                <div className="briefing-actions">
                  <Button
                    size="sm"
                    onClick={() => activate(selectedItem)}
                  >
                    {selectedItem.review?.status === 'completed' &&
                    selectedItem.review.snapshot?.fingerprint === fingerprint(selectedItem.subject)
                      ? 'Open AI explanation'
                      : 'Open PR overview'}
                    <ArrowRight size={14} />
                  </Button>
                  {selectedItem.review?.status === 'completed' && <button onClick={() => { setError(''); setOpenedItem(selectedItem); }}>Author description</button>}
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
                          <button onClick={() => {
                            setError('');
                            setOpenedItem({ attention: selectedItem.attention, subject: { id: m.url, kind: 'pr', scope: 'single', title: m.title, members: [m], edges: [], warnings: [] } });
                          }}>
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
                    A parent PR contains work that another PR builds on. Choose the dependent PR and paste its parent’s
                    full GitHub URL.
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
                    <button key={e.child} disabled={grouping} onClick={() => void correct('unlink', e.parent, e.child)}>
                      Separate #{e.child.split('/').at(-1)} from #{e.parent.split('/').at(-1)}
                    </button>
                  ))}
                </details>
              </aside>
            )}
          </div>
          <footer className="workbench-footer">
            {prefs && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={prefs.autoBriefings !== false}
                    onChange={(e) => void savePrefs({ ...prefs, autoBriefings: e.target.checked })}
                  />
                  Automatic briefings
                </label>
                <span>{queue.remaining} briefing attempts left today</span>
                <label>
                  Daily briefing limit{' '}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    aria-label="Daily briefing limit"
                    value={prefs.briefingDailyLimit ?? 10}
                    onChange={(e) =>
                      void savePrefs({
                        ...prefs,
                        briefingDailyLimit: Math.max(0, Math.min(100, Number(e.target.value))),
                      })
                    }
                  />
                </label>
              </>
            )}
            <span className="ml-auto">AI explanations start when you request them</span>
          </footer>
        </main>
      </div>}
      <GitHubAuthDialog open={authOpen} onOpenChange={setAuthOpen} onConnected={syncAuth} login={auth?.login}
        prUrl={summaryItem?.subject.members[0].url ?? (url.trim() || undefined)} />
      <SettingsDialog
        initialSection={settingsSection}
        onReplayOnboarding={replayGettingStarted}
        open={settings}
        onOpenChange={(open) => {
          setSettings(open);
          if (!open)
            void window.electronAPI.loadPreferences().then((p) => {
              setPrefs(p);
              void refresh(true);
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
