import { useId, useRef, useState } from 'react';
import { useSessionDraft } from '../lib/session-drafts';
import { Button } from './ui/button';
export function ChangesCommentComposer({
  draftKey,
  label,
  onSave,
  onCancel,
}: {
  draftKey: string;
  label: string;
  onSave: (body: string, now: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [body, setBody] = useSessionDraft(`changes-comment:${draftKey}`, '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  async function save(now: boolean) {
    if (pending.current || !body.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await onSave(body.trim(), now);
      setBody('');
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="changes-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={65536}
        disabled={busy}
        autoFocus
        placeholder="Write a comment… Markdown supported."
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save(false);
          }
        }}
      />
      <p className="changes-comment-help">
        Add to review saves a private draft. Comment now posts to GitHub immediately.
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !body.trim()}
          onClick={() => void save(true)}
        >
          Comment now
        </Button>
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Add to review'}
        </Button>
      </div>
    </form>
  );
}
