import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useId, useRef, useState } from 'react';
import { useSessionDraft } from '../lib/session-drafts';
import { Button } from './ui/button';
export function ChangesCommentComposer({
  draftKey,
  label,
  onSave,
  onAddToBrief,
  onCancel,
  note,
}: {
  draftKey: string;
  label: string;
  /** Absent when this diff cannot be commented on in GitHub, such as the combined stack diff. */
  onSave?: (body: string, now: boolean) => Promise<void>;
  onAddToBrief?: (body: string) => Promise<void>;
  onCancel: () => void;
  note?: string;
}) {
  const id = useId();
  const [body, setBody] = useSessionDraft(`changes-comment:${draftKey}`, '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  async function run(action: (text: string) => Promise<void>) {
    if (pending.current || !body.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action(body.trim());
      setBody('');
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const save = (now: boolean) => (onSave ? run((text) => onSave(text, now)) : Promise.resolve());
  const addToBrief = () => (onAddToBrief ? run(onAddToBrief) : Promise.resolve());
  const submit = () => (onSave ? save(false) : addToBrief());
  return (
    <form
      className="changes-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <MarkdownCommentEditor
        id={id}
        value={body}
        onValueChange={setBody}
        rows={4}
        maxLength={65536}
        disabled={busy}
        autoFocus
        placeholder="Write a comment… Markdown supported."
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void (e.shiftKey ? addToBrief() : submit());
          }
        }}
      />
      <p className="changes-comment-help">
        {onSave
          ? `${onAddToBrief ? 'Add to brief saves a note for your agent. ' : ''}Add to review saves a private draft. Comment now posts to GitHub immediately.`
          : 'Add to brief saves a note for your agent on this computer. Nothing is posted to GitHub.'}
        {note && ` ${note}`}
      </p>
      {error && (
        <p role="alert" className="github-thread-error">
          {error}
        </p>
      )}
      <div className="changes-comment-buttons">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {onAddToBrief && onSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !body.trim()}
            title="Shift+Cmd+Enter"
            onClick={() => void addToBrief()}
          >
            Add to brief
          </Button>
        )}
        {onSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !body.trim()}
            onClick={() => void save(true)}
          >
            Comment now
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : onSave ? 'Add to review' : 'Add to brief'}
        </Button>
      </div>
    </form>
  );
}
