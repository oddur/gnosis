import type { QueueItem, WorkbenchQueue } from './workbench';
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

export interface SavedQueue {
  version: 1;
  account: string;
  savedAt: number;
  queue: WorkbenchQueue;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isItem = (value: unknown): value is QueueItem =>
  isRecord(value) && isRecord(value.subject) && typeof value.subject.id === 'string' && Array.isArray(value.subject.members) &&
  value.subject.members.every((member) => isRecord(member) && typeof member.url === 'string' && typeof member.headSha === 'string');

/** A saved copy that is complete, recent and for a known account; otherwise undefined. */
export function parseSavedQueue(value: unknown, now = Date.now()): SavedQueue | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.account !== 'string' || !value.account) return;
  if (typeof value.savedAt !== 'number' || now - value.savedAt > SAVED_QUEUE_MAX_AGE_MS || value.savedAt > now + 60_000) return;
  const queue = value.queue;
  if (!isRecord(queue) || !Array.isArray(queue.items) || !queue.items.every(isItem)) return;
  if (queue.starredItems !== undefined && (!Array.isArray(queue.starredItems) || !queue.starredItems.every(isItem))) return;
  return value as unknown as SavedQueue;
}

/** What is saved: the queue without saved status, bounded in rows and size. Revisions are kept with each row. */
export function savedQueueFor(queue: WorkbenchQueue, account: string, now = Date.now()): SavedQueue {
  const rest: WorkbenchQueue = { ...queue };
  delete rest.savedSignals;
  let limit = MAX_ITEMS;
  for (;;) {
    const saved: SavedQueue = {
      version: 1,
      account,
      savedAt: now,
      queue: { ...rest, items: rest.items.slice(0, limit), starredItems: rest.starredItems?.slice(0, Math.min(limit, MAX_STARRED)) },
    };
    if (limit <= 10 || JSON.stringify(saved).length <= MAX_BYTES) return saved;
    limit = Math.floor(limit / 2);
  }
}

interface Storage {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => Promise<void>;
}

/**
 * Seeds the store from the saved copy, then keeps the copy current. Only queues main answered with are saved, never
 * the saved copy itself, and never before the window knows its account. Returns the saved copy's account, if one was
 * shown, and a function that stops saving.
 */
export function keepSavedQueue(store: WorkbenchStore, storage: Storage, options: { delay?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let saved: SavedQueue | undefined;
  try {
    saved = parseSavedQueue(storage.read(SAVED_QUEUE_KEY), now());
  } catch {
    /* Saved state that cannot be read only means waiting for main. */
  }
  const seeded = !!saved && store.seed(saved.queue, saved.account);
  let last: WorkbenchQueue | undefined = saved ? store.getQueue() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    const account = store.getAccount();
    const status = store.getStatus();
    const queue = store.getQueue();
    if (!account || !status.loaded || status.saved || queue === last) return;
    last = queue;
    void storage.write(SAVED_QUEUE_KEY, savedQueueFor(queue, account, now())).catch(() => {
      // The next change tries again.
      last = undefined;
    });
  };
  const unsubscribe = store.subscribe(() => {
    timer ??= setTimeout(save, options.delay ?? WRITE_DELAY_MS);
  });
  const flush = () => {
    if (timer) clearTimeout(timer);
    save();
  };
  const page = typeof window === 'undefined' ? undefined : window;
  page?.addEventListener('pagehide', flush);
  return {
    account: seeded ? saved?.account : undefined,
    stop() {
      unsubscribe();
      page?.removeEventListener('pagehide', flush);
      if (timer) clearTimeout(timer);
    },
  };
}
