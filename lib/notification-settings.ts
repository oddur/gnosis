/**
 * Settings › Notifications. Pure, so main, the renderer and unit tests share one reading of `preferences.json`.
 * `preferences.notifications` stays the desktop master switch, so existing users keep their choice.
 */
import type { AttentionKind } from './attention';

/** Phase 1 event types: attention kinds that notify when they enter a PR's set, plus edge-only events. */
export type NotificationEventType =
  | Extract<AttentionKind, 'review-requested' | 'changes-requested' | 'checks-failed' | 'ready-to-merge' | 'explanation-ready'>
  | 'team-review-requested'
  | 'approved'
  | 'update-ready'
  /** A snoozed PR came back and no other event says why. */
  | 'snooze-ended'
  /** Someone wrote @you in a comment or review. */
  | 'mention'
  /** A new comment in a review thread you started or wrote in, or from someone else on your own PR. */
  | 'reply';
export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'explanation-ready',
  'update-ready',
  'snooze-ended',
  'mention',
  'reply',
];
/** Team review requests are the largest source of noise in organisations with CODEOWNERS teams. */
export const DEFAULT_NOTIFICATION_EVENTS: Readonly<Record<NotificationEventType, boolean>> = {
  'review-requested': true,
  'team-review-requested': false,
  'changes-requested': true,
  approved: true,
  'checks-failed': true,
  'ready-to-merge': true,
  'explanation-ready': true,
  'update-ready': true,
  'snooze-ended': true,
  mention: true,
  reply: true,
};
/** Events about a PR. Until the user has seen the introduction, these are delivered in the app only. */
export const PR_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'snooze-ended',
  'mention',
  'reply',
];
export const isPrEvent = (type: NotificationEventType) => PR_EVENT_TYPES.includes(type);

export interface NotificationPreferences {
  inApp?: boolean;
  events?: Partial<Record<NotificationEventType, boolean>>;
  /** Epoch milliseconds: the end of a pause. */
  pausedUntil?: number;
  /** "Allow replies from notifications". On unless saved as `false`. */
  allowReplies?: boolean;
  /** True once the user answered the "Turn on" introduction. */
  introduced?: boolean;
}
export interface NotificationSettings {
  desktop: boolean;
  inApp: boolean;
  events: Record<NotificationEventType, boolean>;
  pausedUntil: number;
  introduced: boolean;
  allowReplies: boolean;
}
export const PAUSE_DURATION = 60 * 60_000;

/** Missing or invalid values fall back to the defaults. Switches are on unless saved as `false`. */
export function notificationSettings(preferences: unknown): NotificationSettings {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  const raw = (p.notificationSettings && typeof p.notificationSettings === 'object' ? p.notificationSettings : {}) as Record<string, unknown>;
  const saved = (raw.events && typeof raw.events === 'object' ? raw.events : {}) as Record<string, unknown>;
  const events = Object.fromEntries(
    NOTIFICATION_EVENT_TYPES.map((type) => [type, typeof saved[type] === 'boolean' ? saved[type] : DEFAULT_NOTIFICATION_EVENTS[type]])
  ) as Record<NotificationEventType, boolean>;
  return {
    desktop: p.notifications !== false,
    inApp: raw.inApp !== false,
    events,
    pausedUntil: typeof raw.pausedUntil === 'number' && Number.isFinite(raw.pausedUntil) && raw.pausedUntil > 0 ? raw.pausedUntil : 0,
    introduced: raw.introduced === true,
    allowReplies: raw.allowReplies !== false,
  };
}
/** The saved form of `notificationSettings`: every field present and valid. */
export type SavedNotificationPreferences = Omit<NotificationSettings, 'desktop'>;
export function normalizeNotificationPreferences(preferences: unknown): SavedNotificationPreferences {
  const settings = notificationSettings(preferences);
  return { inApp: settings.inApp, events: settings.events, pausedUntil: settings.pausedUntil, introduced: settings.introduced, allowReplies: settings.allowReplies };
}
export const isPaused = (settings: Pick<NotificationSettings, 'pausedUntil'>, now: number) => settings.pausedUntil > now;

/** The pause choices in Settings › Notifications. Focus and Do Not Disturb cover quiet hours. */
export type PauseChoice = 'hour' | 'morning' | 'monday';
export const PAUSE_CHOICES: readonly PauseChoice[] = ['hour', 'morning', 'monday'];
export const PAUSE_LABELS: Record<PauseChoice, string> = { hour: 'Pause for 1 hour', morning: 'Until tomorrow morning', monday: 'Until Monday' };
/** A pause "until morning" ends at this local hour. */
export const MORNING_HOUR = 8;
/** Before this local hour, "tomorrow morning" still means the coming morning, not the one after it. */
const NIGHT_ENDS_HOUR = 4;
/**
 * When a pause chosen at `now` ends, in local time. "Tomorrow morning" is the next 08:00 at least a night away;
 * "Monday" is 08:00 on the next Monday, a week ahead once Monday's night is over.
 */
export function pauseUntil(choice: PauseChoice, now: number): number {
  if (choice === 'hour') return now + PAUSE_DURATION;
  const at = new Date(now);
  const morning = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), MORNING_HOUR, 0, 0, 0);
  if (choice === 'morning') {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + (at.getHours() < NIGHT_ENDS_HOUR ? 0 : 1));
    return morning(day).getTime();
  }
  const ahead = at.getDay() === 1 && at.getHours() < NIGHT_ENDS_HOUR ? 0 : (8 - at.getDay()) % 7 || 7;
  return morning(new Date(at.getFullYear(), at.getMonth(), at.getDate() + ahead)).getTime();
}
/** An IPC pause request: a choice, `true` for the hour (older renderers), or `false` to resume. */
export function parsePauseRequest(value: unknown): PauseChoice | false | undefined {
  if (value === false) return false;
  if (value === true) return 'hour';
  return PAUSE_CHOICES.includes(value as PauseChoice) ? (value as PauseChoice) : undefined;
}
