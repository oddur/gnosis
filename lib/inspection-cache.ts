import { clearMarkdownReviews } from './markdown-review-cache';
import { createPrFileCache } from './pr-file-cache';
import { prChangePreview } from './pr-change-preview';
import { commitSelectionKey, type CommitSelection } from './pr-commits';
import { fileRevisionKey, type PrChanges, type PrChangeFile } from './pr-changes';
import type { FileDiffMetadata } from '@pierre/diffs';
import { createPrInspectionCache } from './pr-inspection-cache';
import type { PrCommits } from './pr-commits';
import { createByteCache } from './byte-cache';
import { INVENTORY_MEMORY_BYTES } from './inspection-limits';

async function inventory<T>(signal: AbortSignal | undefined, read: (requestId: string) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const abort = () => { void window.electronAPI.cancelInspection(requestId).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try { return await read(requestId); }
  finally { signal?.removeEventListener('abort', abort); }
}

export const latestCommitSelection = (list: PrCommits): CommitSelection | undefined => {
  const commit = list.commits.at(-1);
  return commit
    ? {
        url: list.url,
        prBaseSha: list.metadata.baseSha,
        prHeadSha: list.metadata.headSha,
        firstSha: commit.sha,
        lastSha: commit.sha,
      }
    : undefined;
};

export const inspectionData = createPrInspectionCache({
  restore: revisions => window.electronAPI.getPreparedInventories(revisions),
  changes: (r, refresh, background, signal) => inventory(signal, requestId => window.electronAPI.getPrChanges(r.url, refresh, { revision: r, background, requestId })),
  commits: (r, refresh, background, signal) => inventory(signal, requestId => window.electronAPI.getPrCommits(r.url, refresh, { revision: r, background, requestId })),
  file: (snapshot, file) => inspectionFiles.read(inspectionFileRequest(snapshot, file), true),
  comparison: (list, commit) => readComparison({
    url: list.url, prBaseSha: list.metadata.baseSha, prHeadSha: list.metadata.headSha,
    firstSha: commit.sha, lastSha: commit.sha,
  }, '', true),
  review: (snapshot) => window.electronAPI.preparePrReview(snapshot.url, snapshot.metadata),
  // Background requests remain rate-limited; minimizing the window need not stop preparation.
  visible: () => true,
  prioritize: (urls) => {
    inspectionFiles.prioritize(urls);
    comparisonPriorities = new Map(urls.map((url, index) => [url, index]));
  },
  reset: () => {
    inspectionEpoch++;
    clearMarkdownReviews();
    inspectionFiles.clear();
    previews.clear();
    comparisons.clear();
    comparisonPriorities.clear();
    pending.clear();
    queue.clear();
    failed.clear();
  },
});

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
let inspectionEpoch = 0;
let comparisonPriorities = new Map<string, number>();
const comparisons = createByteCache<string, PrChanges>(INVENTORY_MEMORY_BYTES, 100);
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
  if (existing && (!existing.background || background)) return existing.promise;
  const generation = inspectionEpoch;
  const promise = (async () => {
    const snapshot = saved ?? (await window.electronAPI.getCommitComparison(selection, background));
    if (generation !== inspectionEpoch) return snapshot;
    const first = preferredFile(snapshot, subjectId);
    // A missing/binary first file must not prevent access to the rest of the comparison.
    if (first) await prepareFile(snapshot, first, background).catch(() => {});
    if (generation !== inspectionEpoch) return snapshot;
    comparisons.set(key, snapshot);
    while (comparisons.size > 100) {
      const oldest = [...comparisons]
        .sort(
          (a, b) => (comparisonPriorities.get(b[1].url) ?? Infinity) - (comparisonPriorities.get(a[1].url) ?? Infinity)
        )
        .at(0)?.[0];
      if (oldest === undefined) break;
      comparisons.delete(oldest);
    }
    return snapshot;
  })().finally(() => {
    if (pending.get(key)?.promise === promise) pending.delete(key);
  });
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
