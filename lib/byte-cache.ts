/** Conservative in-memory estimate without constructing a second serialized copy. */
export function approximateBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2 + 16;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return 32 + (value as unknown[]).reduce<number>((n, entry) => n + approximateBytes(entry, seen), 0);
  return Object.entries(value).reduce((n, [key, entry]) => n + key.length * 2 + 24 + approximateBytes(entry, seen), 32);
}

/**
 * Byte and entry bounds both apply, including to a single oversized value. Each entry remembers when it was last
 * read or written, so a caller can drop what has not been used for a while (#355).
 */
export function createByteCache<K, V>(maxBytes: number, maxEntries: number, now: () => number = Date.now) {
  const entries = new Map<K, { value: V; bytes: number; at: number }>();
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
      entry.at = now();
      return entry.value;
    },
    /** Stores a value. `size` replaces the estimate when the caller knows it more cheaply. */
    set(key: K, value: V, size = approximateBytes(value)) {
      remove(key);
      if (size > maxBytes) return;
      entries.set(key, { value, bytes: size, at: now() });
      bytes += size;
      while (bytes > maxBytes || entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
    },
    delete: remove,
    /**
     * Evicts until a value of `size` bytes fits as one more entry: the highest `rank` first, least recently used first
     * within a rank. Set the value with the same size after, and nothing else is evicted.
     */
    makeRoom(size: number, rank: (value: V, key: K) => number) {
      const fits = () => bytes + size <= maxBytes && entries.size < maxEntries;
      if (fits()) return;
      const order = [...entries]
        .map(([key, entry], index) => ({ key, rank: rank(entry.value, key), index }))
        .sort((a, b) => b.rank - a.rank || a.index - b.index);
      for (const { key } of order) {
        if (fits()) break;
        remove(key);
      }
    },
    /** Removes the entries `drop` selects, given each value and when it was last used. */
    prune(drop: (value: V, at: number, key: K) => boolean) {
      for (const [key, entry] of [...entries]) if (drop(entry.value, entry.at, key)) remove(key);
    },
    /** Each entry's value and last use, oldest first. */
    *uses(): IterableIterator<[V, number]> {
      for (const entry of entries.values()) yield [entry.value, entry.at];
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
