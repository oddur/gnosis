import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
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
} from 'lucide-react';
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
  updated: 'Updated since review',
  requested: 'Review requested',
  blocking: 'Blocking dependent work',
  other: 'Following',
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
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('all');
  const [section, setSection] = useState('all');
  const [selected, setSelected] = useState<string | null>(
    () => initialSubjectId ?? localStorage.getItem('gnosis-queue-selection')
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('queue');
  const [showGettingStarted, setShowGettingStarted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [url, setUrl] = useState(prefillPrUrl ?? '');
  const [showUrl, setShowUrl] = useState(!!prefillPrUrl);
  const [starting, setStarting] = useState(false);
  const [pat, setPat] = useState('');
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
  const selectedItem = queue.items.find((i) => i.subject.id === selected);
  const briefingSelection = prefs ? briefingModel(prefs) : undefined;
  const briefingModelLabel = briefingSelection
    ? `${PROVIDERS[briefingSelection.provider].label} · ${PROVIDERS[briefingSelection.provider].models.find((m) => m.id === briefingSelection.model)?.label ?? briefingSelection.model}`
    : '';

  const refresh = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      await Promise.all([
        window.electronAPI.workbenchQueue(force).then((next) => {
          if (alive.current) {
            setQueue(next);
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
    if (selected) localStorage.setItem('gnosis-queue-selection', selected);
    let cancelled = false;
    setStatuses({});
    setStatusErrors({});
    const refreshStatuses = () => {
      if (selectedItem)
        void Promise.allSettled(
          selectedItem.subject.members.map(async (m) => ({
            url: m.url,
            status: await window.electronAPI.getPrStatus(m.url),
          }))
        ).then((results) => {
          if (!cancelled) {
            setStatusErrors(
              Object.fromEntries(
                results.flatMap((r, i) =>
                  r.status === 'rejected' ? [[selectedItem.subject.members[i].url, String(r.reason)]] : []
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
  }, [selected, selectedItem?.subject.id, selectedItem?.subject.members.map((m) => m.url).join(','), statusAttempt]);
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
  }, [selected, loading, section, query, repo]);
  const savePrefs = async (next: Preferences) => {
    await window.electronAPI.savePreferences(next);
    setPrefs(next);
    void refresh();
  };
  const start = async (target: string, subject?: ReviewSubject, localTools?: boolean, standalone = false) => {
    if (!prefs) return;
    setError('');
    setStarting(true);
    try {
      const cli = await window.electronAPI.checkCliInstalled(prefs.provider);
      if (!cli.installed)
        throw new Error(`${PROVIDERS[prefs.provider].label} was not found. Open Settings → Integrations for AI setup.`);
      await window.electronAPI.startReview({
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
      if (!prefs.firstRunSeen || showGettingStarted) void dismissGettingStarted();
      setShowUrl(false);
      setUrl('');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
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
  const login = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      setError('');
      if (pat) {
        await window.electronAPI.savePat(pat);
        setPat('');
      } else await window.electronAPI.startOAuth();
      setAuth(await window.electronAPI.getAuthState());
      void refresh(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };
  const items = queue.items.filter((item) => {
    const s = item.subject;
    return (
      (section === 'all' || section === item.attention) &&
      (repo === 'all' || s.members.some((m) => m.repo === repo)) &&
      `${s.title} ${s.members.map((m) => `${m.repo} ${m.title} #${m.number} ${m.author}`).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });
  const repos = [...new Set(queue.items.flatMap((i) => i.subject.members.map((m) => m.repo)))].sort();
  const saved = useMemo(
    () => history.filter((h) => `${h.prTitle} ${h.prUrl}`.toLowerCase().includes(query.toLowerCase())),
    [history, query]
  );
  const orderedItems = (['updated', 'requested', 'blocking', 'other'] as const).flatMap((category) =>
    items.filter((item) => item.attention === category)
  );
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
    if (entry?.status === 'generating' || starting) return;
    if (entry?.status === 'completed' && entry.snapshot?.fingerprint === fingerprint(item.subject)) void open(entry);
    else void start(item.subject.members[0].url, item.subject);
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
    { enabled: !settings && !localOpen && section !== 'saved' }
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
          >
            <span className="queue-title">{s.title}</span>
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
                Generating
              </>
            ) : item.review?.status === 'completed' ? (
              <>
                <Check size={13} />
                Review ready
              </>
            ) : item.briefing?.status === 'generating' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Briefing
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
                <span className="truncate">{m.title}</span>
                <span className="ml-auto">{m.merged ? 'Merged' : m.isDraft ? 'Draft' : m.state}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="workbench-home">
      <header className="workbench-header">
        <a
          href="#"
          className="workbench-brand"
          onClick={(e) => {
            e.preventDefault();
            setSection('all');
          }}
        >
          Gnosis
        </a>
        <span className="workbench-header-separator" />
        <span className="text-sm text-muted-foreground">Review workbench</span>
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
          <WorkbenchHelp
            onGettingStarted={() => {
              setSection('all');
              setSelected(null);
              setQuery('');
              setRepo('all');
              setShowGettingStarted(true);
            }}
          />
          <button className="workbench-icon" title="Settings" aria-label="Settings" onClick={() => openSettings()}>
            <Settings size={17} />
          </button>
          <span className="text-xs text-muted-foreground account-name">{auth?.login ?? 'Local workspace'}</span>
        </div>
      </header>
      <UpdateBanner />
      <div className="workbench-body">
        <nav className="workbench-sidebar" aria-label="Workspace">
          <p className="workbench-nav-heading">Reviews</p>
          {[
            ['all', 'Work queue', Inbox],
            ['requested', 'Requested', GitPullRequest],
            ['updated', 'Updated', RefreshCw],
            ['blocking', 'Dependencies', GitBranch],
            ['saved', 'Saved reviews', Clock],
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof Inbox;
            return (
              <button
                key={id as string}
                title={label as string}
                aria-current={section === id ? 'page' : undefined}
                className={section === id ? 'active' : ''}
                onClick={() => {
                  setSection(id as string);
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
                      : queue.items.filter((i) => i.attention === id).length}
                </span>
              </button>
            );
          })}
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
                  : section === 'all'
                    ? 'Work queue'
                    : labels[section as keyof typeof labels]}
              </h1>
              <p>
                {section === 'saved'
                  ? 'Your review history, ready to resume.'
                  : 'Select a PR or stack for a short briefing; start a guided review to inspect the code.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="workbench-icon"
                aria-label="Refresh queue"
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
                void start(url);
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
              <Button size="sm" disabled={starting || !url.trim()} type="submit">
                {starting ? 'Preparing…' : 'Start guided review'}
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
                aria-label="Search reviews"
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
                placeholder="Find a change…"
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
            <span className="queue-count">
              {section === 'saved' ? saved.length : items.length} {section === 'saved' ? 'reviews' : 'changes'}
            </span>
          </div>
          {section !== 'saved' && (
            <p className="queue-keyboard-help" id="queue-keyboard-help">
              <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> select · <kbd>Enter</kbd> guided review ·{' '}
              <kbd>/</kbd> search
            </p>
          )}
          <div className="queue-content">
            <section className="queue-list" aria-label="Review queue">
              {!loading && section !== 'saved' && auth && !auth.authenticated && !prefs?.guestMode && (
                <section className="workbench-connect">
                  <h2>Connect GitHub</h2>
                  <p>Sign in to load your GitHub review requests. Local reviews work without a GitHub connection.</p>
                  <Button size="sm" disabled={connecting} onClick={() => void login()}>
                    {connecting ? 'Connecting…' : 'Sign in to GitHub'}
                  </Button>
                  <details>
                    <summary>Use a personal access token</summary>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void login();
                      }}
                    >
                      <label htmlFor="github-token">GitHub personal access token</label>
                      <input
                        id="github-token"
                        type="password"
                        aria-label="GitHub personal access token"
                        value={pat}
                        onChange={(e) => setPat(e.target.value)}
                        autoComplete="off"
                      />
                      <Button size="sm" disabled={connecting || !pat.trim()} type="submit">
                        Connect
                      </Button>
                    </form>
                  </details>
                  <button onClick={() => setLocalOpen(true)}>Review local changes</button>
                </section>
              )}
              {!loading &&
                prefs &&
                section === 'all' &&
                !query &&
                repo === 'all' &&
                (showGettingStarted || (!prefs.firstRunSeen && history.length === 0)) && (
                  <GettingStarted
                    provider={prefs.provider}
                    settingsOpen={settings}
                    onSettings={() => openSettings('integrations')}
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
                          {entry.author} · {timeAgo(entry.savedAt)} · {entry.status ?? 'completed'}
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
                (['updated', 'requested', 'blocking', 'other'] as const).map((category) => {
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
              ) : (
                <div className="queue-empty">
                  <Inbox size={24} />
                  <h2>
                    {queueFailed
                      ? 'Queue could not be loaded'
                      : query || repo !== 'all'
                        ? 'No matching changes'
                        : !auth?.authenticated
                          ? 'Your GitHub queue is not connected'
                          : section !== 'all'
                            ? `No changes in ${labels[section as keyof typeof labels].toLowerCase()}`
                            : 'No pull requests in your queue'}
                  </h2>
                  <p>
                    {queueFailed
                      ? 'Try loading the queue again. You can still open a PR by URL or a saved review.'
                      : query || repo !== 'all'
                        ? 'Clear the search and repository filter to see more changes.'
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
                      else if (query || repo !== 'all') {
                        setQuery('');
                        setRepo('all');
                      } else if (section !== 'all') setSection('all');
                      else if (!auth?.authenticated) setLocalOpen(true);
                      else openSettings();
                    }}
                  >
                    {queueFailed
                      ? 'Retry queue'
                      : query || repo !== 'all'
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
                    Discovery needs attention ({queue.warnings.length})
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
                  A briefing is a short summary. Start a guided review for explanations beside the code.
                </p>
                {briefingSelection && (
                  <p className="text-xs text-muted-foreground mb-3" aria-label="Briefing model">
                    Briefing model: {briefingModelLabel}
                    {prefs?.proactiveReviewOverrides ? ' (Settings override)' : ''}
                  </p>
                )}
                <div className="briefing-actions">
                  <Button
                    size="sm"
                    disabled={starting || selectedItem.review?.status === 'generating'}
                    onClick={() => activate(selectedItem)}
                  >
                    {selectedItem.review?.status === 'completed' &&
                    selectedItem.review.snapshot?.fingerprint === fingerprint(selectedItem.subject)
                      ? 'Continue review'
                      : 'Start guided review'}
                    <ArrowRight size={14} />
                  </Button>
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
                        : 'Freshness is unknown.'}
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
                        ? 'Preparing a short briefing…'
                        : selectedItem.briefing?.status === 'failed'
                          ? 'The briefing could not be generated. Retry it or open the guided review.'
                          : selectedItem.briefing?.status === 'cancelled'
                            ? 'Briefing cancelled. Retry it from Activity.'
                            : selectedItem.briefing?.status === 'paused'
                              ? prefs?.autoBriefings === false
                                ? 'Automatic briefings are off.'
                                : queue.remaining <= 0
                                  ? 'Daily briefing limit reached.'
                                  : 'Briefing is paused while other work runs.'
                              : 'Briefing queued. You can start the detailed review now.'}
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
                        <p>
                          {m.merged ? 'Merged' : m.isDraft ? 'Draft' : m.state} ·{' '}
                          {statuses[m.url]
                            ? `CI ${statuses[m.url]?.ciConclusion} · ${statuses[m.url]?.reviewSummary.approved} approvals`
                            : statusErrors[m.url]
                              ? 'Status unavailable'
                              : 'Loading status…'}
                        </p>
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
                          <button onClick={() => void start(m.url, undefined, undefined, true)}>
                            Review this PR only
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
                <span>{queue.remaining} remaining today</span>
                <label>
                  Daily limit{' '}
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
            <span className="ml-auto">Detailed reviews on demand</span>
          </footer>
        </main>
      </div>
      <SettingsDialog
        initialSection={settingsSection}
        onReplayOnboarding={() => {
          setSection('all');
          setQuery('');
          setRepo('all');
          setSelected(null);
          setShowGettingStarted(true);
        }}
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
