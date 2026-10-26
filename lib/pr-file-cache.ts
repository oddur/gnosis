import { fileRevisionKey, type PrFileContents, type PrFileRequest } from './pr-changes';

/** Keep opened immutable revisions in the renderer: revisits need no IPC or network round trip. */
export function createPrFileCache(
  load: (request: PrFileRequest, background?: boolean) => Promise<PrFileContents>,
  maxBytes = 32_000_000
) {
  const saved = new Map<string, { value: PrFileContents; bytes: number; url: string }>();
  let priorities = new Map<string, number>();
  const pending = new Map<string, { promise: Promise<PrFileContents>; background: boolean }>();
  let bytes = 0,
    epoch = 0;
  const keyFor = (r: PrFileRequest) =>
    `${r.comparison ? 'commit:' : ''}${fileRevisionKey(r.url, r.path, r.baseSha, r.headSha)}`;
  const peek = (r: PrFileRequest) => {
    const key = keyFor(r),
      entry = saved.get(key);
    if (entry) {
      saved.delete(key);
      saved.set(key, entry);
    }
    return entry?.value;
  };
  function read(r: PrFileRequest, background = false): Promise<PrFileContents> {
    const cached = peek(r);
    if (cached && (!r.downloadLfs || ![cached.before, cached.after].some((s) => s.kind === 'lfs')))
      return Promise.resolve(cached);
    const key = keyFor(r),
      pendingKey = `${key}:${!!r.downloadLfs}`,
      existing = pending.get(pendingKey);
    if (existing && (!existing.background || background)) return existing.promise;
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
          // Evict low-priority PRs first; preserve LRU order within each PR.
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
  return {
    peek,
    read,
    prioritize(urls: string[]) {
      priorities = new Map(urls.map((url, index) => [url, index]));
    },
    clear() {
      epoch++;
      saved.clear();
      pending.clear();
      priorities.clear();
      bytes = 0;
    },
  };
}
