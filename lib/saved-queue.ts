import type { QueueItem, WorkbenchQueue } from './workbench';
import type { QueueSignalRequest, QueueSignals } from './queue-signals';
import type { WorkbenchStore } from './workbench-store';

/**
 * The queue as it was last shown, saved with review state. Review state is the one read the first render waits for,
 * so the saved queue paints before main's snapshot, which waits for the GitHub cache. The store reports it as `saved`
 * until main answers, and the queue and PR header show "Refreshing…" meanwhile.
 */
export const SAVED_QUEUE_KEY = 'gnosis-saved-queue:v1';
/** Older copies are not shown: the reader would see a queue that has moved on too far. */
export const SAVED_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Rows kept. The first screens of every view are covered, and the saved state stays small. */
const MAX_ITEMS = 150;
const MAX_STARRED = 50;
/** Saved state is read at every launch; a copy larger than this keeps fewer rows. */
const MAX_BYTES = 1_500_000;
const WRITE_DELAY_MS = 2000;
/** Serializing a large queue runs in slices this long, so input and rendering go between them (#345). */
const SLICE_MS = 6;
/** Rows kept however large they are, so a copy always covers the first screen. */
const MIN_ITEMS = 10;

export interface SavedQueue {
  version: 1;
  account: string;
  savedAt: number;
  queue: WorkbenchQueue;
  /**
   * The saved status of the saved rows' revisions (checks, reviews, mergeability), as the rows last showed it. Rows
   * show it with its own check time, so a badge never waits for main when its last state is known.
   */
  signals?: QueueSignals[];
}
/** Saved status, from and to the shared queue-signal store. */
export interface SavedSignals {
  read: (account: string, requests: QueueSignalRequest[]) => QueueSignals[];
  publish: (account: string, values: QueueSignals[]) => void;
  /** Changes when any of these revisions gets a new value. */
  stamp?: (account: string, requests: QueueSignalRequest[]) => string;
  /** Called when the account's saved status changes. Returns a function that stops listening. */
  subscribe?: (account: string, listener: () => void) => () => void;
}
/** The revisions whose saved status goes with the copy. */
const statusRequests = (queue: WorkbenchQueue) =>
  [...queue.items.slice(0, MAX_ITEMS), ...(queue.starredItems ?? []).slice(0, MAX_STARRED)]
    .flatMap((item) => item.subject.members.map(({ url, headSha }) => ({ url, headSha })));

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isItem = (value: unknown): value is QueueItem =>
  isRecord(value) && isRecord(value.subject) && typeof value.subject.id === 'string' && Array.isArray(value.subject.members) &&
  value.subject.members.every((member) => isRecord(member) && typeof member.url === 'string' && typeof member.headSha === 'string');

/**
 * A saved copy that is complete, recent and for a known account; otherwise undefined. The copy is saved as JSON text,
 * which crosses IPC as one string; copies saved as objects by earlier builds are read too.
 */
export function parseSavedQueue(stored: unknown, now = Date.now()): SavedQueue | undefined {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return;
    }
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.account !== 'string' || !value.account) return;
  if (typeof value.savedAt !== 'number' || now - value.savedAt > SAVED_QUEUE_MAX_AGE_MS || value.savedAt > now + 60_000) return;
  const queue = value.queue;
  if (!isRecord(queue) || !Array.isArray(queue.items) || !queue.items.every(isItem)) return;
  if (queue.starredItems !== undefined && (!Array.isArray(queue.starredItems) || !queue.starredItems.every(isItem))) return;
  if (value.signals !== undefined && !(Array.isArray(value.signals) &&
    value.signals.every((signal) => isRecord(signal) && typeof signal.url === 'string' && typeof signal.headSha === 'string' &&
      typeof signal.checkedAt === 'number' && isRecord(signal.checks)))) return;
  return value as unknown as SavedQueue;
}

/**
 * What is saved, as JSON text: the queue without saved status, bounded in rows and size. Revisions are kept with each
 * row. Rows are serialized one at a time, so the work can pause between them; it yields when a slice has run long
 * enough. Up to 1.5 MB of JSON in one `JSON.stringify` blocked input for tens of milliseconds on every queue change.
 */
function* serialize(queue: WorkbenchQueue, account: string, now: number, status?: SavedSignals['read']): Generator<void, string> {
  const rest: Partial<WorkbenchQueue> = { ...queue };
  delete rest.savedSignals;
  delete rest.items;
  delete rest.starredItems;
  const restJson = JSON.stringify(rest);
  const signals = status ? status(account, statusRequests(queue)) : [];
  const signalsJson = signals.length ? `,"signals":${JSON.stringify(signals)}` : '';
  let budget = MAX_BYTES - restJson.length - signalsJson.length - 200;
  let sliceStart = performance.now();
  const rows = new Map<string, string>();
  const take = function* (items: QueueItem[] | undefined, limit: number): Generator<void, string[] | undefined> {
    if (!items) return;
    const kept: string[] = [];
    for (const item of items) {
      if (kept.length >= limit) break;
      const json = rows.get(item.subject.id) ?? JSON.stringify(item);
      const fresh = !rows.has(item.subject.id);
      if (fresh && json.length + 1 > budget && kept.length >= MIN_ITEMS) break;
      if (fresh) {
        rows.set(item.subject.id, json);
        budget -= json.length + 1;
      }
      kept.push(json);
      if (performance.now() - sliceStart > SLICE_MS) {
        yield;
        sliceStart = performance.now();
      }
    }
    return kept;
  };
  const items = (yield* take(queue.items, MAX_ITEMS)) ?? [];
  const starred = yield* take(queue.starredItems, Math.min(items.length, MAX_STARRED));
  const fields = [`"items":[${items.join(',')}]`, ...(starred ? [`"starredItems":[${starred.join(',')}]`] : [])].join(',');
  const queueJson = restJson === '{}' ? `{${fields}}` : `${restJson.slice(0, -1)},${fields}}`;
  return `{"version":1,"account":${JSON.stringify(account)},"savedAt":${now},"queue":${queueJson}${signalsJson}}`;
}
const run = (steps: Generator<void, string>) => {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};
/** A macrotask boundary: pending input and rendering run before the next slice. */
const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The saved copy as JSON text, serialized at once. */
export function serializeSavedQueue(queue: WorkbenchQueue, account: string, now = Date.now(), status?: SavedSignals['read']): string {
  return run(serialize(queue, account, now, status));
}
/** The saved copy as JSON text, serialized in slices with input handled between them. */
export async function serializeSavedQueueInSlices(queue: WorkbenchQueue, account: string, now = Date.now(), pause = yieldToInput,
  status?: SavedSignals['read']) {
  const steps = serialize(queue, account, now, status);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}
/** What is saved, as an object. */
export function savedQueueFor(queue: WorkbenchQueue, account: string, now = Date.now()): SavedQueue {
  return JSON.parse(serializeSavedQueue(queue, account, now)) as SavedQueue;
}

interface Storage {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => Promise<void>;
  /**
   * Runs a debounced save later and returns a function that drops it. Review state's scheduler also runs it, and
   * waits for the promise it returns, when the app quits, so a queue that changed just before quit is saved.
   */
  schedule?: (save: (quit: boolean) => Promise<void>, delayMs: number) => () => void;
}
const scheduleTimer = (save: () => Promise<void>, delayMs: number) => {
  const timer = setTimeout(() => void save(), delayMs);
  return () => clearTimeout(timer);
};

/**
 * Seeds the store from the saved copy, then keeps the copy current. Only queues main answered with are saved, never
 * the saved copy itself, and never before the window knows its account. A queue whose content revision was already
 * saved is not saved again. Returns the saved copy's account, if one was shown, and a function that stops saving.
 */
export function keepSavedQueue(store: WorkbenchStore, storage: Storage,
  options: { delay?: number; now?: () => number; signals?: SavedSignals } = {}) {
  const now = options.now ?? Date.now;
  let saved: SavedQueue | undefined;
  try {
    saved = parseSavedQueue(storage.read(SAVED_QUEUE_KEY), now());
  } catch {
    /* Saved state that cannot be read only means waiting for main. */
  }
  const seeded = !!saved && store.seed(saved.queue, saved.account);
  // Rows and the restored PR show the status they last showed, aged by its own check time.
  if (seeded && saved?.signals?.length) options.signals?.publish(saved.account, saved.signals);
  let last: WorkbenchQueue | undefined = saved ? store.getQueue() : undefined;
  /** The account, content revision and status stamp of the copy last saved. */
  let lastKey: string | undefined;
  let lastStamp: string | undefined;
  const scheduleSave = storage.schedule ?? scheduleTimer;
  /** Drops the scheduled save, if one is waiting. */
  let cancel: (() => void) | undefined;
  /** The save in progress, which ends by checking again. */
  let saving: Promise<void> | undefined;
  const due = () => {
    const account = store.getAccount();
    const status = store.getStatus();
    const queue = store.getQueue();
    if (!account || !status.loaded || status.saved) return;
    // Status that arrives after the queue, such as rows that came into view, is saved with it too.
    const stamp = options.signals?.stamp?.(account, statusRequests(queue)) ?? '';
    if (queue === last && stamp === lastStamp) return;
    const key = queue.revision === undefined ? undefined : `${account}\n${queue.revision}\n${stamp}`;
    if (key !== undefined && key === lastKey) {
      last = queue;
      return;
    }
    return { account, queue, key, stamp };
  };
  const write = (next: { queue: WorkbenchQueue; key?: string; stamp: string }, json: string) => {
    last = next.queue;
    lastKey = next.key;
    lastStamp = next.stamp;
    return storage.write(SAVED_QUEUE_KEY, json).catch(() => {
      // The next change tries again.
      last = undefined;
      lastKey = undefined;
    });
  };
  // At quit, slices do not wait on timers: background windows throttle them, and quit waits a short time.
  let hurry = false;
  const pause = () => (hurry ? Promise.resolve() : yieldToInput());
  // Returns the save in progress, so quit can wait for the queue it is still preparing.
  const save = (quit = false): Promise<void> => {
    cancel = undefined;
    if (quit) hurry = true;
    if (saving) return saving;
    const next = due();
    if (!next) return Promise.resolve();
    saving = (async () => {
      try {
        const json = await serializeSavedQueueInSlices(next.queue, next.account, now(), pause, options.signals?.read);
        // A newer queue that arrived meanwhile is saved by the next pass.
        if (store.getQueue() === next.queue) await write(next, json);
      } finally {
        saving = undefined;
        hurry = false;
      }
      if (due()) schedule();
    })();
    return saving;
  };
  const schedule = () => {
    cancel ??= scheduleSave(save, options.delay ?? WRITE_DELAY_MS);
  };
  let statusAccount: string | undefined;
  let stopStatus: (() => void) | undefined;
  const unsubscribe = store.subscribe(() => {
    const account = store.getAccount();
    if (account !== statusAccount) {
      stopStatus?.();
      statusAccount = account;
      stopStatus = account ? options.signals?.subscribe?.(account, schedule) : undefined;
    }
    schedule();
  });
  /** The window is going away: save what is shown now, in one piece. */
  const flush = () => {
    cancel?.();
    cancel = undefined;
    const next = due();
    if (next) void write(next, serializeSavedQueue(next.queue, next.account, now(), options.signals?.read));
  };
  const page = typeof window === 'undefined' ? undefined : window;
  page?.addEventListener('pagehide', flush);
  return {
    account: seeded ? saved?.account : undefined,
    stop() {
      unsubscribe();
      stopStatus?.();
      page?.removeEventListener('pagehide', flush);
      cancel?.();
      cancel = undefined;
    },
  };
}
