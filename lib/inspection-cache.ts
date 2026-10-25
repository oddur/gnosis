import { createPrFileCache } from './pr-file-cache';
import { prChangePreview } from './pr-change-preview';
import { commitSelectionKey, type CommitSelection } from './pr-commits';
import { fileRevisionKey, type PrChanges, type PrChangeFile } from './pr-changes';
import type { FileDiffMetadata } from '@pierre/diffs';

export const inspectionFiles = createPrFileCache((request, background) =>
  window.electronAPI.getPrChangeFile(request, background)
);
export const inspectionFileRequest = (snapshot: PrChanges, file: PrChangeFile) => ({
  url: snapshot.url,
  path: file.path,
  baseSha: snapshot.metadata.baseSha,
  headSha: snapshot.metadata.headSha,
  comparison: snapshot.comparison,
});
export const commitPositionId = (subjectId: string, snapshot?: PrChanges) =>
  `commit:${subjectId}:${snapshot?.url ?? ''}:${snapshot?.comparisonBase ?? ''}:${snapshot?.metadata.headSha ?? ''}`;
const previews = new Map<string, FileDiffMetadata | null>();
export function previewFor(key: string, file: PrChangeFile, contextLines = 3) {
  key = `${key}:context:${contextLines}`;
  if (!previews.has(key)) {
    previews.set(key, prChangePreview(file, contextLines) ?? null);
    while (previews.size > 64) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
  }
  return previews.get(key) ?? undefined;
}
export function fileIsReady(snapshot: PrChanges, file: PrChangeFile) {
  return (
    !!inspectionFiles.peek(inspectionFileRequest(snapshot, file)) ||
    !!previewFor(
      `${snapshot.comparison ? 'commit:' : ''}${fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha)}`,
      file
    )
  );
}
export async function prepareFile(snapshot: PrChanges, file: PrChangeFile, background = false) {
  if (!fileIsReady(snapshot, file)) await inspectionFiles.read(inspectionFileRequest(snapshot, file), background);
}
const comparisons = new Map<string, PrChanges>();
const pending = new Map<string, { promise: Promise<PrChanges>; background: boolean }>();
export const peekComparison = (selection: CommitSelection) => comparisons.get(commitSelectionKey(selection));
function preferredFile(snapshot: PrChanges, subjectId: string) {
  let path: string | undefined;
  try {
    path = (
      JSON.parse(
        localStorage.getItem(`gnosis-changes-position:${commitPositionId(subjectId, snapshot)}`) ?? 'null'
      ) as { selected?: string } | null
    )?.selected;
  } catch {
    /* Optional position. */
  }
  return (
    snapshot.files.find((f) => f.path === path) ??
    [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path)).at(0)
  );
}
export function comparisonIsReady(selection: CommitSelection, subjectId: string) {
  const snapshot = peekComparison(selection);
  if (!snapshot) return false;
  const first = preferredFile(snapshot, subjectId);
  return !first || fileIsReady(snapshot, first);
}
export async function readComparison(
  selection: CommitSelection,
  subjectId: string,
  background = false
): Promise<PrChanges> {
  const key = commitSelectionKey(selection);
  const saved = comparisons.get(key);
  if (saved && comparisonIsReady(selection, subjectId)) return saved;
  const existing = pending.get(key);
  if (existing)
    return existing.background && !background
      ? existing.promise.catch(() => readComparison(selection, subjectId, false))
      : existing.promise;
  const promise = (async () => {
    const snapshot = saved ?? (await window.electronAPI.getCommitComparison(selection, background));
    const first = preferredFile(snapshot, subjectId);
    // A missing/binary first file must not prevent access to the rest of the comparison.
    if (first) await prepareFile(snapshot, first, background).catch(() => {});
    comparisons.set(key, snapshot);
    while (comparisons.size > 100) {
      const oldest = comparisons.keys().next().value;
      if (oldest === undefined) break;
      comparisons.delete(oldest);
    }
    return snapshot;
  })().finally(() => pending.delete(key));
  pending.set(key, { promise, background });
  return promise;
}

// A small, cancellable queue: one speculative request chain at a time, never a whole repository scan.
const queue = new Map<string, () => Promise<unknown>>();
const failed = new Map<string, number>();
let running = false;
export function prefetchInspection(key: string, run: () => Promise<unknown>) {
  if ((failed.get(key) ?? 0) > Date.now() || queue.has(key)) return () => {};
  queue.set(key, run);
  while (queue.size > 12) {
    const first = queue.keys().next().value;
    if (first === undefined) break;
    queue.delete(first);
  }
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.size) {
        const next = queue.entries().next().value;
        if (!next) break;
        const [key, job] = next;
        queue.delete(key);
        if (document.visibilityState === 'hidden') continue;
        try {
          await job();
        } catch {
          failed.set(key, Date.now() + 30_000);
          while (failed.size > 100) {
            const first = failed.keys().next().value;
            if (first === undefined) break;
            failed.delete(first);
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setTimeout(() => void drain(), 100);
  return () => {
    clearTimeout(timer);
    if (queue.get(key) === run) queue.delete(key);
  };
}
