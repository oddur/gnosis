/**
 * A guided session (#596): one run through what Overview says to do next, one PR at a time. Each step shows what
 * changed since you last looked, what blocks the PR with the action that clears it, and how deep to go: a summary is
 * enough, or a deep review. Pure: built from the morning page (`lib/morning.ts`), the queue signals and the extras the
 * page already reads; `now` is an argument, and nothing here reads the clock, storage or the network.
 *
 * - **Steps** (`sessionSteps`): Next up's items in Next up's order, then the PRs that need a decision. Next up already
 *   makes a stack one step with its next PR, so a session does too.
 * - **Digest** (`stepDigest`): facts only, from GitHub data. Your last review and its age, then what came after it:
 *   lines changed since that review, a reply waiting on you, checks that turned red or green, unresolved threads.
 * - **Blockers** (`mergeBlockers`): why the PR cannot merge, each with one next action and who owns it.
 * - **Depth** (`suggestDepth`): summary or deep review, with the rule that chose it, so the reason can be shown.
 */
import type { CheckView } from './check-summary';
import type { DecisionItem, MorningPage, NextItem, NextKind } from './morning';
import { viewerReview, type QueueSignals } from './queue-signals';
import type { OverviewRow } from './overview';
import type { SinceEvent } from './since-log';
import type { ReviewMember } from './workbench';

export type StepKind = NextKind | 'decide';
export interface SessionStep {
  /** The Next up or decision item's id: stable while the item stays on the page. */
  id: string;
  source: 'next' | 'decide';
  kind: StepKind;
  row: OverviewRow;
  /** The PR the step acts on: a merge's PR, a stack's next step, else the row's PR. */
  member: ReviewMember;
  title: string;
  /** Next up's one-line reason ("approved by lena · 3 PRs wait on it"), or the decision's label. */
  why: string;
  urls: string[];
  check: CheckView;
  /** A stack base's merge: the open PRs above it. */
  unblocks?: number;
  next?: NextItem;
  decide?: DecisionItem;
}

/** Next up's items, then the decisions. Each PR once: a decision whose PR a Next up item lists is left out. */
export function sessionSteps(page: Pick<MorningPage, 'next' | 'decide'>): SessionStep[] {
  const steps: SessionStep[] = page.next.items.map((item) => ({
    id: item.id,
    source: 'next',
    kind: item.kind,
    row: item.row,
    member: item.member,
    title: item.title,
    why: item.why,
    urls: item.urls,
    check: item.check,
    ...(item.unblocks ? { unblocks: item.unblocks } : {}),
    next: item,
  }));
  const listed = new Set(steps.flatMap((step) => step.urls));
  for (const item of page.decide) {
    if (listed.has(item.member.url)) continue;
    steps.push({ id: item.id, source: 'decide', kind: 'decide', row: item.row, member: item.member, title: item.member.title, why: item.label, urls: [item.member.url], check: item.check, decide: item });
  }
  return steps;
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export type DigestTone = 'neutral' | 'danger' | 'success' | 'attention';
export interface DigestLine {
  tone: DigestTone;
  text: string;
  /** A quoted reply, shown after the text. */
  quote?: string;
}
export interface StepDigest {
  /** "You approved yesterday. Since then:", "You haven't reviewed this PR.", "Your PR." */
  lead: string;
  lines: DigestLine[];
}
export interface DigestInput {
  step: Pick<SessionStep, 'kind' | 'member'>;
  signals: QueueSignals | undefined;
  login: string;
  now: number;
  /** The since-log's events for any PR; the step keeps its own. */
  since: readonly SinceEvent[];
  /** Lines changed since your last review, when Gnosis has read them (`getRereviewLines`). */
  rereviewLines?: number;
  /** A reply that waits on you, with its author and text (`waitingReply`). */
  reply?: { author: string; text: string };
}
/** A comment's Markdown as plain words, for a one-line quote: emphasis, code and links keep their text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/^\s*(?:>|#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const REVIEW_VERB: Readonly<Record<string, string>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'reviewed' };
const MAX_QUOTE = 140;

/** What changed since you last looked, from GitHub data only. At most five lines, most pressing first. */
export function stepDigest({ step, signals, login, now, since, rereviewLines, reply }: DigestInput): StepDigest {
  const { member } = step;
  const own = member.author.toLowerCase() === login.toLowerCase();
  const mine = signals ? viewerReview(signals, login) : undefined;
  const reviewedAt = mine ? Date.parse(mine.submittedAt) : NaN;
  const lead = own
    ? 'Your PR.'
    : mine && Number.isFinite(reviewedAt)
      ? `You ${REVIEW_VERB[mine.state] ?? 'reviewed'} ${ago(reviewedAt, now)}. Since then:`
      : step.kind === 'rereview'
        ? 'Updated since your review:'
        : "You haven't reviewed this PR.";
  const after = Number.isFinite(reviewedAt) ? reviewedAt : 0;
  const lines: DigestLine[] = [];
  if (reply) {
    const text = plainText(reply.text);
    lines.push({ tone: 'attention', text: `${reply.author} replied`, quote: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE - 1).trimEnd()}…` : text });
  }
  if (rereviewLines !== undefined && rereviewLines > 0) lines.push({ tone: 'neutral', text: `${rereviewLines} line${rereviewLines === 1 ? '' : 's'} changed since your review` });
  else if (!mine && !own && step.kind !== 'rereview') lines.push({ tone: 'neutral', text: `${member.commitCount} commit${member.commitCount === 1 ? '' : 's'} · +${member.additions ?? 0} −${member.deletions ?? 0} in ${member.changedFileCount ?? 0} file${member.changedFileCount === 1 ? '' : 's'}` });
  // The since-log's check turns, newest first, after your review: the latest is what the checks are now.
  const turns = since.filter((event) => event.url === member.url && event.at > after && (event.type === 'checks-red' || event.type === 'checks-green')).sort((a, b) => b.at - a.at);
  const turn = turns.length ? turns[0] : undefined;
  const checks = signals?.checks;
  if (checks && checks.state === 'failure') lines.push({ tone: 'danger', text: `${checks.failed ?? 0} of ${checks.total} checks failing${turn?.type === 'checks-red' ? ` since ${ago(turn.at, now)}` : ''}` });
  else if (checks && checks.state === 'pending') lines.push({ tone: 'neutral', text: `${checks.running ?? 0} of ${checks.total} checks running` });
  else if (turn?.type === 'checks-green') lines.push({ tone: 'success', text: `Checks passing again since ${ago(turn.at, now)}` });
  const unresolved = signals?.threads?.unresolved.length ?? 0;
  if (unresolved) lines.push({ tone: 'neutral', text: `${unresolved}${signals?.threads?.complete === false ? '+' : ''} unresolved thread${unresolved === 1 ? '' : 's'}` });
  const requested = signals?.opinions?.filter((review) => review.state === 'CHANGES_REQUESTED' && review.author.toLowerCase() !== login.toLowerCase() && Date.parse(review.submittedAt) > after) ?? [];
  if (requested.length) lines.push({ tone: 'attention', text: `${requested.map((review) => review.author).join(', ')} requested changes` });
  return { lead, lines: lines.slice(0, 5) };
}

export type BlockerOwner = 'me' | 'author' | 'reviewer' | 'anyone';
export type BlockerAction =
  | { kind: 'rerun-failed' }
  | { kind: 'update-branch' }
  | { kind: 'resolve-conflicts' }
  | { kind: 'review' }
  | { kind: 'reply' }
  | { kind: 'show-threads'; count: number }
  | { kind: 'mark-ready' }
  | { kind: 'wait' }
  | { kind: 'open-on-github' };
export interface Blocker {
  /** What blocks, in a few words: "3 of 12 checks failing". */
  cause: string;
  action: BlockerAction;
  owner: BlockerOwner;
}
/** The order blockers are listed in: what unblocks the most first. */
const BLOCKER_ORDER: readonly BlockerAction['kind'][] = ['resolve-conflicts', 'rerun-failed', 'wait', 'update-branch', 'review', 'reply', 'show-threads', 'mark-ready', 'open-on-github'];

/**
 * Why the PR cannot merge, from its signals: each cause with its one next action and who can take it. Empty when it
 * can merge. A PR whose readiness Gnosis has not read yet has no blockers here: the step says so instead.
 */
export function mergeBlockers(member: Pick<ReviewMember, 'author' | 'isDraft' | 'baseBranch'>, signals: QueueSignals | undefined, login: string): Blocker[] {
  const status = signals?.readiness;
  if (!signals || !status) return [];
  const own = member.author.toLowerCase() === login.toLowerCase();
  const blockers: Blocker[] = [];
  if (status.isDraft || member.isDraft) blockers.push({ cause: 'Draft', action: { kind: 'mark-ready' }, owner: own ? 'me' : 'author' });
  if (status.mergeable === 'CONFLICTING' || status.mergeState === 'DIRTY')
    blockers.push({ cause: `Conflicts with ${status.baseBranch || member.baseBranch}`, action: { kind: 'resolve-conflicts' }, owner: 'anyone' });
  const { checks } = signals;
  if (checks.state === 'failure') blockers.push({ cause: `${checks.failed ?? 0} of ${checks.total} checks failing`, action: { kind: 'rerun-failed' }, owner: 'anyone' });
  else if (checks.state === 'pending') blockers.push({ cause: `${checks.running ?? 0} of ${checks.total} checks running`, action: { kind: 'wait' }, owner: 'anyone' });
  if (status.mergeState === 'BEHIND')
    blockers.push({ cause: `Behind ${status.baseBranch || member.baseBranch}${status.behindBy ? ` by ${status.behindBy} commit${status.behindBy === 1 ? '' : 's'}` : ''}`, action: { kind: 'update-branch' }, owner: 'anyone' });
  if (status.reviewDecision === 'CHANGES_REQUESTED') blockers.push({ cause: 'Changes requested', action: own ? { kind: 'reply' } : { kind: 'review' }, owner: own ? 'me' : 'author' });
  else if (status.reviewDecision === 'REVIEW_REQUIRED') blockers.push({ cause: 'Needs an approving review', action: { kind: 'review' }, owner: own ? 'reviewer' : 'me' });
  const unresolved = signals.threads?.unresolved.length ?? 0;
  if (unresolved && status.mergeState === 'BLOCKED')
    blockers.push({ cause: `${unresolved} unresolved thread${unresolved === 1 ? '' : 's'}`, action: { kind: 'show-threads', count: unresolved }, owner: 'anyone' });
  if (!blockers.length && status.mergeState === 'BLOCKED')
    blockers.push({ cause: 'Blocked by a branch rule Gnosis can’t see', action: { kind: 'open-on-github' }, owner: 'anyone' });
  return blockers.sort((a, b) => BLOCKER_ORDER.indexOf(a.action.kind) - BLOCKER_ORDER.indexOf(b.action.kind));
}

export type Depth = 'summary' | 'deep';
export interface DepthSuggestion {
  depth: Depth;
  /** The rule that chose it, as the step shows it: "Small update to code you reviewed (14 lines)." */
  reason: string;
}
/** An update this small to code you have reviewed reads well from the digest. */
export const SUMMARY_LINES = 50;

/** Summary or deep review, by the session's rules, and why. */
export function suggestDepth(step: Pick<SessionStep, 'kind' | 'member'>, rereviewLines: number | undefined): DepthSuggestion {
  const size = (step.member.additions ?? 0) + (step.member.deletions ?? 0);
  switch (step.kind) {
    case 'merge':
      return { depth: 'summary', reason: 'Approved and ready: merging needs no new read.' };
    case 'fix':
      return { depth: 'summary', reason: 'Your PR: clear what blocks it.' };
    case 'reply':
      return { depth: 'summary', reason: 'A reply waits on you: the thread is enough.' };
    case 'changes':
      return { depth: 'summary', reason: 'Changes were requested on your PR: read the review.' };
    case 'decide':
      return { depth: 'summary', reason: 'Stuck for over a week: decide whether it goes on.' };
    case 'rereview':
      if (rereviewLines !== undefined && rereviewLines < SUMMARY_LINES)
        return { depth: 'summary', reason: `Small update to code you reviewed (${rereviewLines} line${rereviewLines === 1 ? '' : 's'}).` };
      return { depth: 'deep', reason: rereviewLines !== undefined ? `Large update since your review (${rereviewLines} lines).` : 'Updated since your review.' };
    case 'review':
      return { depth: 'deep', reason: `First review: you haven't read this PR yet${size ? ` (${size} lines)` : ''}.` };
  }
}

/** The step's one primary action, as its button says it. */
export function primaryAction(step: Pick<SessionStep, 'kind'>, blockers: readonly Blocker[], depth: Depth): string {
  if (step.kind === 'merge') return 'Merge';
  const first = blockers.find((blocker) => blocker.owner !== 'author' && blocker.action.kind !== 'wait');
  if (step.kind === 'fix' && first?.action.kind === 'rerun-failed') return 'Rerun failed checks';
  if (step.kind === 'reply') return 'Reply';
  if (step.kind === 'decide') return 'Open';
  return depth === 'deep' ? 'Start review' : step.kind === 'rereview' ? 'Review the update' : step.kind === 'review' ? 'Review' : 'Open';
}

/** What happened to a step in this run. */
export type StepOutcome = 'done' | 'skipped' | 'parked' | 'opened' | 'open';
export interface RunSummary {
  done: number;
  total: number;
  lines: { id: string; outcome: StepOutcome; text: string }[];
}
const OUTCOME_WORD: Readonly<Record<StepOutcome, string>> = { done: 'Moved', skipped: 'Skipped', parked: 'Still waiting', opened: 'Opened', open: 'Still on your list' };
/** The end of a run: what moved, what you skipped, what still waits on something else. */
export function runSummary(steps: readonly Pick<SessionStep, 'id' | 'member'>[], outcomes: Readonly<Partial<Record<string, StepOutcome>>>): RunSummary {
  const lines = steps.map((step) => {
    const outcome = outcomes[step.id] ?? 'open';
    return { id: step.id, outcome, text: `${OUTCOME_WORD[outcome]}: #${step.member.number} ${step.member.title}` };
  });
  return { done: lines.filter((line) => line.outcome === 'done' || line.outcome === 'opened').length, total: lines.length, lines };
}
