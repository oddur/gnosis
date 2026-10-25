import { useSyncExternalStore } from 'react';
import type { FileChatMessage, FileChatRequest } from './pr-changes';
interface Session {
  messages: FileChatMessage[];
  busy: boolean;
  error: string;
}
const sessions = new Map<string, Session>();
const listeners = new Set<() => void>();
const storage = (key: string) => `gnosis-file-chat:v1:${key}`;
function get(key: string): Session {
  let value = sessions.get(key);
  if (!value) {
    let messages: FileChatMessage[] = [];
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storage(key)) ?? '[]');
      if (Array.isArray(saved))
        messages = saved.filter(
          (m: unknown): m is FileChatMessage =>
            !!m &&
            typeof m === 'object' &&
            'content' in m &&
            typeof m.content === 'string' &&
            'role' in m &&
            (m.role === 'user' || m.role === 'assistant')
        );
    } catch {
      /* Optional saved conversation. */
    }
    value = { messages, busy: false, error: '' };
    sessions.set(key, value);
  }
  return value;
}
function update(key: string, value: Session) {
  sessions.set(key, value);
  try {
    localStorage.setItem(storage(key), JSON.stringify(value.messages));
  } catch {
    /* Keep session in memory. */
  }
  listeners.forEach((fn) => fn());
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
    send: async (request: Omit<FileChatRequest, 'history'>) => {
      const before = get(key);
      if (before.busy) return false;
      const messages = [...before.messages, { role: 'user' as const, content: request.question }];
      update(key, { messages, busy: true, error: '' });
      try {
        const content = await window.electronAPI.askPrFile({ ...request, history: before.messages });
        update(key, { messages: [...messages, { role: 'assistant', content }], busy: false, error: '' });
        return true;
      } catch (e) {
        update(key, { messages: before.messages, busy: false, error: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
  };
}
