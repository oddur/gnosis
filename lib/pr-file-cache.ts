import { fileRevisionKey, type PrFileContents, type PrFileRequest } from './pr-changes';

/** Keep opened immutable revisions in the renderer: revisits need no IPC or network round trip. */
export function createPrFileCache(load: (request: PrFileRequest) => Promise<PrFileContents>, maxBytes = 32_000_000) {
  const saved = new Map<string, { value: PrFileContents; bytes: number }>();
  const pending = new Map<string, Promise<PrFileContents>>();
  let bytes = 0;
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
  return {
    peek,
    read(r: PrFileRequest): Promise<PrFileContents> {
      const cached = peek(r);
      if (cached) return Promise.resolve(cached);
      const key = keyFor(r),
        existing = pending.get(key);
      if (existing) return existing;
      const promise = load(r)
        .then((value) => {
          const size = [value.before, value.after].reduce(
            (n, side) =>
              n +
              (side.kind === 'text' ? side.content.length * 2 : side.kind === 'image' ? side.dataUrl.length * 2 : 0),
            0
          );
          if (size <= maxBytes) {
            saved.set(key, { value, bytes: size });
            bytes += size;
            for (const [oldKey, old] of saved) {
              if (bytes <= maxBytes && saved.size <= 128) break;
              saved.delete(oldKey);
              bytes -= old.bytes;
            }
          }
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
  };
}
