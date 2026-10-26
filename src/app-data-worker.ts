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
    (db.prepare('SELECT DISTINCT name FROM records').all() as { name: string }[]).map(({ name }) => [name, read(name)])
  );
}
port.on('message', ({ id, method, args }: Request) => {
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
        for (const { name } of db.prepare("SELECT DISTINCT name FROM records WHERE name LIKE 'workbench:%'").all() as {
          name: string;
        }[]) {
          const state = read(name) as Record<string, unknown>;
          const retained = Object.fromEntries(
            ['account', 'credentialKey', 'overrides', 'briefs', 'day', 'used', 'filters']
              .filter((key) => key in state)
              .map((key) => [key, state[key]])
          );
          write(name, { ...retained, subjects: [] });
        }
      });
      result = states();
    } else {
      if (opened) db.close();
    }
    port.postMessage({ id, result });
    if (method === 'close') port.close();
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
