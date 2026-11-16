import { fileRevisionKey, inspectionRank, type InspectionMode, type PrFileContents, type PrFileRequest, type PrFileSide } from './pr-changes';

/** Keep opened immutable revisions in the renderer: revisits need no IPC or network round trip. */
export function createPrFileCache(
  load: (request: PrFileRequest, background?: InspectionMode) => Promise<PrFileContents>,
  maxBytes = 32_000_000,
  loadAfter?: (request: PrFileRequest, background?: InspectionMode) => Promise<PrFileSide>
) {
  const saved = new Map<string, { value: PrFileContents; bytes: number; url: string }>();
  let priorities = new Map<string, number>();
  const pending = new Map<string, { promise: Promise<PrFileContents>; background: InspectionMode }>();
  let bytes = 0,
    epoch = 0;
  const keyFor = (r: PrFileRequest) =>
    `${r.stackComparison ? `stack:${r.stackComparison}:` : r.comparison ? 'commit:' : ''}${fileRevisionKey(r.url, r.path, r.baseSha, r.headSha)}`;
  const peek = (r: PrFileRequest) => {
    const key = keyFor(r),
      entry = saved.get(key);
    if (entry) {
      saved.delete(key);
      saved.set(key, entry);
    }
    return entry?.value;
  };
  /**
   * A pending read is reused only by a caller of the same or lower rank. A reader's own request sends its own IPC
   * even while a prediction or queue read is pending; main joins the two and promotes the work.
   */
  function read(r: PrFileRequest, background: InspectionMode = false): Promise<PrFileContents> {
    const cached = peek(r);
    if (cached && (!r.downloadLfs || ![cached.before, cached.after].some((s) => s.kind === 'lfs')))
      return Promise.resolve(cached);
    const key = keyFor(r),
      pendingKey = `${key}:${!!r.downloadLfs}`,
      existing = pending.get(pendingKey);
    if (existing && inspectionRank(existing.background) >= inspectionRank(background)) return existing.promise;
    const generation = epoch;
    const promise = load(r, background)
      .then((value) => {
        const current = saved.get(key)?.value;
        if (
          generation === epoch &&
          current?.lfs &&
          ![current.before, current.after].some((s) => s.kind === 'lfs') &&
          [value.before, value.after].some((s) => s.kind === 'lfs')
        )
          return current;
        const size = [value.before, value.after].reduce(
          (n, side) =>
            n + (side.kind === 'text' ? side.content.length * 2 : side.kind === 'image' ? side.dataUrl.length * 2 : 0),
          0
        );
        if (generation === epoch && size <= maxBytes) {
          bytes -= saved.get(key)?.bytes ?? 0;
          saved.set(key, { value, bytes: size, url: r.url });
          bytes += size;
          // Evict low-priority PRs first; preserve LRU order within each PR. Sort only when over budget: background
          // preparation stores hundreds of files, and sorting on each one kept the main thread busy (#346).
          if (bytes <= maxBytes && saved.size <= 128) return value;
          const eviction = [...saved].sort(
            (a, b) => (priorities.get(b[1].url) ?? Infinity) - (priorities.get(a[1].url) ?? Infinity)
          );
          for (const [oldKey, old] of eviction) {
            if (bytes <= maxBytes && saved.size <= 128) break;
            saved.delete(oldKey);
            bytes -= old.bytes;
          }
        }
        return value;
      })
      .finally(() => {
        if (pending.get(pendingKey)?.promise === promise) pending.delete(pendingKey);
      });
    pending.set(pendingKey, { promise, background });
    return promise;
  }
  // After sides read alone, to reveal context gaps (#299). A file whose both sides are cached answers from them.
  const afters = new Map<string, { value: PrFileSide; bytes: number }>();
  const afterPending = new Map<string, Promise<PrFileSide>>();
  let afterBytes = 0;
  const peekAfter = (r: PrFileRequest) => peek(r)?.after ?? afters.get(keyFor(r))?.value;
  function readAfter(r: PrFileRequest, background: InspectionMode = false): Promise<PrFileSide> {
    const known = peekAfter(r);
    if (known) return Promise.resolve(known);
    const key = keyFor(r);
    const full = pending.get(`${key}:false`);
    if (full) return full.promise.then((value) => value.after);
    if (!loadAfter) return read(r, background).then((value) => value.after);
    const existing = afterPending.get(key);
    if (existing) return existing;
    const generation = epoch;
    const promise = loadAfter(r, background)
      .then((value) => {
        const size = value.kind === 'text' ? value.content.length * 2 : 0;
        if (generation === epoch && size <= maxBytes / 2) {
          afterBytes -= afters.get(key)?.bytes ?? 0;
          afters.delete(key);
          afters.set(key, { value, bytes: size });
          afterBytes += size;
          for (const [oldKey, old] of afters) {
            if (afterBytes <= maxBytes / 2 && afters.size <= 32) break;
            afters.delete(oldKey);
            afterBytes -= old.bytes;
          }
        }
        return value;
      })
      .finally(() => {
        if (afterPending.get(key) === promise) afterPending.delete(key);
      });
    afterPending.set(key, promise);
    return promise;
  }
  return {
    peek,
    read,
    peekAfter,
    readAfter,
    prioritize(urls: string[]) {
      priorities = new Map(urls.map((url, index) => [url, index]));
    },
    clear() {
      epoch++;
      saved.clear();
      pending.clear();
      afters.clear();
      afterPending.clear();
      afterBytes = 0;
      priorities.clear();
      bytes = 0;
    },
  };
}
