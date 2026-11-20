/**
 * Replies typed in a notification that GitHub refused (#385 part 2). The text is kept for the thread it answered,
 * so nothing typed is lost: the thread's reply box shows it as a draft the next time it is on screen, or at once
 * if it is showing. Session only, like the app's other drafts. Renderer side.
 */
import { useEffect, useRef } from 'react';
import type { NotificationReplyTarget } from './notification-events';

export const replyDraftKey = (reply: NotificationReplyTarget) =>
  reply.kind === 'thread' ? `thread:${reply.threadId}` : `feedback:${reply.prUrl}#${reply.sourceId}`;

type Change = { type: 'keep' | 'sent'; text: string };
const kept = new Map<string, string>();
const listeners = new Map<string, Set<(change: Change) => void>>();
const emit = (key: string, change: Change) => listeners.get(key)?.forEach((listener) => listener(change));

export function keepReplyDraft(key: string, text: string) {
  kept.set(key, text);
  emit(key, { type: 'keep', text });
}
/** A retry went through: an editor that shows this text clears it. */
export function replyDraftSent(key: string, text: string) {
  if (kept.get(key) === text) kept.delete(key);
  emit(key, { type: 'sent', text });
}
export const peekReplyDraft = (key: string) => kept.get(key);

/**
 * For a thread's reply box: `apply` receives a kept draft once, when the box mounts or when the draft arrives.
 * `sent` runs when a retry of that text went through. `visible` keeps a box in a hidden workspace tab from taking the
 * draft: the PR's Conversation page may be open in several tabs (#418), and the reader opens the one in front.
 */
export function useKeptReplyDraft(key: string, apply: (text: string) => void, sent: (text: string) => void, visible?: () => boolean) {
  const handlers = useRef({ apply, sent });
  handlers.current = { apply, sent };
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    // The draft stays kept until a retry or a reply sends it: each box that shows the thread offers it once, so the
    // copy the reader opens has it even when another tab's copy of the same Conversation showed it first (#418).
    let applied: string | undefined;
    const take = () => {
      const text = kept.get(key);
      if (text === undefined || text === applied || (visibleRef.current && !visibleRef.current())) return;
      applied = text;
      handlers.current.apply(text);
    };
    take();
    const listener = (change: Change) => (change.type === 'keep' ? take() : handlers.current.sent(change.text));
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(key);
    };
  }, [key]);
}
