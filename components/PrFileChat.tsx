import { useState } from 'react';
import { X } from 'lucide-react';
import { PROVIDERS } from '../lib/models';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { useFileChat } from '../lib/use-file-chat';
import { fileRevisionKey, type PrFileRequest } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
export function PrFileChat({
  request,
  preferences,
  selection,
  onClose,
}: {
  request: PrFileRequest;
  preferences: Preferences;
  selection: string;
  onClose: () => void;
}) {
  const key = fileRevisionKey(request.url, request.path, request.baseSha, request.headSha);
  const chat = useFileChat(key);
  const [question, setQuestion] = useState('');
  return (
    <aside className="changes-chat" aria-label="Ask about this file">
      <header>
        <strong>Ask about this file</strong>
        <Button variant="ghost" size="icon" aria-label="Close file conversation" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <p className="changes-chat-source">
        {request.path} · {request.headSha.slice(0, 7)}
      </p>
      <div className="changes-chat-messages" aria-live="polite">
        {!chat.messages.length && <p>Ask how this change works, what it affects, or what to check during review.</p>}
        {chat.messages.map((m, i) => (
          <article key={i}>
            <strong>{m.role === 'user' ? 'You' : 'Assistant'}</strong>
            <Markdown>{m.content}</Markdown>
          </article>
        ))}
        {chat.busy && <p role="status">Thinking about this file… You can keep browsing.</p>}
        {chat.error && <p role="alert">{chat.error}</p>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = question.trim();
          if (value && !chat.busy) {
            void chat
              .send({
                ...request,
                question: value,
                selection,
                provider: preferences.provider,
                model: preferences.model,
              })
              .then((sent) => {
                if (sent) setQuestion('');
              });
          }
        }}
      >
        {selection && (
          <details>
            <summary>Selected code</summary>
            <pre>{selection}</pre>
          </details>
        )}
        <label htmlFor="changes-question">Your question</label>
        <textarea
          id="changes-question"
          value={question}
          disabled={chat.busy}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          maxLength={20000}
        />
        <Button size="sm" disabled={chat.busy || !question.trim()} type="submit">
          Ask ·{' '}
          {PROVIDERS[preferences.provider].models.find((m) => m.id === preferences.model)?.label ?? preferences.model}
        </Button>
      </form>
    </aside>
  );
}
