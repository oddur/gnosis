import { PrInactivitySetting } from './PrInactivitySetting';
import { normalizePrInactivityDays, DEFAULT_PR_INACTIVITY_DAYS } from '../lib/pr-inactivity';
import { useState, useEffect, useRef } from 'react';
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
  // Reopens the optional setup panel in the work queue.
  onReplayOnboarding?: () => void;
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
  initialSection = 'queue',
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
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
        if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
        if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
        setEnableTools(prefs.enableTools);
        setInstructions(prefs.instructions);
        setThinking(prefs.thinking);
        setSmartImports(prefs.smartImports);
        setAutoBriefings(prefs.autoBriefings !== false);
        setIgnoreDependabotPrs(prefs.ignoreDependabotPrs !== false);
        setPrInactivityDays(normalizePrInactivityDays(prefs.prInactivityDays));
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
    if (!next && (savingRef.current || Object.keys(pendingChanges.current).length)) return;
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
                <div className="relative">
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
                        if (e.key === 'Escape') setSuggestionsDismissed(true);
                      }}
                      onFocus={() => setSuggestionsDismissed(false)}
                      onBlur={() => setTimeout(() => setSuggestionsDismissed(true), 200)}
                      className="flex-1 bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors"
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
                            <span className="font-mono text-xs text-foreground">{repo.fullName}</span>
                            {repo.description && (
                              <span className="text-xs text-muted-foreground truncate">{repo.description}</span>
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
                        <span className="font-mono text-xs">{repo}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = watchedRepos.filter((r) => r !== repo);
                            setWatchedRepos(next);
                            saveField({ watchedRepos: next });
                          }}
                          className="text-xs text-muted-foreground hover:text-destructive transition-colors"
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
                      Choose a separate AI model for automatic briefings. Selecting a model in the queue makes reviews
                      and briefings use that model again.
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
                  onChange={(e) => setInstructions(e.target.value)}
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

              <label className="settings-field">
                Code font
                <select value={codeFont} onChange={(e) => handleSelectFont(e.target.value as CodeFont)}>
                  {CODE_FONTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                Code theme
                <select value={codeTheme} onChange={(e) => handleSelectTheme(e.target.value as CodeTheme)}>
                  {CODE_THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">Code colors are independent of the app theme.</span>
              </label>
            </Tabs.Content>
            <Tabs.Content value="integrations" className="settings-panel">
              <section className="ai-setup-guide" aria-labelledby="ai-setup-title">
                <h3 id="ai-setup-title">Set up an AI tool</h3>
                <p>
                  Gnosis uses Claude Code or Codex on your computer to generate explanations. Install one and sign in to
                  it in your terminal.
                </p>
                <p>
                  Choose its model at the top of the work queue. GitHub sign-in connects your PRs; it does not sign you
                  in to the AI tool.
                </p>
                <div className="ai-setup-links">
                  <button onClick={() => void window.electronAPI.openExternal('https://code.claude.com/docs/en/setup')}>
                    Claude Code setup ↗
                  </button>
                  <button
                    onClick={() => void window.electronAPI.openExternal('https://developers.openai.com/codex/cli/')}
                  >
                    Codex setup ↗
                  </button>
                </div>
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
                  onChange={(e) => setClaudePath(e.target.value)}
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
                  onChange={(e) => setCodexPath(e.target.value)}
                  onBlur={() => saveField({ codexPath })}
                  className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors"
                />
                <p className="slide-meta">
                  Leave empty to auto-detect. Sign in first with <code>codex login</code>.
                </p>
              </div>

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
                  Show getting started →
                </button>
              )}
              <button
                type="button"
                onClick={() => void window.electronAPI.openLogsDirectory()}
                className="slide-meta hover:text-foreground transition-colors"
              >
                Open logs directory →
              </button>
            </Tabs.Content>
          </Tabs.Root>
        )}
      </DialogContent>
    </Dialog>
  );
}
