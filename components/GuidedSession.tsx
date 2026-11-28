import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AlarmClock, ArrowLeft, ArrowRight, Bot, Check, CircleAlert, CircleCheck, Clock3, ExternalLink, GitBranch, Hourglass, MessageSquare, MessagesSquare, ScanSearch, ShieldCheck, SkipForward, TextSearch, VolumeX, X } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from './ui/toast';
import { conflictHeaderLine } from '../lib/conflict-header';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { useConflictHeader } from '../lib/use-conflict-header';
import { mergeBlockers, plainText, runSummary, stepDigest, suggestDepth, type Blocker, type Depth, type DepthContext, type DigestLine, type Park, type ParkResult, type SessionStep, type StepOutcome } from '../lib/guided-session';
import type { QueueSignals } from '../lib/queue-signals';
import type { SinceEvent } from '../lib/since-log';
import type { WaitingReply } from '../lib/use-morning';

/** Where a step's button takes the reader: the PR's review, its summary, its conflicts, or GitHub (its checks page). */
export type SessionOpen = 'review' | 'summary' | 'conflicts' | 'github' | 'github-checks';
/** What the PR is about, under its title: the generated summary, or the start of its description. */
export interface StepAbout {
  text: string;
  generated: boolean;
}

export interface GuidedSessionProps {
  /** The run's steps as they were when it started, in order: the session walks these. */
  steps: readonly SessionStep[];
  /** The same steps as the page has them now, by id. A step that left the page is done. */
  live: ReadonlyMap<string, SessionStep>;
  index: number;
  outcomes: Readonly<Partial<Record<string, StepOutcome>>>;
  /** Steps parked while a slow action runs (a rerun, a branch update), by id. */
  parked: Readonly<Partial<Record<string, Park>>>;
  /** What a parked step's action came to, once it resolved, by id. */
  results: Readonly<Partial<Record<string, ParkResult>>>;
  /** What the depth rules read beyond the step: its paths, its author's association. */
  depthContext: (step: SessionStep) => DepthContext;
  login: string;
  now: number;
  statusOf: (member: { url: string }) => QueueSignals | undefined;
  since: readonly SinceEvent[];
  rereviewLines: Readonly<Partial<Record<string, number>>>;
  replies: Readonly<Partial<Record<string, WaitingReply>>>;
  about: (step: SessionStep) => StepAbout | undefined;
  /** The step's in-place action as the Overview row draws it (Merge, Rerun), or undefined. */
  renderAction: (step: SessionStep) => ReactNode | undefined;
  /**
   * Snooze the step's PRs: the picker asks until when, and `snoozed` runs once they are, so the session moves on.
   * False when nothing can be snoozed (a merged or closed PR).
   */
  snooze?: (step: SessionStep, snoozed: () => void) => boolean;
  /** Mute the step's PRs: they leave every list until unmuted. Resolves true once saved. */
  mute?: (step: SessionStep) => Promise<boolean>;
  /** A step's other way forward, beside Skip: a decision's Close PR. Its button carries `data-session-close` for C. */
  renderSecondary?: (step: SessionStep) => ReactNode | undefined;
  /** Update branch and Mark ready, through the PR header's actions and their confirmations. */
  renderPrAction: (step: SessionStep, kind: 'update-branch' | 'mark-ready') => ReactNode;
  /** The PR's icon and repository label, as the Overview rows draw them. */
  renderIdentity: (step: SessionStep) => ReactNode;
  reply: (step: SessionStep, threadId: string, body: string, resolve: boolean) => Promise<void>;
  approve: (step: SessionStep, body: string) => Promise<void>;
  onOpen: (step: SessionStep, where: SessionOpen) => void;
  onIndex: (index: number) => void;
  onOutcome: (id: string, outcome: StepOutcome) => void;
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
  'approve-workflows': ShieldCheck,
  wait: Clock3,
  'open-on-github': CircleAlert,
};
const OWNER_LABEL: Readonly<Record<Blocker['owner'], string | undefined>> = { me: undefined, anyone: undefined, author: 'Waiting on the author', reviewer: 'Waiting on a reviewer', maintainer: 'Needs a maintainer' };
const PRIMARY = '[data-session-primary]';

/**
 * A guided session (#596): one PR at a time, from Overview's Next up, so each can be moved on without leaving it.
 * The card says what the PR is (its summary), what is new since you last looked, and what blocks the merge, each with
 * the action that clears it: reply to the comment waiting on you, approve a small update, merge, rerun, update the
 * branch. The full PR is always one click away. Enter takes the primary action; O opens the full PR; D switches the
 * depth; S skips; ← and → move; Esc leaves.
 */
/** Put off or let go: the PR leaves the list, but it did not move. */
const setAside = (outcome: StepOutcome | undefined) => outcome === 'snoozed' || outcome === 'muted';
/** A step's outcome. A snooze or mute that was undone (the PR is back on the list) no longer counts. */
function outcomeOf(id: string, outcomes: GuidedSessionProps['outcomes'], live: GuidedSessionProps['live']): StepOutcome | undefined {
  const outcome = outcomes[id];
  return setAside(outcome) && live.has(id) ? undefined : outcome;
}
export function GuidedSession(props: GuidedSessionProps) {
  const { steps, live, index, outcomes, snooze, mute, onExit, onIndex, onOutcome, onOpen } = props;
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
  // Snoozed: off the list until the time picked, so the session goes on to the next PR.
  const snoozeStep = () => {
    if (!current || gone || !snooze) return;
    const step = current;
    snooze(step, () => {
      onOutcome(step.id, 'snoozed');
      go(index + 1);
    });
  };
  // Muted: no longer followed, so it leaves every list and the session goes on. The toast has its Undo.
  const [muting, setMuting] = useState(false);
  const muteStep = () => {
    if (!current || gone || !mute || muting) return;
    const step = current;
    const at = index;
    setMuting(true);
    void mute(step)
      .then((saved) => {
        if (!saved) return;
        onOutcome(step.id, 'muted');
        go(at + 1);
      })
      .finally(() => setMuting(false));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    // Keys typed into the reply or the approval comment are theirs, as are a menu's or a dialog's the card opened.
    if ((event.target as Element).closest('input, textarea, [role=menu], [role=dialog], [role=listbox]')) return;
    const key = event.key;
    if (key === 'Escape') onExit();
    else if (key === 'ArrowRight') go(index + 1);
    else if (key === 'ArrowLeft') go(index - 1);
    else if (done) return;
    else if (key === 's') skip();
    else if (key === 'z') snoozeStep();
    else if (key === 'm') muteStep();
    else if ((key === 'd' || key === 'o') && current) {
      if (!outcomes[current.id]) onOutcome(current.id, 'opened');
      onOpen(current, key === 'd' ? 'review' : 'summary');
    } else if (key === 'a' && current) root.current?.querySelector<HTMLButtonElement>('[data-session-approve-now]')?.click();
    else if (key === 'c' && current) root.current?.querySelector<HTMLButtonElement>('[data-session-close]')?.click();
    else if (key === 'Enter' && event.target === root.current) {
      // The primary action: a reply box takes the keyboard, a button is pressed.
      const target = root.current.querySelector<HTMLElement>(`textarea${PRIMARY}, ${PRIMARY} button, button${PRIMARY}`);
      if (target instanceof HTMLTextAreaElement) target.focus();
      else target?.click();
    } else return;
    event.preventDefault();
  };
  return (
    <section ref={root} className="guided-session" aria-label="Guided session" tabIndex={-1} onKeyDown={onKeyDown} data-guided-session>
      <header className="guided-session-head">
        <h2>
          {done ? 'Session done' : 'Session'}
          {!done && <span className="guided-session-count" data-session-position>{index + 1} of {steps.length}</span>}
        </h2>
        <ol className="guided-session-progress" aria-label="PRs in this session">
          {steps.map((step, i) => (
            <li key={step.id} data-outcome={outcomeOf(step.id, outcomes, live) ?? (live.has(step.id) ? undefined : 'done')} aria-current={i === index ? 'step' : undefined}>
              <button type="button" tabIndex={-1} title={`#${step.member.number} ${step.member.title}`} onClick={() => go(i)} />
            </li>
          ))}
        </ol>
        {!done && (
          <Button size="xs" variant="ghost" onClick={onExit} title="Leave the session · Esc">
            <X size={13} aria-hidden="true" />
            Leave
          </Button>
        )}
      </header>
      {current ? <StepCard key={current.id} {...props} step={current} gone={gone} skip={skip} snoozeStep={snooze ? snoozeStep : undefined} muteStep={mute ? muteStep : undefined} muting={muting} next={() => go(index + 1)} /> : <RunEnd {...props} />}
      {!done && (
        <footer className="guided-session-next" data-session-next>
          {index + 1 < steps.length ? (
            <>
              <span className="guided-session-next-label">Next</span>
              <span>#{steps[index + 1].member.number} {steps[index + 1].title}</span>
              <span className="guided-session-next-why">{steps[index + 1].why}</span>
            </>
          ) : (
            <span className="guided-session-next-label">Last one</span>
          )}
          <span className="guided-session-nav">
            <Button size="xs" variant="ghost" disabled={index === 0} onClick={() => go(index - 1)} title="Previous · ←" aria-label="Previous PR">
              <ArrowLeft size={13} aria-hidden="true" />
            </Button>
            <Button size="xs" variant="ghost" onClick={() => go(index + 1)} title="Next · →" aria-label="Next PR">
              <ArrowRight size={13} aria-hidden="true" />
            </Button>
          </span>
        </footer>
      )}
    </section>
  );
}

/** The heading over what is new: since when, in a few words. */
function newHeading(lead: string): string {
  if (lead === 'Your PR.') return 'On your PR';
  if (lead === "You haven't reviewed this PR.") return 'New to you';
  if (lead === 'Updated since your review:') return 'Since your review';
  const match = /^You (.+?) (just now|.+ ago|yesterday)\. Since then:$/.exec(lead);
  return match ? `Since you ${match[1]} ${match[2]}` : lead;
}

type Busy = 'reply' | 'approve' | undefined;

function StepCard(props: GuidedSessionProps & { step: SessionStep; gone: boolean; skip: () => void; snoozeStep?: () => void; muteStep?: () => void; muting?: boolean; next: () => void }) {
  const { step, gone, skip, snoozeStep, muteStep, muting, next, login, now, statusOf, since, rereviewLines, replies, outcomes, parked, results, depthContext, about, renderAction, renderSecondary, renderPrAction, renderIdentity, reply, approve, onOpen, onOutcome } = props;
  const signals = statusOf(step.member);
  const lines = rereviewLines[step.member.url];
  const waiting = replies[step.member.url];
  const digest = stepDigest({ step, signals, login, now, since, rereviewLines: lines, reply: waiting });
  const [approved, setApproved] = useState(false);
  // Your approval clears the review it was waiting on at once; the next status read confirms the rest.
  const blockers = mergeBlockers(step.member, signals, login).filter((blocker) => !(approved && blocker.action.kind === 'review' && blocker.owner === 'me'));
  const suggested = suggestDepth(step, lines, depthContext(step));
  const depth: Depth = suggested.depth;
  const summary = about(step);
  const outcome = outcomeOf(step.id, outcomes, props.live);
  // A parked step's action runs on GitHub: nothing more to do here until it resolves.
  const park = outcome === 'parked' ? parked[step.id] : undefined;
  const settled = results[step.id];
  const moved = gone || outcome === 'done' || !!park;
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [replyText, setReplyText] = useState('');
  const [resolveToo, setResolveToo] = useState(false);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string>();
  const [sent, setSent] = useState<string>();
  const card = useRef<HTMLElement>(null);
  // After a reply or an approval, the keyboard goes back to the session, so → and Enter go on at once.
  const backToSession = () => card.current?.closest<HTMLElement>('[data-guided-session]')?.focus({ preventScroll: true });
  const own = step.member.author.toLowerCase() === login.toLowerCase();
  // Approve from the step: any PR that is not yours, until you have approved it here.
  const canApprove = !own && !moved && !approved;
  const replyHere = !!waiting?.threadId && !moved && !sent;
  const full = (where: 'review' | 'summary') => {
    if (!outcome) onOutcome(step.id, 'opened');
    onOpen(step, where);
  };
  const write = async (what: Exclude<Busy, undefined>, run: () => Promise<void>, done: string) => {
    setBusy(what);
    setError(undefined);
    try {
      await run();
      setResult(done);
      if (what === 'reply') setSent(replyText.trim());
      onOutcome(step.id, 'done');
      toast.add({ type: 'success', title: done });
      // Done here means on to the next PR: no extra press. ← comes back.
      requestAnimationFrame(() => {
        backToSession();
        next();
      });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure);
      setError(`${what === 'reply' ? 'The reply was not sent' : 'The approval was not sent'}: ${message} Your text is kept. Try again, or open the full PR.`);
    } finally {
      setBusy(undefined);
    }
  };
  const sendReply = () => {
    const threadId = waiting?.threadId;
    if (!waiting || !threadId || !replyText.trim() || busy) return;
    void write('reply', () => reply(step, threadId, replyText.trim(), resolveToo), resolveToo ? `Replied to ${waiting.author} and resolved the thread.` : `Replied to ${waiting.author}.`);
  };
  const sendApproval = () => {
    if (busy || !canApprove) return;
    void write('approve', async () => { await approve(step, note.trim()); setApproved(true); }, `Approved #${step.member.number}.`);
  };
  const inline = renderAction(step);
  // The one primary action: what moves this PR on from here. A waiting reply's box is the primary when there is one;
  // otherwise the step's own action (Merge, Rerun), else the depth Gnosis suggests.
  const openButton = (where: 'summary' | 'review', filled: boolean) => (
    <Button size="sm" variant={filled ? 'default' : 'outline'} data-session-primary={filled || undefined} onClick={() => full(where)}
      title={where === 'review' ? `Open #${step.member.number} on Changes, for a full read · D` : `Open #${step.member.number} on Summary · O`}>
      {where === 'review' ? 'Deep review' : 'Summary'}
      <kbd>{where === 'review' ? 'D' : 'O'}</kbd>
    </Button>
  );
  const primary: ReactNode = moved ? (
    <Button size="sm" data-session-primary onClick={next}>
      Next PR
      <kbd>↵</kbd>
    </Button>
  ) : inline ? (
    <span data-session-primary className="guided-step-primary">{inline}</span>
  ) : null;
  const suggestedOpen = !moved && !inline && !replyHere;
  const blockerAction = (blocker: Blocker): ReactNode => {
    if (moved) return null;
    switch (blocker.action.kind) {
      case 'rerun-failed':
        // A failing fix's Rerun is the step's primary action; elsewhere the checks are one click away.
        return step.kind === 'fix' ? null : <Button size="xs" variant="outline" onClick={() => full('summary')}>Show checks</Button>;
      case 'resolve-conflicts':
        return <ResolveConflicts member={step.member} onOpened={() => { if (!outcome) onOutcome(step.id, 'opened'); }} />;
      case 'update-branch':
        return renderPrAction(step, 'update-branch');
      case 'mark-ready':
        return blocker.owner === 'me' ? renderPrAction(step, 'mark-ready') : null;
      case 'show-threads':
        return replyHere ? null : <Button size="xs" variant="outline" onClick={() => full('summary')}>Show threads</Button>;
      case 'approve-workflows':
        // Approve and run from Gnosis is #595; until then, GitHub's checks page, where the button is.
        return (
          <Button size="xs" variant="outline" onClick={() => onOpen(step, 'github-checks')} title="Approve and run the held workflow runs on GitHub">
            Approve on GitHub
            <ExternalLink size={12} aria-hidden="true" />
          </Button>
        );
      case 'open-on-github':
        return (
          <Button size="xs" variant="outline" onClick={() => onOpen(step, 'github')}>
            Open merge box
            <ExternalLink size={12} aria-hidden="true" />
          </Button>
        );
      case 'review':
      case 'reply':
      case 'wait':
        return null;
    }
  };
  // The waiting reply shows once, as its thread with the reply box; the other lines list the rest of what is new.
  const others = digest.lines.filter((line) => line.quote === undefined);
  return (
    <article ref={card} className="guided-step" aria-labelledby={`step-${step.id}-title`} data-session-step={step.id} data-kind={step.kind}>
      <div className="guided-step-identity">
        <p className="guided-step-ref">
          {renderIdentity(step)}
          <span className="guided-step-by">
            {own ? 'your PR' : step.member.author} · <span className="guided-step-add">+{step.member.additions ?? 0}</span> <span className="guided-step-del">−{step.member.deletions ?? 0}</span>
          </span>
        </p>
        <h3 id={`step-${step.id}-title`} className="guided-step-title">{step.title}</h3>
        {summary && (
          <p className="guided-step-about" data-generated={summary.generated || undefined}>
            {summary.generated && (
              <span className="guided-step-about-label" title="From the PR's briefing, written by a model. Check it against the code.">
                <Bot size={12} aria-hidden="true" />
                Briefing
              </span>
            )}
            {summary.text}
          </p>
        )}
      </div>
      {gone && (
        <p className="guided-step-status" data-tone={setAside(outcome) ? 'neutral' : 'success'} role="status">
          {outcome === 'snoozed' ? <AlarmClock size={14} aria-hidden="true" /> : outcome === 'muted' ? <VolumeX size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />}
          {outcome === 'snoozed' ? 'Snoozed: off your list until the time you picked.' : outcome === 'muted' ? 'Muted: you no longer follow it. Unmute it from Muted PRs.' : 'Moved on: it left Next up.'}
        </p>
      )}
      {park && !gone && (
        <p className="guided-step-status" data-tone="neutral" role="status" data-session-parked={park.action}>
          <Hourglass size={14} aria-hidden="true" />
          {park.action === 'rerun-failed' ? 'Rerun requested.' : 'Branch update requested.'} The session went on; this PR comes back here when{' '}
          {park.action === 'rerun-failed' ? 'the checks finish' : 'the new head’s checks finish'}.
        </p>
      )}
      {settled && !park && !gone && (
        <p className="guided-step-status" data-tone={settled.tone} role="status" data-session-result={settled.outcome}>
          {settled.tone === 'success' ? <CircleCheck size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
          {settled.text}
        </p>
      )}
      <div className="guided-step-block">
        <h4 className="guided-step-heading">{newHeading(digest.lead)}</h4>
        {others.length === 0 && !waiting ? (
          <p className="guided-step-quiet">{step.kind === 'rereview' ? 'New commits since your review. Gnosis can’t tell yet what they change.' : 'Nothing new that Gnosis can see.'}</p>
        ) : (
          others.length > 0 && (
            <ul className="guided-step-digest">
              {others.map((line) => {
                const Icon = TONE_ICON[line.tone];
                return (
                  <li key={line.text} data-tone={line.tone}>
                    <Icon size={14} aria-hidden="true" />
                    <span>{line.text}</span>
                  </li>
                );
              })}
            </ul>
          )
        )}
        {waiting && (
          <div className="guided-step-thread" data-session-thread>
            <p className="guided-step-said">
              <MessageSquare size={14} aria-hidden="true" />
              <span>
                <strong>{waiting.author}</strong>{sent ? ' wrote' : ' is waiting on your reply'}
                <q className="guided-step-quote">{plainText(waiting.text)}</q>
              </span>
            </p>
            {sent && (
              <p className="guided-step-said" data-sent role="status">
                <CircleCheck size={14} aria-hidden="true" />
                <span>
                  <strong>You replied</strong>
                  {resolveToo ? ' and resolved the thread' : ''}
                  <q className="guided-step-quote">{sent}</q>
                </span>
              </p>
            )}
            {replyHere && (
              <div className="guided-step-compose">
                <textarea
                  data-session-primary={!inline || undefined}
                  aria-label={`Reply to ${waiting.author}`}
                  placeholder={`Reply to ${waiting.author}…`}
                  rows={2}
                  value={replyText}
                  disabled={busy === 'reply'}
                  onChange={(event) => setReplyText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      sendReply();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.currentTarget.closest<HTMLElement>('[data-guided-session]')?.focus();
                    }
                  }}
                />
                <div className="guided-step-compose-actions">
                  <Button size="sm" disabled={!replyText.trim() || !!busy} onClick={sendReply}>
                    {busy === 'reply' ? 'Sending…' : 'Reply'}
                    <kbd>⌘↵</kbd>
                  </Button>
                  {waiting.canResolve && (
                    <label className="guided-step-check">
                      <input type="checkbox" checked={resolveToo} onChange={(event) => setResolveToo(event.target.checked)} />
                      and resolve the thread
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {!gone && <div className="guided-step-block">
        <h4 className="guided-step-heading">{blockers.length ? 'Blocking the merge' : signals?.readiness ? 'Nothing blocks the merge' : 'Merge status'}</h4>
        {blockers.length > 0 ? (
          <ul className="guided-step-blockers">
            {blockers.map((blocker) => {
              const Icon = BLOCKER_ICON[blocker.action.kind];
              const owner = OWNER_LABEL[blocker.owner];
              const action = blockerAction(blocker);
              return (
                <li key={blocker.cause} data-blocker={blocker.action.kind}>
                  <Icon size={14} aria-hidden="true" />
                  <span className="guided-step-cause">{blocker.cause}</span>
                  {owner && <span className="guided-step-owner">{owner}</span>}
                  {action && <span className="guided-step-fix">{action}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          !signals?.readiness && <p className="guided-step-quiet">Not read yet. Gnosis reads it in the background.</p>
        )}
      </div>}
      {approving && !moved && (
        <div className="guided-step-block guided-step-approve" data-session-approve>
          <label className="guided-step-heading" htmlFor={`approve-${step.id}`}>Approve #{step.member.number}</label>
          <textarea
            id={`approve-${step.id}`}
            data-session-primary
            placeholder="Add a comment (optional)"
            rows={2}
            value={note}
            disabled={busy === 'approve'}
            autoFocus
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendApproval();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setApproving(false);
              }
            }}
          />
          <div className="guided-step-compose-actions">
            <Button size="sm" disabled={!!busy} onClick={sendApproval}>
              <Check size={14} aria-hidden="true" />
              {busy === 'approve' ? 'Approving…' : 'Approve'}
              <kbd>⌘↵</kbd>
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setApproving(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && (
        <p className="guided-step-status" data-tone="danger" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      )}
      <div className="guided-step-actions">
        {result && busy === undefined && !sent && (
          <p className="guided-step-done" role="status">
            <CircleCheck size={14} aria-hidden="true" />
            {result}
          </p>
        )}
        {!moved && (
          <p className="guided-step-depth" data-depth={depth}>
            {depth === 'deep' ? <ScanSearch size={14} aria-hidden="true" /> : <TextSearch size={14} aria-hidden="true" />}
            <span>
              <strong>{depth === 'deep' ? 'Worth a deep review.' : 'A summary is enough.'}</strong> {suggested.reason}
            </span>
          </p>
        )}
        <div className="guided-step-buttons">
          {primary}
          {canApprove && (
            <span className="guided-step-approve-group">
              <Button size="sm" variant={suggestedOpen && depth === 'summary' && (step.kind === 'review' || step.kind === 'rereview') ? 'default' : 'outline'}
                data-session-approve-now data-session-primary={(suggestedOpen && depth === 'summary' && (step.kind === 'review' || step.kind === 'rereview')) || undefined}
                disabled={!!busy} onClick={sendApproval} title={`Approve #${step.member.number} now · A`}>
                <Check size={14} aria-hidden="true" />
                {busy === 'approve' ? 'Approving…' : 'Approve'}
                <kbd>A</kbd>
              </Button>
              {!approving && <button type="button" className="guided-step-link" onClick={() => setApproving(true)}>with a comment…</button>}
            </span>
          )}
          {openButton('summary', suggestedOpen && depth === 'summary' && !(canApprove && (step.kind === 'review' || step.kind === 'rereview')))}
          {openButton('review', suggestedOpen && depth === 'deep')}
          {!moved && renderSecondary?.(step)}
          {!moved && snoozeStep && (
            <Button size="sm" variant="ghost" onClick={snoozeStep} title={`Snooze #${step.member.number} until later… · Z`} data-session-snooze>
              <AlarmClock size={14} aria-hidden="true" />
              Snooze…
              <kbd>Z</kbd>
            </Button>
          )}
          {!moved && muteStep && (
            <Button size="sm" variant="ghost" onClick={muteStep} disabled={muting} title={`Mute #${step.member.number}: stop following it · M`} data-session-mute>
              <VolumeX size={14} aria-hidden="true" />
              {muting ? 'Muting…' : 'Mute'}
              <kbd>M</kbd>
            </Button>
          )}
          {!moved && (
            <Button size="sm" variant="ghost" onClick={skip} title="Skip for now · S">
              <SkipForward size={14} aria-hidden="true" />
              Skip
              <kbd>S</kbd>
            </Button>
          )}
          {outcome === 'opened' && !moved && <span className="guided-step-note" role="status">Opened in its own tab. Come back here to go on.</span>}
        </div>
      </div>
    </article>
  );
}

function RunEnd({ steps, live, outcomes, results, onExit, onIndex }: GuidedSessionProps) {
  // A step that left the page moved on, whatever the reader did there.
  // A snoozed or muted PR leaves the queue too, but it was put off or let go, not moved: it says so.
  const settled = Object.fromEntries(
    steps.map((step) => {
      const outcome = outcomeOf(step.id, outcomes, live);
      return [step.id, setAside(outcome) ? outcome : live.has(step.id) ? (outcome ?? 'open') : 'done'];
    })
  ) as Record<string, StepOutcome>;
  const summary = runSummary(steps, settled);
  return (
    <div className="guided-end" data-session-end>
      <p className="guided-end-lead">
        {summary.done === summary.total ? `All ${summary.total} moved forward.` : summary.done ? `${summary.done} of ${summary.total} moved forward.` : 'Nothing moved this time.'}
        {summary.waiting > 0 && ` ${summary.waiting} still wait${summary.waiting === 1 ? 's' : ''} on checks and come${summary.waiting === 1 ? 's' : ''} back here when they finish.`}
      </p>
      {summary.groups.map((group) => (
        <section key={group.outcome} className="guided-end-group" data-outcome={group.outcome}>
          <h3>
            {group.label}
            <span className="guided-end-count">{group.steps.length}</span>
          </h3>
          <ul className="guided-end-lines">
            {group.steps.map((line) => (
              <li key={line.id} data-outcome={group.outcome}>
                <button type="button" onClick={() => onIndex(line.index)}>
                  {line.text}
                  {results[line.id] && <span className="guided-end-result"> · {results[line.id]?.text}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Button size="sm" onClick={onExit}>Back to Overview</Button>
    </div>
  );
}

/**
 * Resolve conflicts straight from the step: the PR header's button (components/PrActions.tsx), opening the conflict
 * workspace in one press. When Gnosis prepared the merge in the background, it says so: "Review and push…".
 */
function ResolveConflicts({ member, onOpened }: { member: SessionStep['member']; onOpened: () => void }) {
  const line = useConflictHeader(member.url, member.headSha, true);
  return (
    <Button size="xs" variant="outline" title={line ? conflictHeaderLine(line) : `Resolve the conflicts of #${member.number}`}
      onClick={() => { onOpened(); openConflictWorkspace(member.url); }} data-session-conflicts>
      {line?.state === 'ready' && line.merged ? 'Review and push…' : 'Resolve conflicts…'}
    </Button>
  );
}
