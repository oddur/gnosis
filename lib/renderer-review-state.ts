import { FILE_PROGRESS_KEY, isReviewStateKey, type FileProgressPatch } from './review-state';
let saved: Record<string, unknown> | undefined;
/** Saves sent to the main process and not yet answered. Quit waits for them. */
const sending = new Set<Promise<unknown>>();
/** Keys with a save in flight, so a repeated value is never skipped behind a different one. */
const sendingKeys = new Map<string, number>();
/** Debounced saves that have not run yet. Quit runs them at once. */
const deferred = new Set<() => void>();
let quitting = false;
function track<T>(promise: Promise<T>, key?: string): Promise<T> {
  sending.add(promise);
  if (key) sendingKeys.set(key, (sendingKeys.get(key) ?? 0) + 1);
  const settle = () => {
    sending.delete(promise);
    if (!key) return;
    const count = (sendingKeys.get(key) ?? 1) - 1;
    if (count) sendingKeys.set(key, count);
    else sendingKeys.delete(key);
  };
  promise.then(settle, settle);
  return promise;
}
/**
 * Run `save` after `delayMs`, or sooner if the app quits first. Returns a cancel function that drops
 * the save. Use it for debounced writes, such as scroll positions, so quitting does not lose them.
 */
export function scheduleReviewStateWrite(save: () => void, delayMs: number): () => void {
  const run = () => {
    clearTimeout(timer);
    if (!deferred.delete(run)) return;
    save();
  };
  const timer = setTimeout(run, delayMs);
  deferred.add(run);
  return () => {
    clearTimeout(timer);
    deferred.delete(run);
  };
}
function nextTask() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
/**
 * Run every scheduled save now, then wait until the main process has answered every save sent so far.
 * Main asks for this before it closes saved data at quit. Later writes that repeat the saved value are
 * skipped, so closing the window does not send them again after the store has closed.
 */
export async function flushReviewState({ quit = false } = {}) {
  if (quit) quitting = true;
  for (let round = 0; round < 10; round++) {
    for (const run of [...deferred]) {
      try {
        run();
      } catch {
        /* One failed save must not keep the others from quit. */
      }
    }
    await Promise.allSettled([...sending]);
    // Writers often chain a save behind an earlier one; a task lets those chains send theirs. A message
    // port, not a timer: background windows throttle timers, and quit gives each window 500 ms.
    await nextTask();
    if (!sending.size && !deferred.size) return;
  }
}
const migrationKey = 'gnosis-review-storage:sqlite-v1';
// Browser-only previews and source-level tests may omit the preload interface.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
const native = () => typeof window !== 'undefined' && window.electronAPI?.reviewStateStorageVersion === 1;
/** Browser storage is read once to migrate data owned by the old renderer origin. */
export async function initializeReviewState() {
  if (!native()) return; // Standalone component previews do not have an Electron backend.
  const legacy: Record<string, string> = {};
  if (localStorage.getItem(migrationKey) !== 'done') {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isReviewStateKey(key)) {
        const value = localStorage.getItem(key);
        if (value !== null) legacy[key] = value;
      }
    }
  }
  saved = await window.electronAPI.loadReviewState(legacy);
  window.electronAPI.onFlushReviewState(() => flushReviewState({ quit: true }));
  // Import is committed before any old copy is removed. A failed cleanup is safe to retry.
  try {
    for (const key of Object.keys(legacy)) localStorage.removeItem(key);
    localStorage.setItem(migrationKey, 'done');
  } catch {
    /* Database migration markers prevent resurrection if cleanup must be retried. */
  }
}
export function readReviewState(key: string): unknown {
  if (!isReviewStateKey(key)) throw new Error('Invalid review state key');
  if (native()) {
    if (!saved) throw new Error('Your saved review progress is still loading');
    return saved[key];
  }
  // Browser-only previews retain their existing local storage adapter.
  const value = localStorage.getItem(key);
  return value === null ? undefined : (JSON.parse(value) as unknown);
}
export async function writeReviewState(key: string, value: unknown) {
  if (!isReviewStateKey(key)) throw new Error('Invalid review state key');
  if (native()) {
    if (!saved) throw new Error('Your saved review progress is still loading');
    if (quitting && !sendingKeys.has(key) && JSON.stringify(saved[key] ?? null) === JSON.stringify(value)) return;
    await track(window.electronAPI.saveReviewState({ key, value }), key);
    if (value === null) Reflect.deleteProperty(saved, key);
    else saved[key] = value;
  } else if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
export async function patchFileProgress(patch: FileProgressPatch) {
  if (native()) {
    await track(window.electronAPI.saveFileProgress(patch));
    return;
  }
  const previous = (readReviewState(FILE_PROGRESS_KEY) ?? { aliases: {}, marks: {} }) as FileProgressPatch;
  await writeReviewState(FILE_PROGRESS_KEY, {
    aliases: { ...previous.aliases, ...patch.aliases },
    marks: { ...previous.marks, ...patch.marks },
  });
}
