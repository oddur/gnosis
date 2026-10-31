import { DIFF_HIGHLIGHTER, DEFAULT_DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { resolveDiffHighlighter, type DiffHighlighter } from '../lib/diff-highlighter-preference';
import { HarnessEnvironmentSettings } from './HarnessEnvironmentSettings';
import { GITHUB_CACHE_SIZES_MB, DEFAULT_GITHUB_CACHE_MB, normalizeGitHubCacheMB } from '../lib/github-cache-settings';
import { SearchableSelect } from './SearchableSelect';
import { Button } from './ui/button';
import { PrInactivitySetting } from './PrInactivitySetting';
import { normalizePrInactivityDays, DEFAULT_PR_INACTIVITY_DAYS } from '../lib/pr-inactivity';
import { useState, useEffect, useRef } from 'react';
import { LocalCloneSettings } from './LocalCloneSettings';
import { Tabs } from 'radix-ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';
import { applyTheme, type ThemeChoice } from '@/lib/theme';
import { PROVIDERS, PROVIDER_IDS, DEFAULT_FAST_CLAUDE_MODEL } from '@/lib/models';
import type { ModelId, Preferences, Provider, RepoSearchResult } from '@/lib/types';

export type SettingsSection = 'queue' | 'review' | 'appearance' | 'integrations';

interface Props {
  initialSection?: SettingsSection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange?: (theme: string) => void;
  // Reopens the optional setup panel in the review queue.
  onReplayOnboarding?: () => void;
  onShowWalkthrough?: () => void;
}

// Default faces ship locally. Fetch optional code families only when selected.
const optionalFontStyles: Record<string, string[]> = {
  'fira-code': ['https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap'],
  hack: ['https://cdn.jsdelivr.net/npm/hack-font@3/build/web/hack.css'],
  'monaspace-neon': [
    'https://cdn.jsdelivr.net/npm/@fontsource/monaspace-neon@5/400.css',
    'https://cdn.jsdelivr.net/npm/@fontsource/monaspace-neon@5/700.css',
  ],
  iosevka: [
    'https://cdn.jsdelivr.net/npm/@fontsource/iosevka@5/400.css',
    'https://cdn.jsdelivr.net/npm/@fontsource/iosevka@5/700.css',
  ],
};

export function applyCodeFont(fontId: string) {
  const font = CODE_FONTS.find((f) => f.id === fontId);
  if (font) {
    for (const [index, href] of (optionalFontStyles[font.id] ?? []).entries()) {
      const id = `code-font-${font.id}-${index}`;
      if (document.getElementById(id)) continue;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      document.head.append(link);
    }
    document.documentElement.style.setProperty(
      '--font-mono',
      `${font.family}, 'JetBrains Mono', ui-monospace, monospace`
    );
  }
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
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
  const [diffHighlighter, setDiffHighlighter] = useState<DiffHighlighter>(DIFF_HIGHLIGHTER);
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [thinking, setThinking] = useState(false);
  const [smartImports, setSmartImports] = useState(true);
  const [prInactivityDays, setPrInactivityDays] = useState(DEFAULT_PR_INACTIVITY_DAYS);
  const [ignoreDependabotPrs, setIgnoreDependabotPrs] = useState(true);
  const [autoBriefings, setAutoBriefings] = useState(false);
  const [watchedRepos, setWatchedRepos] = useState<string[]>([]);
  const [watchedRepoInput, setWatchedRepoInput] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<RepoSearchResult[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const showSuggestions = repoSuggestions.length > 0 && !suggestionsDismissed;
  const replayingOnboarding = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [briefingDailyLimit, setBriefingDailyLimit] = useState(10);
  const [parallelReview, setParallelReview] = useState(false);
  const [educationMode, setEducationMode] = useState(true);
  const [claudeContext, setClaudeContext] = useState(true);
  const [analytics, setAnalytics] = useState(true);
  const [proactiveReviewOverrides, setProactiveReviewOverrides] = useState(false);
  const [proactiveModel, setProactiveModel] = useState<ModelId>(DEFAULT_FAST_CLAUDE_MODEL);
  const [proactiveThinking, setProactiveThinking] = useState(false);
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
        setThinking(prefs.thinking);
        setSmartImports(prefs.smartImports);
        setAutoBriefings(prefs.autoBriefings !== false);
        setIgnoreDependabotPrs(prefs.ignoreDependabotPrs !== false);
        setPrInactivityDays(normalizePrInactivityDays(prefs.prInactivityDays));
        setCacheSizeMB(normalizeGitHubCacheMB(prefs.githubCacheSizeMB));
        setWatchedRepos(prefs.watchedRepos);
        setNotifications(prefs.notifications);
        setTrayEnabled(prefs.trayEnabled);
        setBriefingDailyLimit(prefs.briefingDailyLimit ?? 10);
        setParallelReview(prefs.parallelReview);
        setEducationMode(prefs.educationMode);
        setClaudeContext(prefs.claudeContext);
        setAnalytics(prefs.analytics);
        setProactiveReviewOverrides(prefs.proactiveReviewOverrides);
        setProactiveProvider(prefs.proactiveProvider);
        setProactiveModel(prefs.proactiveModel);
        setCodexPath(prefs.codexPath);
        setProactiveThinking(prefs.proactiveThinking);
        setClaudePath(prefs.claudePath || '');
      })
      .catch(() => {
        if (active) setLoadState('error');
      });
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
    const next = [...watchedRepos, name];
    setWatchedRepos(next);
    searchRepositories('');
    saveField({ watchedRepos: next });
    document.getElementById('watched-repos')?.focus();
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="settings-dialog bg-card sm:max-w-2xl"
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
            {saving ? 'Saving changes…' : saveError ? 'You have unsaved changes.' : 'Changes save automatically.'}
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
        {loadState === 'loading' && <p role="status">Loading settings…</p>}
        {loadState === 'error' && (
          <div className="settings-load-error" role="alert">
            <p>Could not load your settings. Retry before making changes.</p>
            <button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading settings</button>
          </div>
        )}
        {loadState === 'ready' && (
          <Tabs.Root
            className="settings-tabs"
            value={section}
            onValueChange={(value) => setSection(value as SettingsSection)}
          >
            <Tabs.List className="settings-sections" aria-label="Settings sections">
              <Tabs.Trigger value="queue">Queue &amp; briefings</Tabs.Trigger>
              <Tabs.Trigger value="review">Review</Tabs.Trigger>
              <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
              <Tabs.Trigger value="integrations">Integrations</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="queue" className="settings-panel">
              <SettingRow label="Ignore PRs inactive for…"
                description="Uses the last GitHub update. Keep starred PRs and any stack with a recent or starred PR. Applies to all saved views.">
                <PrInactivitySetting days={prInactivityDays} onChange={days => {
                  setPrInactivityDays(days); saveField({ prInactivityDays: days });
                }} />
              </SettingRow>
              <SettingRow
                label="Ignore Dependabot PRs"
                description="Hide Dependabot PRs from the queue and automatic briefings. Keep them visible when a PR by a person builds on them."
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
              <SettingRow
                label="Automatic briefings"
                description="Generate short AI summaries in the background. Queue filters control which PRs and stacks are included; the daily attempt limit still applies."
              >
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
                <label htmlFor="watched-repos" className="text-sm font-medium text-foreground">
                  Repositories in your queue
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
                            <span className="max-w-full break-words font-mono text-xs text-foreground">{repo.fullName}</span>
                            {repo.description && (
                              <span className="max-w-full text-xs text-muted-foreground truncate">{repo.description}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {watchedRepos.length > 0 && (
                  <ul className="flex flex-col gap-1 mt-1">
                    {watchedRepos.map((repo) => (
                      <li key={repo} className="flex items-center justify-between gap-2 text-sm text-foreground">
                        <span className="min-w-0 break-words font-mono text-xs">{repo}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = watchedRepos.filter((r) => r !== repo);
                            setWatchedRepos(next);
                            saveField({ watchedRepos: next });
                          }}
                          aria-label={`Remove ${repo} from your queue`}
                          className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center justify-between gap-4 mt-2">
                  <div className="flex flex-col gap-0.5">
                    <label htmlFor="settings-briefing-limit" className="text-sm font-medium text-foreground">
                      Daily briefing limit
                    </label>
                    <p className="settings-description">
                      Maximum automatic briefing attempts per day, including retries. AI explanations do not count
                      toward this limit.
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

                <div className="mt-2 pt-3 border-t border-border flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium text-foreground">Use a different model for briefings</span>
                    <span className="slide-meta">
                      Keep a separate model for briefings when you change the explanation model. Turn this off to use
                      the explanation model for both.
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

                {proactiveReviewOverrides && (
                  <div className="flex flex-col gap-3 mt-1">
                    {PROVIDER_IDS.map((id) => (
                      <div key={id} className="flex flex-wrap items-center gap-x-5 gap-y-2 slide-meta">
                        <span className="text-foreground/60">{PROVIDERS[id].label}</span>
                        {PROVIDERS[id].models.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            aria-pressed={proactiveProvider === id && proactiveModel === m.id}
                            onClick={() => {
                              setProactiveProvider(id);
                              setProactiveModel(m.id);
                              saveField({ proactiveProvider: id, proactiveModel: m.id });
                            }}
                            className={`pb-0.5 border-b transition-colors ${proactiveModel === m.id ? 'text-foreground border-[var(--ring)]' : 'border-transparent hover:text-foreground'}`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-medium text-foreground">Deeper reasoning</span>
                        <span className="slide-meta">Off is usually faster and cheaper for background runs.</span>
                      </div>
                      <div className="shrink-0">
                        <Toggle
                          checked={proactiveThinking}
                          ariaLabel="Proactive deeper reasoning"
                          onChange={() => {
                            const next = !proactiveThinking;
                            setProactiveThinking(next);
                            saveField({ proactiveThinking: next });
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
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
                label="Explain background concepts"
                description="Include short notes about concepts used by the code, alongside the relevant review topic."
              >
                <Toggle
                  checked={educationMode}
                  ariaLabel="Explain background concepts"
                  onChange={() => {
                    const next = !educationMode;
                    setEducationMode(next);
                    saveField({ educationMode: next });
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

              <SettingRow label="Deeper review reasoning" description="Give detailed reviews more reasoning time.">
                <Toggle
                  checked={thinking}
                  ariaLabel="Deeper review reasoning"
                  onChange={() => {
                    setThinking(!thinking);
                    saveField({ thinking: !thinking });
                  }}
                />
              </SettingRow>
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
            <Tabs.Content value="integrations" className="settings-panel">
              <LocalCloneSettings />
              <section className="flex flex-col items-start gap-3" aria-labelledby="github-cache-title">
                <h3 id="github-cache-title" className="text-sm font-medium">GitHub cache</h3>
                <div className="settings-field">
                  <label htmlFor="github-cache-size">Disk cache size</label>
                  <SearchableSelect id="github-cache-size" label="Disk cache size" value={String(cacheSizeMB)}
                    options={GITHUB_CACHE_SIZES_MB.map(size => ({ value: String(size), label: `${size >= 1024 ? `${size / 1024} GB` : `${size} MB`}${size === DEFAULT_GITHUB_CACHE_MB ? ' (default)' : ''}` }))}
                    onValueChange={value => { const size = normalizeGitHubCacheMB(Number(value)); setCacheSizeMB(size); saveField({ githubCacheSizeMB: size }); }}
                  />
                  <p className="settings-description">Keep more changes, commits, and images ready to open. Older downloads are removed when the cache is full. Takes effect immediately; saved reviews and drafts are kept.</p>
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
              <SettingRow label="Desktop notifications" description="Notify when a review completes">
                <Toggle
                  checked={notifications}
                  ariaLabel="Desktop notifications"
                  onChange={() => {
                    const next = !notifications;
                    setNotifications(next);
                    saveField({ notifications: next });
                  }}
                />
              </SettingRow>

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
