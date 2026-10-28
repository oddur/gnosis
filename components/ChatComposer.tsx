import { useEffect, useRef, type RefObject } from 'react';
import { ArrowUp, Square, X } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from './ui/input-group';
import { Tooltip, TooltipProvider, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function ChatComposer({
  value,
  onChange,
  onSend,
  busy,
  onStop,
  label,
  modelLabel,
  quote,
  onRemoveQuote,
  textareaRef,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  onStop?: () => void;
  label: string;
  modelLabel?: string;
  quote?: string | null;
  onRemoveQuote?: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  id?: string;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  useEffect(() => {
    const input = ref.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    }
  }, [value, ref]);
  return (
    <TooltipProvider delayDuration={350}>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !busy) onSend();
        }}
      >
        <InputGroup>
          {quote && (
            <InputGroupAddon align="block-start" className="chat-quote">
              <details>
                <summary>
                  Selected code · {quote.split('\n').length} {quote.includes('\n') ? 'lines' : 'line'}
                </summary>
                <pre>{quote}</pre>
              </details>
              {onRemoveQuote && (
                <InputGroupButton size="icon-xs" aria-label="Remove quoted code" onClick={onRemoveQuote}>
                  <X size={14} />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            ref={ref}
            id={id}
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={label + '…'}
            rows={2}
            maxLength={20000}
            dir="auto"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              if (value.trim() && !busy) onSend();
            }}
          />
          <InputGroupAddon align="block-end" className="chat-composer-footer">
            <span className="chat-model" title={modelLabel}>
              {modelLabel ?? 'Ask a follow-up'}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                {busy && onStop ? (
                  <InputGroupButton size="icon-sm" aria-label="Stop answer" onClick={onStop}>
                    <Square size={14} fill="currentColor" />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    size="icon-sm"
                    variant="default"
                    type="submit"
                    aria-label="Send question"
                    disabled={busy || !value.trim()}
                  >
                    <ArrowUp size={16} />
                  </InputGroupButton>
                )}
              </TooltipTrigger>
              <TooltipContent>
                {busy ? (onStop ? 'Stop answer' : 'Another answer is in progress') : 'Send question (Enter)'}
              </TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
        <p className="chat-key-hint">
          {busy ? 'You can draft your next question.' : 'Enter to send · Shift+Enter for a new line'}
        </p>
      </form>
    </TooltipProvider>
  );
}
