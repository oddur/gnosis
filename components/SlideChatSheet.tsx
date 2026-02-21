import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import type { ChatMessage } from '@/lib/use-slide-chat';

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (open) {
      // Delay focus to allow animation to complete
      const timer = setTimeout(() => textareaRef.current?.focus(), 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex flex-col"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>Ask about this slide</SheetTitle>
          <SheetDescription className="truncate">{slideTitle}</SheetDescription>
        </SheetHeader>

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
      </SheetContent>
    </Sheet>
  );
}
