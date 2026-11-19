import { clearStackChanges, forgetStackChanges, stackLastUses } from './stack-inspection-cache';
import { clearMarkdownReviews } from './markdown-review-cache';
import { createPrFileCache } from './pr-file-cache';
import { commitSelectionKey, type CommitSelection } from './pr-commits';
import { fileRevisionKey, inspectionRank, type InspectionMode, type PrChanges, type PrChangeFile, type PrFileRequest } from './pr-changes';
import type { FileDiffMetadata } from '@pierre/diffs';
import { createPrInspectionCache } from './pr-inspection-cache';
import type { PrCommits } from './pr-commits';
import { approximateBytes, createByteCache } from './byte-cache';
import {
  RENDERER_COMPARISON_BYTES,
  RENDERER_COMPARISON_ENTRIES,
  RENDERER_FILE_BYTES,
  RENDERER_IDLE_MS,
  RENDERER_PREVIEW_BYTES,
  RENDERER_PREVIEW_ENTRIES,
} from './inspection-limits';
import { inTreeOrder } from './tree-file-order';
import { isMarkdownFile } from './markdown-review';
import { imageMimeType } from './review-images';

/** IPC options for a read mode: queue preparation is `background`, a prediction carries its destination kind. */
const loadMode = (mode: InspectionMode) =>
  typeof mode === 'object' ? { predicted: mode.predicted } : mode === 'view' ? { view: true } : { background: mode };
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
  changes: (r, refresh, mode, signal, recheck) => inventory(signal, requestId => window.electronAPI.getPrChanges(r.url, refresh, { revision: r, ...loadMode(mode), requestId, ...(recheck ? { recheck } : {}) })),
  commits: (r, refresh, mode, signal) => inventory(signal, requestId => window.electronAPI.getPrCommits(r.url, refresh, { revision: r, ...loadMode(mode), requestId })),
  file: (snapshot, file, mode = true) => inspectionFiles.read(inspectionFileRequest(snapshot, file), mode),
  // A patch preview shows code at once; Markdown needs its contents to render.
  fileReady: (snapshot, file) =>
    !!inspectionFiles.peek(inspectionFileRequest(snapshot, file)) || (!isMarkdownFile(file.path) && fileIsReady(snapshot, file)),
  comparison: (list, commit) => readComparison({
    url: list.url, prBaseSha: list.metadata.baseSha, prHeadSha: list.metadata.headSha,
    firstSha: commit.sha, lastSha: commit.sha,
  }, '', true),
  review: (snapshot) => window.electronAPI.preparePrReview(snapshot.url, snapshot.metadata),
  visible: () => document.visibilityState !== 'hidden' && navigator.onLine,
  prioritize: (urls) => {
    inspectionFiles.prioritize(urls);
    comparisonPriorities = new Map(urls.map((url, index) => [url, index]));
  },
  reset: () => {
    inspectionEpoch++;
    clearStackChanges();
    clearMarkdownReviews();
    for (const listener of forgetListeners) listener(undefined);
    inspectionFiles.clear();
    previews.clear();
    comparisons.clear();
    comparisonPriorities.clear();
    pending.clear();
    queue.clear();
    failed.clear();
  },
});
document.addEventListener('visibilitychange', () => inspectionData.resume());
window.addEventListener('online', () => inspectionData.resume());

export const inspectionFiles = createPrFileCache(
  (request, background) => window.electronAPI.getPrChangeFile(request, background),
  RENDERER_FILE_BYTES,
  (request, background) => window.electronAPI.getPrChangeFileAfter(request, background)
);
export const inspectionFileRequest = (snapshot: PrChanges, file: PrChangeFile) => ({
  url: snapshot.url,
  path: file.path,
  baseSha: snapshot.metadata.baseSha,
  headSha: snapshot.metadata.headSha,
  comparison: snapshot.comparison,
  stackComparison: snapshot.stackComparison?.key,
});
export const commitPositionId = (subjectId: string, snapshot?: PrChanges) =>
  `commit:${subjectId}:${snapshot?.url ?? ''}:${snapshot?.comparisonBase ?? ''}:${snapshot?.metadata.headSha ?? ''}`;
// Previews parse with @pierre/diffs, which stays out of the startup bundle until an inspection needs it.
let changePreview: typeof import('./pr-change-preview') | undefined;
let changePreviewLoad: Promise<void> | undefined;
export function loadChangePreview(): Promise<void> {
  changePreviewLoad ??= import('./pr-change-preview').then(
    (module) => { changePreview = module; },
    (error: unknown) => { changePreviewLoad = undefined; throw error; }
  );
  return changePreviewLoad;
}
// Parsed patches, bounded by an estimate from the patch's length: walking the parsed lines to measure them would cost
// as much as parsing them. Each preview keeps its PR's URL, so a closed or idle PR's previews leave with it.
const previews = createByteCache<string, { url: string; value: FileDiffMetadata | null }>(RENDERER_PREVIEW_BYTES, RENDERER_PREVIEW_ENTRIES);
/** The PR of a preview key that ends in a file revision key (`fileRevisionKey`); '' for other keys. */
const previewUrl = (key: string) => {
  const start = key.indexOf('["');
  if (start < 0) return '';
  try {
    const url = (JSON.parse(key.slice(start)) as unknown[])[0];
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
};
export function previewFor(key: string, file: PrChangeFile, contextLines = 3) {
  if (!changePreview) {
    void loadChangePreview().catch(() => {});
    return;
  }
  const id = `${key}:context:${contextLines}`;
  let saved = previews.get(id);
  if (!saved) {
    saved = { url: previewUrl(key), value: changePreview.prChangePreview(file, contextLines) ?? null };
    previews.set(id, saved, 1024 + (file.patch?.length ?? 0) * 6);
  }
  return saved.value ?? undefined;
}
export function fileIsReady(snapshot: PrChanges, file: PrChangeFile) {
  return (
    !!inspectionFiles.peek(inspectionFileRequest(snapshot, file)) ||
    !!previewFor(
      `${snapshot.stackComparison ? `stack:${snapshot.stackComparison.key}:` : snapshot.comparison ? 'commit:' : ''}${fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha)}`,
      file
    )
  );
}
export async function prepareFile(snapshot: PrChanges, file: PrChangeFile, background: InspectionMode = false) {
  // Without a preview parser the file itself is read, as for a file without a patch.
  await loadChangePreview().catch(() => {});
  if (!fileIsReady(snapshot, file)) await inspectionFiles.read(inspectionFileRequest(snapshot, file), background);
}
let inspectionEpoch = 0;
let comparisonPriorities = new Map<string, number>();
const comparisons = createByteCache<string, PrChanges>(RENDERER_COMPARISON_BYTES, RENDERER_COMPARISON_ENTRIES);
const pending = new Map<string, { promise: Promise<PrChanges>; background: InspectionMode }>();
export const peekComparison = (selection: CommitSelection) => comparisons.get(commitSelectionKey(selection));
/** What the renderer's inspection caches hold, for the diagnostics export (#345). Bytes are estimates. */
export const inspectionCacheStats = () => ({
  inventories: inspectionData.stats(),
  comparisons: { entries: comparisons.size, bytes: comparisons.bytes },
  files: inspectionFiles.stats(),
  previews: { entries: previews.size, bytes: previews.bytes },
  prs: inspectionLastUses().size,
});

const forgetListeners = new Set<(urls: ReadonlySet<string> | undefined) => void>();
/**
 * Calls `listener` when PRs leave the inspection caches, with their URLs, or with undefined when every PR does. Caches
 * kept beside these, such as parsed definitions (lib/syntax-scope-client.ts), leave with them. Main bundles this
 * module through the diagnostics export, so it imports none of them.
 */
export function onInspectionForget(listener: (urls: ReadonlySet<string> | undefined) => void) {
  forgetListeners.add(listener);
  return () => forgetListeners.delete(listener);
}
const useSources = new Set<(into: Map<string, number>) => void>();
/**
 * Adds a cache kept beside these to the idle sweep: `source` merges the last use of each PR it holds into `into` (the
 * latest wins). A PR that only such a cache still holds, after its files left the file cache by its bound, is then
 * swept too, and its `onInspectionForget` listener drops it.
 */
export function onInspectionUses(source: (into: Map<string, number>) => void) {
  useSources.add(source);
  return () => useSources.delete(source);
}

/** When each PR in the inspection caches, and in the caches kept beside them, was last read. */
function inspectionLastUses() {
  const uses = new Map<string, number>();
  inspectionData.lastUses(uses);
  inspectionFiles.lastUses(uses);
  stackLastUses(uses);
  for (const source of useSources) source(uses);
  for (const [snapshot, at] of comparisons.uses()) if ((uses.get(snapshot.url) ?? -Infinity) < at) uses.set(snapshot.url, at);
  for (const [preview, at] of previews.uses()) if ((uses.get(preview.url) ?? -Infinity) < at) uses.set(preview.url, at);
  uses.delete('');
  return uses;
}
/**
 * Drops everything the renderer holds for these PRs: inventories, comparisons, files, previews and stack comparisons.
 * For a closed tab's PRs and PRs not read for a while (#355). Main still has them, so a later visit reads them over
 * IPC.
 */
export function forgetInspection(urls: Iterable<string>) {
  const set = new Set(urls);
  if (!set.size) return;
  inspectionData.forget(set);
  inspectionFiles.forget(set);
  forgetStackChanges(set);
  for (const listener of forgetListeners) listener(set);
  comparisons.prune((snapshot) => set.has(snapshot.url));
  previews.prune((preview) => set.has(preview.url));
}
/**
 * Drops what the renderer holds for one file: its contents and its parsed patch. For a file whose contents did not
 * match its patch (lib/stale-diff-refresh.ts), so both read again once the PR's changes are refreshed.
 */
export function dropInspectionFile(request: PrFileRequest) {
  const key = inspectionFiles.keyFor(request);
  inspectionFiles.drop(request);
  previews.prune((_value, _at, id) => id.startsWith(`${key}:context:`));
}
/** Drops the PRs nothing has read for `idleMs`. Use is per PR: reading one file keeps all of its PR's entries. */
export function sweepIdleInspection(now = Date.now(), idleMs = RENDERER_IDLE_MS) {
  const idle = [...inspectionLastUses()].filter(([, at]) => now - at > idleMs).map(([url]) => url);
  forgetInspection(idle);
  return idle;
}
if (typeof window !== 'undefined') setInterval(() => sweepIdleInspection(), 60_000);
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
    inTreeOrder(snapshot.files, (file) => file.path).at(0)
  );
}
/**
 * The files a prediction prepares for Changes: the file the reader last viewed, or the first in tree order, then the
 * next ones in tree order. The same choice Changes makes when it opens.
 */
export function predictedFiles(snapshot: PrChanges, subjectId: string, count: number): PrChangeFile[] {
  let selected: string | undefined;
  try {
    selected = (JSON.parse(localStorage.getItem(`gnosis-changes-position:${subjectId}`) ?? 'null') as { selected?: unknown } | null)
      ?.selected as string | undefined;
  } catch {
    /* Optional position. */
  }
  const ordered = inTreeOrder(snapshot.files, (file) => file.path);
  // Stack positions prefix the path with the PR.
  const start = Math.max(0, typeof selected === 'string' && selected
    ? ordered.findIndex((file) => file.path === selected || selected.endsWith(`/${file.path}`)) : -1);
  // Images are large; only the file Changes opens on may be one.
  return [...ordered.slice(start, start + 1), ...ordered.slice(start + 1).filter((file) => !imageMimeType(file.path))].slice(0, count);
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
  background: InspectionMode = false
): Promise<PrChanges> {
  const key = commitSelectionKey(selection);
  const saved = comparisons.get(key);
  if (saved && comparisonIsReady(selection, subjectId)) return saved;
  const existing = pending.get(key);
  if (existing && inspectionRank(existing.background) >= inspectionRank(background)) return existing.promise;
  const generation = inspectionEpoch;
  const promise = (async () => {
    const snapshot = saved ?? (await window.electronAPI.getCommitComparison(selection, background));
    if (generation !== inspectionEpoch) return snapshot;
    const first = preferredFile(snapshot, subjectId);
    // A missing/binary first file must not prevent access to the rest of the comparison.
    if (first) await prepareFile(snapshot, first, background).catch(() => {});
    if (generation !== inspectionEpoch) return snapshot;
    // Lower-priority PRs leave first, so preparing the queue's earlier commits never evicts the open PR's.
    const size = approximateBytes(snapshot);
    comparisons.delete(key);
    comparisons.makeRoom(size, (old) => comparisonPriorities.get(old.url) ?? Infinity);
    comparisons.set(key, snapshot, size);
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
