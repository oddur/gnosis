import { watchGitHub } from './watch-github';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { QUEUE_SIGNALS_TTL, overviewStatusOptions, overviewStatusPriority, queueSignalKey, type QueueSignalOptions, type QueueSignalRequest, type QueueSignals } from './queue-signals';
import {
  publishQueueSignals,
  signalAccount,
  signalStamp,
  signalValue,
  signalValues,
  updates,
  type SignalEntry,
} from './queue-signal-store';
import {
  MERGE_RECHECK_DELAY,
  mergeConflictState,
  mergeStateSignature,
  parseMergeStateSignature,
  type MergeStates,
} from './merge-conflicts';

export { publishQueueSignals } from './queue-signal-store';

// Only rows intersecting the scrollport enter the batch. Coalesce their IPC and GitHub reads. `options.active` reads
// at visible priority: such requests go to main in their own 25-PR chunks, the rest at background priority.
function read(scope: string, request: QueueSignalRequest, options: Pick<QueueSignalOptions, 'active'> = {}): Promise<QueueSignals | undefined> {
  const account = signalAccount(scope);
  const key = queueSignalKey(request);
  const current = account.entries.get(key);
  if (current?.pending) return current.pending;
  if (current && current.expires > Date.now()) return Promise.resolve(current.value);
  const entry: SignalEntry = { value: current?.value, expires: 0 };
  entry.pending = new Promise((resolve) => account.batch.set(key, { request, resolve, ...(options.active ? { active: true } : {}) }));
  account.entries.set(key, entry);
  const state = account;
  state.timer ??= setTimeout(() => {
    state.timer = undefined;
    const all = [...state.batch.entries()];
    state.batch.clear();
    // Visible reads first, in their own chunks, so each chunk has one priority.
    const active = all.filter(([, item]) => item.active);
    const chunks = [active, all.filter(([, item]) => !item.active)].flatMap((list) =>
      Array.from({ length: Math.ceil(list.length / 25) }, (_, i) => ({ chunk: list.slice(i * 25, i * 25 + 25), active: list === active })));
    void (async () => {
      for (const { chunk, active } of chunks) {
        const result = await window.electronAPI.getQueueSignals(chunk.map(([, item]) => item.request), ...(active ? [{ active: true }] : [])).catch(() => []);
        for (const [id, item] of chunk) {
          const record = state.entries.get(id);
          if (!record) {
            item.resolve(undefined);
            continue;
          }
          const value = result.find((value) => queueSignalKey(value) === id);
          if (value && (!record.value || value.checkedAt >= record.value.checkedAt)) record.value = value;
          record.expires = Date.now() + QUEUE_SIGNALS_TTL;
          record.pending = undefined;
          item.resolve(record.value);
        }
        updates.dispatchEvent(new Event(scope));
      }
      for (const [id, record] of state.entries) {
        if (state.entries.size <= 500) break;
        if (!record.pending) state.entries.delete(id);
      }
    })();
  }, 150);
  return entry.pending;
}
/**
 * Publish saved status, including expired status, for members without a value. The first queue
 * snapshot usually brought it already. Resolves false if cancelled.
 */
async function restoreSaved(scope: string, members: QueueSignalRequest[], cancelled: () => boolean) {
  if (signalValues(scope, members).length < members.length)
    for (let i = 0; i < members.length; i += 25) {
      const cached = await window.electronAPI.getQueueSignals(members.slice(i, i + 25), { cachedOnly: true }).catch(() => []);
      if (cancelled()) return false;
      publishQueueSignals(scope, cached);
    }
  return !cancelled();
}
/**
 * Values for these PR revisions, read during render. Saved values published before the first queue
 * commit show in that commit, and a row renders again only when one of its own values changes.
 */
function useSignalValues(scope: string | null, key: string) {
  const subscribe = useCallback((listener: () => void) => {
    if (!scope) return () => {};
    updates.addEventListener(scope, listener);
    return () => updates.removeEventListener(scope, listener);
  }, [scope]);
  const members = useMemo(() => (key ? (JSON.parse(key) as QueueSignalRequest[]) : []), [key]);
  const stamp = useSyncExternalStore(subscribe, () => (scope ? signalStamp(scope, members) : ''));
  // The stamp changes whenever a member's value does.
  return useMemo(() => (scope ? signalValues(scope, members) : NO_SIGNALS), [scope, members, stamp]);
}
export function useQueueSignals(scope: string | null, requests: QueueSignalRequest[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const key = JSON.stringify(requests);
  const values = useSignalValues(scope, key);
  useEffect(() => {
    setLoaded(false);
    const element = ref.current;
    if (!element || !scope) return;
    const members = JSON.parse(key) as QueueSignalRequest[];
    let visible = false,
      cancelled = false;
    const load = () => {
      if (!visible || document.visibilityState === 'hidden') return;
      void Promise.all(members.map((request) => read(scope, request))).then(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    };
    let stop: (() => void) | undefined;
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (!visible) { stop?.(); stop = undefined; }
      if (visible) {
        stop ??= watchGitHub({ kind: 'signals', priority: 'visible', targets: members }, update => {
          if (update.kind === 'signals') { publishQueueSignals(scope, [update.value]); setLoaded(true); }
        });
        // Restore saved status before waiting on GitHub.
        void restoreSaved(scope, members, () => cancelled).then((current) => {
          if (current) { if (!stop) load(); else setLoaded(true); }
        });
      }
    });
    observer.observe(element);
    const timer = window.electronAPI.githubSyncVersion === 1 ? undefined : setInterval(load, QUEUE_SIGNALS_TTL);
    const onVisibility = () => { if (window.electronAPI.githubSyncVersion !== 1) load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      observer.disconnect();
      stop?.();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scope, key]);
  return { ref, values, loaded };
}

/** Observe cached status for sorting; this hook never requests a GitHub refresh. */
const NO_SIGNALS: QueueSignals[] = [];
export function useCachedQueueSignals(scope: string | null, requests: QueueSignalRequest[], enabled: boolean) {
  const key = enabled ? JSON.stringify(requests.map(({ url, headSha }) => ({ url, headSha }))) : '';
  const values = useSignalValues(scope && key ? scope : null, key);
  useEffect(() => {
    if (!scope || !key) return;
    let cancelled = false;
    void restoreSaved(scope, JSON.parse(key) as QueueSignalRequest[], () => cancelled);
    return () => { cancelled = true; };
  }, [scope, key]);
  return values;
}

/**
 * Merge conflict states for these PR revisions, read from the shared store. The snapshot is one character
 * per PR, so a status refresh that leaves every state unchanged renders nothing. Off: no subscription.
 */
export function useMergeStates(scope: string | null, requests: readonly QueueSignalRequest[], enabled: boolean): MergeStates | undefined {
  const active = enabled && !!scope;
  const subscribe = useCallback((listener: () => void) => {
    if (!active || !scope) return () => {};
    updates.addEventListener(scope, listener);
    return () => updates.removeEventListener(scope, listener);
  }, [scope, active]);
  const signature = useSyncExternalStore(subscribe, () =>
    active && scope ? mergeStateSignature(requests, (request) => signalValue(scope, request)) : '');
  return useMemo(() => (active ? parseMergeStateSignature(requests, signature) : undefined), [active, requests, signature]);
}

export type MergeLoadPhase = 'loading' | 'waiting' | 'rechecking' | 'done';
/**
 * Status for every candidate PR while the merge filter is on. Saved status comes first. Revisions without
 * any go to GitHub through the same coalesced 25-PR batches, service cache and backoff as visible rows.
 * PRs whose mergeability GitHub was still computing are read once more after a short delay.
 */
export async function loadMergeSignals(
  scope: string,
  requests: readonly QueueSignalRequest[],
  options: {
    cancelled: () => boolean;
    /** Revisions already re-checked in this filter session. Each one is re-checked at most once. */
    rechecked: Set<string>;
    onPhase?: (phase: MergeLoadPhase) => void;
    delay?: (ms: number) => Promise<void>;
  }
) {
  const { cancelled, rechecked, onPhase } = options;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const missing = () => requests.filter((request) => !signalValue(scope, request));
  onPhase?.('loading');
  if (!(await restoreSaved(scope, missing(), cancelled))) return;
  const unknown = missing();
  if (unknown.length) {
    await Promise.all(unknown.map((request) => read(scope, request)));
    if (cancelled()) return;
  }
  const computing = () =>
    requests.filter((request) => mergeConflictState(signalValue(scope, request)) === 'computing' && !rechecked.has(queueSignalKey(request)));
  if (computing().length) {
    onPhase?.('waiting');
    await delay(MERGE_RECHECK_DELAY);
    if (cancelled()) return;
    const recheck = computing();
    onPhase?.('rechecking');
    for (let i = 0; i < recheck.length; i += 25) {
      const chunk = recheck.slice(i, i + 25);
      for (const request of chunk) rechecked.add(queueSignalKey(request));
      const values = await window.electronAPI.getQueueSignals(chunk, { recheckMerge: true }).catch(() => []);
      if (cancelled()) return;
      publishQueueSignals(scope, values);
    }
  }
  onPhase?.('done');
}

/** Loads status for the merge filter while it is on. Off: no reads and a constant result. */
export function useMergeFilter(scope: string | null, requests: readonly QueueSignalRequest[], enabled: boolean) {
  const states = useMergeStates(scope, requests, enabled);
  const [phase, setPhase] = useState<MergeLoadPhase>('loading');
  const rechecked = useRef<{ scope: string | null; keys: Set<string> }>({ scope: null, keys: new Set() });
  const key = enabled && scope ? JSON.stringify(requests.map(({ url, headSha }) => ({ url, headSha }))) : '';
  useEffect(() => {
    if (!key || !scope) {
      rechecked.current = { scope: null, keys: new Set() };
      return;
    }
    if (rechecked.current.scope !== scope) rechecked.current = { scope, keys: new Set() };
    let cancelled = false;
    void loadMergeSignals(scope, JSON.parse(key) as QueueSignalRequest[], {
      cancelled: () => cancelled,
      rechecked: rechecked.current.keys,
      onPhase: (next) => { if (!cancelled) setPhase(next); },
    });
    return () => { cancelled = true; };
  }, [scope, key]);
  return { states, phase: enabled ? phase : ('done' as const) };
}

/** How often the Overview looks for status past its time-to-live. A local check; only expired PRs are read. */
const OVERVIEW_STATUS_SWEEP_MS = 30_000;
const isDue = (scope: string, request: QueueSignalRequest) => {
  const entry = signalAccount(scope).entries.get(queueSignalKey(request));
  return !entry?.value || !!entry.pending || entry.expires <= Date.now();
};
/**
 * Status for every PR the Overview can place in a lane (#390), and how many reads are in flight. Saved status shows
 * first, always, without a GitHub read. While `live`, every PR without status, or with status past its time-to-live
 * (`QUEUE_SIGNALS_TTL`), is read through the queue rows' path: the coalesced 25-PR batches, main's 2-minute service
 * cache and the automatic rate-limit budget. Native builds also join the shared backend watch, so changes arrive as
 * they happen. A hidden window reads nothing until it shows again.
 *
 * Priority (`overviewStatusPriority`): `visible` while the Overview is `shown` (the active tab) and the window is
 * visible, else `background`. It is read at each sweep, so showing the Overview raises the next reads without
 * restarting anything; the budget, back-off and batching are the same at both.
 *
 * `checking` is the number of these PRs whose read has not answered yet; it changes once per answered batch.
 */
export function useOverviewStatus(scope: string | null, requests: readonly QueueSignalRequest[], live: boolean, shown = false) {
  const visibleRef = useRef(shown);
  visibleRef.current = shown;
  // The sweep, once saved status is restored: showing the Overview runs it at once, at visible priority.
  const sweep = useRef<(() => void) | undefined>(undefined);
  const key = JSON.stringify(requests.map(({ url, headSha }) => ({ url, headSha })));
  const values = useSignalValues(scope, key);
  const [checking, setChecking] = useState(0);
  useEffect(() => {
    setChecking(0);
    if (!scope) return;
    const members = JSON.parse(key) as QueueSignalRequest[];
    if (!members.length) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const pending = new Set<string>();
    let reported = -1;
    let scheduled = false;
    // Answers arrive per batch: one count update for each, not one per PR.
    const report = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (cancelled || reported === pending.size) return;
        reported = pending.size;
        setChecking(pending.size);
      });
    };
    const load = () => {
      const windowVisible = document.visibilityState !== 'hidden';
      // A hidden window reads nothing; it reads again when it shows.
      if (cancelled || !live || !windowVisible) return;
      const options = overviewStatusOptions(overviewStatusPriority(visibleRef.current, windowVisible));
      for (const request of members) {
        const id = queueSignalKey(request);
        if (pending.has(id) || !isDue(scope, request)) continue;
        pending.add(id);
        void read(scope, request, options).finally(() => {
          pending.delete(id);
          report();
        });
      }
      report();
    };
    void restoreSaved(scope, members, () => cancelled).then((current) => {
      if (!current || !live) return;
      stop ??= watchGitHub({ kind: 'signals', priority: 'visible', targets: members }, (update) => {
        if (update.kind === 'signals') publishQueueSignals(scope, [update.value]);
      });
      sweep.current = load;
      load();
    });
    const timer = live ? setInterval(load, OVERVIEW_STATUS_SWEEP_MS) : undefined;
    if (live) document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      sweep.current = undefined;
      stop?.();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [scope, key, live]);
  useEffect(() => {
    if (shown) sweep.current?.();
  }, [shown]);
  return { values, checking: live ? checking : 0 };
}
