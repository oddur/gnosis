import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { GitHubAuthor } from './GitHubAuthor';
import { useSessionDraft } from '../lib/session-drafts';
import { useId, useState, useRef, useEffect } from 'react';
import { MessageSquare, Check, ChevronRight } from 'lucide-react';
import { CommentMarkdown } from './CommentMarkdown';
import { timeAgo } from '../lib/utils';
import type { GitHubReviewThread as Thread, ReviewThreadAction, ReviewCommentAction } from '../lib/review-threads';

interface Props {
  thread: Thread;
  expanded?: boolean;
  reason?: string;
  onResolvedNext?: () => void;
  actionContainer?: HTMLElement | null;
  onOpenFeedback?: () => void;
  onCommentAction?: (commentId: string, action: ReviewCommentAction['action'], body?: string) => Promise<void>;
  onAction?: (action: ReviewThreadAction['action'], body?: string) => Promise<void>;
}

export function GitHubReviewThread({
  thread,
  reason,
  onAction,
  onCommentAction,
  expanded,
  onResolvedNext,
  actionContainer,
  onOpenFeedback,
}: Props) {
  const [replying, setReplying] = useSessionDraft(`thread-replying:${thread.id}`, false);
  const [draft, setDraft] = useSessionDraft(`thread-reply:${thread.id}`, '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedAction, setFailedAction] = useState<string>();
  const errorElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      errorElement.current?.scrollIntoView({ block: 'nearest' });
      errorElement.current?.focus({ preventScroll: true });
    }
  }, [error]);
  const replyForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!replying || !actionContainer) return;
    const frame = requestAnimationFrame(() => replyForm.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [replying, actionContainer]);
  const inputId = useId();
  const pending = useRef(false);
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [editBody, setEditBody] = useSessionDraft(`thread-edit:${thread.id}`, '');
  async function changeComment(id: string, action: ReviewCommentAction['action']) {
    if (!onCommentAction || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await onCommentAction(id, action, action === 'edit' ? editBody : undefined);
      setEditing(undefined);
      setDeleting(undefined);
      setEditBody('');
    } catch (e) {
      setFailedAction(action);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function act(action: ReviewThreadAction['action'], advance = false) {
    if (!onAction || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await onAction(action, action === 'reply' ? draft : undefined);
      if (advance) onResolvedNext?.();
      if (action === 'reply') {
        setDraft('');
        setReplying(false);
      }
    } catch (e) {
      setFailedAction(action);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const actionButton = (label: string, onClick: () => void, primary = false) =>
    actionContainer ? (
      <Button size="sm" variant={primary ? 'default' : 'outline'} disabled={busy} onClick={onClick}>
        {label}
      </Button>
    ) : (
      <button disabled={busy} onClick={onClick}>
        {label}
      </button>
    );
  const actions = (
    <div className="github-thread-actions" aria-label="Thread actions">
      {onOpenFeedback && actionButton('Address feedback', onOpenFeedback)}
      {!replying && actionButton('Reply', () => setReplying(true))}
      {replying && actionContainer && (
        <>
          <Button size="sm" type="submit" form={`${inputId}-form`} disabled={busy || !draft.trim()}>
            Reply on GitHub
          </Button>
          {actionButton('Cancel', () => setReplying(false))}
        </>
      )}
      {((thread.isResolved && thread.viewerCanUnresolve) || (!thread.isResolved && thread.viewerCanResolve)) &&
        actionButton(
          thread.isResolved ? 'Reopen thread' : 'Resolve thread',
          () => void act(thread.isResolved ? 'unresolve' : 'resolve')
        )}
      {onResolvedNext &&
        !thread.isResolved &&
        thread.viewerCanResolve &&
        actionButton('Resolve & next', () => void act('resolve', true), true)}
      {busy && <span role="status">Saving to GitHub…</span>}
    </div>
  );
  const first = thread.comments.length ? thread.comments[0] : undefined;
  return (
    <details
      className="github-thread"
      data-thread-id={thread.id}
      data-resolved={thread.isResolved}
      open={expanded ?? !thread.isResolved}
    >
      <summary>
        <ChevronRight className="github-thread-chevron" size={12} aria-hidden="true" />
        <MessageSquare size={14} aria-hidden="true" />
        <span>
          {first?.author?.login ?? 'GitHub'} · {thread.comments.length}{' '}
          {thread.comments.length === 1 ? 'comment' : 'comments'}
        </span>
        <span className="github-thread-state">
          {thread.isResolved ? (
            <span className="github-thread-resolution">
              <Check size={13} aria-hidden="true" />
              Resolved
            </span>
          ) : (
            'Unresolved'
          )}
          {thread.isOutdated ? ' · Earlier revision' : ''}
        </span>
      </summary>
      {reason && <p className="github-thread-reason">{reason}</p>}
      <div className="github-thread-comments">
        {thread.comments.map((comment) => (
          <article key={comment.id}>
            <header>
              <strong>{comment.author ? <GitHubAuthor login={comment.author.login} /> : 'Deleted account'}</strong>
              <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                {timeAgo(comment.createdAt)}
              </time>
              <button onClick={() => void window.electronAPI.openExternal(comment.url)}>On GitHub</button>
            </header>
            {editing === comment.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void changeComment(comment.id, 'edit');
                }}
              >
                <label htmlFor={`${inputId}-edit`}>Edit your comment</label>
                <MarkdownCommentEditor
                  id={`${inputId}-edit`}
                  value={editBody}
                  onValueChange={setEditBody}
                  disabled={busy}
                  maxLength={65536}
                  rows={3}
                  autoFocus
                />
                <div className="github-thread-actions">
                  <button disabled={busy || !editBody.trim()}>Save changes</button>
                  <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <CommentMarkdown>{comment.body}</CommentMarkdown>
            )}
            {onCommentAction && !editing && (
              <div className="github-thread-actions">
                {comment.viewerCanUpdate && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(comment.id);
                      setEditBody(comment.body);
                      setDeleting(undefined);
                    }}
                  >
                    Edit
                  </button>
                )}
                {comment.viewerCanDelete &&
                  (deleting === comment.id ? (
                    <>
                      <span>Delete this comment from GitHub?</span>
                      <button disabled={busy} onClick={() => void changeComment(comment.id, 'delete')}>
                        Delete comment
                      </button>
                      <button disabled={busy} onClick={() => setDeleting(undefined)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button disabled={busy} onClick={() => setDeleting(comment.id)}>
                      Delete
                    </button>
                  ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {onAction && (actionContainer ? createPortal(actions, actionContainer) : actions)}
      {onAction && replying && (
        <form
          id={`${inputId}-form`}
          ref={replyForm}
          onSubmit={(e) => {
            e.preventDefault();
            void act('reply');
          }}
        >
          <label htmlFor={inputId}>Reply to this GitHub thread</label>
          <MarkdownCommentEditor
            id={inputId}
            value={draft}
            onValueChange={setDraft}
            rows={3}
            maxLength={65536}
            disabled={busy}
            autoFocus
          />
          {!actionContainer && (
            <div className="github-thread-actions">
              <button type="submit" disabled={busy || !draft.trim()}>
                Reply on GitHub
              </button>
              <button type="button" disabled={busy} onClick={() => setReplying(false)}>
                Cancel
              </button>
            </div>
          )}
        </form>
      )}
      {error && (
        <div ref={errorElement} role="alert" tabIndex={-1} className="github-thread-error">
          <p>
            {failedAction === 'reply'
              ? 'Reply wasn’t posted. Your draft is saved. Try again.'
              : failedAction === 'resolve'
                ? 'Thread wasn’t resolved. Try again.'
                : failedAction === 'unresolve'
                  ? 'Thread wasn’t reopened. Try again.'
                  : failedAction === 'edit'
                    ? 'Changes weren’t saved. Your draft is saved. Try again.'
                    : failedAction === 'delete'
                      ? 'Comment wasn’t deleted. Try again.'
                      : 'Could not save the change. Try again.'}
          </p>
          <details>
            <summary>Details</summary>
            <p>{error}</p>
          </details>
        </div>
      )}
    </details>
  );
}
