import { useEffect, useRef, useState, type RefObject } from 'react';
import { chatSuggestions } from '../lib/chat-context';
import { CommitBadge } from './EntityBadge';
import { useSessionDraft } from '../lib/session-drafts';
import { PROVIDERS } from '../lib/models';
import { ChatPanel } from './ChatPanel';
import { ChatConversation } from './ChatConversation';
import { ChatComposer } from './ChatComposer';
import { useFileChat } from '../lib/use-file-chat';
import { fileRevisionKey, type PrFileRequest } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
export function PrFileChat(props: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  focusRequest?: number;
  onClose: () => void;
}) {
  const { request } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('.changes-chat')) origin.current = active;
    const input = textareaRef.current;
    const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
      .filter((element) => element.checkVisibility())
      .at(-1);
    if (input && (!dialog || dialog.contains(input))) input.focus({ preventScroll: true });
  }, [props.focusRequest]);
  const close = () => {
    props.onClose();
    requestAnimationFrame(() => {
      if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    });
  };
  const key = `${request.stackComparison ? `stack:${request.stackComparison}:` : request.comparison ? 'commit:' : ''}${fileRevisionKey(request.url, request.path, request.baseSha, request.headSha)}`;
  // A revision owns its composer and async draft updates, even during file navigation.
  return <FileConversation key={key} {...props} onClose={close} conversationId={key} textareaRef={textareaRef} />;
}
function FileConversation({
  request,
  preferences,
  selection,
  onClose,
  conversationId,
  textareaRef,
}: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  onClose: () => void;
  conversationId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const chat = useFileChat(conversationId);
  const [question, setQuestion] = useSessionDraft(`file-question:${conversationId}`, '');
  const [dismissedSelection, setDismissedSelection] = useState<string | null>(null);
  const quote = selection !== dismissedSelection ? selection : '';
  const context = { ...request, provider: preferences.provider, model: preferences.model, effort: preferences.effort };
  const send = (value = question) => {
    if (!value.trim() || chat.busy) return;
    setQuestion('');
    setDismissedSelection(selection);
    void chat.send({ ...context, question: value.trim(), selection: quote });
  };
  return (
    <ChatPanel
      className="changes-chat"
      label="Ask about this file"
      onClose={onClose}
      contextTitle={request.path}
      context={
        <>
          {request.path} ·{' '}
          {(request.comparison || request.stackComparison) && (
            <>
              <CommitBadge sha={request.baseSha} /> →{' '}
            </>
          )}
          <CommitBadge sha={request.headSha} />
        </>
      }
    >
      <ChatConversation
        conversationId={conversationId}
        messages={chat.messages}
        busy={chat.busy}
        onRetry={(id) => void chat.retry(context, id)}
        empty={
          <>
            <p>Ask about this file’s changes.</p>
            <div className="chat-suggestions">
              {chatSuggestions({ path: request.path, selection: !!quote }).map((text) => (
                <button className="chat-suggestion" key={text} onClick={() => send(text)}>
                  {text}
                </button>
              ))}
            </div>
          </>
        }
      />
      <ChatComposer
        id="changes-question"
        textareaRef={textareaRef}
        value={question}
        onChange={setQuestion}
        onSend={() => send()}
        busy={chat.busy}
        onStop={chat.stop}
        label="Your question"
        quote={quote}
        onRemoveQuote={() => setDismissedSelection(selection)}
        modelLabel={
          PROVIDERS[preferences.provider].models.find((m) => m.id === preferences.model)?.label ?? preferences.model
        }
      />
    </ChatPanel>
  );
}
