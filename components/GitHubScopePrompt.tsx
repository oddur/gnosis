import { ExternalLink, KeyRound } from 'lucide-react';
import { Button } from './ui/button';
import { scopePromptCopy } from '../lib/github-access';
import { startGitHubSignIn, startGitHubTokenSignIn, useGitHubAccess } from '../lib/use-github-access';

interface ScopeActionProps {
  onSignIn?: () => void;
  /** Open the token form. Outside the GitHub account dialog it opens the dialog there. */
  onUseToken?: () => void;
  disabled?: boolean;
}

/**
 * "Sign in again", or for a personal access token, which can't gain scopes by signing in again: create a token with
 * the scopes preselected, enter it, or use GitHub sign-in instead.
 */
export function GitHubScopeActions({
  onSignIn = startGitHubSignIn,
  onUseToken = startGitHubTokenSignIn,
  disabled = false,
}: ScopeActionProps) {
  const access = useGitHubAccess();
  const copy = scopePromptCopy(access);
  if (copy.kind === 'sign-in')
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={onSignIn}>
        Sign in again
      </Button>
    );
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => void window.electronAPI.openExternal(copy.url).catch(() => {})}
      >
        Create a token on GitHub <ExternalLink size={12} aria-hidden="true" />
      </Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={onUseToken}>
        Enter new token
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onSignIn}>
        Sign in with GitHub instead
      </Button>
    </>
  );
}

/**
 * Asks an older sign-in to allow `read:org` and `workflow`. Calm and optional: the current token keeps working, and
 * nothing signs you out. `message` replaces the general explanation where one need is known, such as GitHub refusing
 * a write for the workflow permission. A personal access token gets token instructions after it (`scopePromptCopy`).
 */
export function GitHubScopePrompt({
  onDismiss,
  message,
  ...actions
}: ScopeActionProps & {
  onDismiss?: () => void;
  message?: string;
}) {
  const access = useGitHubAccess();
  const copy = scopePromptCopy(access, message);
  return (
    <div className="github-scope-prompt" role="note" aria-label="GitHub access" data-scope-prompt={copy.kind}>
      <KeyRound size={14} aria-hidden="true" />
      <p>{copy.text}</p>
      <div className="github-scope-prompt-actions">
        <GitHubScopeActions {...actions} />
        {onDismiss && (
          <Button size="sm" variant="ghost" disabled={actions.disabled} onClick={onDismiss}>
            Not now
          </Button>
        )}
      </div>
    </div>
  );
}
