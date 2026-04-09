import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import type { ChatMessage } from '@/lib/use-slide-chat';

const MIN_WIDTH = 300;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 460;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slideTitle: string;
  reviewFocus: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (text: string) => void;
  // When the user selects code in the diff and clicks "Ask about
  // this", the selected code is passed here as a fenced code block.
  // The chat sheet renders it as a quoted block above the input and
  // includes it in the message when the user sends. Cleared after
  // first send via onQuotedCodeConsumed.
  quotedCode?: string | null;
  onQuotedCodeConsumed?: () => void;
}

// Suggested questions on first open. No bordered cards, no bg fills —
// just a quiet list of italic prompts under a small label, like the
// "you might also like" footer of a printed essay.
function SuggestedQuestions({ reviewFocus, onSelect }: { reviewFocus: string | null; onSelect: (q: string) => void }) {
  const suggestions = buildSuggestions(reviewFocus);
  if (suggestions.length === 0) return null;

  return (
    <div className="flex-1 flex flex-col items-start justify-center gap-4 px-2 max-w-md">
      <p className="slide-meta">Try asking</p>
      <ul className="flex flex-col gap-3 w-full">
        {suggestions.map((q, i) => (
          <li key={i}>
            <button
              onClick={() => onSelect(q)}
              className="text-left font-serif text-base leading-snug text-foreground/75 hover:text-foreground italic transition-colors"
            >
              &ldquo;{q}&rdquo;
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function buildSuggestions(reviewFocus: string | null): string[] {
  const suggestions: string[] = [];
  const lower = (reviewFocus ?? '').toLowerCase();

  if (lower.includes('error') || lower.includes('edge case') || lower.includes('validation')) {
    suggestions.push('What edge cases could break this code?');
  }
  if (lower.includes('performance') || lower.includes('scaling')) {
    suggestions.push('Are there any performance concerns here?');
  }
  if (lower.includes('security') || lower.includes('auth')) {
    suggestions.push('Are there security implications to review?');
  }

  suggestions.push('Why were these changes made this way?');
  if (suggestions.length < 3) {
    suggestions.push('What could go wrong with this approach?');
  }

  return suggestions.slice(0, 3);
}

// Message — no bubble, no bg fill. User questions are a small mono
// "You · " label followed by the question as quoted serif italic.
// Assistant replies are plain prose. Tool calls are quiet inline
// margin notes, not glowing pills.
function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="slide-meta">You</span>
        <p className="font-serif text-base leading-snug text-foreground italic">&ldquo;{message.content}&rdquo;</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="slide-meta">Gnosis</span>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {message.toolCalls.map((tool) => (
            <li key={tool} className="slide-meta opacity-70">
              · {tool}
            </li>
          ))}
        </ul>
      )}
      {message.content ? (
        <Markdown className="text-sm text-foreground/85 leading-relaxed">{message.content}</Markdown>
      ) : message.isStreaming ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : null}
      {message.isStreaming && message.content && (
        <span className="inline-block w-px h-4 bg-foreground/40 align-text-bottom" />
      )}
    </div>
  );
}

export function SlideChatSheet({
  open,
  onOpenChange,
  slideTitle,
  reviewFocus,
  messages,
  isStreaming,
  onSend,
  quotedCode,
  onQuotedCodeConsumed,
}: Props) {
  const [input, setInput] = useState('');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const didDrag = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Drag-to-resize: attach to window so dragging works even if cursor leaves the handle
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      didDrag.current = true;
      const newWidth = window.innerWidth - e.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth)));
    }
    function onMouseUp() {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function handleHandleMouseDown(e: React.MouseEvent) {
    if (!open) return; // only resize when open
    e.preventDefault();
    dragging.current = true;
    didDrag.current = false;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleHandleClick() {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    onOpenChange(!open);
  }

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    // If there's quoted code from a selection, prepend it as a fenced
    // code block so the AI knows exactly which code the user is asking
    // about. Clear the quote after sending so it doesn't persist.
    const message = quotedCode
      ? `Regarding this code:\n\`\`\`\n${quotedCode}\n\`\`\`\n\n${trimmed}`
      : trimmed;
    setInput('');
    onQuotedCodeConsumed?.();
    onSend(message);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="shrink-0 flex flex-row h-full">
      {/* Handle / toggle bar — hairline divider, no fill. */}
      <button
        type="button"
        onMouseDown={handleHandleMouseDown}
        onClick={handleHandleClick}
        className={`group relative flex items-center justify-center w-4 border-l border-border hover:bg-muted/30 transition-colors ${open ? 'cursor-col-resize' : 'cursor-pointer'}`}
        aria-label={open ? 'Collapse chat panel' : 'Expand chat panel'}
      >
        {open ? (
          <div className="flex flex-col gap-1 opacity-30 group-hover:opacity-60 transition-opacity">
            <div className="w-px h-1 bg-foreground" />
            <div className="w-px h-1 bg-foreground" />
            <div className="w-px h-1 bg-foreground" />
          </div>
        ) : (
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        )}
      </button>

      {/* Panel content */}
      <div
        className="overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: open ? width : 0 }}
      >
        <div className="h-full flex flex-col bg-background" style={{ minWidth: width }}>
          {/* Header — editorial heading + slide context as
              meta. Reads like the running header of an essay. */}
          <div className="border-b border-border px-6 py-4">
            <h3 className="editorial-heading text-base">Ask about this slide</h3>
            <p className="slide-meta truncate mt-0.5">{slideTitle}</p>
          </div>

          {/* Message list */}
          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-6 flex flex-col gap-7">
            {messages.length === 0 ? (
              <SuggestedQuestions reviewFocus={reviewFocus} onSelect={(q) => onSend(q)} />
            ) : (
              <>
                {messages.map((msg) => (
                  <Message key={msg.id} message={msg} />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input area — bottom-bordered textarea, no rounded
              fill. Send button is a quiet icon, not a primary CTA.
              When quoted code is attached from a selection, a quiet
              preview sits above the input so the user sees what's
              going to be sent. */}
          <div className="border-t border-border px-6 py-4 flex flex-col gap-2">
            {quotedCode && (
              <div className="flex items-start gap-2 text-xs animate-fade-in">
                <pre className="flex-1 font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap break-all">
                  {quotedCode.length > 200 ? quotedCode.slice(0, 200) + '…' : quotedCode}
                </pre>
                <button
                  onClick={() => onQuotedCodeConsumed?.()}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-1"
                  aria-label="Remove quoted code"
                >
                  ×
                </button>
              </div>
            )}
            <div className="flex gap-3 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question about this slide…"
              rows={2}
              className="flex-1 resize-none bg-transparent border-0 border-b border-border px-0 py-2 text-sm placeholder:text-muted-foreground/60 transition-colors"
            />
            <button
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
              className="shrink-0 p-2 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
              aria-label="Send"
            >
              {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
