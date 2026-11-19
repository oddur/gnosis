import { CommentMarkdown } from './CommentMarkdown';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useSessionDraft } from '../lib/session-drafts';
import { useState, useRef, useEffect } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingReviewComment, DiffSide } from '@/lib/types';

export interface CommentCallbacks {
  onAddComment: (params: {
    filePath: string;
    line: number;
    side: DiffSide;
    body: string;
    hunkHeader: string;
    codeSnippet: string;
    slideIndex: number;
  }) => void | Promise<void>;
  onRemoveComment: (id: string) => void | Promise<void>;
  onEditComment: (id: string, body: string) => void | Promise<void>;
}

/** The class and inline style of a topic's saved Shiki `<pre>`: its class names the code theme it was written in. */
export function extractShikiStyles(renderedHtml: string): { preStyle: Record<string, string>; preClass: string } {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(renderedHtml, 'text/html');
    const pre = doc.querySelector('pre');
    const styleStr = pre?.getAttribute('style') ?? '';
    const preStyle: Record<string, string> = {};
    for (const decl of styleStr.split(';')) {
      const [prop, ...rest] = decl.split(':');
      if (!prop.trim() || rest.length === 0) continue;
      const camel = prop.trim().replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase());
      preStyle[camel] = rest.join(':').trim();
    }
    return {
      preStyle,
      preClass: pre?.getAttribute('class') ?? '',
    };
  } catch {
    return { preStyle: {}, preClass: '' };
  }
}

export function InlineCommentForm({
  onSubmit,
  onCancel,
  initialBody,
  draftKey,
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  initialBody?: string;
  draftKey?: string;
}) {
  const [body, setBody] = useSessionDraft(`inline:${draftKey ?? initialBody ?? 'new'}`, initialBody ?? '');
  const [error, setError] = useState('');
  const [saving,setSaving] = useState(false);
  const pendingSave = useRef(false);
  async function save() {
    if (pendingSave.current || !body.trim()) return;
    pendingSave.current = true;
    setSaving(true);
    try { await onSubmit(body.trim()); setBody(''); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save your comment. Your text is still here.'); }
    finally {pendingSave.current = false;setSaving(false);}
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (pendingSave.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="mx-2 my-1.5 border rounded-md bg-muted/30 p-2">
      <MarkdownCommentEditor
        textareaRef={textareaRef}
        disabled={saving}
        value={body}
        onValueChange={setBody}
        onKeyDown={handleKeyDown}
        placeholder="Leave a comment... (Cmd+Enter to add, Esc to cancel)"
        aria-label="Comment"
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-1.5 mt-1.5">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || !body.trim()}>
          Add comment
        </Button>
      </div>
    </div>
  );
}

export function CommentBubble({
  comment,
  onRemove,
  onEdit,
}: {
  comment: PendingReviewComment;
  onRemove: (id: string) => void | Promise<void>;
  onEdit: (id: string, body: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error,setError] = useState('');

  if (editing) {
    return (
      <InlineCommentForm
        draftKey={comment.id}
        initialBody={comment.body}
        onSubmit={async (body) => {
          await onEdit(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="pending-comment-block mx-2 my-1 border rounded-md p-2 flex gap-2 group">
      {error && <p role="alert">{error}</p>}
      <div className="pending-comment-block-text flex-1 min-w-0"><CommentMarkdown>{comment.body}</CommentMarkdown></div>
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={() => setEditing(true)}
          className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          title="Edit"
          aria-label="Edit comment"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => { void Promise.resolve().then(()=>onRemove(comment.id)).catch(()=>setError('Could not remove this draft. Try again.')); }}
          className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
          title="Delete"
          aria-label="Delete comment"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
