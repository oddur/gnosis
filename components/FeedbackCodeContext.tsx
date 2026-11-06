import { useEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { PrFileInspection, type ChangeFileEntry } from './PrFileInspection';
import { PrFileChat } from './PrFileChat';
import { inspectionData } from '../lib/inspection-cache';
import { feedbackCodeContext, type FeedbackItem } from '../lib/feedback';
import type { Preferences } from '../lib/types';
import type { usePrDiscussions } from '../lib/use-pr-discussions';

/** The saved hunk is immediate. Wider inspection is explicit and reuses the Changes cache. */
export function FeedbackCodeContext({
  item,
  thread,
  preferences,
  discussion,
  onSource,
}: {
  item: FeedbackItem;
  thread: NonNullable<FeedbackItem['thread']>;
  preferences?: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  onSource: () => void;
}) {
  const fullContext = useRef<HTMLDivElement>(null);
  const [revision] = useState(() => ({
    url: item.member.url,
    baseSha: item.member.baseSha,
    headSha: item.member.headSha,
  }));
  const [expanded, setExpanded] = useState(false);
  const [fullFile, setFullFile] = useState(false);
  const [entry, setEntry] = useState<ChangeFileEntry>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [chat, setChat] = useState<string>();
  const context = feedbackCodeContext(
    thread,
    item.headSha ? { headSha: item.headSha, baseSha: item.baseSha ?? '' } : undefined,
    item.member
  );
  const earlier = context === 'earlier';
  const [contextOpen, setContextOpen] = useState(() => !thread.isResolved && context === 'current');
  useEffect(() => {
    if (!fullFile) return;
    let live = true;
    const controller = new AbortController();
    setError('');
    void inspectionData
      .readChanges(revision, false, false, controller.signal)
      .then((snapshot) => {
        if (!live) return;
        const file = snapshot.files.find((file) => file.path === thread.path || file.previousPath === thread.path);
        if (!file) {
          setError(
            snapshot.filesTruncated
              ? 'This file is outside the available file list. The saved comment context is still available.'
              : 'This file is no longer in the current changes. The saved comment context is still available.'
          );
          return;
        }
        setEntry({ key: `${snapshot.url}:${file.path}`, snapshot, file });
      })
      .catch(() => {
        if (live) setError('Could not load the full file. Your conversation and saved code context remain available.');
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [fullFile, attempt, revision, thread.path]);
  useEffect(() => {
    if (!fullFile) return;
    const frame = requestAnimationFrame(() => fullContext.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [fullFile]);
  const hunk = item.comments[0]?.diffHunk;
  const lines = hunk?.split('\n').filter((line) => !line.startsWith('@@')) ?? [];
  const shown = expanded ? lines : lines.slice(-6);
  return (
    <details
      className="feedback-code-context"
      aria-label="Commented code"
      open={contextOpen}
      onToggle={(event) => setContextOpen(event.currentTarget.open)}
    >
      <summary className="feedback-code-heading">
        <ChevronRight size={14} aria-hidden="true" />
        {earlier
          ? 'Code from earlier revision'
          : context === 'unavailable'
            ? 'Original code context'
            : `Commented code${thread.line ? ` · Line ${thread.line}` : ''}`}
      </summary>
      <div className="feedback-code-tools">
        {preferences && (
          <Button size="sm" variant="ghost" aria-expanded={fullFile} onClick={() => setFullFile((value) => !value)}>
            {fullFile ? 'Hide full file' : earlier ? 'View current file' : 'Show full file'}
          </Button>
        )}
      </div>
      {!fullFile &&
        (hunk ? (
          <>
            <pre className="feedback-code" aria-label="Code when commented">
              {shown.map((line, index) => (
                <span
                  key={index}
                  data-change={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}
                >
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
            {lines.length > 6 && (
              <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {expanded ? 'Less code context' : `Show all ${lines.length} lines of context`}
              </Button>
            )}
          </>
        ) : (
          <p className="feedback-context-unavailable">
            GitHub did not provide code context for this comment.
          </p>
        ))}
      {fullFile && preferences && (
        <div className="feedback-full-file" ref={fullContext}>
          <p>
            {earlier
              ? `File at ${revision.headSha.slice(0, 7)} — the earlier comment is not attached to these lines.`
              : `Full file at ${revision.headSha.slice(0, 7)}`}{' '}
            <Button variant="link" size="sm" onClick={onSource}>
              Open in Changes
            </Button>
          </p>
          {error ? (
            <p role="status">
              {error}{' '}
              <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Retry file
              </Button>
            </p>
          ) : entry ? (
            <PrFileInspection
              entry={entry}
              preferences={preferences}
              discussion={discussion}
              focusThreadId={thread.id}
              renderFeedbackThread={() => null}
              onAsk={setChat}
            />
          ) : (
            <p role="status">
              <RefreshCw size={14} className="animate-spin" /> Loading full file context…
            </p>
          )}
          {chat !== undefined && entry && (
            <PrFileChat
              request={{
                url: entry.snapshot.url,
                path: entry.file.path,
                baseSha: entry.snapshot.metadata.baseSha,
                headSha: entry.snapshot.metadata.headSha,
              }}
              preferences={preferences}
              selection={chat}
              onClose={() => setChat(undefined)}
            />
          )}
        </div>
      )}
    </details>
  );
}
