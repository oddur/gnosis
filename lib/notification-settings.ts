/**
 * Settings › Notifications. Pure, so main, the renderer and unit tests share one reading of `preferences.json`.
 * `preferences.notifications` stays the desktop master switch, so existing users keep their choice.
 */
import type { AttentionKind } from './attention';
import { repositoryKey, validRepository } from './repository-settings';

/** Phase 1 event types: attention kinds that notify when they enter a PR's set, plus edge-only events. */
export type NotificationEventType =
  | Extract<AttentionKind, 'review-requested' | 'changes-requested' | 'checks-failed' | 'ready-to-merge' | 'explanation-ready'>
  | 'team-review-requested'
  | 'approved'
  | 'update-ready'
  /** A snoozed PR came back and no other event says why. */
  | 'snooze-ended'
  /** New commits on someone else's PR since your review: a re-review is needed. */
  | 'rereview'
  /** You were @mentioned in a comment or review. Produced by #385 part 2. */
  | 'mention'
  /** A reply to you: a new comment in a thread you are in, or someone else's comment on your PR. #385 part 2. */
  | 'reply';
export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'rereview',
  'mention',
  'reply',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'explanation-ready',
  'update-ready',
  'snooze-ended',
];
/** Team review requests are the largest source of noise in organisations with CODEOWNERS teams. */
export const DEFAULT_NOTIFICATION_EVENTS: Readonly<Record<NotificationEventType, boolean>> = {
  'review-requested': true,
  'team-review-requested': false,
  rereview: true,
  mention: true,
  reply: true,
  'changes-requested': true,
  approved: true,
  'checks-failed': true,
  'ready-to-merge': true,
  'explanation-ready': true,
  'update-ready': true,
  'snooze-ended': true,
};
/** Events about a PR. Until the user has seen the introduction, these are delivered in the app only. */
export const PR_EVENT_TYPES: readonly NotificationEventType[] = [
  'review-requested',
  'team-review-requested',
  'rereview',
  'mention',
  'reply',
  'changes-requested',
  'approved',
  'checks-failed',
  'ready-to-merge',
  'snooze-ended',
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
  /** The level of repositories you do not watch and have not given a level. */
  otherRepositories?: RepositoryNotificationLevel;
  /** "Also notify for these bots": logins such as `coderabbitai[bot]`. Other bots never notify. */
  allowedBots?: string[];
}
export interface NotificationSettings {
  desktop: boolean;
  inApp: boolean;
  events: Record<NotificationEventType, boolean>;
  pausedUntil: number;
  introduced: boolean;
  allowReplies: boolean;
  otherRepositories: RepositoryNotificationLevel;
  /** Lower-case logins. */
  allowedBots: string[];
  /** Read from `repositorySettings[repo].notifications`, keyed by lower-case `owner/repo`. Not saved here. */
  repositories: Record<string, RepositoryNotificationLevel>;
  /** Lower-case `owner/repo` of watched repositories. Not saved here. */
  watched: string[];
}
export const PAUSE_DURATION = 60 * 60_000;

/**
 * Per-repository level (#385). `all`: whatever the global event switches allow. `on-me`: only events where the
 * next move is yours. `none`: nothing about this repository's PRs. A level only narrows the global switches.
 */
export type RepositoryNotificationLevel = 'all' | 'on-me' | 'none';
export const REPOSITORY_NOTIFICATION_LEVELS: readonly RepositoryNotificationLevel[] = ['all', 'on-me', 'none'];
export const REPOSITORY_NOTIFICATION_LABEL: Readonly<Record<RepositoryNotificationLevel, string>> = {
  all: 'All',
  'on-me': 'Only when it’s on me',
  none: 'None',
};
/** The short form for menus: "Notifications from org/repo: On me". */
export const REPOSITORY_NOTIFICATION_SHORT_LABEL: Readonly<Record<RepositoryNotificationLevel, string>> = { all: 'All', 'on-me': 'On me', none: 'None' };
export const isRepositoryNotificationLevel = (value: unknown): value is RepositoryNotificationLevel =>
  typeof value === 'string' && (REPOSITORY_NOTIFICATION_LEVELS as readonly string[]).includes(value);
/** Watched repositories without a level get All. */
export const DEFAULT_OTHER_REPOSITORIES: RepositoryNotificationLevel = 'all';
/** A GitHub login, optionally with the `[bot]` suffix REST adds to Apps. */
const validLogin = (login: string) => /^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i.test(login);
export function normalizeBotLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins = value.flatMap((login) => (typeof login === 'string' && validLogin(login.trim()) ? [login.trim().toLowerCase()] : []));
  return [...new Set(logins)].slice(0, 100);
}
/**
 * Events "on me": the next move is yours. A review requested of you personally (a re-request after new commits is
 * one too), a mention, a reply to you and, on your own PRs only, changes requested, checks failed and ready to
 * merge. A snooze you set and an explanation you are waiting for are yours as well. Team review requests,
 * approvals on their own and events on other people's PRs are not.
 */
const ON_ME: ReadonlySet<NotificationEventType> = new Set(['review-requested', 'rereview', 'mention', 'reply', 'snooze-ended', 'explanation-ready']);
const ON_ME_WHEN_MINE: ReadonlySet<NotificationEventType> = new Set(['changes-requested', 'checks-failed', 'ready-to-merge']);
export function levelAllows(level: RepositoryNotificationLevel, event: { type: NotificationEventType; mine?: boolean }): boolean {
  if (level === 'all') return true;
  if (level === 'none') return false;
  return ON_ME.has(event.type) || (ON_ME_WHEN_MINE.has(event.type) && event.mine === true);
}
/** A repository's own level, then All for a watched repository, then the "Other repositories" default. */
export function repositoryNotificationLevel(
  settings: Pick<NotificationSettings, 'repositories' | 'watched' | 'otherRepositories'>,
  repo: string
): RepositoryNotificationLevel {
  const key = repositoryKey(repo);
  return settings.repositories[key] ?? (settings.watched.includes(key) ? 'all' : settings.otherRepositories);
}
/** Whether a bot may notify: never, unless the user allowed that login. */
export const botAllowed = (settings: Pick<NotificationSettings, 'allowedBots'>, login: string) => {
  // GraphQL names an App `coderabbitai`, REST `coderabbitai[bot]`: either form matches.
  const bare = (value: string) => value.trim().toLowerCase().replace(/\[bot\]$/, '');
  return settings.allowedBots.some((allowed) => bare(allowed) === bare(login));
};

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
    otherRepositories: isRepositoryNotificationLevel(raw.otherRepositories) ? raw.otherRepositories : DEFAULT_OTHER_REPOSITORIES,
    allowedBots: normalizeBotLogins(raw.allowedBots),
    repositories: repositoryLevels(p.repositorySettings),
    watched: Array.isArray(p.watchedRepos) ? p.watchedRepos.flatMap((repo) => (typeof repo === 'string' ? [repositoryKey(repo)] : [])) : [],
  };
}
function repositoryLevels(value: unknown): Record<string, RepositoryNotificationLevel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([repo, settings]) => {
      const level = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).notifications : undefined;
      return validRepository(repo) && isRepositoryNotificationLevel(level) ? [[repositoryKey(repo), level]] : [];
    })
  );
}
/** The saved form of `notificationSettings`: every field present and valid. Repository levels live in `repositorySettings`. */
export type SavedNotificationPreferences = Omit<NotificationSettings, 'desktop' | 'repositories' | 'watched'>;
export function normalizeNotificationPreferences(preferences: unknown): SavedNotificationPreferences {
  const settings = notificationSettings(preferences);
  return {
    inApp: settings.inApp,
    events: settings.events,
    pausedUntil: settings.pausedUntil,
    introduced: settings.introduced,
    otherRepositories: settings.otherRepositories,
    allowedBots: settings.allowedBots,
    allowReplies: settings.allowReplies,
  };
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
