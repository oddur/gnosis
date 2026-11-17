/**
 * Notification events: the moment an attention kind enters a PR's set (`lib/attention.ts`), plus "approved",
 * which is edge-only and has no row. Pure. The persisted basis makes the same snapshot, a replay or a restart
 * derive nothing; `src/notification-store.ts` adds a persisted key per event on top.
 */
import { attentionTarget, memberAttention, type AttentionKind, type AttentionMember } from './attention';
import type { QueueSignals } from './queue-signals';
import type { DeepLinkTarget } from './deep-link';
import type { NotificationEventType } from './notification-settings';

export interface NotificationEvent {
  type: NotificationEventType;
  /** Idempotency key. The same key is never delivered twice. */
  key: string;
  title: string;
  url?: string;
  repo?: string;
  number?: number;
  /** Who caused it, such as the reviewer. */
  actor?: string;
  /** The actor is a bot or GitHub App. Bots never notify unless allowed (#385). Unset: judged by the login. */
  actorIsBot?: boolean;
  at: number;
  /** Where a click lands. Without one, a click only shows Gnosis. */
  target?: DeepLinkTarget;
  /** The reason a snoozed PR came back: "new comment from lena". */
  detail?: string;
  /** The PR is the user's own. "On me" counts changes requested, checks failed and ready to merge only then. */
  mine?: boolean;
  /** Checks failed: the settled run's counts. `names` are added when the check list can be read. */
  checks?: { failed: number; total: number; headSha: string; names?: string[] };
}
/** Row order of the design's event table: picks the headline when events coalesce. */
export const EVENT_RANK: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'mention',
  'changes-requested',
  'checks-failed',
  'reply',
  'ready-to-merge',
  'approved',
  'snooze-ended',
  'explanation-ready',
  'update-ready',
];
export const byEventRank = (a: NotificationEvent, b: NotificationEvent) => EVENT_RANK.indexOf(a.type) - EVENT_RANK.indexOf(b.type);

/** The last state seen for one PR. */
export interface PrBasis {
  headSha: string;
  /** Level kinds with identity tokens, as `memberAttention` returns them. */
  kinds: Partial<Record<AttentionKind, string>>;
  /** Persisted counters of request transitions, for the idempotency keys. */
  requests: number;
  teamRequests: number;
  team: boolean;
  /** Latest review identity; `null` means none, `undefined` means signals were never seen. */
  review?: string | null;
  /** Sorted `url:state` of each counted opinionated review. Undefined until signals with opinions were seen. */
  opinions?: string[];
  signalsAt?: number;
  /** When checks were first seen failing for this head while others still ran. */
  checksFailingSince?: number;
  observedAt: number;
}
export type ObservedMember = AttentionMember & { title: string; repo: string; number: number };
export interface PrObservation {
  member: ObservedMember;
  signals?: QueueSignals;
  /** A current explanation is saved: a review request opens it. */
  explanation?: boolean;
}
export interface DeriveContext {
  login: string;
  now: number;
  /** False until the first-run baseline is finished. */
  initialized: boolean;
  /** A write made in Gnosis: update the basis, raise nothing. */
  own?: boolean;
}
/** A basis older than this is replaced silently: a week-old edge is not news. */
export const STALE_BASIS_MS = 7 * 86_400_000;
/** Signals older than this update the basis but raise nothing. */
export const STALE_SIGNALS_MS = 30 * 60_000;
/**
 * "Checks failed" waits for the run to settle (no checks pending), but no longer than this after the first
 * failure was seen, so a hung job cannot hide it.
 */
export const CHECKS_SETTLE_CAP_MS = 20 * 60_000;
const STATUS_KINDS: readonly AttentionKind[] = ['changes-requested', 'checks-failed', 'conflicts', 'ready-to-merge'];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Event types whose request this observation shows as handled: the review was submitted or withdrawn, checks
 * went green, nobody requests changes any more, or the PR was merged or closed. A notification about a handled
 * request is closed.
 */
export type ResolvedTypes = NotificationEventType[];
export function deriveEvents(
  previous: PrBasis | undefined,
  next: PrObservation,
  context: DeriveContext
): { basis: PrBasis; events: NotificationEvent[]; resolved: ResolvedTypes } {
  const { member } = next;
  const { login, now } = context;
  const prev = previous && now - previous.observedAt <= STALE_BASIS_MS ? previous : undefined;
  const silent = !context.initialized || !!context.own || (!!previous && !prev);
  const sameHead = prev?.headSha === member.headSha;
  const own = same(member.author, login);
  const open = member.state === 'open' && !member.merged;
  const eligible = open && !member.isDraft && !own;
  const direct = eligible && member.requestedReviewers.some((reviewer) => same(reviewer, login));
  // Only discovery knows the search role. Metadata updates keep the last answer.
  const team = eligible && !direct && (member.role !== undefined ? member.role === 'review-requested' : (prev?.team ?? false));

  const signals = next.signals && next.signals.url === member.url && next.signals.headSha === member.headSha &&
    (!prev || !sameHead || next.signals.checkedAt > (prev.signalsAt ?? 0)) ? next.signals : undefined;
  const kinds: Partial<Record<AttentionKind, string>> = {};
  if (direct) kinds['review-requested'] = 'direct';
  // Status kinds come from signals for this head. A new head resets them to unknown without an event.
  // A merge keeps the head, so the kinds saved for it must not outlive the PR.
  const status = !open ? {} : signals ? memberAttention(member, signals, login) : sameHead ? prev.kinds : {};
  for (const kind of STATUS_KINDS) if (status[kind] !== undefined) kinds[kind] = status[kind];
  // A failure with checks still running has not settled: leave the kind out, so its edge fires once it does.
  let checksFailingSince = sameHead ? prev.checksFailingSince : undefined;
  if (!kinds['checks-failed']) checksFailingSince = undefined;
  else if (signals && (signals.checks.running ?? 0) > 0 && prev?.kinds['checks-failed'] !== kinds['checks-failed']) {
    checksFailingSince ??= now;
    if (now - checksFailingSince < CHECKS_SETTLE_CAP_MS) delete kinds['checks-failed'];
  }

  const requestEntered = direct && !prev?.kinds['review-requested'];
  const teamEntered = team && !prev?.team;
  const latest = signals?.latestReview;
  const review = signals ? (latest ? `${latest.url}:${latest.state}` : latest === null ? null : (prev?.review ?? null)) : prev?.review;
  const pair = (opinion: { url: string; state: string }) => `${opinion.url}:${opinion.state}`;
  const opinions = signals?.opinions ? signals.opinions.map(pair).sort() : prev?.opinions;
  const basis: PrBasis = {
    headSha: member.headSha,
    kinds,
    requests: (prev?.requests ?? 0) + (requestEntered ? 1 : 0),
    teamRequests: (prev?.teamRequests ?? 0) + (teamEntered ? 1 : 0),
    team,
    ...(review !== undefined ? { review } : {}),
    ...(opinions ? { opinions } : {}),
    ...(signals ?{ signalsAt: signals.checkedAt } : prev?.signalsAt !== undefined && sameHead ? { signalsAt: prev.signalsAt } : {}),
    ...(checksFailingSince !== undefined && kinds['checks-failed'] === undefined ? { checksFailingSince } : {}),
    observedAt: now,
  };
  const resolved: ResolvedTypes = !open
    ? [...NOTIFICATION_TYPES_RESOLVED_BY_CLOSE]
    : [
        ...(!direct ? ['review-requested' as const] : []),
        ...(!team ? ['team-review-requested' as const] : []),
        ...(signals && signals.checks.state === 'success' ? ['checks-failed' as const] : []),
        ...(signals && !kinds['changes-requested'] ? ['changes-requested' as const] : []),
      ];
  if (silent) return { basis, events: [], resolved };

  const events: NotificationEvent[] = [];
  const base = { title: member.title, url: member.url, repo: member.repo, number: member.number, at: now, ...(own ? { mine: true } : {}) };
  const add = (type: NotificationEventType, key: string, kind: AttentionKind, actor?: string, actorIsBot?: boolean) => {
    const target = attentionTarget(kind, member.url, { explanation: next.explanation });
    if (target) events.push({ ...base, type, key, target, ...(actor ? { actor } : {}), ...(actorIsBot ? { actorIsBot } : {}) });
  };
  if (requestEntered) add('review-requested', `requested|${member.url}|${basis.requests}`, 'review-requested');
  if (teamEntered) add('team-review-requested', `team-requested|${member.url}|${basis.teamRequests}`, 'review-requested');

  // A PR seen for the first time, or signals seen for the first time, only start a basis.
  const signalsKnown = prev?.review !== undefined;
  if (open && signals && signalsKnown && own && now - signals.checkedAt <= STALE_SIGNALS_MS) {
    const opinion = (review: { url: string; state: string; author: string }) => {
      if (same(review.author, login)) return;
      // GraphQL names an App without the `[bot]` suffix; the signals know its type.
      const bot = signals.activity?.recent?.some((entry) => entry.kind === 'review' && entry.id === review.url && entry.automated) || undefined;
      if (review.state === 'CHANGES_REQUESTED') add('changes-requested', `review|${review.url}`, 'changes-requested', review.author, bot);
      else if (review.state === 'APPROVED') add('approved', `review|${review.url}`, 'ready-to-merge', review.author, bot);
    };
    // Each reviewer's latest opinion is an edge when it is new, even if a comment followed it before this poll.
    if (signals.opinions && prev.opinions) {
      const seen = new Set(prev.opinions);
      for (const entry of signals.opinions) if (!seen.has(pair(entry))) opinion(entry);
    } else if (latest && review !== prev.review) opinion(latest);
    if (kinds['checks-failed'] && prev.kinds['checks-failed'] !== kinds['checks-failed']) {
      add('checks-failed', `checks-failed|${member.url}|${member.headSha}`, 'checks-failed');
      const event = events.at(-1);
      if (event?.type === 'checks-failed')
        event.checks = { failed: signals.checks.failed ?? 0, total: signals.checks.total, headSha: member.headSha };
    }
    if (kinds['ready-to-merge'] && prev.kinds['ready-to-merge'] !== kinds['ready-to-merge'])
      add('ready-to-merge', `ready|${member.url}|${member.headSha}`, 'ready-to-merge');
  }
  return { basis, events: subsume(events), resolved };
}
/** A merged or closed PR needs nothing: every notification about it is closed. */
const NOTIFICATION_TYPES_RESOLVED_BY_CLOSE: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'mention',
  'reply',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'snooze-ended',
  'explanation-ready',
];

/** "Ready to merge" absorbs "Approved" for the same PR. */
export function subsume(events: readonly NotificationEvent[]): NotificationEvent[] {
  const ready = new Set(events.filter((event) => event.type === 'ready-to-merge').map((event) => event.url));
  return events.filter((event) => event.type !== 'approved' || !ready.has(event.url));
}
