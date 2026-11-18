import { UsersRound } from 'lucide-react';
import { Button } from './ui/button';
import { TEAM_REQUESTS_NOTE, TEAM_REQUESTS_TOKEN_NOTE, teamRequestsNoteVisible } from '../lib/github-access';
import { dismissScopes, useGitHubAccess, useScopeDismissal } from '../lib/use-github-access';
import { GitHubScopeActions } from './GitHubScopePrompt';

/**
 * Where Gnosis shows team review requests, a sign-in without `read:org` may miss some: GitHub hides the organization's
 * teams from it. One quiet note per surface, dismissed per account and surface in the sign-in prompt's store.
 */
export function TeamRequestsNote({
  surface,
  showsTeamRequests = true,
}: {
  /** Names the surface in the dismissal store and in `data-team-requests-note`. */
  surface: 'overview' | 'review-requests' | 'notifications';
  showsTeamRequests?: boolean;
}) {
  const access = useGitHubAccess();
  const dismissed = useScopeDismissal(access?.login, `team-requests:${surface}`);
  if (!access?.login || !teamRequestsNoteVisible({ scopes: access.scopes, showsTeamRequests, dismissed })) return null;
  return (
    <div className="team-requests-note" role="note" aria-label="Team review requests" data-team-requests-note={surface}>
      <UsersRound size={13} aria-hidden="true" />
      <p>{access.tokenKind === 'classic' ? TEAM_REQUESTS_TOKEN_NOTE : TEAM_REQUESTS_NOTE}</p>
      <div className="team-requests-note-actions">
        <GitHubScopeActions />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => dismissScopes(access.login, ['read:org'], `team-requests:${surface}`)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
