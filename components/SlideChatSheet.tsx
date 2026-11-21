import { useSessionDraft } from '../lib/session-drafts';
import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { WorkbenchIcon } from './WorkbenchIcon';
import { ChatPanel } from './ChatPanel';
import { chatSuggestions } from '../lib/chat-context';
import { ChatComposerFallback, ChatConversationFallback, LazyChatComposer, LazyChatConversation } from './chat-lazy';
import type { ChatModelChoice } from '@/lib/chat-preferences';
import type { ChatCitationSource } from './ChatCitation';
import type { ChatMessage } from '@/lib/use-slide-chat';
import type { ChatTraceStep } from '@/lib/chat-trace';

const MIN_WIDTH = 300;
const MAX_WIDTH = 700;
const DEFAULT_WIDTH = 460;

interface Props {
  embedded?: boolean;
  open: boolean;
  focusRequest?: number;
  onOpenChange: (open: boolean) => void;
  slideTitle: string;
  slideId?: string;
  reviewFocus: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSend: (text: string, selection?: string) => void;
  onRetry?: (assistantId: string) => void;
  onStop?: () => void;
  onOpenTraceStep?: (step: ChatTraceStep) => void;
  /** The PR's files, for citations in answers. */
  citations?: ChatCitationSource;
  /** The model the next question goes to, chosen in the prompt input. */
  model?: ChatModelChoice;
  onModelChange?: (choice: ChatModelChoice) => void;
  // When the user selects code in the diff and clicks "Ask about
  // this", the selected code is passed here as a fenced code block.
  // The chat sheet renders it as a quoted block above the input and
  // includes it in the message when the user sends. Cleared after
  // first send via onQuotedCodeConsumed.
  quotedCode?: string | null;
  onQuotedCodeConsumed?: () => void;
  /** Code selected in an answer's diff: it becomes the quoted code. */
  onQuoteSelection?: (code: string) => void;
}

// Suggested questions remain compact, readable actions.
function SuggestedQuestions({
  reviewFocus,
  slideTitle,
  selection,
  onSelect,
  disabled,
}: {
  reviewFocus: string | null;
  slideTitle: string;
  selection: boolean;
  onSelect: (q: string) => void;
  disabled: boolean;
}) {
  const suggestions = chatSuggestions({ title: slideTitle, focus: reviewFocus, selection });
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-col items-start gap-3">
      <ul className="flex flex-col gap-3 w-full" aria-label="Suggested questions">
        {suggestions.map((q, i) => (
          <li key={i}>
            <button
              disabled={disabled}
              onClick={() => onSelect(q)}
              className="chat-suggestion transition-colors disabled:opacity-50"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SlideChatSheet({
  embedded = false,
  open,
  focusRequest,
  onOpenChange,
  slideTitle,
  slideId,
  reviewFocus,
  messages,
  isStreaming,
  onSend,
  onRetry,
  onStop,
  onOpenTraceStep,
  model,
  onModelChange,
  citations,
  quotedCode,
  onQuotedCodeConsumed,
  onQuoteSelection,
}: Props) {
  const [input, setInput] = useSessionDraft(`chat-input:${slideId ?? slideTitle}`, '');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef<{ id: number; target: HTMLButtonElement; cursor: string; select: string } | null>(null);
  const didDrag = useRef(false);

  // A focus request waits for the composer when it is still loading (components/chat-lazy.tsx).
  const focusPending = useRef(false);
  const focusComposer = useCallback(() => {
    const target = textareaRef.current;
    if (!target) return;
    focusPending.current = false;
    const topDialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
      .filter((dialog) => dialog.checkVisibility())
      .at(-1);
    // A palette opened during the sheet animation owns keyboard focus now.
    if (!topDialog || topDialog.contains(target)) target.focus();
  }, []);
  useEffect(() => {
    if (open) {
      focusPending.current = true;
      const timer = setTimeout(focusComposer, 300);
      return () => clearTimeout(timer);
    }
  }, [open, focusRequest, focusComposer]);

  const finishResize = useCallback(() => {
    const drag = dragging.current;
    if (!drag) return;
    dragging.current = null;
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = drag.select;
    if (drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
  }, []);

  const cancelResize = useCallback(() => {
    if (dragging.current) didDrag.current = true;
    finishResize();
  }, [finishResize]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current || event.pointerId !== dragging.current.id) return;
      if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
        cancelResize();
        return;
      }
      didDrag.current = true;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - event.clientX)));
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId === dragging.current?.id) finishResize();
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === dragging.current?.id) cancelResize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancelResize);
    return () => {
      finishResize();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancelResize);
    };
  }, [finishResize, cancelResize]);

  function handleHandlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!open || !event.isPrimary || event.button !== 0 || dragging.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = {
      id: event.pointerId,
      target: event.currentTarget,
      cursor: document.body.style.cursor,
      select: document.body.style.userSelect,
    };
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

  function handleSend(text = input) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    onQuotedCodeConsumed?.();
    onSend(trimmed, quotedCode ?? undefined);
  }

  const panel = (
    <ChatPanel
      className={embedded ? 'chat-sheet' : ''}
      contained={!embedded}
      surface="topic"
      label="Ask about this topic"
      context={slideTitle}
      contextTitle={slideTitle}
      onClose={() => onOpenChange(false)}
    >
      <Suspense fallback={<ChatConversationFallback />}>
        <LazyChatConversation
          conversationId={slideId ?? slideTitle}
          messages={messages}
          busy={isStreaming}
          onRetry={onRetry}
          onOpenTraceStep={onOpenTraceStep}
          citations={citations}
          onAskAboutSelection={
            onQuoteSelection &&
            ((code) => {
              onQuoteSelection(code);
              focusComposer();
            })
          }
          empty={
            <SuggestedQuestions
              slideTitle={slideTitle}
              selection={!!quotedCode}
              reviewFocus={reviewFocus}
              onSelect={handleSend}
              disabled={isStreaming}
            />
          }
        />
      </Suspense>
      <Suspense fallback={<ChatComposerFallback />}>
        <LazyChatComposer
          value={input}
          onChange={setInput}
          onSend={() => handleSend()}
          busy={isStreaming}
          onStop={messages.some((message) => message.isStreaming) ? onStop : undefined}
          model={model}
          onModelChange={onModelChange}
          label="Question about this topic"
          quote={quotedCode}
          onRemoveQuote={onQuotedCodeConsumed}
          textareaRef={textareaRef}
          onReady={() => {
            if (focusPending.current) focusComposer();
          }}
        />
      </Suspense>
    </ChatPanel>
  );
  if (embedded) return open ? panel : null;

  return (
    <div className="chat-sheet shrink-0 flex flex-row h-full" data-open={open}>
      {/* Handle / toggle bar — hairline divider, no fill. */}
      <button
        type="button"
        onPointerDown={handleHandlePointerDown}
        onLostPointerCapture={cancelResize}
        onKeyDown={(event) => {
          if (!open || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          setWidth((current) =>
            Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current + (event.key === 'ArrowLeft' ? 40 : -40)))
          );
        }}
        aria-expanded={open}
        aria-description="Drag to resize, or use Left and Right arrow keys. Activate to collapse or expand."
        style={{ touchAction: 'none' }}
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
          <WorkbenchIcon name="chat" className="text-muted-foreground group-hover:text-foreground transition-colors" />
        )}
      </button>

      {/* Panel content */}
      <div
        inert={!open}
        className="overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: open ? width : 0, maxWidth: 'calc(100vw - 1rem)' }}
      >
        {panel}
      </div>
    </div>
  );
}
