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
  | 'update-ready';
export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'explanation-ready',
  'update-ready',
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
};
/** Events about a PR. Until the user has seen the introduction, these are delivered in the app only. */
export const PR_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
];
export const isPrEvent = (type: NotificationEventType) => PR_EVENT_TYPES.includes(type);

export interface NotificationPreferences {
  inApp?: boolean;
  events?: Partial<Record<NotificationEventType, boolean>>;
  /** Epoch milliseconds; "Pause for 1 hour". */
  pausedUntil?: number;
  /** True once the user answered the "Turn on" introduction. */
  introduced?: boolean;
}
export interface NotificationSettings {
  desktop: boolean;
  inApp: boolean;
  events: Record<NotificationEventType, boolean>;
  pausedUntil: number;
  introduced: boolean;
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
  };
}
/** The saved form of `notificationSettings`: every field present and valid. */
export type SavedNotificationPreferences = Omit<NotificationSettings, 'desktop'>;
export function normalizeNotificationPreferences(preferences: unknown): SavedNotificationPreferences {
  const settings = notificationSettings(preferences);
  return { inApp: settings.inApp, events: settings.events, pausedUntil: settings.pausedUntil, introduced: settings.introduced };
}
export const isPaused = (settings: Pick<NotificationSettings, 'pausedUntil'>, now: number) => settings.pausedUntil > now;
