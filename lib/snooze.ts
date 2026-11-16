/**
 * Snooze (#324): hide a PR or a stack until a time or until something happens, then bring it back.
 *
 * Pure, so main, the browser fixture and unit tests share one reading. Detection makes no GitHub reads: each
 * snooze keeps a basis saved when it was snoozed, and every observation Gnosis already makes (discovery, the
 * status batch for changed PRs, the own-PR sweep) is compared with that basis, never with the previous poll.
 * So a signal that arrived while the app was closed is found by the first observation after launch.
 */
import { isAutomationActor, sameLogin } from './github-actors';
import type { QueueSignals } from './queue-signals';
import type { QueueItem, ReviewMember } from './workbench';

/** What a snooze waits for besides its time. */
export type SnoozeOn = 'activity' | 'checks';
/** One wake signal. "activity" is review, comment, commits, requested and ready; "checks" is checks and review. */
export type WakeSignal = 'review' | 'comment' | 'commits' | 'requested' | 'ready' | 'checks';
export type WakeReason =
  | { kind: 'review'; actor: string }
  | { kind: 'comment'; actor?: string }
  | { kind: 'commits'; actor?: string }
  | { kind: 'requested' }
  | { kind: 'ready' }
  | { kind: 'checks'; state: 'passed' | 'failed' }
  | { kind: 'time' }
  | { kind: 'ceiling' };

/** A snooze with no time ends after this, so a quiet PR still comes back. */
export const SNOOZE_CEILING_MS = 14 * 86_400_000;
/** The "Back" line stays this long at most, even while the PR stays unread. */
export const BACK_RETENTION_MS = 7 * 86_400_000;
export const SNOOZE_LIMIT = 1000;

export type SnoozedPrSummary = Pick<ReviewMember, 'url' | 'repo' | 'number' | 'title' | 'author' | 'state' | 'merged' | 'isDraft'>;
export type SnoozeMember = Pick<ReviewMember, 'url' | 'author' | 'headSha' | 'state' | 'merged' | 'isDraft' | 'requestedReviewers'>;

/** What the PR looked like when it was snoozed, plus the check runs seen since. */
export interface SnoozeBasis {
  headSha: string;
  isDraft: boolean;
  /** A review is requested from the reader by name. */
  requested: boolean;
  /** GitHub's comment total, for status saved before recent activity was read. */
  comments?: number;
  /**
   * Checks of `head`. `armed`: they can still finish after the snooze, because they were running or the head is
   * new. `success`: when a passing result was first seen; a pass counts once it is seen twice, so a gap between
   * two workflows does not end the snooze.
   */
  checks?: { head: string; armed: boolean; success?: number };
}
export interface SnoozeEntry {
  member: SnoozedPrSummary;
  /** PRs snoozed together, such as a stack, share a group. A signal on any of them wakes all. */
  group: string;
  snoozedAt: number;
  until?: number;
  on: SnoozeOn[];
  /** The reader authored the PR. */
  own: boolean;
  basis: SnoozeBasis;
}
/** One row of Tools › Snoozed. */
export type SnoozedPr = Omit<SnoozeEntry, 'basis'>;
/** Why a PR came back. Shown as its "Back" line until the PR is read. */
export interface SnoozeBack {
  reason: WakeReason;
  at: number;
  snoozedAt: number;
  /** The stack member whose signal woke the group, when it is another PR. */
  via?: number;
}
export type SnoozeRequest =
  /** Each group is snoozed together. URLs only: main snoozes the PRs it knows. */
  | { action: 'snooze'; groups: string[][]; until?: number; on: SnoozeOn[] }
  /** With `mute`, the PRs are muted instead: "not mine" rather than "not now". */
  | { action: 'unsnooze'; urls: string[]; mute?: boolean }
  /** Undo a snooze, an unsnooze or a change: the PRs return to how they were. */
  | { action: 'undo'; token: string };
export interface SnoozeResult<Q> {
  queue: Q;
  /** Undoes this change. */
  undo?: string;
  /** The PRs this change snoozed or unsnoozed. */
  urls: string[];
}
export interface SnoozeObservation {
  member: SnoozeMember;
  signals?: QueueSignals;
}

const open = (member: Pick<ReviewMember, 'state' | 'merged'>) => member.state === 'open' && !member.merged;
const requestedFrom = (member: SnoozeMember, login: string) => member.requestedReviewers.some((reviewer) => sameLogin(reviewer, login));

export function summaryOf({ url, repo, number, title, author, state, merged, isDraft }: SnoozedPrSummary): SnoozedPrSummary {
  return { url, repo, number, title, author, state, merged, isDraft };
}

/** The signals that end a snooze. A time also ends on a review or a review request; checks also end on a review. */
export function wakeSignals(entry: Pick<SnoozeEntry, 'until' | 'on' | 'own'>): ReadonlySet<WakeSignal> {
  const signals = new Set<WakeSignal>();
  if (entry.until !== undefined) signals.add('review').add('requested');
  if (entry.on.includes('activity')) {
    signals.add('review').add('comment').add('requested').add('ready');
    if (!entry.own) signals.add('commits');
  }
  if (entry.on.includes('checks') && entry.own) signals.add('checks').add('review');
  return signals;
}

/** A snooze without a time ends at its ceiling. */
export const snoozeDeadline = (entry: Pick<SnoozeEntry, 'until' | 'snoozedAt' | 'on'>) =>
  entry.until ?? entry.snoozedAt + SNOOZE_CEILING_MS;

/** The basis saved with a new snooze, from the PR and its saved status. */
export function snoozeBasis(member: SnoozeMember, signals: QueueSignals | undefined, login: string): SnoozeBasis {
  const current = signals && signals.url === member.url ? signals : undefined;
  return {
    headSha: member.headSha,
    isDraft: member.isDraft,
    requested: requestedFrom(member, login),
    ...(current ? { comments: current.comments } : {}),
    checks: { head: member.headSha, armed: current?.headSha === member.headSha && current.checks.state === 'pending' },
  };
}

type ActivityEvent = { kind: 'comment' | 'review'; author: string; at: string; automated: boolean; minimized?: boolean };
/** Comments and reviews in the signals, from recent activity when it was read, otherwise the newest of each. */
function activityEvents(signals: QueueSignals): ActivityEvent[] {
  const activity = signals.activity;
  const events: ActivityEvent[] = activity?.recent
    ? [...activity.recent]
    : [
        ...(activity?.comment ? [{ kind: 'comment' as const, ...activity.comment, automated: isAutomationActor({ login: activity.comment.author }) }] : []),
        ...(activity?.review ? [{ kind: 'review' as const, ...activity.review, automated: isAutomationActor({ login: activity.review.author }) }] : []),
      ];
  const latest = signals.latestReview;
  if (latest && !events.some((event) => event.kind === 'review' && event.at === latest.submittedAt && sameLogin(event.author, latest.author)))
    events.push({ kind: 'review', author: latest.author, at: latest.submittedAt, automated: isAutomationActor({ login: latest.author }) });
  return events;
}
/** The reader's own push: they wrote the head commit and committed it themselves or on GitHub's web interface. */
const ownCommit = (head: { author: string | null; committer: string | null }, login: string) =>
  sameLogin(head.author, login) && (head.committer === null || sameLogin(head.committer, login) || sameLogin(head.committer, 'web-flow'));

export interface ObserveResult {
  /** The PR closed or merged: the snooze ends silently. */
  end?: boolean;
  wake?: WakeReason;
  /** The entry with a newer basis, to save. */
  entry?: SnoozeEntry;
}
/**
 * Compares one observation with a snooze's basis. `own` marks a write the reader made in Gnosis: the basis
 * follows it and nothing wakes. The reader's own reviews, comments and pushes, bots, minimized comments, status
 * from before the snooze and checks of an older head never wake a PR.
 */
export function observeSnooze(entry: SnoozeEntry, observation: SnoozeObservation, context: { login: string; own?: boolean }): ObserveResult {
  const { member } = observation;
  const { login } = context;
  if (member.url !== entry.member.url) return {};
  if (!open(member)) return { end: true };
  const basis = entry.basis;
  if (context.own) {
    const next: SnoozeBasis = { ...basis, headSha: member.headSha, isDraft: member.isDraft, requested: requestedFrom(member, login) };
    return next.headSha === basis.headSha && next.isDraft === basis.isDraft && next.requested === basis.requested ? {} : { entry: { ...entry, basis: next } };
  }
  const want = wakeSignals(entry);
  if (want.has('requested') && !basis.requested && requestedFrom(member, login) && !sameLogin(member.author, login))
    return { wake: { kind: 'requested' } };
  if (want.has('ready') && basis.isDraft && !member.isDraft) return { wake: { kind: 'ready' } };
  const signals = observation.signals && observation.signals.url === member.url && observation.signals.checkedAt > entry.snoozedAt
    ? observation.signals
    : undefined;
  if (want.has('commits') && member.headSha !== basis.headSha) {
    const head = signals?.headSha === member.headSha ? signals.activity?.head : undefined;
    const bot = !!head?.author && isAutomationActor({ login: head.author });
    if (!head || (!ownCommit(head, login) && !bot)) return { wake: { kind: 'commits', ...(head?.author ? { actor: head.author } : {}) } };
  }
  if (!signals) return {};
  const events = activityEvents(signals).filter(
    (event) => Date.parse(event.at) > entry.snoozedAt && !event.automated && !event.minimized && !sameLogin(event.author, login)
  );
  const review = events.find((event) => event.kind === 'review');
  if (want.has('review') && review) return { wake: { kind: 'review', actor: review.author } };
  if (want.has('comment')) {
    const comment = events.find((event) => event.kind === 'comment');
    if (comment) return { wake: { kind: 'comment', actor: comment.author } };
    // Status saved before recent activity was read knows only the total.
    if (!signals.activity && basis.comments !== undefined && signals.comments > basis.comments) return { wake: { kind: 'comment' } };
  }
  if (want.has('checks') && signals.headSha === member.headSha) {
    const known = basis.checks?.head === member.headSha ? basis.checks : undefined;
    const checks = known ?? { head: member.headSha, armed: member.headSha !== basis.headSha };
    const state = signals.checks.state;
    let next = checks;
    if (state === 'pending') next = { head: member.headSha, armed: true };
    else if (checks.armed && state === 'failure') return { wake: { kind: 'checks', state: 'failed' } };
    else if (checks.armed) {
      if (checks.success !== undefined && signals.checkedAt > checks.success) return { wake: { kind: 'checks', state: 'passed' } };
      next = { ...checks, success: checks.success ?? signals.checkedAt };
    }
    if (next !== known) return { entry: { ...entry, basis: { ...basis, checks: next } } };
  }
  return {};
}

/** A snooze whose time or ceiling has passed. */
export function dueReason(entry: Pick<SnoozeEntry, 'until' | 'snoozedAt' | 'on'>, now: number): WakeReason | undefined {
  if (entry.until !== undefined) return entry.until <= now ? { kind: 'time' } : undefined;
  return entry.snoozedAt + SNOOZE_CEILING_MS <= now ? { kind: 'ceiling' } : undefined;
}

export interface GroupWake {
  /** Every PR of the group, which all come back. */
  urls: string[];
  /** The PR whose signal or time woke the group. */
  trigger: string;
  reason: WakeReason;
  snoozedAt: number;
}
export interface SnoozeChanges {
  wakes: GroupWake[];
  /** Closed or merged PRs whose snooze ended silently. */
  ended: string[];
  /** Entries with a newer basis. */
  updated: SnoozeEntry[];
}
/** Wakes whole groups: a signal on any member brings every member of its group back. */
export function groupWakes(entries: ReadonlyMap<string, SnoozeEntry>, found: { url: string; reason: WakeReason }[]): GroupWake[] {
  const wakes: GroupWake[] = [];
  const done = new Set<string>();
  for (const { url, reason } of found) {
    const entry = entries.get(url);
    if (!entry || done.has(entry.group)) continue;
    done.add(entry.group);
    const urls = [...entries.values()].filter((other) => other.group === entry.group).map((other) => other.member.url);
    wakes.push({ urls, trigger: url, reason, snoozedAt: entry.snoozedAt });
  }
  return wakes;
}
/** Every change a batch of observations makes to the saved snoozes. */
export function observeSnoozes(
  entries: ReadonlyMap<string, SnoozeEntry>,
  observations: readonly SnoozeObservation[],
  context: { login: string; own?: boolean }
): SnoozeChanges {
  const found: { url: string; reason: WakeReason }[] = [];
  const ended: string[] = [];
  const updated = new Map<string, SnoozeEntry>();
  for (const observation of observations) {
    const url = observation.member.url;
    const entry = updated.get(url) ?? entries.get(url);
    if (!entry) continue;
    const result = observeSnooze(entry, observation, context);
    if (result.end) ended.push(url);
    else if (result.wake) found.push({ url, reason: result.wake });
    else if (result.entry) updated.set(url, result.entry);
  }
  const remaining = new Map([...entries].filter(([url]) => !ended.includes(url)));
  const wakes = groupWakes(remaining, found);
  const woken = new Set(wakes.flatMap((wake) => wake.urls));
  return { wakes, ended, updated: [...updated.values()].filter((entry) => !woken.has(entry.member.url) && !ended.includes(entry.member.url)) };
}
/** Groups whose time or ceiling has passed. */
export function dueWakes(entries: ReadonlyMap<string, SnoozeEntry>, now: number): GroupWake[] {
  return groupWakes(
    entries,
    [...entries.values()].flatMap((entry) => {
      const reason = dueReason(entry, now);
      return reason ? [{ url: entry.member.url, reason }] : [];
    })
  );
}

/**
 * A queue item with its snoozed PRs applied. A row whose open PRs are all snoozed is hidden. A stack with some
 * snoozed PRs keeps its row: those PRs are listed in `snoozedUrls` and leave its unread state.
 */
export function applySnoozes(item: QueueItem, snoozed: ReadonlySet<string>, backs?: Readonly<Partial<Record<string, SnoozeBack>>>): QueueItem | undefined {
  const members = item.subject.members;
  const asleep = snoozed.size ? members.filter((member) => snoozed.has(member.url)).map((member) => member.url) : [];
  if (asleep.length) {
    const openMembers = members.filter(open);
    if ((openMembers.length ? openMembers : members).every((member) => snoozed.has(member.url))) return undefined;
  }
  const back = backs ? Object.fromEntries(members.flatMap((member) => (backs[member.url] ? [[member.url, backs[member.url]]] : []))) : {};
  if (!asleep.length && !Object.keys(back).length) return item;
  return {
    ...item,
    ...(asleep.length ? { snoozedUrls: asleep, unreadUrls: item.unreadUrls?.filter((url) => !asleep.includes(url)) } : {}),
    ...(Object.keys(back).length ? { back } : {}),
  };
}

// Copy. Plain, short and specific.

const DAY = 86_400_000;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** "6:30 PM", "tomorrow 9:00 AM", "Mon 9:00 AM", "Nov 29, 9:00 AM". */
export function snoozeTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (sameDay(date, today)) return `today ${timeOf(date)}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (sameDay(date, tomorrow)) return `tomorrow ${timeOf(date)}`;
  if (at - now < 6 * DAY) return `${date.toLocaleDateString([], { weekday: 'short' })} ${timeOf(date)}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeOf(date)}`;
}
export interface SnoozePreset {
  id: 'later' | 'tomorrow' | 'week';
  label: string;
  until: number;
}
/**
 * Later today (three hours from now, on the half hour, until 9 PM), tomorrow at 9:00 and next Monday at 9:00.
 * On the local calendar, so daylight saving does not move "9:00".
 */
export function snoozePresets(now: number): SnoozePreset[] {
  const today = new Date(now);
  const later = new Date(now + 3 * 3_600_000);
  later.setSeconds(0, 0);
  later.setMinutes(later.getMinutes() <= 30 ? (later.getMinutes() === 0 ? 0 : 30) : 60);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 9);
  const toMonday = (8 - today.getDay()) % 7 || 7;
  // On Sunday, tomorrow morning is already Monday: next week is the Monday after.
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (toMonday === 1 ? 8 : toMonday), 9);
  return [
    ...(sameDay(later, today) && later.getHours() <= 21 ? [{ id: 'later' as const, label: 'Later today', until: later.getTime() }] : []),
    { id: 'tomorrow', label: 'Tomorrow morning', until: tomorrow.getTime() },
    { id: 'week', label: 'Next week', until: monday.getTime() },
  ];
}
/** The detail beside a preset: "6:30 PM", "Sun 9:00 AM". */
export function presetDetail(until: number, now: number): string {
  const date = new Date(until);
  if (sameDay(date, new Date(now))) return timeOf(date);
  if (until - now < 6 * DAY) return `${date.toLocaleDateString([], { weekday: 'short' })} ${timeOf(date)}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${timeOf(date)}`;
}
/** "until tomorrow 9:00 AM", "until new activity", "until checks finish". */
export function snoozeChoiceLabel(choice: { until?: number; on: readonly SnoozeOn[] }, now: number): string {
  if (choice.until !== undefined) return `until ${snoozeTime(choice.until, now)}`;
  if (choice.on.includes('checks')) return 'until checks finish';
  return 'until new activity';
}
/** The "Wakes …" line in Tools › Snoozed. */
export function wakesLine(entry: Pick<SnoozedPr, 'until' | 'on' | 'own' | 'snoozedAt'>, now: number): string {
  if (entry.until !== undefined) return `Wakes ${snoozeTime(entry.until, now)}, or on a new review or review request`;
  const by = snoozeTime(entry.snoozedAt + SNOOZE_CEILING_MS, now);
  if (entry.on.includes('checks') && entry.own) return `Wakes when checks finish or on a new review, or by ${by}`;
  return `Wakes on new activity, or by ${by}`;
}
export function reasonText(reason: WakeReason): string {
  switch (reason.kind) {
    case 'review':
      return `new review from ${reason.actor}`;
    case 'comment':
      return reason.actor ? `new comment from ${reason.actor}` : 'new comment';
    case 'commits':
      return reason.actor ? `new commits from ${reason.actor}` : 'new commits';
    case 'requested':
      return 'review requested';
    case 'ready':
      return 'marked ready for review';
    case 'checks':
      return reason.state === 'passed' ? 'checks passed' : 'checks failed';
    case 'time':
      return 'snooze ended';
    case 'ceiling':
      return 'no activity for 14 days';
  }
}
/** "3 hours", "2 days". */
export function snoozeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
/** "Back: new review from lena on #413 · snoozed 2 days". */
export function backLine(back: SnoozeBack): string {
  return `Back: ${reasonText(back.reason)}${back.via ? ` on #${back.via}` : ''} · snoozed ${snoozeDuration(back.at - back.snoozedAt)}`;
}
