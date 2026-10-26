/** Self-contained worker source keeps packaged ASAR builds independent of source paths. */
export const SQLITE_CACHE_WORKER = String.raw`
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let db;
parentPort.on('message', ({ id, method, args }) => {
  try {
    let result;
    if (method === 'open') {
      const { file, legacy, now, maxBytes, maxEntryBytes, maxEntries, retention } = args;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = new DatabaseSync(file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      if (!db.prepare("SELECT value FROM metadata WHERE key='legacy-imported'").get()) {
        let entries = [];
        try {
          if (fs.statSync(legacy).size <= maxBytes + 100000) {
            const saved = JSON.parse(fs.readFileSync(legacy, 'utf8'));
            if (saved.version === 1 && Array.isArray(saved.entries)) entries = saved.entries;
          }
        } catch (error) { if (error.code !== 'ENOENT') console.warn('Ignoring unreadable legacy GitHub cache'); }
        db.exec('BEGIN IMMEDIATE');
        try {
          const put = db.prepare('INSERT OR REPLACE INTO cache(id,payload) VALUES (?,?)');
          let bytes = 0, count = 0;
          for (const entry of entries.slice().reverse()) {
            if (!entry || !/^[a-f0-9]{64}$/.test(entry.scope) || !/^[a-f0-9]{64}$/.test(entry.key) ||
              !Number.isFinite(entry.savedAt) || entry.savedAt > now || now - entry.savedAt >= retention || !('value' in entry)) continue;
            const payload = JSON.stringify(entry), size = Buffer.byteLength(payload);
            if (size > maxEntryBytes || bytes + size > maxBytes || count >= maxEntries) continue;
            put.run(entry.scope + ':' + entry.key, payload); bytes += size; count++;
          }
          db.prepare("INSERT INTO metadata VALUES ('legacy-imported','1')").run();
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const remove = db.prepare('DELETE FROM cache WHERE id=?');
      result = db.prepare('SELECT id,payload FROM cache').all().flatMap(row => {
        try {
          const entry = JSON.parse(row.payload), size = Buffer.byteLength(row.payload);
          if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.scope) ||
            !/^[a-f0-9]{64}$/.test(entry.key) || row.id !== entry.scope + ':' + entry.key ||
            !Number.isFinite(entry.savedAt) || entry.savedAt > now || now - entry.savedAt >= retention ||
            !('value' in entry) || size > maxEntryBytes) throw new Error('Invalid cache entry');
          return [{ entry, size }];
        } catch { remove.run(row.id); return []; }
      }).sort((a,b) => a.entry.savedAt - b.entry.savedAt);
    } else if (method === 'write') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const put = db.prepare('INSERT OR REPLACE INTO cache(id,payload) VALUES (?,?)');
        const remove = db.prepare('DELETE FROM cache WHERE id=?');
        const revalidate = db.prepare("UPDATE cache SET payload=json_set(payload,'$.revalidate',json('true')) WHERE id=?");
        for (const operation of args) {
          if (operation.revalidate) revalidate.run(operation.id);
          else if (operation.payload === null) remove.run(operation.id);
          else put.run(operation.id, operation.payload);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (method === 'close') { db?.close(); db = undefined; }
    else throw new Error('Unknown cache storage operation');
    parentPort.postMessage({ id, result });
    if (method === 'close') parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
`;
