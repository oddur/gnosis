import { Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { chatSuggestions } from '../lib/chat-context';
import { CommitBadge } from './EntityBadge';
import { useSessionDraft } from '../lib/session-drafts';
import { ChatPanel } from './ChatPanel';
import { ChatComposerFallback, ChatConversationFallback, LazyChatComposer, LazyChatConversation } from './chat-lazy';
import { rememberChatModel, rememberedChatModel } from '../lib/chat-preferences';
import { useFileChat } from '../lib/use-file-chat';
import { fileRevisionKey, type PrFileRequest } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
import type { ChatTraceStep } from '../lib/chat-trace';
import type { ChatCitationSource } from './ChatCitation';
export function PrFileChat(props: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  focusRequest?: number;
  onClose: () => void;
  onOpenTraceStep?: (step: ChatTraceStep) => void;
  /** The PR's files, for citations in answers. */
  citations?: ChatCitationSource;
}) {
  const { request } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  // The composer loads with the chat (components/chat-lazy.tsx): a focus request made before it mounts waits for it.
  const focusPending = useRef(false);
  const focusComposer = useCallback(() => {
    const input = textareaRef.current;
    if (!input) return;
    focusPending.current = false;
    const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
      .filter((element) => element.checkVisibility())
      .at(-1);
    if (!dialog || dialog.contains(input)) input.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const active = document.activeElement;
    // Focus returns where the reader was; a selection's transient Ask button is not such a place.
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !active.closest('.changes-chat, .review-selection-actions')
    )
      origin.current = active;
    focusPending.current = true;
    focusComposer();
  }, [props.focusRequest, focusComposer]);
  const close = () => {
    props.onClose();
    requestAnimationFrame(() => {
      if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    });
  };
  const key = `${request.stackComparison ? `stack:${request.stackComparison}:` : request.comparison ? 'commit:' : ''}${fileRevisionKey(request.url, request.path, request.baseSha, request.headSha)}`;
  // A revision owns its composer and async draft updates, even during file navigation.
  return (
    <FileConversation
      key={key}
      {...props}
      onClose={close}
      conversationId={key}
      textareaRef={textareaRef}
      onComposerReady={() => {
        if (focusPending.current) focusComposer();
      }}
    />
  );
}
function FileConversation({
  request,
  preferences,
  selection,
  onClose,
  onOpenTraceStep,
  citations,
  conversationId,
  textareaRef,
  onComposerReady,
}: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  onClose: () => void;
  onOpenTraceStep?: (step: ChatTraceStep) => void;
  citations?: ChatCitationSource;
  conversationId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onComposerReady: () => void;
}) {
  const chat = useFileChat(conversationId);
  const [question, setQuestion] = useSessionDraft(`file-question:${conversationId}`, '');
  const [dismissedSelection, setDismissedSelection] = useState<string | null>(null);
  // Code selected in an answer's diff replaces the selection from Changes until it is sent or removed.
  const [answerQuote, setAnswerQuote] = useState('');
  const quote = answerQuote || (selection !== dismissedSelection ? selection : '');
  // The model chosen in this surface's prompt input, else the chat model preference (lib/chat-preferences.ts).
  const [model, setModel] = useState(() => rememberedChatModel(preferences, 'file'));
  const context = { ...request, provider: model.provider, model: model.model, effort: preferences.effort };
  const send = (value = question) => {
    if (!value.trim() || chat.busy) return;
    setQuestion('');
    setDismissedSelection(selection);
    setAnswerQuote('');
    void chat.send({ ...context, question: value.trim(), selection: quote });
  };
  return (
    <ChatPanel
      className="changes-chat"
      surface="file"
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
      <Suspense fallback={<ChatConversationFallback />}>
        <LazyChatConversation
          conversationId={conversationId}
          messages={chat.messages}
          busy={chat.busy}
          onRetry={(id) => void chat.retry(context, id)}
          onOpenTraceStep={onOpenTraceStep}
          citations={citations}
          onAskAboutSelection={(code) => {
            setAnswerQuote(code);
            textareaRef.current?.focus({ preventScroll: true });
          }}
          empty={
            <div className="chat-suggestions" role="group" aria-label="Suggested questions">
              {chatSuggestions({ path: request.path, selection: !!quote }).map((text) => (
                <button className="chat-suggestion" key={text} onClick={() => send(text)}>
                  {text}
                </button>
              ))}
            </div>
          }
        />
      </Suspense>
      <Suspense fallback={<ChatComposerFallback />}>
        <LazyChatComposer
          id="changes-question"
          textareaRef={textareaRef}
          value={question}
          onChange={setQuestion}
          onSend={() => send()}
          busy={chat.busy}
          onStop={chat.stop}
          label="Your question"
          quote={quote}
          quotePath={request.path}
          onRemoveQuote={() => {
            if (answerQuote) setAnswerQuote('');
            else setDismissedSelection(selection);
          }}
          model={model}
          onModelChange={(choice) => {
            setModel(choice);
            void rememberChatModel('file', choice).catch(() => {});
          }}
          onReady={onComposerReady}
        />
      </Suspense>
    </ChatPanel>
  );
}
