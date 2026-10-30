import { watchGitHub } from './watch-github';
import { useEffect, useRef, useState } from 'react';
import { QUEUE_SIGNALS_TTL, queueSignalKey, type QueueSignalRequest, type QueueSignals } from './queue-signals';

interface Entry {
  value?: QueueSignals;
  expires: number;
  pending?: Promise<QueueSignals | undefined>;
}
interface BatchItem {
  request: QueueSignalRequest;
  resolve: (value: QueueSignals | undefined) => void;
}
// Only rows intersecting the scrollport enter this queue. Coalesce their IPC and GitHub reads.
const accounts = new Map<
  string,
  { entries: Map<string, Entry>; batch: Map<string, BatchItem>; timer?: ReturnType<typeof setTimeout> }
>();
const updates = new EventTarget();
export function publishQueueSignals(scope: string, values: QueueSignals[]) {
  let account = accounts.get(scope);
  if (!account) {
    account = { entries: new Map(), batch: new Map() };
    accounts.set(scope, account);
  }
  for (const value of values) {
    const key = queueSignalKey(value);
    const entry = account.entries.get(key);
    if (entry?.value && entry.value.checkedAt > value.checkedAt) continue;
    account.entries.set(key, { ...entry, value, expires: value.checkedAt + QUEUE_SIGNALS_TTL });
  }
  updates.dispatchEvent(new Event(scope));
}
function read(scope: string, request: QueueSignalRequest): Promise<QueueSignals | undefined> {
  let account = accounts.get(scope);
  if (!account) {
    account = { entries: new Map(), batch: new Map() };
    accounts.set(scope, account);
  }
  const key = queueSignalKey(request);
  const current = account.entries.get(key);
  if (current?.pending) return current.pending;
  if (current && current.expires > Date.now()) return Promise.resolve(current.value);
  const entry: Entry = { value: current?.value, expires: 0 };
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
export function useQueueSignals(scope: string | null, requests: QueueSignalRequest[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<QueueSignals[]>([]);
  const [loaded, setLoaded] = useState(false);
  const key = JSON.stringify(requests);
  useEffect(() => {
    setValues([]);
    setLoaded(false);
    const element = ref.current;
    if (!element || !scope) return;
    const members = JSON.parse(key) as QueueSignalRequest[];
    const update = () =>
      setValues(
        members.flatMap((request) => {
          const value = accounts.get(scope)?.entries.get(queueSignalKey(request))?.value;
          return value ? [value] : [];
        })
      );
    update();
    updates.addEventListener(scope, update);
    let visible = false,
      cancelled = false;
    const load = () => {
      if (!visible || document.visibilityState === 'hidden') return;
      update();
      void Promise.all(members.map((request) => read(scope, request))).then((results) => {
        if (cancelled) return;
        setValues(results.filter((v): v is QueueSignals => !!v));
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
        // Restore persisted snapshots before waiting on GitHub, including expired snapshots.
        void (async () => {
          for (let i = 0; i < members.length; i += 25) {
            const cached = await window.electronAPI
              .getQueueSignals(members.slice(i, i + 25), { cachedOnly: true })
              .catch(() => []);
            if (cancelled) return;
            publishQueueSignals(scope, cached);
          }
          if (!stop) load(); else { update(); setLoaded(true); }
        })();
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
      updates.removeEventListener(scope, update);
    };
  }, [scope, key]);
  return { ref, values, loaded };
}

/** Observe cached status for sorting; this hook never requests a GitHub refresh. */
export function useCachedQueueSignals(scope: string | null, requests: QueueSignalRequest[], enabled: boolean) {
  const [state, setState] = useState<{ scope: string | null; key: string; values: QueueSignals[] }>({ scope: null, key: '', values: [] });
  const key = enabled ? JSON.stringify(requests.map(({ url, headSha }) => ({ url, headSha }))) : '';
  useEffect(() => {
    setState({ scope, key, values: [] });
    if (!scope || !key) return;
    const members = JSON.parse(key) as QueueSignalRequest[];
    const lifecycle = { cancelled: false };
    const update = () => setState({ scope, key, values: members.flatMap(member => accounts.get(scope)?.entries.get(queueSignalKey(member))?.value ?? []) });
    update();
    updates.addEventListener(scope, update);
    void (async () => {
      for (let i = 0; i < members.length; i += 25) {
        const cached = await window.electronAPI.getQueueSignals(members.slice(i, i + 25), { cachedOnly: true }).catch(() => []);
        if (lifecycle.cancelled) return;
        publishQueueSignals(scope, cached);
      }
    })();
    return () => { lifecycle.cancelled = true; updates.removeEventListener(scope, update); };
  }, [scope, key]);
  return state.scope === scope && state.key === key ? state.values : [];
}
