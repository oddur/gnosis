import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LogOut,
  Search,
  SlidersHorizontal,
  Play,
  History,
  Trash2,
  Settings,
  ChevronDown,
  ChevronRight,
  Loader2,
  CircleX,
  FileText,
  RefreshCw,
  X,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  AlertTriangle,
  Eraser,
} from 'lucide-react';
import { GitHubIcon } from '../../lib/constants';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { PRPickerDialog } from '../../components/PRPickerDialog';
import { FilePickerDialog } from '../../components/FilePickerDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { riskConfig } from '../../lib/constants';
import type { ModelId, Preferences, Provider, PrSearchResult, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';
import { timeAgo, formatDuration, formatBytes, groupReviewsByPR } from '../../lib/utils';

interface Props {
  onReviewReady: (review: ReviewGuide) => void;
  prefillPrUrl?: string;
}

type AuthStatus = 'checking' | 'unauthenticated' | 'signing-in' | { login: string };

const PROVIDERS = {
  claude: {
    label: 'Claude',
    models: [
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  gemini: {
    label: 'Gemini',
    models: [
      { id: 'gemini-3.1-pro-preview', label: '3.1 Pro' },
      { id: 'gemini-3-pro-preview', label: '3 Pro' },
      { id: 'gemini-3-flash-preview', label: '3 Flash' },
      { id: 'gemini-2.5-pro', label: '2.5 Pro' },
      { id: 'gemini-2.5-flash', label: '2.5 Flash' },
    ],
  },
} as const;

const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDERS).flatMap((p) => p.models.map((m) => [m.id, `${p.label} ${m.label}`]))
);

function getEntryStatus(entry: ReviewHistoryEntry): 'generating' | 'completed' | 'failed' {
  return entry.status ?? 'completed';
}

// ── Reusable toggle switch ──────────────────────────────────────

interface ToggleSwitchProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  badge?: string;
}

function ToggleSwitch({ id, label, description, checked, onToggle, badge }: ToggleSwitchProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
          {badge && (
            <>
              {' '}
              <span className="ml-1 inline-block rounded bg-teal-900/60 px-1.5 py-0.5 text-[10px] font-medium text-teal-300 leading-none align-middle">
                {badge}
              </span>
            </>
          )}
        </label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          checked ? 'bg-primary' : 'bg-input'
        }`}
      >
        <span
          className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────

export function HomePage({ onReviewReady, prefillPrUrl }: Props) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [prUrl, setPrUrl] = useState(prefillPrUrl ?? '');
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState<ModelId>('claude-opus-4-6');
  const [thinking, setThinking] = useState(true);
  const [signalBoost, setSignalBoost] = useState(true);
  const [smartImports, setSmartImports] = useState(true);
  const [reviewSuggestions, setReviewSuggestions] = useState(true);
  const [webResearch, setWebResearch] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const [includeAllFiles, setIncludeAllFiles] = useState(true);
  const [prPickerOpen, setPrPickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cliNotFound, setCliNotFound] = useState<{ provider: string } | null>(null);
  const [expandedPRs, setExpandedPRs] = useState<Set<string>>(new Set());
  const [reviewPhases, setReviewPhases] = useState<Map<string, string>>(new Map());
  const [pendingReviews, setPendingReviews] = useState<PrSearchResult[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [dismissedPendingPrs, setDismissedPendingPrs] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('dismissed-pending-prs');
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [generationStartTimes, setGenerationStartTimes] = useState<Map<string, number>>(new Map());
  const [elapsedSeconds, setElapsedSeconds] = useState<Map<string, number>>(new Map());
  const [reviewBytes, setReviewBytes] = useState<Map<string, { inputBytes: number; outputBytes: number }>>(new Map());
  const [livePrStates, setLivePrStates] = useState<
    Map<string, { prState: 'open' | 'merged' | 'closed'; headSha: string }>
  >(new Map());
  const [patExpanded, setPatExpanded] = useState(false);
  const [patToken, setPatToken] = useState('');
  const [patError, setPatError] = useState<string | null>(null);
  const [patConnecting, setPatConnecting] = useState(false);

  const prGroups = useMemo(() => groupReviewsByPR(history), [history]);

  useEffect(() => {
    window.electronAPI.onNewReviewInHistory(() => {
      void window.electronAPI.listReviews().then(setHistory);
    });
    return () => {
      window.electronAPI.offNewReviewInHistory();
    };
  }, []);

  useEffect(() => {
    void window.electronAPI.getAuthState().then(({ authenticated, login }) => {
      setAuthStatus(authenticated && login ? { login } : 'unauthenticated');
    });
    void window.electronAPI.listReviews().then(setHistory);
    void window.electronAPI.loadPreferences().then((prefs) => {
      if (prefs.instructions) setInstructions(prefs.instructions);
      setProvider(prefs.provider);
      setModel(prefs.model);
      setThinking(prefs.thinking);
      setSignalBoost(prefs.signalBoost);
      setSmartImports(prefs.smartImports);
      setReviewSuggestions(prefs.reviewSuggestions);
      setWebResearch(prefs.enableWebResearch);
      setIncludeAllFiles(prefs.includeAllFiles);
      setPrefsLoaded(true);
    });
  }, []);

  // Listen for background review phase changes, completion, failure, and stats
  useEffect(() => {
    window.electronAPI.onReviewPhase((reviewId, phase) => {
      setReviewPhases((prev) => new Map(prev).set(reviewId, phase));
    });
    window.electronAPI.onReviewProgress((reviewId, chunk, isThinking) => {
      if (!isThinking) {
        setReviewBytes((prev) => {
          const next = new Map(prev);
          const existing = next.get(reviewId) ?? { inputBytes: 0, outputBytes: 0 };
          next.set(reviewId, { ...existing, outputBytes: existing.outputBytes + chunk.length });
          return next;
        });
      }
    });
    window.electronAPI.onReviewStats((reviewId, inputBytes) => {
      setReviewBytes((prev) => {
        const next = new Map(prev);
        const existing = next.get(reviewId) ?? { inputBytes: 0, outputBytes: 0 };
        next.set(reviewId, { ...existing, inputBytes });
        return next;
      });
    });
    const clearReview = (reviewId: string) => {
      setReviewPhases((prev) => {
        const next = new Map(prev);
        next.delete(reviewId);
        return next;
      });
      setGenerationStartTimes((prev) => {
        const next = new Map(prev);
        next.delete(reviewId);
        return next;
      });
      setElapsedSeconds((prev) => {
        const next = new Map(prev);
        next.delete(reviewId);
        return next;
      });
    };
    window.electronAPI.onReviewCompleted((reviewId) => {
      clearReview(reviewId);
      void window.electronAPI.listReviews().then(setHistory);
    });
    window.electronAPI.onReviewFailed((reviewId) => {
      clearReview(reviewId);
      void window.electronAPI.listReviews().then(setHistory);
    });
    return () => {
      window.electronAPI.offReviewPhase();
      window.electronAPI.offReviewProgress();
      window.electronAPI.offReviewStats();
      window.electronAPI.offReviewCompleted();
      window.electronAPI.offReviewFailed();
    };
  }, []);

  const fetchPendingReviews = useCallback(() => {
    setPendingLoading(true);
    void window.electronAPI
      .searchPullRequests()
      .then((results) => {
        setPendingReviews(results.filter((r) => r.role === 'review-requested' && !r.isDraft));
      })
      .catch(() => {})
      .finally(() => setPendingLoading(false));
  }, []);

  useEffect(() => {
    if (typeof authStatus !== 'object') return;
    fetchPendingReviews();
  }, [authStatus, fetchPendingReviews]);

  function dismissPendingPr(url: string) {
    setDismissedPendingPrs((prev) => {
      const next = new Set(prev);
      next.add(url);
      localStorage.setItem('dismissed-pending-prs', JSON.stringify([...next]));
      return next;
    });
  }

  const visiblePendingReviews = useMemo(
    () => pendingReviews.filter((pr) => !dismissedPendingPrs.has(pr.url)),
    [pendingReviews, dismissedPendingPrs]
  );

  // Tick elapsed seconds for active generations
  useEffect(() => {
    if (generationStartTimes.size === 0) return;
    const id = setInterval(() => {
      setElapsedSeconds((prev) => {
        const next = new Map(prev);
        for (const [reviewId, startTime] of generationStartTimes) {
          next.set(reviewId, Math.floor((Date.now() - startTime) / 1000));
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [generationStartTimes]);

  // Fetch live PR state for each unique PR URL in history
  useEffect(() => {
    if (prGroups.length === 0) return;
    for (const group of prGroups) {
      void window.electronAPI
        .getPrState(group.prUrl)
        .then((live) => {
          setLivePrStates((prev) => new Map(prev).set(group.prUrl, live));
        })
        .catch(() => {});
    }
  }, [prGroups]);

  const savePrefs = useCallback(
    (overrides?: Partial<Preferences>) => {
      void window.electronAPI.loadPreferences().then((current) => {
        void window.electronAPI.savePreferences({
          ...current,
          instructions,
          provider,
          model,
          thinking,
          signalBoost,
          smartImports,
          reviewSuggestions,
          enableWebResearch: webResearch,
          includeAllFiles,
          ...overrides,
        });
      });
    },
    [
      instructions,
      provider,
      model,
      thinking,
      signalBoost,
      smartImports,
      reviewSuggestions,
      webResearch,
      includeAllFiles,
    ]
  );

  // Auto-save when toggles or model/provider change (skip initial load)
  useEffect(() => {
    if (prefsLoaded) savePrefs();
  }, [
    prefsLoaded,
    provider,
    model,
    thinking,
    signalBoost,
    smartImports,
    reviewSuggestions,
    webResearch,
    includeAllFiles,
    savePrefs,
  ]);

  async function handleSignIn() {
    setAuthError(null);
    setAuthStatus('signing-in');
    try {
      await window.electronAPI.startOAuth();
      const { login } = await window.electronAPI.getAuthState();
      setAuthStatus(login ? { login } : 'unauthenticated');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in failed.');
      setAuthStatus('unauthenticated');
    }
  }

  async function handleConnectPat() {
    const trimmed = patToken.trim();
    if (!trimmed || patConnecting) return;
    setPatError(null);
    setPatConnecting(true);
    try {
      const login = await window.electronAPI.savePat(trimmed);
      setAuthStatus({ login });
      setPatToken('');
      setPatExpanded(false);
    } catch (err) {
      setPatError(err instanceof Error ? err.message : 'Failed to connect token.');
    } finally {
      setPatConnecting(false);
    }
  }

  async function handleSignOut() {
    await window.electronAPI.signOut();
    setAuthStatus('unauthenticated');
  }

  async function doStartReview(excludedFiles: string[]) {
    setSubmitting(true);
    try {
      const result = await window.electronAPI.startReview({
        prUrl: prUrl.trim(),
        provider,
        model,
        instructions: instructions.trim() || undefined,
        thinking,
        signalBoost,
        smartImports,
        reviewSuggestions,
        webResearch,
        excludedFiles: excludedFiles.length > 0 ? excludedFiles : undefined,
      });
      setGenerationStartTimes((prev) => new Map(prev).set(result.reviewId, Date.now()));
      const updated = await window.electronAPI.listReviews();
      setHistory(updated);
      setPrUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start review.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!prUrl.trim() || submitting) return;

    savePrefs();
    setError(null);

    const { installed } = await window.electronAPI.checkCliInstalled(provider);
    if (!installed) {
      setCliNotFound({ provider });
      return;
    }

    if (!includeAllFiles) {
      setFilePickerOpen(true);
      return;
    }

    void doStartReview([]);
  }

  async function handleLoadFromHistory(id: string) {
    try {
      const [review] = await Promise.all([
        window.electronAPI.loadReview(id),
        window.electronAPI.markReviewRead(id),
      ]);
      setHistory((prev) => prev.map((e) => (e.id === id ? { ...e, unread: false } : e)));
      onReviewReady(review);
    } catch {
      setError('Failed to load saved review.');
    }
  }

  async function handleDeleteFromHistory(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await window.electronAPI.deleteReview(id);
    setHistory((prev) => prev.filter((h) => h.id !== id));
  }

  async function handleDeleteAllHistory() {
    await window.electronAPI.deleteAllReviews();
    setHistory([]);
    setExpandedPRs(new Set());
  }

  async function handleDeleteClosedPRs() {
    const toDelete = history.filter((entry) => {
      const live = livePrStates.get(entry.prUrl);
      const state = live?.prState ?? entry.prState;
      return state === 'merged' || state === 'closed';
    });
    await Promise.all(toDelete.map((entry) => window.electronAPI.deleteReview(entry.id)));
    const deletedIds = new Set(toDelete.map((e) => e.id));
    const deletedUrls = new Set(toDelete.map((e) => e.prUrl));
    setHistory((prev) => prev.filter((e) => !deletedIds.has(e.id)));
    setExpandedPRs((prev) => {
      const next = new Set(prev);
      for (const url of deletedUrls) next.delete(url);
      return next;
    });
  }

  function handleProviderChange(p: Provider) {
    setProvider(p);
    setModel(PROVIDERS[p].models[0].id);
    if (p === 'gemini') setThinking(false);
  }

  const isAuthenticated = typeof authStatus === 'object';

  return (
    <main className="h-screen overflow-y-auto p-8">
      <div className="w-full max-w-6xl mx-auto flex flex-col gap-6">
        {/* Auth section */}
        {authStatus === 'checking' && (
          <div className="flex justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">Loading…</span>
          </div>
        )}

        {authStatus === 'unauthenticated' && (
          <>
            {authError && (
              <Alert variant="destructive">
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
            <Card className="max-w-md mx-auto w-full">
              <CardContent className="flex flex-col gap-3 items-center text-center">
                <p className="text-sm text-muted-foreground">Sign into your GitHub account</p>
                <Button onClick={handleSignIn} className="w-full gap-2">
                  <GitHubIcon className="h-4 w-4" />
                  Sign in with GitHub
                </Button>
                <div className="w-full border-t" />
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    setPatExpanded((v) => !v);
                    setPatError(null);
                  }}
                >
                  {patExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Use a Personal Access Token
                </button>
                {patExpanded && (
                  <div className="w-full flex flex-col gap-2 text-left">
                    <p className="text-xs text-muted-foreground">
                      Create a token with <code className="font-mono">repo</code> scope at{' '}
                      <button
                        type="button"
                        className="underline hover:text-foreground"
                        onClick={() =>
                          void window.electronAPI.openExternal(
                            'https://github.com/settings/tokens/new?scopes=repo&description=Gnosis'
                          )
                        }
                      >
                        github.com/settings/tokens
                      </button>
                      , then paste it below.
                    </p>
                    <input
                      type="password"
                      placeholder="ghp_…"
                      value={patToken}
                      onChange={(e) => setPatToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleConnectPat();
                      }}
                      className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {patError && (
                      <Alert variant="destructive">
                        <AlertDescription>{patError}</AlertDescription>
                      </Alert>
                    )}
                    <Button
                      onClick={() => void handleConnectPat()}
                      disabled={!patToken.trim() || patConnecting}
                      className="w-full"
                      size="sm"
                    >
                      {patConnecting ? 'Connecting…' : 'Connect'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {authStatus === 'signing-in' && (
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="text-sm text-muted-foreground animate-pulse">
              Waiting for GitHub… complete sign-in in your browser.
            </span>
          </div>
        )}

        {/* Two-column layout: form + history */}
        {isAuthenticated && (
          <div
            className={`grid gap-6 items-start ${prGroups.length > 0 ? 'grid-cols-[420px_1fr]' : 'max-w-lg mx-auto w-full'}`}
          >
            {/* Left column: account card + form card */}
            <div className="flex flex-col gap-4">
              {/* Account card */}
              <Card>
                <CardContent className="py-2 px-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center gap-2">
                    <Avatar className="h-5 w-5">
                      <AvatarImage
                        src={`https://github.com/${(authStatus as { login: string }).login}.png`}
                        alt={(authStatus as { login: string }).login}
                      />
                      <AvatarFallback className="text-[10px]">
                        {(authStatus as { login: string }).login.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    @{(authStatus as { login: string }).login}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setSettingsOpen(true)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                      aria-label="Settings"
                    >
                      <Settings className="h-3 w-3" />
                      Settings
                    </button>
                    <button
                      onClick={handleSignOut}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <LogOut className="h-3 w-3" />
                      Sign out
                    </button>
                  </div>
                </CardContent>
              </Card>

              {/* PR form */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">New Review</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="pr-url" className="text-sm font-medium flex items-center gap-1.5">
                        <GitHubIcon className="h-3.5 w-3.5" />
                        Pull Request URL
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="pr-url"
                          type="url"
                          placeholder="https://github.com/owner/repo/pull/123"
                          value={prUrl}
                          onChange={(e) => setPrUrl(e.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          required
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setPrPickerOpen(true)}
                          className="gap-1.5"
                        >
                          <Search className="h-3.5 w-3.5" />
                          Browse
                        </Button>
                      </div>
                    </div>
                    <PRPickerDialog open={prPickerOpen} onOpenChange={setPrPickerOpen} onSelect={setPrUrl} />
                    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
                    <FilePickerDialog
                      open={filePickerOpen}
                      onOpenChange={setFilePickerOpen}
                      prUrl={prUrl.trim()}
                      onConfirm={(excluded) => {
                        setFilePickerOpen(false);
                        void doStartReview(excluded);
                      }}
                    />

                    <Dialog open={cliNotFound !== null} onOpenChange={() => setCliNotFound(null)}>
                      <DialogContent className="bg-card sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>
                            {cliNotFound?.provider === 'claude' ? 'Claude' : 'Gemini'} CLI not found
                          </DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                          <p>
                            The {cliNotFound?.provider === 'claude' ? 'Claude' : 'Gemini'} CLI could not be found on
                            your system. Gnosis uses the CLI to generate reviews.
                          </p>
                          <p>
                            {cliNotFound?.provider === 'claude'
                              ? 'Install it from claude.ai/code and authenticate with `claude auth`.'
                              : 'Install it from github.com/google-gemini/gemini-cli and authenticate.'}
                          </p>
                          <p>
                            If the CLI is already installed but not detected, you can set the path manually in Settings.
                          </p>
                        </div>
                        <div className="flex gap-2 justify-end pt-2">
                          <Button variant="outline" onClick={() => setCliNotFound(null)}>
                            Dismiss
                          </Button>
                          <Button
                            onClick={() => {
                              setCliNotFound(null);
                              setSettingsOpen(true);
                            }}
                          >
                            Open Settings
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>

                    {/* Pending review requests */}
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Pending reviews
                        </label>
                        <button
                          type="button"
                          onClick={fetchPendingReviews}
                          disabled={pendingLoading}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                          aria-label="Reload pending reviews"
                        >
                          <RefreshCw className={`h-3 w-3 ${pendingLoading ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                      {pendingLoading ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Loading…
                        </div>
                      ) : visiblePendingReviews.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1">No pending reviews</p>
                      ) : (
                        <>
                          {visiblePendingReviews.slice(0, 10).map((pr) => (
                            <div
                              key={pr.url}
                              className="group flex items-center gap-1 rounded-md hover:bg-muted/50 transition-colors min-w-0 pr-1"
                            >
                              <button
                                type="button"
                                onClick={() => setPrUrl(pr.url)}
                                className="flex items-center gap-2 text-left flex-1 px-2 py-1.5 min-w-0"
                              >
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {pr.repoName} #{pr.number}
                                </span>
                                <span className="text-sm truncate">{pr.title}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => dismissPendingPr(pr.url)}
                                className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                aria-label="Dismiss"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                          {visiblePendingReviews.length > 10 && (
                            <button
                              type="button"
                              onClick={() => setPrPickerOpen(true)}
                              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 text-left"
                            >
                              Show {visiblePendingReviews.length - 10} more…
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="instructions" className="text-sm font-medium flex items-center gap-1.5">
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        Instructions <span className="text-muted-foreground font-normal">(optional)</span>
                      </label>
                      <textarea
                        id="instructions"
                        rows={5}
                        placeholder="e.g. focus on performance, flag any security concerns, explain the auth flow"
                        value={instructions}
                        onChange={(e) => setInstructions(e.target.value)}
                        onBlur={() => savePrefs()}
                        className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">Provider</label>
                      <div className="flex gap-2">
                        {(['claude', 'gemini'] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => handleProviderChange(p)}
                            className={`flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                              provider === p
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30'
                            }`}
                          >
                            {PROVIDERS[p].label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">Model</label>
                      <div className="flex flex-wrap gap-2">
                        {PROVIDERS[provider].models.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setModel(m.id)}
                            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                              model === m.id
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30'
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <ToggleSwitch
                      id="include-all-files"
                      label="Include all files"
                      description={
                        includeAllFiles
                          ? 'All changed files included in the review'
                          : 'You will choose which files to include'
                      }
                      checked={includeAllFiles}
                      onToggle={() => setIncludeAllFiles((v) => !v)}
                    />

                    {provider === 'claude' && (
                      <ToggleSwitch
                        id="thinking"
                        label="Extended thinking"
                        description="Claude reasons through the code before writing. Catches subtle bugs and design issues standard mode misses, but takes longer."
                        checked={thinking}
                        onToggle={() => setThinking((t) => !t)}
                      />
                    )}

                    <ToggleSwitch
                      id="signal-boost"
                      label="Signal boost"
                      description="Skip trivial changes, focus on design and complexity"
                      checked={signalBoost}
                      onToggle={() => setSignalBoost((s) => !s)}
                      badge="Experimental"
                    />

                    <ToggleSwitch
                      id="smart-imports"
                      label="Smart imports"
                      description="Use AI to find related files across all languages"
                      checked={smartImports}
                      onToggle={() => setSmartImports((s) => !s)}
                      badge="Experimental"
                    />

                    <ToggleSwitch
                      id="review-suggestions"
                      label="Review suggestions"
                      description="Generate 'What to check' for each slide"
                      checked={reviewSuggestions}
                      onToggle={() => setReviewSuggestions((r) => !r)}
                    />

                    {provider === 'claude' && (
                      <ToggleSwitch
                        id="web-research"
                        label="Web research"
                        description="Search for framework docs and best practices (slower)"
                        checked={webResearch}
                        onToggle={() => setWebResearch((w) => !w)}
                      />
                    )}

                    {error && (
                      <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}

                    <Button type="submit" className="w-full gap-2" disabled={submitting}>
                      {submitting ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Starting…
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4" />
                          Generate Review
                        </>
                      )}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </div>

            {/* History */}
            {prGroups.length > 0 && (
              <Card className="min-h-0 max-h-[calc(100vh-6rem)] sticky top-8 overflow-hidden flex flex-col bg-card/50">
                <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <History className="h-3 w-3" />
                    Review history
                  </p>
                  <div className="flex items-center gap-2">
                    {prGroups.some((g) => {
                      const state = livePrStates.get(g.prUrl)?.prState ?? g.latestReview.prState;
                      return state === 'merged' || state === 'closed';
                    }) && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => void handleDeleteClosedPRs()}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Eraser className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Remove merged &amp; closed PRs</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={handleDeleteAllHistory}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Delete all history</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <CardContent className="p-0 flex-1 overflow-y-auto min-h-0">
                  <ul className="divide-y">
                    {prGroups.map((group) => {
                      const latestStatus = getEntryStatus(group.latestReview);
                      const risk = riskConfig[group.latestReview.riskLevel];
                      const hasMultiple = group.reviews.length > 1;
                      const isExpanded = expandedPRs.has(group.prUrl);
                      const isClickable = latestStatus === 'completed';
                      const latestId = group.latestReview.id;
                      const elapsed = elapsedSeconds.get(latestId) ?? 0;
                      const bytes = reviewBytes.get(latestId);
                      const liveState = livePrStates.get(group.prUrl);
                      const prState = liveState?.prState ?? group.latestReview.prState;
                      const isOutdated =
                        liveState?.prState === 'open' && liveState.headSha !== group.latestReview.prHeadSha;

                      return (
                        <li key={group.prUrl}>
                          <div
                            className={`flex items-center gap-1 px-4 py-3 hover:bg-muted/50 transition-colors group ${isClickable ? 'cursor-pointer' : ''}`}
                          >
                            <div className="shrink-0 w-5 flex items-center justify-center">
                              {hasMultiple && (
                                <button
                                  onClick={() =>
                                    setExpandedPRs((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(group.prUrl)) next.delete(group.prUrl);
                                      else next.add(group.prUrl);
                                      return next;
                                    })
                                  }
                                  className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              )}
                            </div>
                            <button
                              onClick={() => isClickable && handleLoadFromHistory(latestId)}
                              className={`flex-1 min-w-0 flex items-center gap-3 text-left ${!isClickable ? 'cursor-default' : ''}`}
                              disabled={!isClickable}
                            >
                              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                <span className="text-sm font-medium truncate flex items-center gap-2">
                                  {group.latestReview.unread && (
                                    <span className="shrink-0 h-2 w-2 rounded-full bg-blue-500" title="Unread" />
                                  )}
                                  {group.prTitle}
                                </span>
                                <span className="text-xs text-muted-foreground truncate">
                                  {group.repoRef} · {group.author} · {timeAgo(group.latestReview.savedAt)}
                                  {hasMultiple && ` · ${group.reviews.length} reviews`}
                                </span>
                                {latestStatus === 'generating' && bytes && bytes.inputBytes > 0 && (
                                  <span className="text-xs text-muted-foreground/60 truncate">
                                    ↑{formatBytes(bytes.inputBytes)} ↓{formatBytes(bytes.outputBytes)}
                                  </span>
                                )}
                              </div>
                            </button>
                            {prState && (
                              <>
                                {prState === 'open' && !isOutdated && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-xs border-green-500/30 text-green-400"
                                  >
                                    <GitPullRequest className="h-3 w-3 mr-1" />
                                    Open
                                  </Badge>
                                )}
                                {prState === 'open' && isOutdated && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-xs border-yellow-500/30 text-yellow-400"
                                  >
                                    <AlertTriangle className="h-3 w-3 mr-1" />
                                    Outdated
                                  </Badge>
                                )}
                                {prState === 'merged' && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-xs border-purple-500/30 text-purple-400"
                                  >
                                    <GitMerge className="h-3 w-3 mr-1" />
                                    Merged
                                  </Badge>
                                )}
                                {prState === 'closed' && (
                                  <Badge variant="outline" className="shrink-0 text-xs border-red-500/30 text-red-400">
                                    <GitPullRequestClosed className="h-3 w-3 mr-1" />
                                    Closed
                                  </Badge>
                                )}
                              </>
                            )}
                            {latestStatus === 'generating' && (
                              <Badge variant="outline" className="shrink-0 text-xs border-blue-500/30 text-blue-400">
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                {reviewPhases.get(latestId) ?? 'Starting'}
                                {elapsed > 0 && ` · ${formatDuration(elapsed * 1000)}`}
                              </Badge>
                            )}
                            {latestStatus === 'failed' && (
                              <Badge
                                variant="outline"
                                className="shrink-0 text-xs border-red-500/30 text-red-400 max-w-[200px]"
                                title={group.latestReview.error ?? 'Failed'}
                              >
                                <CircleX className="h-3 w-3 mr-1 shrink-0" />
                                <span className="truncate">{group.latestReview.error ?? 'Failed'}</span>
                              </Badge>
                            )}
                            {latestStatus === 'completed' && (
                              <Badge variant="outline" className={`shrink-0 text-xs ${risk.badgeClassName}`}>
                                {risk.label}
                              </Badge>
                            )}
                            <div className="shrink-0 flex items-center gap-0.5">
                              {!hasMultiple && latestStatus === 'generating' && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void window.electronAPI.cancelReview(latestId);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity px-1"
                                  aria-label="Cancel review"
                                  title="Cancel this review"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {!hasMultiple && latestStatus !== 'generating' && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void window.electronAPI.openReviewPrompt(latestId);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity px-1"
                                  aria-label="View prompt"
                                  title="Open the prompt sent to the AI"
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                </button>
                              )}
                              {!hasMultiple && latestStatus !== 'generating' && (
                                <button
                                  onClick={(e) => handleDeleteFromHistory(e, latestId)}
                                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity px-1"
                                  aria-label="Delete"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          {hasMultiple && isExpanded && (
                            <ul className="border-t border-border/50">
                              {group.reviews.map((review) => {
                                const reviewStatus = getEntryStatus(review);
                                const reviewRisk = riskConfig[review.riskLevel];
                                const reviewClickable = reviewStatus === 'completed';
                                const reviewElapsed = elapsedSeconds.get(review.id) ?? 0;
                                const reviewBytesEntry = reviewBytes.get(review.id);
                                return (
                                  <li key={review.id}>
                                    <button
                                      onClick={() => reviewClickable && handleLoadFromHistory(review.id)}
                                      className={`w-full flex items-center gap-3 pl-10 pr-4 py-2 text-left hover:bg-muted/30 transition-colors group/review ${!reviewClickable ? 'cursor-default' : ''}`}
                                      disabled={!reviewClickable}
                                    >
                                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                        <span className="text-xs text-muted-foreground truncate">
                                          {review.model ? (MODEL_LABELS[review.model] ?? review.model) : 'Unknown'}
                                          {review.generationDurationMs != null &&
                                            ` · ${formatDuration(review.generationDurationMs)}`}
                                          {' · '}
                                          {timeAgo(review.savedAt)}
                                        </span>
                                        {reviewStatus === 'generating' &&
                                          reviewBytesEntry &&
                                          reviewBytesEntry.inputBytes > 0 && (
                                            <span className="text-xs text-muted-foreground/60 truncate">
                                              ↑{formatBytes(reviewBytesEntry.inputBytes)} ↓
                                              {formatBytes(reviewBytesEntry.outputBytes)}
                                            </span>
                                          )}
                                      </div>
                                      {reviewStatus === 'generating' && (
                                        <Badge
                                          variant="outline"
                                          className="shrink-0 text-xs border-blue-500/30 text-blue-400"
                                        >
                                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                          {reviewPhases.get(review.id) ?? 'Starting'}
                                          {reviewElapsed > 0 && ` · ${formatDuration(reviewElapsed * 1000)}`}
                                        </Badge>
                                      )}
                                      {reviewStatus === 'failed' && (
                                        <Badge
                                          variant="outline"
                                          className="shrink-0 text-xs border-red-500/30 text-red-400 max-w-[200px]"
                                          title={review.error ?? 'Failed'}
                                        >
                                          <CircleX className="h-3 w-3 mr-1 shrink-0" />
                                          <span className="truncate">{review.error ?? 'Failed'}</span>
                                        </Badge>
                                      )}
                                      {reviewStatus === 'completed' && (
                                        <Badge
                                          variant="outline"
                                          className={`shrink-0 text-xs ${reviewRisk.badgeClassName}`}
                                        >
                                          {reviewRisk.label}
                                        </Badge>
                                      )}
                                      {reviewStatus === 'generating' && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void window.electronAPI.cancelReview(review.id);
                                          }}
                                          className="shrink-0 opacity-0 group-hover/review:opacity-100 text-muted-foreground hover:text-destructive transition-opacity px-1"
                                          aria-label="Cancel review"
                                          title="Cancel this review"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      {reviewStatus !== 'generating' && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void window.electronAPI.openReviewPrompt(review.id);
                                          }}
                                          className="shrink-0 opacity-0 group-hover/review:opacity-100 text-muted-foreground hover:text-foreground transition-opacity px-1"
                                          aria-label="View prompt"
                                          title="Open the prompt sent to the AI"
                                        >
                                          <FileText className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      {reviewStatus !== 'generating' && (
                                        <button
                                          onClick={(e) => handleDeleteFromHistory(e, review.id)}
                                          className="shrink-0 opacity-0 group-hover/review:opacity-100 text-muted-foreground hover:text-destructive transition-opacity px-1"
                                          aria-label="Delete"
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
