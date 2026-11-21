import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { TextSelect, X } from 'lucide-react';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from './ai-elements/prompt-input';
import { ModelSelector, modelSelectorValue } from './ai-elements/model-selector';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from './ui/attachment';
import { Tooltip, TooltipProvider, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { chatModelLabel, chatModelOptions, type ChatModelChoice } from '../lib/chat-preferences';
import { chatSelectionLabel, chatSelectionLineCount, parseChatSelection } from '../lib/chat-selection';
import type { ModelId, Provider } from '../lib/models';

const MODEL_GROUPS = chatModelOptions().map((group) => ({
  id: group.provider,
  label: group.label,
  models: group.models,
}));

/** The selected code waiting to go with the next question: its file and lines, and the code on request. */
function SelectionChip({ quote, path, onRemove }: { quote: string; path?: string; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const preview = useId();
  const selection = parseChatSelection(quote);
  const label = chatSelectionLabel(selection, path);
  const lines = chatSelectionLineCount(selection);
  const where = selection.path ?? path;
  return (
    <div className="chat-selection">
      <Attachment
        size="xs"
        className="chat-selection-chip"
        data-open={open || undefined}
        data-located={where && selection.startLine ? '' : undefined}
      >
        <AttachmentMedia>
          <TextSelect aria-hidden="true" />
        </AttachmentMedia>
        <AttachmentContent>
          <button
            type="button"
            className="chat-selection-toggle"
            aria-expanded={open}
            aria-controls={preview}
            aria-label={`Selected code: ${label}, ${lines} ${lines === 1 ? 'line' : 'lines'}. ${open ? 'Hide' : 'Show'} the code`}
            title={where ?? undefined}
            onClick={() => setOpen((value) => !value)}
          >
            <AttachmentTitle>{label}</AttachmentTitle>
            {/* A located chip's range already counts its lines; it only says when the code is the old version. */}
            {selection.startLine ? (
              selection.side === 'before' && <AttachmentDescription>old code</AttachmentDescription>
            ) : (
              <AttachmentDescription>
                {lines} {lines === 1 ? 'line' : 'lines'}
              </AttachmentDescription>
            )}
          </button>
        </AttachmentContent>
        {onRemove && (
          <AttachmentActions>
            <AttachmentAction aria-label="Remove selected code" title="Remove selected code" onClick={onRemove}>
              <X aria-hidden="true" />
            </AttachmentAction>
          </AttachmentActions>
        )}
      </Attachment>
      <pre id={preview} className="chat-selection-code" hidden={!open}>
        {selection.code}
      </pre>
    </div>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  busy,
  onStop,
  label,
  model,
  onModelChange,
  quote,
  quotePath,
  onRemoveQuote,
  textareaRef,
  id,
  onReady,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  onStop?: () => void;
  label: string;
  /** The model the next question goes to. Without onModelChange it shows as a label. */
  model?: ChatModelChoice;
  onModelChange?: (choice: ChatModelChoice) => void;
  quote?: string | null;
  /** The file a selection without its own path came from. */
  quotePath?: string;
  onRemoveQuote?: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  id?: string;
  /** Runs once the composer has mounted: it loads with the chat, after the panel opens. */
  onReady?: () => void;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  const ready = useRef(onReady);
  useEffect(() => ready.current?.(), []);
  const status = busy ? (onStop ? 'streaming' : 'busy') : 'ready';
  return (
    <TooltipProvider delayDuration={350}>
      <PromptInput
        className="chat-composer"
        onSubmit={() => {
          if (value.trim() && !busy) onSend();
        }}
      >
        {quote && (
          <PromptInputHeader>
            <SelectionChip quote={quote} path={quotePath} onRemove={onRemoveQuote} />
          </PromptInputHeader>
        )}
        <PromptInputTextarea
          textareaRef={ref}
          id={id}
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={label + '…'}
          aria-description="Enter to send. Shift+Enter for a new line."
          maxLength={20000}
          dir="auto"
        />
        <PromptInputFooter>
          <PromptInputTools>
            {model && onModelChange ? (
              <ModelSelector
                groups={MODEL_GROUPS}
                value={modelSelectorValue(model.provider, model.model)}
                onValueChange={(provider, next) =>
                  onModelChange({ provider: provider as Provider, model: next as ModelId })
                }
              />
            ) : (
              <span className="chat-model" title={model ? chatModelLabel(model) : undefined}>
                {model ? chatModelLabel(model) : 'Ask a follow-up'}
              </span>
            )}
          </PromptInputTools>
          <span className="chat-key-hint" title="Enter to send · Shift+Enter for a new line">
            {busy ? 'Draft while answering' : 'Shift+Enter for a new line'}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="chat-submit-slot">
                <PromptInputSubmit
                  status={status}
                  disabled={!value.trim()}
                  onStop={onStop}
                  sendLabel="Send question"
                  stopLabel="Stop answer"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {status === 'streaming'
                ? 'Stop answer'
                : status === 'busy'
                  ? 'Another answer is in progress'
                  : 'Send question (Enter)'}
            </TooltipContent>
          </Tooltip>
        </PromptInputFooter>
      </PromptInput>
    </TooltipProvider>
  );
}
