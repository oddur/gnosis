/**
 * The Overview lanes (#390): what you can act on right now, across every repository in the queue. Pure, with no
 * Node, Electron or React imports. Built from the same attention model as notifications and the menu bar
 * (`lib/attention.ts`), over the queue snapshot the window already holds, so it adds no GitHub reads.
 *
 * - **Merge:** your PRs that are ready to merge.
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
import { ATTENTION_LABEL, ATTENTION_RANK, explanationFor, freshSignals, isOwnPr, memberKinds, type AttentionKind } from './attention';
import { changeRequests, type QueueSignals } from './queue-signals';
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
/** An item waiting this long is flagged "Stale". */
export const OVERVIEW_STALE_MS = 3 * 86_400_000;

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
/** The reason the lane's name already says. Rows leave it out, as the menu bar does. */
export const LANE_IMPLIED: Readonly<Partial<Record<OverviewLane, OverviewReason>>> = { merge: 'ready-to-merge', review: 'review-requested' };
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
  /** Who the row is about: the author to review, or the reviewer you answer or wait on. */
  person: string;
  since: number;
  source: OverviewSinceSource;
  /** "2 d": how long it has waited, at the model's time. */
  waiting: string;
  stale: boolean;
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
  rows: OverviewRow[];
}
export interface OverviewModel {
  lanes: OverviewLaneState[];
  counts: Readonly<Record<OverviewLane, number>>;
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
}

/** The last visit, saved per account in local storage. */
export interface OverviewVisit {
  at: number;
  keys: string[];
}
export const overviewVisitKey = (account: string) => `gnosis-overview-visit:v1:${account}`;
export function parseOverviewVisit(raw: string | null): OverviewVisit | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<OverviewVisit>;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at) || !Array.isArray(value.keys)) return undefined;
    return { at: value.at, keys: value.keys.filter((key): key is string => typeof key === 'string').slice(0, 2000) };
  } catch {
    return undefined;
  }
}
export const nextOverviewVisit = (model: Pick<OverviewModel, 'keys'>, now: number): OverviewVisit => ({ at: now, keys: model.keys.slice(0, 2000) });

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

/** Who a row is about, per lane. */
function personFor(lane: OverviewLane, entry: OverviewEntry, fresh: QueueSignals | undefined, login: string): string {
  const { member } = entry;
  if (lane === 'answer') {
    if (entry.reasons[0] === 'changes-requested') {
      const request = fresh ? changeRequests(fresh, login)?.[0] : undefined;
      if (request) return request.author;
    }
    const reply = [...(fresh?.activity?.recent ?? [])].reverse().find((item) => item.kind === 'comment' && !same(item.author, login) && !item.automated);
    if (reply) return reply.author;
  }
  if (lane === 'merge') {
    const approval = [...(fresh?.opinions ?? [])].filter((review) => review.state === 'APPROVED').sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).at(0);
    if (approval) return approval.author;
  }
  if (lane === 'waiting') return member.requestedReviewers.at(0) ?? member.requestedTeams.at(0) ?? member.author;
  return member.author;
}

const sum = (values: (number | undefined)[]) => (values.some((value) => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined);

/** The lanes, each sorted oldest first. Snoozed, muted, merged and closed PRs are left out, as in the queue. */
export function overviewModel(input: OverviewInput): OverviewModel {
  const { login, now } = input;
  const lanes = new Map<OverviewLane, OverviewRow[]>(OVERVIEW_LANES.map((lane) => [lane, []]));
  const urls = new Map<OverviewLane, Set<string>>(OVERVIEW_LANES.map((lane) => [lane, new Set()]));
  const unchecked = new Set<string>();
  const previous = input.previous ? new Set(input.previous.keys) : undefined;
  let fresh = 0;
  for (const item of input.items) {
    const subject = item.subject;
    const mergedUrls = new Set(subject.members.filter((member) => member.merged).map((member) => member.url));
    const parentMerged = new Set(subject.edges.filter((edge) => mergedUrls.has(edge.parent)).map((edge) => edge.child));
    const perLane = new Map<OverviewLane, { entry: OverviewEntry; fresh?: QueueSignals }[]>();
    for (const member of subject.members) {
      if (!isOpen(member) || item.snoozedUrls?.includes(member.url) || input.excluded?.has(member.url)) continue;
      const signals = freshSignals(input.signals(member), now);
      const current = signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;
      if (isOwnPr(member, login) && !current) unchecked.add(member.url);
      const reasons = memberReasons(item, member, current, login, { teamRequests: input.teamRequests, parentMerged: parentMerged.has(member.url) });
      for (const lane of OVERVIEW_LANES) {
        const laneReasons = LANE_REASONS[lane].filter((reason) => reasons.has(reason)).sort(byReason);
        if (!laneReasons.length) continue;
        // A PR has waited since the first of its reasons in this lane.
        const since = laneReasons.map((reason) => reasonSince(reason, member, current, login)).sort((a, b) => a.at - b.at)[0];
        const list = perLane.get(lane) ?? [];
        list.push({ entry: { member, reasons: laneReasons, since: Math.min(since.at, now), source: since.source }, fresh: current });
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
      const changedAt = Math.max(first.entry.since, ...entries.map((entry) => time(entry.member.updatedAt) ?? 0));
      const isNew = !!previous && !!input.previous && (!previous.has(key) || changedAt > input.previous.at);
      if (isNew && lane !== 'waiting') fresh++;
      const saved = lane === 'review' ? subject.members.map((member) => explanationFor(item, member.url)).find(Boolean) : undefined;
      const row: Omit<OverviewRow, 'signature'> = {
        id,
        lane,
        item,
        kind: subject.kind,
        title: stack ? subject.name || subject.title : focus.title,
        focus,
        entries,
        ...(stack ? { stackSize: subject.members.length } : {}),
        reasons,
        person: personFor(lane, first.entry, first.fresh, login),
        since: first.entry.since,
        source: first.entry.source,
        waiting: waitingLabel(first.entry.since, now),
        stale: now - first.entry.since >= OVERVIEW_STALE_MS,
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
        row.key, row.title, row.person, row.since, row.waiting, row.stale, row.isNew, row.additions, row.deletions, row.files, row.explanation?.reviewId,
        row.stackSize, entries.map((entry) => [entry.member.title, entry.member.isDraft, entry.member.state, entry.member.number, entry.member.repo]),
      ]);
      lanes.get(lane)?.push({ ...row, signature });
      for (const entry of entries) urls.get(lane)?.add(entry.member.url);
    }
  }
  const states = OVERVIEW_LANES.map((lane): OverviewLaneState => ({
    lane,
    rows: (lanes.get(lane) ?? []).sort((a, b) => a.since - b.since || a.title.localeCompare(b.title)),
  }));
  const counts = Object.fromEntries(states.map((state) => [state.lane, state.rows.length])) as Record<OverviewLane, number>;
  return {
    lanes: states,
    counts,
    actionable: ACTION_LANES.reduce((total, lane) => total + counts[lane], 0),
    fresh,
    unchecked: unchecked.size,
    urls: Object.fromEntries(OVERVIEW_LANES.map((lane) => [lane, [...(urls.get(lane) ?? [])]])) as Record<OverviewLane, string[]>,
    keys: states.flatMap((state) => state.rows.map((row) => row.key)),
  };
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
export const rowReasons = (row: Pick<OverviewRow, 'lane' | 'reasons'>) => row.reasons.filter((reason) => reason !== LANE_IMPLIED[row.lane]);
