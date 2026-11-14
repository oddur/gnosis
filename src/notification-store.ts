import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { StateStorage } from './app-data-store';
import { deriveEvents, type NotificationEvent, type PrBasis, type PrObservation } from '../lib/notification-events';
import type { NotificationEventType } from '../lib/notification-settings';

/** Why a derived event was not delivered. Counted locally only. */
export type SuppressReason = 'own' | 'muted' | 'archived' | 'type-off' | 'active' | 'duplicate' | 'paused' | 'in-app-off' | 'banner';
export type CounterField =
  | 'derived'
  | `suppressed:${SuppressReason}`
  | 'coalesced'
  | 'desktopShown'
  | 'toastShown'
  | 'clicked'
  | 'dismissed'
  | 'timedOut'
  | 'desktopFailed';
type CounterType = NotificationEventType | 'summary' | 'test';
export type NotificationCounters = Record<string, Partial<Record<CounterType, Partial<Record<CounterField, number>>>>>;
interface Entry {
  basis: PrBasis;
  /** Idempotency key to delivery time. */
  fired: Record<string, number>;
}
interface State {
  initialized: boolean;
  counters: NotificationCounters;
  entries: Partial<Record<string, Entry>>;
}
const KEYS_PER_PR = 50;
const RETAIN_MS = 30 * 86_400_000;
const COUNTER_DAYS = 30;
/** The basis is saved again without other changes at most this often, so an unchanged queue writes nothing. */
const TOUCH_MS = 60 * 60_000;
const validUrl = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validEntry(value: unknown): value is Entry {
  if (!record(value) || !record(value.basis) || !record(value.fired)) return false;
  const basis = value.basis;
  return (
    typeof basis.headSha === 'string' &&
    record(basis.kinds) &&
    Number.isSafeInteger(basis.requests) &&
    Number.isSafeInteger(basis.teamRequests) &&
    typeof basis.team === 'boolean' &&
    Number.isFinite(basis.observedAt) &&
    Object.values(value.fired).every((at) => Number.isFinite(at))
  );
}
export const notificationStateName = (account: string) =>
  `pr-notify-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`;

/**
 * Per-account notification basis, delivered keys and local counters. Saved as a row state, one row per PR.
 * Two guards prevent duplicates: edge triggering against the persisted basis, and a persisted key per event.
 */
export function createNotificationStore(storage: StateStorage, now = Date.now) {
  const accounts = new Map<string, State>();
  function load(account: string): State {
    const key = account.toLowerCase();
    let state = accounts.get(key);
    if (state) return state;
    state = { initialized: false, counters: {}, entries: {} };
    const remove: string[] = [];
    try {
      const saved = storage.read(notificationStateName(account));
      if (saved !== undefined) {
        if (!record(saved) || typeof saved.initialized !== 'boolean' || !record(saved.entries)) throw new Error('Invalid notification state');
        const entries: State['entries'] = {};
        for (const [url, entry] of Object.entries(saved.entries)) {
          if (!validUrl(url) || !validEntry(entry)) throw new Error('Invalid notification entry');
          // PRs absent from the queue for 30 days are dropped.
          if (now() - entry.basis.observedAt > RETAIN_MS) remove.push(url);
          else entries[url] = entry;
        }
        state = { initialized: saved.initialized, counters: record(saved.counters) ? (saved.counters as NotificationCounters) : {}, entries };
      }
    } catch (error) {
      // Losing this state only costs a new silent baseline. Never trust a malformed basis.
      console.warn('[notifications] Saved notification state was invalid and has been reset:', error instanceof Error ? error.message : error);
      state = { initialized: false, counters: {}, entries: {} };
      storage.write(notificationStateName(account), { initialized: false, counters: {}, entries: {} });
    }
    accounts.set(key, state);
    if (remove.length) storage.patch(notificationStateName(account), { header: header(state), remove });
    return state;
  }
  const header = (state: State) => ({ initialized: state.initialized, counters: state.counters });
  function save(account: string, state: State, put: Record<string, Entry>, headerChanged: boolean) {
    if (!Object.keys(put).length && !headerChanged) return;
    storage.patch(notificationStateName(account), { header: header(state), put });
  }
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  function bump(state: State, type: CounterType, field: CounterField, n = 1) {
    const today = day(now());
    const bucket = (state.counters[today] ??= {});
    const counts = (bucket[type] ??= {});
    counts[field] = (counts[field] ?? 0) + n;
    const days = Object.keys(state.counters).sort();
    for (const old of days.slice(0, Math.max(0, days.length - COUNTER_DAYS))) Reflect.deleteProperty(state.counters, old);
  }
  return {
    initialized: (account: string) => load(account).initialized,
    /**
     * Updates the basis of each observed PR and returns the events to deliver. Until the baseline is finished,
     * and for the user's own writes, only the basis changes. `suppress` names a reason to record an event as
     * delivered without showing it, such as a muted PR; its key is kept so it never fires later.
     */
    observe(
      account: string,
      observations: readonly PrObservation[],
      options: {
        login: string;
        finishBaseline?: boolean;
        own?: boolean;
        suppress?: (event: NotificationEvent) => SuppressReason | undefined;
        /** Count events in the local counters (the analytics preference). */
        count?: boolean;
      }
    ): NotificationEvent[] {
      const state = load(account);
      const put: Record<string, Entry> = {};
      const events: NotificationEvent[] = [];
      let headerChanged = false;
      const at = now();
      for (const observation of observations) {
        const url = observation.member.url;
        if (!validUrl(url)) continue;
        const saved = state.entries[url];
        const { basis, events: derived } = deriveEvents(saved?.basis, observation, {
          login: options.login,
          now: at,
          initialized: state.initialized,
          own: options.own,
        });
        const fired = { ...(saved?.fired ?? {}) };
        for (const event of derived) {
          if (options.count) { bump(state, event.type, 'derived'); headerChanged = true; }
          if (Object.hasOwn(fired, event.key)) {
            if (options.count) bump(state, event.type, 'suppressed:duplicate');
            continue;
          }
          fired[event.key] = at;
          const reason = options.suppress?.(event);
          if (reason) {
            if (options.count) bump(state, event.type, `suppressed:${reason}`);
            continue;
          }
          events.push(event);
        }
        const keys = Object.entries(fired).sort((a, b) => a[1] - b[1]).slice(-KEYS_PER_PR);
        const next: Entry = { basis, fired: Object.fromEntries(keys) };
        const unchanged =
          saved &&
          isDeepStrictEqual({ ...saved.basis, observedAt: 0 }, { ...basis, observedAt: 0 }) &&
          isDeepStrictEqual(saved.fired, next.fired) &&
          at - saved.basis.observedAt < TOUCH_MS;
        if (unchanged) continue;
        state.entries[url] = next;
        put[url] = next;
      }
      if (options.finishBaseline && !state.initialized) {
        state.initialized = true;
        headerChanged = true;
      }
      save(account, state, put, headerChanged);
      return events;
    },
    count(account: string, type: CounterType, field: CounterField, n = 1) {
      const state = load(account);
      bump(state, type, field, n);
      save(account, state, {}, true);
    },
    counters: (account: string): NotificationCounters => structuredClone(load(account).counters),
    /** Tests: the saved basis of one PR. */
    basis: (account: string, url: string) => load(account).entries[url]?.basis,
  };
}
export type NotificationStore = ReturnType<typeof createNotificationStore>;
