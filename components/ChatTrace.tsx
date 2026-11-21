import { useEffect, useState } from 'react';
import {
  Brain,
  FileDiff,
  FilePen,
  FileSearch,
  FileText,
  GitPullRequest,
  Globe,
  ListTree,
  LoaderCircle,
  MessagesSquare,
  Search,
  SquareArrowOutUpRight,
  SquareTerminal,
  TextSelect,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './ui/trace';
import {
  durationText,
  lineRangeText,
  traceCountText,
  traceLabel,
  type ChatTiming,
  type ChatTrace,
  type ChatTraceKind,
  type ChatTraceStep,
} from '../lib/chat-trace';

/**
 * What a prompt did, on shadcn/ui's Trace (https://ui.shadcn.com/docs/components/base/trace, MIT): one summary line
 * that opens to a row per step. While the answer streams the rows are open and grow live, with the step that runs
 * shimmering; once it is done they fold to the summary, whatever the reader opened meanwhile.
 *
 * Rows come only from lib/chat-trace.ts: the context Gnosis sent, and the tool calls (with their input and output)
 * the AI CLI reported. "Thinking" is the time before the first words of the answer, measured here, not reasoning
 * text: chat runs without extended thinking.
 */
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

const openLabel = (step: ChatTraceStep) => {
  const lines =
    step.startLine && step.endLine && step.endLine !== step.startLine
      ? ` lines ${step.startLine} to ${step.endLine}`
      : step.startLine
        ? ` line ${step.startLine}`
        : '';
  return `Open ${step.path}${lines} in Changes`;
};

function StepLine({ step }: { step: ChatTraceStep }) {
  const Icon = KIND[step.kind].icon;
  const range = lineRangeText(step);
  const status = step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : undefined;
  const time = step.duration !== undefined ? durationText(step.duration) : step.status === 'running' ? 'running' : '';
  return (
    <TraceLine status={status} className="chat-trace-line">
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle className="chat-trace-title">
        <span className="chat-trace-verb">{KIND[step.kind].verb}</span>
        {step.label !== KIND[step.kind].verb && (
          <>
            {' '}
            <span className="chat-trace-label">{step.label}</span>
          </>
        )}
      </TraceTitle>
      {range && <TraceDescription className="chat-trace-range">{range}</TraceDescription>}
      {step.status === 'error' && <TraceDescription>failed</TraceDescription>}
      {time && <TraceDescription className="chat-trace-time">{time}</TraceDescription>}
    </TraceLine>
  );
}

function StepRow({ step, onOpen }: { step: ChatTraceStep; onOpen?: (step: ChatTraceStep) => void }) {
  const open = onOpen && step.path ? () => onOpen(step) : undefined;
  if (step.input || step.output)
    return (
      <TraceCollapsible className="chat-trace-step" data-step={step.id}>
        <TraceCollapsibleTrigger className="chat-trace-step-toggle" title={step.detail}>
          <StepLine step={step} />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="chat-trace-io">
          {step.input && (
            <>
              <span className="chat-trace-io-label">Input</span>
              <pre>{step.input}</pre>
            </>
          )}
          <span className="chat-trace-io-label">Output</span>
          {step.output !== undefined ? (
            <pre data-status={step.status}>{step.output || 'No output.'}</pre>
          ) : (
            <p>{step.status === 'running' ? 'Waiting for the result…' : 'The AI did not report a result.'}</p>
          )}
          {open && (
            <button type="button" className="chat-trace-open" onClick={open} aria-label={openLabel(step)}>
              <SquareArrowOutUpRight size={12} aria-hidden="true" /> Open in Changes
            </button>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  if (open)
    return (
      <button
        type="button"
        className="chat-trace-step chat-trace-link"
        data-step={step.id}
        onClick={open}
        aria-label={openLabel(step)}
        title={step.detail}
      >
        <StepLine step={step} />
      </button>
    );
  return (
    <div className="chat-trace-step" data-step={step.id} title={step.detail}>
      <StepLine step={step} />
    </div>
  );
}

/** The wait for the first words, live until they arrive. */
function ThinkingRow({ timing, streaming, answered }: { timing: ChatTiming; streaming: boolean; answered: boolean }) {
  const waiting = streaming && !timing.firstTextAt && !answered;
  const time = timing.firstTextAt ? durationText(timing.firstTextAt - timing.sentAt) : '';
  if (!waiting && !time) return null;
  return (
    <div className="chat-trace-step chat-trace-thinking">
      <TraceLine status={waiting ? 'running' : undefined} className="chat-trace-line">
        <TraceIcon>
          <Brain />
        </TraceIcon>
        <TraceTitle className="chat-trace-title">{waiting ? 'Thinking' : 'Thought'}</TraceTitle>
        {time && <TraceDescription className="chat-trace-time">{time}</TraceDescription>}
      </TraceLine>
    </div>
  );
}

/** Ticks once a second while the answer streams, so the summary's elapsed time stays current. */
function useElapsed(timing: ChatTiming | undefined, streaming: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming || !timing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming, timing]);
  if (!timing) return undefined;
  return (timing.doneAt ?? (streaming ? now : undefined) ?? timing.sentAt) - timing.sentAt;
}

export function ChatTraceView({
  trace,
  timing,
  streaming = false,
  answered = false,
  onOpen,
}: {
  trace: ChatTrace;
  timing?: ChatTiming;
  streaming?: boolean;
  /** The answer has text: thinking is over even when its timing was not recorded. */
  answered?: boolean;
  onOpen?: (step: ChatTraceStep) => void;
}) {
  const [expanded, setExpanded] = useState(streaming);
  // Streaming opens the rows; completion folds them to the summary, whatever the reader opened meanwhile.
  useEffect(() => setExpanded(streaming), [streaming]);
  const label = traceLabel(trace);
  const count = traceCountText(trace);
  const elapsed = useElapsed(timing, streaming);
  const time = elapsed !== undefined && elapsed >= 0 && (streaming || timing?.doneAt) ? durationText(elapsed) : '';
  const running = trace.steps.find((s) => s.status === 'running');
  const failed = trace.steps.filter((s) => s.status === 'error').length;
  const title = streaming
    ? running
      ? `${KIND[running.kind].verb} ${running.label}`
      : timing && !timing.firstTextAt && !answered
        ? 'Thinking'
        : 'Answering'
    : label;
  const mixed = trace.steps.some((s) => s.source === 'agent') && trace.steps.some((s) => s.source === 'context');
  const groups = mixed
    ? [
        { title: 'Sent by Gnosis', steps: trace.steps.filter((s) => s.source === 'context') },
        { title: 'Reported by the AI', steps: trace.steps.filter((s) => s.source === 'agent') },
      ]
    : [{ title: '', steps: trace.steps }];
  const summary = [count, failed ? `${failed} failed` : '', time].filter(Boolean).join(' · ');
  return (
    <div className="chat-trace" data-streaming={streaming || undefined} data-expanded={expanded || undefined}>
      <Trace>
        <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
          <TraceCollapsibleTrigger className="chat-trace-toggle" aria-label={`${label}, ${count}`}>
            <TraceLine status={streaming ? 'running' : failed ? 'error' : undefined} className="chat-trace-summary">
              <TraceIcon>{streaming ? <LoaderCircle className="motion-safe:animate-spin" /> : <ListTree />}</TraceIcon>
              <TraceTitle className="chat-trace-heading">{title}</TraceTitle>
              <TraceDescription className="chat-trace-count">{summary}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted className="chat-trace-body">
            {timing && <ThinkingRow timing={timing} streaming={streaming} answered={answered} />}
            {groups.map((group) => (
              <section key={group.title} className="chat-trace-group" aria-label={group.title || label}>
                {group.title && <h4>{group.title}</h4>}
                <Trace className="chat-trace-steps">
                  {group.steps.map((step) => (
                    <StepRow key={step.id} step={step} onOpen={onOpen} />
                  ))}
                </Trace>
              </section>
            ))}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </div>
  );
}
