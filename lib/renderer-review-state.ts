import { FILE_PROGRESS_KEY, isReviewStateKey, type FileProgressPatch } from './review-state';
let saved: Record<string, unknown> | undefined;
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
    await window.electronAPI.saveReviewState({ key, value });
    if (value === null) Reflect.deleteProperty(saved, key);
    else saved[key] = value;
  } else if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
export async function patchFileProgress(patch: FileProgressPatch) {
  if (native()) {
    await window.electronAPI.saveFileProgress(patch);
    return;
  }
  const previous = (readReviewState(FILE_PROGRESS_KEY) ?? { aliases: {}, marks: {} }) as FileProgressPatch;
  await writeReviewState(FILE_PROGRESS_KEY, {
    aliases: { ...previous.aliases, ...patch.aliases },
    marks: { ...previous.marks, ...patch.marks },
  });
}
