import { fileRevisionKey, inspectionRank, type InspectionMode, type PrFileContents, type PrFileRequest, type PrFileSide } from './pr-changes';

/** After sides read alone, for gap reveals and hunk scopes (#393), which prefetch up to 300 files of the open PR. */
const AFTER_ENTRIES = 400;
/** Keep opened immutable revisions in the renderer: revisits need no IPC or network round trip. */
export function createPrFileCache(
  load: (request: PrFileRequest, background?: InspectionMode) => Promise<PrFileContents>,
  maxBytes = 32_000_000,
  loadAfter?: (request: PrFileRequest, background?: InspectionMode) => Promise<PrFileSide>,
  now: () => number = Date.now
) {
  // `at` is the entry's last use, so files of PRs no longer read can be dropped (#355).
  const saved = new Map<string, { value: PrFileContents; bytes: number; url: string; at: number }>();
  let priorities = new Map<string, number>();
  const pending = new Map<string, { promise: Promise<PrFileContents>; background: InspectionMode }>();
  let bytes = 0,
    epoch = 0;
  // A read in flight when its PR is forgotten (a closed tab, an idle PR) still answers its caller, but keeps nothing:
  // otherwise it would put the PR back in the cache after it left. Each forget is numbered; a read stores its result
  // only when its PR was not forgotten after it started. Cleared whenever no read is in flight.
  let forgets = 0;
  const forgottenAt = new Map<string, number>();
  const keeps = (url: string, since: number) => (forgottenAt.get(url) ?? -1) <= since;
  const settled = () => {
    if (!pending.size && !afterPending.size) forgottenAt.clear();
  };
  /** Entries and estimated bytes, for the diagnostics export: whole files, and after sides read alone. */
  const stats = () => ({ entries: saved.size, bytes, afters: { entries: afters.size, bytes: afterBytes } });
  const keyFor = (r: PrFileRequest) =>
    `${r.stackComparison ? `stack:${r.stackComparison}:` : r.comparison ? 'commit:' : ''}${fileRevisionKey(r.url, r.path, r.baseSha, r.headSha)}`;
  const peek = (r: PrFileRequest) => {
    const key = keyFor(r),
      entry = saved.get(key);
    if (entry) {
      saved.delete(key);
      saved.set(key, entry);
      entry.at = now();
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
    const generation = epoch,
      since = forgets;
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
        if (generation === epoch && keeps(r.url, since) && size <= maxBytes) {
          bytes -= saved.get(key)?.bytes ?? 0;
          saved.set(key, { value, bytes: size, url: r.url, at: now() });
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
        settled();
      });
    pending.set(pendingKey, { promise, background });
    return promise;
  }
  // After sides read alone, to reveal context gaps (#299). A file whose both sides are cached answers from them.
  const afters = new Map<string, { value: PrFileSide; bytes: number; url: string; at: number }>();
  const afterPending = new Map<string, { promise: Promise<PrFileSide>; background: InspectionMode }>();
  let afterBytes = 0;
  const peekAfter = (r: PrFileRequest) => {
    const full = peek(r);
    if (full) return full.after;
    const entry = afters.get(keyFor(r));
    if (entry) entry.at = now();
    return entry?.value;
  };
  function readAfter(r: PrFileRequest, background: InspectionMode = false): Promise<PrFileSide> {
    const known = peekAfter(r);
    if (known) return Promise.resolve(known);
    const key = keyFor(r);
    // As for whole files, a pending read is joined only by a caller of the same or lower rank: a reveal does not wait
    // behind a background read for hunk scopes (#393). Main joins the two reads and promotes the work.
    const full = pending.get(`${key}:false`);
    if (full && inspectionRank(full.background) >= inspectionRank(background)) return full.promise.then((value) => value.after);
    if (!loadAfter) return read(r, background).then((value) => value.after);
    const existing = afterPending.get(key);
    if (existing && inspectionRank(existing.background) >= inspectionRank(background)) return existing.promise;
    const generation = epoch,
      since = forgets;
    const promise = loadAfter(r, background)
      .then((value) => {
        const size = value.kind === 'text' ? value.content.length * 2 : 0;
        if (generation === epoch && keeps(r.url, since) && size <= maxBytes / 2) {
          afterBytes -= afters.get(key)?.bytes ?? 0;
          afters.delete(key);
          afters.set(key, { value, bytes: size, url: r.url, at: now() });
          afterBytes += size;
          for (const [oldKey, old] of afters) {
            if (afterBytes <= maxBytes / 2 && afters.size <= AFTER_ENTRIES) break;
            afters.delete(oldKey);
            afterBytes -= old.bytes;
          }
        }
        return value;
      })
      .finally(() => {
        if (afterPending.get(key)?.promise === promise) afterPending.delete(key);
        settled();
      });
    afterPending.set(key, { promise, background });
    return promise;
  }
  return {
    stats,
    /** The last use of each PR's files, merged into `into` (the latest wins). */
    lastUses(into: Map<string, number>) {
      for (const entry of [...saved.values(), ...afters.values()])
        if ((into.get(entry.url) ?? -Infinity) < entry.at) into.set(entry.url, entry.at);
    },
    /** Drops every saved file of these PRs. Reads in flight still answer their callers, and keep nothing. */
    forget(urls: ReadonlySet<string>) {
      if (pending.size || afterPending.size) {
        forgets++;
        for (const url of urls) forgottenAt.set(url, forgets);
      }
      for (const [key, entry] of saved)
        if (urls.has(entry.url)) {
          saved.delete(key);
          bytes -= entry.bytes;
        }
      for (const [key, entry] of afters)
        if (urls.has(entry.url)) {
          afters.delete(key);
          afterBytes -= entry.bytes;
        }
    },
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
      forgottenAt.clear();
      afterBytes = 0;
      priorities.clear();
      bytes = 0;
    },
  };
}
