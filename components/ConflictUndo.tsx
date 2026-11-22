import { useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { ConflictSession } from '../lib/conflict-resolution';
import { describeUndoError, undoAllowed, UNDO_DOCS_URL, type PushedUpdate, type UndoErrorCopy } from '../lib/conflict-undo';
import { revertCommands } from '../lib/conflict-flow';
import { pushButtonKey } from '../lib/push-button-keys';
import { repositoryKey } from '../lib/repository-settings';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { CopyCommands } from './CopyCommands';
import { BranchBadge, CommitBadge } from './EntityBadge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { toast } from './ui/toast';

/**
 * Undo this update (#445 item 25), after a conflict resolution was pushed: in the PR header and the conflict view's
 * published state. Only where the repository allows the force push; elsewhere a link to the manual steps.
 */
export function ConflictUndo({
  update,
  onUndone,
  announce = true,
}: {
  update: PushedUpdate;
  onUndone?: (session: ConflictSession) => void;
  /**
   * A toast for the outcome. The Conflicts view says it on screen instead: a toast there would outlive the state it
   * reports and contradict the screen.
   */
  announce?: boolean;
}) {
  const { settings } = useRepositorySettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UndoErrorCopy>();
  const cancel = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const mac = window.electronAPI.platform === 'darwin';
  if (!undoAllowed(settings[repositoryKey(update.baseRepo)]))
    return (
      <a href={UNDO_DOCS_URL} target="_blank" rel="noreferrer" data-conflict-undo-docs="">
        How to undo this update
      </a>
    );
  const branch = update.headBranch;
  async function undo() {
    // A refused or failed undo is never sent again from the same dialog: reopen it to try once more.
    if (pending.current || error) return;
    pending.current = true;
    setBusy(true);
    try {
      const reply = await window.electronAPI.conflictResolution({
        kind: 'undo-publish',
        id: update.id,
        version: update.version,
      });
      setOpen(false);
      if (announce)
        toast.add({
          type: 'success',
          title: `${branch} is back at ${update.headSha.slice(0, 7)}`,
          description: 'The merge commit is off the branch. Your resolutions are saved: fix them and push again.',
        });
      onUndone?.(reply.session);
    } catch (e) {
      setError(describeUndoError(e instanceof Error ? e.message : String(e), branch, revertCommands(update)));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="conflict-undo-action"
        data-conflict-undo=""
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      >
        Undo this update
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent
          className="conflict-undo-dialog"
          showCloseButton={!busy}
          data-conflict-undo-dialog=""
          // Cancel takes focus: no key on its own reaches the force push.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Undo the update to {branch}?</DialogTitle>
            <DialogDescription>This force-pushes {branch} and rewrites its history.</DialogDescription>
          </DialogHeader>
          <ul className="conflict-confirm-facts">
            <li>
              Moves <BranchBadge branch={branch} repo={update.headRepo} /> back to{' '}
              <CommitBadge sha={update.headSha} repo={update.headRepo} />, its commit before you merged{' '}
              {update.baseBranch}.
            </li>
            <li>
              Only if the branch is still at the merge commit <code>{update.commitSha.slice(0, 7)}</code>. If anyone
              pushed since, nothing changes.
            </li>
            <li>Anyone who pulled the merge commit needs to reset their copy. Checks run again.</li>
            <li>Your resolutions stay saved, so you can fix them and push again.</li>
          </ul>
          {error && (
            <div className="conflict-error" role="alert" data-conflict-undo-error="">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <p className="conflict-error-title">{error.title}</p>
                {error.body && <p>{error.body}</p>}
                {error.commands && <CopyCommands commands={error.commands} />}
                {error.details && (
                  <details className="conflict-error-details">
                    <summary>Details</summary>
                    <pre>{error.details}</pre>
                  </details>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button ref={cancel} size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {error ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              data-conflict-undo-push=""
              disabled={busy || !!error}
              onClick={() => void undo()}
              onKeyDown={(event) => pushButtonKey(event, mac, () => void undo())}
              onKeyUp={(event) => pushButtonKey(event, mac, () => void undo())}
              aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
            >
              {busy ? 'Undoing…' : `Force-push ${branch}`}
              {!busy && (
                <kbd className="kbd" aria-hidden="true">
                  {mac ? '⌘↵' : 'Ctrl ↵'}
                </kbd>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
