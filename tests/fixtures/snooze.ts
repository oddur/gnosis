/**
 * Snoozes for the workbench fixture, saved in session storage like the fixture's mutes. The store, the queue
 * rules and the copy are the app's own (`lib/snooze.ts`); only GitHub observations are simulated, through
 * `window.fixtureSnoozeWake(url, reason)`.
 */
import { snoozeBasis, summaryOf, groupWakes, type SnoozeBack, type SnoozedPr, type SnoozeEntry, type SnoozeRequest, type WakeReason } from '../../lib/snooze';
import type { ReviewMember } from '../../lib/workbench';

interface State {
  entries: SnoozeEntry[];
  backs: Partial<Record<string, SnoozeBack>>;
}
const KEY = 'fixture-snoozes';

export function createFixtureSnoozes(members: () => ReviewMember[], login = 'oddur') {
  const state: State = JSON.parse(sessionStorage.getItem(KEY) ?? '{"entries":[],"backs":{}}') as State;
  const undos = new Map<string, { entries: Map<string, SnoozeEntry | undefined>; backs: Map<string, SnoozeBack | undefined> }>();
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  const remember = (urls: string[]) => {
    const token = crypto.randomUUID();
    undos.set(token, {
      entries: new Map(urls.map((url) => [url, state.entries.find((entry) => entry.member.url === url)])),
      backs: new Map(urls.map((url) => [url, state.backs[url]])),
    });
    return token;
  };
  const without = (urls: string[]) => state.entries.filter((entry) => !urls.includes(entry.member.url));
  return {
    urls: () => new Set(state.entries.map((entry) => entry.member.url)),
    backs: () => state.backs,
    rows: (): SnoozedPr[] => state.entries.map(({ member, group, snoozedAt, until, on, own }) => ({ member, group, snoozedAt, ...(until !== undefined ? { until } : {}), on, own })),
    /** Reading a PR clears its "Back" line, as main does. */
    read(urls: string[]) {
      if (!urls.some((url) => state.backs[url])) return;
      state.backs = Object.fromEntries(Object.entries(state.backs).filter(([url]) => !urls.includes(url)));
      save();
    },
    request(request: SnoozeRequest): { urls: string[]; undo?: string } {
      if (request.action === 'undo') {
        const saved = undos.get(request.token);
        if (!saved) throw new Error('This change can no longer be undone.');
        undos.delete(request.token);
        const urls = [...saved.entries.keys()];
        state.entries = [...without(urls), ...[...saved.entries.values()].filter((entry): entry is SnoozeEntry => !!entry)];
        state.backs = { ...state.backs, ...Object.fromEntries(saved.backs) };
        save();
        return { urls };
      }
      if (request.action === 'unsnooze') {
        const urls = request.urls.filter((url) => state.entries.some((entry) => entry.member.url === url));
        const undo = request.mute ? undefined : remember(urls);
        state.entries = without(urls);
        save();
        return { urls, ...(undo ? { undo } : {}) };
      }
      const known = new Map(members().map((member) => [member.url, member]));
      const at = Date.now();
      const put = request.groups.flatMap((urls) => {
        const group = crypto.randomUUID();
        return urls.flatMap((url): SnoozeEntry[] => {
          const member = known.get(url);
          if (!member || member.state !== 'open' || member.merged) return [];
          return [{ member: summaryOf(member), group, snoozedAt: at, ...(request.until !== undefined ? { until: request.until } : {}), on: request.on, own: member.author === login, basis: snoozeBasis(member, undefined, login) }];
        });
      });
      const urls = put.map((entry) => entry.member.url);
      const undo = remember(urls);
      state.entries = [...without(urls), ...put];
      state.backs = Object.fromEntries(Object.entries(state.backs).filter(([url]) => !urls.includes(url)));
      save();
      return { urls, undo };
    },
    /** Simulates an observation that wakes a snoozed PR, and its whole group. */
    wake(url: string, reason: WakeReason, minutesAgo = 120) {
      const entries = new Map(state.entries.map((entry) => [entry.member.url, entry]));
      const wake = groupWakes(entries, [{ url, reason }]).at(0);
      if (!wake) return [];
      const trigger = entries.get(url);
      const now = Date.now();
      for (const member of wake.urls)
        state.backs[member] = { reason, at: now, snoozedAt: now - minutesAgo * 60_000, ...(member !== url && trigger ? { via: trigger.member.number } : {}) };
      state.entries = without(wake.urls);
      save();
      return wake.urls;
    },
  };
}
