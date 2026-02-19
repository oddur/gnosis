'use client';

import { useEffect, useRef } from 'react';

interface Props {
  message: string;
  streamingText?: string;
}

export function LoadingScreen({ message, streamingText }: Props) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [streamingText]);

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 text-center w-full max-w-2xl">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-foreground" />
        <p className="text-muted-foreground max-w-sm">{message}</p>
        {streamingText && (
          <pre
            ref={preRef}
            className="w-full text-left text-xs text-muted-foreground/70 font-mono bg-muted/30 rounded-md p-3 overflow-y-auto max-h-48 whitespace-pre-wrap break-all"
          >
            {streamingText}
          </pre>
        )}
      </div>
    </div>
  );
}
