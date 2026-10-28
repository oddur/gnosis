import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { PrFileChat } from '../../components/PrFileChat';
import { useSlideChat } from '../../lib/use-slide-chat';
import { DEFAULT_CLAUDE_MODEL } from '../../lib/models';
import type { Preferences, ReviewGuide } from '../../lib/types';
import '../../src/globals.css';
const fileListeners = new Set<(event: { requestId: string; chunk: string }) => void>();
let progress: ((chunk: string) => void) | undefined;
let finish: ((content: string) => void) | undefined;
let fail: ((error: Error) => void) | undefined;
let requestId = '';
let kind = '';
const requests: unknown[] = [];
const api: Partial<Window['electronAPI']> = {
  onChatProgress: (callback) => {
    progress = callback;
  },
  offChatProgress: () => {
    progress = undefined;
  },
  onChatToolUse: () => {},
  offChatToolUse: () => {},
  onFileChatProgress: (callback) => {
    fileListeners.add(callback);
    return () => fileListeners.delete(callback);
  },
  sendSlideChat: (request) => {
    kind = 'topic';
    requestId = request.requestId ?? '';
    requests.push(request);
    return new Promise((yes, no) => {
      finish = yes;
      fail = no;
    });
  },
  askPrFile: (request) => {
    kind = 'file';
    requestId = request.requestId ?? '';
    requests.push(request);
    return new Promise((yes, no) => {
      finish = yes;
      fail = no;
    });
  },
  cancelChat: (id) => {
    if (id === requestId) fail?.(Error('Cancelled'));
    return Promise.resolve();
  },
};
Object.assign(window, {
  electronAPI: api,
  chatFixture: {
    requests,
    chunk(text: string) {
      if (kind === 'topic') progress?.(text);
      else for (const listener of fileListeners) listener({ requestId, chunk: text });
    },
    finish(text: string) {
      finish?.(text);
    },
    fail() {
      fail?.(Error('Connection lost. Try again.'));
    },
  },
});
const review = {
  reviewId: 'chat-fixture',
  prUrl: 'https://github.com/test/repo/pull/1',
  slides: [
    {
      id: 'topic-1',
      title: 'Preserve queue order',
      narrative: 'Each worker acknowledges its command.',
      affectedFiles: ['src/queue.ts'],
      diffHunks: [],
      reviewFocus: null,
    },
  ],
  summary: '',
  prDescription: '',
  prTitle: 'Preserve queue order',
} as unknown as ReviewGuide;
function Fixture() {
  const [mode, setMode] = useState('topic');
  const [file, setFile] = useState('src/queue.ts');
  const [quote, setQuote] = useState<string | null>('await queue.dispatch(command);');
  const chat = useSlideChat(review, 'claude', DEFAULT_CLAUDE_MODEL);
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ display: 'flex', gap: 16, padding: 8, fontSize: 13 }}>
        <button onClick={() => setMode(mode === 'topic' ? 'file' : 'topic')}>Switch chat</button>
        <button onClick={() => setFile(file === 'src/queue.ts' ? 'src/worker.ts' : 'src/queue.ts')}>Switch file</button>
      </nav>
      <div
        id="chat-surface"
        style={{
          minHeight: 0,
          flex: 1,
          width: 'min(100%,460px)',
          alignSelf: 'center',
          border: '1px solid var(--border)',
        }}
      >
        {mode === 'topic' ? (
          <SlideChatSheet
            embedded
            open
            onOpenChange={() => {}}
            slideId="topic-1"
            slideTitle="Preserve queue order"
            reviewFocus={null}
            messages={chat.getMessages(1)}
            isStreaming={chat.isStreaming}
            onSend={(text) => void chat.send(1, text)}
            onRetry={(id) => void chat.retry(1, id)}
            onStop={() => chat.stop(1)}
            modelLabel="Claude Opus 5.5"
            quotedCode={quote}
            onQuotedCodeConsumed={() => setQuote(null)}
          />
        ) : (
          <PrFileChat
            request={{ url: review.prUrl, path: file, baseSha: 'abc123456', headSha: 'def456789' }}
            preferences={{ provider: 'claude', model: DEFAULT_CLAUDE_MODEL } as Preferences}
            selection="return command.result;"
            onClose={() => setMode('topic')}
          />
        )}
      </div>
      <style>{`#chat-surface > .changes-chat {width:100%;max-width:100%;height:100%;border-left:0;} @media(max-width:700px){#chat-surface > .changes-chat {position:static;}}`}</style>
    </main>
  );
}
const container = document.getElementById('root');
if (container) createRoot(container).render(<Fixture />);
