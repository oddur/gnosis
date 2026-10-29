/** Conservative in-memory estimate without constructing a second serialized copy. */
export function approximateBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2 + 16;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return 32 + (value as unknown[]).reduce<number>((n, entry) => n + approximateBytes(entry, seen), 0);
  return Object.entries(value).reduce((n, [key, entry]) => n + key.length * 2 + 24 + approximateBytes(entry, seen), 32);
}

/** Byte and entry bounds both apply, including to a single oversized value. */
export function createByteCache<K, V>(maxBytes: number, maxEntries: number) {
  const entries = new Map<K, { value: V; bytes: number }>();
  let bytes = 0;
  const remove = (key: K) => {
    bytes -= entries.get(key)?.bytes ?? 0;
    return entries.delete(key);
  };
  return {
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
    keys: () => entries.keys(),
    *[Symbol.iterator](): IterableIterator<[K, V]> {
      for (const [key, entry] of entries) yield [key, entry.value];
    },
    get(key: K) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key: K, value: V) {
      remove(key);
      const size = approximateBytes(value);
      if (size > maxBytes) return;
      entries.set(key, { value, bytes: size });
      bytes += size;
      while (bytes > maxBytes || entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
    },
    delete: remove,
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
