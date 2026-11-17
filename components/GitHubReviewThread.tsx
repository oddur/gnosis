import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { GitHubAuthor } from './GitHubAuthor';
import { readSessionDraft, useSessionDraft, useSessionDraftId, writeSessionDraft } from '../lib/session-drafts';
import { useId, useState, useRef, useEffect } from 'react';
import { optimisticWrite, useWriteInFlight } from '../lib/write-failures';
import { WriteFailureNotice } from './WriteFailureNotice';
import { MessageSquare, Check, ChevronRight } from 'lucide-react';
import { CommentMarkdown } from './CommentMarkdown';
import { timeAgo } from '../lib/utils';
import {
  isPendingComment,
  minimizedLabel,
  type GitHubReviewComment,
  type GitHubReviewThread as Thread,
  type ReviewThreadAction,
  type ReviewCommentAction,
} from '../lib/review-threads';

/** A comment hidden on GitHub stays collapsed behind its reason, as on GitHub. */
export function HiddenComment({ comment }: { comment: Pick<GitHubReviewComment, 'body' | 'minimizedReason'> }) {
  return (
    <details className="github-comment-hidden">
      <summary>{minimizedLabel(comment)}</summary>
      <CommentMarkdown>{comment.body}</CommentMarkdown>
    </details>
  );
}

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
  const draftId = useSessionDraftId(`thread-reply:${thread.id}`);
  const replyingId = useSessionDraftId(`thread-replying:${thread.id}`);
  // One reply per thread at a time: a second one waits until GitHub answers the first.
  const replySending = useWriteInFlight(`thread-reply:${thread.id}`);
  // Writes show at once: main applies them to the thread before GitHub answers, and rolls them back on failure.
  // Nothing here waits, so the controls stay available; a failure brings the typed text back with Retry.
  const replyForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!replying || !actionContainer) return;
    const frame = requestAnimationFrame(() => replyForm.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [replying, actionContainer]);
  const inputId = useId();
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [editBody, setEditBody] = useSessionDraft(`thread-edit:${thread.id}`, '');
  function changeComment(id: string, action: ReviewCommentAction['action']) {
    if (!onCommentAction) return;
    const body = action === 'edit' ? editBody : undefined;
    if (action === 'edit' && !body?.trim()) return;
    void optimisticWrite({
      key: `comment-change:${id}`,
      action: action === 'edit' ? 'comment-edit' : 'comment-delete',
      body,
      clear: () => {
        setEditing(undefined);
        setDeleting(undefined);
        if (action === 'edit') setEditBody('');
      },
      restore: (text) => {
        setEditing(id);
        setEditBody(text);
      },
      write: () => onCommentAction(id, action, body),
    });
  }
  function act(action: ReviewThreadAction['action'], advance = false) {
    if (!onAction) return;
    if (action === 'reply') {
      const body = draft;
      if (!body.trim()) return;
      void optimisticWrite({
        key: `thread-reply:${thread.id}`,
        action: 'thread-reply',
        body,
        clear: () => {
          setDraft('');
          setReplying(false);
        },
        // Written by id: the thread may have remounted since, for example after the file was collapsed and
        // expanded. Text typed since stays; the failed reply is kept in the notice and sent again by Retry.
        restore: (text) => {
          const current = readSessionDraft(draftId);
          if (typeof current !== 'string' || !current.trim()) writeSessionDraft(draftId, text);
          writeSessionDraft(replyingId, true);
        },
        write: () => onAction('reply', body),
      });
      return;
    }
    // The thread shows its new state at once. "Resolve & next" moves on once GitHub accepted it, so a failure stays
    // beside the thread it belongs to.
    void optimisticWrite({
      key: `thread-state:${thread.id}`,
      action: action === 'resolve' ? 'thread-resolve' : 'thread-unresolve',
      write: async () => {
        await onAction(action);
        if (advance) onResolvedNext?.();
      },
    });
  }
  const actionButton = (label: string, onClick: () => void, primary = false) =>
    actionContainer ? (
      <Button size="sm" variant={primary ? 'default' : 'outline'} onClick={onClick}>
        {label}
      </Button>
    ) : (
      <button onClick={onClick}>
        {label}
      </button>
    );
  const actions = (
    <div className="github-thread-actions" aria-label="Thread actions">
      {onOpenFeedback && actionButton('Address feedback', onOpenFeedback)}
      {!replying && actionButton('Reply', () => setReplying(true))}
      {replying && actionContainer && (
        <>
          <Button size="sm" type="submit" form={`${inputId}-form`} disabled={!draft.trim() || replySending}
            title={replySending ? 'Your previous reply is still sending.' : undefined}>
            Reply on GitHub
          </Button>
          {actionButton('Cancel', () => setReplying(false))}
        </>
      )}
      {((thread.isResolved && thread.viewerCanUnresolve) || (!thread.isResolved && thread.viewerCanResolve)) &&
        actionButton(
          thread.isResolved ? 'Reopen thread' : 'Resolve thread',
          () => act(thread.isResolved ? 'unresolve' : 'resolve')
        )}
      {onResolvedNext &&
        !thread.isResolved &&
        thread.viewerCanResolve &&
        actionButton('Resolve & next', () => act('resolve', true), true)}
    </div>
  );
  const first = thread.comments.length ? thread.comments[0] : undefined;
  const pendingCount = thread.comments.filter(isPendingComment).length;
  const published = thread.comments.length - pendingCount;
  return (
    <details
      className="github-thread"
      data-thread-id={thread.id}
      data-resolved={thread.isResolved}
      data-sending={thread.sending}
      open={expanded ?? !thread.isResolved}
    >
      <summary>
        <ChevronRight className="github-thread-chevron" size={12} aria-hidden="true" />
        <MessageSquare size={14} aria-hidden="true" />
        <span>
          {first?.author?.login ?? 'GitHub'} · {published}{' '}
          {published === 1 ? 'comment' : 'comments'}
          {pendingCount > 0 && ` · ${pendingCount} pending`}
        </span>
        <span className="github-thread-state">
          {thread.sending === 'resolving' ? (
            <span className="github-sending" role="status">Resolving…</span>
          ) : thread.sending === 'reopening' ? (
            <span className="github-sending" role="status">Reopening…</span>
          ) : thread.isResolved ? (
            <span className="github-thread-resolution">
              <Check size={13} aria-hidden="true" />
              Resolved
            </span>
          ) : published ? (
            'Unresolved'
          ) : (
            'Not submitted'
          )}
          {thread.isOutdated ? ' · Earlier revision' : ''}
        </span>
      </summary>
      {reason && <p className="github-thread-reason">{reason}</p>}
      <div className="github-thread-comments">
        {thread.comments.map((comment) => (
          <article key={comment.id} data-pending={isPendingComment(comment) || undefined} data-sending={comment.sending}>
            <header>
              <strong>{comment.author ? <GitHubAuthor login={comment.author.login} bot={comment.author.__typename === 'Bot'} /> : 'Deleted account'}</strong>
              {comment.sending ? (
                // The reader's write, before GitHub confirmed it. A new comment has no URL yet; an edited one keeps its own.
                <span className="github-sending" role="status">{comment.url ? 'Saving…' : 'Sending…'}</span>
              ) : isPendingComment(comment) ? (
                <span className="github-comment-pending" title="Only you can see this comment until you submit your review on GitHub">
                  Pending · not submitted
                </span>
              ) : (
                <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                  {timeAgo(comment.createdAt)}
                </time>
              )}
              {comment.url && <button onClick={() => void window.electronAPI.openExternal(comment.url)}>On GitHub</button>}
            </header>
            {editing === comment.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  changeComment(comment.id, 'edit');
                }}
              >
                <label htmlFor={`${inputId}-edit`}>Edit your comment</label>
                <MarkdownCommentEditor
                  id={`${inputId}-edit`}
                  value={editBody}
                  onValueChange={setEditBody}
                 
                  maxLength={65536}
                  rows={3}
                  autoFocus
                />
                <div className="github-thread-actions">
                  <button disabled={!editBody.trim()}>Save changes</button>
                  <button type="button" onClick={() => setEditing(undefined)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : comment.isMinimized ? (
              <HiddenComment comment={comment} />
            ) : (
              <CommentMarkdown>{comment.body}</CommentMarkdown>
            )}
            <WriteFailureNotice failureKey={`comment-change:${comment.id}`} className="github-thread-error" />
            {onCommentAction && !editing && !comment.sending && (
              <div className="github-thread-actions">
                {comment.viewerCanUpdate && (
                  <button
                   
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
                      <button onClick={() => changeComment(comment.id, 'delete')}>
                        Delete comment
                      </button>
                      <button onClick={() => setDeleting(undefined)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setDeleting(comment.id)}>
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
            act('reply');
          }}
        >
          <label htmlFor={inputId}>Reply to this GitHub thread</label>
          <MarkdownCommentEditor
            id={inputId}
            value={draft}
            onValueChange={setDraft}
            rows={3}
            maxLength={65536}
           
            autoFocus
          />
          {!actionContainer && (
            <div className="github-thread-actions">
              <button type="submit" disabled={!draft.trim() || replySending}
            title={replySending ? 'Your previous reply is still sending.' : undefined}>
                Reply on GitHub
              </button>
              <button type="button" onClick={() => setReplying(false)}>
                Cancel
              </button>
            </div>
          )}
        </form>
      )}
      <WriteFailureNotice failureKey={`thread-reply:${thread.id}`} className="github-thread-error" />
      <WriteFailureNotice failureKey={`thread-state:${thread.id}`} className="github-thread-error" />
    </details>
  );
}
