import { useEffect, useId, useState } from 'react';
import {
  ChevronRight,
  FileDiff,
  FilePen,
  FileSearch,
  FileText,
  GitPullRequest,
  Globe,
  MessagesSquare,
  Search,
  SquareTerminal,
  TextSelect,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  lineRangeText,
  traceCountText,
  traceLabel,
  type ChatTrace,
  type ChatTraceKind,
  type ChatTraceStep,
} from '../lib/chat-trace';

// Compact chips and a one-line summary, after Beautiful UI's Thinking and Tool Chips (MIT).
const KIND: Record<ChatTraceKind, { icon: LucideIcon; verb: string }> = {
  diff: { icon: FileDiff, verb: 'Diff' },
  file: { icon: FileText, verb: 'File' },
  selection: { icon: TextSelect, verb: 'Selected code' },
  pr: { icon: GitPullRequest, verb: 'Pull request' },
  history: { icon: MessagesSquare, verb: 'Conversation' },
  read: { icon: FileSearch, verb: 'Read' },
  search: { icon: Search, verb: 'Searched' },
  command: { icon: SquareTerminal, verb: 'Ran' },
  edit: { icon: FilePen, verb: 'Edited' },
  web: { icon: Globe, verb: 'Web' },
  tool: { icon: Wrench, verb: 'Used' },
};
// Two chips fit the 400px chat column without truncating file names.
const INLINE = 2;

function TraceChip({ step, onOpen }: { step: ChatTraceStep; onOpen?: (step: ChatTraceStep) => void }) {
  const Icon = KIND[step.kind].icon;
  const range = lineRangeText(step);
  const body = (
    <>
      <Icon size={12} aria-hidden="true" />
      <span className="chat-trace-chip-label">{step.label}</span>
      {range && <span className="chat-trace-chip-range">{range}</span>}
    </>
  );
  if (onOpen && step.path) {
    const lines =
      step.startLine && step.endLine && step.endLine !== step.startLine
        ? ` lines ${step.startLine} to ${step.endLine}`
        : step.startLine
          ? ` line ${step.startLine}`
          : '';
    return (
      <button
        type="button"
        className="chat-trace-chip"
        aria-label={`Open ${step.path}${lines} in Changes`}
        title={step.detail ?? step.path}
        onClick={() => onOpen(step)}
      >
        {body}
      </button>
    );
  }
  return (
    <span className="chat-trace-chip" title={step.detail}>
      {body}
    </span>
  );
}

/** Disclosure of what an answer was built from. Live while streaming, one line once complete. */
export function ChatTraceView({
  trace,
  streaming,
  onOpen,
}: {
  trace: ChatTrace;
  streaming?: boolean;
  onOpen?: (step: ChatTraceStep) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  // Completion collapses the trace to its summary, whatever the reader opened meanwhile.
  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);
  const label = traceLabel(trace);
  const count = traceCountText(trace);
  // The summary favours steps that open a file; the expanded list keeps the real order.
  const inline = streaming
    ? trace.steps
    : [...trace.steps.filter((s) => s.path), ...trace.steps.filter((s) => !s.path)].slice(0, INLINE);
  const hidden = trace.steps.length - inline.length;
  const mixed = trace.steps.some((s) => s.source === 'agent') && trace.steps.some((s) => s.source === 'context');
  const groups = mixed
    ? [
        { title: 'Sent by Gnosis', steps: trace.steps.filter((s) => s.source === 'context') },
        { title: 'Reported by the AI', steps: trace.steps.filter((s) => s.source === 'agent') },
      ]
    : [{ title: '', steps: trace.steps }];
  return (
    <div className="chat-trace" data-streaming={streaming || undefined} data-expanded={expanded || undefined}>
      <div className="chat-trace-row">
        <button
          type="button"
          className="chat-trace-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${label}, ${count}`}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRight size={12} aria-hidden="true" className="chat-trace-chevron" />
          <span>{label}</span>
          {expanded && <span className="chat-trace-count">· {count}</span>}
        </button>
        {!expanded && (
          <>
            <ul className="chat-trace-chips" aria-label={label}>
              {inline.map((step) => (
                <li key={step.id}>
                  <TraceChip step={step} onOpen={onOpen} />
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                className="chat-trace-more"
                aria-label={`Show all ${trace.steps.length} steps`}
                onClick={() => setExpanded(true)}
              >
                {hidden} more
              </button>
            )}
          </>
        )}
      </div>
      <div id={id} hidden={!expanded}>
        {expanded &&
          groups.map((group) => (
            <section key={group.title} className="chat-trace-group" aria-label={group.title || label}>
              {group.title && <h4>{group.title}</h4>}
              <ol className="chat-trace-steps">
                {group.steps.map((step) => (
                  <li key={step.id}>
                    <span className="chat-trace-verb">{KIND[step.kind].verb}</span>
                    <TraceChip step={step} onOpen={onOpen} />
                    {step.detail && <span className="chat-trace-detail">{step.detail}</span>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
      </div>
    </div>
  );
}
