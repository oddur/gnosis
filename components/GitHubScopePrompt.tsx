import { KeyRound } from 'lucide-react';
import { Button } from './ui/button';
import { GITHUB_SCOPE_PROMPT } from '../lib/github-access';

/**
 * Asks an older sign-in to allow `read:org` and `workflow`. Calm and optional: the current token keeps working, and
 * nothing signs you out.
 */
export function GitHubScopePrompt({
  onSignIn,
  onDismiss,
  disabled = false,
}: {
  onSignIn: () => void;
  onDismiss?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="github-scope-prompt" role="note" aria-label="GitHub access">
      <KeyRound size={14} aria-hidden="true" />
      <p>{GITHUB_SCOPE_PROMPT}</p>
      <div className="github-scope-prompt-actions">
        <Button size="sm" variant="outline" disabled={disabled} onClick={onSignIn}>
          Sign in again
        </Button>
        {onDismiss && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onDismiss}>
            Not now
          </Button>
        )}
      </div>
    </div>
  );
}
