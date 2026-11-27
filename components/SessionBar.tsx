import { ArrowLeft, ArrowRight, CircleCheck } from 'lucide-react';
import { Button } from './ui/button';
import { requestSession, useSessionState } from '../lib/session-store';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';

/**
 * The guided session's bar on a PR the session opened (#596): where the PR is in the run, the way back to its step,
 * and the next PR. Once the PR is finished here (a review submitted, or every change viewed), Next is the bar's one
 * primary action, so moving on is one press. Shown only while a session runs and lists this PR.
 */
export function SessionBar({ urls }: { urls: readonly string[] }) {
  const session = useSessionState();
  const navigation = useWorkspaceNavigation();
  const index = session ? session.steps.findIndex((step) => urls.includes(step.url)) : -1;
  if (!session || index < 0) return null;
  const step = session.steps[index];
  const following = index + 1 < session.steps.length ? session.steps[index + 1] : undefined;
  const finished = session.finished.has(step.url);
  const toOverview = (request: 'back' | 'next') => {
    requestSession(request, step.url);
    void navigation?.openTarget?.({ kind: 'queue', section: 'overview' }).catch(() => {});
  };
  return (
    <nav className="session-bar" aria-label="Guided session" data-session-bar data-finished={finished || undefined}>
      <Button size="xs" variant="ghost" onClick={() => toOverview('back')} title="Back to this PR's step in the session">
        <ArrowLeft size={13} aria-hidden="true" />
        Session
      </Button>
      <span className="session-bar-position">{index + 1} of {session.steps.length}</span>
      {finished && (
        <span className="session-bar-done" role="status">
          <CircleCheck size={14} aria-hidden="true" />
          Done here
        </span>
      )}
      <span className="session-bar-next">
        {following ? (
          <>
            <span className="session-bar-next-label">Next</span>
            <span className="session-bar-next-title">#{following.number} {following.title}</span>
          </>
        ) : (
          <span className="session-bar-next-label">Last PR in the session</span>
        )}
      </span>
      <Button size="xs" variant={finished ? 'default' : 'outline'} onClick={() => toOverview('next')} title={following ? `Go on to #${following.number}` : 'See what the session moved'}>
        {following ? 'Next PR' : 'Finish'}
        <ArrowRight size={13} aria-hidden="true" />
      </Button>
    </nav>
  );
}
