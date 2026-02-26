import { useState, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';

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

export function SettingsDialog({ open, onOpenChange, onThemeChange }: Props) {
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [claudePath, setClaudePath] = useState('');
  const [geminiPath, setGeminiPath] = useState('');
  const [claudeDetected, setClaudeDetected] = useState('');
  const [geminiDetected, setGeminiDetected] = useState('');

  useEffect(() => {
    if (!open) return;
    void window.electronAPI.loadPreferences().then((prefs) => {
      if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
      if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
      setEnableTools(prefs.enableTools);
      setNotifications(prefs.notifications);
      setClaudePath(prefs.claudePath || '');
      setGeminiPath(prefs.geminiPath || '');
    });
    void window.electronAPI.detectBinaryPath('claude').then(setClaudeDetected);
    void window.electronAPI.detectBinaryPath('gemini').then(setGeminiDetected);
  }, [open]);

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
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your preferences</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Code font</label>
            <div className="flex flex-wrap gap-2">
              {CODE_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => handleSelectFont(f.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    codeFont === f.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30'
                  }`}
                  style={{ fontFamily: `${f.family}, monospace` }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Code theme</label>
            <div className="flex flex-wrap gap-2">
              {CODE_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleSelectTheme(t.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    codeTheme === t.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-sm font-medium">Enable AI tools</label>
              <p className="text-xs text-muted-foreground">
                Allow the AI to search the web and fetch GitHub context (slower but more thorough)
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enableTools}
              onClick={() => {
                const next = !enableTools;
                setEnableTools(next);
                saveField({ enableTools: next });
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                enableTools ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  enableTools ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-sm font-medium">Desktop notifications</label>
              <p className="text-xs text-muted-foreground">Notify when a review completes</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notifications}
              onClick={() => {
                const next = !notifications;
                setNotifications(next);
                saveField({ notifications: next });
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                notifications ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  notifications ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Claude CLI path</label>
            <input
              type="text"
              value={claudePath}
              placeholder={claudeDetected || 'auto-detect'}
              onChange={(e) => setClaudePath(e.target.value)}
              onBlur={() => saveField({ claudePath })}
              className="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">Leave empty to auto-detect</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Gemini CLI path</label>
            <input
              type="text"
              value={geminiPath}
              placeholder={geminiDetected || 'auto-detect'}
              onChange={(e) => setGeminiPath(e.target.value)}
              onBlur={() => saveField({ geminiPath })}
              className="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">Leave empty to auto-detect</p>
          </div>

          <div className="border-t border-border pt-4">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void window.electronAPI.openLogsDirectory()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open logs
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
