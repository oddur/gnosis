import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 8_000_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_ENTRIES = 200;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
export function isCacheRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
interface Entry {
  scope: string;
  key: string;
  savedAt: number;
  value: unknown;
  revalidate?: boolean;
}

/** Bounded, credential-scoped local snapshots. Freshness is decided by each consumer. */
export function createGitHubCache(now = Date.now) {
  const entries = new Map<string, Entry>();
  const versions = new Map<string, number>();
  let file: string | undefined;
  const id = (scope: string, key: string) => `${scope}:${createHash('sha256').update(key).digest('hex')}`;
  const validTime = (time: number) => Number.isFinite(time) && time <= now() && now() - time < RETENTION_MS;
  function trim() {
    let bytes = 0;
    for (const [key, entry] of [...entries].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (!validTime(entry.savedAt) || size > MAX_ENTRY_BYTES || bytes + size > MAX_BYTES) entries.delete(key);
      else bytes += size;
    }
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
  function persist() {
    trim();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {
      // Cache failures must never replace a successful GitHub response.
    }
  }
  return {
    setStorage(location: string) {
      file = location;
      try {
        if (fs.statSync(file).size > MAX_BYTES + 100_000) return;
        const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isCacheRecord(saved) || saved.version !== 1 || !Array.isArray(saved.entries)) return;
        for (const entry of saved.entries as unknown[]) {
          if (
            !isCacheRecord(entry) ||
            typeof entry.scope !== 'string' ||
            typeof entry.key !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.scope) ||
            !/^[a-f0-9]{64}$/.test(entry.key) ||
            typeof entry.savedAt !== 'number' ||
            !validTime(entry.savedAt) ||
            !('value' in entry)
          )
            continue;
          entries.set(`${entry.scope}:${entry.key}`, {
            scope: entry.scope,
            key: entry.key,
            savedAt: entry.savedAt,
            value: entry.value,
            revalidate: entry.revalidate === true,
          });
        }
        trim();
      } catch {
        // First use, unsupported schema, or corrupt cache: fetch normally.
      }
    },
    scope(scope: string) {
      return {
        version: () => versions.get(scope) ?? 0,
        values<T>(validate: (value: unknown) => value is T): T[] {
          return [...entries.values()]
            .filter((entry) => entry.scope === scope && validTime(entry.savedAt) && validate(entry.value))
            .map((entry) => structuredClone(entry.value) as T);
        },
        get<T>(
          key: string,
          validate: (value: unknown) => value is T
        ): { value: T; savedAt: number; revalidate: boolean } | undefined {
          const entry = entries.get(id(scope, key));
          if (!entry || !validTime(entry.savedAt) || !validate(entry.value)) return;
          return { value: structuredClone(entry.value), savedAt: entry.savedAt, revalidate: entry.revalidate === true };
        },
        set(key: string, value: unknown) {
          const hash = id(scope, key);
          entries.delete(hash);
          entries.set(hash, { scope, key: hash.split(':')[1], savedAt: now(), value: structuredClone(value) });
          persist();
        },
        delete(key: string) {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          entries.delete(id(scope, key));
          persist();
        },
        clear() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const [key, entry] of entries) if (entry.scope === scope) entries.delete(key);
          persist();
        },
        revalidate() {
          versions.set(scope, (versions.get(scope) ?? 0) + 1);
          for (const entry of entries.values()) if (entry.scope === scope) entry.revalidate = true;
          persist();
        },
      };
    },
  };
}

export type GitHubCache = ReturnType<ReturnType<typeof createGitHubCache>['scope']>;
