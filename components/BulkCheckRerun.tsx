import { useRef, useState } from 'react';
import type { ReviewMember } from '../lib/workbench';
import type { PrChecks } from '../lib/pr-checks';
import { checkRerunPlan, type WorkflowRerun } from '../lib/check-rerun-plan';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

export function BulkCheckRerun({
  members,
  values,
  onChanged,
}: {
  members: ReviewMember[];
  values: Partial<Record<string, PrChecks>>;
  onChanged: () => void;
}) {
  const [plan, setPlan] = useState<WorkflowRerun[]>();
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const eligible = checkRerunPlan(members, values).filter((run) => accepted[run.key] !== run.revision);
  const remaining = plan?.filter((run) => accepted[run.key] !== run.revision) ?? [];
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setErrors({});
    let changed = false;
    try {
      // Sequential writes respect the shared interactive API scheduler and never retry automatically.
      for (const run of remaining) {
        try {
          await window.electronAPI.rerunChecks({ ...run.target, mode: run.mode });
          changed = true;
          setAccepted((current) => ({ ...current, [run.key]: run.revision }));
        } catch (error) {
          setErrors((current) => ({ ...current, [run.key]: error instanceof Error ? error.message : String(error) }));
          // Stop on errors (including rate limits); preserve accepted requests for a safe manual retry.
          break;
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
      if (changed && window.electronAPI.githubSyncVersion !== 1) onChanged();
    }
  }
  if (!eligible.length && !plan) return null;
  const missing = members.some(
    (member) => values[member.url]?.headSha !== member.headSha || values[member.url]?.warning
  );
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!eligible.length}
        onClick={() => {
          setPlan(eligible);
          setErrors({});
        }}
      >
        Re-run failed &amp; cancelled…
      </Button>
      <Dialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open && !pending.current) setPlan(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run failed and cancelled checks</DialogTitle>
            <DialogDescription>
              {plan?.length} workflow runs. Failed workflows rerun failed jobs and their dependents. Workflows with
              cancelled jobs rerun all jobs, including those that passed. Running workflows and external checks are
              excluded.
            </DialogDescription>
          </DialogHeader>
          {missing && <p>Some check results are missing or incomplete. Only loaded results are included.</p>}
          <ul className="bulk-check-rerun-list">
            {plan?.map((run) => (
              <li key={run.key}>
                <strong>PR #{run.number}</strong> · {run.names.join(', ')}
                <p>
                  {accepted[run.key] === run.revision
                    ? 'Rerun requested'
                    : run.mode === 'all'
                      ? 'All jobs in this workflow'
                      : 'Failed jobs and dependents'}
                </p>
                {errors[run.key] && <p role="alert">{errors[run.key]}</p>}
              </li>
            ))}
          </ul>
          <p role="status">
            {busy
              ? `Requesting reruns… ${(plan?.length ?? 0) - remaining.length}/${plan?.length}`
              : !remaining.length
                ? 'All reruns requested. Results will update automatically.'
                : ''}
          </p>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setPlan(undefined)}>
              {remaining.length ? 'Close' : 'Done'}
            </Button>
            {!!remaining.length && (
              <Button disabled={busy} onClick={() => void submit()}>
                {busy ? 'Requesting…' : Object.keys(errors).length ? 'Retry remaining workflows' : 'Re-run workflows'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
