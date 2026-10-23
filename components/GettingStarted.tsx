import { useEffect, useState, useRef, type ReactNode } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { Button } from './ui/button';
import type { Provider } from '../lib/types';

export function GettingStarted({
  provider,
  focusOnMount = false,
  settingsOpen,
  githubConnection,
  githubLogin,
  hasQueueItems,
  onRepositories,
  onSettings,
  onOpenPr,
  onLocal,
  onDismiss,
}: {
  provider: Provider;
  focusOnMount?: boolean;
  settingsOpen: boolean;
  githubConnection?: ReactNode;
  githubLogin?: string | null;
  hasQueueItems: boolean;
  onRepositories: () => void;
  onSettings: () => void;
  onOpenPr: () => void;
  onLocal: () => void;
  onDismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);
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
        <h2 ref={heading} tabIndex={-1} id="getting-started-title">
          Understand your first PR
        </h2>
        <button className="workbench-icon" aria-label="Dismiss getting started" onClick={onDismiss}>
          <X size={16} />
        </button>
      </div>
      <p>
        Read the author’s description and GitHub status first. Add an AI walkthrough when you want to dig into the code.
      </p>
      <div className="getting-started-actions">
        <Button size="sm" onClick={onOpenPr}>
          Open a pull request <ArrowRight size={14} />
        </Button>
        <Button size="sm" variant="outline" onClick={onLocal}>
          Review local changes
        </Button>
      </div>
      <p className="getting-started-note">
        {hasQueueItems ? 'Or choose a PR from the queue below. ' : ''}
        Opening a PR does not start AI generation.
      </p>
      <div className="getting-started-connections">
        {githubConnection ? (
          <details className="getting-started-connection">
            <summary>
              Connect GitHub <span>For private PRs and your review queue</span>
            </summary>
            {githubConnection}
          </details>
        ) : githubLogin ? (
          <div className="getting-started-connected">
            <span>
              <Check size={14} aria-hidden="true" /> GitHub connected as {githubLogin}
            </span>
            <button onClick={onRepositories}>Choose repositories</button>
          </div>
        ) : null}
        <details className="getting-started-setup">
          <summary>
            Add AI explanations{' '}
            <span>
              {toolName}
              {check === 'found'
                ? ' found'
                : check === 'missing'
                  ? ' needs setup'
                  : check === 'checking'
                    ? ' · checking…'
                    : ' · check unavailable'}
            </span>
          </summary>
          <p>
            Claude Code or Codex runs the AI walkthroughs. GitHub sign-in is separate; you can read PR overviews before
            setting this up.
          </p>
          <p role="status">
            {check === 'checking'
              ? `Checking for ${toolName}…`
              : check === 'found'
                ? `${toolName} found. Make sure you are signed in to it in your terminal.`
                : check === 'missing'
                  ? `${toolName} was not found. Install and sign in to it before generating an explanation.`
                  : `Could not check ${toolName}. Check its setup or try again.`}
          </p>
          <button onClick={onSettings}>AI setup</button>
          {(check === 'missing' || check === 'failed') && (
            <button onClick={() => setAttempt((n) => n + 1)}>Check again</button>
          )}
        </details>
      </div>
      <p className="getting-started-note">
        Explanations run in Activity below and are saved on this computer. Feedback goes to GitHub only when you submit
        it.
      </p>
      <button className="getting-started-skip" onClick={onDismiss}>
        I’ll explore on my own
      </button>
    </section>
  );
}
