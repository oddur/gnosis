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
          record.value = result.find((value) => queueSignalKey(value) === id) ?? record.value;
          record.expires = Date.now() + QUEUE_SIGNALS_TTL;
          record.pending = undefined;
          item.resolve(record.value);
        }
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
    let visible = false,
      cancelled = false;
    const load = () => {
      if (!visible || document.visibilityState === 'hidden') return;
      void Promise.all(members.map((request) => read(scope, request))).then((results) => {
        if (cancelled) return;
        setValues(results.filter((v): v is QueueSignals => !!v));
        setLoaded(true);
      });
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) load();
    });
    observer.observe(element);
    const timer = setInterval(load, QUEUE_SIGNALS_TTL);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [scope, key]);
  return { ref, values, loaded };
}
