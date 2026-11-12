import {
  FILE_PROGRESS_KEY,
  isReviewStateKey,
  type FileProgressPatch,
  type ReviewStateWrite,
} from '../lib/review-state';
import {
  SEARCH_INDEX_MIGRATION,
  clearSearchIndex,
  createSqliteSearchIndex,
  dropLegacySearchIndex,
  type SqliteSearchIndex,
} from './sqlite-search-index';
import { maintainDatabase, type MaintainState } from './sqlite-maintain';
import type { LocalSearchResponse, SearchOp, SearchRequest } from './command-search-service';
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const port = parentPort;
if (!port) throw new Error('Storage must run in a worker');
let opened = false;
let db: DatabaseSync;
let file = '';
const maintenance: MaintainState = {};
type Request = { id: number } & (
  | { method: 'open'; args: { directory: string } }
  | { method: 'write'; args: { states: [string, unknown][]; patches: [string, unknown][] } }
  | { method: 'close' | 'clear-github'; args?: undefined }
  | { method: 'search'; args: SearchRequest }
  | { method: 'search-feeds'; args: { account: string } }
  | { method: 'search-apply'; args: { account: string; ops: SearchOp[] } }
  | { method: 'maintain'; args: { idleSeconds: number } }
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
/** States saved as a header row plus one `entry:<id>` row per entry, read as `{ ...header, entries }`. */
const rowState = (name: string) => /^(?:pr-read-|muted-prs:|starred-prs:)/.test(name);
/** The row states that accept patches: unread progress, mutes and stars. */
const patchable = /^(?:pr-read-[a-f0-9]{64}\.json|(?:muted|starred)-prs:[a-f0-9]{64})$/;
/** Separate queue subjects, briefings, unread receipts, mutes and stars into independently updated rows. */
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
  } else if (rowState(name)) {
    if (!record(value.entries)) throw new Error(`Invalid saved entries: ${name}`);
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
  } else if (rowState(name)) {
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
/** Changes only the listed rows. The header row is created when missing. */
function patch(name: string, change: unknown) {
  if (!patchable.test(name) || !record(change)) throw new Error(`Invalid saved change: ${name}`);
  const { header, put = [], remove = [] } = change;
  if ((header !== undefined && !record(header)) || !Array.isArray(put) || !Array.isArray(remove))
    throw new Error(`Invalid saved change: ${name}`);
  const upsert = db.prepare(
    'INSERT INTO records(name,id,payload) VALUES(?,?,?) ON CONFLICT(name,id) DO UPDATE SET payload=excluded.payload'
  );
  if (header) upsert.run(name, 'header', JSON.stringify(header));
  else db.prepare("INSERT OR IGNORE INTO records(name,id,payload) VALUES(?,'header','{}')").run(name);
  for (const row of put as unknown[]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || row[1] === undefined) throw new Error(`Invalid saved entry: ${name}`);
    upsert.run(name, 'entry:' + row[0], JSON.stringify(row[1]));
  }
  const drop = db.prepare('DELETE FROM records WHERE name=? AND id=?');
  for (const id of remove as unknown[]) {
    if (typeof id !== 'string') throw new Error(`Invalid saved entry: ${name}`);
    drop.run(name, 'entry:' + id);
  }
}
/**
 * Imports muted PRs, starred PRs and saved views from their JSON files. An unreadable file is skipped and
 * left in place. Imported files are renamed to `*.json.migrated` after the commit and kept as backups:
 * muted PR descriptions cannot be downloaded again.
 */
function importLegacyStores(directory: string) {
  const imported: string[] = [];
  transaction(() => {
    for (const file of fs.readdirSync(directory)) {
      const match = /^(muted-prs|starred-prs|queue-views)-([a-f0-9]{64})\.json$/.exec(file);
      if (!match) continue;
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      } catch (error) {
        console.warn(`Could not import ${file}. It has been left in place:`, error instanceof Error ? error.message : error);
        continue;
      }
      const name = `${match[1]}:${match[2]}`;
      if (match[1] === 'queue-views') {
        if (!record(value)) {
          console.warn(`Could not import ${file}. It has been left in place.`);
          continue;
        }
        write(name, value);
      } else {
        if (!Array.isArray(value)) {
          console.warn(`Could not import ${file}. It has been left in place.`);
          continue;
        }
        // Structure only; the stores validate members when they load. `seq` keeps the saved order.
        const entries = new Map<string, Record<string, unknown>>();
        value.forEach((entry: unknown, index) => {
          if (!record(entry) || !record(entry.member) || typeof entry.member.url !== 'string') return;
          const url = entry.member.url;
          entries.set(url, { ...entry, seq: entries.get(url)?.seq ?? index });
        });
        write(name, { entries: Object.fromEntries(entries) });
      }
      imported.push(file);
    }
    db.prepare('INSERT INTO migrations VALUES (?)').run('legacy-stores-v1');
  });
  // After the commit. A crash before the rename is harmless: the migration never runs again.
  for (const file of imported) {
    const source = path.join(directory, file);
    try {
      fs.renameSync(source, source + '.migrated');
    } catch (error) {
      console.warn(`Could not rename ${file} after importing it:`, error instanceof Error ? error.message : error);
    }
  }
}
function states() {
  return Object.fromEntries(
    (db.prepare("SELECT DISTINCT name FROM records WHERE name NOT LIKE 'renderer:%'").all() as { name: string }[]).map(
      ({ name }) => [name, read(name)]
    )
  );
}
let searchIndex: SqliteSearchIndex | undefined;
/** Created on first use: `open` never touches the search tables. */
const search = () => (searchIndex ??= createSqliteSearchIndex(db));
let chain = Promise.resolve();
port.on('message', (request: Request) => {
  chain = chain.then(() => {
    const { id, method, args } = request;
    try {
      let result: unknown;
      if (method === 'open') {
        fs.mkdirSync(args.directory, { recursive: true });
        file = path.join(args.directory, 'workbench.sqlite');
        db = new DatabaseSync(file);
        opened = true;
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
        // New files start in incremental mode. An existing file keeps its mode until `maintain` converts it.
        db.exec(
          'PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=16777216; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS records (name TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(name,id)); CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)'
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
        if (!db.prepare('SELECT id FROM migrations WHERE id=?').get('legacy-stores-v1')) importLegacyStores(args.directory);
        result = states();
      } else if (method === 'write') {
        transaction(() => {
          for (const [name, value] of args.states) write(name, value);
          for (const [name, change] of args.patches) patch(name, change);
        });
      } else if (method === 'clear-github') {
        transaction(() => {
          // Search also contains derived GitHub text; it can be rebuilt from surviving saved reviews.
          clearSearchIndex(db);
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
        searchIndex = undefined;
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
        const found = search().search(args);
        result = {
          account: args.account,
          ...found,
          ignoreBots: args.ignoreBots || Object.values(args.repositoryBotSettings ?? {}).some(Boolean),
        } satisfies LocalSearchResponse;
      } else if (method === 'search-feeds') {
        result = { feeds: search().feeds(args.account) };
      } else if (method === 'search-apply') {
        result = search().apply(args.account, args.ops);
      } else if (method === 'maintain') {
        // One bounded step per request, so saved-work writes queue behind at most one step.
        if (!db.prepare('SELECT id FROM migrations WHERE id=?').get(SEARCH_INDEX_MIGRATION)) {
          transaction(() => {
            dropLegacySearchIndex(db);
            db.prepare('INSERT INTO migrations VALUES (?)').run(SEARCH_INDEX_MIGRATION);
          });
          result = { more: true, fileBytes: 0, freeBytes: 0 };
        } else result = maintainDatabase(db, file, { idleSeconds: args.idleSeconds, label: 'saved work' }, maintenance);
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
