import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useEffect, useId, useRef, useState } from 'react';
import { CommentMarkdown } from './CommentMarkdown';
import { useSessionDraft } from '../lib/session-drafts';
import { Button } from './ui/button';
import type { PendingReviewComment } from '../lib/types';
export function ChangesDraftComment({
  comment,
  onEdit,
  onRemove,
  disabled = false,
  onBusyChange,
  noun = 'draft',
  contextLabel,
}: {
  comment: Pick<PendingReviewComment, 'id' | 'body'>;
  noun?: 'draft' | 'comment' | 'note';
  contextLabel?: string;
  onEdit: (id: string, body: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  disabled?: boolean;
  onBusyChange?: (id: string, busy: boolean) => void;
}) {
  const [editing, setEditing] = useSessionDraft(`changes-draft-editing:${comment.id}`, false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  disabled = disabled || saving;
  const [body, setBody] = useSessionDraft(`changes-draft-edit:${comment.id}`, comment.body);
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const returnFocus = useRef(false);
  const finishEditing = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  useEffect(() => {
    if (!editing && !disabled && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing, disabled]);
  useEffect(() => {
    onBusyChange?.(comment.id, editing || saving);
    return () => onBusyChange?.(comment.id, false);
  }, [comment.id, editing, saving, onBusyChange]);
  return (
    <div className="changes-draft-comment">
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (disabled || pending.current || !body.trim()) return;
            pending.current = true;
            setSaving(true);
            try {
              await onEdit(comment.id, body.trim());
              finishEditing();
              setError('');
            } catch {
              setError('Could not save this edit. Your text is still here.');
            } finally {
              pending.current = false;
              setSaving(false);
            }
          }}
        >
          <label htmlFor={id}>{noun === 'draft' ? 'Edit draft comment' : `Edit ${noun}`}</label>
          <MarkdownCommentEditor
            id={id}
            rows={3}
            maxLength={65536}
            autoFocus
            value={body}
            disabled={disabled}
            onValueChange={setBody}
          />
          {error && <p role="alert">{error}</p>}
          <div className="changes-comment-buttons">
            <Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={finishEditing}>
              Cancel
            </Button>
            <Button size="sm" disabled={disabled || !body.trim()}>
              {saving ? 'Saving…' : `Save ${noun}`}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <CommentMarkdown>{comment.body}</CommentMarkdown>
          <div className="changes-comment-buttons">
            <Button
              ref={editButton}
              aria-label={contextLabel ? `Edit ${noun} · ${contextLabel}` : undefined}
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setBody(comment.body);
                setEditing(true);
              }}
            >
              Edit {noun}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={contextLabel ? `Remove ${noun} · ${contextLabel}` : undefined}
              onClick={async () => {
                if (pending.current) return;
                pending.current = true;
                setSaving(true);
                try {
                  await onRemove(comment.id);
                  setError('');
                } catch {
                  setError(`Could not remove this ${noun}. Try again.`);
                } finally {
                  pending.current = false;
                  setSaving(false);
                }
              }}
            >
              Remove {noun}
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
