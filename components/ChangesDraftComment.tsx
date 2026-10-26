import { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionDraft } from '../lib/session-drafts';
import { Button } from './ui/button';
import type { PendingReviewComment } from '../lib/types';
export function ChangesDraftComment({
  comment,
  onEdit,
  onRemove,
  disabled = false,
  onEditingChange,
}: {
  comment: PendingReviewComment;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  disabled?: boolean;
  onEditingChange?: (id: string, editing: boolean) => void;
}) {
  const [editing, setEditing] = useSessionDraft(`changes-draft-editing:${comment.id}`, false);
  const [error, setError] = useState('');
  const [saving,setSaving] = useState(false);
  disabled = disabled || saving;
  const [body, setBody] = useSessionDraft(`changes-draft-edit:${comment.id}`, comment.body);
  const id = useId();
  useEffect(() => {
    onEditingChange?.(comment.id, editing);
    return () => onEditingChange?.(comment.id, false);
  }, [comment.id, editing, onEditingChange]);
  return (
    <div className="changes-draft-comment">
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (disabled || !body.trim()) return;
            setSaving(true);
            try {
              await onEdit(comment.id, body.trim());
              setEditing(false);
              setError('');
            } catch {
              setError('Could not save this edit. Your text is still here.');
            } finally {setSaving(false);}
          }}
        >
          <label htmlFor={id}>Edit draft comment</label>
          <textarea
            id={id}
            rows={3}
            maxLength={65536}
            autoFocus
            value={body}
            disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <div className="changes-comment-buttons">
            <Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={disabled || !body.trim()}>
              Save draft
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="github-comment-body select-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: ({ alt }) => <span>[{alt || 'Image attachment'}]</span>,
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
              }}
            >
              {comment.body}
            </ReactMarkdown>
          </div>
          <div className="changes-comment-buttons">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setBody(comment.body);
                setEditing(true);
              }}
            >
              Edit draft
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={async () => {
                setSaving(true);
                try {
                  await onRemove(comment.id);
                  setError('');
                } catch {
                  setError('Could not remove this draft. Try again.');
                } finally {setSaving(false);}
              }}
            >
              Remove draft
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
