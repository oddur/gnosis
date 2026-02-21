import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LogOut,
  CircleCheck,
  Search,
  SlidersHorizontal,
  Play,
  History,
  Trash2,
  Settings,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { GitHubIcon } from '../../lib/constants';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { LoadingScreen } from '../../components/LoadingScreen';
import { PRPickerDialog } from '../../components/PRPickerDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { riskConfig } from '../../lib/constants';
import type { ModelId, Preferences, Provider, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';
import { timeAgo, formatDuration, groupReviewsByPR } from '../../lib/utils';

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
  const [instructions, setInstructions] = useState('');
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isThinkingPhase, setIsThinkingPhase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const [prPickerOpen, setPrPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cliNotFound, setCliNotFound] = useState<{ provider: string } | null>(null);
  const [expandedPRs, setExpandedPRs] = useState<Set<string>>(new Set());

  const prGroups = useMemo(() => groupReviewsByPR(history), [history]);

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
      setPrefsLoaded(true);
    });
  }, []);

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
          ...overrides,
        });
      });
    },
    [instructions, provider, model, thinking, signalBoost, smartImports]
  );

  // Auto-save when toggles or model/provider change (skip initial load)
  useEffect(() => {
    if (prefsLoaded) savePrefs();
  }, [prefsLoaded, provider, model, thinking, signalBoost, smartImports, savePrefs]);

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

  async function handleSignOut() {
    await window.electronAPI.signOut();
    setAuthStatus('unauthenticated');
  }

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!prUrl.trim()) return;

    savePrefs();
    setError(null);

    const { installed } = await window.electronAPI.checkCliInstalled(provider);
    if (!installed) {
      setCliNotFound({ provider });
      return;
    }

    setStreamingText('');
    setIsThinkingPhase(false);
    setLoading(true);

    window.electronAPI.offReviewProgress();
    window.electronAPI.onReviewProgress((chunk, isThinking) => {
      if (isThinking) {
        setIsThinkingPhase(true);
      } else {
        setIsThinkingPhase(false);
        setStreamingText((prev) => prev + chunk);
      }
    });

    try {
      const review = await window.electronAPI.generateReview({
        prUrl: prUrl.trim(),
        provider,
        model,
        instructions: instructions.trim() || undefined,
        thinking,
        signalBoost,
        smartImports,
      });
      void window.electronAPI.listReviews().then(setHistory);
      onReviewReady(review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setLoading(false);
    } finally {
      window.electronAPI.offReviewProgress();
    }
  }

  async function handleLoadFromHistory(id: string) {
    setLoading(true);
    try {
      const review = await window.electronAPI.loadReview(id);
      onReviewReady(review);
    } catch {
      setError('Failed to load saved review.');
      setLoading(false);
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

  function handleProviderChange(p: Provider) {
    setProvider(p);
    setModel(PROVIDERS[p].models[0].id);
    if (p === 'gemini') setThinking(false);
  }

  if (loading) {
    return (
      <LoadingScreen
        message={isThinkingPhase ? 'Thinking...' : 'Generating review guide...'}
        streamingText={streamingText}
      />
    );
  }

  const isAuthenticated = typeof authStatus === 'object';

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-6xl flex flex-col gap-8">
        <div className="text-center hero-glow">
          <h1 className="text-3xl font-bold tracking-tight font-display relative z-10">Gnosis</h1>
        </div>

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
            className={`grid gap-6 items-start ${prGroups.length > 0 ? 'grid-cols-[2fr_3fr]' : 'max-w-lg mx-auto w-full'}`}
          >
            {/* PR form */}
            <Card>
              <CardContent className="pt-6">
                <div className="flex justify-end items-center gap-2 mb-4">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <CircleCheck className="h-3 w-3" />@{(authStatus as { login: string }).login}
                  </span>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    aria-label="Settings"
                  >
                    <Settings className="h-3 w-3" />
                  </button>
                  <button
                    onClick={handleSignOut}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <LogOut className="h-3 w-3" />
                    Sign out
                  </button>
                </div>
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
                      <Button type="button" variant="outline" onClick={() => setPrPickerOpen(true)} className="gap-1.5">
                        <Search className="h-3.5 w-3.5" />
                        Browse
                      </Button>
                    </div>
                  </div>
                  <PRPickerDialog open={prPickerOpen} onOpenChange={setPrPickerOpen} onSelect={setPrUrl} />
                  <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

                  <Dialog open={cliNotFound !== null} onOpenChange={() => setCliNotFound(null)}>
                    <DialogContent className="bg-card sm:max-w-md">
                      <DialogHeader>
                        <DialogTitle>
                          {cliNotFound?.provider === 'claude' ? 'Claude' : 'Gemini'} CLI not found
                        </DialogTitle>
                      </DialogHeader>
                      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                        <p>
                          The {cliNotFound?.provider === 'claude' ? 'Claude' : 'Gemini'} CLI could not be found on your
                          system. Gnosis uses the CLI to generate reviews.
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

                  {provider === 'claude' && (
                    <ToggleSwitch
                      id="thinking"
                      label="Extended thinking"
                      description={thinking ? 'Deeper reasoning · slower' : 'Standard speed'}
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

                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

                  <Button type="submit" className="w-full gap-2">
                    <Play className="h-4 w-4" />
                    Generate Review
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* History */}
            {prGroups.length > 0 && (
              <Card className="min-h-0 max-h-[calc(100vh-12rem)] sticky top-8 overflow-hidden flex flex-col bg-card/50">
                <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <History className="h-3 w-3" />
                    Review history
                  </p>
                  <button
                    onClick={handleDeleteAllHistory}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete all history"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <CardContent className="p-0 flex-1 overflow-y-auto min-h-0">
                  <ul className="divide-y">
                    {prGroups.map((group) => {
                      const risk = riskConfig[group.latestReview.riskLevel];
                      const hasMultiple = group.reviews.length > 1;
                      const isExpanded = expandedPRs.has(group.prUrl);

                      return (
                        <li key={group.prUrl}>
                          <div className="flex items-center gap-1 px-4 py-3 hover:bg-muted/50 transition-colors group">
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
                              onClick={() => handleLoadFromHistory(group.latestReview.id)}
                              className="flex-1 min-w-0 flex items-center gap-3 text-left"
                            >
                              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                <span className="text-sm font-medium truncate">{group.prTitle}</span>
                                <span className="text-xs text-muted-foreground truncate">
                                  {group.repoRef} · {group.author} · {timeAgo(group.latestReview.savedAt)}
                                  {hasMultiple && ` · ${group.reviews.length} reviews`}
                                </span>
                              </div>
                            </button>
                            <Badge variant="outline" className={`shrink-0 text-xs ${risk.badgeClassName}`}>
                              {risk.label}
                            </Badge>
                            <div className="shrink-0 w-7 flex items-center justify-center">
                              {!hasMultiple && (
                                <button
                                  onClick={(e) => handleDeleteFromHistory(e, group.latestReview.id)}
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
                                const reviewRisk = riskConfig[review.riskLevel];
                                return (
                                  <li key={review.id}>
                                    <button
                                      onClick={() => handleLoadFromHistory(review.id)}
                                      className="w-full flex items-center gap-3 pl-10 pr-4 py-2 text-left hover:bg-muted/30 transition-colors group/review"
                                    >
                                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                        <span className="text-xs text-muted-foreground truncate">
                                          {review.model ? (MODEL_LABELS[review.model] ?? review.model) : 'Unknown'}
                                          {review.generationDurationMs != null &&
                                            ` · ${formatDuration(review.generationDurationMs)}`}
                                          {' · '}
                                          {timeAgo(review.savedAt)}
                                        </span>
                                      </div>
                                      <Badge
                                        variant="outline"
                                        className={`shrink-0 text-xs ${reviewRisk.badgeClassName}`}
                                      >
                                        {reviewRisk.label}
                                      </Badge>
                                      <button
                                        onClick={(e) => handleDeleteFromHistory(e, review.id)}
                                        className="shrink-0 opacity-0 group-hover/review:opacity-100 text-muted-foreground hover:text-destructive transition-opacity px-1"
                                        aria-label="Delete"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
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
