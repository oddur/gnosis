import { chatQuestion } from './chat-context';
import { useSyncExternalStore } from 'react';
import type { FileChatRequest } from './pr-changes';
import type { ChatMessage } from './use-slide-chat';
type FileMessage = ChatMessage & { selection?: string };
interface Session {
  messages: FileMessage[];
  busy: boolean;
  error: string;
}
const sessions = new Map<string, Session>();
const runs = new Map<string, { requestId: string; stopped: boolean }>();
const listeners = new Set<() => void>();
const storage = (key: string) => `gnosis-file-chat:v1:${key}`;
function get(key: string): Session {
  let value = sessions.get(key);
  if (!value) {
    let messages: FileMessage[] = [];
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storage(key)) ?? '[]');
      if (Array.isArray(saved))
        messages = saved.flatMap((entry: unknown): FileMessage[] => {
          if (
            !entry ||
            typeof entry !== 'object' ||
            !('content' in entry) ||
            typeof entry.content !== 'string' ||
            !('role' in entry) ||
            (entry.role !== 'user' && entry.role !== 'assistant')
          )
            return [];
          return [
            {
              id: 'id' in entry && typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
              role: entry.role,
              content: entry.content,
              selection: 'selection' in entry && typeof entry.selection === 'string' ? entry.selection : undefined,
              error: 'error' in entry && typeof entry.error === 'string' ? entry.error : undefined,
              stopped:
                ('isStreaming' in entry && entry.isStreaming === true) ||
                ('stopped' in entry && entry.stopped === true),
            },
          ];
        });
    } catch {
      /* Optional saved conversation. */
    }
    value = { messages, busy: false, error: '' };
    sessions.set(key, value);
  }
  return value;
}
function update(key: string, value: Session, persist = true) {
  sessions.set(key, value);
  if (persist)
    try {
      localStorage.setItem(storage(key), JSON.stringify(value.messages));
    } catch {
      /* Keep session in memory. */
    }
  listeners.forEach((fn) => fn());
}
async function send(key: string, request: Omit<FileChatRequest, 'history'>, retryId?: string) {
  const before = get(key);
  if (before.busy) return false;
  if (
    retryId &&
    (before.messages.at(-1)?.id !== retryId || !(before.messages.at(-1)?.error || before.messages.at(-1)?.stopped))
  )
    return false;
  const run = { requestId: crypto.randomUUID(), stopped: false };
  runs.set(key, run);
  const assistant: FileMessage = {
    id: retryId ?? crypto.randomUUID(),
    role: 'assistant',
    content: '',
    isStreaming: true,
  };
  const messages: FileMessage[] = retryId
    ? [...before.messages.slice(0, -1), assistant]
    : [
        ...before.messages,
        { id: crypto.randomUUID(), role: 'user', content: request.question, selection: request.selection },
        assistant,
      ];
  const patch = (value: Partial<FileMessage>, busy: boolean, persist = true) =>
    update(
      key,
      {
        messages: get(key).messages.map((m) => (m.id === assistant.id ? { ...m, ...value } : m)),
        busy,
        error: value.error ?? '',
      },
      persist
    );
  update(key, { messages, busy: true, error: '' });
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = // Older browser fixtures predate streaming; production preload always supplies this.
      (window.electronAPI as Partial<Window['electronAPI']>).onFileChatProgress?.((event) => {
        if (event.requestId !== run.requestId || run.stopped) return;
        const current = get(key).messages.find((m) => m.id === assistant.id);
        patch({ content: (current?.content ?? '') + event.chunk }, true, false);
      });
    const history = before.messages
      .filter(
        (m, i) =>
          !m.isStreaming && !m.error && !m.stopped && !before.messages[i + 1]?.error && !before.messages[i + 1]?.stopped
      )
      .map((m) => ({ role: m.role, content: chatQuestion(m.content, m.selection) }));
    const content = await window.electronAPI.askPrFile({ ...request, requestId: run.requestId, history });
    if (!run.stopped) patch({ content, isStreaming: false }, false);
    return !run.stopped;
  } catch (error) {
    if (error instanceof Error && error.message.includes('GNOSIS_CANCELLED')) run.stopped = true;
    if (!run.stopped)
      patch({ isStreaming: false, error: error instanceof Error ? error.message : String(error) }, false);
    return false;
  } finally {
    unsubscribe?.();
    if (run.stopped) patch({ isStreaming: false, stopped: true }, false);
    runs.delete(key);
  }
}
export function useFileChat(key: string) {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => get(key)
  );
  return {
    ...state,
    send: (request: Omit<FileChatRequest, 'history'>) => send(key, request),
    retry: (request: Omit<FileChatRequest, 'history' | 'question' | 'selection'>, id: string) => {
      const question = get(key).messages.at(-2);
      if (question?.role === 'user')
        return send(key, { ...request, question: question.content, selection: question.selection }, id);
      return Promise.resolve(false);
    },
    stop: () => {
      const run = runs.get(key);
      if (!run || run.stopped) return;
      run.stopped = true;
      void window.electronAPI.cancelChat(run.requestId).catch(() => {
        run.stopped = false;
      });
    },
  };
}
