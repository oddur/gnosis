import { GitHubAuthor } from './GitHubAuthor';
import { useSessionDraft } from '../lib/session-drafts';
import { useId, useState } from 'react';
import { MessageSquare, Check, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { timeAgo } from '../lib/utils';
import type { GitHubReviewThread as Thread, ReviewThreadAction } from '../lib/review-threads';

interface Props {
  thread: Thread;
  reason?: string;
  onAction: (action: ReviewThreadAction['action'], body?: string) => Promise<void>;
}

export function GitHubReviewThread({ thread, reason, onAction }: Props) {
  const [replying, setReplying] = useSessionDraft(`thread-replying:${thread.id}`,false);
  const [draft, setDraft] = useSessionDraft(`thread-reply:${thread.id}`, '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  async function act(action: ReviewThreadAction['action']) {
    setBusy(true);
    setError('');
    try {
      await onAction(action, action === 'reply' ? draft : undefined);
      if (action === 'reply') {
        setDraft('');
        setReplying(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const first = thread.comments.length ? thread.comments[0] : undefined;
  return (
    <details className="github-thread" data-thread-id={thread.id} open={!thread.isResolved}>
      <summary>
        <ChevronRight className="github-thread-chevron" size={12} aria-hidden="true" />
        {thread.isResolved ? <Check size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
        <span>
          {first?.author?.login ?? 'GitHub'} · {thread.comments.length}{' '}
          {thread.comments.length === 1 ? 'comment' : 'comments'}
        </span>
        <span className="github-thread-state">
          {thread.isResolved ? 'Resolved' : 'Unresolved'}
          {thread.isOutdated ? ' · Outdated' : ''}
        </span>
      </summary>
      {reason && <p className="github-thread-reason">{reason}</p>}
      <div className="github-thread-comments">
        {thread.comments.map((comment) => (
          <article key={comment.id}>
            <header>
              <strong>{comment.author ? <GitHubAuthor login={comment.author.login}/> : 'Deleted account'}</strong>
              <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
                {timeAgo(comment.createdAt)}
              </time>
              <button onClick={() => void window.electronAPI.openExternal(comment.url)}>On GitHub</button>
            </header>
            <div className="github-comment-body select-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (href && /^https?:\/\//.test(href)) void window.electronAPI.openExternal(href);
                      }}
                    >
                      {children}
                    </a>
                  ),
                  img: ({ alt }) => <span>[{alt || 'Image attachment'} — view on GitHub]</span>,
                }}
              >
                {comment.body}
              </ReactMarkdown>
            </div>
          </article>
        ))}
      </div>
      <div className="github-thread-actions">
        {!replying && (
          <button disabled={busy} onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
        {((thread.isResolved && thread.viewerCanUnresolve) || (!thread.isResolved && thread.viewerCanResolve)) && (
          <button disabled={busy} onClick={() => void act(thread.isResolved ? 'unresolve' : 'resolve')}>
            {thread.isResolved ? 'Reopen thread' : 'Resolve thread'}
          </button>
        )}
        {busy && <span role="status">Saving to GitHub…</span>}
      </div>
      {replying && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act('reply');
          }}
        >
          <label htmlFor={inputId}>Reply to this GitHub thread</label>
          <textarea
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={65536}
            disabled={busy}
            autoFocus
          />
          <div className="github-thread-actions">
            <button type="submit" disabled={busy || !draft.trim()}>
              Reply on GitHub
            </button>
            <button type="button" disabled={busy} onClick={() => setReplying(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="github-thread-error">
          {error}
        </p>
      )}
    </details>
  );
}
