import { CommentMarkdown } from './CommentMarkdown';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { CommitBadge } from './EntityBadge';
import { useSessionDraft } from '../lib/session-drafts';
import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { ChangesDraftComment } from './ChangesDraftComment';
import { AlertTriangle, Check, ExternalLink, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PendingReviewComment, ReviewEvent } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: PendingReviewComment[];
  prUrl: string;
  headSha?: string;
  isOwnPr: boolean;
  onEditComment?: (id: string, body: string) => void | Promise<void>;
  onRemoveComment?: (id: string) => void | Promise<void>;
  onSubmit: (event: ReviewEvent, body: string) => Promise<{ reviewUrl: string; droppedCommentCount: number }>;
}

export function SubmitReviewDialog({
  open,
  onOpenChange,
  comments,
  prUrl,
  headSha,
  isOwnPr,
  onSubmit,
  onEditComment,
  onRemoveComment,
}: Props) {
  const target = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  const destination = target ? `${target[1]}/${target[2]} #${target[3]}` : prUrl;
  const [body, setBody] = useSessionDraft(`submission:${prUrl}:${headSha ?? ''}`, '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [reviewSignature, setReviewSignature] = useState(true);
  const [signatureState, setSignatureState] = useState<'loading' | 'saving' | 'ready' | 'error'>('loading');
  const [signatureError, setSignatureError] = useState('');
  const signatureIntent = useRef<boolean | undefined>(undefined);
  const signatureEpoch = useRef(0);
  const signaturePending = useRef(false);
  const pending = useRef(false);
  const decisionId = useId();
  const [decision, setDecision] = useState<ReviewEvent>('COMMENT');
  const [busyDraftIds, setBusyDraftIds] = useState<Set<string>>(() => new Set());
  const onDraftBusyChange = useCallback((id: string, busy: boolean) => {
    setBusyDraftIds((previous) => {
      if (previous.has(id) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const draftsBusy = comments.some((comment) => busyDraftIds.has(comment.id));
  const needsMessage = decision !== 'APPROVE' && !comments.length;
  const canSubmit =
    !submitting &&
    signatureState === 'ready' &&
    !draftsBusy &&
    !(isOwnPr && decision !== 'COMMENT') &&
    (!needsMessage || !!body.trim());
  const decisions: { value: ReviewEvent; label: string; description: string }[] = [
    { value: 'COMMENT', label: 'Comment', description: 'Give feedback without approval.' },
    { value: 'APPROVE', label: 'Approve', description: 'Approve these changes.' },
    { value: 'REQUEST_CHANGES', label: 'Request changes', description: 'Ask the author to revise these changes.' },
  ];

  async function syncSignature(desired?: boolean) {
    if (signaturePending.current) return;
    const epoch = ++signatureEpoch.current;
    signaturePending.current = true;
    signatureIntent.current = desired;
    if (desired !== undefined) setReviewSignature(desired);
    setSignatureState(desired === undefined ? 'loading' : 'saving');
    setSignatureError('');
    try {
      const prefs = await window.electronAPI.loadPreferences();
      if (signatureEpoch.current !== epoch) return;
      if (desired !== undefined) await window.electronAPI.savePreferences({ ...prefs, reviewSignature: desired });
      if (signatureEpoch.current !== epoch) return;
      setReviewSignature(desired ?? prefs.reviewSignature);
      setSignatureState('ready');
    } catch {
      if (signatureEpoch.current !== epoch) return;
      setSignatureState('error');
      setSignatureError(
        desired === undefined
          ? 'Could not load the signature setting. Retry before posting your review.'
          : 'Could not save the signature setting. Your review has not been posted. Retry saving before submitting.'
      );
    } finally {
      if (signatureEpoch.current === epoch) signaturePending.current = false;
    }
  }

  useEffect(() => {
    if (!open) return;
    void syncSignature();
    return () => {
      signatureEpoch.current++;
      signaturePending.current = false;
    };
  }, [open]);

  // Group comments by file for the summary
  const fileGroups = new Map<string, PendingReviewComment[]>();
  for (const c of comments) {
    const existing = fileGroups.get(c.filePath);
    if (existing) {
      existing.push(c);
    } else {
      fileGroups.set(c.filePath, [c]);
    }
  }

  async function handleSubmit(event: ReviewEvent) {
    if (pending.current || signaturePending.current || signatureState !== 'ready' || successUrl || draftsBusy) return;
    if (event !== 'COMMENT' && isOwnPr) return;
    if (event !== 'APPROVE' && !comments.length && !body.trim()) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      setSubmittedCount(comments.length);
      const result = await onSubmit(event, body);
      setSuccessUrl(result.reviewUrl);
      setDroppedCount(result.droppedCommentCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit the review.");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  function handleClose() {
    // Don't allow closing while a submit is in flight — the user
    // might think the review wasn't posted and retry, creating a
    // duplicate. The dialog stays open until the operation finishes.
    if (pending.current) return;
    if (successUrl) {
      setSuccessUrl(null);
      setBody('');
    }
    onOpenChange(false);
  }

  // Success state
  if (successUrl) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="editorial-heading flex items-center gap-2">
              <Check className="h-4 w-4 text-[var(--color-success)]" />
              Feedback submitted to GitHub
            </DialogTitle>
            <DialogDescription className="slide-meta">
              Your review of {destination} has been posted
              {submittedCount > 0 ? ` with ${submittedCount} comment${submittedCount !== 1 ? 's' : ''}` : ''}.
            </DialogDescription>
          </DialogHeader>
          {droppedCount > 0 && (
            <div className="staleBanner-warn flex items-start gap-2 rounded-md p-3 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {droppedCount} comment{droppedCount !== 1 ? 's were' : ' was'} on lines outside the diff range and{' '}
                {droppedCount !== 1 ? 'were' : 'was'} included in the review body instead.
              </span>
            </div>
          )}
          <div className="flex justify-center">
            <a
              href={successUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-[var(--ring)] hover:opacity-80 underline underline-offset-2"
            >
              View on GitHub <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <DialogFooter>
            <Button onClick={handleClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="review-submit-dialog" showCloseButton={!submitting}>
        <DialogHeader className="review-submit-header">
          <DialogTitle>{target ? `Review PR #${target[3]}` : 'Submit review'}</DialogTitle>
          <DialogDescription asChild>
            <div className="submission-destination">
              <a
                href={prUrl}
                onClick={(event) => {
                  event.preventDefault();
                  void window.electronAPI.openExternal(prUrl);
                }}
                aria-label={`Open ${destination} on GitHub`}
              >
                {target ? `${target[1]}/${target[2]}` : prUrl} <ExternalLink size={13} aria-hidden="true" />
              </a>
              {headSha && (
                <span title={`Reviewing revision ${headSha}`}>
                  Revision <CommitBadge sha={headSha} repo={target ? `${target[1]}/${target[2]}` : undefined} />
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="review-submit-body">
          {!headSha && (
            <p className="review-submit-notice" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              This saved review has no commit reference. Open the current changes before posting line comments.
            </p>
          )}
          <fieldset className="review-decision" disabled={submitting}>
            <legend>Review decision</legend>
            {decisions.map((option) => (
              <label key={option.value} className="review-decision-option" data-selected={decision === option.value}>
                <input
                  type="radio"
                  name={decisionId}
                  value={option.value}
                  checked={decision === option.value}
                  disabled={isOwnPr && option.value !== 'COMMENT'}
                  aria-describedby={`${decisionId}-${option.value}-description`}
                  onChange={() => {
                    setDecision(option.value);
                    setError(null);
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <span id={`${decisionId}-${option.value}-description`}>{option.description}</span>
                </span>
              </label>
            ))}
            {isOwnPr && (
              <p className="review-submit-hint">
                You can comment on your own PR, but cannot approve it or request changes.
              </p>
            )}
          </fieldset>

          <div className="review-submit-message">
            <label htmlFor="review-summary">
              Review message <span>{needsMessage ? 'Required' : 'Optional'}</span>
            </label>
            <MarkdownCommentEditor
              id="review-summary"
              value={body}
              disabled={submitting}
              rows={3}
              maxLength={65536}
              aria-required={needsMessage}
              aria-describedby={needsMessage || comments.length ? 'review-message-hint' : undefined}
              onValueChange={setBody}
              placeholder={
                decision === 'REQUEST_CHANGES'
                  ? 'Describe the changes you need…'
                  : decision === 'APPROVE'
                    ? 'Add an approval note…'
                    : 'Share your feedback…'
              }
            />
            {(needsMessage || comments.length > 0) && (
              <p id="review-message-hint" className="review-submit-hint">
                {needsMessage
                  ? 'Add a message or an inline comment before submitting.'
                  : 'Your inline comments will be included.'}
              </p>
            )}
          </div>

          {comments.length > 0 && (
            <section className="review-submit-comments" aria-label="Pending inline comments">
              <h3>
                {comments.length} {comments.length === 1 ? 'comment' : 'comments'}{' '}
                <span>
                  in {fileGroups.size} {fileGroups.size === 1 ? 'file' : 'files'}
                </span>
              </h3>
              {Array.from(fileGroups.entries()).map(([filePath, fileComments]) => (
                <details key={filePath} className="review-submit-file" open>
                  <summary>
                    <ChevronRight size={14} aria-hidden="true" />
                    <span>{filePath}</span>
                    <span className="review-submit-file-count">{fileComments.length}</span>
                  </summary>
                  {fileComments.map((comment) => (
                    <div key={comment.id} className="review-submit-comment">
                      <div className="review-submit-line">
                        {comment.side === 'LEFT' ? 'Old' : 'New'}{' '}
                        {comment.startLine ? `lines ${comment.startLine}–${comment.line}` : `line ${comment.line}`}
                      </div>
                      {comment.codeSnippet && (
                        <pre className="review-submit-snippet">
                          <code>{comment.codeSnippet}</code>
                        </pre>
                      )}
                      {onEditComment && onRemoveComment ? (
                        <ChangesDraftComment
                          comment={comment}
                          onEdit={onEditComment}
                          onRemove={onRemoveComment}
                          disabled={submitting}
                          onBusyChange={onDraftBusyChange}
                        />
                      ) : (
                        <CommentMarkdown>{comment.body}</CommentMarkdown>
                      )}
                    </div>
                  ))}
                </details>
              ))}
            </section>
          )}

          <label className="review-submit-signature">
            <input
              type="checkbox"
              checked={reviewSignature}
              disabled={submitting || signatureState === 'loading' || signatureState === 'saving'}
              onChange={(event) => {
                void syncSignature(event.target.checked);
              }}
            />
            <span>Add “Reviewed using gnosis.to” signature</span>
          </label>
          {signatureError && (
            <div className="review-submit-error" role="alert">
              <p>{signatureError}</p>
              <Button variant="link" size="sm" onClick={() => void syncSignature(signatureIntent.current)}>
                Retry signature setting
              </Button>
            </div>
          )}
          {error && (
            <p className="review-submit-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="review-submit-footer">
          <span className="review-submit-hint" role="status">
            {submitting ? 'Posting to GitHub…' : draftsBusy ? 'Finish editing or removing draft comments before submitting.' : ''}
          </span>
          <div>
            <Button variant="outline" size="sm" onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSubmit(decision)} disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Submit review'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
