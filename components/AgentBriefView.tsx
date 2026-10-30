import { useMemo, useState } from 'react';
import { Check, ClipboardCopy, Trash2 } from 'lucide-react';
import {
  agentBriefMarkdown,
  briefGroups,
  briefLines,
  briefViewLabel,
  useAgentBrief,
  type AgentBriefComment,
} from '../lib/agent-brief';
import { useSessionScroll } from '../lib/session-drafts';
import { useCopyToClipboard } from '../lib/use-copy';
import type { ReviewSubject } from '../lib/workbench';
import { ChangesDraftComment } from './ChangesDraftComment';
import { Button } from './ui/button';

/** Review the comments collected for one stack or PR, then hand them to an agent as Markdown. */
export function AgentBriefView({
  subject,
  onOpenComment,
  onOpenChanges,
}: {
  subject: ReviewSubject;
  onOpenComment: (comment: AgentBriefComment) => void;
  onOpenChanges: () => void;
}) {
  const { comments, update } = useAgentBrief(subject.id);
  const groups = useMemo(() => briefGroups(comments, subject), [comments, subject]);
  const markdown = useMemo(() => (comments.length ? agentBriefMarkdown(subject, comments) : ''), [comments, subject]);
  const { state: copyState, copy } = useCopyToClipboard();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useSessionScroll(`agent-brief:${subject.id}`);
  const remove = async (ids: ReadonlySet<string>) => {
    await update((list) => list.filter((comment) => !ids.has(comment.id)));
  };
  const clear = async (copyFirst: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    setConfirming(false);
    // Only what was copied is deleted, so a comment saved meanwhile cannot be lost.
    const ids = new Set(comments.map((comment) => comment.id));
    try {
      if (copyFirst) await navigator.clipboard.writeText(markdown);
    } catch {
      setBusy(false);
      setError('Could not copy to the clipboard, so your comments were kept. Try again.');
      return;
    }
    try {
      await remove(ids);
      setNotice(copyFirst ? 'Copied and deleted the brief.' : 'Deleted the brief.');
    } catch {
      setError(
        copyFirst
          ? 'Copied, but could not delete the comments on this computer. Try again.'
          : 'Could not delete the comments on this computer. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };
  const scopeLabel =
    subject.kind === 'stack' ? `Stack · ${subject.members.length} PRs` : `PR #${subject.members[0].number}`;
  return (
    <section className="agent-brief" aria-label="Agent brief" ref={scroll.ref} onScroll={scroll.onScroll}>
      <header className="agent-brief-header">
        <div>
          <h2>Agent brief</h2>
          <p>
            {scopeLabel} · {comments.length} {comments.length === 1 ? 'comment' : 'comments'} · Saved on this computer,
            never posted to GitHub
          </p>
        </div>
        {comments.length > 0 && (
          <div className="agent-brief-actions">
            <Button size="sm" disabled={busy} onClick={() => copy(markdown)}>
              {copyState === 'copied' ? <Check size={14} /> : <ClipboardCopy size={14} />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed, retry' : 'Copy'}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void clear(true)}>
              Copy and delete
            </Button>
            {confirming ? (
              <span className="agent-brief-confirm" role="group" aria-label="Confirm delete">
                <span>
                  Delete {comments.length} {comments.length === 1 ? 'comment' : 'comments'}?
                </span>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void clear(false)}>
                  Delete
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 size={14} /> Delete
              </Button>
            )}
          </div>
        )}
      </header>
      {error && (
        <p className="changes-notice" role="alert">
          {error}
        </p>
      )}
      {notice && !comments.length && (
        <p className="changes-notice" role="status">
          {notice}
        </p>
      )}
      {!comments.length ? (
        <div className="changes-empty agent-brief-empty">
          <strong>No comments in this brief yet</strong>
          <p>
            In Changes, use the + beside a line or select several lines, write your comment, and choose Add to brief.
            {subject.kind === 'stack' && ' Comments from the Combined and By PR views both collect here.'}
          </p>
          <Button variant="outline" size="sm" onClick={onOpenChanges}>
            Open Changes
          </Button>
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <section className="agent-brief-group" key={group.key}>
              <h3>
                {briefViewLabel(group.first)}
                {group.first.view !== 'combined' && <span> {group.first.title}</span>}
              </h3>
              <p className="agent-brief-revision">
                {group.first.comparisonBase.slice(0, 7)}..{group.first.headSha.slice(0, 7)}
                {group.newerHead && ` · Earlier version: this PR has moved to ${group.newerHead.slice(0, 7)}`}
              </p>
              {group.comments.map((comment) => (
                <article className="agent-brief-comment" key={comment.id}>
                  <button className="agent-brief-location" onClick={() => onOpenComment(comment)}>
                    <span>{comment.path}</span> {briefLines(comment)}
                  </button>
                  {comment.code && (
                    <pre>
                      {comment.code}
                      {comment.codeLinesOmitted ? `\n… ${comment.codeLinesOmitted} more` : ''}
                    </pre>
                  )}
                  <ChangesDraftComment
                    noun="comment"
                    comment={comment}
                    onRemove={(id) => remove(new Set([id]))}
                    onEdit={(id, body) => update((list) => list.map((c) => (c.id === id ? { ...c, body } : c)))}
                  />
                </article>
              ))}
            </section>
          ))}
          <details className="agent-brief-preview">
            <summary>Preview what gets copied</summary>
            <pre>{markdown}</pre>
          </details>
        </>
      )}
    </section>
  );
}
