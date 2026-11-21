import { lazy } from 'react';

/**
 * The conversation and the prompt input load when a chat panel opens, not with the app or a PR: they bring the AI
 * Elements (prompt input, model selector, trace, inline citations) and their Base UI menus and cards.
 * scripts/check-startup-bundle.mjs fails if they reach the startup bundle or the review page's chunk.
 */
export const loadChatConversation = () => import('./ChatConversation');
export const loadChatComposer = () => import('./ChatComposer');
export const LazyChatConversation = lazy(() => loadChatConversation().then((m) => ({ default: m.ChatConversation })));
export const LazyChatComposer = lazy(() => loadChatComposer().then((m) => ({ default: m.ChatComposer })));

/** Holds the conversation's place while it loads. */
export function ChatConversationFallback() {
  return <div className="chat-conversation chat-loading flex-1" aria-busy="true" />;
}
/** Holds the composer's height while it loads, so the panel does not jump. */
export function ChatComposerFallback() {
  return <div className="chat-composer chat-composer-placeholder" aria-busy="true" />;
}
