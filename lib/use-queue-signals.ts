import { watchGitHub } from './watch-github';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { QUEUE_SIGNALS_TTL, queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';
import {
  publishQueueSignals,
  signalAccount,
  signalStamp,
  signalValues,
  updates,
  type SignalEntry,
} from './queue-signal-store';

export { publishQueueSignals } from './queue-signal-store';

// Only rows intersecting the scrollport enter the batch. Coalesce their IPC and GitHub reads.
function read(scope: string, request: QueueSignalRequest): Promise<QueueSignals | undefined> {
  const account = signalAccount(scope);
  const key = queueSignalKey(request);
  const current = account.entries.get(key);
  if (current?.pending) return current.pending;
  if (current && current.expires > Date.now()) return Promise.resolve(current.value);
  const entry: SignalEntry = { value: current?.value, expires: 0 };
  entry.pending = new Promise((resolve) => account.batch.set(key, { request, resolve }));
  account.entries.set(key, entry);
  const state = account;
  state.timer ??= setTimeout(() => {
    state.timer = undefined;
    const batch = [...state.batch.entries()];
    state.batch.clear();
    void (async () => {
      for (let i = 0; i < batch.length; i += 25) {
        const chunk = batch.slice(i, i + 25);
        const result = await window.electronAPI.getQueueSignals(chunk.map(([, item]) => item.request)).catch(() => []);
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
