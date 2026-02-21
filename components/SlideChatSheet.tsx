import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import type { ChatMessage } from '@/lib/use-slide-chat';

const MIN_WIDTH = 300;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 420;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slideTitle: string;
  reviewFocus: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (text: string) => void;
}

function SuggestedQuestions({ reviewFocus, onSelect }: { reviewFocus: string; onSelect: (q: string) => void }) {
  const suggestions = buildSuggestions(reviewFocus);
  if (suggestions.length === 0) return null;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4">
      <p className="text-sm text-muted-foreground">Suggested questions:</p>
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {suggestions.map((q, i) => (
          <button
            key={i}
            onClick={() => onSelect(q)}
            className="text-left text-sm px-3 py-2 rounded-md border border-border hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function buildSuggestions(reviewFocus: string): string[] {
  const suggestions: string[] = [];
  const lower = reviewFocus.toLowerCase();

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

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 max-w-[85%] text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="bg-muted rounded-lg px-3 py-2 max-w-[85%] text-sm">
        {message.content ? (
          <Markdown className="chat-response">{message.content}</Markdown>
        ) : message.isStreaming ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : null}
        {message.isStreaming && message.content && (
          <span className="inline-block w-1.5 h-4 bg-foreground/50 animate-pulse ml-0.5 align-text-bottom" />
        )}
      </div>
    </div>
  );
}

export function SlideChatSheet({ open, onOpenChange, slideTitle, reviewFocus, messages, isStreaming, onSend }: Props) {
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
    // If we just finished a drag, don't toggle
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    onOpenChange(!open);
  }

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    onSend(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="shrink-0 flex flex-row h-full">
      {/* Handle / toggle bar */}
      <button
        type="button"
        onMouseDown={handleHandleMouseDown}
        onClick={handleHandleClick}
        className={`group relative flex items-center justify-center w-5 border-l border-border bg-muted/30 hover:bg-muted/60 transition-colors ${open ? 'cursor-col-resize' : 'cursor-pointer'}`}
        aria-label={open ? 'Collapse chat panel' : 'Expand chat panel'}
      >
        {/* Grip dots when open, chat icon when collapsed */}
        {open ? (
          <div className="flex flex-col gap-1 opacity-40 group-hover:opacity-70 transition-opacity">
            <div className="w-1 h-1 rounded-full bg-foreground" />
            <div className="w-1 h-1 rounded-full bg-foreground" />
            <div className="w-1 h-1 rounded-full bg-foreground" />
          </div>
        ) : (
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
        )}
      </button>

      {/* Panel content */}
      <div className="overflow-hidden transition-[width] duration-300 ease-in-out" style={{ width: open ? width : 0 }}>
        <div className="h-full flex flex-col bg-background" style={{ minWidth: width }}>
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Ask about this slide</h3>
              <p className="text-xs text-muted-foreground truncate">{slideTitle}</p>
            </div>
          </div>

          {/* Message list */}
          <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-3">
            {messages.length === 0 ? (
              <SuggestedQuestions
                reviewFocus={reviewFocus}
                onSelect={(q) => {
                  onSend(q);
                }}
              />
            ) : (
              <>
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input area */}
          <div className="border-t p-4 flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question about this slide..."
              rows={2}
              className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <Button size="sm" onClick={handleSend} disabled={isStreaming || !input.trim()} className="shrink-0">
              {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
