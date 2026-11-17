/**
 * "Since yesterday" on the Overview's morning page (#390): what changed while you were away. Pure.
 *
 * Main keeps a small log per account (`src/since-log-service.ts`), fed from what it already sees:
 * - the notification events the workbench derives, after muted and snoozed PRs are left out: new review requests
 *   (direct and team), replies and mentions with who wrote them, and checks that failed on your PRs;
 * - the sync's PR updates: your PRs that merged, and your PRs whose checks went from failing to passing.
 *
 * The log keeps `SINCE_LOG_LIMIT` events for `SINCE_LOG_MAX_AGE_MS`, newest first, each once (by `key`). It runs while
 * Gnosis runs, also with no window open, so the morning page sees the night's changes. A change Gnosis never saw (it
 * was not running) is not in it.
 */
import type { NotificationEvent } from './notification-events';

export type SinceEventType = 'merged' | 'review-requested' | 'reply' | 'checks-red' | 'checks-green';
export interface SinceEvent {
  type: SinceEventType;
  /** Each event once: a repeated key is the same event. */
  key: string;
  url: string;
  repo?: string;
  number?: number;
  title?: string;
  /** Who: the person who replied. */
  actor?: string;
  at: number;
}
export const SINCE_LOG_LIMIT = 200;
export const SINCE_LOG_MAX_AGE_MS = 14 * 86_400_000;
const TYPES: readonly SinceEventType[] = ['merged', 'review-requested', 'reply', 'checks-red', 'checks-green'];
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;

/** Validates one event that crossed IPC or came from disk. Unknown fields are dropped. */
export function parseSinceEvent(value: unknown): SinceEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!TYPES.includes(raw.type as SinceEventType) || typeof raw.key !== 'string' || raw.key.length > 400) return undefined;
  if (typeof raw.url !== 'string' || !PR_URL.test(raw.url) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  return {
    type: raw.type as SinceEventType,
    key: raw.key,
    url: raw.url,
    at: raw.at,
    ...(typeof raw.repo === 'string' ? { repo: raw.repo.slice(0, 200) } : {}),
    ...(typeof raw.number === 'number' && Number.isSafeInteger(raw.number) ? { number: raw.number } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title.slice(0, 300) } : {}),
    ...(typeof raw.actor === 'string' && /^[\w.[\]-]{1,100}$/.test(raw.actor) ? { actor: raw.actor } : {}),
  };
}
export const parseSinceLog = (value: unknown): SinceEvent[] =>
  Array.isArray(value) ? value.flatMap((entry) => parseSinceEvent(entry) ?? []).slice(0, SINCE_LOG_LIMIT) : [];

/** The log with `events` added: each key once, nothing older than `SINCE_LOG_MAX_AGE_MS`, newest first, bounded. */
export function appendSinceEvents(log: readonly SinceEvent[], events: readonly SinceEvent[], now: number): SinceEvent[] {
  const known = new Set(log.map((event) => event.key));
  const added = events.filter((event) => !known.has(event.key) && known.add(event.key));
  return [...added, ...log]
    .filter((event) => now - event.at <= SINCE_LOG_MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, SINCE_LOG_LIMIT);
}

/** The notification events worth a line: review requests, replies and mentions, and failed checks on your PRs. */
export function sinceEventsFromNotifications(events: readonly NotificationEvent[]): SinceEvent[] {
  return events.flatMap((event): SinceEvent[] => {
    if (!event.url || !PR_URL.test(event.url)) return [];
    const type: SinceEventType | undefined =
      event.type === 'review-requested' || event.type === 'team-review-requested'
        ? 'review-requested'
        : event.type === 'reply' || event.type === 'mention'
          ? 'reply'
          : event.type === 'checks-failed' && event.mine
            ? 'checks-red'
            : undefined;
    if (!type) return [];
    return [
      {
        type,
        key: `${type}|${event.key}`,
        url: event.url,
        at: event.at,
        ...(event.repo ? { repo: event.repo } : {}),
        ...(event.number ? { number: event.number } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(type === 'reply' && event.actor && !event.actorIsBot ? { actor: event.actor } : {}),
      },
    ];
  });
}

export interface SinceSummary {
  merged: number;
  /** New review requests, each PR once. */
  requests: number;
  /** People who replied or mentioned you, most recent first. */
  repliers: string[];
  /** Your PRs whose checks are failing now after turning red, and passing now after turning green. */
  red: number;
  green: number;
}
/** What changed after `since`. A PR whose checks turned red and then green counts once, by its latest change. */
export function sinceSummary(events: readonly SinceEvent[], since: number): SinceSummary {
  const recent = events.filter((event) => event.at > since).sort((a, b) => b.at - a.at);
  const urls = (type: SinceEventType) => new Set(recent.filter((event) => event.type === type).map((event) => event.url));
  const checks = new Map<string, SinceEventType>();
  for (const event of recent) if ((event.type === 'checks-red' || event.type === 'checks-green') && !checks.has(event.url)) checks.set(event.url, event.type);
  const merged = urls('merged');
  // A merged PR's checks no longer matter.
  for (const url of merged) checks.delete(url);
  const repliers: string[] = [];
  for (const event of recent) if (event.type === 'reply' && event.actor && !repliers.some((name) => name.toLowerCase() === event.actor?.toLowerCase())) repliers.push(event.actor);
  return {
    merged: merged.size,
    requests: urls('review-requested').size,
    repliers,
    red: [...checks.values()].filter((type) => type === 'checks-red').length,
    green: [...checks.values()].filter((type) => type === 'checks-green').length,
  };
}

const people = (names: readonly string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Since yesterday: 3 merged · 2 new review requests · lena and owen replied · checks failed on 1, passed on 2".
 * "Since 09:40" when the last visit was today. Empty when nothing changed, so the page shows no line.
 */
export function sinceLine(summary: SinceSummary, since: number, now: number): string {
  const parts = [
    summary.merged ? `${summary.merged} merged` : '',
    summary.requests ? `${count(summary.requests, 'new review request', 'new review requests')}` : '',
    summary.repliers.length ? `${people(summary.repliers)} replied` : '',
    summary.red || summary.green
      ? `checks ${[summary.red ? `failed on ${summary.red}` : '', summary.green ? `passed on ${summary.green}` : ''].filter(Boolean).join(', ')}`
      : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  return `${sinceLabel(since, now)}: ${parts.join(' · ')}`;
}

/** "Since yesterday" when `since` is before today (local time), "Since 09:40" otherwise. */
export function sinceLabel(since: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (since < today.getTime()) return 'Since yesterday';
  return `Since ${new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
