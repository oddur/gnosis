import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, Eye, MoreHorizontal, Trash2, Undo2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import {
  agentBriefMarkdown,
  briefGroups,
  briefLines,
  briefViewLabel,
  useAgentBrief,
  type AgentBriefComment,
} from '../lib/agent-brief';
import { useSessionScroll } from '../lib/session-drafts';
import type { ReviewSubject } from '../lib/workbench';
import { ChangesDraftComment } from './ChangesDraftComment';
import { Button } from './ui/button';

function PrNotesLink({ url, number, onOpen }: { url: string; number: number; onOpen: (id: string) => void }) {
  const { comments } = useAgentBrief(url);
  if (!comments.length) return null;
  return (
    <button onClick={() => onOpen(url)}>
      {comments.length} {comments.length === 1 ? 'note' : 'notes'} in PR #{number}
    </button>
  );
}

/** Review private notes with their source context, then copy a complete handoff. */
export function AgentBriefView({
  subject,
  parentStack,
  onOpenScope,
  onOpenComment,
  onOpenChanges,
}: {
  subject: ReviewSubject;
  parentStack?: ReviewSubject;
  onOpenScope?: (id: string) => void;
  onOpenComment: (comment: AgentBriefComment) => void;
  onOpenChanges: () => void;
}) {
  const { comments, removed, update, remove, restore } = useAgentBrief(subject.id);
  const parentNotes = useAgentBrief(parentStack?.id ?? '');
  const groups = useMemo(() => briefGroups(comments, subject), [comments, subject]);
  const markdown = useMemo(() => (comments.length ? agentBriefMarkdown(subject, comments) : ''), [comments, subject]);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const [editors, setEditors] = useState<ReadonlySet<string>>(new Set());
  const editing = comments.some((note) => editors.has(note.id));
  const blocked = !!busy || editing;
  const onBusyChange = useCallback((id: string, active: boolean) => {
    setEditors((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const scroll = useSessionScroll(`agent-brief:${subject.id}`);
  const previewId = useId();
  const undoButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusUndo = useRef(false);
  useEffect(() => {
    if (removed.length && !blocked && focusUndo.current) {
      focusUndo.current = false;
      undoButton.current?.focus();
    }
  }, [removed.length, blocked]);
  async function run(label: string, action: () => Promise<void>, success: string) {
    if (pending.current || editing) return;
    pending.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
    } catch {
      setError(
        label === 'Copying…'
          ? 'Could not copy your notes. They are still saved here. Try Copy for agent again.'
          : label === 'Restoring…'
            ? 'Could not restore your notes. Undo is still available. Try again.'
            : 'Could not delete your notes. They are still saved here. Try again.'
      );
    } finally {
      pending.current = false;
      setBusy('');
    }
  }
  const removeNotes = async (ids: ReadonlySet<string>) => {
    focusUndo.current = true;
    try {
      await remove(ids);
    } catch (error) {
      focusUndo.current = false;
      throw error;
    }
  };
  const scopeLabel = subject.kind === 'stack' ? 'this stack' : `PR #${subject.members[0].number}`;
  return (
    <section className="agent-brief" aria-label="Local notes" ref={scroll.ref} onScroll={scroll.onScroll}>
      <header className="agent-brief-header">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Local notes <span>{comments.length}</span>
          </h2>
          <p>Notes for {scopeLabel} only. Saved on this computer, never posted to GitHub.</p>
        </div>
        {comments.length > 0 && (
          <div className="agent-brief-actions">
            <Button
              size="sm"
              disabled={blocked}
              onClick={() =>
                void run(
                  'Copying…',
                  () => navigator.clipboard.writeText(markdown),
                  'Copied with code context. Paste into your coding agent.'
                )
              }
            >
              <ClipboardCopy size={14} />
              {busy === 'Copying…' ? busy : 'Copy for agent'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={preview}
              aria-controls={previewId}
              onClick={() => setPreview((open) => !open)}
            >
              <Eye size={14} />
              {preview ? 'Hide preview' : 'Preview'}
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Note actions" disabled={blocked}>
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="pr-update-menu"
                  align="end"
                  sideOffset={4}
                  onCloseAutoFocus={(event) => {
                    if (pending.current) event.preventDefault();
                  }}
                >
                  <DropdownMenu.Item
                    onSelect={() =>
                      void run('Deleting…', () => removeNotes(new Set(comments.map((note) => note.id))), '')
                    }
                  >
                    <Trash2 size={14} /> Delete all notes
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        )}
      </header>
      {parentStack && onOpenScope && (
        <p className="agent-brief-scope-link">
          Stack notes are separate.{' '}
          <button onClick={() => onOpenScope(parentStack.id)}>
            {parentNotes.comments.length
              ? `View ${parentNotes.comments.length} ${parentNotes.comments.length === 1 ? 'note' : 'notes'} saved for the stack`
              : 'Open stack notes'}
          </button>
        </p>
      )}
      {subject.kind === 'stack' && (
        <div className="agent-brief-scope-link">
          <p>Combined and By PR notes collect here. Individual PR notebooks are separate.</p>
          {onOpenScope && (
            <div className="agent-brief-related">
              {subject.members.map((member) => (
                <PrNotesLink key={member.url} url={member.url} number={member.number} onOpen={onOpenScope} />
              ))}
            </div>
          )}
        </div>
      )}
      {editing && (
        <p className="agent-brief-edit-notice" role="status">
          Save or cancel your edits before copying or deleting notes.
        </p>
      )}
      {error && (
        <p className="changes-notice" role="alert">
          {error}
        </p>
      )}
      <p className="agent-brief-notice" role="status">
        {notice}
      </p>
      {removed.length > 0 && (
        <div className="agent-brief-undo">
          <span role="status">
            {removed.length} {removed.length === 1 ? 'note deleted' : 'notes deleted'}. You can undo until you close
            Gnosis.
          </span>
          <Button
            ref={undoButton}
            variant="ghost"
            size="sm"
            disabled={blocked}
            onClick={() =>
              void run(
                'Restoring…',
                async () => {
                  await restore();
                  requestAnimationFrame(() => heading.current?.focus());
                },
                'Restored your notes.'
              )
            }
          >
            <Undo2 size={14} />
            {busy === 'Restoring…' ? busy : 'Undo deletion'}
          </Button>
        </div>
      )}
      {preview && comments.length > 0 && (
        <section className="agent-brief-preview" id={previewId} aria-label="Preview what gets copied">
          <h3>What your agent receives</h3>
          <p>
            Saved notes with code, file locations, and the version you reviewed.
            {editing && ' Unsaved edits are not included yet.'}
          </p>
          <pre>{markdown}</pre>
        </section>
      )}
      {!comments.length ? (
        <div className="changes-empty agent-brief-empty">
          <strong>No local notes for {scopeLabel}</strong>
          <p>In Changes, select a line or range, write your note, and choose Add local note.</p>
          <Button variant="outline" size="sm" onClick={onOpenChanges}>
            Open Changes
          </Button>
        </div>
      ) : (
        groups.map((group) => (
          <section className="agent-brief-group" key={group.key}>
            <header className="agent-brief-group-heading">
              <h3>
                {briefViewLabel(group.first)}
                {group.first.view !== 'combined' && <span> {group.first.title}</span>}
              </h3>
              <p className="agent-brief-revision">
                {group.first.comparisonBase.slice(0, 7)}..{group.first.headSha.slice(0, 7)}
              </p>
            </header>
            {group.newerHead && (
              <p className="agent-brief-stale">
                Earlier version — this PR has new commits. Check that these notes still apply.
              </p>
            )}
            {group.comments.map((comment) => (
              <article className="agent-brief-comment" key={comment.id}>
                <button className="agent-brief-location" onClick={() => onOpenComment(comment)}>
                  <span>{comment.path}</span> {briefLines(comment)}
                </button>
                {comment.code &&
                  (comment.code.split('\n').length > 5 ? (
                    <details className="agent-brief-code">
                      <summary>
                        Show selected code ({comment.code.split('\n').length} lines
                        {comment.codeLinesOmitted ? `, ${comment.codeLinesOmitted} more not captured` : ''})
                      </summary>
                      <pre>{comment.code}</pre>
                    </details>
                  ) : (
                    <pre>{comment.code}</pre>
                  ))}
                <ChangesDraftComment
                  noun="note"
                  contextLabel={`${comment.path}, ${briefLines(comment)}`}
                  comment={comment}
                  disabled={!!busy}
                  onBusyChange={onBusyChange}
                  onRemove={(id) => removeNotes(new Set([id]))}
                  onEdit={async (id, body) => {
                    await update((list) => list.map((c) => (c.id === id ? { ...c, body } : c)));
                    setNotice('Note saved.');
                  }}
                />
              </article>
            ))}
          </section>
        ))
      )}
    </section>
  );
}
