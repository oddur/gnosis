import { createHash } from 'node:crypto';
import type { StateStorage } from './app-data-store';
import { appendSinceEvents, parseSinceLog, serializeSinceLog, type SinceEvent } from '../lib/since-log';

export const sinceLogName = (account: string) => `overview-since-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`;

/**
 * The Overview's "Since yesterday" log, per account (`lib/since-log.ts`): at most 200 events from the last 14 days,
 * saved with the app's other local state. Local only: it records what main already saw and never reads GitHub.
 */
export function createSinceLog(storage: StateStorage, now = Date.now) {
  const accounts = new Map<string, SinceEvent[]>();
  const load = (account: string) => {
    const key = account.toLowerCase();
    let log = accounts.get(key);
    if (!log) {
      try {
        log = parseSinceLog(storage.read(sinceLogName(account)));
      } catch {
        log = [];
      }
      accounts.set(key, log);
    }
    return log;
  };
  return {
    record(account: string, events: readonly SinceEvent[]) {
      if (!events.length) return;
      const before = load(account);
      const next = appendSinceEvents(before, events, now());
      if (next.length === before.length && next.every((event, index) => event === before[index])) return;
      accounts.set(account.toLowerCase(), next);
      storage.write(sinceLogName(account), serializeSinceLog(next));
    },
    /** Events after `since`, newest first. */
    list: (account: string, since: number) => load(account).filter((event) => event.at > since),
  };
}
