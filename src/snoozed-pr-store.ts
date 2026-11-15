import { createHash } from 'node:crypto';
import type { StateStorage } from './app-data-store';
import { deepFreeze } from '../lib/deep-freeze';
import { SNOOZE_LIMIT, type SnoozeBack, type SnoozedPr, type SnoozeEntry, type WakeReason } from '../lib/snooze';

const REASONS = new Set<WakeReason['kind']>(['review', 'comment', 'commits', 'requested', 'ready', 'checks', 'time', 'ceiling']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validUrl = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function validEntry(value: unknown): value is SnoozeEntry & { seq: number } {
  if (!record(value) || !record(value.member) || !record(value.basis)) return false;
  const m = value.member;
  const b = value.basis;
  return (
    typeof value.seq === 'number' &&
    validUrl(m.url) &&
    typeof m.repo === 'string' &&
    typeof m.number === 'number' &&
    typeof m.title === 'string' &&
    typeof m.author === 'string' &&
    typeof value.group === 'string' &&
    time(value.snoozedAt) &&
    (value.until === undefined || time(value.until)) &&
    Array.isArray(value.on) &&
    value.on.every((on) => on === 'activity' || on === 'checks') &&
    (value.until !== undefined || value.on.length > 0) &&
    typeof value.own === 'boolean' &&
    typeof b.headSha === 'string' &&
    typeof b.isDraft === 'boolean' &&
    typeof b.requested === 'boolean'
  );
}
function validBack(value: unknown): value is SnoozeBack & { url: string } {
  return record(value) && validUrl(value.url) && record(value.reason) && REASONS.has(value.reason.kind as WakeReason['kind']) && time(value.at) && time(value.snoozedAt);
}

interface SavedEntry extends SnoozeEntry {
  seq: number;
}
interface SavedBack extends SnoozeBack {
  url: string;
}
interface SnoozeIndex {
  /** Snoozed URLs. */
  urls: ReadonlySet<string>;
  rows: readonly SnoozedPr[];
  entries: ReadonlyMap<string, Readonly<SavedEntry>>;
  backs: Readonly<Partial<Record<string, SnoozeBack>>>;
}
const entryId = (url: string) => `snooze:${url}`;
const backId = (url: string) => `back:${url}`;
function indexOf(entries: SavedEntry[], backs: SavedBack[]): SnoozeIndex {
  const sorted = deepFreeze([...entries].sort((a, b) => a.seq - b.seq));
  return Object.freeze({
    urls: new Set(sorted.map((entry) => entry.member.url)),
    rows: deepFreeze(sorted.map(({ member, group, snoozedAt, until, on, own }) => ({ member, group, snoozedAt, ...(until !== undefined ? { until } : {}), on, own }))),
    entries: new Map(sorted.map((entry) => [entry.member.url, entry])),
    backs: deepFreeze(Object.fromEntries(backs.map(({ url, ...back }) => [url, back]))),
  });
}
export const snoozedPrsName = (account: string) =>
  `snoozed-prs:${createHash('sha256').update(account.toLowerCase()).digest('hex')}`;

/**
 * Snoozed PRs and the "Back" reasons of PRs that woke, per GitHub account, saved on this computer like mutes.
 * One row per snooze and one per reason. An unreadable store resets to empty: a lost snooze shows a PR, it
 * never hides one.
 */
export function createSnoozedPrStore(storage: StateStorage) {
  const accounts = new Map<string, SnoozeIndex>();
  const load = (account: string): SnoozeIndex => {
    const key = account.toLowerCase();
    const cached = accounts.get(key);
    if (cached) return cached;
    let saved: unknown;
    try {
      saved = storage.take(snoozedPrsName(account));
    } catch {
      saved = undefined;
    }
    const rows = record(saved) && record(saved.entries) ? Object.entries(saved.entries) : [];
    const entries = new Map<string, SavedEntry>();
    const backs = new Map<string, SavedBack>();
    for (const [id, value] of rows) {
      if (id.startsWith('snooze:') && validEntry(value)) entries.set(value.member.url, value);
      else if (id.startsWith('back:') && validBack(value)) backs.set(value.url, value);
    }
    const index = indexOf([...entries.values()], [...backs.values()]);
    accounts.set(key, index);
    return index;
  };
  return {
    /** Frozen and shared: never change them. */
    index: (account: string): SnoozeIndex => load(account),
    /**
     * Saves snoozes and "Back" reasons. `put` adds or replaces snoozes, `remove` ends them; `backs` sets a
     * reason, or clears it with `undefined`.
     */
    change(account: string, change: { put?: SnoozeEntry[]; remove?: string[]; backs?: Record<string, SnoozeBack | undefined> }) {
      const current = load(account);
      const entries = new Map<string, SavedEntry>([...current.entries].map(([url, entry]) => [url, entry]));
      const backs = new Map<string, SavedBack>(Object.entries(current.backs).flatMap(([url, back]) => (back ? [[url, { ...back, url }]] : [])));
      let next = Math.max(-1, ...[...entries.values()].map((entry) => entry.seq)) + 1;
      const put: Record<string, unknown> = {};
      const remove: string[] = [];
      for (const url of change.remove ?? [])
        if (entries.delete(url)) remove.push(entryId(url));
      for (const entry of change.put ?? []) {
        const saved: SavedEntry = { ...structuredClone(entry), seq: entries.get(entry.member.url)?.seq ?? next++ };
        entries.set(entry.member.url, saved);
        put[entryId(entry.member.url)] = saved;
      }
      if (entries.size > SNOOZE_LIMIT) throw new Error(`Snooze at most ${SNOOZE_LIMIT} PRs.`);
      for (const [url, back] of Object.entries(change.backs ?? {})) {
        if (back) {
          const saved = { ...structuredClone(back), url };
          backs.set(url, saved);
          put[backId(url)] = saved;
        } else if (backs.delete(url)) remove.push(backId(url));
      }
      // A patch applies removals after puts, so a row put again is not removed.
      const removed = remove.filter((id) => !Object.hasOwn(put, id));
      if (!Object.keys(put).length && !removed.length) return;
      storage.patch(snoozedPrsName(account), { put, remove: removed });
      accounts.set(account.toLowerCase(), indexOf([...entries.values()], [...backs.values()]));
    },
  };
}
export type SnoozedPrStore = ReturnType<typeof createSnoozedPrStore>;
