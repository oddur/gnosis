import { useRef, useState } from 'react';
import type { PrCheck, CheckDetails } from '../lib/pr-checks';
import type { ReviewMember } from '../lib/workbench';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

/** Resolve permissions on demand. The existing backend pins reruns to this head. */
export function StackCheckRerun({
  member,
  check,
  onChanged,
}: {
  member: ReviewMember;
  check: PrCheck;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CheckDetails>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const pending = useRef(false);
  const cancelled = check.conclusion === 'cancelled';
  const target = { url: member.url, headSha: member.headSha, id: check.id };
  async function prepare() {
    if (pending.current) return;
    pending.current = true;
    setOpen(true);
    setBusy(true);
    setError('');
    setDetail(undefined);
    try {
      setDetail(await window.electronAPI.getCheckDetails(target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (pending.current || !detail?.job?.canRerun || detail.job.status !== 'completed') return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await window.electronAPI.rerunChecks({ ...target, mode: cancelled ? 'all' : 'failed' });
      setRequested(true);
      setOpen(false);
      if (window.electronAPI.githubSyncVersion !== 1) onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (check.kind !== 'check') return null;
  if (
    !['github-actions', 'GitHub Actions'].includes(check.provider) &&
    !/github\.com\/[^/]+\/[^/]+\/actions\/runs\//.test(check.url ?? '')
  )
    return null;
  return (
    <>
      <button disabled={requested} onClick={() => void prepare()}>
        {requested ? 'Rerun requested' : cancelled ? 'Re-run cancelled workflow…' : 'Re-run failed jobs…'}
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{cancelled ? 'Re-run cancelled workflow' : 'Re-run failed jobs'}</DialogTitle>
            <DialogDescription>
              PR #{member.number} · {check.name}.{' '}
              {cancelled
                ? 'Re-run all jobs in this workflow, including jobs that passed.'
                : 'Re-run failed jobs and their dependent jobs in this workflow.'}{' '}
              Other workflows are unchanged.
            </DialogDescription>
          </DialogHeader>
          {busy && !detail && <p role="status">Checking workflow and permissions…</p>}
          {detail &&
            (!detail.job ? (
              <p>Open this check on GitHub to rerun it.</p>
            ) : !detail.job.canRerun ? (
              <p>Repository write access is required.</p>
            ) : detail.job.status !== 'completed' ? (
              <p>This workflow is already queued or running.</p>
            ) : (
              <p>
                Workflow run {detail.job.runId} · attempt {detail.job.attempt}
              </p>
            ))}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {error && !detail ? (
              <Button disabled={busy} onClick={() => void prepare()}>
                Retry
              </Button>
            ) : (
              <Button
                disabled={busy || !detail?.job?.canRerun || detail.job.status !== 'completed'}
                onClick={() => void submit()}
              >
                {busy ? 'Requesting…' : cancelled ? 'Re-run workflow' : 'Re-run failed jobs'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
