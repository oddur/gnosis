import { useEffect, useRef, useState } from 'react';

interface Props {
  message: string;
  streamingText?: string;
  activeToolCall?: string | null;
}

// Phase copy reads as natural prose, not log messages. The wait is
// the first page of the monograph — these are chapter titles, not
// status updates.
const phases = [
  'Reading the pull request',
  'Building the context around it',
  'Looking at the changes one by one',
  'Composing the walkthrough',
];

export function LoadingScreen({ message, streamingText, activeToolCall }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [streamingText]);

  useEffect(() => {
    const interval = setInterval(() => {
      setPhaseIndex((i) => (i < phases.length - 1 ? i + 1 : i));
    }, 4500);
    return () => clearInterval(interval);
  }, []);

  // Once streaming text starts arriving we know we're in the final
  // phase — don't pretend otherwise.
  useEffect(() => {
    if (streamingText) setPhaseIndex(phases.length - 1);
  }, [streamingText]);

  const progress = ((phaseIndex + 1) / phases.length) * 100;

  return (
    <div className="flex min-h-screen items-start justify-center px-8 pt-[18vh] pb-12">
      <div className="w-full max-w-2xl flex flex-col gap-10">
        {/* Chapter chip — same vocabulary as the rest of the
            monograph. Tells the reader what stage of the wait
            they're in without dramatizing it. */}
        <div className="slide-chapter">
          <span>Section 00</span>
          <span aria-hidden="true">·</span>
          <span>{phaseIndex + 1} of {phases.length}</span>
        </div>

        {/* Serif phase title — the dominant element on the page,
            same treatment as a real slide title. The wait IS a
            slide; it just happens to be the first one. */}
        <h1 className="slide-title">{phases[phaseIndex]}</h1>

        {/* Hairline progress rule. A single 1px line that fills
            from left to right as phases advance. No glow, no
            shimmer, no animated stripes — just a quiet rule that
            tells you where you are. */}
        <div className="relative h-px w-full bg-border" role="progressbar" aria-valuenow={progress}>
          <div
            className="absolute left-0 top-0 h-px bg-[var(--ring)] loading-progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Active tool call — small inline mono line, no pill, no
            border, no glow. Reads like a margin note. */}
        {activeToolCall && (
          <p className="slide-meta">
            <span className="text-muted-foreground/60">·</span> {activeToolCall}
          </p>
        )}

        {/* Free-text status message from the caller. Quiet meta
            register, not a headline. */}
        {message && <p className="slide-meta opacity-70">{message}</p>}

        {/* Streaming text from the model. A calm mono panel
            on a faint warm-paper tint, no glow, no cyan border.
            Reads like the AI's marginalia. */}
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
