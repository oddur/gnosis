import { useState } from 'react';
import { CommitBadge } from './EntityBadge';
import { useSessionDraft } from '../lib/session-drafts';
import { X } from 'lucide-react';
import { PROVIDERS } from '../lib/models';
import { Button } from './ui/button';
import { ChatConversation } from './ChatConversation';
import { ChatComposer } from './ChatComposer';
import { useFileChat } from '../lib/use-file-chat';
import { fileRevisionKey, type PrFileRequest } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
export function PrFileChat(props: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  onClose: () => void;
}) {
  const { request } = props;
  const key = `${request.comparison ? 'commit:' : ''}${fileRevisionKey(request.url, request.path, request.baseSha, request.headSha)}`;
  // A revision owns its composer and async draft updates, even during file navigation.
  return <FileConversation key={key} {...props} conversationId={key} />;
}
function FileConversation({
  request,
  preferences,
  selection,
  onClose,
  conversationId,
}: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  onClose: () => void;
  conversationId: string;
}) {
  const chat = useFileChat(conversationId);
  const [question, setQuestion] = useSessionDraft(`file-question:${conversationId}`, '');
  const [dismissedSelection, setDismissedSelection] = useState<string | null>(null);
  const quote = selection !== dismissedSelection ? selection : '';
  const context = { ...request, provider: preferences.provider, model: preferences.model };
  const send = (value = question) => {
    if (!value.trim() || chat.busy) return;
    setQuestion('');
    setDismissedSelection(selection);
    void chat.send({ ...context, question: value.trim(), selection: quote }).then((sent) => {
      if (!sent) setQuestion((current) => current || value);
    });
  };
  return (
    <aside className="changes-chat" aria-label="Ask about this file">
      <header>
        <strong>Ask about this file</strong>
        <Button variant="ghost" size="icon-sm" aria-label="Close file conversation" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <p className="changes-chat-source">
        {request.path} ·{' '}
        {request.comparison && (
          <>
            <CommitBadge sha={request.baseSha} /> →{' '}
          </>
        )}
        <CommitBadge sha={request.headSha} />
      </p>
      <ChatConversation
        conversationId={conversationId}
        messages={chat.messages}
        busy={chat.busy}
        onRetry={(id) => {
          const original = chat.messages.at(-2)?.content;
          if (question === original) setQuestion('');
          void chat.retry(context, id).then((sent) => {
            if (!sent && original) setQuestion((current) => current || original);
          });
        }}
        empty={
          <>
            <p>Ask about this file’s changes.</p>
            <div className="chat-suggestions">
              {['How does this change work?', 'What could break?'].map((text) => (
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
    </aside>
  );
}
