import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Play,
  Trash2,
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
  Share2,
  Upload,
} from 'lucide-react';
import { GitHubIcon } from '../../lib/constants';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { PRPickerDialog } from '../../components/PRPickerDialog';
import { FilePickerDialog } from '../../components/FilePickerDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { ShortcutOverlay } from '../../components/ShortcutOverlay';
import { CommandPalette, type Command } from '../../components/CommandPalette';
import { useKeyboardShortcuts, type ShortcutMap } from '../../lib/use-keyboard-shortcuts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { OnboardingRepoSetup } from '../../components/OnboardingRepoSetup';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { riskConfig, safeConfigLookup } from '../../lib/constants';
import type { ModelId, Preferences, Provider, PrSearchResult, ReviewGuide, ReviewHistoryEntry, UpdateInfo } from '../../lib/types';
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
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
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
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5 min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
          {badge && (
            <>
              {' '}
              <span className="statusPill-amber ml-1 inline-block px-1.5 py-0.5 text-[10px] font-medium leading-none align-middle">
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
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          checked ? 'bg-[var(--ring)] border-[var(--ring)]' : 'bg-transparent border-border'
        }`}
      >
        <span
          className={`pointer-events-none block h-3.5 w-3.5 rounded-full transition-transform translate-y-px ${
            checked ? 'bg-background translate-x-[1.125rem]' : 'bg-muted-foreground translate-x-[2px]'
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
  const [model, setModel] = useState<ModelId>('claude-opus-4-7');
  const [thinking, setThinking] = useState(true);
  const [smartImports, setSmartImports] = useState(true);
  const [reviewSuggestions, setReviewSuggestions] = useState(true);
  const [webResearch, setWebResearch] = useState(false);
  const [educationMode, setEducationMode] = useState(true);
  const [claudeContext, setClaudeContext] = useState(true);
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
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const [repoSetupOpen, setRepoSetupOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The "About Gnosis" panel is the on-demand way to re-read the
  // welcome content after the first-run flag has been flipped. Same
  // copy as the inline welcome hero, just reachable from the top bar.
  const [aboutOpen, setAboutOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<'all' | 'closed' | null>(null);
  const [trayPromptOpen, setTrayPromptOpen] = useState(false);

  // Update availability — rendered as a newspaper "Extra" notice
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);

  // Has the user EVER had a pending PR from GitHub? Persisted in
  // localStorage so we know whether the empty Suggested-for-you
  // section should render its teaching placeholder (first-time
  // users) or hide entirely (returning users who already understand
  // what the section is for).
  const [hasEverHadPendingReviews, setHasEverHadPendingReviews] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gnosis-has-ever-had-pending') === '1';
    } catch {
      return false;
    }
  });

  // Quiet keyboard discoverability hint shown under the compose row.
  // Auto-dismisses the first time the user opens the shortcuts cheat
  // sheet — that's signal that they've found the keyboard layer and
  // no longer need the hint.
  const [keyboardHintDismissed, setKeyboardHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gnosis-keyboard-hint-dismissed') === '1';
    } catch {
      return false;
    }
  });

  const mainRef = useRef<HTMLElement>(null);
  const scrollToTop = () => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  // Compose-row progressive disclosure. Each section starts collapsed
  // so the default state of the page is one-line-of-intent. Instructions
  // automatically expand if the user already has saved instructions
  // (so they can see and edit them on return visits).
  const prInputRef = useRef<HTMLInputElement>(null);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [prefsExpanded, setPrefsExpanded] = useState(false);
  const [modelMenuExpanded, setModelMenuExpanded] = useState(false);

  const prGroups = useMemo(() => groupReviewsByPR(history), [history]);

  // Unread reviews drive the "Pick up where you left off" hero. The
  // most recent unread is featured; the count of remaining unread
  // becomes a "+ N more unread" link that scrolls down to the second
  // unread row in the history list.
  const unreadGroups = useMemo(
    () => prGroups.filter((g) => g.latestReview.unread),
    [prGroups]
  );
  // .at() returns T | undefined regardless of noUncheckedIndexedAccess,
  // so the conditional renders below get the correct narrowing.
  const latestUnreadGroup = unreadGroups.at(0);

  useEffect(() => {
    window.electronAPI.onNewReviewInHistory(() => {
      void window.electronAPI.listReviews().then(setHistory);
    });
    return () => {
      window.electronAPI.offNewReviewInHistory();
    };
  }, []);

  useEffect(() => {
    window.electronAPI.onShowTrayPrompt(() => setTrayPromptOpen(true));
    return () => { window.electronAPI.offShowTrayPrompt(); };
  }, []);

  // Listen for app update events
  useEffect(() => {
    window.electronAPI.onUpdateAvailable((info) => setUpdateInfo(info));
    window.electronAPI.onUpdateReady((version) => setReadyVersion(version));
    return () => {
      window.electronAPI.offUpdateAvailable();
      window.electronAPI.offUpdateReady();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.getAuthState().then(({ authenticated, login }) => {
      if (!cancelled) setAuthStatus(authenticated && login ? { login } : 'unauthenticated');
    });
    void window.electronAPI.listReviews().then((reviews) => {
      if (!cancelled) setHistory(reviews);
    });
    void window.electronAPI.loadPreferences().then((prefs) => {
      if (cancelled) return;
      if (prefs.instructions) setInstructions(prefs.instructions);
      setProvider(prefs.provider);
      setModel(prefs.model);
      setThinking(prefs.thinking);
      setSmartImports(prefs.smartImports);
      setReviewSuggestions(prefs.reviewSuggestions);
      setWebResearch(prefs.enableWebResearch);
      setEducationMode(prefs.educationMode);
      setClaudeContext(prefs.claudeContext);
      setIncludeAllFiles(prefs.includeAllFiles);
      setPrefsLoaded(true);
      if (!prefs.firstRunSeen) {
        setRepoSetupOpen(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Keyboard shortcuts on the home screen. The hook handles input
  // suppression and modifier signatures, so the manual `?` listener
  // we used before is no longer needed. The `n` shortcut focuses the
  // PR URL input — this is the single most common intent on this
  // screen so it earns a one-keystroke entry point, consistent with
  // the vim-style single-key navigation already on ReviewPage.
  const shortcutMap = useMemo<ShortcutMap>(
    () => ({
      '?': () => setShortcutsOpen((v) => !v),
      'cmd+k': () => setPaletteOpen(true),
      'ctrl+k': () => setPaletteOpen(true),
      n: () => prInputRef.current?.focus(),
    }),
    []
  );
  useKeyboardShortcuts(shortcutMap);

  function dismissFirstRun() {
    setFirstRunOpen(false);
    void window.electronAPI.loadPreferences().then((current) => {
      void window.electronAPI.savePreferences({ ...current, firstRunSeen: true });
    });
  }

  // Resets every onboarding flag — the firstRunSeen pref, the
  // hasEverHadPendingReviews localStorage key, the keyboardHint flag,
  // and the dismissed-pending-prs list. Reopens the inline welcome
  // hero immediately so the user can walk through it again. Used by
  // the "Replay first-time welcome" link in the Settings dialog.
  function replayOnboarding() {
    void window.electronAPI.loadPreferences().then((current) => {
      void window.electronAPI.savePreferences({ ...current, firstRunSeen: false });
    });
    setHasEverHadPendingReviews(false);
    setKeyboardHintDismissed(false);
    setDismissedPendingPrs(new Set());
    try {
      localStorage.removeItem('gnosis-has-ever-had-pending');
      localStorage.removeItem('gnosis-keyboard-hint-dismissed');
      localStorage.removeItem('dismissed-pending-prs');
    } catch {
      /* non-fatal */
    }
    setAboutOpen(false);
    setRepoSetupOpen(true);
    scrollToTop();
  }

  // Command palette commands for the home screen. Recently-used
  // PRs from history are exposed so the user can re-open a review
  // by typing a few characters of the title.
  const paletteCommands = useMemo<Command[]>(() => {
    const commands: Command[] = [
      {
        id: 'browse-prs',
        label: 'Browse pull requests',
        group: 'Actions',
        keywords: 'pr search find',
        perform: () => setPrPickerOpen(true),
      },
      {
        id: 'settings',
        label: 'Open settings',
        group: 'Actions',
        keywords: 'preferences config theme',
        perform: () => setSettingsOpen(true),
      },
      {
        id: 'shortcuts',
        label: 'Show keyboard shortcuts',
        hint: '?',
        group: 'Actions',
        keywords: 'help cheatsheet keys',
        perform: () => setShortcutsOpen(true),
      },
      {
        id: 'sign-out',
        label: 'Sign out',
        group: 'Actions',
        keywords: 'logout exit',
        perform: () => void handleSignOut(),
      },
    ];

    // Recent reviews — first 8 by group order (most recent first).
    prGroups.slice(0, 8).forEach((group) => {
      commands.push({
        id: `recent-${group.prUrl}`,
        label: group.prTitle,
        hint: group.repoRef,
        group: 'Recent reviews',
        keywords: `${group.prTitle} ${group.repoRef} ${group.author}`,
        perform: () => void handleLoadFromHistory(group.latestReview.id),
      });
    });

    return commands;
  }, [prGroups]);

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

  // The first time GitHub returns a non-empty pending list, flip the
  // localStorage flag so we stop showing the teaching placeholder
  // for this user forever after.
  useEffect(() => {
    if (pendingReviews.length > 0 && !hasEverHadPendingReviews) {
      setHasEverHadPendingReviews(true);
      try {
        localStorage.setItem('gnosis-has-ever-had-pending', '1');
      } catch {
        /* localStorage unavailable — non-fatal */
      }
    }
  }, [pendingReviews, hasEverHadPendingReviews]);

  // Auto-dismiss the keyboard hint the first time the user opens the
  // shortcuts cheatsheet — they've discovered the keyboard layer.
  useEffect(() => {
    if (shortcutsOpen && !keyboardHintDismissed) {
      setKeyboardHintDismissed(true);
      try {
        localStorage.setItem('gnosis-keyboard-hint-dismissed', '1');
      } catch {
        /* non-fatal */
      }
    }
  }, [shortcutsOpen, keyboardHintDismissed]);

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
          smartImports,
          reviewSuggestions,
          enableWebResearch: webResearch,
          educationMode,
          claudeContext,
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
      smartImports,
      reviewSuggestions,
      webResearch,
      educationMode,
      claudeContext,
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
    smartImports,
    reviewSuggestions,
    webResearch,
    educationMode,
    claudeContext,
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
      setPatError(err instanceof Error ? err.message : "Couldn't connect that token.");
    } finally {
      setPatConnecting(false);
    }
  }

  async function handleSignOut() {
    await window.electronAPI.signOut();
    setAuthStatus('unauthenticated');
  }

  async function doStartReview(excludedFiles: string[], urlOverride?: string) {
    const targetUrl = (urlOverride ?? prUrl).trim();
    if (!targetUrl) return;
    setSubmitting(true);
    try {
      const result = await window.electronAPI.startReview({
        prUrl: targetUrl,
        provider,
        model,
        instructions: instructions.trim() || undefined,
        thinking,
        smartImports,
        reviewSuggestions,
        webResearch,
        educationMode,
        claudeContext,
        excludedFiles: excludedFiles.length > 0 ? excludedFiles : undefined,
      });
      setGenerationStartTimes((prev) => new Map(prev).set(result.reviewId, Date.now()));
      const updated = await window.electronAPI.listReviews();
      setHistory(updated);
      setPrUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the review. Check the URL and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Shared "validate and start" path used by both the compose form
  // submit AND the inline "Generate review →" link in the suggested
  // section. The latter passes a URL directly so the review starts
  // without first writing to the input field.
  async function startReviewForUrl(targetUrl: string) {
    if (!targetUrl.trim() || submitting) return;
    savePrefs();
    setError(null);

    const { installed } = await window.electronAPI.checkCliInstalled(provider);
    if (!installed) {
      setCliNotFound({ provider });
      return;
    }

    if (!includeAllFiles) {
      // FilePickerDialog reads from prUrl, so populate it before opening.
      setPrUrl(targetUrl);
      setFilePickerOpen(true);
      return;
    }

    void doStartReview([], targetUrl);
  }

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    await startReviewForUrl(prUrl);
  }

  async function handleLoadFromHistory(id: string) {
    try {
      const [review] = await Promise.all([
        window.electronAPI.loadReview(id),
        window.electronAPI.markReviewRead(id),
      ]);
      setHistory((prev) => prev.map((e) => (e.id === id ? { ...e, unread: false, autoUpdated: false } : e)));
      onReviewReady(review);
    } catch {
      setError("Couldn't load that review. The file may have been deleted.");
    }
  }

  async function handleDeleteFromHistory(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await window.electronAPI.deleteReview(id);
    setHistory((prev) => prev.filter((h) => h.id !== id));
  }

  async function handleExportReview(id: string) {
    try {
      await window.electronAPI.exportReview(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export this review.");
    }
  }

  async function handleImportReview() {
    try {
      const entry = await window.electronAPI.importReview();
      if (entry) {
        setHistory((prev) => [entry, ...prev.filter((h) => h.id !== entry.id)]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't import that .gr file.");
    }
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

  // Scroll the second unread row in the history list into view. The
  // first unread is shown in the pickup hero above, so the "+ N more
  // unread" link should jump to the next one. Honors reduced motion.
  function scrollToNextUnread() {
    const target = unreadGroups.at(1);
    if (!target) return;
    const el = document.querySelector<HTMLElement>(`[data-pr-url="${CSS.escape(target.prUrl)}"]`);
    if (!el) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }

  const isAuthenticated = typeof authStatus === 'object';
  const login = isAuthenticated ? (authStatus as { login: string }).login : '';

  // Format today as a newspaper dateline
  const today = new Date();
  const dateline = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Newspaper edition number — days since an arbitrary epoch,
  // normalized to local midnight so it doesn't drift with UTC.
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const editionEpoch = new Date(2024, 0, 1);
  const editionNumber = Math.floor(
    (todayLocal.getTime() - editionEpoch.getTime()) / 86_400_000
  );

  return (
    <main ref={mainRef} className="h-screen overflow-y-auto">
      <ShortcutOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
        placeholder="Jump to a review or run a command…"
      />

      {/* ── Pre-auth states ── */}
      {authStatus === 'checking' && (
        <div className="flex justify-center pt-[20vh]">
          <span className="slide-meta animate-pulse">Loading…</span>
        </div>
      )}

      {authStatus === 'unauthenticated' && (
        <div className="newspaper">
          <header className="newspaper-masthead">
            <hr className="newspaper-rule--double" />
            <h1>Gnosis</h1>
            <p className="newspaper-tagline">Code Review, Narrated</p>
            <hr className="newspaper-rule--double" />
          </header>
          <div className="max-w-md mx-auto w-full pt-8 flex flex-col gap-8">
            {authError && (
              <Alert variant="destructive">
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-4 text-center">
              <p className="newspaper-lede">
                Sign in with your GitHub account to begin reading.
              </p>
              <p className="slide-meta max-w-[52ch] mx-auto">
                Gnosis uses your GitHub account to fetch pull request diffs, post review comments, and remember which
                reviews are yours. Nothing leaves your machine besides the requests to GitHub.
              </p>
            </div>
            <Button onClick={handleSignIn} className="w-full gap-2">
              <GitHubIcon className="h-4 w-4" />
              Sign in with GitHub
            </Button>
            <button
              type="button"
              className="slide-meta hover:text-foreground transition-colors flex items-center gap-1.5 self-center"
              onClick={() => {
                setPatExpanded((v) => !v);
                setPatError(null);
              }}
            >
              {patExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Use a Personal Access Token instead
            </button>
            {patExpanded && (
              <div className="border-l border-border pl-4 flex flex-col gap-3">
                <p className="slide-meta">
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
                  className="w-full bg-transparent border-0 border-b border-border px-0 py-2 text-sm placeholder:text-muted-foreground/60 transition-colors"
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
          </div>
        </div>
      )}

      {authStatus === 'signing-in' && (
        <div className="flex flex-col items-center gap-2 text-center pt-[20vh]">
          <span className="slide-meta animate-pulse">
            Waiting for GitHub… complete sign-in in your browser.
          </span>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          ██  THE NEWSPAPER  ██
          Broadsheet-style layout: masthead, above-the-fold lead
          story, dispatches sidebar, classified submission form,
          and a multi-column archives grid.
          ══════════════════════════════════════════════════════════ */}
      {isAuthenticated && (
        <div className="newspaper">
          {/* ── Masthead ── */}
          <header className="newspaper-masthead">
            <hr className="newspaper-rule--double" />
            <h1>Gnosis</h1>
            <p className="newspaper-tagline">Code Review, Narrated</p>
            <p className="newspaper-dateline">
              No. {editionNumber} · {dateline} ·{' '}
              <span className="inline-flex items-center gap-1.5">
                <Avatar className="h-3.5 w-3.5 inline-block align-middle">
                  <AvatarImage
                    src={`https://github.com/${login}.png`}
                    alt={login}
                  />
                  <AvatarFallback className="text-[8px]">
                    {login.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                @{login}
              </span>
            </p>
            <hr className="newspaper-rule--double" />
          </header>

          {/* ── EXTRA: Update available ── Rendered as a newspaper
              "Extra" notice strip between the masthead and content.
              Auto-update platforms show "will install on restart";
              manual platforms show a download link. */}
          {(() => {
            const supportsAutoUpdate = window.electronAPI.platform !== 'linux' && window.electronAPI.isPackaged;
            if (supportsAutoUpdate && readyVersion) {
              return (
                <div className="newspaper-extra">
                  <span className="newspaper-extra-label">Extra</span>
                  <span className="newspaper-extra-text">
                    Gnosis <strong>v{readyVersion}</strong> will install on next restart
                  </span>
                  <button
                    onClick={() => setReadyVersion(null)}
                    className="newspaper-extra-dismiss"
                    aria-label="Dismiss"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            }
            if (updateInfo && !supportsAutoUpdate) {
              return (
                <div className="newspaper-extra">
                  <span className="newspaper-extra-label">Extra</span>
                  <span className="newspaper-extra-text">
                    Gnosis <strong>v{updateInfo.version}</strong> is available
                  </span>
                  <button
                    onClick={() => void window.electronAPI.openExternal(updateInfo.releaseUrl)}
                    className="text-xs text-[var(--ring)] hover:underline transition-colors"
                  >
                    Download →
                  </button>
                  <button
                    onClick={() => {
                      void window.electronAPI.dismissUpdate(updateInfo.version);
                      setUpdateInfo(null);
                    }}
                    className="newspaper-extra-dismiss"
                    aria-label="Dismiss"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            }
            return null;
          })()}

          {/* ── Welcome / About ── Inline hero, newspaper style */}
          {(firstRunOpen || aboutOpen) && (
            <section className="py-6 border-b border-border max-w-[68ch] mx-auto text-center">
              <p className="newspaper-section">
                {firstRunOpen ? 'Welcome' : 'About Gnosis'}
              </p>
              <h2 className="newspaper-headline--lead !text-center">
                A pull request is a story. Read it like one.
              </h2>
              <div className="newspaper-lede mx-auto mt-4 text-center max-w-[56ch]">
                <p>
                  Gnosis turns a GitHub pull request into an ordered walkthrough you can read like a chapter.
                  Foundation changes first, then the features built on top, then the tests and config — each on
                  its own slide, each with a short narrative explaining <em>why</em> the change is there.
                </p>
                <p className="mt-3">
                  You'll still see every diff. Everything runs locally on your machine — nothing leaves except
                  requests to GitHub.
                </p>
              </div>
              <div className="flex items-center justify-center gap-6 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    if (firstRunOpen) dismissFirstRun();
                    else setAboutOpen(false);
                    // Focus the PR input so the user can paste immediately
                    setTimeout(() => prInputRef.current?.focus(), 100);
                  }}
                  className="text-sm text-foreground underline underline-offset-4 hover:opacity-80 transition-opacity"
                >
                  {firstRunOpen ? 'Paste a PR URL to get started →' : 'Close'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (firstRunOpen) dismissFirstRun();
                    setAboutOpen(false);
                    setShortcutsOpen(true);
                  }}
                  className="slide-meta hover:text-foreground transition-colors"
                >
                  Keyboard shortcuts
                </button>
              </div>
            </section>
          )}

          {/* ── Above the fold: Lead story + Dispatches sidebar ──
              Only show when there's actual content: an unread review
              to feature OR pending dispatches to show. Skip entirely
              for first-time users with no reviews — the newsroom
              section handles that case. */}
          {(latestUnreadGroup || visiblePendingReviews.length > 0) &&
            !firstRunOpen &&
            !aboutOpen && (
            <div className="newspaper-above-fold">
              {/* Lead story — latest unread review */}
              <div className="newspaper-lead">
                {latestUnreadGroup ? (
                  <>
                    <span className="newspaper-section">{(() => {
                      const age = Date.now() - new Date(latestUnreadGroup.latestReview.savedAt).getTime();
                      if (age < 3_600_000) return 'Breaking';
                      if (age < 86_400_000) return 'New';
                      return 'Unread';
                    })()}</span>
                    <button
                      type="button"
                      onClick={() => void handleLoadFromHistory(latestUnreadGroup.latestReview.id)}
                      className="text-left"
                    >
                      <h2 className="newspaper-headline--lead">
                        {latestUnreadGroup.prTitle}
                      </h2>
                    </button>
                    <p className="newspaper-byline mt-2">
                      By {latestUnreadGroup.author} · {latestUnreadGroup.repoRef} · {timeAgo(latestUnreadGroup.latestReview.savedAt)}
                    </p>
                    <p className="newspaper-lede">
                      {latestUnreadGroup.latestReview.summary
                        ?? (latestUnreadGroup.latestReview.riskLevel === 'high'
                          ? 'Elevated risk — proceed with scrutiny.'
                          : latestUnreadGroup.latestReview.riskLevel === 'medium'
                            ? 'Moderate complexity. Worth a careful read.'
                            : 'A straightforward set of changes.')}
                    </p>
                    <div className="flex items-center gap-5 mt-4">
                      <button
                        type="button"
                        onClick={() => void handleLoadFromHistory(latestUnreadGroup.latestReview.id)}
                        className="text-sm text-[var(--ring)] hover:underline transition-colors"
                      >
                        Read the full review →
                      </button>
                      {unreadGroups.length > 1 && (
                        <button
                          type="button"
                          onClick={scrollToNextUnread}
                          className="slide-meta hover:text-foreground transition-colors"
                        >
                          + {unreadGroups.length - 1} more unread
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="newspaper-section">All Clear</span>
                    <h2 className="newspaper-headline--secondary">
                      Nothing unread.
                    </h2>
                    <p className="newspaper-lede">
                      No unread reviews on file. Paste a pull request URL below to start a new one.
                    </p>
                  </>
                )}
              </div>

              {/* Sidebar — dispatches (pending review requests) */}
              <aside className="newspaper-sidebar">
                <div className="flex items-baseline justify-between">
                  <span className="newspaper-section mb-1">Dispatches</span>
                  <button
                    type="button"
                    onClick={fetchPendingReviews}
                    disabled={pendingLoading}
                    className="slide-meta hover:text-foreground disabled:opacity-40 transition-colors"
                    aria-label="Reload pending reviews"
                  >
                    <RefreshCw className={`h-3 w-3 ${pendingLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                {visiblePendingReviews.length === 0 ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {hasEverHadPendingReviews
                      ? 'No pending reviews right now.'
                      : 'When someone requests your review on GitHub, it will appear here.'}
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {visiblePendingReviews.slice(0, 8).map((pr) => (
                      <div key={pr.url} className="newspaper-sidebar-item group">
                        <button
                          type="button"
                          onClick={() => void startReviewForUrl(pr.url)}
                          className="text-left"
                        >
                          <span className="newspaper-sidebar-headline">
                            {pr.title}
                          </span>
                        </button>
                        <div className="flex items-center justify-between">
                          <span className="slide-meta">
                            {pr.repoName}#{pr.number} · {pr.author}
                          </span>
                          <button
                            type="button"
                            onClick={() => dismissPendingPr(pr.url)}
                            className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                            aria-label="Dismiss"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {visiblePendingReviews.length > 8 && (
                      <button
                        type="button"
                        onClick={() => setPrPickerOpen(true)}
                        className="slide-meta hover:text-foreground pt-2 text-left"
                      >
                        + {visiblePendingReviews.length - 8} more dispatches…
                      </button>
                    )}
                  </div>
                )}
              </aside>
            </div>
          )}

          <hr className="newspaper-rule--thin mt-6" />

          {/* ── The Newsroom: compose form ── */}
          <section className="newspaper-newsroom">
            <span className="newspaper-section">
              {prGroups.length === 0 ? 'Start Your First Review' : 'The Newsroom'}
            </span>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex items-end gap-4 flex-wrap">
                <div className="flex-1 min-w-[280px] flex items-end gap-3">
                  <input
                    ref={prInputRef}
                    id="pr-url"
                    type="url"
                    placeholder="Paste a pull request URL — github.com/owner/repo/pull/123"
                    value={prUrl}
                    onChange={(e) => setPrUrl(e.target.value)}
                    className="flex-1 bg-transparent border-0 border-b border-border px-0 py-2.5 text-base placeholder:text-muted-foreground/60 transition-colors"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setPrPickerOpen(true)}
                    className="slide-meta hover:text-foreground transition-colors pb-2.5"
                  >
                    Browse
                  </button>
                </div>
                <Button type="submit" className="gap-2 px-6 py-2.5 h-auto" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Starting review…
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Generate review
                    </>
                  )}
                </Button>
              </div>

              {/* Options row */}
              <div className="flex items-center gap-6 slide-meta">
                <button
                  type="button"
                  onClick={() => setModelMenuExpanded((v) => !v)}
                  className={`pb-0.5 border-b transition-colors ${
                    modelMenuExpanded
                      ? 'text-foreground border-[var(--ring)]'
                      : 'border-transparent hover:text-foreground'
                  }`}
                >
                  {PROVIDERS[provider].label} ·{' '}
                  {PROVIDERS[provider].models.find((m) => m.id === model)?.label ?? model}
                </button>
                <button
                  type="button"
                  onClick={() => setInstructionsExpanded((v) => !v)}
                  className={`pb-0.5 border-b transition-colors ${
                    instructionsExpanded || instructions
                      ? 'text-foreground border-[var(--ring)]'
                      : 'border-transparent hover:text-foreground'
                  }`}
                >
                  {instructions ? 'Instructions' : 'Add instructions'}
                </button>
                <button
                  type="button"
                  onClick={() => setPrefsExpanded((v) => !v)}
                  className={`pb-0.5 border-b transition-colors ${
                    prefsExpanded
                      ? 'text-foreground border-[var(--ring)]'
                      : 'border-transparent hover:text-foreground'
                  }`}
                >
                  Preferences
                </button>
              </div>

              {!keyboardHintDismissed && (
                <p className="slide-meta flex items-center gap-2 -mt-1">
                  <span>
                    <kbd className="kbd">n</kbd> to focus ·{' '}
                    <kbd className="kbd">⌘ K</kbd> to search ·{' '}
                    <kbd className="kbd">?</kbd> for shortcuts
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setKeyboardHintDismissed(true);
                      try { localStorage.setItem('gnosis-keyboard-hint-dismissed', '1'); } catch { /* non-fatal */ }
                    }}
                    className="hover:text-foreground transition-colors"
                    aria-label="Dismiss keyboard hint"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </p>
              )}

              {/* Model menu disclosure */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${modelMenuExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 slide-meta pt-1 pb-2">
                    <span className="text-foreground/60">Claude</span>
                    {PROVIDERS.claude.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setModel(m.id)}
                        className={`pb-0.5 border-b transition-colors ${model === m.id ? 'text-foreground border-[var(--ring)]' : 'border-transparent hover:text-foreground'}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Instructions disclosure */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${instructionsExpanded || instructions ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <textarea
                    id="instructions"
                    rows={4}
                    placeholder="What should the reviewer pay special attention to?"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    onBlur={() => savePrefs()}
                    className="w-full bg-transparent border-0 border-b border-border px-0 py-2 text-sm placeholder:text-muted-foreground/60 transition-colors resize-none mt-1"
                  />
                </div>
              </div>

              {/* Preferences disclosure */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${prefsExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-10 gap-y-5 pt-2">
                    <ToggleSwitch
                      id="include-all-files"
                      label="Include all files"
                      description={includeAllFiles ? 'All changed files included in the review' : 'You will choose which files to include'}
                      checked={includeAllFiles}
                      onToggle={() => setIncludeAllFiles((v) => !v)}
                    />
                    <ToggleSwitch
                      id="thinking"
                      label="Extended thinking"
                      description="Deeper reasoning before writing. Catches subtle bugs that standard mode misses. Takes longer."
                      checked={thinking}
                      onToggle={() => setThinking((t) => !t)}
                    />
                    <ToggleSwitch
                      id="smart-imports"
                      label="Smart imports"
                      description="Pull in related files across all languages, not just imports the parser sees"
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
                    <ToggleSwitch
                      id="education-mode"
                      label="Education mode"
                      description="Small explainer notes for concepts the code assumes knowledge of (e.g. Unit of Work)"
                      checked={educationMode}
                      onToggle={() => setEducationMode((e) => !e)}
                    />
                    <ToggleSwitch
                      id="claude-context"
                      label="Apply project's Claude conventions"
                      description="Read CLAUDE.md and .claude/ in the PR repo so the review respects the team's Claude Code setup"
                      checked={claudeContext}
                      onToggle={() => setClaudeContext((c) => !c)}
                    />
                    <ToggleSwitch
                      id="web-research"
                      label="Web research"
                      description="Search for framework docs and best practices (slower)"
                      checked={webResearch}
                      onToggle={() => setWebResearch((w) => !w)}
                    />
                  </div>
                </div>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </form>
          </section>

          {/* Dialogs (unchanged — just mounted here) */}
          <PRPickerDialog open={prPickerOpen} onOpenChange={setPrPickerOpen} onSelect={setPrUrl} />
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onReplayOnboarding={replayOnboarding} />
          <FilePickerDialog
            open={filePickerOpen}
            onOpenChange={setFilePickerOpen}
            prUrl={prUrl.trim()}
            onConfirm={(excluded) => { setFilePickerOpen(false); void doStartReview(excluded); }}
          />
          <Dialog open={cliNotFound !== null} onOpenChange={() => setCliNotFound(null)}>
            <DialogContent className="bg-card sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Claude CLI not found</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p>Gnosis runs reviews against your local Claude CLI, but couldn't find it on your machine.</p>
                <p>Install it from claude.ai/code and authenticate with `claude auth`.</p>
                <p>Already installed? Set the path manually in Settings.</p>
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" onClick={() => setCliNotFound(null)}>Dismiss</Button>
                <Button onClick={() => { setCliNotFound(null); setSettingsOpen(true); }}>Open Settings</Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* ── Delete confirmation dialog ── */}
          <Dialog open={confirmDelete !== null} onOpenChange={() => setConfirmDelete(null)}>
            <DialogContent className="bg-card sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>
                  {confirmDelete === 'all' ? 'Delete all reviews?' : 'Delete closed PRs?'}
                </DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {confirmDelete === 'all'
                  ? `This will permanently delete all ${prGroups.length} reviews. This cannot be undone.`
                  : 'This will permanently remove reviews for merged and closed pull requests. Open PRs are not affected.'}
              </p>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (confirmDelete === 'all') void handleDeleteAllHistory();
                    else void handleDeleteClosedPRs();
                    setConfirmDelete(null);
                  }}
                >
                  {confirmDelete === 'all' ? 'Delete all' : 'Delete closed'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* ── Tray prompt dialog ── */}
          <Dialog open={trayPromptOpen} onOpenChange={setTrayPromptOpen}>
            <DialogContent
              className="bg-card sm:max-w-sm"
              showCloseButton={false}
              onPointerDownOutside={(e) => e.preventDefault()}
              onEscapeKeyDown={(e) => e.preventDefault()}
            >
              <DialogHeader>
                <DialogTitle>Enable menu bar icon?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Gnosis can show a menu bar icon for quick access to your reviews, CI status, and more.
              </p>
              <p className="text-xs text-muted-foreground">You can change this anytime in Settings.</p>
              <div className="flex gap-2 justify-end pt-2">
                <Button variant="outline" onClick={() => {
                  setTrayPromptOpen(false);
                  void window.electronAPI.loadPreferences().then((current) => {
                    void window.electronAPI.savePreferences({ ...current, trayEnabled: false });
                  });
                }}>Not now</Button>
                <Button onClick={() => {
                  setTrayPromptOpen(false);
                  void window.electronAPI.loadPreferences().then((current) => {
                    void window.electronAPI.savePreferences({ ...current, trayEnabled: true });
                  });
                }}>Enable</Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* ── Onboarding repo setup ── */}
          <OnboardingRepoSetup
            open={repoSetupOpen}
            onComplete={(repos) => {
              setRepoSetupOpen(false);
              void window.electronAPI.loadPreferences().then((current) => {
                void window.electronAPI.savePreferences({
                  ...current,
                  firstRunSeen: true,
                  proactiveMode: true,
                  watchedRepos: repos,
                });
              });
              setTimeout(() => prInputRef.current?.focus(), 100);
            }}
            onSkip={() => {
              setRepoSetupOpen(false);
              void window.electronAPI.loadPreferences().then((current) => {
                void window.electronAPI.savePreferences({ ...current, firstRunSeen: true });
              });
              setTimeout(() => prInputRef.current?.focus(), 100);
            }}
          />

          {/* ── Empty state ── Only shown for first-time users.
              Explains what will appear here and sets expectations. */}
          {prGroups.length === 0 && (
            <section className="py-8 max-w-[56ch] mx-auto">
              <p className="newspaper-section">The Archives</p>
              <p className="text-sm text-muted-foreground">
                Your reviews will appear here, grouped by pull request.
                Each review takes 2–4 minutes to generate and is stored locally on your machine.
              </p>
              <p className="slide-meta mt-3">
                Got a <span className="font-mono">.gr</span> file from a teammate?{' '}
                <button
                  onClick={() => void handleImportReview()}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                >
                  Import it.
                </button>
              </p>
            </section>
          )}

          {/* ═══════════════════════════════════════════════════════
              ██  THE ARCHIVES  ██
              Multi-column newspaper grid. The first article spans
              full width as a secondary lead; the rest fill a 3-col
              grid with vertical column rules.
              ═══════════════════════════════════════════════════════ */}
          {prGroups.length > 0 && (
            <section>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="newspaper-section !mb-0">
                  The Archives
                  <span className="font-normal text-muted-foreground ml-2">
                    {prGroups.length} {prGroups.length === 1 ? 'review' : 'reviews'}
                    {unreadGroups.length > 0 && ` · ${unreadGroups.length} unread`}
                  </span>
                </h2>
                <div className="flex items-center gap-3 slide-meta">
                  {prGroups.some((g) => {
                    const state = livePrStates.get(g.prUrl)?.prState ?? g.latestReview.prState;
                    return state === 'merged' || state === 'closed';
                  }) && (
                    <button
                      onClick={() => setConfirmDelete('closed')}
                      className="hover:text-foreground transition-colors flex items-center gap-1"
                      title="Remove merged & closed PRs"
                    >
                      <Eraser className="h-3.5 w-3.5" />
                      <span>Clear closed</span>
                    </button>
                  )}
                  <button
                    onClick={() => void handleImportReview()}
                    className="hover:text-foreground transition-colors flex items-center gap-1"
                    title="Import a .gr review file"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>Import</span>
                  </button>
                  <button
                    onClick={() => setConfirmDelete('all')}
                    className="hover:text-foreground transition-colors flex items-center gap-1"
                    title="Delete all history"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear all</span>
                  </button>
                </div>
              </div>

              <hr className="newspaper-rule" />

              <div className="newspaper-grid">
                {prGroups.map((group, idx) => {
                  const latestStatus = getEntryStatus(group.latestReview);
                  const risk = safeConfigLookup(riskConfig, group.latestReview.riskLevel, riskConfig.low);
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
                  const isUnread = group.latestReview.unread;

                  return (
                    <article
                      key={group.prUrl}
                      data-pr-url={group.prUrl}
                      className={`${idx === 0 ? 'newspaper-article--featured' : 'newspaper-article'} group`}
                      role={isClickable ? 'button' : undefined}
                      tabIndex={isClickable ? 0 : undefined}
                      onClick={() => isClickable && handleLoadFromHistory(latestId)}
                      onKeyDown={(e) => {
                        if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          handleLoadFromHistory(latestId);
                        }
                      }}
                      aria-label={isClickable ? `Open review: ${group.prTitle}` : undefined}
                    >
                      {/* Featured articles use a two-column layout:
                          left = headline + meta + badges, right = lede.
                          Regular articles keep the flat stack. */}
                      {idx === 0 ? (
                        <>
                          <div className="newspaper-featured-left">
                            <h3 className="newspaper-article-headline--featured">
                              {group.prTitle}
                            </h3>
                            <p className="newspaper-article-meta">
                              {group.repoRef} · {group.author}&nbsp;· <span className="whitespace-nowrap">{timeAgo(group.latestReview.savedAt)}</span>
                              {hasMultiple && <>&nbsp;· <span className="whitespace-nowrap">{group.reviews.length} reviews</span></>}
                            </p>
                          </div>
                          {group.latestReview.summary ? (
                            <div className="newspaper-featured-right">
                              <p className="newspaper-article-lede !mt-0">
                                {group.latestReview.summary}
                              </p>
                            </div>
                          ) : <div />}
                        </>
                      ) : (
                        <>
                          <h3
                            className={`newspaper-article-headline ${isUnread ? 'newspaper-article-headline--unread' : ''}`}
                          >
                            {group.prTitle}
                          </h3>
                          <p className="newspaper-article-meta">
                            {group.repoRef} · {group.author}&nbsp;· <span className="whitespace-nowrap">{timeAgo(group.latestReview.savedAt)}</span>
                            {hasMultiple && <>&nbsp;· <span className="whitespace-nowrap">{group.reviews.length} reviews</span></>}
                          </p>
                          {group.latestReview.summary && (
                            <p className="newspaper-article-lede">
                              {group.latestReview.summary}
                            </p>
                          )}
                        </>
                      )}

                      {/* Status badges — spans full width in featured layout */}
                      <div className={`flex items-center gap-2 mt-2 flex-wrap ${idx === 0 ? 'newspaper-featured-footer' : ''}`}>
                        {prState === 'open' && !isOutdated && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-success)]/35 text-[var(--color-success)]">
                            <GitPullRequest className="h-2.5 w-2.5 mr-0.5" /> Open
                          </Badge>
                        )}
                        {prState === 'open' && isOutdated && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-warning)]/35 text-[var(--color-warning)]">
                            <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Outdated
                          </Badge>
                        )}
                        {prState === 'merged' && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-info)]/35 text-[var(--color-info)]">
                            <GitMerge className="h-2.5 w-2.5 mr-0.5" /> Merged
                          </Badge>
                        )}
                        {prState === 'closed' && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-danger)]/35 text-[var(--color-danger)]">
                            <GitPullRequestClosed className="h-2.5 w-2.5 mr-0.5" /> Closed
                          </Badge>
                        )}
                        {latestStatus === 'generating' && (
                          <Badge variant="outline" className="text-[10px] border-[var(--ring)]/40 text-[var(--ring)]">
                            <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />
                            {reviewPhases.get(latestId) ?? 'Starting'}
                            {elapsed > 0 && ` · ${formatDuration(elapsed * 1000)}`}
                          </Badge>
                        )}
                        {latestStatus === 'failed' && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-danger)]/35 text-[var(--color-danger)] max-w-[180px]">
                            <CircleX className="h-2.5 w-2.5 mr-0.5 shrink-0" />
                            <span className="truncate">{group.latestReview.error ?? 'Failed'}</span>
                          </Badge>
                        )}
                        {latestStatus === 'completed' && (
                          <Badge variant="outline" className={`text-[10px] ${risk.badgeClassName}`}>
                            {risk.label}
                          </Badge>
                        )}
                        {group.latestReview.autoUpdated && (
                          <Badge variant="outline" className="text-[10px] border-[var(--color-warning)]/35 text-[var(--color-warning)]">
                            Updated
                          </Badge>
                        )}
                      </div>

                      {/* Byte stats for generating reviews */}
                      {latestStatus === 'generating' && bytes && bytes.inputBytes > 0 && (
                        <p className={`slide-meta opacity-60 mt-1 ${idx === 0 ? 'newspaper-featured-footer' : ''}`}>
                          ↑{formatBytes(bytes.inputBytes)} ↓{formatBytes(bytes.outputBytes)}
                        </p>
                      )}

                      {/* Action row — visible on hover */}
                      <div className={`flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity ${idx === 0 ? 'newspaper-featured-footer' : ''}`}>
                        {latestStatus === 'generating' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void window.electronAPI.cancelReview(latestId); }}
                            className="slide-meta hover:text-destructive transition-colors"
                            title="Cancel"
                          >
                            Cancel
                          </button>
                        )}
                        {latestStatus !== 'generating' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); void window.electronAPI.openReviewPrompt(latestId); }}
                              className="text-muted-foreground hover:text-foreground transition-colors p-1.5 -m-1.5"
                              title="View prompt"
                              aria-label="View prompt"
                            >
                              <FileText className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); void handleExportReview(latestId); }}
                              className="text-muted-foreground hover:text-foreground transition-colors p-1.5 -m-1.5"
                              title="Export as .gr file"
                              aria-label="Export review"
                            >
                              <Share2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={(e) => handleDeleteFromHistory(e, latestId)}
                              className="text-muted-foreground hover:text-destructive transition-colors p-1.5 -m-1.5"
                              title="Delete"
                              aria-label="Delete review"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        {hasMultiple && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedPRs((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.prUrl)) next.delete(group.prUrl);
                                else next.add(group.prUrl);
                                return next;
                              });
                            }}
                            className="slide-meta hover:text-foreground transition-colors ml-auto"
                            aria-expanded={isExpanded}
                            aria-label={`${group.reviews.length} previous reviews`}
                          >
                            {isExpanded ? 'Hide' : `${group.reviews.length} reviews`}
                          </button>
                        )}
                      </div>

                      {/* Expanded sub-reviews */}
                      {hasMultiple && isExpanded && (
                        <div className={`mt-2 pt-2 border-t border-border/40 flex flex-col gap-1 ${idx === 0 ? 'newspaper-featured-footer' : ''}`}>
                          {group.reviews.map((review) => {
                            const reviewStatus = getEntryStatus(review);
                            const reviewRisk = safeConfigLookup(riskConfig, review.riskLevel, riskConfig.low);
                            const reviewClickable = reviewStatus === 'completed';
                            const reviewElapsed = elapsedSeconds.get(review.id) ?? 0;
                            return (
                              <button
                                key={review.id}
                                onClick={() => reviewClickable && handleLoadFromHistory(review.id)}
                                className={`flex items-center justify-between gap-2 py-1 text-left group/review ${!reviewClickable ? 'cursor-default' : 'hover:text-foreground'}`}
                                disabled={!reviewClickable}
                              >
                                <span className="slide-meta truncate">
                                  {review.model ? (MODEL_LABELS[review.model] ?? review.model) : 'Unknown'}
                                  {review.generationDurationMs != null && ` · ${formatDuration(review.generationDurationMs)}`}
                                  {' · '}{timeAgo(review.savedAt)}
                                </span>
                                <div className="flex items-center gap-1 shrink-0">
                                  {reviewStatus === 'generating' && (
                                    <Badge variant="outline" className="text-[10px] border-[var(--ring)]/40 text-[var(--ring)]">
                                      <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />
                                      {reviewPhases.get(review.id) ?? 'Starting'}
                                      {reviewElapsed > 0 && ` · ${formatDuration(reviewElapsed * 1000)}`}
                                    </Badge>
                                  )}
                                  {reviewStatus === 'completed' && (
                                    <Badge variant="outline" className={`text-[10px] ${reviewRisk.badgeClassName}`}>
                                      {reviewRisk.label}
                                    </Badge>
                                  )}
                                  {reviewStatus === 'failed' && (
                                    <Badge variant="outline" className="text-[10px] border-[var(--color-danger)]/35 text-[var(--color-danger)]">
                                      <CircleX className="h-2.5 w-2.5 mr-0.5" /> Failed
                                    </Badge>
                                  )}
                                  <button
                                    onClick={(e) => handleDeleteFromHistory(e, review.id)}
                                    className="shrink-0 opacity-0 group-hover/review:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-1.5 -m-1.5"
                                    aria-label="Delete review"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Newspaper footer ── */}
          <hr className="newspaper-rule--double mt-8" />
          <div className="newspaper-footer">
            <button onClick={() => { setAboutOpen(true); scrollToTop(); }}>
              About
            </button>
            <button onClick={() => setShortcutsOpen(true)}>Shortcuts</button>
            <button onClick={() => setSettingsOpen(true)}>Settings</button>
            <button onClick={handleSignOut}>Sign Out</button>
          </div>
        </div>
      )}
    </main>
  );
}
