import { useEffect, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { Button } from './ui/button';
import type { Provider } from '../lib/types';

export function GettingStarted({
  provider,
  settingsOpen,
  onSettings,
  onOpenPr,
  onLocal,
  onDismiss,
}: {
  provider: Provider;
  settingsOpen: boolean;
  onSettings: () => void;
  onOpenPr: () => void;
  onLocal: () => void;
  onDismiss: () => void;
}) {
  const toolName = provider === 'claude' ? 'Claude Code' : 'Codex';
  const [check, setCheck] = useState<'checking' | 'found' | 'missing' | 'failed'>('checking');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    setCheck('checking');
    void window.electronAPI.checkCliInstalled(provider).then(
      (result) => {
        if (!cancelled) setCheck(result.installed ? 'found' : 'missing');
      },
      () => {
        if (!cancelled) setCheck('failed');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [provider, settingsOpen, attempt]);
  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <div className="getting-started-heading">
        <h2 id="getting-started-title">Understand your first change</h2>
        <button className="workbench-icon" aria-label="Dismiss getting started" onClick={onDismiss}>
          <X size={16} />
        </button>
      </div>
      <p>Open a pull request or local changes for a guided explanation beside the code.</p>
      <div className="getting-started-setup">
        <p role="status">
          {check === 'checking'
            ? `Checking for ${toolName}…`
            : check === 'found'
              ? `${toolName} found. Make sure you are signed in to it in your terminal.`
              : check === 'missing'
                ? `${toolName} was not found. Install and sign in to this AI tool before generating a review.`
                : `Could not check ${toolName}. Check its setup or try again.`}
        </p>
        <button onClick={onSettings}>AI setup</button>
        {(check === 'missing' || check === 'failed') && (
          <button onClick={() => setAttempt((n) => n + 1)}>Check again</button>
        )}
      </div>
      <div className="getting-started-actions">
        <Button size="sm" onClick={onOpenPr}>
          Open a pull request <ArrowRight size={14} />
        </Button>
        <Button size="sm" variant="outline" onClick={onLocal}>
          Review local changes
        </Button>
      </div>
      <p className="getting-started-note">
        Generation runs in Activity below. Reviews are saved here; feedback goes to GitHub only when you submit it.
      </p>
    </section>
  );
}
