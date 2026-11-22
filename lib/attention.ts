/**
 * What needs the user's action, shared by notifications (#307) and the menu bar (#308).
 *
 * The menu bar shows the *current set* of kinds per PR. Notifications announce the *moment a kind enters*
 * a PR's set (see `lib/notification-events.ts`). Same kinds, same rank, same target, same switches, except `restack`:
 * the menu bar and the Overview show it, and no notification announces it.
 * Pure: no Node or Electron imports.
 *
 * Built by #307 Phase 1; #308 Phase 1 adds `explanation-ready` rows. `restack`: your PR's stack parent merged and the PR
 * still has to move onto the parent's base (`mergedParent`, #445).
 */
import { changeRequests, type QueueSignals } from './queue-signals';
import type { QueueItem, ReviewMember } from './workbench';
import { mergeReadiness } from './merge-readiness';
import { mergeConflictState } from './merge-conflicts';
import { prRef, prTarget, type DeepLinkTarget, type PrTab } from './deep-link';
import { mergedParent, mergedParentText, type MergedParent } from './stack-conflict-plan';

export type AttentionKind =
  | 'review-requested'
  | 'updated-since-review'
  | 'changes-requested'
  | 'checks-failed'
  | 'conflicts'
  | 'replies'
  | 'restack'
  | 'ready-to-merge'
  | 'explanation-ready';
/** Highest first. Picks the headline of a row and of a coalesced notification. */
export const ATTENTION_RANK: readonly AttentionKind[] = [
  'review-requested',
  'updated-since-review',
  'changes-requested',
  'checks-failed',
  'conflicts',
  'replies',
  'restack',
  'ready-to-merge',
  'explanation-ready',
];
export type AttentionGroup = 'review' | 'fix' | 'ready';
export const ATTENTION_GROUPS: readonly AttentionGroup[] = ['review', 'fix', 'ready'];
export const ATTENTION_GROUP: Readonly<Record<AttentionKind, AttentionGroup>> = {
  'review-requested': 'review',
  'updated-since-review': 'review',
  'changes-requested': 'fix',
  'checks-failed': 'fix',
  conflicts: 'fix',
  replies: 'fix',
  restack: 'fix',
  'ready-to-merge': 'ready',
  'explanation-ready': 'ready',
};
export const ATTENTION_LABEL: Readonly<Record<AttentionKind, string>> = {
  'review-requested': 'Review requested',
  'updated-since-review': 'Updated since your review',
  'changes-requested': 'Changes requested',
  'checks-failed': 'Checks failed',
  conflicts: 'Merge conflicts',
  replies: 'Awaiting your reply',
  restack: 'Needs to move',
  'ready-to-merge': 'Ready to merge',
  'explanation-ready': 'Explanation ready',
};
/** Identical to `NotificationTarget` in the #307 design. */
export type AttentionTarget = DeepLinkTarget;
export const attentionRank = (kind: AttentionKind) => ATTENTION_RANK.indexOf(kind);
export const byAttentionRank = (a: AttentionKind, b: AttentionKind) => attentionRank(a) - attentionRank(b);

/** Signals older than this are not used for status kinds: the row says so instead. */
export const ATTENTION_SIGNALS_MAX_AGE = 30 * 60_000;

export type AttentionMember = Pick<
  ReviewMember,
  'url' | 'author' | 'headSha' | 'baseSha' | 'baseBranch' | 'state' | 'merged' | 'isDraft' | 'requestedReviewers'
> & { role?: ReviewMember['role'] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const isOwnPr = (member: Pick<ReviewMember, 'author'>, login: string) => same(member.author, login);
const isOpen = (member: AttentionMember) => member.state === 'open' && !member.merged;
/** A direct request names the user. A `review-requested` search role without that is a team request. */
export function reviewRequest(member: AttentionMember, login: string): 'direct' | 'team' | undefined {
  if (!isOpen(member) || member.isDraft || isOwnPr(member, login)) return undefined;
  if (member.requestedReviewers.some((reviewer) => same(reviewer, login))) return 'direct';
  return member.role === 'review-requested' ? 'team' : undefined;
}

/**
 * The level kinds of one PR, each with an identity token. A kind *enters* the set when it is absent before or
 * its token changes: a new head SHA for checks and readiness, a new review for changes requested.
 * Only signals for the member's current head are used, and readiness is evaluated as of `signals.checkedAt`,
 * because `mergeReadiness` treats signals older than 2 minutes as not ready.
 */
export function memberAttention(
  member: AttentionMember,
  signals: QueueSignals | undefined,
  login: string,
  options: { teamRequests?: boolean } = {}
): Partial<Record<AttentionKind, string>> {
  const kinds: Partial<Record<AttentionKind, string>> = {};
  const request = reviewRequest(member, login);
  if (request === 'direct' || (request === 'team' && options.teamRequests)) kinds['review-requested'] = request;
  if (!isOpen(member) || !isOwnPr(member, login)) return kinds;
  const current = signals && signals.url === member.url && signals.headSha === member.headSha ? signals : undefined;
  if (!current) return kinds;
  // Each reviewer's latest opinion counts; a later comment, including the author's reply, does not clear it.
  // Snapshots saved before opinions were read know only the single newest review.
  const review = current.latestReview;
  const requested = changeRequests(current, login)?.[0] ??
    (!current.opinions && review && !same(review.author, login) && review.state === 'CHANGES_REQUESTED' ? review : undefined);
  if (requested) kinds['changes-requested'] = requested.url;
  else if (current.readiness?.reviewDecision === 'CHANGES_REQUESTED') kinds['changes-requested'] = 'decision';
  if (current.checks.state === 'failure') kinds['checks-failed'] = member.headSha;
  if (mergeConflictState(current) === 'conflicts') kinds.conflicts = `${member.headSha}:${current.readiness?.baseSha ?? member.baseSha}`;
  if (mergeReadiness(member, current, current.checkedAt).ready) kinds['ready-to-merge'] = member.headSha;
  return kinds;
}

/** Where a click on each kind lands. `explanation` is used for a review request only when an explanation is saved. */
export function attentionTarget(kind: AttentionKind, url: string, options: { explanation?: boolean; reviewId?: string } = {}): AttentionTarget | undefined {
  if (kind === 'explanation-ready' && options.reviewId) return { kind: 'review', reviewId: options.reviewId };
  // A conflicted PR opens its Conflicts view (#445 item 8), as Resolve conflicts… does.
  if (kind === 'conflicts') { const pr = prRef(url); if (pr) return { kind: 'conflicts', pr }; }
  const tab: PrTab =
    kind === 'review-requested'
      ? options.explanation ? 'explanation' : 'summary'
      : kind === 'updated-since-review' ? 'changes'
        : kind === 'changes-requested' || kind === 'replies' ? 'feedback'
          : kind === 'checks-failed' ? 'checks'
            : 'summary';
  return prTarget(url, tab);
}

export interface AttentionItem {
  /** `${subjectId}|${url}`; one row per PR. */
  id: string;
  group: AttentionGroup;
  /** Ranked; `kinds[0]` is the headline. */
  kinds: AttentionKind[];
  url: string;
  title: string;
  repo: string;
  number: number;
  author: string;
  /** Only open PRs need you, so a row is open or, with this, a draft. */
  isDraft?: boolean;
  stackSize?: number;
  /** The stack's subject id, shared by every row from the same stack. */
  stackId?: string;
  /** `restack`: "Parent #101 merged" (`mergedParentText`). */
  detail?: string;
  /** Needs you and not opened since. */
  isNew: boolean;
  /** Age of the signals behind status kinds. */
  checkedAt?: number;
  target: AttentionTarget;
}
const STATUS_KINDS: readonly AttentionKind[] = ['changes-requested', 'checks-failed', 'conflicts', 'ready-to-merge'];

/**
 * Whether this PR of a queue entry changed since your latest review of it. Per PR when main says which
 * (`QueueItem.sinceReview`); in older queues, every PR of an `updated` entry.
 */
export const updatedSinceYourReview = (item: Pick<QueueItem, 'attention' | 'sinceReview'>, url: string) =>
  item.attention === 'updated' && (!item.sinceReview || !!item.sinceReview[url]);

/** Signals young enough for status kinds (`ATTENTION_SIGNALS_MAX_AGE`). */
export const freshSignals = (signals: QueueSignals | undefined, now: number) =>
  signals && now - signals.checkedAt <= ATTENTION_SIGNALS_MAX_AGE ? signals : undefined;

/**
 * Every kind one open PR of a queue entry has, before notification switches apply: the level kinds of
 * `memberAttention`, updates since your review, replies to you, and an unread explanation. `fresh` must already be
 * young enough (`freshSignals`). Shared by `attentionItems` and the Overview lanes (`lib/overview.ts`).
 */
export function memberKinds(
  item: QueueItem,
  member: ReviewMember,
  fresh: QueueSignals | undefined,
  login: string,
  /** `merged`: the PR's `mergedParent` when the caller already has it, null for none. Undefined: found here. */
  options: { teamRequests?: boolean; merged?: MergedParent | null } = {}
): Set<AttentionKind> {
  const kinds = new Set(Object.keys(memberAttention(member, fresh, login, options)) as AttentionKind[]);
  if (updatedSinceYourReview(item, member.url) && !isOwnPr(member, login)) kinds.add('updated-since-review');
  if ((item.responses?.[member.url]?.awaitingReply ?? 0) > 0) kinds.add('replies');
  if (isOwnPr(member, login) && (options.merged === undefined ? mergedParent(item.subject, member) : options.merged))
    kinds.add('restack');
  // A finished, current, unread explanation. It folds into a review request on the same row.
  if (explanationFor(item, member.url)?.unread) kinds.add('explanation-ready');
  return kinds;
}

/** The current set, one row per PR, ordered by group and rank. Queue filters do not apply. */
export function attentionItems(input: {
  items: readonly QueueItem[];
  signals: (member: ReviewMember) => QueueSignals | undefined;
  login: string;
  enabled: (kind: AttentionKind, repo: string) => boolean;
  now: number;
  teamRequests?: boolean;
  /** "Delivered and not opened since". Defaults to the unread marker. */
  isNew?: (url: string, item: QueueItem) => boolean;
}): AttentionItem[] {
  const rows: AttentionItem[] = [];
  const updated = new Map<string, number>();
  for (const item of input.items) {
    for (const member of item.subject.members) {
      // A merged or closed PR needs nobody: no replies, explanations or status kinds keep it listed.
      // A snoozed PR in a stack that stays in the queue needs nobody until it wakes.
      if (!isOpen(member) || item.snoozedUrls?.includes(member.url)) continue;
      const signals = input.signals(member);
      const fresh = freshSignals(signals, input.now);
      const merged = mergedParent(item.subject, member) ?? null;
      const kinds = memberKinds(item, member, fresh, input.login, { teamRequests: input.teamRequests, merged });
      const explanation = explanationFor(item, member.url);
      for (const kind of kinds) if (!input.enabled(kind, member.repo)) kinds.delete(kind);
      // A fix comes before merging.
      if ([...kinds].some((kind) => ATTENTION_GROUP[kind] === 'fix')) kinds.delete('ready-to-merge');
      if (!kinds.size) continue;
      const ranked = [...kinds].sort(byAttentionRank);
      const saved = !!item.review && (item.review.status ?? 'completed') === 'completed';
      const target = attentionTarget(ranked[0], member.url, { explanation: saved, reviewId: explanation?.id });
      if (!target) continue;
      const isNew = input.isNew ? input.isNew(member.url, item) : !!item.unreadUrls?.includes(member.url) || (kinds.has('explanation-ready') && !!explanation?.unread);
      updated.set(`${item.subject.id}|${member.url}`, Date.parse(member.updatedAt) || 0);
      rows.push({
        id: `${item.subject.id}|${member.url}`,
        group: ATTENTION_GROUP[ranked[0]],
        kinds: ranked,
        url: member.url,
        title: member.title,
        repo: member.repo,
        number: member.number,
        author: member.author,
        ...(member.isDraft ? { isDraft: true } : {}),
        ...(item.subject.kind === 'stack' ? { stackSize: item.subject.members.length, stackId: item.subject.id } : {}),
        ...(merged && kinds.has('restack') ? { detail: mergedParentText(member, merged, 'short') } : {}),
        isNew,
        ...(fresh && ranked.some((kind) => STATUS_KINDS.includes(kind)) ? { checkedAt: fresh.checkedAt } : {}),
        target,
      });
    }
  }
  // Groups are fixed. Inside a group: rank, then new before seen, then most recently updated.
  return rows.sort(
    (a, b) =>
      ATTENTION_GROUPS.indexOf(a.group) - ATTENTION_GROUPS.indexOf(b.group) ||
      byAttentionRank(a.kinds[0], b.kinds[0]) ||
      Number(b.isNew) - Number(a.isNew) ||
      (updated.get(b.id) ?? 0) - (updated.get(a.id) ?? 0)
  );
}

/**
 * The saved explanation that makes a row "Explanation ready": completed, current for the subject (an outdated one
 * makes the item `updated` instead), on this PR or, for a stack, on the stack as a whole.
 */
export function explanationFor(item: QueueItem, url: string): { id: string; unread: boolean } | undefined {
  const review = item.review;
  if (!review || (review.status ?? 'completed') !== 'completed' || item.attention === 'updated' || item.reviewOutdated) return undefined;
  const members = item.subject.members;
  const owner = members.some((member) => member.url === review.prUrl) ? review.prUrl : members[0]?.url;
  return owner === url ? { id: review.id, unread: !!review.unread } : undefined;
}

export function attentionSummary(items: readonly AttentionItem[]): { needYou: number; ready: number; fresh: number; line: string } {
  const ready = items.filter((item) => item.group === 'ready').length;
  const needYou = items.length - ready;
  const fresh = items.filter((item) => item.isNew).length;
  const parts = [needYou ? `${needYou} need${needYou === 1 ? 's' : ''} you` : '', ready ? `${ready} ready` : ''].filter(Boolean);
  return { needYou, ready, fresh, line: parts.length ? parts.join(' · ') : 'Nothing needs you' };
}

/** `new`: PRs that need you and that you have not opened since. `all`: every row. */
export const badgeCount = (items: readonly AttentionItem[], mode: 'new' | 'all') =>
  mode === 'all' ? items.length : items.filter((item) => item.isNew).length;
