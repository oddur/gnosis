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
  }) => void;
  onRemoveComment: (id: string) => void;
  onEditComment: (id: string, body: string) => void;
}

/**
 * Parse the Shiki-rendered HTML to extract individual line elements.
 * Shiki wraps each line in <span class="line">...</span> inside <code> inside <pre>.
 */
export function parseShikiLines(renderedHtml: string): string[] | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(renderedHtml, 'text/html');
    const lines = doc.querySelectorAll('span.line');
    if (lines.length === 0) return null;
    return Array.from(lines).map((el) => el.innerHTML);
  } catch {
    return null;
  }
}

/**
 * Extract the Shiki theme styles from the rendered <pre> element so we can
 * re-apply them when rendering individual lines outside the original tree.
 */
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
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
  initialBody?: string;
}) {
  const [body, setBody] = useState(initialBody ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (body.trim()) onSubmit(body.trim());
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="mx-2 my-1.5 border rounded-md bg-muted/30 p-2">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Leave a comment... (Cmd+Enter to add, Esc to cancel)"
        className="w-full min-h-[60px] bg-transparent text-sm font-mono resize-y border rounded p-2 focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex justify-end gap-1.5 mt-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => body.trim() && onSubmit(body.trim())} disabled={!body.trim()}>
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
  onRemove: (id: string) => void;
  onEdit: (id: string, body: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineCommentForm
        initialBody={comment.body}
        onSubmit={(body) => {
          onEdit(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="pending-comment-block mx-2 my-1 border rounded-md p-2 flex gap-2 group">
      <pre className="pending-comment-block-text flex-1 text-xs font-mono whitespace-pre-wrap break-words">
        {comment.body}
      </pre>
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={() => setEditing(true)}
          className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          title="Edit"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={() => onRemove(comment.id)}
          className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
