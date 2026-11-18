/**
 * The Overview's two GitHub writes (#390), each behind a confirmation like Merge: Nudge re-requests a reviewer's
 * review on your PRs, and Close PR closes one without merging, with an optional comment. Main refreshes after each
 * write (`lib/github-write-refresh.ts`); the page hides a closing PR at once and brings it back if GitHub refuses.
 */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { closeBlockedReason, type PrActionState } from '../lib/pr-actions';
import { closeConfirmation, closeRequest, nudgeConfirmation, nudgeRequests, type PersonGroup } from '../lib/morning';
import { writeErrorDetail } from '../lib/write-failures';
import type { ReviewMember } from '../lib/workbench';

export function NudgeDialog({ group, onClose, onDone }: {
  group: PersonGroup | null;
  onClose: () => void;
  /** After GitHub answered: the PRs it accepted, and the first refusal. */
  onDone: (result: { sent: string[]; error?: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const words = group ? nudgeConfirmation(group) : undefined;
  const submit = async () => {
    if (!group) return;
    setBusy(true);
    const sent: string[] = [];
    let error: string | undefined;
    // One at a time, so a refusal stops the rest and nothing is sent twice.
    for (const request of nudgeRequests(group)) {
      try {
        await window.electronAPI.feedbackAction(request);
        sent.push(request.prUrl);
      } catch (cause) {
        error = writeErrorDetail(cause);
        break;
      }
    }
    setBusy(false);
    onDone({ sent, error });
  };
  return (
    <Dialog open={!!group} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showCloseButton={!busy} className="pr-action-dialog" data-overview-dialog="nudge"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{words?.title}</DialogTitle>
          <DialogDescription>{words?.body}</DialogDescription>
        </DialogHeader>
        {group?.nudge && (
          <ul className="pr-action-members">
            {group.nudge.members.map((member) => (
              <li key={member.url}>
                <span>{member.repo} #{member.number}</span>
                <span className="pr-action-note">{member.title}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()} data-overview-confirm>
            {busy ? (<><Loader2 size={14} className="motion-safe:animate-spin" />Sending…</>) : words?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ClosePrDialog({ member, onClose, onConfirm }: {
  member: ReviewMember | null;
  onClose: () => void;
  /** The confirmed request. The page closes the dialog, hides the PR and sends it. */
  onConfirm: (request: ReturnType<typeof closeRequest>, member: ReviewMember) => void;
}) {
  const [state, setState] = useState<PrActionState>();
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const commentId = useId();
  useEffect(() => {
    setState(undefined);
    setError('');
    setComment('');
    if (!member) return;
    let cancelled = false;
    // Permissions and the current revision, read fresh, as Merge does.
    window.electronAPI.getPrActionState(member.url, true).then(
      (value) => { if (!cancelled) setState(value); },
      (cause: unknown) => { if (!cancelled) setError(writeErrorDetail(cause)); }
    );
    return () => { cancelled = true; };
  }, [member]);
  const words = member ? closeConfirmation(member) : undefined;
  const blocked = state ? closeBlockedReason(state) : undefined;
  return (
    <Dialog open={!!member} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="pr-action-dialog" data-overview-dialog="close">
        <DialogHeader>
          <DialogTitle>{words?.title}</DialogTitle>
          <DialogDescription>{words?.body}</DialogDescription>
        </DialogHeader>
        <label className="overview-close-comment" htmlFor={commentId}>
          <span>Comment (optional)</span>
          <textarea id={commentId} rows={3} value={comment} maxLength={65000} placeholder="Why it is closing, for the people on the PR"
            onChange={(event) => setComment(event.target.value)} />
        </label>
        {!state && !error && (
          <p className="pr-action-note" role="status"><Loader2 size={16} className="motion-safe:animate-spin" />Checking GitHub…</p>
        )}
        {(blocked || error) && <p className="pr-action-error" role="alert">{blocked ?? error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!state || !!blocked} data-overview-confirm
            onClick={() => { if (state && member) onConfirm(closeRequest(state, comment), member); }}>
            {words?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
