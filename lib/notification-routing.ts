/**
 * Where a notification goes, and how events become one notification. Pure, so the rules are tested without
 * Electron. Each event gets exactly one transient surface: a desktop notification when no Gnosis window has
 * focus, an in-app toast when one does.
 */
import { byEventRank, EVENT_RANK, subsume, type NotificationEvent } from './notification-events';
import { isPaused, isPrEvent, type NotificationEventType, type NotificationSettings } from './notification-settings';
import type { DeepLinkTarget } from './deep-link';

/** `failed`: the OS reported a failed delivery this session. `unsupported`: `Notification.isSupported()` is false. */
export type DesktopState = 'available' | 'unsupported' | 'failed';
export interface RouteContext {
  /** A Gnosis window has focus. */
  focused: boolean;
  /** The PR shown in the focused window's active workspace. */
  activeUrl?: string;
  desktop: DesktopState;
  settings: NotificationSettings;
  now: number;
}
export type Route =
  | { surface: 'desktop' | 'toast' }
  | { surface: 'none'; reason: 'type-off' | 'active' | 'in-app-off' | 'banner' }
  /** Paused: hold, and summarise when the pause ends. */
  | { surface: 'hold'; reason: 'paused' };

export function routeEvent(event: Pick<NotificationEvent, 'type' | 'url'>, context: RouteContext): Route {
  const { settings } = context;
  if (!settings.events[event.type]) return { surface: 'none', reason: 'type-off' };
  if (isPaused(settings, context.now)) return { surface: 'hold', reason: 'paused' };
  if (context.focused) {
    // The open view is already live.
    if (event.url && event.url === context.activeUrl) return { surface: 'none', reason: 'active' };
    // The update banner is the in-app surface for updates.
    if (event.type === 'update-ready') return { surface: 'none', reason: 'banner' };
    return settings.inApp ? { surface: 'toast' } : { surface: 'none', reason: 'in-app-off' };
  }
  const desktop = settings.desktop && context.desktop === 'available' && (!isPrEvent(event.type) || settings.introduced);
  if (desktop) return { surface: 'desktop' };
  if (event.type === 'update-ready') return { surface: 'none', reason: 'banner' };
  // Toast timers pause while the window is unfocused, so the toast waits for the user's return.
  return settings.inApp ? { surface: 'toast' } : { surface: 'none', reason: 'in-app-off' };
}

export type NotificationKind = NotificationEventType | 'summary' | 'test';
/** One notification, as shown on either surface. */
export interface NotificationDelivery {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** `owner/repo #123`, shown as the macOS subtitle. */
  subtitle?: string;
  url?: string;
  target?: DeepLinkTarget;
  keys: string[];
  types: NotificationEventType[];
  /** Offer "Turn on" for desktop delivery on this toast. */
  introduce?: boolean;
}

const LABEL: Record<NotificationEventType, string> = {
  'review-requested': 'Review requested',
  'team-review-requested': 'Review requested from your team',
  'changes-requested': 'Changes requested',
  approved: 'Approved',
  'checks-failed': 'Checks failed',
  'ready-to-merge': 'Ready to merge',
  'explanation-ready': 'Explanation ready',
  'update-ready': 'A Gnosis update is ready',
};
const COUNT_LABEL: Record<NotificationEventType, [string, string]> = {
  'review-requested': ['review request', 'review requests'],
  'team-review-requested': ['team review request', 'team review requests'],
  'changes-requested': ['change request', 'change requests'],
  approved: ['approval', 'approvals'],
  'checks-failed': ['failing check', 'failing checks'],
  'ready-to-merge': ['PR ready to merge', 'PRs ready to merge'],
  'explanation-ready': ['explanation ready', 'explanations ready'],
  'update-ready': ['update', 'updates'],
};
export const TITLE_LIMIT = 60;
export const BODY_LIMIT = 140;
export const truncate = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
/** Notification daemons differ in whether they accept markup. */
export const plainText = (text: string) => text.replace(/[<>&]/g, '');

/** The line for one event, used as the body of a single notification and as a line of a coalesced one. */
export function eventLine(event: NotificationEvent): string {
  if (event.type === 'changes-requested' && event.actor) return `${event.actor} requested changes`;
  if (event.type === 'approved' && event.actor) return `${event.actor} approved`;
  return LABEL[event.type];
}
const subtitleOf = (event: NotificationEvent) => (event.repo && event.number ? `${event.repo} #${event.number}` : undefined);

/** Several events for one PR, after its settle window, become one notification. */
export function coalesce(events: readonly NotificationEvent[], id: string): NotificationDelivery | undefined {
  const ranked = subsume(events).sort(byEventRank);
  const head = ranked[0] as NotificationEvent | undefined;
  if (!head) return undefined;
  const common = {
    id,
    kind: head.type,
    subtitle: subtitleOf(head),
    url: head.url,
    target: head.target,
    keys: ranked.map((event) => event.key),
    types: ranked.map((event) => event.type),
  };
  if (ranked.length === 1) {
    if (head.type === 'update-ready') return { ...common, title: LABEL[head.type], body: truncate(head.title, BODY_LIMIT) };
    const line = eventLine(head);
    return { ...common, title: truncate(line, TITLE_LIMIT), body: truncate(head.title, BODY_LIMIT) };
  }
  const where = head.number ? `#${head.number}` : 'this PR';
  return {
    ...common,
    title: truncate(`${ranked.length} updates on ${where}`, TITLE_LIMIT),
    body: truncate(`${ranked.slice(0, 2).map(eventLine).join(' · ')} · ${head.title}`, BODY_LIMIT),
  };
}

/** "2 review requests · 2 failing checks · 1 approval", ranked. */
export function countLine(types: readonly NotificationEventType[]): string {
  const counts = new Map<NotificationEventType, number>();
  for (const type of [...types].sort((a, b) => EVENT_RANK.indexOf(a) - EVENT_RANK.indexOf(b))) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${n} ${COUNT_LABEL[type][n === 1 ? 0 : 1]}`).join(' · ');
}
export const UNREAD_TARGET: DeepLinkTarget = { kind: 'queue', filters: { read: 'unread' } };
/** Three or more held events become one summary that opens the Unread view. */
export function summarize(events: readonly NotificationEvent[], id: string, title = `${events.length} updates while you were away`): NotificationDelivery {
  return {
    id,
    kind: 'summary',
    title: truncate(title, TITLE_LIMIT),
    body: truncate(countLine(events.map((event) => event.type)), BODY_LIMIT),
    target: UNREAD_TARGET,
    keys: events.map((event) => event.key),
    types: [...new Set(events.map((event) => event.type))],
  };
}
/** Several waiting notifications, such as those over the desktop rate limit, become one digest. */
export function digest(deliveries: readonly NotificationDelivery[], id: string): NotificationDelivery {
  return {
    id,
    kind: 'summary',
    title: `${deliveries.length} more updates`,
    body: truncate(countLine(deliveries.flatMap((delivery) => delivery.types)), BODY_LIMIT),
    target: UNREAD_TARGET,
    keys: deliveries.flatMap((delivery) => delivery.keys),
    types: [...new Set(deliveries.flatMap((delivery) => delivery.types))],
  };
}
export const CATCH_UP_SUMMARY_MIN = 3;
/** A catch-up batch: one or two PRs are delivered as normal, three or more events become one summary. */
export function batch(events: readonly NotificationEvent[], nextId: () => string, title?: string): NotificationDelivery[] {
  const kept = subsume(events);
  if (kept.length >= CATCH_UP_SUMMARY_MIN) return [summarize(kept, nextId(), title)];
  const byPr = new Map<string, NotificationEvent[]>();
  for (const event of kept) byPr.set(event.url ?? event.key, [...(byPr.get(event.url ?? event.key) ?? []), event]);
  return [...byPr.values()].flatMap((group) => coalesce(group, nextId()) ?? []);
}

/** At most three desktop notifications in any five minutes. */
export const DESKTOP_LIMIT = { count: 3, windowMs: 5 * 60_000 };
/** Main to renderer, on the `notification` channel. */
export type NotificationMessage = { type: 'show'; delivery: NotificationDelivery } | { type: 'close'; urls: string[] };
/** When the next desktop notification may be shown, given the times of recent ones. */
export function nextDesktopSlot(shown: readonly number[], now: number): number {
  const recent = shown.filter((at) => now - at < DESKTOP_LIMIT.windowMs).sort((a, b) => a - b);
  return recent.length < DESKTOP_LIMIT.count ? now : recent[recent.length - DESKTOP_LIMIT.count] + DESKTOP_LIMIT.windowMs;
}
/** Events for one PR wait this long, so a burst becomes one notification. */
export const SETTLE_MS = 20_000;
/** Without a successful sync for this long, the next pass is a catch-up pass. */
export const CATCH_UP_GAP_MS = 10 * 60_000;
export function isCatchUp(input: { lastSyncAt?: number; now: number; resumed: boolean; intervalMs: number }): boolean {
  if (input.resumed || input.lastSyncAt === undefined) return true;
  // A slow watch cadence is not a gap: allow one interval plus slack.
  return input.now - input.lastSyncAt > Math.max(CATCH_UP_GAP_MS, input.intervalMs + 2 * 60_000);
}
