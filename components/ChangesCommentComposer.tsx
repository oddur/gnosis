import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useEffect, useId, useRef, useState } from 'react';
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
  /** Absent when GitHub cannot represent this comparison or selection. */
  onSave?: (body: string, now: boolean) => Promise<void>;
  onAddToBrief?: (body: string) => Promise<void>;
  onCancel: () => void;
  note?: string;
}) {
  const id = useId();
  const [body, setBody] = useSessionDraft(`changes-comment:${draftKey}`, '');
  // Remember intent across files and comparison views, not the immediate-post action.
  const [preferred, setPreferred] = useSessionDraft<'local' | 'review'>('changes-comment-destination', 'review');
  const destination = preferred === 'local' && onAddToBrief ? 'local' : onSave ? 'review' : 'local';
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => actions.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, []);
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
  const submit = (target = destination) => {
    if (target === 'local' && onAddToBrief) {
      setPreferred('local');
      return run(onAddToBrief);
    }
    if (target === 'review' && onSave) {
      setPreferred('review');
      return run((text) => onSave(text, false));
    }
  };
  const shortcut = /Macintosh|Mac OS X/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
  return (
    <form
      className="changes-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id}>{!onSave ? label.replace(/^Comment on /, 'Local note on ') : label}</label>
      {onAddToBrief && onSave && (
        <fieldset className="changes-comment-destination" disabled={busy}>
          <legend>Save as</legend>
          <label>
            <input
              type="radio"
              name={`${id}-destination`}
              value="local"
              checked={destination === 'local'}
              onChange={() => setPreferred('local')}
            />
            Local note
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-destination`}
              value="review"
              checked={destination === 'review'}
              onChange={() => setPreferred('review')}
            />
            Review draft
          </label>
        </fieldset>
      )}
      <MarkdownCommentEditor
        id={id}
        value={body}
        onValueChange={setBody}
        rows={4}
        maxLength={65536}
        disabled={busy}
        autoFocus
        placeholder={
          destination === 'local'
            ? 'Write a local note… Markdown supported.'
            : 'Write a review comment… Markdown supported.'
        }
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(e.shiftKey && onAddToBrief ? 'local' : destination);
          }
        }}
      />
      <p className="changes-comment-help">
        {destination === 'local'
          ? 'Saved on this computer, never posted to GitHub. Copy it with code context from Local notes.'
          : 'Saved as a draft until you submit your GitHub review.'}
        {note && ` ${note}`}
      </p>
      {error && (
        <p role="alert" className="github-thread-error">
          {error}
        </p>
      )}
      <div ref={actions} className="changes-comment-buttons">
        <span className="changes-comment-shortcut">
          {shortcut}Enter to {destination === 'local' ? 'add local note' : 'add to review'}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {onSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !body.trim()}
            onClick={() => void run((text) => onSave(text, true))}
          >
            Post to GitHub now
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : destination === 'local' ? 'Add local note' : 'Add to review'}
        </Button>
      </div>
    </form>
  );
}
