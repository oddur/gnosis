import { useEffect, useRef, useState } from 'react';
import type { ReviewMember } from '../lib/workbench';
import { markPrsReady } from '../lib/mark-prs-ready';
import { Button } from './ui/button';
import { toast } from './ui/toast';

export function StackMarkReady({
  members,
  account,
  onChanged,
}: {
  members: ReviewMember[];
  account: string | null;
  onChanged: () => void;
}) {
  const active = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const remaining = members.filter((member) => !done.includes(member.url));
  async function submit() {
    if (pending.current || !account || !remaining.length) return;
    pending.current = true;
    setBusy(true);
    setError('');
    let count = 0;
    setProgress(`Marking ready… 0/${remaining.length}`);
    try {
      const result = await markPrsReady(remaining, account, {
        read: (url, force) => window.electronAPI.getPrActionState(url, force),
        act: (request) => window.electronAPI.performPrAction(request),
        active: () => active.current,
        ready: (url) => {
          count++;
          if (active.current) {
            setDone((previous) => [...previous, url]);
            setProgress(`Marking ready… ${count}/${remaining.length}`);
          }
        },
      });
      if (active.current) {
        setProgress(
          result.completed.length
            ? `${result.completed.length} PR${result.completed.length === 1 ? '' : 's'} ready for review.`
            : ''
        );
        if (result.failure)
          setError(`#${result.failure.member.number}: ${result.failure.message} Remaining PRs were not changed.`);
        else if (result.completed.length)
          toast.add({
            title: 'PRs ready for review',
            description: 'Required checks and approvals still apply.',
            type: 'success',
          });
      }
      if (result.completed.length) {
        onChanged();
        window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed', { detail: result.completed }));
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <span className="stack-mark-ready">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !account || !remaining.length}
        onClick={() => void submit()}
        title={`Mark ${remaining.length} draft PR${remaining.length === 1 ? '' : 's'} ready for review. Does not approve or merge them.`}
      >
        {busy ? 'Marking ready…' : error ? 'Retry remaining' : 'Mark all ready'}
      </Button>
      {progress && <span role="status">{progress}</span>}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
