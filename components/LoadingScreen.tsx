import { useEffect, useRef } from 'react';
import { LoadingState, LoadingIndicator } from './LoadingState';

interface Props {
  message: string;
  streamingText?: string;
  activeToolCall?: string | null;
}

export function LoadingScreen({ message, streamingText, activeToolCall }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [streamingText]);
  return (
    <div className="flex min-h-full items-start justify-center px-6 py-12">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <LoadingState title="Preparing your explanation" description={message || undefined} />
        {activeToolCall && <LoadingIndicator className="slide-meta">{activeToolCall}</LoadingIndicator>}
        {streamingText && (
          <pre
            ref={preRef}
            className="loading-stream w-full text-left text-xs font-mono text-muted-foreground rounded-md px-4 py-3 max-h-56 overflow-y-auto whitespace-pre-wrap"
          >
            {streamingText}
          </pre>
        )}
      </div>
    </div>
  );
}
