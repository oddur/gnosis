import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, Clock3, GitBranch, MessageSquare, MessagesSquare, ScanSearch, SkipForward, TextSearch, X } from 'lucide-react';
import { Button } from './ui/button';
import {
  mergeBlockers,
  primaryAction,
  runSummary,
  stepDigest,
  suggestDepth,
  type Blocker,
  type Depth,
  type DigestLine,
  type SessionStep,
  type StepOutcome,
} from '../lib/guided-session';
import type { QueueSignals } from '../lib/queue-signals';
import type { SinceEvent } from '../lib/since-log';

/** Where a step's button takes the reader: the PR's review, its summary, its conflicts, or GitHub. */
export type SessionOpen = 'review' | 'summary' | 'conflicts' | 'github';

export interface GuidedSessionProps {
  /** The run's steps as they were when it started, in order: the session walks these. */
  steps: readonly SessionStep[];
  /** The same steps as the page has them now, by id. A step that left the page is done. */
  live: ReadonlyMap<string, SessionStep>;
  index: number;
  outcomes: Readonly<Partial<Record<string, StepOutcome>>>;
  /** Per step: the depth the reader chose instead of the suggestion. */
  depths: Readonly<Partial<Record<string, Depth>>>;
  login: string;
  now: number;
  statusOf: (member: { url: string }) => QueueSignals | undefined;
  since: readonly SinceEvent[];
  rereviewLines: Readonly<Partial<Record<string, number>>>;
  replies: Readonly<Partial<Record<string, { author: string; text: string }>>>;
  /** The step's primary action as the Overview row draws it (Merge, Rerun), or undefined for an open. */
  renderAction: (step: SessionStep) => ReactNode | undefined;
  /** The PR's icon and repository label, as the Overview rows draw them. */
  renderIdentity: (step: SessionStep) => ReactNode;
  onOpen: (step: SessionStep, where: SessionOpen) => void;
  onIndex: (index: number) => void;
  onOutcome: (id: string, outcome: StepOutcome) => void;
  onDepth: (id: string, depth: Depth) => void;
  onExit: () => void;
}

const TONE_ICON: Readonly<Record<DigestLine['tone'], typeof CircleAlert>> = { danger: CircleAlert, success: CircleCheck, attention: MessageSquare, neutral: GitBranch };
const BLOCKER_ICON: Readonly<Record<Blocker['action']['kind'], typeof CircleAlert>> = {
  'rerun-failed': CircleAlert,
  'update-branch': GitBranch,
  'resolve-conflicts': CircleAlert,
  review: ScanSearch,
  reply: MessageSquare,
  'show-threads': MessagesSquare,
  'mark-ready': GitBranch,
  wait: Clock3,
  'open-on-github': CircleAlert,
};
const OWNER_LABEL: Readonly<Record<Blocker['owner'], string | undefined>> = { me: undefined, anyone: undefined, author: 'Waiting on the author', reviewer: 'Waiting on a reviewer' };

/**
 * A guided session (#596): one PR at a time, from Overview's Next up. The card says what changed since you last
 * looked, what blocks the PR with the action for each, and whether a summary is enough or the PR needs a deep review.
 * Enter takes the primary action; d switches the depth; s skips; ← and → move; Esc leaves. At the end, a summary of
 * the run. The keys are the session's own while it has focus: it holds the keyboard until the reader leaves.
 */
export function GuidedSession(props: GuidedSessionProps) {
  const { steps, live, index, outcomes, depths, onExit, onIndex, onOutcome, onDepth, onOpen } = props;
  const root = useRef<HTMLElement>(null);
  const done = index >= steps.length;
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [index]);
  const current = done ? undefined : (live.get(steps[index].id) ?? steps[index]);
  const gone = !done && !live.has(steps[index].id);
  const go = (to: number) => onIndex(Math.max(0, Math.min(steps.length, to)));
  const skip = () => {
    if (!current) return;
    if (!outcomes[current.id]) onOutcome(current.id, 'skipped');
    go(index + 1);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    // Keys inside a menu, field or dialog the card opened are theirs.
    if ((event.target as Element).closest('input, textarea, [role=menu], [role=dialog], [role=listbox]')) return;
    const key = event.key;
    if (key === 'Escape') onExit();
    else if (key === 'ArrowRight') go(index + 1);
    else if (key === 'ArrowLeft') go(index - 1);
    else if (done) return;
    else if (key === 's') skip();
    else if (key === 'd' && current) onDepth(current.id, (depths[current.id] ?? suggestDepth(current, props.rereviewLines[current.member.url]).depth) === 'deep' ? 'summary' : 'deep');
    else if (key === '.' && current) onOpen(current, 'summary');
    else if (key === 'Enter' && event.target === root.current) root.current.querySelector<HTMLButtonElement>('[data-session-primary] button, button[data-session-primary]')?.click();
    else return;
    event.preventDefault();
  };
  return (
    <section ref={root} className="guided-session" aria-label="Guided session" tabIndex={-1} onKeyDown={onKeyDown} data-guided-session>
      <header className="guided-session-head">
        <h2>
          {done ? 'Session done' : 'Session'}
          {!done && <span className="guided-session-count" data-session-position>{index + 1} of {steps.length}</span>}
        </h2>
        <ol className="guided-session-progress" aria-label="Steps">
          {steps.map((step, i) => (
            <li key={step.id} data-outcome={outcomes[step.id] ?? (live.has(step.id) ? undefined : 'done')} aria-current={i === index ? 'step' : undefined}>
              <button type="button" tabIndex={-1} title={`#${step.member.number} ${step.member.title}`} onClick={() => go(i)} />
            </li>
          ))}
        </ol>
        <Button size="xs" variant="ghost" onClick={onExit} title="Leave the session · Esc">
          <X size={13} aria-hidden="true" />
          Leave
        </Button>
      </header>
      {current ? <StepCard {...props} step={current} gone={gone} skip={skip} /> : <RunEnd {...props} />}
      {!done && (
        <footer className="guided-session-next" data-session-next>
          {index + 1 < steps.length ? (
            <>
              <span className="guided-session-next-label">Next</span>
              <span>#{steps[index + 1].member.number} {steps[index + 1].title}</span>
              <span className="guided-session-next-why">{steps[index + 1].why}</span>
            </>
          ) : (
            <span className="guided-session-next-label">Last step</span>
          )}
          <span className="guided-session-nav">
            <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => go(index - 1)} title="Previous · ←" aria-label="Previous step">
              <ArrowLeft size={13} aria-hidden="true" />
            </Button>
            <Button size="xs" variant="ghost" onClick={() => go(index + 1)} title="Next · →" aria-label="Next step">
              <ArrowRight size={13} aria-hidden="true" />
            </Button>
          </span>
        </footer>
      )}
    </section>
  );
}

function StepCard({ step, gone, skip, login, now, statusOf, since, rereviewLines, replies, depths, outcomes, renderAction, renderIdentity, onOpen, onOutcome, onDepth }: GuidedSessionProps & { step: SessionStep; gone: boolean; skip: () => void }) {
  const signals = statusOf(step.member);
  const lines = rereviewLines[step.member.url];
  const digest = stepDigest({ step, signals, login, now, since, rereviewLines: lines, reply: replies[step.member.url] });
  const blockers = mergeBlockers(step.member, signals, login);
  const suggested = suggestDepth(step, lines);
  const depth = depths[step.id] ?? suggested.depth;
  const chosen = depths[step.id] !== undefined && depths[step.id] !== suggested.depth;
  const label = primaryAction(step, blockers, depth);
  const action = renderAction(step);
  const outcome = outcomes[step.id];
  const open = (where: 'review' | 'summary') => {
    onOutcome(step.id, 'opened');
    onOpen(step, where);
  };
  const blockerButton = (blocker: Blocker): ReactNode => {
    switch (blocker.action.kind) {
      case 'rerun-failed':
        return step.kind === 'fix' ? null : <Button size="xs" variant="outline" onClick={() => open('summary')}>Show checks</Button>;
      case 'resolve-conflicts':
        return <Button size="xs" variant="outline" onClick={() => { onOutcome(step.id, 'opened'); onOpen(step, 'conflicts'); }}>Resolve conflicts</Button>;
      case 'update-branch':
        return <Button size="xs" variant="outline" onClick={() => open('summary')}>Update branch</Button>;
      // Reviewing is the step's own primary action.
      case 'review':
        return null;
      case 'reply':
        return <Button size="xs" variant="outline" onClick={() => open('summary')}>Reply</Button>;
      case 'show-threads':
        return <Button size="xs" variant="outline" onClick={() => open('summary')}>Show threads</Button>;
      case 'mark-ready':
        return blocker.owner === 'me' ? <Button size="xs" variant="outline" onClick={() => open('summary')}>Mark ready</Button> : null;
      case 'open-on-github':
        return <Button size="xs" variant="outline" onClick={() => onOpen(step, 'github')}>Open merge box</Button>;
      case 'wait':
        return null;
    }
  };
  return (
    <article className="guided-step" aria-labelledby={`step-${step.id}-title`} data-session-step={step.id} data-kind={step.kind}>
      <div className="guided-step-identity">
        {renderIdentity(step)}
        <h3 id={`step-${step.id}-title`} className="guided-step-title">{step.title}</h3>
        <span className="guided-step-meta">
          {step.member.author} · <span className="guided-step-add">+{step.member.additions ?? 0}</span> <span className="guided-step-del">−{step.member.deletions ?? 0}</span>
        </span>
      </div>
      {(gone || outcome === 'done') && (
        <p className="guided-step-status" data-tone="success" role="status">
          <CircleCheck size={14} aria-hidden="true" />
          Moved on: it left Next up.
        </p>
      )}
      <div className="guided-step-block">
        <p className="guided-step-lead">{digest.lead}</p>
        {digest.lines.length > 0 ? (
          <ul className="guided-step-digest">
            {digest.lines.map((line) => {
              const Icon = TONE_ICON[line.tone];
              return (
                <li key={line.text} data-tone={line.tone}>
                  <Icon size={14} aria-hidden="true" />
                  <span>
                    {line.text}
                    {line.quote && <q className="guided-step-quote">{line.quote}</q>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          digest.lead.endsWith(':') && <p className="guided-step-quiet">Nothing new that Gnosis can see.</p>
        )}
      </div>
      <div className="guided-step-block">
        <h4 className="guided-step-heading">{blockers.length ? 'Blocking the merge' : signals?.readiness ? 'Nothing blocks the merge' : 'Merge readiness'}</h4>
        {blockers.length > 0 ? (
          <ul className="guided-step-blockers">
            {blockers.map((blocker) => {
              const Icon = BLOCKER_ICON[blocker.action.kind];
              const owner = OWNER_LABEL[blocker.owner];
              const button = blockerButton(blocker);
              return (
                <li key={blocker.cause} data-blocker={blocker.action.kind}>
                  <Icon size={14} aria-hidden="true" />
                  <span className="guided-step-cause">{blocker.cause}</span>
                  {owner && <span className="guided-step-owner">{owner}</span>}
                  {button && <span className="guided-step-fix">{button}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          !signals?.readiness && <p className="guided-step-quiet">Not read yet: Gnosis reads it in the background.</p>
        )}
      </div>
      <div className="guided-step-depth" data-depth={depth}>
        {depth === 'deep' ? <ScanSearch size={15} aria-hidden="true" /> : <TextSearch size={15} aria-hidden="true" />}
        <p>
          <strong>{depth === 'deep' ? 'Deep review' : 'Summary is enough'}</strong>
          {chosen ? ' — your choice for this PR.' : ` — ${suggested.reason}`}
        </p>
        <Button size="xs" variant="ghost" onClick={() => onDepth(step.id, depth === 'deep' ? 'summary' : 'deep')} title={depth === 'deep' ? 'A summary is enough · D' : 'Deep review instead · D'}>
          {depth === 'deep' ? 'Summary is enough' : 'Go deeper'}
          <kbd>D</kbd>
        </Button>
      </div>
      <div className="guided-step-actions">
        {action ? (
          <span data-session-primary className="guided-step-primary">{action}</span>
        ) : (
          <Button size="sm" data-session-primary onClick={() => open(depth === 'deep' ? 'review' : 'summary')}>
            {label}
            <kbd>↵</kbd>
          </Button>
        )}
        {action && (
          <Button size="sm" variant="outline" onClick={() => open(depth === 'deep' ? 'review' : 'summary')}>
            {depth === 'deep' ? 'Review' : 'Open summary'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={skip} title="Skip for now · S">
          <SkipForward size={14} aria-hidden="true" />
          Skip
          <kbd>S</kbd>
        </Button>
        {outcome === 'opened' && <span className="guided-step-note" role="status">Opened in the PR tab. Come back here to go on.</span>}
      </div>
    </article>
  );
}

function RunEnd({ steps, live, outcomes, onExit, onIndex }: GuidedSessionProps) {
  // A step that left the page moved on, whatever the reader did there.
  const settled = Object.fromEntries(steps.map((step) => [step.id, live.has(step.id) ? (outcomes[step.id] ?? 'open') : 'done'])) as Record<string, StepOutcome>;
  const summary = runSummary(steps, settled);
  return (
    <div className="guided-end" data-session-end>
      <p className="guided-end-lead">
        {summary.done === summary.total ? `All ${summary.total} moved forward.` : summary.done ? `${summary.done} of ${summary.total} moved forward.` : `Nothing moved yet: ${summary.total} still on your list.`}
      </p>
      <ul className="guided-end-lines">
        {summary.lines.map((line, i) => (
          <li key={line.id} data-outcome={line.outcome}>
            <button type="button" onClick={() => onIndex(i)}>{line.text}</button>
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={onExit}>Back to Overview</Button>
    </div>
  );
}
