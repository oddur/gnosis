import { useReducer, useCallback, useEffect, useRef } from 'react';
import type { ReviewGuide, Provider, ModelId, SendSlideChatRequest } from './types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

type MessagesMap = Map<number, ChatMessage[]>;

type Action =
  | { type: 'SEND'; slideIndex: number; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { type: 'APPEND_CHUNK'; slideIndex: number; assistantId: string; chunk: string }
  | { type: 'FINALIZE'; slideIndex: number; assistantId: string }
  | { type: 'ERROR'; slideIndex: number; assistantId: string; error: string }
  | { type: 'CLEAR'; slideIndex: number };

function reducer(state: MessagesMap, action: Action): MessagesMap {
  const next = new Map(state);

  switch (action.type) {
    case 'SEND': {
      const existing = next.get(action.slideIndex) ?? [];
      next.set(action.slideIndex, [...existing, action.userMessage, action.assistantMessage]);
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
    case 'FINALIZE': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) => (m.id === action.assistantId ? { ...m, isStreaming: false } : m))
      );
      return next;
    }
    case 'ERROR': {
      const msgs = next.get(action.slideIndex);
      if (!msgs) return state;
      next.set(
        action.slideIndex,
        msgs.map((m) =>
          m.id === action.assistantId ? { ...m, content: m.content || action.error, isStreaming: false } : m
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

export function useSlideChat(review: ReviewGuide, provider: Provider, model: ModelId) {
  const [messages, dispatch] = useReducer(reducer, new Map<number, ChatMessage[]>());
  const streamingRef = useRef<{ slideIndex: number; assistantId: string } | null>(null);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    const handler = (chunk: string) => {
      const current = streamingRef.current;
      if (!current) return;
      dispatch({ type: 'APPEND_CHUNK', slideIndex: current.slideIndex, assistantId: current.assistantId, chunk });
    };

    window.electronAPI.onChatProgress(handler);
    return () => {
      window.electronAPI.offChatProgress();
    };
  }, []);

  const getMessages = useCallback(
    (slideIndex: number): ChatMessage[] => {
      return messages.get(slideIndex) ?? [];
    },
    [messages]
  );

  const send = useCallback(
    async (slideIndex: number, question: string) => {
      if (isStreamingRef.current) return;

      const slide = review.slides[slideIndex - 1];

      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: question };
      const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', isStreaming: true };

      dispatch({ type: 'SEND', slideIndex, userMessage: userMsg, assistantMessage: assistantMsg });
      streamingRef.current = { slideIndex, assistantId: assistantMsg.id };
      isStreamingRef.current = true;

      const existingMessages = messages.get(slideIndex) ?? [];
      const history = existingMessages
        .filter((m) => !m.isStreaming && m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      const diffContent = slide.diffHunks.map((h) => `--- ${h.filePath}\n${h.hunkHeader}\n${h.content}`).join('\n\n');

      const req: SendSlideChatRequest = {
        prTitle: review.prTitle,
        prDescription: review.prDescription,
        summary: review.summary,
        slideTitle: slide.title,
        slideNarrative: slide.narrative,
        slideReviewFocus: slide.reviewFocus,
        affectedFiles: slide.affectedFiles,
        diffContent,
        history,
        question,
        provider,
        model,
      };

      try {
        await window.electronAPI.sendSlideChat(req);
        dispatch({ type: 'FINALIZE', slideIndex, assistantId: assistantMsg.id });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to get response';
        dispatch({ type: 'ERROR', slideIndex, assistantId: assistantMsg.id, error: errorMsg });
      } finally {
        streamingRef.current = null;
        isStreamingRef.current = false;
      }
    },
    [review, provider, model, messages]
  );

  const clearSlide = useCallback((slideIndex: number) => {
    dispatch({ type: 'CLEAR', slideIndex });
  }, []);

  const isStreaming = isStreamingRef.current;

  return { getMessages, send, isStreaming, clearSlide };
}
