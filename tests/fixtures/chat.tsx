import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { PrFileChat } from '../../components/PrFileChat';
import { useSlideChat } from '../../lib/use-slide-chat';
import { DEFAULT_CLAUDE_MODEL } from '../../lib/models';
import { rememberChatModel, rememberedChatModel } from '../../lib/chat-preferences';
import { hunkNewLines, hunkNewRange } from '../../lib/chat-citations';
import type { ChatCitationSource } from '../../components/ChatCitation';
import type { Preferences, ReviewGuide } from '../../lib/types';
import '../../src/globals.css';
import { createClaudeEventHandler } from '../../lib/providers/claude-events';
import { toolCallStep, toolResultStep, type ChatTraceStep } from '../../lib/chat-trace';
const opened: ChatTraceStep[] = [];
let toolCalls = 0;
const claudeEvents = createClaudeEventHandler({
  onToolCall: (call) =>
    (window as unknown as { chatFixture: { trace: (s: ChatTraceStep[]) => void } }).chatFixture.trace([
      toolCallStep(call, toolCalls++),
    ]),
  onToolResult: (result) =>
    (window as unknown as { chatFixture: { trace: (s: Partial<ChatTraceStep>[]) => void } }).chatFixture.trace([
      toolResultStep(result),
    ]),
});
const traceListeners = new Set<(event: { requestId?: string; steps: ChatTraceStep[] }) => void>();
const fileListeners = new Set<(event: { requestId: string; chunk: string }) => void>();
let progress: ((chunk: string) => void) | undefined;
let finish: ((content: string) => void) | undefined;
let fail: ((error: Error) => void) | undefined;
let requestId = '';
let kind = '';
const requests: unknown[] = [];
// Preferences the chat writes (model choices, panel widths), kept as the main process would keep them.
let stored = {} as Preferences;
const api: Partial<Window['electronAPI']> = {
  // Chat's Markdown loads lazily, after this API is installed, and reads the saved preferences: none are saved here.
  loadPreferences: () => Promise.resolve(structuredClone(stored)),
  // Chat writes only its own fields, through main's narrow write.
  saveChatPreferences: (patch) => {
    stored = { ...stored, ...structuredClone(patch) };
    return Promise.resolve();
  },
  savePreferences: (next) => {
    stored = structuredClone(next);
    return Promise.resolve();
  },
  onChatProgress: (callback) => {
    progress = callback;
  },
  offChatProgress: () => {
    progress = undefined;
  },
  onChatTrace: (callback) => {
    traceListeners.add(callback);
    return () => traceListeners.delete(callback);
  },
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
    preferences: () => stored,
    chunk(text: string) {
      if (kind === 'topic') progress?.(text);
      else for (const listener of fileListeners) listener({ requestId, chunk: text });
    },
    finish(text: string) {
      finish?.(text);
    },
    /** Replays trace steps as the main process sends them for the active request. */
    trace(steps: Partial<ChatTraceStep>[]) {
      for (const listener of traceListeners) listener({ requestId, steps: steps as ChatTraceStep[] });
    },
    /** Replays a recorded Claude stream-json line through the real parser. */
    claudeLine(line: string) {
      claudeEvents.processLine(line);
    },
    opened,
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
      diffHunks: [
        {
          filePath: 'src/queue.ts',
          hunkHeader: '@@ -38,6 +40,81 @@',
          content: '+await queue.dispatch(command);\n+await worker.acknowledge(command.id);\n return command.result;',
          language: 'ts',
          renderedHtml: '',
        },
        {
          filePath: 'src/worker.ts',
          hunkHeader: '@@ -10,4 +10,5 @@',
          content: '+worker.acknowledge(id);',
          language: 'ts',
          renderedHtml: '',
        },
      ],
      reviewFocus: null,
    },
  ],
  summary: 'Keeps queue order across worker restarts.',
  prDescription: '',
  prTitle: 'Preserve queue order',
} as unknown as ReviewGuide;
// Citations resolve to the fixture PR's two files, preview the topic's hunks, and record where a click opens.
const citedLines = new Map<string, Map<number, string>>();
for (const hunk of review.slides[0].diffHunks)
  citedLines.set(hunk.filePath, hunkNewLines(hunk.hunkHeader, hunk.content));
const citations: ChatCitationSource = {
  files: ['src/queue.ts', 'src/worker.ts'],
  bounds: (path) => {
    const hunk = review.slides[0].diffHunks.find((h) => h.filePath === path);
    const range = hunk && hunkNewRange(hunk.hunkHeader);
    return range ? { ranges: [range] } : undefined;
  },
  preview: (path, start, end) => {
    const lines = Array.from({ length: end - start + 1 }, (_, i) => citedLines.get(path)?.get(start + i));
    return lines.every((line) => line === undefined) ? undefined : lines.map((line) => line ?? '').join('\n');
  },
  open: (target) => opened.push({ id: 'citation', source: 'context', kind: 'file', label: target.path, ...target }),
};
function Fixture() {
  const [mode, setMode] = useState('topic');
  const [file, setFile] = useState('src/queue.ts');
  const [quote, setQuote] = useState<string | null>('await queue.dispatch(command);');
  const [topicModel, setTopicModel] = useState(() => rememberedChatModel(stored, 'topic'));
  const chat = useSlideChat(review, topicModel.provider, topicModel.model);
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
            onSend={(text, selection) => void chat.send(1, text, selection)}
            onRetry={(id) => void chat.retry(1, id)}
            onStop={() => chat.stop(1)}
            onOpenTraceStep={(step) => opened.push(step)}
            model={topicModel}
            onModelChange={(choice) => {
              setTopicModel(choice);
              void rememberChatModel('topic', choice);
            }}
            citations={citations}
            quotedCode={quote}
            onQuotedCodeConsumed={() => setQuote(null)}
            onQuoteSelection={setQuote}
          />
        ) : (
          <PrFileChat
            request={{ url: review.prUrl, path: file, baseSha: 'abc123456', headSha: 'def456789' }}
            preferences={{ provider: 'claude', model: DEFAULT_CLAUDE_MODEL } as Preferences}
            selection="return command.result;"
            onClose={() => setMode('topic')}
            onOpenTraceStep={(step) => opened.push(step)}
            citations={citations}
          />
        )}
      </div>
      <style>{`#chat-surface > .chat-panel {width:100%;max-width:100%;height:100%;border-left:0;} @media(max-width:700px){#chat-surface > .chat-panel {position:static;}}`}</style>
    </main>
  );
}
const container = document.getElementById('root');
if (container) createRoot(container).render(<Fixture />);
