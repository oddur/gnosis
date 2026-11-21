import { chatQuestion } from './chat-context';
import { appendTraceSteps, parseChatTiming, parseChatTrace, settleTrace } from './chat-trace';
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
/** Saved citable lines, kept only when they are well-formed ranges. */
function parseCitable(value: unknown): Record<string, [number, number][]> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  const result: Record<string, [number, number][]> = {};
  for (const [path, ranges] of Object.entries(value))
    if (Array.isArray(ranges))
      result[path] = ranges.filter(
        (r): r is [number, number] => Array.isArray(r) && ok(r[0]) && ok(r[1]) && r[0] <= r[1]
      );
  return result;
}
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
              trace: 'trace' in entry ? parseChatTrace(entry.trace) : undefined,
              timing: 'timing' in entry ? parseChatTiming(entry.timing) : undefined,
              citable: 'citable' in entry ? parseCitable(entry.citable) : undefined,
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
    timing: { sentAt: Date.now() },
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
  // An answer that ends stops its clock and its running tool calls.
  const ended = (status: 'done' | 'error' = 'done'): Partial<FileMessage> => {
    const current = get(key).messages.find((m) => m.id === assistant.id);
    return {
      trace: settleTrace(current?.trace, status),
      ...(current?.timing && !current.timing.doneAt ? { timing: { ...current.timing, doneAt: Date.now() } } : {}),
    };
  };
  let unsubscribe: (() => void) | undefined;
  let offTrace: (() => void) | undefined;
  try {
    unsubscribe = // Older browser fixtures predate streaming; production preload always supplies this.
      (window.electronAPI as Partial<Window['electronAPI']>).onFileChatProgress?.((event) => {
        if (event.requestId !== run.requestId || run.stopped) return;
        const current = get(key).messages.find((m) => m.id === assistant.id);
        patch(
          {
            content: (current?.content ?? '') + event.chunk,
            ...(current?.timing && !current.timing.firstTextAt && event.chunk
              ? { timing: { ...current.timing, firstTextAt: Date.now() } }
              : {}),
          },
          true,
          false
        );
      });
    // Context arrives from the main process before the answer; agent tool calls follow live.
    // Like chunks, trace updates stay in memory until the answer settles and is saved.
    offTrace = (window.electronAPI as Partial<Window['electronAPI']>).onChatTrace?.((event) => {
      if (event.requestId !== run.requestId || run.stopped) return;
      const current = get(key).messages.find((m) => m.id === assistant.id);
      const elapsed = current?.timing ? Date.now() - current.timing.sentAt : undefined;
      patch(
        {
          trace: appendTraceSteps(current?.trace, event.steps, elapsed),
          ...(event.citable ? { citable: event.citable } : {}),
        },
        true,
        false
      );
    });
    const history = before.messages
      .filter(
        (m, i) =>
          !m.isStreaming && !m.error && !m.stopped && !before.messages[i + 1]?.error && !before.messages[i + 1]?.stopped
      )
      .map((m) => ({ role: m.role, content: chatQuestion(m.content, m.selection) }));
    const content = await window.electronAPI.askPrFile({ ...request, requestId: run.requestId, history });
    if (!run.stopped) patch({ content, isStreaming: false, ...ended() }, false);
    return !run.stopped;
  } catch (error) {
    if (error instanceof Error && error.message.includes('GNOSIS_CANCELLED')) run.stopped = true;
    if (!run.stopped)
      patch(
        { isStreaming: false, error: error instanceof Error ? error.message : String(error), ...ended('error') },
        false
      );
    return false;
  } finally {
    unsubscribe?.();
    offTrace?.();
    if (run.stopped) patch({ isStreaming: false, stopped: true, ...ended() }, false);
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
