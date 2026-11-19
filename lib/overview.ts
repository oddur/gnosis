/**
 * The Overview lanes (#390): what you can act on right now, across every repository in the queue. Pure, with no
 * Node, Electron or React imports. Built from the same attention model as notifications and the menu bar
 * (`lib/attention.ts`), over the queue snapshot the window already holds, so it adds no GitHub reads.
 *
 * - **Merge:** your PRs GitHub reports mergeable. Each row says why it can merge (`mergeNotes`). Ready rows are approved,
 *   or need no review, and changed in the last three days; the rest are Parked, a collapsed group that the tab title
 *   and the count strip leave out.
 * - **Answer:** replies to you, and changes requested on your PRs.
 * - **Review:** review requested of you, and updates since your review. Rows say when an explanation is ready.
 * - **Fix:** failed checks, conflicts and restacks on your PRs.
 * - **Waiting on others:** your PRs waiting on someone's review, or on checks that are still running.
 *
 * A stack is one row per lane, with the members that need that lane's action. Each lane sorts oldest first.
 *
 * Waiting time ("since") is the best timestamp the snapshot has for when the PR entered that state. GitHub's
 * review-request and check-run times are not in the snapshot, so some reasons fall back to the PR's last update:
 *
 * | Reason | Since |
 * | --- | --- |
 * | Review requested | Your latest review of the PR (a re-request follows it), else when the PR was opened |
 * | Updated since your review | The PR's last update |
 * | Changes requested | The newest open change request |
 * | Awaiting your reply | The newest comment by someone else, else the PR's last update |
 * | Checks failed, conflicts, restack, checks running | The PR's last update (a push or new activity) |
 * | Ready to merge | The newest approval, else the PR's last update |
 * | Awaiting review | The newest review by someone else (a re-request follows it), else when the PR was opened |
 */
import { ATTENTION_LABEL, ATTENTION_RANK, explanationFor, freshSignals, isOwnPr, memberKinds, reviewRequest, updatedSinceYourReview, type AttentionKind } from './attention';
import { changeRequests, type QueueSignals } from './queue-signals';
import { currentApprovers } from './pr-review-status';
import { preciseTarget } from './notification-targets';
import { prTarget, type DeepLinkTarget } from './deep-link';
import type { NotificationEventType } from './notification-settings';
import type { QueueItem, ReviewMember } from './workbench';

export type OverviewLane = 'merge' | 'answer' | 'review' | 'fix' | 'waiting';
/** Fixed order, top to bottom. */
export const OVERVIEW_LANES: readonly OverviewLane[] = ['merge', 'answer', 'review', 'fix', 'waiting'];
/** The lanes that need you. Waiting on others is not counted as work. */
export const ACTION_LANES: readonly OverviewLane[] = ['merge', 'answer', 'review', 'fix'];
export const isOverviewLane = (value: unknown): value is OverviewLane => OVERVIEW_LANES.includes(value as OverviewLane);
export const OVERVIEW_LANE_LABEL: Readonly<Record<OverviewLane, string>> = {
  merge: 'Merge',
  answer: 'Answer',
  review: 'Review',
  fix: 'Fix',
  waiting: 'Waiting on others',
};
/** The count strip names lanes shortly: "Merge 2 · Answer 3 · Review 6 · Fix 1 · Waiting 4". */
export const OVERVIEW_COUNT_LABEL: Readonly<Record<OverviewLane, string>> = { ...OVERVIEW_LANE_LABEL, waiting: 'Waiting' };
export const OVERVIEW_EMPTY: Readonly<Record<OverviewLane, string>> = {
  merge: 'Nothing to merge',
  answer: 'Nothing to answer',
  review: 'Nothing to review',
  fix: 'Nothing to fix',
  waiting: 'Nothing waiting on others',
};
/** Rows shown per lane; "Show all N" opens the rest in the queue. */
export const OVERVIEW_LANE_LIMIT = 5;
const DAY_MS = 86_400_000;
/**
 * When a row is an outlier worth a label, per lane. Every age is shown as plain text; only rows past their lane's
 * limit carry a label. Review and Answer count working days, because someone is blocked on you and weekends do not
 * count against you. Merge flags only Ready rows: Parked rows are already set aside.
 */
export const OVERVIEW_STALE_AFTER: Readonly<Record<OverviewLane, { days: number; working: boolean }>> = {
  merge: { days: 1, working: false },
  answer: { days: 2, working: true },
  review: { days: 2, working: true },
  fix: { days: 2, working: false },
  waiting: { days: 3, working: false },
};
/** The lane heading counts rows older than this: "Fix 18 · 15 over a week". */
export const OVERVIEW_LONG_MS = 7 * DAY_MS;
/** A mergeable PR untouched this long is Parked, not Ready. */
export const OVERVIEW_IDLE_MS = 3 * DAY_MS;
/** The Parked group under Merge, and why its rows are there. */
export const OVERVIEW_PARKED_LABEL = 'Parked';
export const OVERVIEW_PARKED_HINT = 'mergeable, not approved or idle over 3 days';
/**
 * The label on a row past its lane's limit. Waiting on others asks whether to remind someone; in the other lanes the
 * work is yours and has gone stale. Always words, with colour only as support.
 */
export const OVERVIEW_STALE_LABEL: Readonly<Record<OverviewLane, string>> = { merge: 'Stale', answer: 'Stale', review: 'Stale', fix: 'Stale', waiting: 'Nudge?' };
/** The label's tooltip: what the limit is. */
export const OVERVIEW_STALE_TITLE: Readonly<Record<OverviewLane, string>> = {
  merge: 'Ready to merge for over a day',
  answer: 'Waiting on your reply for over 2 working days',
  review: 'Waiting on your review for over 2 working days',
  fix: 'Unchanged for over 2 days',
  waiting: 'Waiting on others for over 3 days. Consider a reminder.',
};
/** The stale label for a row, or undefined when it is not stale. */
export const overviewStaleLabel = (row: Pick<OverviewRow, 'lane' | 'stale'>) => (row.stale ? OVERVIEW_STALE_LABEL[row.lane] : undefined);

/** Time from `since` to `now`. With `working`, Saturdays and Sundays (local time) do not count. */
export function elapsed(since: number, now: number, working = false): number {
  if (now <= since) return 0;
  if (!working) return now - since;
  let total = 0;
  let cursor = since;
  // A year of days at most; anything older is long past every limit.
  for (let i = 0; cursor < now && i < 400; i++) {
    const day = new Date(cursor);
    const end = Math.min(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(), now);
    if (day.getDay() !== 0 && day.getDay() !== 6) total += end - cursor;
    cursor = end;
  }
  return total + Math.max(0, now - cursor);
}
/** Past the lane's limit (`OVERVIEW_STALE_AFTER`). */
export function isStale(lane: OverviewLane, since: number, now: number): boolean {
  const limit = OVERVIEW_STALE_AFTER[lane];
  return elapsed(since, now, limit.working) >= limit.days * DAY_MS;
}

export type OverviewReason = Exclude<AttentionKind, 'explanation-ready'> | 'review-pending' | 'checks-pending';
export const OVERVIEW_REASON_LABEL: Readonly<Record<OverviewReason, string>> = {
  'review-requested': ATTENTION_LABEL['review-requested'],
  'updated-since-review': ATTENTION_LABEL['updated-since-review'],
  'changes-requested': ATTENTION_LABEL['changes-requested'],
  'checks-failed': ATTENTION_LABEL['checks-failed'],
  conflicts: ATTENTION_LABEL.conflicts,
  replies: ATTENTION_LABEL.replies,
  restack: ATTENTION_LABEL.restack,
  'ready-to-merge': ATTENTION_LABEL['ready-to-merge'],
  'review-pending': 'Awaiting review',
  'checks-pending': 'Checks running',
};
const REASON_RANK: readonly OverviewReason[] = [
  ...(ATTENTION_RANK.filter((kind) => kind !== 'explanation-ready') as OverviewReason[]),
  'review-pending',
  'checks-pending',
];
const byReason = (a: OverviewReason, b: OverviewReason) => REASON_RANK.indexOf(a) - REASON_RANK.indexOf(b);
export const LANE_REASONS: Readonly<Record<OverviewLane, readonly OverviewReason[]>> = {
  merge: ['ready-to-merge'],
  answer: ['changes-requested', 'replies'],
  review: ['review-requested', 'updated-since-review'],
  fix: ['checks-failed', 'conflicts', 'restack'],
  waiting: ['review-pending', 'checks-pending'],
};
/**
 * The reason the lane's name already says. Rows leave it out, as the menu bar does. The other lanes have several
 * reasons; there the most common one (`OverviewLaneState.dominant`) is named once in the heading instead.
 */
export const LANE_IMPLIED: Readonly<Partial<Record<OverviewLane, OverviewReason>>> = { merge: 'ready-to-merge', review: 'review-requested' };
/** The lanes whose most common reason moves from the rows to the heading. */
const DOMINANT_LANES: readonly OverviewLane[] = ['answer', 'fix', 'waiting'];
/** Work for you on your own PR. Any of it comes before merging, as in `attentionItems`. */
const OWN_WORK: readonly OverviewReason[] = ['changes-requested', 'replies', 'checks-failed', 'conflicts', 'restack'];

/** Where a click on the row lands: the same place as the notification for its headline reason. */
const NOTIFICATION_TYPE: Partial<Record<OverviewReason, NotificationEventType>> = {
  'ready-to-merge': 'ready-to-merge',
  'changes-requested': 'changes-requested',
  replies: 'reply',
  'review-requested': 'review-requested',
  'updated-since-review': 'rereview',
  'checks-failed': 'checks-failed',
};
export function overviewTarget(reason: OverviewReason, url: string): DeepLinkTarget | undefined {
  const type = NOTIFICATION_TYPE[reason];
  return (type && preciseTarget({ type, url })) || prTarget(url);
}

/** Which timestamp a waiting time came from, for its tooltip. */
export type OverviewSinceSource = 'opened' | 'your-review' | 'review' | 'change-request' | 'reply' | 'approval' | 'updated';
export const OVERVIEW_SINCE_LABEL: Readonly<Record<OverviewSinceSource, string>> = {
  opened: 'since the PR was opened',
  'your-review': 'since your last review',
  review: 'since the latest review',
  'change-request': 'since changes were requested',
  reply: 'since the latest reply',
  approval: 'since it was approved',
  updated: 'since the PR was last updated',
};

export interface OverviewEntry {
  member: ReviewMember;
  /** This lane's reasons for the PR, ranked. */
  reasons: OverviewReason[];
  since: number;
  source: OverviewSinceSource;
  /**
   * The PR's state in this lane changed since the last visit (`entryChanged`): the unread dot. Never for a PR that was
   * only unopened or unread.
   */
  isNew?: boolean;
}
/**
 * One fact about why a Merge row can merge, shown in the row's reason slot.
 * - `approved`: "Approved by lena", "Approved by lena and 2 others", or "Approved" when GitHub gives no names.
 * - `no-review`: "No review required": GitHub reports no review decision, so the branch rules ask for none.
 * - `unapproved`: "Mergeable, not approved": GitHub allows the merge, but reports neither of the above.
 * - `base-open`: "Waits for #12 to merge": a stack member whose base PR is still open.
 * - `behind`: "Behind main by 3 commits": the base branch moved on; GitHub does not require an update.
 */
export type OverviewMergeNoteKind = 'approved' | 'no-review' | 'unapproved' | 'base-open' | 'behind';
export interface OverviewMergeNote {
  kind: OverviewMergeNoteKind;
  text: string;
}
export interface OverviewMerge {
  /** The PR the Merge button merges: in a stack, the lowest one in this lane (base first). */
  member: ReviewMember;
  /** The review fact first, then at most one more: the open base, else how far behind. */
  notes: OverviewMergeNote[];
  /** Approved or no review required, and changed within `OVERVIEW_IDLE_MS`. Otherwise Parked. */
  ready: boolean;
}

export interface OverviewRow {
  /** `${lane}|${subjectId}`; stable while the entry stays in the lane, so live updates change the row in place. */
  id: string;
  lane: OverviewLane;
  item: QueueItem;
  kind: 'pr' | 'stack';
  title: string;
  /** The PR the row opens and acts on: the one that has waited longest. */
  focus: ReviewMember;
  /** The PRs that need this lane's action, oldest first. One for a PR row. */
  entries: OverviewEntry[];
  /** A stack's size; absent for a PR. */
  stackSize?: number;
  reasons: OverviewReason[];
  /** The reasons the row shows: `reasons` without what the lane name or heading already says (`rowReasons`). */
  shown: OverviewReason[];
  /**
   * Who the row is about: the author to review, or the reviewer you answer or wait on. Never you: absent when you
   * are the only candidate. Absent on Merge rows, whose notes name the approver.
   */
  person?: string;
  /** Merge rows: why the PR can merge, and whether it is Ready or Parked. */
  merge?: OverviewMerge;
  since: number;
  source: OverviewSinceSource;
  /** "2 d": how long it has waited, at the model's time. */
  waiting: string;
  stale: boolean;
  /** Any of its entries changed since the last visit (`OverviewEntry.isNew`). */
  isNew: boolean;
  additions?: number;
  deletions?: number;
  files?: number;
  /** Review lane: a current explanation is saved. */
  explanation?: { reviewId: string };
  target: DeepLinkTarget;
  /** Identity for "new since your last visit": the row, its PRs at their head commits, and its reasons. */
  key: string;
  /** Everything the row shows, so a memoized row renders again only when this changes. */
  signature: string;
}
export interface OverviewLaneState {
  lane: OverviewLane;
  /** On Merge, only the Ready rows. */
  rows: OverviewRow[];
  /** Merge only: mergeable rows that are not approved, or idle over three days. Not counted as work. */
  parked: OverviewRow[];
  /** Rows (not Parked) waiting longer than `OVERVIEW_LONG_MS`, for the heading: "Fix 18 · 15 over a week". */
  overWeek: number;
  /**
   * Answer, Fix and Waiting: the reason most rows share, when it is more than half of them and at least two. The
   * heading names it once ("16 checks failed") and rows leave it out, so a row's words mark how it differs.
   */
  dominant?: { reason: OverviewReason; count: number };
}
export interface OverviewModel {
  lanes: OverviewLaneState[];
  /** Rows per lane. Merge counts only its Ready rows. */
  counts: Readonly<Record<OverviewLane, number>>;
  /** Parked Merge rows. */
  parked: number;
  /** Rows in the four action lanes. */
  actionable: number;
  /** Rows marked new. */
  fresh: number;
  /** Your open PRs whose status is unknown or older than 30 minutes, so status lanes may miss them. */
  unchecked: number;
  /** Every PR URL in each lane, for the queue's lane filter. */
  urls: Readonly<Record<OverviewLane, string[]>>;
  /** Row keys, saved as the visit when the Overview is shown. */
  keys: string[];
  /** Each PR's state per lane (`entryKey`), saved as the visit: what "changed since your last visit" compares. */
  entryKeys: string[];
  /** Every open PR the lanes considered, and the ones of yours whose status was not known yet. */
  seen: string[];
  uncheckedUrls: string[];
}

/** The last visit, saved per account in local storage. */
export interface OverviewVisit {
  at: number;
  keys: string[];
  /** The PRs' states then (`entryKey`). A visit saved before these existed marks nothing new. */
  entries?: string[];
  /** Every open PR then, and the ones whose status was not known, so their state then is not known either. */
  seen?: string[];
  unchecked?: string[];
}
export const overviewVisitKey = (account: string) => `gnosis-overview-visit:v1:${account}`;
export function parseOverviewVisit(raw: string | null): OverviewVisit | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<OverviewVisit>;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at) || !Array.isArray(value.keys)) return undefined;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string').slice(0, VISIT_LIMIT) : undefined);
    const entries = strings(value.entries);
    const seen = strings(value.seen);
    const unchecked = strings(value.unchecked);
    return { at: value.at, keys: strings(value.keys) ?? [], ...(entries ? { entries } : {}), ...(seen ? { seen } : {}), ...(unchecked ? { unchecked } : {}) };
  } catch {
    return undefined;
  }
}
/** At most this many keys of each kind are saved per visit. */
const VISIT_LIMIT = 4000;
export const nextOverviewVisit = (model: Pick<OverviewModel, 'keys'> & Partial<Pick<OverviewModel, 'entryKeys' | 'seen' | 'uncheckedUrls'>>, now: number): OverviewVisit => ({
  at: now,
  keys: model.keys.slice(0, VISIT_LIMIT),
  entries: (model.entryKeys ?? []).slice(0, VISIT_LIMIT),
  seen: (model.seen ?? []).slice(0, VISIT_LIMIT),
  unchecked: (model.uncheckedUrls ?? []).slice(0, VISIT_LIMIT),
});
/** One PR's state in one lane: its head commit and its reasons there. A push or a new reason changes it. */
export const entryKey = (lane: OverviewLane, entry: Pick<OverviewEntry, 'member' | 'reasons'>) => `${lane}|${entry.member.url}@${entry.member.headSha}|${entry.reasons.join(',')}`;
/**
 * The unread dot: the PR's state in this lane is not the one the last visit saw, and the last visit knew the PR's
 * state (it was in the queue with its status known), or the PR was not in the queue at all then. A PR whose status
 * was still loading at the last visit, an update that changes no state (a label, a comment on a PR waiting on
 * others) and a PR that is only unopened are not new. Without a saved visit of this kind, nothing is new.
 */
export function entryChanged(previous: { entries: ReadonlySet<string>; seen: ReadonlySet<string>; unchecked: ReadonlySet<string> } | undefined, lane: OverviewLane, entry: Pick<OverviewEntry, 'member' | 'reasons'>): boolean {
  if (!previous || previous.entries.has(entryKey(lane, entry))) return false;
  const url = entry.member.url;
  return !previous.seen.has(url) || !previous.unchecked.has(url);
}

export interface OverviewInput {
  items: readonly QueueItem[];
  signals: (member: ReviewMember) => QueueSignals | undefined;
  login: string;
  now: number;
  /** Team review requests count as requests of you. Follows the notification setting. */
  teamRequests?: boolean;
  /** The previous visit. Without one, nothing is new. */
  previous?: OverviewVisit;
  /** PRs to leave out, such as muted ones that a snapshot still holds. Snoozed PRs leave out themselves. */
  excluded?: ReadonlySet<string>;
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const isOpen = (member: ReviewMember) => member.state === 'open' && !member.merged;

/** Your PR waits on a review: someone is requested, or GitHub still requires one, and nobody asked for changes. */
function awaitingReview(member: ReviewMember, fresh: QueueSignals | undefined) {
  const decision = fresh?.readiness?.reviewDecision;
  if (decision === 'CHANGES_REQUESTED') return false;
  return member.requestedReviewers.length > 0 || member.requestedTeams.length > 0 || decision === 'REVIEW_REQUIRED';
}

/** Every reason one open PR has, across lanes. `parentMerged`: the PR builds on a stack parent that has merged. */
export function memberReasons(
  item: QueueItem,
  member: ReviewMember,
  fresh: QueueSignals | undefined,
  login: string,
  options: { teamRequests?: boolean; parentMerged?: boolean } = {}
): Set<OverviewReason> {
  const reasons = memberKinds(item, member, fresh, login, { teamRequests: options.teamRequests }) as Set<OverviewReason | 'explanation-ready'>;
  // An explanation is a marker on a Review row, not a lane of its own.
  reasons.delete('explanation-ready');
  const result = reasons as Set<OverviewReason>;
  const own = isOwnPr(member, login);
  // Its parent merged, so the PR still carries the parent's commits or targets a merged branch.
  if (own && options.parentMerged) result.add('restack');
  if ([...result].some((reason) => OWN_WORK.includes(reason))) result.delete('ready-to-merge');
  // Waiting on others: nothing for you to do on it now. A draft is not waiting on anyone.
  if (own && !member.isDraft && ![...result].some((reason) => OWN_WORK.includes(reason) || reason === 'ready-to-merge')) {
    if (fresh?.checks.state === 'pending') result.add('checks-pending');
    if (awaitingReview(member, fresh)) result.add('review-pending');
  }
  return result;
}

/** When the PR entered the state behind `reason`. See the table at the top of this file. */
export function reasonSince(
  reason: OverviewReason,
  member: ReviewMember,
  fresh: QueueSignals | undefined,
  login: string
): { at: number; source: OverviewSinceSource } {
  const opened = time(member.createdAt) ?? 0;
  const updated = time(member.updatedAt) ?? opened;
  const recent = fresh?.activity?.recent ?? [];
  const reviews = [...(fresh?.opinions ?? []), ...(fresh?.latestReview ? [fresh.latestReview] : [])];
  const newest = (values: (number | undefined)[]) => values.reduce<number | undefined>((best, value) => (value !== undefined && (best === undefined || value > best) ? value : best), undefined);
  if (reason === 'review-requested' || reason === 'review-pending') {
    const mine = reason === 'review-requested';
    const reviewed = newest([
      ...reviews.filter((review) => mine === same(review.author, login)).map((review) => time(review.submittedAt)),
      ...recent.filter((entry) => entry.kind === 'review' && mine === same(entry.author, login) && !entry.automated).map((entry) => time(entry.at)),
    ]);
    return reviewed !== undefined && reviewed > opened ? { at: reviewed, source: mine ? 'your-review' : 'review' } : { at: opened, source: 'opened' };
  }
  if (reason === 'changes-requested') {
    const request = fresh ? changeRequests(fresh, login)?.[0] : undefined;
    const fallback = fresh?.latestReview && fresh.latestReview.state === 'CHANGES_REQUESTED' && !same(fresh.latestReview.author, login) ? fresh.latestReview : undefined;
    const at = time((request ?? fallback)?.submittedAt);
    return at !== undefined ? { at, source: 'change-request' } : { at: updated, source: 'updated' };
  }
  if (reason === 'replies') {
    const at = newest(recent.filter((entry) => entry.kind === 'comment' && !same(entry.author, login) && !entry.automated && !entry.minimized).map((entry) => time(entry.at)));
    return at !== undefined ? { at, source: 'reply' } : { at: updated, source: 'updated' };
  }
  if (reason === 'ready-to-merge') {
    const at = newest((fresh?.opinions ?? []).filter((review) => review.state === 'APPROVED').map((review) => time(review.submittedAt)));
    return at !== undefined ? { at, source: 'approval' } : { at: updated, source: 'updated' };
  }
  return { at: updated, source: 'updated' };
}

/** Who a row is about, per lane. Never the viewer: undefined when nobody else fits. Merge notes name the approver. */
function personFor(lane: OverviewLane, entry: OverviewEntry, fresh: QueueSignals | undefined, login: string): string | undefined {
  const { member } = entry;
  const other = (value: string | undefined) => (value && !same(value, login) ? value : undefined);
  if (lane === 'merge') return undefined;
  if (lane === 'answer') {
    if (entry.reasons[0] === 'changes-requested') {
      const request = fresh ? changeRequests(fresh, login)?.[0] : undefined;
      if (request) return request.author;
    }
    const reply = [...(fresh?.activity?.recent ?? [])].reverse().find((item) => item.kind === 'comment' && !same(item.author, login) && !item.automated);
    if (reply) return reply.author;
  }
  if (lane === 'waiting') return other(member.requestedReviewers.find((reviewer) => !same(reviewer, login))) ?? other(member.requestedTeams.at(0)) ?? other(member.author);
  return other(member.author);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Why a Merge row can merge, from the status snapshot and the stack: the review fact, then the open base or how far
 * behind. See `OverviewMergeNoteKind`. Says only what GitHub reported.
 */
export function mergeNotes(item: QueueItem, member: ReviewMember, fresh: QueueSignals | undefined, login: string): OverviewMergeNote[] {
  const notes: OverviewMergeNote[] = [];
  const approvers = [
    ...new Set(
      [...(fresh?.opinions ?? [])]
        .filter((review) => review.state === 'APPROVED' && !same(review.author, login))
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((review) => review.author)
    ),
  ];
  // Snapshots saved before opinions were read know only the newest review.
  const latest = fresh?.latestReview;
  if (!fresh?.opinions && latest?.state === 'APPROVED' && !same(latest.author, login)) approvers.push(latest.author);
  const decision = fresh?.readiness?.reviewDecision;
  // With no review decision, only approvals of the current commit count, as on the PR page and in the queue
  // (`prReviewStatus`). GitHub's APPROVED vouches for older approvals it still counts.
  if (fresh?.readiness && decision === null) approvers.splice(0, approvers.length, ...currentApprovers(fresh, member.headSha, login));
  if (approvers.length)
    notes.push({ kind: 'approved', text: approvers.length === 1 ? `Approved by ${approvers[0]}` : `Approved by ${approvers[0]} and ${plural(approvers.length - 1, 'other', 'others')}` });
  else if (decision === 'APPROVED') notes.push({ kind: 'approved', text: 'Approved' });
  // GitHub reports no review decision when the branch rules require no review.
  else if (fresh?.readiness && decision === null) notes.push({ kind: 'no-review', text: 'No review required' });
  else notes.push({ kind: 'unapproved', text: 'Mergeable, not approved' });
  const subject = item.subject;
  const base = subject.edges
    .filter((edge) => edge.child === member.url)
    .map((edge) => subject.members.find((candidate) => candidate.url === edge.parent))
    .find((parent) => parent && isOpen(parent));
  const behind = fresh?.readiness?.behindBy ?? 0;
  if (base) notes.push({ kind: 'base-open', text: `Waits for #${base.number} to merge` });
  else if (behind > 0) notes.push({ kind: 'behind', text: `Behind ${fresh?.readiness?.baseBranch || member.baseBranch} by ${plural(behind, 'commit', 'commits')}` });
  return notes;
}

/** Ready, or Parked: approved or no review required, and changed (pushed, reviewed, commented) within `OVERVIEW_IDLE_MS`. */
export function mergeReady(notes: readonly OverviewMergeNote[], member: ReviewMember, fresh: QueueSignals | undefined, now: number): boolean {
  if (!notes.some((note) => note.kind === 'approved' || note.kind === 'no-review')) return false;
  const approvals = (fresh?.opinions ?? []).filter((review) => review.state === 'APPROVED').map((review) => time(review.submittedAt) ?? 0);
  const touched = Math.max(time(member.updatedAt) ?? 0, ...approvals);
  return now - touched < OVERVIEW_IDLE_MS;
}

const sum = (values: (number | undefined)[]) => (values.some((value) => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined);

/**
 * Every PR that can appear in a lane, for the Overview's status requests: your open PRs first (Merge, Answer, Fix and
 * Waiting all read their status), then review requests (direct, and team ones when they count), then PRs you reviewed
 * that changed or wait on your reply (their ages read your latest review from status). Snoozed, muted, merged and
 * closed PRs are left out, as in `overviewModel`. Each PR revision is listed once.
 */
export function overviewStatusRequests(
  items: readonly QueueItem[],
  login: string,
  options: { teamRequests?: boolean; excluded?: ReadonlySet<string> } = {}
): { url: string; headSha: string }[] {
  if (!login) return [];
  const own: ReviewMember[] = [];
  const others: ReviewMember[] = [];
  const seen = new Set<string>();
  for (const item of items)
    for (const member of item.subject.members) {
      if (!isOpen(member) || item.snoozedUrls?.includes(member.url) || options.excluded?.has(member.url) || seen.has(member.url)) continue;
      if (isOwnPr(member, login)) {
        seen.add(member.url);
        own.push(member);
        continue;
      }
      const request = reviewRequest(member, login);
      const reviewed = updatedSinceYourReview(item, member.url) || (item.responses?.[member.url]?.awaitingReply ?? 0) > 0;
      if (request === 'direct' || (request === 'team' && options.teamRequests) || reviewed) {
        seen.add(member.url);
        others.push(member);
      }
    }
  return [...own, ...others].map(({ url, headSha }) => ({ url, headSha }));
}

/** The lanes, each sorted oldest first. Snoozed, muted, merged and closed PRs are left out, as in the queue. */
export function overviewModel(input: OverviewInput): OverviewModel {
  const { login, now } = input;
  const lanes = new Map<OverviewLane, OverviewRow[]>(OVERVIEW_LANES.map((lane) => [lane, []]));
  const urls = new Map<OverviewLane, Set<string>>(OVERVIEW_LANES.map((lane) => [lane, new Set()]));
  const unchecked = new Set<string>();
  const seen = new Set<string>();
  const entryKeys: string[] = [];
  const before = input.previous?.entries && input.previous.seen
    ? { entries: new Set(input.previous.entries), seen: new Set(input.previous.seen), unchecked: new Set(input.previous.unchecked ?? []) }
    : undefined;
  for (const item of input.items) {
    const subject = item.subject;
    const mergedUrls = new Set(subject.members.filter((member) => member.merged).map((member) => member.url));
    const parentMerged = new Set(subject.edges.filter((edge) => mergedUrls.has(edge.parent)).map((edge) => edge.child));
    const perLane = new Map<OverviewLane, { entry: OverviewEntry; fresh?: QueueSignals }[]>();
    for (const member of subject.members) {
      if (!isOpen(member) || item.snoozedUrls?.includes(member.url) || input.excluded?.has(member.url)) continue;
      const signals = freshSignals(input.signals(member), now);
      const current = signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;
      seen.add(member.url);
      if (isOwnPr(member, login) && !current) unchecked.add(member.url);
      const reasons = memberReasons(item, member, current, login, { teamRequests: input.teamRequests, parentMerged: parentMerged.has(member.url) });
      for (const lane of OVERVIEW_LANES) {
        const laneReasons = LANE_REASONS[lane].filter((reason) => reasons.has(reason)).sort(byReason);
        if (!laneReasons.length) continue;
        // A PR has waited since the first of its reasons in this lane.
        const since = laneReasons.map((reason) => reasonSince(reason, member, current, login)).sort((a, b) => a.at - b.at)[0];
        const list = perLane.get(lane) ?? [];
        const entry: OverviewEntry = { member, reasons: laneReasons, since: Math.min(since.at, now), source: since.source };
        entryKeys.push(entryKey(lane, entry));
        if (entryChanged(before, lane, entry)) entry.isNew = true;
        list.push({ entry, fresh: current });
        perLane.set(lane, list);
      }
    }
    for (const [lane, list] of perLane) {
      list.sort((a, b) => a.entry.since - b.entry.since || a.entry.member.number - b.entry.member.number);
      const entries = list.map(({ entry }) => entry);
      const first = list[0];
      const focus = first.entry.member;
      const reasons = [...new Set(entries.flatMap((entry) => entry.reasons))].sort(byReason);
      const stack = subject.kind === 'stack';
      const id = `${lane}|${subject.id}`;
      const key = `${id}|${entries.map((entry) => `${entry.member.url}@${entry.member.headSha}`).join(',')}|${reasons.join(',')}`;
      const isNew = entries.some((entry) => entry.isNew);
      // Base first: in a stack, the lowest PR in the lane is the one to merge.
      const merging = lane === 'merge' ? (subject.members.map((member) => list.find(({ entry }) => entry.member.url === member.url)).find(Boolean) ?? first) : undefined;
      const notes = merging ? mergeNotes(item, merging.entry.member, merging.fresh, login) : undefined;
      const merge = merging && notes ? { member: merging.entry.member, notes, ready: mergeReady(notes, merging.entry.member, merging.fresh, now) } : undefined;
      const person = personFor(lane, first.entry, first.fresh, login);
      const saved = lane === 'review' ? subject.members.map((member) => explanationFor(item, member.url)).find(Boolean) : undefined;
      const row: Omit<OverviewRow, 'signature' | 'shown'> = {
        id,
        lane,
        item,
        kind: subject.kind,
        title: stack ? subject.name || subject.title : focus.title,
        focus,
        entries,
        ...(stack ? { stackSize: subject.members.length } : {}),
        reasons,
        ...(person ? { person } : {}),
        ...(merge ? { merge } : {}),
        since: first.entry.since,
        source: first.entry.source,
        waiting: waitingLabel(first.entry.since, now),
        // Parked merges are set aside already, so they are never flagged.
        stale: (!merge || merge.ready) && isStale(lane, first.entry.since, now),
        isNew,
        ...(() => {
          const additions = sum(entries.map((entry) => entry.member.additions));
          const deletions = sum(entries.map((entry) => entry.member.deletions));
          const files = sum(entries.map((entry) => entry.member.changedFileCount));
          return { ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(files !== undefined ? { files } : {}) };
        })(),
        ...(saved ? { explanation: { reviewId: saved.id } } : {}),
        target: overviewTarget(first.entry.reasons[0], focus.url) ?? { kind: 'queue' },
        key,
      };
      const signature = JSON.stringify([
        row.key, row.title, row.person, merge?.notes, merge?.ready, merge?.member.url, row.since, row.waiting, row.stale, row.isNew, row.additions, row.deletions, row.files, row.explanation?.reviewId,
        row.stackSize, entries.map((entry) => [entry.member.title, entry.member.isDraft, entry.member.state, entry.member.number, entry.member.repo, !!entry.isNew]),
      ]);
      // `shown` depends on the lane's other rows; it is set, and signed, once the lane is complete.
      lanes.get(lane)?.push({ ...row, shown: [], signature });
      for (const entry of entries) urls.get(lane)?.add(entry.member.url);
    }
  }
  const states = OVERVIEW_LANES.map((lane): OverviewLaneState => {
    const built = lanes.get(lane) ?? [];
    const dominant = dominantReason(lane, built);
    const all = built
      .map((row) => {
        const shown = rowReasons(row, dominant?.reason);
        return { ...row, shown, signature: `${row.signature}|${shown.join(',')}` };
      })
      .sort((a, b) => a.since - b.since || a.title.localeCompare(b.title));
    const rows = all.filter((row) => !row.merge || row.merge.ready);
    return {
      lane,
      rows,
      parked: all.filter((row) => !!row.merge && !row.merge.ready),
      overWeek: rows.filter((row) => now - row.since >= OVERVIEW_LONG_MS).length,
      ...(dominant ? { dominant } : {}),
    };
  });
  const counts = Object.fromEntries(states.map((state) => [state.lane, state.rows.length])) as Record<OverviewLane, number>;
  // New rows in the lanes that are work: not Waiting on others, and not Parked.
  const fresh = states.reduce((total, state) => total + (state.lane === 'waiting' ? 0 : state.rows.filter((row) => row.isNew).length), 0);
  return {
    lanes: states,
    counts,
    parked: states.reduce((total, state) => total + state.parked.length, 0),
    actionable: ACTION_LANES.reduce((total, lane) => total + counts[lane], 0),
    fresh,
    unchecked: unchecked.size,
    urls: Object.fromEntries(OVERVIEW_LANES.map((lane) => [lane, [...(urls.get(lane) ?? [])]])) as Record<OverviewLane, string[]>,
    keys: states.flatMap((state) => [...state.rows, ...state.parked].map((row) => row.key)),
    entryKeys,
    seen: [...seen],
    uncheckedUrls: [...unchecked],
  };
}

/**
 * What follows a lane heading's count, when it matters: the reason most rows share (which they then leave out), long
 * waits and parked merges. "Fix 18 · 16 checks failed · 15 over a week", "Merge 4 · 12 parked".
 */
export function overviewLaneSummary(state: Pick<OverviewLaneState, 'parked' | 'overWeek' | 'dominant'>): string[] {
  const dominant = state.dominant ? `${state.dominant.count} ${OVERVIEW_REASON_LABEL[state.dominant.reason].toLowerCase()}` : '';
  return [dominant, state.overWeek ? `${state.overWeek} over a week` : '', state.parked.length ? `${state.parked.length} parked` : ''].filter(Boolean);
}

/** "Merge 2 · Answer 3 · Review 6 · Fix 1 · Waiting 4". */
export const overviewCountLine = (counts: Readonly<Record<OverviewLane, number>>) =>
  OVERVIEW_LANES.map((lane) => `${OVERVIEW_COUNT_LABEL[lane]} ${counts[lane]}`).join(' · ');

/** "2 d", "5 h", "12 m", "now": how long a row has waited. */
export function waitingLabel(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 7 * 8 ? `${days} d` : `${Math.floor(days / 7)} w`;
}

/** The words on a row, leaving out what the lane already says. */
export const rowReasons = (row: Pick<OverviewRow, 'lane' | 'reasons'>, dominant?: OverviewReason) =>
  row.reasons.filter((reason) => reason !== LANE_IMPLIED[row.lane] && reason !== dominant);

/** The reason most rows in a lane share (see `OverviewLaneState.dominant`), or undefined. */
export function dominantReason(lane: OverviewLane, rows: readonly Pick<OverviewRow, 'reasons'>[]): OverviewLaneState['dominant'] {
  if (!DOMINANT_LANES.includes(lane)) return undefined;
  const counts = new Map<OverviewReason, number>();
  for (const row of rows) for (const reason of row.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const [reason, count] = [...counts].sort((a, b) => b[1] - a[1] || byReason(a[0], b[0]))[0] ?? [];
  return reason && count && count >= 2 && count * 2 > rows.length ? { reason, count } : undefined;
}

/** "11 d" read aloud: "11 days". */
export function spokenWaiting(label: string): string {
  if (label === 'now') return 'just now';
  const [count, unit] = label.split(' ');
  const word = ({ m: 'minute', h: 'hour', d: 'day', w: 'week' } as Record<string, string>)[unit] ?? unit;
  return `${count} ${word}${count === '1' ? '' : 's'}`;
}

/**
 * Everything a row says, as one sentence for assistive technology, in the order it is shown:
 * "Checks failed, web-seed-portal #1959, waiting 11 days, stale". It names the reason even when the heading carries
 * it for the lane, because a row is often heard alone.
 */
export function overviewRowDescription(row: Pick<OverviewRow, 'lane' | 'reasons' | 'merge' | 'focus' | 'entries' | 'kind' | 'item' | 'person' | 'waiting' | 'stale' | 'explanation'>): string {
  const ref = overviewRef(row);
  const extra = Number(ref.number.split('+')[1] ?? 0);
  const words = [
    ...(row.merge ? row.merge.notes.map((note) => note.text) : rowReasons(row).map((reason) => OVERVIEW_REASON_LABEL[reason])),
    `${ref.repo} ${extra ? `${ref.number.split(' ')[0]} and ${extra} more` : ref.number}`,
    ...(row.person ? [`${row.lane === 'review' ? 'by' : row.lane === 'waiting' ? 'on' : 'from'} ${row.person}`] : []),
    ...(row.explanation ? ['explanation ready'] : []),
    `waiting ${spokenWaiting(row.waiting)}`,
    ...(row.stale ? [row.lane === 'waiting' ? 'consider a nudge' : 'stale'] : []),
  ];
  return words.join(', ');
}

/**
 * What changed in the lane counts, for a polite announcement: "Fix 3, was 2. Merge 1, was 2." Empty when nothing
 * changed, so a sync that changes nothing says nothing.
 */
export function overviewCountChange(before: Readonly<Record<OverviewLane, number>>, after: Readonly<Record<OverviewLane, number>>): string {
  return OVERVIEW_LANES.filter((lane) => before[lane] !== after[lane])
    .map((lane) => `${OVERVIEW_COUNT_LABEL[lane]} ${after[lane]}, was ${before[lane]}.`)
    .join(' ');
}

/** The short name of a repository: "web-seed-portal" for "klanggames/web-seed-portal". */
export const repoName = (repo: string) => repo.slice(repo.lastIndexOf('/') + 1) || repo;

/**
 * A row's repository and PR as one plain token: "web-seed-portal #1994", or "seed-launcher #380 +3" for the stack
 * members in the lane. `title` is the full form, for truncated names and assistive technology.
 */
export function overviewRef(row: Pick<OverviewRow, 'focus' | 'entries' | 'kind' | 'item'>): { repo: string; number: string; title: string } {
  const repo = row.focus.repo;
  // Stack members in stack order, base first.
  const numbers = row.item.subject.members.filter((member) => row.entries.some((entry) => entry.member.url === member.url)).map((member) => member.number);
  const first = row.kind === 'stack' ? numbers[0] : row.focus.number;
  const number = row.kind === 'stack' && numbers.length > 1 ? `#${first} +${numbers.length - 1}` : `#${first}`;
  return { repo: repoName(repo), number, title: `${repo} ${row.kind === 'stack' ? numbers.map((n) => `#${n}`).join(', ') : `#${first}`}` };
}

// ── The front page: a briefing sentence and four lane tiles ──

/** The tiles, in reading order: people blocked on you first (Answer, Review), then your own PRs (Merge, Fix). */
export const OVERVIEW_TILE_LANES: readonly OverviewLane[] = ['answer', 'review', 'merge', 'fix'];
/** Items each tile lists; "All N" opens the lane in the queue. */
export const OVERVIEW_TILE_LIMIT = 3;

export interface OverviewTile {
  lane: OverviewLane;
  /** The lane's count: on Merge, the Ready rows only. */
  count: number;
  /** The oldest `OVERVIEW_TILE_LIMIT` rows: the ones that have waited longest. */
  rows: OverviewRow[];
  /** The lane heading's summary (`overviewLaneSummary`): "15 checks failed", "15 over a week", "12 parked". */
  summary: string[];
}

/** The four tiles, from the lane model. Pure, so the page and the tests build them the same way. */
export function overviewTiles(model: Pick<OverviewModel, 'lanes'>): OverviewTile[] {
  return OVERVIEW_TILE_LANES.map((lane) => {
    const state = model.lanes.find((entry) => entry.lane === lane);
    return {
      lane,
      count: state?.rows.length ?? 0,
      rows: (state?.rows ?? []).slice(0, OVERVIEW_TILE_LIMIT),
      summary: state ? overviewLaneSummary(state) : [],
    };
  });
}

/**
 * What a tile item keeps off the page until it is hovered or focused, as one line: "web #311 · Changes requested ·
 * from lena · Stale". The tile names its lane and its most common reason, so this names the rest.
 */
export function overviewRowDetail(row: Pick<OverviewRow, 'lane' | 'reasons' | 'merge' | 'focus' | 'entries' | 'kind' | 'item' | 'person' | 'stale' | 'stackSize' | 'explanation'>): string {
  const ref = overviewRef(row);
  const words = [
    `${ref.repo} ${ref.number}`,
    ...(row.kind === 'stack' && row.stackSize ? [row.entries.length === row.stackSize ? `${row.stackSize} PRs` : `${row.entries.length} of ${row.stackSize} PRs`] : []),
    ...(row.merge ? row.merge.notes.map((note) => note.text) : rowReasons(row).map((reason) => OVERVIEW_REASON_LABEL[reason])),
    ...(row.person ? [`${row.lane === 'review' ? 'by' : row.lane === 'waiting' ? 'on' : 'from'} ${row.person}`] : []),
    ...(row.explanation ? ['Explanation ready'] : []),
    ...(row.stale ? [OVERVIEW_STALE_LABEL[row.lane]] : []),
  ];
  return words.join(' · ');
}

/**
 * The Overview's opening line, built from the lanes with no model call. At most two people are named, longest wait
 * first. People blocked on you come first, then your own PRs. Failed checks are named only when there are any; other
 * Fix work is "needs a fix".
 *
 * - "lena is waiting on your reply, and 7 reviews are waiting on you. 2 PRs are approved and ready to merge, 8 more can
 *   merge without review, and 2 have failed checks."
 * - "lena and sam are waiting on your reply on 3 PRs."
 * - "Nothing needs you right now. 3 of your PRs are waiting on others."
 */
export function overviewBriefing(model: Pick<OverviewModel, 'lanes' | 'counts'>): string {
  const lane = (name: OverviewLane) => model.lanes.find((entry) => entry.lane === name)?.rows ?? [];
  const answer = lane('answer');
  // Rows are oldest first, so the first people named have waited longest.
  const people = [...new Set(answer.map((row) => row.person).filter((person): person is string => !!person))];
  const blocked: string[] = [];
  if (answer.length) {
    const on = answer.length > Math.max(1, people.length) ? ` on ${answer.length} PRs` : '';
    if (!people.length) blocked.push(`${plural(answer.length, 'PR is', 'PRs are')} waiting on your reply`);
    else if (people.length === 1) blocked.push(`${people[0]} is waiting on your reply${on}`);
    else if (people.length === 2) blocked.push(`${people[0]} and ${people[1]} are waiting on your reply${on}`);
    else blocked.push(`${people[0]}, ${people[1]} and ${plural(people.length - 2, 'other', 'others')} are waiting on your reply${on}`);
  }
  // PRs, not rows: a stack of three PRs waiting on your review is three reviews, as Waiting on you counts it.
  const reviews = lane('review').reduce((total, row) => total + (row.entries?.length || 1), 0);
  if (reviews) blocked.push(`${plural(reviews, 'review is', 'reviews are')} waiting on you`);
  const own: string[] = [];
  // Only approved PRs are "ready": a PR the branch rules let merge without review is named apart.
  const ready = lane('merge');
  const unreviewed = ready.filter((row) => row.merge?.notes[0]?.kind === 'no-review').length;
  const approved = ready.length - unreviewed;
  const merges = ready.length;
  if (approved && unreviewed) own.push(`${plural(approved, 'PR is', 'PRs are')} approved and ready to merge, ${unreviewed} more can merge without review`);
  else if (approved) own.push(`${plural(approved, 'PR is', 'PRs are')} approved and ready to merge`);
  else if (unreviewed) own.push(`${plural(unreviewed, 'PR', 'PRs')} can merge without review`);
  const fix = lane('fix');
  const failed = fix.filter((row) => row.reasons.includes('checks-failed')).length;
  // After "N PRs are ready to merge", the second clause says "2 have failed checks": the PRs are already named.
  if (failed) own.push(merges ? `${failed} ${failed === 1 ? 'has' : 'have'} failed checks` : `${plural(failed, 'PR has', 'PRs have')} failed checks`);
  else if (fix.length) own.push(merges ? `${fix.length} ${fix.length === 1 ? 'needs' : 'need'} a fix` : `${plural(fix.length, 'PR needs', 'PRs need')} a fix`);
  // A sentence starts with a capital, except a GitHub login: it is a name, spelled as GitHub spells it.
  const sentence = (clauses: string[], named: boolean) => {
    const text = clauses.join(', and ');
    return `${named ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`}.`;
  };
  const parts = [
    ...(blocked.length ? [sentence(blocked, people.length > 0)] : []),
    ...(own.length ? [sentence(own, false)] : []),
  ];
  if (parts.length) return parts.join(' ');
  const waiting = model.counts.waiting;
  return `Nothing needs you right now.${waiting ? ` ${waiting === 1 ? '1 of your PRs is' : `${waiting} of your PRs are`} waiting on others.` : ''}`;
}

/**
 * Where each PR sits in the queue's Action grouping (`groupBy: 'action'`): the Overview's lanes in the Overview's
 * order, Merge split into Ready (Merge) and Parked, and Other for PRs in no lane. A PR in two lanes, such as changes
 * requested and failing checks, goes to the first.
 */
export type OverviewActionGroup = 'answer' | 'review' | 'merge' | 'fix' | 'waiting' | 'parked' | 'other';
export const OVERVIEW_ACTION_GROUPS: readonly OverviewActionGroup[] = ['answer', 'review', 'merge', 'fix', 'waiting', 'parked', 'other'];
export const OVERVIEW_ACTION_GROUP_LABEL: Readonly<Record<OverviewActionGroup, string>> = {
  answer: 'Answer',
  review: 'Review',
  merge: 'Merge',
  fix: 'Fix',
  waiting: 'Waiting on others',
  parked: 'Parked',
  other: 'Other',
};
export const isOverviewActionGroup = (value: unknown): value is OverviewActionGroup => OVERVIEW_ACTION_GROUPS.includes(value as OverviewActionGroup);
const groupRank = (group: OverviewActionGroup) => OVERVIEW_ACTION_GROUPS.indexOf(group);

/** Each PR URL's action group, from the lanes. A URL in no lane is absent: it is Other. */
export function overviewActionGroups(model: Pick<OverviewModel, 'lanes'>): Readonly<Record<string, OverviewActionGroup>> {
  const groups: Record<string, OverviewActionGroup> = {};
  const assign = (rows: readonly OverviewRow[], group: OverviewActionGroup) => {
    for (const row of rows)
      for (const entry of row.entries) {
        const current = groups[entry.member.url];
        if (!current || groupRank(group) < groupRank(current)) groups[entry.member.url] = group;
      }
  };
  for (const state of model.lanes) {
    assign(state.rows, state.lane);
    assign(state.parked, 'parked');
  }
  return groups;
}

/** A queue entry's action group: the first group any of its PRs is in, else Other. */
export function actionGroupOf(item: Pick<QueueItem, 'subject'>, groups: Readonly<Record<string, OverviewActionGroup>>): OverviewActionGroup {
  let best: OverviewActionGroup = 'other';
  for (const member of item.subject.members) {
    const group = groups[member.url];
    if (group && groupRank(group) < groupRank(best)) best = group;
  }
  return best;
}
