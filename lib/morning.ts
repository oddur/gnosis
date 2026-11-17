/**
 * The Overview's morning page (#390): the questions a reviewer asks on arrival, in order. Pure; built from the lane
 * model (`lib/overview.ts`) and a few reads the page adds. See the last comment of #390 for the spec.
 *
 * 1. **Since yesterday:** `lib/since-log.ts`.
 * 2. **Move forward now:** quick wins across the lanes, cheapest first, each with one action and why it is quick.
 * 3. **Waiting on you:** people blocked on you, grouped by person, oldest wait first, and team requests.
 * 4. **Waiting on others:** your PRs grouped by what blocks them: each requested reviewer (with Nudge), teams, CI,
 *    an open base PR, and you (failing checks, conflicts).
 * 5. **Needs a decision:** your PRs failing, never approved or idle for over a week. Close or snooze them.
 *
 * **Effort heuristic** (`moveEffort`), in minutes, rough on purpose: it only orders the quick wins.
 * - Merge an approved, green PR: 1.
 * - Reply to a thread: 3.
 * - Re-review: 2, plus 1 for every 50 lines changed since your review (5 when the size is not known yet).
 * - A small review (at most `SMALL_REVIEW_LINES` lines; twice that with an explanation ready): 3, plus 1 for every
 *   40 lines. A ready explanation takes a third off.
 *
 * **Tab count** (`morningCount`): the PRs in Move forward now and Waiting on you, each PR once. Work on your own PRs
 * that waits on others, and decisions, are not counted.
 */
import { reviewRequest } from './attention';
import { waitingLabel, type OverviewModel, type OverviewRow } from './overview';
import type { QueueSignals } from './queue-signals';
import type { ReviewMember } from './workbench';

const DAY_MS = 86_400_000;
/** Quick wins listed at most. */
export const MOVE_LIMIT = 6;
/** A review this small, in changed lines, is a quick win. */
export const SMALL_REVIEW_LINES = 200;
/** Needs a decision: failing, never approved or idle for this long. */
export const DECISION_MS = 7 * DAY_MS;
/** Characters of a reply quoted on its row. */
export const QUOTE_LENGTH = 60;

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const lanes = (model: Pick<OverviewModel, 'lanes'>, lane: OverviewRow['lane']) => model.lanes.find((state) => state.lane === lane);
const rowLines = (row: Pick<OverviewRow, 'additions' | 'deletions'>) =>
  row.additions === undefined && row.deletions === undefined ? undefined : (row.additions ?? 0) + (row.deletions ?? 0);

export type MoveKind = 'merge' | 'rereview' | 'reply' | 'review';
export interface MoveItem {
  /** `move|${row.id}` */
  id: string;
  kind: MoveKind;
  row: OverviewRow;
  /** One line: "approved by lena · green", "+42 lines since your review", "lena: “Could we keep…”", "38 lines". */
  why: string;
  /** Estimated minutes (`moveEffort`). */
  minutes: number;
}
export interface MorningInput {
  model: Pick<OverviewModel, 'lanes'>;
  now: number;
  login: string;
  signals: (member: ReviewMember) => QueueSignals | undefined;
  /** Lines changed since your review, by PR URL (one compare read each). */
  rereviewLines?: Readonly<Record<string, number>>;
  /** The thread waiting on your reply, by PR URL: who wrote last and what. From the saved discussion. */
  replies?: Readonly<Record<string, { author: string; text: string }>>;
}

/** Minutes a quick win takes. See the heuristic at the top of this file. */
export function moveEffort(kind: MoveKind, lines: number | undefined, explanation = false): number {
  if (kind === 'merge') return 1;
  if (kind === 'reply') return 3;
  if (kind === 'rereview') return lines === undefined ? 5 : 2 + Math.ceil(lines / 50);
  const minutes = 3 + Math.ceil((lines ?? SMALL_REVIEW_LINES) / 40);
  return explanation ? Math.max(1, Math.round((minutes * 2) / 3)) : minutes;
}
/** "~10 min", "~1 h 20 min". */
export function effortLabel(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`;
  const rest = minutes % 60;
  return `~${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}
/** A comment as one quoted line: markdown and whitespace flattened, cut at a word near `QUOTE_LENGTH`. */
export function quote(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>.*$/gm, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= QUOTE_LENGTH) return flat;
  const cut = flat.slice(0, QUOTE_LENGTH + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > QUOTE_LENGTH * 0.6 ? cut.slice(0, space) : cut.slice(0, QUOTE_LENGTH)).replace(/[\s,.;:]+$/, '')}…`;
}

/** Move forward now: the quick wins, cheapest first, then the longest waiting, at most `MOVE_LIMIT`. */
export function moveForward(input: MorningInput): MoveItem[] {
  const { model } = input;
  const items: MoveItem[] = [];
  for (const row of lanes(model, 'merge')?.rows ?? []) {
    const member = row.merge?.member ?? row.focus;
    const signals = input.signals(member);
    if (!row.merge?.ready || signals?.headSha !== member.headSha || signals.checks.state !== 'success') continue;
    const review = row.merge.notes[0];
    const said = review.kind === 'approved' ? review.text.replace(/^Approved/, 'approved') : review.kind === 'no-review' ? 'no review required' : '';
    if (!said) continue;
    items.push({ id: `move|${row.id}`, kind: 'merge', row, why: `${said} · green`, minutes: moveEffort('merge', undefined) });
  }
  for (const row of lanes(model, 'review')?.rows ?? []) {
    if (row.reasons.includes('updated-since-review')) {
      const lines = input.rereviewLines?.[row.focus.url];
      items.push({
        id: `move|${row.id}`,
        kind: 'rereview',
        row,
        why: lines === undefined ? 'updated since your review' : `+${plural(lines, 'line', 'lines')} since your review`,
        minutes: moveEffort('rereview', lines),
      });
      continue;
    }
    const lines = rowLines(row);
    const explanation = !!row.explanation;
    if (lines === undefined || lines > SMALL_REVIEW_LINES * (explanation ? 2 : 1)) continue;
    items.push({
      id: `move|${row.id}`,
      kind: 'review',
      row,
      why: [plural(lines, 'line', 'lines'), explanation ? 'explanation ready' : ''].filter(Boolean).join(' · '),
      minutes: moveEffort('review', lines, explanation),
    });
  }
  for (const row of lanes(model, 'answer')?.rows ?? []) {
    if (!row.reasons.includes('replies')) continue;
    const reply = input.replies?.[row.focus.url];
    items.push({
      id: `move|${row.id}`,
      kind: 'reply',
      row,
      why: reply ? `${reply.author}: “${quote(reply.text)}”` : `${row.person ?? 'Someone'} is waiting on your reply`,
      minutes: moveEffort('reply', undefined),
    });
  }
  return items.sort((a, b) => a.minutes - b.minutes || a.row.since - b.row.since).slice(0, MOVE_LIMIT);
}
export const moveMinutes = (items: readonly Pick<MoveItem, 'minutes'>[]) => items.reduce((total, item) => total + item.minutes, 0);

export interface PersonGroup {
  /** `person:lena`, `team`, `team:org/name`, `ci`, `base:<url>`, `you`, `review`. */
  key: string;
  kind: 'person' | 'team' | 'ci' | 'base' | 'you' | 'review';
  /** "lena", "team", "CI", "base #380", "you". */
  label: string;
  /** "2 PRs · oldest 4 d", "3 running", "16 failing checks, 2 conflicts". */
  detail: string;
  rows: OverviewRow[];
  /** When the longest wait in the group began. */
  oldest: number;
  /** A requested reviewer of your PRs: Nudge re-requests their review on these PRs. */
  nudge?: { reviewer: string; members: ReviewMember[] };
}
const prs = (n: number) => plural(n, 'PR', 'PRs');

/**
 * Waiting on you: review requests and re-reviews by author, replies and change requests by who wrote, oldest wait
 * first. Team requests are one group at the end: "team · 3 review requests".
 */
export function waitingOnYou(input: Pick<MorningInput, 'model' | 'now' | 'login'>): PersonGroup[] {
  const people = new Map<string, PersonGroup>();
  const team: OverviewRow[] = [];
  const rows = [...(lanes(input.model, 'review')?.rows ?? []), ...(lanes(input.model, 'answer')?.rows ?? [])];
  for (const row of rows) {
    if (row.lane === 'review' && !row.reasons.includes('updated-since-review') && row.entries.every((entry) => reviewRequest(entry.member, input.login) === 'team')) {
      team.push(row);
      continue;
    }
    const person = row.person ?? (row.lane === 'review' ? row.focus.author : undefined) ?? 'someone';
    const key = `person:${person.toLowerCase()}`;
    const group = people.get(key) ?? { key, kind: 'person' as const, label: person, detail: '', rows: [], oldest: row.since };
    group.rows.push(row);
    group.oldest = Math.min(group.oldest, row.since);
    people.set(key, group);
  }
  const groups = [...people.values()].sort((a, b) => a.oldest - b.oldest || a.label.localeCompare(b.label));
  if (team.length) groups.push({ key: 'team', kind: 'team', label: 'team', detail: '', rows: team, oldest: Math.min(...team.map((row) => row.since)) });
  for (const group of groups) {
    group.rows.sort((a, b) => a.since - b.since);
    group.detail =
      group.kind === 'team'
        ? plural(group.rows.length, 'review request', 'review requests')
        : `${prs(group.rows.length)} · oldest ${waitingLabel(group.oldest, input.now)}`;
  }
  return groups;
}

/** Your open PRs' rows on the page: Fix, Merge (Ready and Parked), Waiting and Answer. A stack can have a row in each. */
function ownRows(model: Pick<OverviewModel, 'lanes'>): OverviewRow[] {
  return (['fix', 'merge', 'waiting', 'answer'] as const).flatMap((lane) => {
    const state = lanes(model, lane);
    return [...(state?.rows ?? []), ...(state?.parked ?? [])];
  });
}

/**
 * Waiting on others: your PRs by blocker. Each requested reviewer is a group with Nudge, oldest wait first; then
 * requested teams, PRs awaiting a reviewer nobody was asked to be, CI still running, an open base PR, and you.
 */
export function waitingOnOthers(input: Pick<MorningInput, 'model' | 'now' | 'login'>): PersonGroup[] {
  const { model, now, login } = input;
  const groups = new Map<string, PersonGroup>();
  const add = (key: string, make: () => Omit<PersonGroup, 'rows' | 'oldest' | 'detail'>, row: OverviewRow, member?: ReviewMember) => {
    const group = groups.get(key) ?? { ...make(), detail: '', rows: [], oldest: row.since };
    if (!group.rows.includes(row)) group.rows.push(row);
    group.oldest = Math.min(group.oldest, row.since);
    if (group.nudge && member && !group.nudge.members.some((entry) => entry.url === member.url)) group.nudge.members.push(member);
    groups.set(key, group);
  };
  for (const row of lanes(model, 'waiting')?.rows ?? []) {
    for (const entry of row.entries) {
      const member = entry.member;
      if (entry.reasons.includes('review-pending')) {
        const reviewers = member.requestedReviewers.filter((reviewer) => !same(reviewer, login));
        for (const reviewer of reviewers)
          add(`person:${reviewer.toLowerCase()}`, () => ({ key: `person:${reviewer.toLowerCase()}`, kind: 'person', label: reviewer, nudge: { reviewer, members: [] } }), row, member);
        for (const team of member.requestedTeams) add(`team:${team.toLowerCase()}`, () => ({ key: `team:${team.toLowerCase()}`, kind: 'team', label: team }), row);
        if (!reviewers.length && !member.requestedTeams.length) add('review', () => ({ key: 'review', kind: 'review', label: 'a reviewer' }), row);
      }
      if (entry.reasons.includes('checks-pending')) add('ci', () => ({ key: 'ci', kind: 'ci', label: 'CI' }), row);
    }
  }
  // An open base PR holds back the PRs above it.
  for (const row of ownRows(model)) {
    const subject = row.item.subject;
    for (const entry of row.entries) {
      const parent = subject.edges
        .filter((edge) => edge.child === entry.member.url)
        .map((edge) => subject.members.find((member) => member.url === edge.parent))
        .find((member) => member && member.state === 'open' && !member.merged);
      if (parent) add(`base:${parent.url}`, () => ({ key: `base:${parent.url}`, kind: 'base', label: `base #${parent.number}` }), row);
    }
  }
  const fix = lanes(model, 'fix')?.rows ?? [];
  for (const row of fix) add('you', () => ({ key: 'you', kind: 'you', label: 'you' }), row);
  const order: PersonGroup['kind'][] = ['person', 'team', 'review', 'ci', 'base', 'you'];
  const result = [...groups.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.oldest - b.oldest || a.label.localeCompare(b.label));
  for (const group of result) {
    group.rows.sort((a, b) => a.since - b.since);
    const n = group.rows.length;
    if (group.kind === 'ci') group.detail = `${n} running`;
    else if (group.kind === 'you') {
      const failing = group.rows.filter((row) => row.reasons.includes('checks-failed')).length;
      const conflicts = group.rows.filter((row) => row.reasons.includes('conflicts')).length;
      const restack = group.rows.filter((row) => row.reasons.includes('restack')).length;
      group.detail = [failing ? plural(failing, 'failing check', 'failing checks') : '', conflicts ? plural(conflicts, 'conflict', 'conflicts') : '', restack ? plural(restack, 'restack', 'restacks') : '']
        .filter(Boolean)
        .join(', ');
    } else group.detail = `${prs(n)} · ${waitingLabel(group.oldest, now)}`;
  }
  return result;
}

export type DecisionReason = 'failing' | 'unapproved' | 'idle';
export interface DecisionItem {
  /** `decide|${row.id}` */
  id: string;
  row: OverviewRow;
  /** The PR Close and Snooze act on. */
  member: ReviewMember;
  reason: DecisionReason;
  /** "Failing 12 d", "Never approved · 9 d", "Idle 9 d". */
  label: string;
  since: number;
}
/**
 * Needs a decision: your PRs failing checks for over a week, mergeable but never approved over a week after they
 * opened, or idle (no push, review or comment) for over a week. One reason each, in that order; oldest first.
 */
export function needsDecision(input: Pick<MorningInput, 'model' | 'now'>): DecisionItem[] {
  const { now } = input;
  const items: DecisionItem[] = [];
  const seen = new Set<string>();
  for (const row of ownRows(input.model)) {
    if (row.kind === 'stack' && row.entries.length > 1) continue;
    const member = row.focus;
    // One reason per PR: the first lane that gives one (Fix, then Merge, Waiting, Answer).
    if (seen.has(member.url)) continue;
    const updated = time(member.updatedAt) ?? now;
    const created = time(member.createdAt) ?? now;
    const days = (since: number) => waitingLabel(since, now);
    let item: Omit<DecisionItem, 'id' | 'row' | 'member'> | undefined;
    if (row.lane === 'fix' && row.reasons.includes('checks-failed') && now - row.since >= DECISION_MS) item = { reason: 'failing', label: `Failing ${days(row.since)}`, since: row.since };
    else if (row.merge && row.merge.notes[0]?.kind === 'unapproved' && now - created >= DECISION_MS) item = { reason: 'unapproved', label: `Never approved · ${days(created)}`, since: created };
    else if (now - updated >= DECISION_MS) item = { reason: 'idle', label: `Idle ${days(updated)}`, since: updated };
    if (item) {
      seen.add(member.url);
      items.push({ id: `decide|${row.id}`, row, member, ...item });
    }
  }
  return items.sort((a, b) => a.since - b.since || a.row.title.localeCompare(b.row.title));
}

/** The tab count: PRs in Move forward now and Waiting on you, each once. */
export function morningCount(move: readonly MoveItem[], you: readonly PersonGroup[]): number {
  return new Set([...move.flatMap((item) => item.row.entries.map((entry) => entry.member.url)), ...you.flatMap((group) => group.rows.flatMap((row) => row.entries.map((entry) => entry.member.url)))]).size;
}
/** Waiting on you, in PRs, each once. */
export const waitingOnYouCount = (you: readonly PersonGroup[]) => new Set(you.flatMap((group) => group.rows.flatMap((row) => row.entries.map((entry) => entry.member.url)))).size;

// ── Writes: Nudge and Close PR ──

/** Nudge: re-request `reviewer`'s review on each PR, through the requested-reviewers API. */
export function nudgeRequests(group: Pick<PersonGroup, 'nudge'>): { prUrl: string; action: 'nudge'; reviewer: string }[] {
  if (!group.nudge) return [];
  const { reviewer, members } = group.nudge;
  return members.map((member) => ({ prUrl: member.url, action: 'nudge' as const, reviewer }));
}
/** The confirmation's words for a nudge. */
export function nudgeConfirmation(group: Pick<PersonGroup, 'nudge'>): { title: string; body: string; action: string } {
  const reviewer = group.nudge?.reviewer ?? '';
  const members = group.nudge?.members ?? [];
  const list = members.map((member) => `#${member.number}`).join(', ');
  return {
    title: `Nudge ${reviewer}?`,
    body: `Gnosis asks GitHub to request ${reviewer}’s review again on ${members.length === 1 ? 'PR' : 'PRs'} ${list}. GitHub notifies ${reviewer}.`,
    action: members.length === 1 ? 'Re-request review' : `Re-request ${members.length} reviews`,
  };
}
/** Close PR: the request, with the optional comment trimmed (empty means none). */
export function closeRequest(
  state: { account: string; url: string; headSha: string; baseSha: string; baseBranch: string },
  comment: string
): { account: string; kind: 'close'; url: string; revisions: { url: string; headSha: string; baseSha: string; baseBranch: string }[]; comment?: string } {
  const body = comment.trim();
  return {
    account: state.account,
    kind: 'close',
    url: state.url,
    revisions: [{ url: state.url, headSha: state.headSha, baseSha: state.baseSha, baseBranch: state.baseBranch }],
    ...(body ? { comment: body } : {}),
  };
}
export function closeConfirmation(member: Pick<ReviewMember, 'number' | 'title' | 'repo'>): { title: string; body: string; action: string } {
  return {
    title: `Close #${member.number}?`,
    body: `${member.repo} #${member.number} “${member.title}” closes without merging. You can reopen it on GitHub later.`,
    action: 'Close PR',
  };
}
