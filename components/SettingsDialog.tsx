import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';
import { applyTheme, type ThemeChoice } from '@/lib/theme';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange?: (theme: string) => void;
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

export function SettingsDialog({ open, onOpenChange, onThemeChange }: Props) {
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [autoReviewOnRequest, setAutoReviewOnRequest] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [claudePath, setClaudePath] = useState('');
  const [geminiPath, setGeminiPath] = useState('');
  const [claudeDetected, setClaudeDetected] = useState('');
  const [geminiDetected, setGeminiDetected] = useState('');

  useEffect(() => {
    if (!open) return;
    void window.electronAPI.loadPreferences().then((prefs) => {
      setAppTheme(prefs.theme);
      if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
      if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
      setEnableTools(prefs.enableTools);
      setAutoReviewOnRequest(prefs.autoReviewOnRequest);
      setNotifications(prefs.notifications);
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

  function saveField(overrides: Partial<Record<string, string | boolean>>) {
    void window.electronAPI.loadPreferences().then((prefs) => {
      void window.electronAPI.savePreferences({ ...prefs, ...overrides });
    });
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
      <DialogContent className="bg-card sm:max-w-md">
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
              label="Enable AI tools"
              description="Allow the AI to search the web and fetch GitHub context (slower but more thorough)"
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
              label="Auto-review when assigned"
              description="Automatically run a review when you're added as a reviewer; you'll be notified when it's ready."
            >
              <Toggle
                checked={autoReviewOnRequest}
                ariaLabel="Auto-review when assigned"
                onChange={() => {
                  const next = !autoReviewOnRequest;
                  setAutoReviewOnRequest(next);
                  saveField({ autoReviewOnRequest: next });
                }}
              />
            </SettingRow>

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
                className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-[var(--ring)] transition-colors"
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
                className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-[var(--ring)] transition-colors"
              />
              <p className="slide-meta">Leave empty to auto-detect.</p>
            </div>
          </section>

          <section className="border-t border-border pt-5">
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
