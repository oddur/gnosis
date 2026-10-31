import { useEffect, useState } from 'react';
import type { Briefing } from '../lib/workbench';
import type { PrGenerationActions } from './PrEntryActions';
import { Markdown } from './Markdown';
import { Button } from './ui/button';

/** A missing briefing is a visible state, never an implicit generation request. */
export function StackBriefing({ briefing, actions, onActivity, onSetup, connected }: {
  briefing?: Briefing;
  actions?: PrGenerationActions;
  onActivity: () => void;
  onSetup?: () => void;
  connected: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); }, [briefing?.key, briefing?.status]);
  if (briefing?.status === 'ready') return <details className="pr-briefing stack-briefing-ready" open>
    <summary>Stack briefing</summary><Markdown>{briefing.summary ?? ''}</Markdown>
  </details>;
  const status = briefing?.status;
  const running = status === 'generating' || pending;
  const message = !connected ? 'Connect GitHub to generate a stack briefing.'
    : running ? 'Generating stack briefing…'
    : status === 'failed' ? 'Stack briefing failed.'
    : status === 'cancelled' ? 'Stack briefing cancelled.'
    : status === 'paused' ? briefing?.pauseReason === 'filter' ? 'Automatic briefing paused by your filters.' : briefing?.pauseDetail ?? 'Automatic briefing paused.'
    : status === 'queued' ? 'Stack briefing queued.' : 'No stack briefing yet.';
  return <div className="stack-briefing-state">
    <span role="status">{message}</span>
    {running || status === 'queued' ? <Button size="sm" variant="ghost" onClick={onActivity}>View activity</Button>
      : !connected ? <Button size="sm" variant="ghost" onClick={onSetup}>Connect GitHub</Button>
      : actions && !actions.briefingDisabled ? <Button size="sm" variant="ghost" onClick={() => {
        setPending(true); setError('');
        void Promise.resolve().then(actions.onGenerateBriefing).catch(() => setError('Could not start the briefing. Try again.')).finally(() => setPending(false));
      }}>{status === 'failed' || status === 'cancelled' ? 'Retry briefing' : 'Generate stack briefing'}</Button>
      : <span>Available for active PRs in your review queue.</span>}
    {status === 'paused' && <Button size="sm" variant="ghost" onClick={onActivity}>View activity</Button>}
    {error && <p role="alert">{error}</p>}
    {status === 'failed' && briefing?.error && <details><summary>Error details</summary><p>{briefing.error}</p></details>}
  </div>;
}
