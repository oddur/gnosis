/**
 * Prompt Input, after shadcn/ui AI Elements (https://ui.shadcn.com/docs/ai-elements/base/prompt-input, MIT): an Input
 * Group with an auto-growing textarea, context chips above it, and a footer holding the model selector and the send
 * button. Styled with Gnosis tokens under `.prompt-input` in globals.css, not the library's defaults.
 *
 * Differences from the pattern: attachments are the code a reviewer selected (never files from disk), and the submit
 * button becomes Stop while an answer streams.
 */
import { useEffect, useRef, type ComponentProps, type RefObject, type SyntheticEvent } from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';

/** `streaming`: this conversation's answer is arriving. `busy`: another conversation's answer is. */
export type PromptInputStatus = 'ready' | 'streaming' | 'busy';

export function PromptInput({
  className,
  onSubmit,
  children,
  ...props
}: Omit<ComponentProps<'form'>, 'onSubmit'> & {
  onSubmit: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => void;
}) {
  return (
    <form
      className={cn('prompt-input', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(event);
      }}
      {...props}
    >
      <InputGroup className="prompt-input-group">{children}</InputGroup>
    </form>
  );
}

/** Context chips above the text: `block-start`, where the pattern places attachments. */
export function PromptInputHeader({ className, ...props }: ComponentProps<'div'>) {
  return <InputGroupAddon align="block-start" className={cn('prompt-input-header', className)} {...props} />;
}

/**
 * Grows with its text up to `maxHeight`, then scrolls. Enter submits the form, Shift+Enter adds a new line, and an
 * Enter that confirms an IME composition does neither.
 */
export function PromptInputTextarea({
  className,
  textareaRef,
  maxHeight = 160,
  onKeyDown,
  value,
  ...props
}: ComponentProps<'textarea'> & { textareaRef?: RefObject<HTMLTextAreaElement | null>; maxHeight?: number }) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(maxHeight, input.scrollHeight)}px`;
  }, [value, ref, maxHeight]);
  return (
    <InputGroupTextarea
      ref={ref}
      value={value}
      rows={1}
      className={cn('prompt-input-textarea', className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }}
      {...props}
    />
  );
}

/** The row under the text: tools at the start, submit at the end. */
export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return <InputGroupAddon align="block-end" className={cn('prompt-input-footer', className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('prompt-input-tools', className)} {...props} />;
}

/** Send while ready; Stop while this conversation's answer streams. */
export function PromptInputSubmit({
  status,
  disabled,
  onStop,
  sendLabel = 'Send',
  stopLabel = 'Stop',
  className,
}: {
  status: PromptInputStatus;
  disabled?: boolean;
  onStop?: () => void;
  sendLabel?: string;
  stopLabel?: string;
  className?: string;
}) {
  if (status === 'streaming' && onStop)
    return (
      <InputGroupButton
        size="icon-sm"
        variant="secondary"
        className={cn('prompt-input-submit', className)}
        aria-label={stopLabel}
        onClick={onStop}
      >
        <SquareIcon size={12} fill="currentColor" aria-hidden="true" />
      </InputGroupButton>
    );
  return (
    <InputGroupButton
      type="submit"
      size="icon-sm"
      variant="default"
      className={cn('prompt-input-submit', className)}
      aria-label={sendLabel}
      disabled={disabled || status !== 'ready'}
    >
      <ArrowUpIcon size={16} aria-hidden="true" />
    </InputGroupButton>
  );
}
