import { chatQuestion } from './chat-context';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { ReviewGuide, Provider, ModelId, SendSlideChatRequest } from './types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  toolCalls?: string[];
  error?: string;
  stopped?: boolean;
  selection?: string;
}

type MessagesMap = Map<number, ChatMessage[]>;
const runs = new Map<string, { requestId: string; stopped: boolean }>();
const sessions = new Map<string, MessagesMap>();
const anyStreaming = () =>
  [...sessions.values()].some((slides) =>
    [...slides.values()].some((rows) => rows.some((message) => message.isStreaming))
  );

type Action =
  | { type: 'SEND'; slideIndex: number; userMessage: ChatMessage; assistantMessage: ChatMessage; retryId?: string }
  | { type: 'APPEND_CHUNK'; slideIndex: number; assistantId: string; chunk: string }
  | { type: 'TOOL_USE'; slideIndex: number; assistantId: string; toolName: string }
  | { type: 'FINALIZE'; slideIndex: number; assistantId: string; content: string }
  | { type: 'ERROR'; slideIndex: number; assistantId: string; error: string }
  | { type: 'STOP'; slideIndex: number; assistantId: string }
  | { type: 'CLEAR'; slideIndex: number };

function reducer(state: MessagesMap, action: Action): MessagesMap {
  const next = new Map(state);

  switch (action.type) {
    case 'SEND': {
      const existing = next.get(action.slideIndex) ?? [];
      next.set(
        action.slideIndex,
        action.retryId
          ? existing.map((m) => (m.id === action.retryId ? action.assistantMessage : m))
          : [...existing, action.userMessage, action.assistantMessage]
      );
      return next;
    }
    case 'APPEND_CHUNK': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) => (m.id === action.assistantId ? { ...m, content: m.content + action.chunk } : m))
      );
      return next;
    }
    case 'TOOL_USE': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) => {
          if (m.id !== action.assistantId) return m;
          const existing = m.toolCalls ?? [];
          if (existing.includes(action.toolName)) return m;
          return { ...m, toolCalls: [...existing, action.toolName] };
        })
      );
      return next;
    }
    case 'FINALIZE': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) => (m.id === action.assistantId ? { ...m, content: action.content, isStreaming: false } : m))
      );
      return next;
    }
    case 'ERROR': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) => (m.id === action.assistantId ? { ...m, error: action.error, isStreaming: false } : m))
      );
      return next;
    }
    case 'STOP': {
      next.set(
        action.slideIndex,
        (next.get(action.slideIndex) ?? []).map((m) =>
          m.id === action.assistantId ? { ...m, isStreaming: false, stopped: true } : m
        )
      );
      return next;
    }
    case 'CLEAR': {
      next.delete(action.slideIndex);
      return next;
    }
  }
}

export function useSlideChat(
  review: ReviewGuide,
  provider: Provider,
  model: ModelId,
  effort?: import('./effort').Effort
) {
  const key = `${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`;
  const [sessionBusy, setSessionBusy] = useState(anyStreaming);
  const [messages, setMessages] = useState<MessagesMap>(() => sessions.get(key) ?? new Map());
  const currentKey = useRef(key);
  currentKey.current = key;
  const dispatch = useCallback(
    (action: Action) => {
      const next = reducer(sessions.get(key) ?? new Map<number, ChatMessage[]>(), action);
      sessions.set(key, next);
      if (currentKey.current === key) setMessages(next);
      window.dispatchEvent(new window.CustomEvent('gnosis-chat-session', { detail: key }));
    },
    [key]
  );
  useEffect(() => {
    setMessages(sessions.get(key) ?? new Map());
    setSessionBusy(anyStreaming());
    const sync = (event: Event) => {
      setSessionBusy(anyStreaming());
      if ((event as CustomEvent<string>).detail === key) setMessages(sessions.get(key) ?? new Map());
    };
    window.addEventListener('gnosis-chat-session', sync);
    return () => window.removeEventListener('gnosis-chat-session', sync);
  }, [key]);
  const isStreamingRef = useRef(false);

  const getMessages = useCallback(
    (slideIndex: number): ChatMessage[] => {
      return messages.get(slideIndex) ?? [];
    },
    [messages]
  );

  const send = useCallback(
    async (slideIndex: number, question: string, selection?: string, retryId?: string) => {
      if (isStreamingRef.current || anyStreaming()) return;

      if (!Number.isInteger(slideIndex) || slideIndex < 1) return;
      const slide = review.slides.at(slideIndex - 1);
      if (!slide || !question.trim()) return;
      const existingMessages = sessions.get(key)?.get(slideIndex) ?? [];
      if (
        retryId &&
        (existingMessages.at(-1)?.id !== retryId ||
          !(existingMessages.at(-1)?.error || existingMessages.at(-1)?.stopped))
      )
        return;

      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: question, selection };
      const assistantMsg: ChatMessage = {
        id: retryId ?? crypto.randomUUID(),
        role: 'assistant',
        content: '',
        isStreaming: true,
      };

      const run = { requestId: crypto.randomUUID(), stopped: false };
      runs.set(`${key}:${slideIndex}`, run);
      dispatch({ type: 'SEND', slideIndex, userMessage: userMsg, assistantMessage: assistantMsg, retryId });
      isStreamingRef.current = true;

      const history = existingMessages
        // Failed output is evidence for the user, never a completed model answer.
        .filter(
          (m, i) =>
            !m.isStreaming &&
            m.content &&
            !m.error &&
            !m.stopped &&
            !existingMessages[i + 1]?.error &&
            !existingMessages[i + 1]?.stopped
        )
        .map((m) => ({ role: m.role, content: chatQuestion(m.content, m.selection) }));

      try {
        window.electronAPI.onChatProgress((chunk) => {
          if (!run.stopped) dispatch({ type: 'APPEND_CHUNK', slideIndex, assistantId: assistantMsg.id, chunk });
        });
        window.electronAPI.onChatToolUse((toolName) => {
          if (!run.stopped) dispatch({ type: 'TOOL_USE', slideIndex, assistantId: assistantMsg.id, toolName });
        });
        const diffContent = slide.diffHunks.map((h) => `--- ${h.filePath}\n${h.hunkHeader}\n${h.content}`).join('\n\n');

        const req: SendSlideChatRequest = {
          requestId: run.requestId,
          prTitle: review.prTitle,
          prDescription: review.prDescription,
          summary: review.summary,
          slideTitle: slide.title,
          slideNarrative: slide.narrative,
          slideReviewFocus: slide.reviewFocus,
          affectedFiles: slide.affectedFiles,
          diffContent,
          history,
          question: chatQuestion(question, selection),
          provider,
          model,
          effort,
        };

        const content = await window.electronAPI.sendSlideChat(req);
        // Progress may include commentary or omit the final text. The returned
        // answer is authoritative for both rendering and subsequent history.
        if (!run.stopped) dispatch({ type: 'FINALIZE', slideIndex, assistantId: assistantMsg.id, content });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to get response';
        if (!run.stopped) dispatch({ type: 'ERROR', slideIndex, assistantId: assistantMsg.id, error: errorMsg });
      } finally {
        if (run.stopped) dispatch({ type: 'STOP', slideIndex, assistantId: assistantMsg.id });
        runs.delete(`${key}:${slideIndex}`);
        window.electronAPI.offChatProgress();
        window.electronAPI.offChatToolUse();
        isStreamingRef.current = false;
      }
    },
    [review, provider, model, effort, dispatch, key]
  );

  const retry = useCallback(
    async (slideIndex: number, assistantId: string) => {
      const rows = sessions.get(key)?.get(slideIndex) ?? [];
      const question = rows.at(-2);
      if (rows.at(-1)?.id === assistantId && question?.role === 'user')
        await send(slideIndex, question.content, question.selection, assistantId);
    },
    [send, key]
  );

  const clearSlide = useCallback(
    (slideIndex: number) => {
      if (!anyStreaming()) dispatch({ type: 'CLEAR', slideIndex });
    },
    [dispatch]
  );

  const isStreaming =
    sessionBusy || isStreamingRef.current || [...messages.values()].some((rows) => rows.some((m) => m.isStreaming));

  const stop = (slideIndex: number) => {
    const run = runs.get(`${key}:${slideIndex}`);
    if (!run || run.stopped) return;
    run.stopped = true;
    void window.electronAPI.cancelChat(run.requestId).catch(() => {
      run.stopped = false;
    });
  };
  return { getMessages, send, retry, stop, isStreaming, clearSlide };
}
