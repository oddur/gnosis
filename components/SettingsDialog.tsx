import { LoadingState } from './LoadingState';
import { applyCodeFont } from '../lib/code-font';
import { RepositoryMark } from './RepositoryAppearance';
import { RepositorySettingsList } from './RepositorySettingsList';
import { RepositorySettingsEditor } from './RepositorySettingsEditor';
import { preferencesUpdated } from '../lib/use-repository-settings';
import { normalizeRepositorySettings, repositoryKey, normalizeBriefingLimit, type RepositorySettingsMap, type BriefingBudget } from '../lib/repository-settings';
import { ModelEffortSelect, EffortSelect } from './ModelEffortSelect';
import { normalizeEffort, type Effort } from '../lib/effort';
import { DIFF_HIGHLIGHTER, DEFAULT_DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { resolveDiffHighlighter, type DiffHighlighter } from '../lib/diff-highlighter-preference';
import { HarnessEnvironmentSettings } from './HarnessEnvironmentSettings';
import { GITHUB_CACHE_SIZES_MB, DEFAULT_GITHUB_CACHE_MB, normalizeGitHubCacheMB } from '../lib/github-cache-settings';
import { SearchableSelect } from './SearchableSelect';
import { Button } from './ui/button';
import { NotificationSettings } from './NotificationSettings';
import { normalizeNotificationPreferences, type SavedNotificationPreferences } from '../lib/notification-settings';
import { PrInactivitySetting } from './PrInactivitySetting';
import { normalizePrInactivityDays, DEFAULT_PR_INACTIVITY_DAYS } from '../lib/pr-inactivity';
import {
  PRELOAD_AMOUNTS,
  PRELOAD_BUDGET_PERCENTS,
  DEFAULT_PRELOAD_BUDGET_PERCENT,
  normalizePreloadBudgetPercent,
  preloadSettings,
  type PreloadAmount,
} from '../lib/preload-settings';
import type { PredictedUsage } from '../lib/github-budget';
import { useState, useEffect, useRef } from 'react';
import { Tabs } from 'radix-ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';
import { applyTheme, type ThemeChoice } from '@/lib/theme';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_FAST_CLAUDE_MODEL } from '@/lib/models';
import type { ModelId, Preferences, Provider, RepoSearchResult } from '@/lib/types';

export type SettingsSection = 'queue' | 'repositories' | 'review' | 'appearance' | 'notifications' | 'integrations';

interface Props {
  initialSection?: SettingsSection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange?: (theme: string) => void;
  // Reopens the optional setup panel in the review queue.
  onReplayOnboarding?: () => void;
  onShowWalkthrough?: () => void;
}

// Quiet toggle switch — drops the bg-primary fill (now ink) and the
// shadow-sm thumb in favor of a warm-amber active state and a flat
// thumb. Used across all the on/off settings.
function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: () => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
        checked ? 'bg-[var(--ring)] border-[var(--ring)]' : 'bg-transparent border-border'
      }`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full transition-transform translate-y-px ${
          checked ? 'bg-background translate-x-[1.125rem]' : 'bg-muted-foreground translate-x-[2px]'
        }`}
      />
    </button>
  );
}

// Quiet text-only chip — same vocabulary as DiffLayoutToggle. Active
// option gets a hairline brand-amber underline; nothing else.
function Chip({
  active,
  onClick,
  children,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={style}
      className={`text-sm pb-0.5 border-b transition-colors ${
        active
          ? 'text-foreground border-[var(--ring)]'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// Single setting row — label + description on the left, control on the right.
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row flex items-center justify-between gap-4 py-1">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <span className="settings-description">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const AMOUNT_LABELS: Record<PreloadAmount, { label: string; description: string }> = {
  light: { label: 'Light', description: 'An opened PR loads its file list, the first file and its checks.' },
  normal: { label: 'Normal', description: 'Also three files, the workflow graph and failing check details.' },
  eager: { label: 'Eager', description: 'Also six files, failing job logs and graphs of failing stack PRs.' },
};
/** "This hour: 12 of 300 requests · 4 of 300 GraphQL points". */
function formatPreloadSpend(usage: { core: PredictedUsage; graphql: PredictedUsage }) {
  const n = (value: number) => value.toLocaleString('en-US');
  return `This hour: ${n(usage.core.spent)} of ${n(usage.core.limit)} requests · ${n(usage.graphql.spent)} of ${n(usage.graphql.limit)} GraphQL points`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function SettingsDialog({
  open,
  onOpenChange,
  onThemeChange,
  onReplayOnboarding,
  onShowWalkthrough,
  initialSection = 'queue',
}: Props) {
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheError, setCacheError] = useState('');
  const [cacheSizeMB, setCacheSizeMB] = useState(DEFAULT_GITHUB_CACHE_MB);
  const [storageSizes, setStorageSizes] = useState<{ savedWorkBytes: number; githubCacheBytes: number }>();
  const [setupError, setSetupError] = useState('');
  const [logsError, setLogsError] = useState('');
  async function clearGitHubCache() {
    if (savingRef.current || Object.keys(pendingChanges.current).length) return;
    setClearingCache(true);
    setCacheError('');
    try { await window.electronAPI.clearGitHubCache(); }
    catch (error) {
      setCacheError(error instanceof Error ? error.message : String(error));
      setClearingCache(false);
    }
  }
  const [addingRepository, setAddingRepository] = useState(false);
  const [narrowSettings, setNarrowSettings] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrowSettings(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useEffect(() => {
    if (open) { setSection(initialSection); setAddingRepository(false); }
  }, [open, initialSection]);
  // File sizes only: main stats the database files, without a worker request.
  useEffect(() => {
    if (!open || section !== 'integrations') return;
    let live = true;
    void Promise.resolve()
      .then(() => window.electronAPI.storageSizes())
      .then((sizes) => { if (live) setStorageSizes(sizes); })
      .catch(() => {});
    return () => { live = false; };
  }, [open, section]);
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
  const [diffHighlighter, setDiffHighlighter] = useState<DiffHighlighter>(DIFF_HIGHLIGHTER);
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState<ModelId>(DEFAULT_CLAUDE_MODEL);
  const [effort, setEffort] = useState<Effort>('high');
  const [smartImports, setSmartImports] = useState(true);
  const [prInactivityDays, setPrInactivityDays] = useState(DEFAULT_PR_INACTIVITY_DAYS);
  const [ignoreDependabotPrs, setIgnoreDependabotPrs] = useState(true);
  const [autoBriefings, setAutoBriefings] = useState(false);
  const [repositorySettings, setRepositorySettings] = useState<RepositorySettingsMap>({});
  const [repositoryDailyLimit, setRepositoryDailyLimit] = useState(10);
  const [pendingRepository, setPendingRepository] = useState('');
  useEffect(() => {
    if (pendingRepository) document.querySelector<HTMLElement>('.repository-editor input')?.focus();
  }, [pendingRepository]);
  const [budget, setBudget] = useState<BriefingBudget>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    const update = () => { void Promise.resolve().then(() => window.electronAPI.workbenchSnapshot()).then(q => { if (live) setBudget(q.briefingBudget); }).catch(() => {}); };
    const unsubscribe = window.electronAPI.onWorkbenchChanged?.(update);
    return () => { live = false; unsubscribe?.(); };
  }, [open]);
  const [watchedRepos, setWatchedRepos] = useState<string[]>([]);
  const [watchedRepoInput, setWatchedRepoInput] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<RepoSearchResult[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const showSuggestions = repoSuggestions.length > 0 && !suggestionsDismissed;
  const replayingOnboarding = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [notificationPrefs, setNotificationPrefs] = useState<SavedNotificationPreferences>(() => normalizeNotificationPreferences({}));
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [predictNavigation, setPredictNavigation] = useState(true);
  const [preloadAmount, setPreloadAmount] = useState<PreloadAmount>('normal');
  const [prepareQueue, setPrepareQueue] = useState(true);
  const [preloadBudgetPercent, setPreloadBudgetPercent] = useState(DEFAULT_PRELOAD_BUDGET_PERCENT);
  const [preloadUsage, setPreloadUsage] = useState<{ core: PredictedUsage; graphql: PredictedUsage }>();
  // Preloading spend this hour: main's counters, read once and then pushed with each prediction-state change.
  useEffect(() => {
    if (!open || section !== 'integrations') return;
    let live = true;
    const apply = (state: { usage?: { core: PredictedUsage; graphql: PredictedUsage } } | undefined) => {
      if (live && state?.usage) setPreloadUsage(state.usage);
    };
    void Promise.resolve().then(() => window.electronAPI.predictionState?.()).then(apply, () => {});
    const unsubscribe = window.electronAPI.onPredictionState?.(apply);
    return () => { live = false; unsubscribe?.(); };
  }, [open, section]);
  const [briefingDailyLimit, setBriefingDailyLimit] = useState(10);
  const [parallelReview, setParallelReview] = useState(false);
  const [claudeContext, setClaudeContext] = useState(true);
  const [analytics, setAnalytics] = useState(true);
  const [proactiveReviewOverrides, setProactiveReviewOverrides] = useState(false);
  const [proactiveModel, setProactiveModel] = useState<ModelId>(DEFAULT_FAST_CLAUDE_MODEL);
  const [proactiveEffort, setProactiveEffort] = useState<Effort>('low');
  const [proactiveProvider, setProactiveProvider] = useState<Provider>('claude');
  const [codexPath, setCodexPath] = useState('');
  const [codexDetected, setCodexDetected] = useState('');
  const [claudePath, setClaudePath] = useState('');
  const [claudeDetected, setClaudeDetected] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [searchError, setSearchError] = useState('');
  const searchVersion = useRef(0);
  const pendingChanges = useRef<Partial<Preferences>>({});
  const savingRef = useRef(false);
  const lastSaved = useRef<Preferences | null>(null);

  // Clean up debounce timer on unmount
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadState('loading');
    void window.electronAPI
      .loadPreferences()
      .then((prefs) => {
        if (!active) return;
        lastSaved.current = prefs;
        setLoadState('ready');
        setAppTheme(prefs.theme);
        setDiffHighlighter(resolveDiffHighlighter(prefs.diffHighlighter, DEFAULT_DIFF_HIGHLIGHTER));
        if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
        if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
        setEnableTools(prefs.enableTools);
        setInstructions(prefs.instructions);
        setProvider(prefs.provider);
        setModel(prefs.model);
        setEffort(normalizeEffort(prefs.provider, prefs.model, prefs.effort, prefs.thinking));
        setSmartImports(prefs.smartImports);
        setAutoBriefings(prefs.autoBriefings !== false);
        setIgnoreDependabotPrs(prefs.ignoreDependabotPrs !== false);
        setPrInactivityDays(normalizePrInactivityDays(prefs.prInactivityDays));
        setCacheSizeMB(normalizeGitHubCacheMB(prefs.githubCacheSizeMB));
        setWatchedRepos(prefs.watchedRepos);
        setRepositorySettings(normalizeRepositorySettings(prefs.repositorySettings));
        setRepositoryDailyLimit(normalizeBriefingLimit(prefs.repositoryBriefingDailyLimit));
        setNotifications(prefs.notifications);
        setNotificationPrefs(normalizeNotificationPreferences(prefs));
        setTrayEnabled(prefs.trayEnabled);
        const preloads = preloadSettings(prefs);
        setPredictNavigation(preloads.predictNavigation);
        setPreloadAmount(preloads.amount);
        setPrepareQueue(preloads.prepareQueue);
        setPreloadBudgetPercent(preloads.budgetPercent);
        setBriefingDailyLimit(prefs.briefingDailyLimit ?? 10);
        setParallelReview(prefs.parallelReview);
        setClaudeContext(prefs.claudeContext);
        setAnalytics(prefs.analytics);
        setProactiveReviewOverrides(prefs.proactiveReviewOverrides);
        setProactiveProvider(prefs.proactiveProvider);
        setProactiveModel(prefs.proactiveModel);
        setCodexPath(prefs.codexPath);
        setProactiveEffort(
          normalizeEffort(
            prefs.proactiveReviewOverrides ? prefs.proactiveProvider : prefs.provider,
            prefs.proactiveReviewOverrides ? prefs.proactiveModel : prefs.model,
            prefs.proactiveEffort,
            prefs.proactiveReviewOverrides ? prefs.proactiveThinking : false
          )
        );
        setClaudePath(prefs.claudePath || '');
      })
      .catch(() => {
        if (active) setLoadState('error');
      });
    void Promise.resolve().then(() => window.electronAPI.workbenchSnapshot()).then(q => { if (active) setBudget(q.briefingBudget); }).catch(() => {});
    // Detection is optional: an unavailable tool must not prevent editing settings.
    void window.electronAPI
      .detectBinaryPath('claude')
      .then((path) => {
        if (active) setClaudeDetected(path);
      })
      .catch(() => {});
    void window.electronAPI
      .detectBinaryPath('codex')
      .then((path) => {
        if (active) setCodexDetected(path);
      })
      .catch(() => {});
    return () => {
      active = false;
      searchVersion.current++;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, loadAttempt]);

  function handleSelectAppTheme(theme: ThemeChoice) {
    setAppTheme(theme);
    saveField({ theme });
    applyTheme(theme);
  }

  async function flushChanges() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      while (Object.keys(pendingChanges.current).length) {
        const patch = pendingChanges.current;
        pendingChanges.current = {};
        try {
          const current = await window.electronAPI.loadPreferences();
          const next = { ...current, ...patch };
          await window.electronAPI.savePreferences(next);
          lastSaved.current = next;
          preferencesUpdated(next);
          void Promise.resolve().then(() => window.electronAPI.workbenchSnapshot()).then(q => setBudget(q.briefingBudget)).catch(() => {});
        } catch {
          // Keep newer edits when a failed write and another edit share a field.
          pendingChanges.current = { ...patch, ...pendingChanges.current };
          setSaveError('Your changes have not been saved. Retry saving, or discard these changes before closing.');
          break;
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function saveField(overrides: Partial<Preferences>) {
    pendingChanges.current = { ...pendingChanges.current, ...overrides };
    void flushChanges();
  }

  function handleOpenChange(next: boolean) {
    if (!next && savingRef.current) return;
    if (!next && Object.keys(pendingChanges.current).length) {
      // Escape does not blur text fields before the dialog unmounts. Flush staged text first.
      void flushChanges().then(() => {
        if (!savingRef.current && !Object.keys(pendingChanges.current).length) onOpenChange(false);
      });
      return;
    }
    onOpenChange(next);
  }

  function discardChanges() {
    if (savingRef.current) return;
    pendingChanges.current = {};
    setSaveError('');
    const saved = lastSaved.current;
    if (saved) {
      applyTheme(saved.theme);
      applyCodeFont(saved.codeFont as CodeFont);
      onThemeChange?.(saved.codeTheme);
    }
    onOpenChange(false);
  }

  function searchRepositories(value: string) {
    const version = ++searchVersion.current;
    setWatchedRepoInput(value);
    setSuggestionsDismissed(false);
    setSearchError('');
    setRepoSuggestions([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) return;
    debounceRef.current = setTimeout(() => {
      void window.electronAPI
        .searchRepos(value.trim())
        .then((results) => {
          if (version === searchVersion.current)
            setRepoSuggestions(results.filter((r) => !watchedRepos.includes(r.fullName)));
        })
        .catch(() => {
          if (version === searchVersion.current)
            setSearchError('Could not search GitHub. Try again, or enter owner/repository and press Enter.');
        });
    }, 300);
  }

  function addWatchedRepo(name: string) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(name)) {
      setSearchError('Enter a repository as owner/repository, without a URL or spaces.');
      return;
    }
    if (watchedRepos.some((repo) => repo.toLowerCase() === name.toLowerCase())) return;
    setPendingRepository(name);
    searchRepositories('');

  }

  function handleSelectTheme(theme: CodeTheme) {
    setCodeTheme(theme);
    saveField({ codeTheme: theme });
    onThemeChange?.(theme);
  }

  function handleSelectFont(font: CodeFont) {
    setCodeFont(font);
    saveField({ codeFont: font });
    applyCodeFont(font);
  }

  const repositoryDefaults = { prInactivityDays, ignoreDependabotPrs, autoBriefings, briefingDailyLimit, repositoryBriefingDailyLimit: repositoryDailyLimit, repositorySettings };
  const unwatchedSettings = Object.keys(repositorySettings).filter(repo => !watchedRepos.some(watched => repositoryKey(watched) === repo));
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="settings-dialog bg-card"
        showCloseButton={!saving && !saveError}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-slot="combobox-content"]')) {
            event.preventDefault();
            return;
          }
          // Radix handles Escape in document capture, before a search field's key handler.
          if (showSuggestions) {
            event.preventDefault();
            document.getElementById('watched-repos')?.focus();
            setSuggestionsDismissed(true);
          }
        }}
        onCloseAutoFocus={(event) => {
          if (replayingOnboarding.current) {
            event.preventDefault();
            replayingOnboarding.current = false;
            document.getElementById('getting-started-title')?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription aria-live="polite">
            {saving ? 'Saving changes…' : saveError ? 'You have unsaved changes.' : 'Global settings save automatically. Repository edits have a Save button.'}
          </DialogDescription>
        </DialogHeader>
        {saveError && (
          <div className="settings-save-error" role="alert">
            <p>{saveError}</p>
            <div>
              <button disabled={saving} onClick={() => void flushChanges()}>
                Retry saving
              </button>
              <button disabled={saving} onClick={discardChanges}>
                Discard unsaved changes
              </button>
            </div>
          </div>
        )}
        {loadState === 'loading' && <LoadingState title="Loading settings…" />}
        {loadState === 'error' && (
          <div className="settings-load-error" role="alert">
            <p>Could not load your settings. Retry before making changes.</p>
            <button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading settings</button>
          </div>
        )}
        {loadState === 'ready' && (
          <Tabs.Root
            className="settings-tabs"
            orientation={narrowSettings ? 'horizontal' : 'vertical'}
            value={section}
            onValueChange={(value) => setSection(value as SettingsSection)}
          >
            <Tabs.List className="settings-sections" aria-label="Settings sections">
              <Tabs.Trigger value="queue">Queue &amp; briefings</Tabs.Trigger>
              <Tabs.Trigger value="repositories">Repositories</Tabs.Trigger>
              <Tabs.Trigger value="review">Review</Tabs.Trigger>
              <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
              <Tabs.Trigger value="notifications">Notifications</Tabs.Trigger>
              <Tabs.Trigger value="integrations">Integrations</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content forceMount value="repositories" className="settings-panel settings-repositories">
              <div className="repository-panel-heading">
                <div><h2>Repositories</h2><p className="settings-description">Add repositories to your queue and set their defaults.</p></div>
                <Button type="button" variant="outline" size="sm" onClick={() => { setAddingRepository(v => !v); requestAnimationFrame(() => document.getElementById('watched-repos')?.focus()); }}>Add repository</Button>
              </div>
              {pendingRepository ? <div className="repository-settings-focus repository-new-editor">
                {pendingRepository && <RepositorySettingsEditor key={pendingRepository} repo={pendingRepository}
                  value={repositorySettings[repositoryKey(pendingRepository)] ?? {}} defaults={repositoryDefaults} budget={budget}
                  onCancel={() => setPendingRepository('')} action="Watch repository" onApply={value => {
                    const next = [...watchedRepos, pendingRepository];
                    const settings = normalizeRepositorySettings({ ...repositorySettings, [repositoryKey(pendingRepository)]: value });
                    setWatchedRepos(next); setRepositorySettings(settings); setPendingRepository('');
                    saveField({ watchedRepos: next, repositorySettings: settings });
                    requestAnimationFrame(() => document.getElementById('watched-repos')?.focus());
                  }} />}
              </div> : <>
              {addingRepository && <div className="repository-add">
                <label htmlFor="watched-repos" className="text-sm font-medium text-foreground">
                  Add a repository
                </label>
                <p className="settings-description">
                  Add open PRs from these repositories. This does not change your GitHub Watch subscriptions.
                </p>
                <div className="relative" onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setSuggestionsDismissed(true);
                }}>
                  <div className="flex items-end gap-2">
                    <input
                      id="watched-repos"
                      type="text"
                      value={watchedRepoInput}
                      placeholder="Search for a repo…"
                      onChange={(e) => searchRepositories(e.target.value)}
                      aria-invalid={!!searchError}
                      aria-describedby={searchError ? 'repo-search-error' : undefined}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addWatchedRepo(watchedRepoInput.trim());
                        }
                      }}
                      onFocus={() => setSuggestionsDismissed(false)}
                      className="min-w-0 flex-1 bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors"
                    />
                  </div>
                  {searchError && (
                    <p id="repo-search-error" className="settings-search-error" role="alert">
                      {searchError}
                    </p>
                  )}
                  {showSuggestions && (
                    <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto">
                      {repoSuggestions.map((repo) => (
                        <li key={repo.fullName}>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex flex-col gap-0.5"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => addWatchedRepo(repo.fullName)}
                          >
                            <span className="max-w-full break-words font-mono text-xs text-foreground"><RepositoryMark repo={repo.fullName} settings={repositorySettings[repositoryKey(repo.fullName)]} /></span>
                            {repo.description && (
                              <span className="max-w-full text-xs text-muted-foreground truncate">{repo.description}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>}
                <RepositorySettingsList focused repositories={watchedRepos} settings={repositorySettings} defaults={repositoryDefaults} budget={budget}
                  onChange={settings => { setRepositorySettings(settings); saveField({ repositorySettings: settings }); }}
                  onRemove={repo => { const next = watchedRepos.filter(r => r !== repo); setWatchedRepos(next); saveField({ watchedRepos: next }); }} />
                {unwatchedSettings.length > 0 && <details className="repository-retained"><summary>Settings for unwatched repositories ({unwatchedSettings.length})</summary>
                  <p className="settings-description">These settings still apply to personal PRs and review requests. Unwatching keeps your configuration.</p>
                  <RepositorySettingsList focused repositories={unwatchedSettings} settings={repositorySettings} defaults={repositoryDefaults} budget={budget}
                    onChange={settings => { setRepositorySettings(settings); saveField({ repositorySettings: settings }); }} />
                </details>}
              </>}
            </Tabs.Content>
            <Tabs.Content value="queue" className="settings-panel">
              <section className="settings-group" aria-labelledby="queue-defaults-title">
                <div>
                  <h2 id="queue-defaults-title">Queue defaults</h2>
                  <p className="settings-description">Override these settings per repository in Repositories.</p>
                </div>
                <SettingRow label="Ignore PRs inactive for…"
                  description="Starred PRs and PRs needed for stack context stay visible.">
                  <PrInactivitySetting days={prInactivityDays} onChange={days => {
                    setPrInactivityDays(days); saveField({ prInactivityDays: days });
                  }} />
                </SettingRow>
                <SettingRow
                  label="Ignore Dependabot PRs"
                  description="Hide them from the queue and automatic briefings, unless a human-authored PR depends on them."
                >
                  <Toggle
                    checked={ignoreDependabotPrs}
                    ariaLabel="Ignore Dependabot PRs"
                    onChange={() => {
                      const next = !ignoreDependabotPrs;
                      setIgnoreDependabotPrs(next);
                      saveField({ ignoreDependabotPrs: next });
                    }}
                  />
                </SettingRow>
              </section>
              <section className="settings-group" aria-labelledby="briefing-defaults-title">
                <div>
                  <h2 id="briefing-defaults-title">Briefing defaults</h2>
                  <p className="settings-description">Short AI summaries. Repository overrides and queue filters apply.</p>
                </div>
                <SettingRow label="Automatic briefings">
                  <Toggle
                    checked={autoBriefings}
                    ariaLabel="Automatic briefings"
                    onChange={() => {
                      const next = !autoBriefings;
                      setAutoBriefings(next);
                      saveField({ autoBriefings: next });
                    }}
                  />
                </SettingRow>

                <div className="flex flex-col gap-2 ml-0.5">
                  <div className="flex items-center justify-between gap-4 mt-2"><div><label htmlFor="settings-repository-briefing-limit" className="text-sm font-medium">Per repository, per day</label></div>
                    <input id="settings-repository-briefing-limit" type="number" min={0} max={100} value={repositoryDailyLimit} className="w-20 shrink-0" onChange={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 100) { setRepositoryDailyLimit(value); saveField({ repositoryBriefingDailyLimit: value }); } }} />
                  </div>
                  <div className="flex items-center justify-between gap-4 mt-2">
                    <div className="flex flex-col gap-0.5">
                      <label htmlFor="settings-briefing-limit" className="text-sm font-medium text-foreground">
                        Overall daily limit
                      </label>
                      <p className="settings-description">
                        Automatic attempts across all repositories, including retries. Manual briefings and explanations do not count. Resets at midnight.
                      </p>
                    </div>
                    <input
                      id="settings-briefing-limit"
                      type="number"
                      min={0}
                      max={100}
                      value={briefingDailyLimit}
                      onChange={(e) => {
                        const next = Math.max(0, Math.min(100, Math.trunc(Number(e.target.value))));
                        setBriefingDailyLimit(next);
                        saveField({ briefingDailyLimit: next });
                      }}
                      className="w-20 bg-background border border-border rounded-md px-2 py-1 text-sm text-foreground"
                    />
                  </div>
                </div>
              </section>
              <section className="settings-group" aria-labelledby="briefing-model-title">
                <h2 id="briefing-model-title">Briefing model</h2>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium text-foreground">Use a different model for briefings</span>
                    <span className="slide-meta">
                      When off, briefings use the explanation model.
                    </span>
                  </div>
                  <div className="shrink-0">
                    <Toggle
                      checked={proactiveReviewOverrides}
                      ariaLabel="Use a different model for briefings"
                      onChange={() => {
                        const next = !proactiveReviewOverrides;
                        setProactiveReviewOverrides(next);
                        saveField({ proactiveReviewOverrides: next });
                      }}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2 mt-1">
                  {proactiveReviewOverrides ? (
                    <ModelEffortSelect
                      label="Briefing model"
                      provider={proactiveProvider}
                      model={proactiveModel}
                      effort={proactiveEffort}
                      onChange={(selection) => {
                        setProactiveProvider(selection.provider);
                        setProactiveModel(selection.model);
                        setProactiveEffort(selection.effort);
                        saveField({
                          proactiveProvider: selection.provider,
                          proactiveModel: selection.model,
                          proactiveEffort: selection.effort,
                        });
                      }}
                    />
                  ) : (
                    <EffortSelect
                      label="Briefing effort"
                      provider={provider}
                      model={model}
                      effort={proactiveEffort}
                      onChange={(value) => {
                        setProactiveEffort(value);
                        saveField({ proactiveEffort: value });
                      }}
                    />
                  )}
                  <p className="settings-description">
                    Higher effort can take longer. Briefing effort is set separately from explanation effort.
                  </p>
                </div>
              </section>
            </Tabs.Content>
            <Tabs.Content value="review" className="settings-panel">
              <SettingRow
                label="Web search and context (Claude only)"
                description="Let Claude search the web and fetch GitHub context during generation. More thorough, but slower."
              >
                <Toggle
                  checked={enableTools}
                  ariaLabel="Enable AI tools"
                  onChange={() => {
                    const next = !enableTools;
                    setEnableTools(next);
                    saveField({ enableTools: next });
                  }}
                />
              </SettingRow>

              <SettingRow
                label="Parallel review"
                description="Generate several review topics at once. This can speed up large reviews and uses concurrent AI requests."
              >
                <Toggle
                  checked={parallelReview}
                  ariaLabel="Parallel review"
                  onChange={() => {
                    const next = !parallelReview;
                    setParallelReview(next);
                    saveField({ parallelReview: next });
                  }}
                />
              </SettingRow>

              <SettingRow
                label="Apply project's Claude conventions"
                description="Use guidance from the repository’s CLAUDE.md and .claude/ files when generating the review."
              >
                <Toggle
                  checked={claudeContext}
                  ariaLabel="Apply project's Claude conventions"
                  onChange={() => {
                    const next = !claudeContext;
                    setClaudeContext(next);
                    saveField({ claudeContext: next });
                  }}
                />
              </SettingRow>

              <div className="flex flex-col gap-2 py-1">
                <span className="text-sm font-medium text-foreground">Explanation model and effort</span>
                <p className="settings-description">
                  Used for explanations, chat, and interactive diagrams. Higher effort allows more reasoning time and
                  can take longer.
                </p>
                <ModelEffortSelect
                  label="Explanation model"
                  provider={provider}
                  model={model}
                  effort={effort}
                  onChange={(selection) => {
                    setProvider(selection.provider);
                    setModel(selection.model);
                    setEffort(selection.effort);
                    saveField(selection);
                  }}
                />
              </div>
              <SettingRow
                label="Simplify import changes"
                description="Condense import-only changes in the guided review."
              >
                <Toggle
                  checked={smartImports}
                  ariaLabel="Simplify import changes"
                  onChange={() => {
                    setSmartImports(!smartImports);
                    saveField({ smartImports: !smartImports });
                  }}
                />
              </SettingRow>
              <label className="flex flex-col gap-2 text-sm">
                Review instructions
                <textarea
                  value={instructions}
                  rows={3}
                  placeholder="What should reviews focus on?"
                  onChange={(e) => {
                    setInstructions(e.target.value);
                    pendingChanges.current = { ...pendingChanges.current, instructions: e.target.value };
                  }}
                  onBlur={() => saveField({ instructions })}
                  className="rounded-md border border-border bg-background p-2 text-sm"
                />
              </label>
            </Tabs.Content>
            <Tabs.Content value="appearance" className="settings-panel">
              <section className="flex flex-col gap-3">
                <label className="text-sm font-medium text-foreground">Theme</label>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {(['light', 'dark', 'system'] as const).map((t) => (
                    <Chip key={t} active={appTheme === t} onClick={() => handleSelectAppTheme(t)}>
                      {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Match system'}
                    </Chip>
                  ))}
                </div>
              </section>

              <div className="settings-field">
                <label htmlFor="settings-code-font">Code font</label>
                <SearchableSelect id="settings-code-font" label="Code font" value={codeFont}
                  options={CODE_FONTS.map(option => ({ value: option.id, label: option.label }))}
                  onValueChange={value => handleSelectFont(value as CodeFont)}
                />
              </div>
              <div className="settings-field">
                <label htmlFor="settings-code-theme">Code theme</label>
                <SearchableSelect id="settings-code-theme" label="Code theme" value={codeTheme}
                  options={CODE_THEMES.map(option => ({ value: option.id, label: option.label }))}
                  onValueChange={value => handleSelectTheme(value as CodeTheme)}
                />
                <span className="text-xs text-muted-foreground">Code colors are independent of the app theme.</span>
              </div>
              <div className="settings-field">
                <label htmlFor="settings-diff-highlighter">Syntax highlighting</label>
                <SearchableSelect id="settings-diff-highlighter" label="Syntax highlighting" value={diffHighlighter}
                  describedBy="settings-diff-highlighter-description settings-diff-highlighter-restart"
                  options={[
                    { value: 'shiki-js', label: 'Shiki — broader language support' },
                    { value: 'highlights', label: 'Highlights — faster rendering' },
                  ]}
                  onValueChange={value => {
                    const next = resolveDiffHighlighter(value);
                    setDiffHighlighter(next);
                    saveField({ diffHighlighter: next });
                  }}
                />
                <span id="settings-diff-highlighter-description" className="text-xs text-muted-foreground">
                  Highlights speeds up large diffs. Unsupported languages appear as plain text. Code themes work with both.
                </span>
                <span id="settings-diff-highlighter-restart" className="text-xs text-muted-foreground" role="status">
                  {!saving && !saveError && diffHighlighter !== DIFF_HIGHLIGHTER
                    ? 'Saved. Quit and reopen Gnosis to apply.'
                    : 'Changes take effect after you quit and reopen Gnosis.'}
                </span>
              </div>
            </Tabs.Content>
            <Tabs.Content value="notifications" className="settings-panel">
              <NotificationSettings
                desktop={notifications}
                value={notificationPrefs}
                onDesktopChange={(next) => { setNotifications(next); saveField({ notifications: next }); }}
                onChange={(next) => { setNotificationPrefs(next); saveField({ notificationSettings: next }); }}
                Row={SettingRow}
                Toggle={Toggle}
              />
            </Tabs.Content>
            <Tabs.Content value="integrations" className="settings-panel">
              <section className="flex flex-col items-start gap-3" aria-labelledby="preloading-title">
                <h3 id="preloading-title" className="text-sm font-medium">Preloading</h3>
                <div className="w-full">
                  <SettingRow
                    label="Preload likely next pages"
                    description="Prepares the tabs of an opened PR and anything you point at."
                  >
                    <Toggle
                      checked={predictNavigation}
                      ariaLabel="Preload likely next pages"
                      onChange={() => {
                        const next = !predictNavigation;
                        setPredictNavigation(next);
                        saveField({ predictNavigation: next });
                      }}
                    />
                  </SettingRow>
                </div>
                <div className="settings-field">
                  <span id="preload-amount-label">Amount</span>
                  <div role="group" aria-labelledby="preload-amount-label" aria-describedby="preload-amount-description"
                    className="flex flex-wrap gap-x-4 gap-y-2">
                    {PRELOAD_AMOUNTS.map((amount) => (
                      <Chip key={amount} active={preloadAmount === amount} onClick={() => {
                        setPreloadAmount(amount);
                        saveField({ preloadAmount: amount });
                      }}>
                        {AMOUNT_LABELS[amount].label}
                      </Chip>
                    ))}
                  </div>
                  <p id="preload-amount-description" className="settings-description">{AMOUNT_LABELS[preloadAmount].description}</p>
                </div>
                <div className="w-full">
                  <SettingRow
                    label="Prepare the top of the queue"
                    description="Loads status, checks and files for PRs near the top of the queue."
                  >
                    <Toggle
                      checked={prepareQueue}
                      ariaLabel="Prepare the top of the queue"
                      onChange={() => {
                        const next = !prepareQueue;
                        setPrepareQueue(next);
                        saveField({ prepareQueue: next });
                      }}
                    />
                  </SettingRow>
                </div>
                <div className="settings-field">
                  <label htmlFor="preload-budget">Hourly GitHub budget</label>
                  <SearchableSelect id="preload-budget" label="Hourly GitHub budget" value={String(preloadBudgetPercent)}
                    describedBy="preload-budget-description preload-budget-spend"
                    options={PRELOAD_BUDGET_PERCENTS.map(percent => ({ value: String(percent), label: `${percent}% of the hourly limit${percent === DEFAULT_PRELOAD_BUDGET_PERCENT ? ' (default)' : ''}` }))}
                    onValueChange={value => {
                      const percent = normalizePreloadBudgetPercent(Number(value));
                      setPreloadBudgetPercent(percent);
                      saveField({ preloadBudgetPercent: percent });
                    }}
                  />
                  <p id="preload-budget-description" className="settings-description">The share of each hourly limit preloading may use. It also stops early when your limit runs low.</p>
                  <p id="preload-budget-spend" className="settings-description" data-testid="preload-spend">
                    {preloadUsage ? formatPreloadSpend(preloadUsage) : ''}
                  </p>
                </div>
              </section>
              <section className="flex flex-col items-start gap-3" aria-labelledby="github-cache-title">
                <h3 id="github-cache-title" className="text-sm font-medium">GitHub cache</h3>
                <div className="settings-field">
                  <label htmlFor="github-cache-size">Disk cache size</label>
                  <SearchableSelect id="github-cache-size" label="Disk cache size" value={String(cacheSizeMB)}
                    options={GITHUB_CACHE_SIZES_MB.map(size => ({ value: String(size), label: `${size >= 1024 ? `${size / 1024} GB` : `${size} MB`}${size === DEFAULT_GITHUB_CACHE_MB ? ' (default)' : ''}` }))}
                    onValueChange={value => { const size = normalizeGitHubCacheMB(Number(value)); setCacheSizeMB(size); saveField({ githubCacheSizeMB: size }); }}
                  />
                  <p className="settings-description">Keep more changes, commits, and images ready to open. Older downloads are removed when the cache is full. Takes effect immediately; saved reviews and drafts are kept.</p>
                  {storageSizes && (
                    <p className="settings-description" data-testid="storage-sizes">
                      On disk: GitHub cache {formatBytes(storageSizes.githubCacheBytes)} · Saved work and search{' '}
                      {formatBytes(storageSizes.savedWorkBytes)}
                    </p>
                  )}
                </div>
                <p className="settings-description">
                  Remove downloaded PR details, changes, commits, comments, statuses, and images. Gnosis restarts
                  and fetches them again as needed. Saved reviews, briefings, bookmarks, settings, and sign-in stay.
                  Save any unfinished text before restarting.
                </p>
                <Button variant="outline" size="sm" disabled={clearingCache || saving || !!Object.keys(pendingChanges.current).length} onClick={() => void clearGitHubCache()}>
                  {clearingCache ? 'Restarting…' : 'Clear cache & restart'}
                </Button>
                {cacheError && <p role="alert" className="text-sm text-[var(--color-danger)]">{cacheError}</p>}
              </section>
              <section className="ai-setup-guide" aria-labelledby="ai-setup-title">
                <h3 id="ai-setup-title">Set up an AI tool</h3>
                <p>
                  Gnosis uses Claude Code or Codex on your computer to generate explanations. Install one and sign in to
                  it in your terminal.
                </p>
                <p>
                  Choose its model at the top of the review queue. GitHub sign-in connects your PRs; it does not sign you
                  in to the AI tool.
                </p>
                <div className="ai-setup-links">
                  <button onClick={() => {
                    setSetupError('');
                    void window.electronAPI.openExternal('https://code.claude.com/docs/en/setup').catch(() =>
                      setSetupError('Could not open the setup guide. Open https://code.claude.com/docs/en/setup in your browser.'));
                  }}>
                    Claude Code setup ↗
                  </button>
                  <button
                    onClick={() => {
                      setSetupError('');
                      void window.electronAPI.openExternal('https://developers.openai.com/codex/cli/').catch(() =>
                        setSetupError('Could not open the setup guide. Open https://developers.openai.com/codex/cli/ in your browser.'));
                    }}
                  >
                    Codex setup ↗
                  </button>
                </div>
                {setupError && <p role="alert" className="text-sm text-destructive">{setupError}</p>}
                <p>
                  The paths below locate the command-line programs (CLIs). Leave them empty unless automatic detection
                  fails.
                </p>
              </section>
              <SettingRow label="Menu bar icon" description="Show review status and quick actions in the menu bar">
                <Toggle
                  checked={trayEnabled}
                  ariaLabel="Menu bar icon"
                  onChange={() => {
                    const next = !trayEnabled;
                    setTrayEnabled(next);
                    saveField({ trayEnabled: next });
                  }}
                />
              </SettingRow>

              <SettingRow
                label="Anonymous usage analytics"
                description="Sends anonymous app-usage events (e.g. launches, feature usage) to Aptabase, an open-source, privacy-first analytics service. No personal data, no IP addresses, no PRs, no source code — just anonymous event counts that help us decide what to build next."
              >
                <Toggle
                  checked={analytics}
                  ariaLabel="Anonymous usage analytics"
                  onChange={() => {
                    const next = !analytics;
                    setAnalytics(next);
                    saveField({ analytics: next });
                  }}
                />
              </SettingRow>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="claude-path" className="text-sm font-medium text-foreground">
                  Claude Code program path
                </label>
                <input
                  type="text"
                  id="claude-path"
                  value={claudePath}
                  placeholder={claudeDetected || 'auto-detect'}
                  onChange={(e) => {
                    setClaudePath(e.target.value);
                    pendingChanges.current = { ...pendingChanges.current, claudePath: e.target.value };
                  }}
                  onBlur={() => saveField({ claudePath })}
                  className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors"
                />
                <p className="slide-meta">Leave empty to auto-detect.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="codex-path" className="text-sm font-medium text-foreground">
                  Codex program path
                </label>
                <input
                  id="codex-path"
                  type="text"
                  value={codexPath}
                  placeholder={codexDetected || 'auto-detect'}
                  onChange={(e) => {
                    setCodexPath(e.target.value);
                    pendingChanges.current = { ...pendingChanges.current, codexPath: e.target.value };
                  }}
                  onBlur={() => saveField({ codexPath })}
                  className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors"
                />
                <p className="slide-meta">
                  Leave empty to auto-detect. Sign in first with <code>codex login</code>.
                </p>
              </div>

              <HarnessEnvironmentSettings />

              {onShowWalkthrough && <Button variant="outline" size="sm" onClick={onShowWalkthrough}>Show walkthrough</Button>}
              {onReplayOnboarding && (
                <button
                  type="button"
                  onClick={() => {
                    if (savingRef.current || Object.keys(pendingChanges.current).length) return;
                    replayingOnboarding.current = true;
                    onReplayOnboarding();
                    onOpenChange(false);
                  }}
                  className="slide-meta hover:text-foreground transition-colors"
                >
                  Run setup again →
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setLogsError('');
                  void window.electronAPI.openLogsDirectory().catch(() =>
                    setLogsError('Could not open the logs folder. Try Open logs directory again.'));
                }}
                className="slide-meta hover:text-foreground transition-colors"
              >
                Open logs directory →
              </button>
              {logsError && <p role="alert" className="text-sm text-destructive">{logsError}</p>}
            </Tabs.Content>
          </Tabs.Root>
        )}
      </DialogContent>
    </Dialog>
  );
}
