import { useRef } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck } from 'lucide-react';
import { Button } from './ui/button';
import { requestSession, useSessionState } from '../lib/session-store';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';

/**
 * The guided session's bar on a PR the session opened (#596): where the PR is in the run, the way back to its step,
 * and the next PR. Once the PR is finished here (a review submitted, or every change viewed), Next is the bar's one
 * primary action, so moving on is one press. Shown only while a session runs and lists this PR.
 *
 * Keys: [ goes back to the PR's step, ] on to the next PR. The PR page's own keys leave them free: J and K move
 * between PRs, the tabs have letters, and history is ⌘[ and ⌘] (Alt+← and Alt+→ off the Mac), all with a modifier
 * or a letter. Only the bar of the tab in front answers, and never while typing or in a dialog.
 */
export function SessionBar({ urls }: { urls: readonly string[] }) {
  const session = useSessionState();
  const navigation = useWorkspaceNavigation();
  const bar = useRef<HTMLElement>(null);
  const index = session ? session.steps.findIndex((step) => urls.includes(step.url)) : -1;
  const shown = !!session && index >= 0;
  useKeyboardShortcuts(
    {
      '[': () => (session && index >= 0 ? toOverview('back', session.steps[index].url) : false),
      ']': () => (session && index >= 0 ? toOverview('next', session.steps[index].url) : false),
      // Layouts that type [ and ] with Option (Icelandic, German, Nordic on the Mac).
      'alt+[': () => (session && index >= 0 ? toOverview('back', session.steps[index].url) : false),
      'alt+]': () => (session && index >= 0 ? toOverview('next', session.steps[index].url) : false),
    },
    { enabled: shown, scope: bar }
  );
  function toOverview(request: 'back' | 'next', url: string) {
    requestSession(request, url);
    void navigation?.openTarget?.({ kind: 'queue', section: 'overview' }).catch(() => {});
  }
  if (!session || index < 0) return null;
  const step = session.steps[index];
  const following = index + 1 < session.steps.length ? session.steps[index + 1] : undefined;
  const finished = session.finished.has(step.url);
  return (
    <nav ref={bar} className="session-bar" aria-label="Guided session" data-session-bar data-finished={finished || undefined}>
      <Button size="xs" variant="ghost" onClick={() => toOverview('back', step.url)} title="Back to this PR's step in the session · [" aria-keyshortcuts="[">
        <ArrowLeft size={13} aria-hidden="true" />
        Session
        <kbd>[</kbd>
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
      <Button size="xs" variant={finished ? 'default' : 'outline'} onClick={() => toOverview('next', step.url)} title={following ? `Go on to #${following.number} · ]` : 'See what the session moved · ]'} aria-keyshortcuts="]">
        {following ? 'Next PR' : 'Finish'}
        <ArrowRight size={13} aria-hidden="true" />
        <kbd>]</kbd>
      </Button>
    </nav>
  );
}
