import { useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, RotateCcw } from 'lucide-react';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Message, MessageContent, MessageHeader, MessageFooter } from './ui/message';
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from './ui/message-scroller';
import type { ChatMessage } from '../lib/use-slide-chat';

function AnswerCopy({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? 'Answer copied' : 'Copy answer'}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(content);
                setCopied(true);
                setError(false);
              } catch {
                setError(true);
              }
            }}
            onBlur={() => setCopied(false)}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied' : 'Copy answer'}</TooltipContent>
      </Tooltip>
      {error && <span role="alert">Could not copy. Select the answer to copy it.</span>}
    </>
  );
}

export function ChatConversation({
  conversationId,
  messages,
  busy,
  onRetry,
  empty,
}: {
  conversationId: string;
  messages: ChatMessage[];
  busy: boolean;
  onRetry?: (id: string) => void;
  empty: ReactNode;
}) {
  const streaming = messages.some((message) => message.isStreaming);
  return (
    <TooltipProvider delayDuration={350}>
      <MessageScrollerProvider
        key={conversationId}
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={12}
      >
        <MessageScroller className="chat-conversation flex-1">
          <MessageScrollerViewport aria-label="Conversation">
            <MessageScrollerContent className="chat-transcript" aria-live="off">
              {!messages.length && <div className="chat-empty">{empty}</div>}
              {messages.map((message, index) => (
                <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
                  <Message align={message.role === 'user' ? 'end' : 'start'} className="chat-message">
                    <MessageContent>
                      <MessageHeader>{message.role === 'user' ? 'You' : 'Gnosis'}</MessageHeader>
                      {message.toolCalls?.length ? (
                        <details className="chat-tools">
                          <summary>
                            {message.isStreaming ? 'Checking context' : 'Context checked'} · {message.toolCalls.length}{' '}
                            {message.toolCalls.length === 1 ? 'tool' : 'tools'}
                          </summary>
                          <ul>
                            {message.toolCalls.map((tool) => (
                              <li key={tool}>{tool}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {message.selection && (
                        <details className="chat-quote">
                          <summary>Selected code</summary>
                          <pre>{message.selection}</pre>
                        </details>
                      )}
                      {message.content && (
                        <Markdown className="reading-prose chat-message-body">{message.content}</Markdown>
                      )}
                      {message.isStreaming && (
                        <div className="chat-answer-status">
                          <Loader2 size={14} className="motion-safe:animate-spin" />
                          {message.content ? 'Answering…' : 'Thinking…'}
                        </div>
                      )}
                      {message.error && (
                        <p role="alert" className="chat-answer-error">
                          Answer interrupted. {message.error}
                        </p>
                      )}
                      {message.stopped && <p className="chat-answer-status">Answer stopped.</p>}
                      {message.role === 'assistant' && !message.isStreaming && (
                        <MessageFooter className="chat-message-actions">
                          {message.content && <AnswerCopy content={message.content} />}
                          {(message.error || message.stopped) && index === messages.length - 1 && onRetry && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRetry(message.id)}>
                              <RotateCcw size={14} />
                              Retry answer
                            </Button>
                          )}
                        </MessageFooter>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton behavior="instant" aria-label="Jump to latest" />
        </MessageScroller>
        <span className="sr-only" role="status" aria-live="polite">
          {streaming ? 'Answer in progress' : messages.length ? 'Answer finished' : ''}
        </span>
      </MessageScrollerProvider>
    </TooltipProvider>
  );
}
