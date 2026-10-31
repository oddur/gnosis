import {
  FILE_PROGRESS_KEY,
  isReviewStateKey,
  type FileProgressPatch,
  type ReviewStateWrite,
} from '../lib/review-state';
import { createSqliteSearchIndex } from './sqlite-search-index';
import { createCommandSearchService, type SearchRequest, type SearchInput } from './command-search-service';
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const port = parentPort;
if (!port) throw new Error('Storage must run in a worker');
let opened = false;
let db: DatabaseSync;
type Request = { id: number } & (
  | { method: 'open'; args: { directory: string } }
  | { method: 'write'; args: [string, unknown][] }
  | { method: 'close' | 'clear-github'; args?: undefined }
  | { method: 'search'; args: SearchRequest }
  | { method: 'review-load'; args: Record<string, string> }
  | { method: 'review-save'; args: ReviewStateWrite }
  | { method: 'progress-save'; args: FileProgressPatch }
);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
/** Separate queue subjects, briefings and unread receipts into independently updated rows. */
function rows(name: string, value: unknown): Map<string, string> {
  if (name.startsWith('renderer:')) {
    const result = new Map<string, string>();
    if (name === 'renderer:' + FILE_PROGRESS_KEY) {
      if (!record(value) || !record(value.aliases) || !record(value.marks)) throw new Error('Invalid file progress');
      result.set('header', '{}');
      for (const [key, v] of Object.entries(value.aliases)) {
        if (typeof v !== 'string') throw new Error('Invalid file alias');
        result.set('alias:' + key, JSON.stringify(v));
      }
      for (const [key, v] of Object.entries(value.marks)) {
        if (typeof v !== 'boolean') throw new Error('Invalid viewed mark');
        result.set('mark:' + key, JSON.stringify(v));
      }
    } else if (name.startsWith('renderer:gnosis-changes-drafts:')) {
      if (!Array.isArray(value)) throw new Error('Invalid saved drafts');
      result.set('header', '{}');
      for (const [index, draft] of value.entries()) {
        if (!record(draft) || typeof draft.id !== 'string') throw new Error('Invalid draft');
        result.set('draft:' + draft.id, JSON.stringify({ index, value: draft }));
      }
    } else result.set('header', JSON.stringify(value));
    return result;
  }
  if (!record(value)) throw new Error(`Invalid saved state: ${name}`);
  const header = { ...value },
    result = new Map<string, string>();
  if (name.startsWith('workbench:')) {
    if (!Array.isArray(value.subjects) || !record(value.briefs)) throw new Error('Invalid saved review queue');
    delete header.subjects;
    delete header.briefs;
    for (const [index, subject] of value.subjects.entries()) {
      if (!record(subject) || typeof subject.id !== 'string') throw new Error('Invalid saved PR');
      result.set('subject:' + subject.id, JSON.stringify({ index, value: subject }));
    }
    for (const [key, brief] of Object.entries(value.briefs)) result.set('brief:' + key, JSON.stringify(brief));
  } else if (name.startsWith('pr-read-')) {
    if (!record(value.entries)) throw new Error('Invalid unread progress');
    delete header.entries;
    for (const [key, entry] of Object.entries(value.entries)) result.set('entry:' + key, JSON.stringify(entry));
  }
  result.set('header', JSON.stringify(header));
  return result;
}
function read(name: string): unknown {
  const saved = db.prepare('SELECT id,payload FROM records WHERE name=?').all(name) as {
    id: string;
    payload: string;
  }[];
  if (!saved.length) return undefined;
  const header = saved.find((row) => row.id === 'header');
  if (!header) throw new Error(`Incomplete saved state: ${name}`);
  const value = JSON.parse(header.payload) as Record<string, unknown>;
  if (name === 'renderer:' + FILE_PROGRESS_KEY) {
    return {
      aliases: Object.fromEntries(
        saved.filter((row) => row.id.startsWith('alias:')).map((row) => [row.id.slice(6), JSON.parse(row.payload)])
      ),
      marks: Object.fromEntries(
        saved.filter((row) => row.id.startsWith('mark:')).map((row) => [row.id.slice(5), JSON.parse(row.payload)])
      ),
    };
  }
  if (name.startsWith('renderer:gnosis-changes-drafts:'))
    return saved
      .filter((row) => row.id.startsWith('draft:'))
      .map((row) => JSON.parse(row.payload) as { index: number; value: unknown })
      .sort((a, b) => a.index - b.index)
      .map((row) => row.value);
  if (name.startsWith('workbench:')) {
    value.subjects = saved
      .filter((row) => row.id.startsWith('subject:'))
      .map((row) => JSON.parse(row.payload) as { index: number; value: unknown })
      .sort((a, b) => a.index - b.index)
      .map((row) => row.value);
    value.briefs = Object.fromEntries(
      saved.filter((row) => row.id.startsWith('brief:')).map((row) => [row.id.slice(6), JSON.parse(row.payload)])
    );
  } else if (name.startsWith('pr-read-')) {
    value.entries = Object.fromEntries(
      saved.filter((row) => row.id.startsWith('entry:')).map((row) => [row.id.slice(6), JSON.parse(row.payload)])
    );
  }
  return value;
}
function write(name: string, value: unknown) {
  const previous = new Map(
    (db.prepare('SELECT id,payload FROM records WHERE name=?').all(name) as { id: string; payload: string }[]).map(
      (row) => [row.id, row.payload]
    )
  );
  const next = rows(name, value);
  const put = db.prepare('INSERT OR REPLACE INTO records(name,id,payload) VALUES (?,?,?)');
  const remove = db.prepare('DELETE FROM records WHERE name=? AND id=?');
  for (const [id, payload] of next) if (previous.get(id) !== payload) put.run(name, id, payload);
  for (const id of previous.keys()) if (!next.has(id)) remove.run(name, id);
}
function states() {
  return Object.fromEntries(
    (db.prepare("SELECT DISTINCT name FROM records WHERE name NOT LIKE 'renderer:%'").all() as { name: string }[]).map(
      ({ name }) => [name, read(name)]
    )
  );
}
let searchInput: SearchInput | undefined;
let searchService: ReturnType<typeof createCommandSearchService> | undefined;
let chain = Promise.resolve();
port.on('message', (request: Request) => {
  chain = chain.then(async () => {
    const { id, method, args } = request;
    try {
      let result: unknown;
      if (method === 'open') {
        fs.mkdirSync(args.directory, { recursive: true });
        const file = path.join(args.directory, 'workbench.sqlite');
        db = new DatabaseSync(file);
        opened = true;
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
        db.exec(
          'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS records (name TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(name,id)); CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)'
        );
        if (!db.prepare('SELECT id FROM migrations WHERE id=?').get('legacy-state-v1'))
          transaction(() => {
            for (const name of fs.readdirSync(args.directory)) {
              if (name !== 'workbench.json' && !/^pr-read-[a-f0-9]{64}\.json$/.test(name)) continue;
              const value: unknown = JSON.parse(fs.readFileSync(path.join(args.directory, name), 'utf8'));
              if (!record(value)) throw new Error(`Could not migrate ${name}. Original data has been kept.`);
              const key = name === 'workbench.json' ? `workbench:${String(value.account).toLowerCase()}` : name;
              write(key, value);
            }
            db.prepare('INSERT INTO migrations VALUES (?)').run('legacy-state-v1');
          });
        result = states();
      } else if (method === 'write') {
        transaction(() => {
          for (const [name, value] of args) write(name, value);
        });
      } else if (method === 'clear-github') {
        transaction(() => {
          // Search also contains derived GitHub text; it can be rebuilt from surviving saved reviews.
          if (db.prepare("SELECT name FROM sqlite_master WHERE name='search_documents'").get())
            db.exec('DELETE FROM search_documents');
          if (db.prepare("SELECT name FROM sqlite_master WHERE name='search_subjects'").get())
            db.exec('DELETE FROM search_subjects');
          for (const { name } of db
            .prepare("SELECT DISTINCT name FROM records WHERE name LIKE 'workbench:%'")
            .all() as {
            name: string;
          }[]) {
            const state = read(name) as Record<string, unknown>;
            const retained = Object.fromEntries(
              ['account', 'credentialKey', 'overrides', 'briefs', 'day', 'used', 'filters', 'stackNames']
                .filter((key) => key in state)
                .map((key) => [key, state[key]])
            );
            write(name, { ...retained, subjects: [] });
          }
        });
        searchService = undefined;
        searchInput = undefined;
        result = states();
      } else if (method === 'review-load') {
        if (!db.prepare('SELECT id FROM migrations WHERE id=?').get('review-state-v1'))
          transaction(() => {
            for (const [key, value] of Object.entries(args)) {
              if (!isReviewStateKey(key) || typeof value !== 'string' || value.length > 32_000_000)
                throw new Error('Invalid saved review data');
              if (!db.prepare('SELECT id FROM records WHERE name=? LIMIT 1').get('renderer:' + key))
                write('renderer:' + key, JSON.parse(value));
            }
            db.prepare('INSERT INTO migrations VALUES (?)').run('review-state-v1');
          });
        result = Object.fromEntries(
          (
            db.prepare("SELECT DISTINCT name FROM records WHERE name LIKE 'renderer:%'").all() as { name: string }[]
          ).map(({ name }) => [name.slice(9), read(name)])
        );
      } else if (method === 'review-save') {
        if (!isReviewStateKey(args.key) || JSON.stringify(args.value).length > 32_000_000)
          throw new Error('Invalid review data');
        transaction(() => {
          if (args.value === null) db.prepare('DELETE FROM records WHERE name=?').run('renderer:' + args.key);
          else write('renderer:' + args.key, args.value);
        });
      } else if (method === 'progress-save') {
        if (
          !record(args.aliases) ||
          !record(args.marks) ||
          Object.keys(args.aliases).length > 10000 ||
          Object.keys(args.marks).length > 10000
        )
          throw new Error('Invalid file progress');
        transaction(() => {
          const name = 'renderer:' + FILE_PROGRESS_KEY;
          db.prepare("INSERT OR IGNORE INTO records(name,id,payload) VALUES(?,'header','{}')").run(name);
          const put = db.prepare(
            'INSERT INTO records(name,id,payload) VALUES(?,?,?) ON CONFLICT(name,id) DO UPDATE SET payload=excluded.payload'
          );
          for (const [key, value] of Object.entries(args.aliases)) {
            if (key.length > 10000 || typeof value !== 'string' || value.length > 10000)
              throw new Error('Invalid file alias');
            put.run(name, 'alias:' + key, JSON.stringify(value));
          }
          for (const [key, value] of Object.entries(args.marks)) {
            if (key.length > 10000 || typeof value !== 'boolean') throw new Error('Invalid viewed mark');
            put.run(name, 'mark:' + key, JSON.stringify(value));
          }
        });
      } else if (method === 'search') {
        if (args.input) searchInput = args.input;
        if (!searchInput || searchInput.account !== args.account)
          throw new Error('Search index is not ready for this account');
        searchInput.muted = args.muted;
        searchInput.ignoreBots = args.ignoreBots;
        searchInput.repositoryBotSettings = args.repositoryBotSettings;
        const current = () => {
          if (!searchInput) throw new Error('Search data unavailable');
          return searchInput;
        };
        if (!searchService)
          searchService = createCommandSearchService({
            index: createSqliteSearchIndex(db),
            directory: () => current().directory,
            queue: () => current().queue,
            history: () => current().history,
            account: () => current().account,
            ignoreBots: () => current().ignoreBots,
            repositoryBotSettings: () => current().repositoryBotSettings ?? {},
            mutedUrls: () => new Set(current().muted),
            cachedResponses: () => current().cachedResponses,
            threads: (url) => current().threads[url],
          });
        result = await searchService.search(args.query, args.includeBots, args.recentIds);
      } else {
        if (opened) db.close();
      }
      port.postMessage({ id, result });
      if (method === 'close') port.close();
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
