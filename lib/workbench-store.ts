import { useSyncExternalStore } from 'react';
import type { QueueItem, WorkbenchQueue, WorkbenchQueueParts } from './workbench';
import type { ReviewHistoryEntry } from './types';
import { historyRevision, stampQueue, type WorkbenchRevisions } from './workbench-revision';
import type { QueueSignals } from './queue-signals';
import { publishQueueSignals } from './queue-signal-store';

export interface WorkbenchStoreApi {
  /** With `withSignals`, the saved PR status for the queue's rows comes with the snapshot. */
  workbenchSnapshot: (withSignals?: boolean) => Promise<WorkbenchQueue>;
  workbenchQueue: (force?: boolean) => Promise<WorkbenchQueue>;
  listReviews: () => Promise<ReviewHistoryEntry[]>;
  onWorkbenchChanged?: (callback: (revisions?: WorkbenchRevisions) => void) => () => void;
  onPrReadStateChanged?: (callback: () => void) => () => void;
  perfMark?: (name: string) => void;
}
export interface WorkbenchStoreStatus {
  loaded: boolean;
  error?: string;
}
export interface WorkbenchRefresh {
  /** Ask GitHub for changes instead of reading the saved snapshot. */
  discover?: boolean;
  force?: boolean;
  /** Read saved reviews even when their revision is unchanged. */
  history?: boolean;
}
interface Options {
  /** Subscribe to window focus; returns an unsubscribe function. */
  focus?: (listener: () => void) => () => void;
  /** Coalescing delay for change notifications. */
  delay?: number;
  /** Receives the saved PR status that comes with the first snapshot, before the queue is shown. */
  onSavedSignals?: (account: string, values: QueueSignals[]) => void;
}

const EMPTY_QUEUE: WorkbenchQueue = Object.freeze({ items: Object.freeze([]) as unknown as QueueItem[], warnings: Object.freeze([]) as unknown as string[], remaining: 0 });
const EMPTY_HISTORY = Object.freeze([]) as unknown as ReviewHistoryEntry[];
const PARTS: (keyof WorkbenchQueueParts)[] = ['stacks', 'readStates', 'mutedPrs', 'starredPrs', 'savedViews', 'filters', 'sync'];
const sameArray = <T,>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]));

/**
 * One queue snapshot shared by every workspace tab and the tab strip. Unchanged content keeps its
 * identity, so memoized rows and counts skip work when a sync push changes nothing they show.
 */
export function createWorkbenchStore(api: () => WorkbenchStoreApi, options: Options = {}) {
  const delay = options.delay ?? 50;
  const listeners = new Set<() => void>();
  let queue = EMPTY_QUEUE;
  let history = EMPTY_HISTORY;
  let held: string | undefined;
  let status: WorkbenchStoreStatus = { loaded: false };
  let account: string | undefined;
  let detach: (() => void) | undefined;
  // Reads started before a hold or an account change are discarded.
  let epoch = 0;
  let generation = 0;
  let holds = 0;
  let dropped = false;
  const inFlight = new Map<string, Promise<void>>();
  const again = new Set<string>();
  let historyLoad: Promise<void> | undefined;
  let historyAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { revisions?: WorkbenchRevisions; read: boolean } | undefined;
  let snapshotMarked = false;

  const notify = () => { for (const listener of [...listeners]) listener(); };
  const setStatus = (next: WorkbenchStoreStatus) => {
    if (next.loaded === status.loaded && next.error === status.error) return;
    status = next;
    notify();
  };

  /** Keep the previous objects for everything whose content revision is unchanged. */
  function share(next: WorkbenchQueue): WorkbenchQueue {
    const previous = new Map<string, QueueItem>();
    for (const item of [...queue.items, ...(queue.starredItems ?? [])])
      if (!previous.has(item.subject.id)) previous.set(item.subject.id, item);
    const adopt = (item: QueueItem) => {
      const old = previous.get(item.subject.id);
      // Copy new entries so a source that edits its objects in place cannot change what is displayed.
      return old && item.revision !== undefined && old.revision === item.revision ? old : { ...item };
    };
    const items = next.items.map(adopt);
    const starredItems = next.starredItems?.map(adopt);
    const result: WorkbenchQueue = {
      ...next,
      items: sameArray(items, queue.items) ? queue.items : items,
      starredItems: sameArray(starredItems, queue.starredItems) ? queue.starredItems : starredItems,
      warnings: sameArray(next.warnings, queue.warnings) ? queue.warnings : next.warnings,
      briefingBudget: JSON.stringify(next.briefingBudget) === JSON.stringify(queue.briefingBudget) ? queue.briefingBudget : next.briefingBudget,
    };
    for (const part of PARTS) {
      const hash = next.parts?.[part];
      if (hash !== undefined && queue.parts?.[part] === hash) Object.assign(result, { [part]: queue[part] });
    }
    if (next.parts && queue.parts && PARTS.every((part) => next.parts?.[part] === queue.parts?.[part])) result.parts = queue.parts;
    return result;
  }
  function commit(next: WorkbenchQueue) {
    const shared = share(next);
    const keys = new Set([...Object.keys(shared), ...Object.keys(queue)]) as Set<keyof WorkbenchQueue>;
    const changed = [...keys].some((key) => shared[key] !== queue[key]);
    if (changed) queue = Object.freeze(shared);
    const statusChanged = !status.loaded || status.error !== undefined;
    if (statusChanged) status = { loaded: true };
    if (changed || statusChanged) notify();
    if (next.historyRevision === undefined || next.historyRevision !== held) void loadHistory();
  }
  function loadHistory(force = false): Promise<void> {
    if (historyLoad) {
      if (force) historyAgain = true;
      return historyLoad;
    }
    const started = generation;
    const request = (async () => {
      try {
        const entries = await api().listReviews();
        if (started !== generation) return;
        const previous = new Map(history.map((entry) => [entry.id, entry]));
        const shared = entries.map((entry) => {
          const old = previous.get(entry.id);
          return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
        });
        held = historyRevision(entries);
        if (!sameArray(shared, history)) {
          history = Object.freeze(shared) as ReviewHistoryEntry[];
          notify();
        }
      } catch {
        /* Keep the saved reviews already shown; the next change or refresh reads them again. */
      }
    })().finally(() => {
      historyLoad = undefined;
      if (historyAgain) {
        historyAgain = false;
        void loadHistory();
      }
    });
    historyLoad = request;
    return request;
  }
  /** One request per kind. A snapshot read requested during another runs once more afterwards. */
  function load(kind: 'snapshot' | 'discover' | 'force'): Promise<void> {
    const current = inFlight.get(kind);
    if (current) {
      if (kind !== 'snapshot') return current;
      // A read requested now must observe changes made before the request, so wait for the follow-up read.
      again.add(kind);
      return current.catch(() => {}).then(() => inFlight.get(kind));
    }
    const request = (async () => {
      let started = { epoch, generation };
      try {
        // Until a queue is shown, ask for saved status too, so the first rows show their badges.
        let next = kind === 'snapshot' ? await api().workbenchSnapshot(!status.loaded) : await api().workbenchQueue(kind === 'force');
        if (!snapshotMarked && kind === 'snapshot') {
          snapshotMarked = true;
          api().perfMark?.('snapshot-ipc');
        }
        // A write that started and finished during this read may be missing from it, so read once more.
        if (started.generation === generation && !holds && started.epoch !== epoch) {
          started = { epoch, generation };
          next = await api().workbenchSnapshot(!status.loaded);
        }
        if (started.generation !== generation) return;
        if (holds > 0) {
          dropped = true;
          return;
        }
        if (started.epoch !== epoch) {
          setTimeout(() => void load('snapshot').catch(() => {}), 0);
          return;
        }
        // Saved status is not part of the queue: it never reaches its identity or revisions.
        const { savedSignals, ...queued } = next;
        if (savedSignals) options.onSavedSignals?.(savedSignals.account, savedSignals.values);
        commit(queued.revision ? queued : stampQueue(queued));
      } catch (error) {
        if (started.generation === generation) setStatus({ loaded: status.loaded, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })().finally(() => {
      inFlight.delete(kind);
      if (again.delete(kind)) void load(kind).catch(() => {});
    });
    inFlight.set(kind, request);
    return request;
  }
  /** Coalesce change notifications. A push that carries revisions needs no read when both match. */
  function flush() {
    timer = undefined;
    const change = pending;
    pending = undefined;
    if (!change) return;
    const revisions = change.read ? undefined : change.revisions;
    if (revisions && status.loaded) {
      if (revisions.revision !== queue.revision) void load('snapshot').catch(() => {});
      else if (revisions.historyRevision !== held) void loadHistory();
      return;
    }
    void load('snapshot').catch(() => {});
  }
  function schedule(revisions?: WorkbenchRevisions) {
    // Revisions describe main's state when it sent them. A later push without them needs a read.
    pending = revisions ? { revisions, read: false } : { revisions: pending?.revisions, read: true };
    timer ??= setTimeout(flush, delay);
  }
  function attach() {
    const source = api();
    const stops = [
      source.onWorkbenchChanged?.((revisions) => schedule(revisions)),
      source.onPrReadStateChanged?.(() => schedule()),
      options.focus?.(() => schedule()),
    ];
    void load('snapshot').catch(() => {});
    return () => {
      for (const stop of stops) stop?.();
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    };
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) detach = attach();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          detach?.();
          detach = undefined;
        }
      };
    },
    getQueue: () => queue,
    getHistory: () => history,
    getStatus: () => status,
    async refresh(request: WorkbenchRefresh = {}) {
      const reviews = request.history ? loadHistory(true) : undefined;
      await load(request.discover ? (request.force ? 'force' : 'discover') : 'snapshot');
      await reviews;
    },
    /** Show the result of a write. It applies even while a write holds the store. */
    apply(next: WorkbenchQueue) {
      commit(next.revision ? next : stampQueue(next));
    },
    /** Optimistic local edit. Edited entries lose their revisions, so the next snapshot replaces them. */
    patch(edit: (current: WorkbenchQueue) => WorkbenchQueue) {
      const before = new Set([...queue.items, ...(queue.starredItems ?? [])]);
      const next = edit(queue);
      const unstamp = (item: QueueItem) => (before.has(item) ? item : { ...item, revision: undefined });
      queue = Object.freeze({
        ...next,
        revision: undefined,
        parts: undefined,
        items: next.items.map(unstamp),
        starredItems: next.starredItems?.map(unstamp),
      });
      notify();
    },
    /** Discard reads that start before the returned release, then read once if any were discarded. */
    hold() {
      holds++;
      epoch++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        epoch++;
        if (!holds && dropped) {
          dropped = false;
          if (listeners.size) void load('snapshot').catch(() => {});
        }
      };
    },
    /** Forget the previous account's queue. */
    reset(next: string) {
      if (next === account) return;
      const first = account === undefined;
      account = next;
      // The first account is the one any loaded snapshot already belongs to.
      if (first) return;
      generation++;
      queue = EMPTY_QUEUE;
      history = EMPTY_HISTORY;
      held = undefined;
      status = { loaded: false };
      notify();
      if (listeners.size) void load('snapshot').catch(() => {});
    },
  };
}
export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>;

export const workbenchStore = createWorkbenchStore(() => window.electronAPI, {
  onSavedSignals: publishQueueSignals,
  focus: (listener) => {
    window.addEventListener('focus', listener);
    return () => window.removeEventListener('focus', listener);
  },
});

const idle = () => () => {};
export function useWorkbenchQueue(enabled = true, store: WorkbenchStore = workbenchStore) {
  return useSyncExternalStore(enabled ? store.subscribe : idle, store.getQueue);
}
export function useReviewHistory(enabled = true, store: WorkbenchStore = workbenchStore) {
  return useSyncExternalStore(enabled ? store.subscribe : idle, store.getHistory);
}
export function useWorkbenchStatus(enabled = true, store: WorkbenchStore = workbenchStore) {
  return useSyncExternalStore(enabled ? store.subscribe : idle, store.getStatus);
}
