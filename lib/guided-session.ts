/**
 * A guided session (#596): one run through what Overview says to do next, one PR at a time. Each step shows what
 * changed since you last looked, what blocks the PR with the action that clears it, and how deep to go: a summary is
 * enough, or a deep review. Pure: built from the morning page (`lib/morning.ts`), the queue signals and the extras the
 * page already reads; `now` is an argument, and nothing here reads the clock, storage or the network.
 *
 * - **Steps** (`sessionSteps`): Next up's items in Next up's order, then the quick wins Next up had no room for
 *   (approved, passing merges and failing checks to rerun: `NextUp.overflow`), then the PRs that need a decision. Next
 *   up already makes a stack one step with its next PR, so a session does too. A step is its item and the PR it acts
 *   on (`stepId`): once a stack's base merges, the stack's next PR is a new step.
 * - **Facts** (`stepFacts`): one line of what Gnosis already read: checks, how long it waited, reviewers, files.
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
  /** The Next up or decision item's id and the PR it acts on (`stepId`): stable while both stay on the page. */
  id: string;
  /** Next up's rows, the quick wins it had no room for (`more`), or the decisions. */
  source: 'next' | 'more' | 'decide';
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

/** A step's id: its item's, and the PR it acts on, so a stack whose base merged is a new step with its next PR. */
export const stepId = (itemId: string, member: Pick<ReviewMember, 'number'>) => `${itemId}|#${member.number}`;
const nextStep = (item: NextItem, source: 'next' | 'more'): SessionStep => ({
  id: stepId(item.id, item.member),
  source,
  kind: item.kind,
  row: item.row,
  member: item.member,
  title: item.title,
  why: item.why,
  urls: item.urls,
  check: item.check,
  ...(item.unblocks ? { unblocks: item.unblocks } : {}),
  next: item,
});
/** A run takes this many of the quick wins and of the decisions: a long backlog is a list to work through, not a run. */
export const QUICK_IN_RUN = 10;
export const DECIDE_IN_RUN = 10;
/**
 * Next up's items, then the quick wins it had no room for, then the decisions, at most `QUICK_IN_RUN` and
 * `DECIDE_IN_RUN` of each, in the Overview's order. Each PR once: a step whose PR an earlier step lists is left out.
 */
export function sessionSteps(page: { next: Pick<MorningPage['next'], 'items'> & Partial<Pick<MorningPage['next'], 'overflow'>>; decide: MorningPage['decide'] }): SessionStep[] {
  const steps: SessionStep[] = page.next.items.map((item) => nextStep(item, 'next'));
  const listed = new Set(steps.flatMap((step) => step.urls));
  for (const item of page.next.overflow ?? []) {
    if (steps.filter((step) => step.source === 'more').length >= QUICK_IN_RUN) break;
    if (item.urls.some((url) => listed.has(url))) continue;
    steps.push(nextStep(item, 'more'));
    for (const url of item.urls) listed.add(url);
  }
  for (const item of page.decide) {
    if (steps.filter((step) => step.source === 'decide').length >= DECIDE_IN_RUN) break;
    if (listed.has(item.member.url)) continue;
    steps.push({ id: stepId(item.id, item.member), source: 'decide', kind: 'decide', row: item.row, member: item.member, title: item.member.title, why: item.label, urls: [item.member.url], check: item.check, decide: item });
  }
  return steps;
}
/**
 * What a run holds, for its Start button: "5 + 2 quick + 2 decisions", or "5 + 10 of 110 decisions" when the run takes
 * only the first of a long list (`decideTotal`: how many the Overview has).
 */
export function runScope(steps: readonly Pick<SessionStep, 'source'>[], decideTotal?: number): string {
  const count = (source: SessionStep['source']) => steps.filter((step) => step.source === source).length;
  const more = count('more');
  const decide = count('decide');
  const decisions = decideTotal !== undefined && decideTotal > decide ? `${decide} of ${decideTotal} decisions` : `${decide} decision${decide === 1 ? '' : 's'}`;
  return [String(count('next')), more ? `${more} quick` : '', decide ? decisions : ''].filter(Boolean).join(' + ');
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

/** "12 minutes", "3 hours", "4 days": how long something has lasted. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
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
  const held = heldForkRuns(member, signals);
  if (held) lines.push({ tone: 'attention', text: `${held} workflow run${held === 1 ? '' : 's'} wait${held === 1 ? 's' : ''} for a maintainer’s approval` });
  if (checks && checks.state === 'failure' && (checks.failed ?? 0) - held > 0) lines.push({ tone: 'danger', text: `${(checks.failed ?? 0) - held} of ${checks.total} checks failing${turn?.type === 'checks-red' ? ` since ${ago(turn.at, now)}` : ''}` });
  else if (checks && checks.state === 'pending') lines.push({ tone: 'neutral', text: `${checks.running ?? 0} of ${checks.total} checks running` });
  else if (turn?.type === 'checks-green') lines.push({ tone: 'success', text: `Checks passing again since ${ago(turn.at, now)}` });
  const unresolved = signals?.threads?.unresolved.length ?? 0;
  if (unresolved) lines.push({ tone: 'neutral', text: `${unresolved}${signals?.threads?.complete === false ? '+' : ''} unresolved thread${unresolved === 1 ? '' : 's'}` });
  const requested = signals?.opinions?.filter((review) => review.state === 'CHANGES_REQUESTED' && review.author.toLowerCase() !== login.toLowerCase() && Date.parse(review.submittedAt) > after) ?? [];
  if (requested.length) lines.push({ tone: 'attention', text: `${requested.map((review) => review.author).join(', ')} requested changes` });
  return { lead, lines: lines.slice(0, 5) };
}

/**
 * How many of the PR's workflow runs from a fork wait for a maintainer's approval (#595): checks GitHub reports as
 * ACTION_REQUIRED on a PR whose head repository is not its base. 0 when the PR is not from a fork, when Gnosis can't
 * tell (no head or base repository, or signals from before `awaitingApproval` was read), or when none wait.
 */
export function heldForkRuns(member: Partial<Pick<ReviewMember, 'headRepo' | 'baseRepo' | 'headRepoUnknown'>>, signals: Pick<QueueSignals, 'checks'> | undefined): number {
  const held = signals?.checks.awaitingApproval ?? 0;
  if (!held || !member.baseRepo) return 0;
  // A deleted fork has no head repository, and is still a fork.
  const fork = member.headRepoUnknown === true || (!!member.headRepo && member.headRepo.toLowerCase() !== member.baseRepo.toLowerCase());
  return fork ? held : 0;
}

/** One fact on a step's facts row (`stepFacts`). `unknown`: Gnosis has not read it, and says so. */
export interface StepFact {
  key: 'checks' | 'waited' | 'reviews' | 'files';
  text: string;
  tone?: DigestTone;
  unknown?: boolean;
  /** The whole fact, when the text is cut short: every reviewer, every path. */
  title?: string;
}
const REVIEW_STATE: Readonly<Record<string, string>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };
/**
 * The facts row: what Gnosis already read about the PR, on one line, from data the page has. Checks passed and
 * failed (always, not only when failing), how long it has waited, its reviewers and their states, and its top three
 * changed files when they are loaded. Fail closed: what is not read says "not read yet", never a guess. Status read
 * for an older commit does not count for the checks.
 */
export function stepFacts(input: { member: Pick<ReviewMember, 'author' | 'headSha' | 'requestedReviewers'>; signals: QueueSignals | undefined; since: number | undefined; now: number; login: string; paths?: readonly string[] }): StepFact[] {
  const { member, signals, since, now, login } = input;
  const facts: StepFact[] = [];
  const checks = signals && signals.headSha === member.headSha ? signals.checks : undefined;
  if (!checks) facts.push({ key: 'checks', text: 'Checks not read yet', unknown: true });
  else if (!checks.total) facts.push({ key: 'checks', text: 'No checks' });
  else {
    const failed = checks.failed ?? 0;
    const running = checks.running ?? 0;
    const parts = [`${checks.passed} passed`, failed ? `${failed} failed` : '', running ? `${running} running` : ''].filter(Boolean);
    facts.push({ key: 'checks', text: `Checks ${parts.join(', ')}`, tone: failed ? 'danger' : running ? 'neutral' : 'success' });
  }
  if (since !== undefined && Number.isFinite(since)) facts.push({ key: 'waited', text: `Waiting ${span(now - since)}` });
  if (!signals?.opinions) facts.push({ key: 'reviews', text: 'Reviews not read yet', unknown: true });
  else {
    const me = login.toLowerCase();
    const latest = new Map<string, string>();
    for (const review of [...signals.opinions].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
      if (review.author.toLowerCase() === member.author.toLowerCase()) continue;
      latest.set(review.author, review.state);
    }
    const said = [...latest].map(([author, state]) => `${author.toLowerCase() === me ? 'you' : author} ${REVIEW_STATE[state] ?? 'reviewed'}`);
    const asked = member.requestedReviewers.filter((name) => !latest.has(name)).map((name) => (name.toLowerCase() === me ? 'your review requested' : `${name} requested`));
    const all = [...said, ...asked];
    facts.push(all.length
      ? { key: 'reviews', text: all.length > 3 ? `${all.slice(0, 3).join(', ')} +${all.length - 3}` : all.join(', '), title: all.join(', ') }
      : { key: 'reviews', text: 'No reviewers' });
  }
  if (input.paths?.length) {
    const top = input.paths.slice(0, 3);
    const rest = input.paths.length - top.length;
    facts.push({ key: 'files', text: `${top.join(', ')}${rest ? ` +${rest} more` : ''}`, title: input.paths.join('\n') });
  }
  return facts;
}

/**
 * The evidence on a decision ("Stuck for over a week"): when anything last happened, and who the PR is waiting on.
 * `remind`: the requested reviewer a Remind would nudge, when there is one.
 */
export function decideEvidence(member: Pick<ReviewMember, 'updatedAt' | 'requestedReviewers'>, reason: 'failing' | 'unapproved' | 'idle' | undefined, now: number): { lines: string[]; remind?: string } {
  const updated = Date.parse(member.updatedAt);
  const lines = [Number.isFinite(updated) ? `Last activity ${ago(updated, now)}` : 'Last activity not known'];
  const reviewers = member.requestedReviewers;
  if (reviewers.length) lines.push(`Waiting on ${reviewers.join(', ')} to review`);
  else if (reason === 'failing') lines.push('Waiting on you: its checks fail');
  else lines.push('No reviewer requested');
  return { lines, ...(reviewers.length ? { remind: reviewers[0] } : {}) };
}

/** The depth line says something only where reading is the choice: a review or a re-review. */
export const showsDepth = (kind: StepKind) => kind === 'review' || kind === 'rereview';

export type BlockerOwner = 'me' | 'author' | 'reviewer' | 'maintainer' | 'anyone';
export type BlockerAction =
  | { kind: 'rerun-failed' }
  | { kind: 'update-branch' }
  | { kind: 'resolve-conflicts' }
  | { kind: 'review' }
  | { kind: 'reply' }
  | { kind: 'show-threads'; count: number }
  | { kind: 'mark-ready' }
  | { kind: 'approve-workflows'; count: number }
  | { kind: 'wait' }
  | { kind: 'open-on-github' };
export interface Blocker {
  /** What blocks, in a few words: "3 of 12 checks failing". */
  cause: string;
  action: BlockerAction;
  owner: BlockerOwner;
}
/** The order blockers are listed in: what unblocks the most first. */
const BLOCKER_ORDER: readonly BlockerAction['kind'][] = ['approve-workflows', 'resolve-conflicts', 'rerun-failed', 'wait', 'update-branch', 'review', 'reply', 'show-threads', 'mark-ready', 'open-on-github'];

/**
 * Why the PR cannot merge, from its signals: each cause with its one next action and who can take it. Empty when it
 * can merge. A PR whose readiness Gnosis has not read yet has no blockers here: the step says so instead.
 */
export function mergeBlockers(member: Pick<ReviewMember, 'author' | 'isDraft' | 'baseBranch'> & Partial<Pick<ReviewMember, 'headRepo' | 'baseRepo' | 'headRepoUnknown'>>, signals: QueueSignals | undefined, login: string): Blocker[] {
  const status = signals?.readiness;
  if (!signals || !status) return [];
  const own = member.author.toLowerCase() === login.toLowerCase();
  const blockers: Blocker[] = [];
  if (status.isDraft || member.isDraft) blockers.push({ cause: 'Draft', action: { kind: 'mark-ready' }, owner: own ? 'me' : 'author' });
  if (status.mergeable === 'CONFLICTING' || status.mergeState === 'DIRTY')
    blockers.push({ cause: `Conflicts with ${status.baseBranch || member.baseBranch}`, action: { kind: 'resolve-conflicts' }, owner: 'anyone' });
  const { checks } = signals;
  // Fork workflow runs GitHub holds for a maintainer's approval (#595): nothing runs until one approves them. They
  // count as failed in `failed`, so they come off it here. Only when the counts carry them and the PR is from a fork:
  // in the same repository, ACTION_REQUIRED means something else and stays a failure.
  const held = heldForkRuns(member, signals);
  if (held) blockers.push({ cause: `${held} workflow run${held === 1 ? '' : 's'} from a fork wait${held === 1 ? 's' : ''} for a maintainer’s approval`, action: { kind: 'approve-workflows', count: held }, owner: 'maintainer' });
  const failed = (checks.failed ?? 0) - held;
  if (checks.state === 'failure' && (failed > 0 || !held)) blockers.push({ cause: `${failed} of ${checks.total} checks failing`, action: { kind: 'rerun-failed' }, owner: 'anyone' });
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

/**
 * Paths whose changes get a full read whatever their size, each with the words a reason uses. Matched on the path's
 * segments, case-insensitive; the first match names the reason.
 */
const RISKY_PATHS: readonly { test: RegExp; what: string }[] = [
  { test: /^\.github\/(workflows|actions)\//i, what: 'a CI workflow' },
  { test: /(^|\/)CODEOWNERS$/i, what: 'code owners' },
  { test: /(^|\/)(migrations?|migrate)\//i, what: 'a database migration' },
  { test: /(^|[/._-])(auth|authn|authz|oauth|security|crypto|permissions?|secrets?|credentials?|passwords?)([/._-]|$)/i, what: 'security-sensitive code' },
  { test: /(\.tf|\.tfvars)$|(^|\/)(terraform|helm|k8s|kubernetes|infra)\//i, what: 'infrastructure' },
  { test: /(^|\/)Dockerfile[^/]*$/i, what: 'a container build' },
];
/** What makes a path risky, in a few words ("a CI workflow"), or undefined when nothing does. */
export function riskyPath(path: string): string | undefined {
  return RISKY_PATHS.find((rule) => rule.test.test(path))?.what;
}
/** GitHub's author associations for someone with no merged commits in the repository yet, as a reason says it. */
const NEW_AUTHOR: Readonly<Partial<Record<string, (author: string) => string>>> = {
  FIRST_TIMER: (author) => `${author}'s first PR on GitHub`,
  FIRST_TIME_CONTRIBUTOR: (author) => `${author}'s first PR in this repository`,
  NONE: (author) => `${author} has no merged commits here yet`,
};
/** What else the depth rules read, when Gnosis has it. Unknown facts make no rule fire. */
export interface DepthContext {
  /** The PR's changed paths. Undefined when not read. */
  paths?: readonly string[];
  /** GitHub's `authorAssociation` for the author (`QueueSignals.authorAssociation`). */
  authorAssociation?: string;
}

/**
 * Summary or deep review, by the session's rules, and why. On someone else's PR to review, two rules come first and
 * ask for a deep review whatever the size: it touches a risky path (`riskyPath`), or its author is new to the
 * repository.
 */
export function suggestDepth(step: Pick<SessionStep, 'kind' | 'member'>, rereviewLines: number | undefined, context: DepthContext = {}): DepthSuggestion {
  const size = (step.member.additions ?? 0) + (step.member.deletions ?? 0);
  if (step.kind === 'review' || step.kind === 'rereview') {
    for (const path of context.paths ?? []) {
      const what = riskyPath(path);
      if (what) return { depth: 'deep', reason: `Touches ${what} (${path}).` };
    }
    const newcomer = context.authorAssociation ? NEW_AUTHOR[context.authorAssociation] : undefined;
    if (newcomer) return { depth: 'deep', reason: `${newcomer(step.member.author)}.` };
  }
  switch (step.kind) {
    case 'merge':
      return { depth: 'summary', reason: 'Approved and ready to merge.' };
    case 'fix':
      return { depth: 'summary', reason: 'Your PR. Clear what blocks it.' };
    case 'reply':
      return { depth: 'summary', reason: 'A reply waits on you, and the thread has what you need.' };
    case 'changes':
      return { depth: 'summary', reason: 'Changes were requested. The review says what.' };
    case 'decide':
      return { depth: 'summary', reason: 'Stuck for over a week. Move it on, or close it.' };
    case 'rereview':
      if (rereviewLines !== undefined && rereviewLines < SUMMARY_LINES)
        return { depth: 'summary', reason: `Small update to code you reviewed (${rereviewLines} line${rereviewLines === 1 ? '' : 's'}).` };
      return { depth: 'deep', reason: rereviewLines !== undefined ? `Large update since your review (${rereviewLines} lines).` : 'Updated since your review.' };
    case 'review':
      return { depth: 'deep', reason: `You haven’t read this PR yet${size ? ` (${size} lines)` : ''}.` };
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
export type StepOutcome = 'done' | 'skipped' | 'snoozed' | 'muted' | 'parked' | 'opened' | 'open';
export interface RunSummary {
  /** Steps that changed on GitHub: merged, approved, answered, closed, or left the list. */
  done: number;
  /** Steps only opened: not counted as moved. */
  opened: number;
  /** Parked steps whose action has not resolved yet. */
  waiting: number;
  total: number;
  lines: { id: string; outcome: StepOutcome; text: string }[];
  /** The steps by what happened to them, in this order: moved, waiting, opened, snoozed, muted, skipped, still on the list. */
  groups: { outcome: StepOutcome; label: string; steps: { id: string; index: number; text: string }[] }[];
}
const OUTCOME_WORD: Readonly<Record<StepOutcome, string>> = { done: 'Moved', skipped: 'Skipped', snoozed: 'Snoozed', muted: 'Muted', parked: 'Still waiting', opened: 'Opened', open: 'Still on your list' };
const GROUP_ORDER: readonly StepOutcome[] = ['done', 'parked', 'opened', 'snoozed', 'muted', 'skipped', 'open'];
const GROUP_LABEL: Readonly<Record<StepOutcome, string>> = { done: 'Moved', parked: 'Waiting on checks', opened: 'Opened', snoozed: 'Snoozed', muted: 'Muted', skipped: 'Skipped', open: 'Still on your list' };
/** The end of a run: what moved, what you skipped, what still waits on something else. */
export function runSummary(steps: readonly Pick<SessionStep, 'id' | 'member'>[], outcomes: Readonly<Partial<Record<string, StepOutcome>>>): RunSummary {
  const lines = steps.map((step) => {
    const outcome = outcomes[step.id] ?? 'open';
    return { id: step.id, outcome, text: `${OUTCOME_WORD[outcome]}: #${step.member.number} ${step.member.title}` };
  });
  const groups = GROUP_ORDER.map((outcome) => ({
    outcome,
    label: GROUP_LABEL[outcome],
    steps: steps.flatMap((step, index) => ((outcomes[step.id] ?? 'open') === outcome ? [{ id: step.id, index, text: `#${step.member.number} ${step.member.title}` }] : [])),
  })).filter((group) => group.steps.length);
  // Only a change on GitHub moved a PR forward: one you only opened is counted apart.
  return { done: lines.filter((line) => line.outcome === 'done').length, opened: lines.filter((line) => line.outcome === 'opened').length, waiting: lines.filter((line) => line.outcome === 'parked').length, total: lines.length, lines, groups };
}

/** A slow action started from the session, whose result comes later: a rerun's checks, or an update's new head. */
export type ParkAction = 'rerun-failed' | 'update-branch';
/** A step parked while its action runs: the session moves on, and the step comes back when the action resolves. */
export interface Park {
  action: ParkAction;
  /** The PR's head when the action started. */
  headSha: string;
  at: number;
  /** The checks were seen running since: a rerun's red is no longer the old red. */
  running?: boolean;
}
export interface ParkResult {
  /** `done`: the PR moved on. `open`: it needs you again. */
  outcome: 'done' | 'open';
  tone: DigestTone;
  text: string;
}
/** How long a parked step waits for its result before it comes back anyway, saying none came. */
export const PARK_LIMIT = 30 * 60_000;

const failing = (checks: QueueSignals['checks']) => `${checks.failed ?? 0} of ${checks.total} check${checks.total === 1 ? '' : 's'} failing`;
/**
 * A parked step against what GitHub says now: still waiting (the park, maybe updated), or its result. Pure: `headSha`
 * is the PR's head as the page has it now, `signals` its status, `now` the time.
 *
 * - **Rerun failed checks:** waits until the checks have run again. A red read before any running is the old red.
 * - **Update branch:** waits for the new head, then for its checks.
 * - Either way, past `PARK_LIMIT` with nothing running the step comes back, saying no result came. Running checks are
 *   waited for. Gnosis never reads a result it can't see as good: status not read for the head keeps waiting.
 */
export function settlePark(park: Park, headSha: string, signals: QueueSignals | undefined, now: number): { park: Park } | { result: ParkResult } {
  const late = now - park.at > PARK_LIMIT;
  const waited: { result: ParkResult } = {
    result: {
      outcome: 'open',
      tone: 'attention',
      text: park.action === 'rerun-failed' ? 'No result from the rerun after 30 minutes.' : 'The branch update shows no result after 30 minutes.',
    },
  };
  // Status for another head, or none yet: nothing to read a result from.
  const current = signals && signals.headSha === headSha ? signals : undefined;
  if (park.action === 'rerun-failed') {
    if (headSha !== park.headSha) return { result: { outcome: 'open', tone: 'neutral', text: 'New commits came in after the rerun.' } };
    if (!current) return late ? waited : { park };
    const { checks } = current;
    if (checks.state === 'pending') return { park: park.running ? park : { ...park, running: true } };
    if (checks.state === 'success') return { result: { outcome: 'done', tone: 'success', text: 'Checks pass after the rerun.' } };
    if (checks.state === 'failure' && park.running) return { result: { outcome: 'open', tone: 'danger', text: `Still ${failing(checks)} after the rerun.` } };
    return late ? waited : { park };
  }
  // Update branch: first the new head, then its checks.
  if (headSha === park.headSha || !current) return late ? waited : { park };
  const { checks } = current;
  if (checks.state === 'pending') return { park: park.running ? park : { ...park, running: true } };
  if (checks.state === 'failure') return { result: { outcome: 'open', tone: 'danger', text: `Branch updated; ${failing(checks)}.` } };
  return { result: { outcome: 'done', tone: 'success', text: checks.state === 'success' ? 'Branch updated; checks pass.' : 'Branch updated.' } };
}
