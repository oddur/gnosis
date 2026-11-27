import { closeReviewComment, reviewCommentOpen } from '../lib/review-comment';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useEffect, useId, useRef, useState } from 'react';
import { useSessionDraft, useSessionDraftId, writeSessionDraft } from '../lib/session-drafts';
import { WriteFailureNotice } from './WriteFailureNotice';
import { Button } from './ui/button';

export function ChangesCommentComposer({
  draftKey,
  label,
  onSave,
  onAddToBrief,
  onCancel,
  note,
  failureKey,
}: {
  draftKey: string;
  label: string;
  /** Absent when GitHub cannot represent this comparison or selection. */
  /**
   * `now` posts to GitHub at once. That write does not wait: the comment shows as sending, and on failure the
   * caller reopens this composer after `restore` put the text back.
   */
  onSave?: (body: string, now: boolean, restore: (text: string) => void) => Promise<void>;
  /** A failed post of this comment, shown with Retry. */
  failureKey?: string;
  onAddToBrief?: (body: string) => Promise<void>;
  onCancel: () => void;
  note?: string;
}) {
  const id = useId();
  const [body, setBody] = useSessionDraft(`changes-comment:${draftKey}`, '');
  const draftId = useSessionDraftId(`changes-comment:${draftKey}`);
  const restore = (text: string) => writeSessionDraft(draftId, text);
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
  // Opened for the item under review (Enter, lib/review-comment.ts): closing hands the keyboard back, or goes on.
  const next = useRef(false);
  const cancel = () => {
    onCancel();
    closeReviewComment('cancelled');
  };
  async function run(action: (text: string) => Promise<void>) {
    if (pending.current || !body.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action(body.trim());
      setBody('');
      onCancel();
      closeReviewComment(next.current ? 'next' : 'saved');
      next.current = false;
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
      return run((text) => onSave(text, false, restore));
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
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            // Opened for the item under review, ⌘⇧↩ saves and then does what V does; elsewhere it saves a local note.
            if (e.shiftKey && reviewCommentOpen()) {
              next.current = true;
              void submit(destination);
              return;
            }
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
      <WriteFailureNotice failureKey={failureKey} />
      <div ref={actions} className="changes-comment-buttons">
        <span className="changes-comment-shortcut">
          {shortcut}Enter to {destination === 'local' ? 'add local note' : 'add to review'}
          {reviewCommentOpen() && ` · ${shortcut}⇧Enter to add and go on`}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        {onSave && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !body.trim()}
            onClick={() => void run((text) => onSave(text, true, restore))}
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
