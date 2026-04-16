import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';
import { applyTheme, type ThemeChoice } from '@/lib/theme';
import type { Preferences, RepoSearchResult } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange?: (theme: string) => void;
  // Resets the first-run welcome, the keyboard hint, and any
  // localStorage onboarding flags so the user can re-experience the
  // first-time path. Owned by HomePage because HomePage holds the
  // firstRunOpen / hasEverHadPendingReviews / keyboardHintDismissed
  // state slots that need to be reset together.
  onReplayOnboarding?: () => void;
}

export function applyCodeFont(fontId: string) {
  const font = CODE_FONTS.find((f) => f.id === fontId);
  if (font) {
    document.documentElement.style.setProperty('--font-mono', `${font.family}, ui-monospace, monospace`);
  }
}

// Quiet toggle switch — drops the bg-primary fill (now ink) and the
// shadow-sm thumb in favor of a warm-amber active state and a flat
// thumb. Used across all the on/off settings.
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
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
      style={style}
      className={`text-sm pb-0.5 border-b transition-colors ${
        active ? 'text-foreground border-[var(--ring)]' : 'border-transparent text-muted-foreground hover:text-foreground'
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
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <span className="slide-meta">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, onThemeChange, onReplayOnboarding }: Props) {
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [proactiveMode, setProactiveMode] = useState(false);
  const [watchedRepos, setWatchedRepos] = useState<string[]>([]);
  const [watchedRepoInput, setWatchedRepoInput] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<RepoSearchResult[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const showSuggestions = repoSuggestions.length > 0 && !suggestionsDismissed;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [maxPrsPerRepo, setMaxPrsPerRepo] = useState(10);
  const [claudePath, setClaudePath] = useState('');
  const [geminiPath, setGeminiPath] = useState('');
  const [claudeDetected, setClaudeDetected] = useState('');
  const [geminiDetected, setGeminiDetected] = useState('');

  // Clean up debounce timer on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  useEffect(() => {
    if (!open) return;
    void window.electronAPI.loadPreferences().then((prefs) => {
      setAppTheme(prefs.theme);
      if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
      if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
      setEnableTools(prefs.enableTools);
      setProactiveMode(prefs.proactiveMode);
      setWatchedRepos(prefs.watchedRepos ?? []);
      setNotifications(prefs.notifications);
      setTrayEnabled(prefs.trayEnabled);
      setMaxPrsPerRepo(prefs.maxPrsPerRepo);
      setClaudePath(prefs.claudePath || '');
      setGeminiPath(prefs.geminiPath || '');
    });
    void window.electronAPI.detectBinaryPath('claude').then(setClaudeDetected);
    void window.electronAPI.detectBinaryPath('gemini').then(setGeminiDetected);
  }, [open]);

  function handleSelectAppTheme(theme: ThemeChoice) {
    setAppTheme(theme);
    saveField({ theme });
    applyTheme(theme);
  }

  function saveField(overrides: Partial<Preferences>) {
    void window.electronAPI.loadPreferences().then((prefs) => {
      void window.electronAPI.savePreferences({ ...prefs, ...overrides });
    });
  }

  function addWatchedRepo(name: string) {
    if (!name || watchedRepos.includes(name)) return;
    const next = [...watchedRepos, name];
    setWatchedRepos(next);
    setWatchedRepoInput('');
    setRepoSuggestions([]);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="editorial-heading">Settings</DialogTitle>
          <DialogDescription className="slide-meta">Configure your preferences</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 mt-2">
          <section className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground">Theme</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <Chip key={t} active={appTheme === t} onClick={() => handleSelectAppTheme(t)}>
                  {t === 'light' ? 'Paper' : t === 'dark' ? 'Study' : 'Match system'}
                </Chip>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground">Code font</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {CODE_FONTS.map((f) => (
                <Chip
                  key={f.id}
                  active={codeFont === f.id}
                  onClick={() => handleSelectFont(f.id)}
                  style={{ fontFamily: `${f.family}, monospace` }}
                >
                  {f.label}
                </Chip>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground">Code theme</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {CODE_THEMES.map((t) => (
                <Chip key={t.id} active={codeTheme === t.id} onClick={() => handleSelectTheme(t.id)}>
                  {t.label}
                </Chip>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3 border-t border-border pt-5">
            <SettingRow
              label="Web search and context"
              description="Let the model search the web and fetch GitHub context during generation. More thorough, but slower."
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
              label="Proactive mode"
              description="Automatically review your PRs, assigned reviews, and watched repos. Re-generates when the PR updates."
            >
              <Toggle
                checked={proactiveMode}
                ariaLabel="Proactive mode"
                onChange={() => {
                  const next = !proactiveMode;
                  setProactiveMode(next);
                  saveField({ proactiveMode: next });
                }}
              />
            </SettingRow>

            {proactiveMode && (
              <div className="flex flex-col gap-2 ml-0.5">
                <label className="text-sm font-medium text-foreground">Watched repos</label>
                <p className="text-xs text-muted-foreground">
                  All open PRs in these repos will be reviewed automatically.
                </p>
                <div className="relative">
                  <div className="flex items-end gap-2">
                    <input
                      type="text"
                      value={watchedRepoInput}
                      placeholder="Search for a repo…"
                      onChange={(e) => {
                        const val = e.target.value;
                        setWatchedRepoInput(val);
                        setSuggestionsDismissed(false);
                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        if (val.trim().length >= 2) {
                          debounceRef.current = setTimeout(() => {
                            void window.electronAPI.searchRepos(val.trim()).then((results) => {
                              setRepoSuggestions(results.filter((r) => !watchedRepos.includes(r.fullName)));
                            });
                          }, 300);
                        } else {
                          setRepoSuggestions([]);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const trimmed = watchedRepoInput.trim();
                          if (trimmed.includes('/')) addWatchedRepo(trimmed);
                        }
                        if (e.key === 'Escape') setSuggestionsDismissed(true);
                      }}
                      onFocus={() => setSuggestionsDismissed(false)}
                      onBlur={() => setTimeout(() => setSuggestionsDismissed(true), 200)}
                      className="flex-1 bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors"
                    />
                  </div>
                  {showSuggestions && (
                    <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto">
                      {repoSuggestions.map((repo) => (
                        <li key={repo.fullName}>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex flex-col gap-0.5"
                            onMouseDown={(e) => { e.preventDefault(); addWatchedRepo(repo.fullName); }}
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
                  <label className="text-sm font-medium text-foreground">Max PRs per repo</label>
                  <p className="text-xs text-muted-foreground">
                    How many of the latest open PRs to review per watched repo.
                  </p>
                </div>
                <select
                  value={maxPrsPerRepo}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setMaxPrsPerRepo(next);
                    saveField({ maxPrsPerRepo: next });
                  }}
                  className="bg-transparent border border-border rounded-md px-2 py-1 text-sm text-foreground"
                >
                  {[5, 10, 15, 20, 30, 50].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              </div>
            )}

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
          </section>

          <section className="flex flex-col gap-4 border-t border-border pt-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">Claude CLI path</label>
              <input
                type="text"
                value={claudePath}
                placeholder={claudeDetected || 'auto-detect'}
                onChange={(e) => setClaudePath(e.target.value)}
                onBlur={() => saveField({ claudePath })}
                className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors"
              />
              <p className="slide-meta">Leave empty to auto-detect.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">Gemini CLI path</label>
              <input
                type="text"
                value={geminiPath}
                placeholder={geminiDetected || 'auto-detect'}
                onChange={(e) => setGeminiPath(e.target.value)}
                onBlur={() => saveField({ geminiPath })}
                className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors"
              />
              <p className="slide-meta">Leave empty to auto-detect.</p>
            </div>
          </section>

          <section className="border-t border-border pt-5 flex flex-col gap-2 items-start">
            {onReplayOnboarding && (
              <button
                type="button"
                onClick={() => {
                  onReplayOnboarding();
                  onOpenChange(false);
                }}
                className="slide-meta hover:text-foreground transition-colors"
              >
                Replay first-time welcome →
              </button>
            )}
            <button
              type="button"
              onClick={() => void window.electronAPI.openLogsDirectory()}
              className="slide-meta hover:text-foreground transition-colors"
            >
              Open logs directory →
            </button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
