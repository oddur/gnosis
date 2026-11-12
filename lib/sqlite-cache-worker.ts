/** Self-contained worker source keeps packaged ASAR builds independent of source paths. */
export const SQLITE_CACHE_WORKER = String.raw`
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let db;
let file;
const maintenance = {};
let preparedBytes = 512 * 1024 * 1024 - 32_000_000;
let memoryEntryBytes = 1_000_000;
const preparedRetention = 30 * 24 * 60 * 60 * 1000;
function trimPrepared(now) {
  db.prepare('DELETE FROM prepared WHERE saved_at < ? OR saved_at > ?').run(now - preparedRetention, now);
  let bytes = db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM prepared').get().bytes;
  if (bytes > preparedBytes) {
    const remove = db.prepare('DELETE FROM prepared WHERE id=?');
    for (const row of db.prepare('SELECT id,bytes FROM prepared ORDER BY saved_at').iterate()) {
      if (bytes <= preparedBytes) break;
      remove.run(row.id); bytes -= row.bytes;
    }
  }
}
// Space reclaim. src/sqlite-maintain.ts holds the same steps for saved work; keep the two in step.
const MB = 1024 * 1024;
function pragma(name) { return Number(Object.values(db.prepare('PRAGMA ' + name).get() ?? {})[0] ?? 0); }
function fileSize(name) { try { return fs.statSync(name).size; } catch { return 0; } }
function maintain(idleSeconds) {
  let more = false, vacuumed = false;
  const pageSize = pragma('page_size');
  if (pragma('auto_vacuum') !== 2) {
    // Converting copies the whole cache, so it waits until the user has been away for a minute.
    if (!maintenance.vacuumSkipped && idleSeconds >= 60) {
      const live = (pragma('page_count') - pragma('freelist_count')) * pageSize;
      try {
        const stats = fs.statfsSync(path.dirname(file));
        if (stats.bavail * stats.bsize < 2 * live + 256 * MB) {
          maintenance.vacuumSkipped = true;
          console.warn('Not compacting the GitHub cache: it needs ' + Math.ceil((2 * live + 256 * MB) / MB) + ' MB free disk space.');
        } else {
          db.exec('PRAGMA auto_vacuum=INCREMENTAL'); db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          vacuumed = more = true;
        }
      } catch (error) {
        maintenance.vacuumSkipped = true;
        console.warn('Could not compact the GitHub cache:', error.message);
      }
    }
  } else {
    const free = pragma('freelist_count') * pageSize;
    if (free >= 16 * MB || (maintenance.draining && free > 4 * MB)) {
      db.exec('PRAGMA incremental_vacuum(2000)');
      maintenance.draining = pragma('freelist_count') * pageSize > 4 * MB;
      more = maintenance.draining;
    } else maintenance.draining = false;
  }
  if (fileSize(file + '-wal') > 16 * MB) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { more, fileBytes: fileSize(file) + fileSize(file + '-wal'), freeBytes: pragma('freelist_count') * pageSize, ...(vacuumed ? { vacuumed } : {}) };
}
parentPort.on('message', ({ id, method, args }) => {
  try {
    let result;
    if (method === 'open') {
      const { legacy, now, maxBytes, maxEntryBytes, maxEntries, retention } = args;
      file = args.file;
      const started = performance.now();
      preparedBytes = args.preparedBytes ?? preparedBytes;
      memoryEntryBytes = maxEntryBytes;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = new DatabaseSync(file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      // New files start in incremental mode. An existing file keeps its mode until 'maintain' converts it.
      db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=16777216; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS prepared (id TEXT PRIMARY KEY, payload TEXT NOT NULL, saved_at INTEGER NOT NULL, bytes INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS prepared_age ON prepared(saved_at)');
      // Trimming reads every prepared row until prepared_size exists, so it waits for 'prepared-limit' after startup.
      const schema = performance.now() - started;
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
      // Validate here, but send payloads as strings: main parses each value only when it is first read.
      const entries = db.prepare('SELECT id,payload FROM cache').all().flatMap(row => {
        try {
          const entry = JSON.parse(row.payload), size = Buffer.byteLength(row.payload);
          if (!entry || typeof entry !== 'object' || !/^[a-f0-9]{64}$/.test(entry.scope) ||
            !/^[a-f0-9]{64}$/.test(entry.key) || row.id !== entry.scope + ':' + entry.key ||
            !Number.isFinite(entry.savedAt) || entry.savedAt > now || now - entry.savedAt >= retention ||
            !('value' in entry) || size > maxEntryBytes) throw new Error('Invalid cache entry');
          return [{ id: row.id, scope: entry.scope, savedAt: entry.savedAt, revalidate: entry.revalidate === true, size, payload: row.payload }];
        } catch { remove.run(row.id); return []; }
      }).sort((a,b) => a.savedAt - b.savedAt);
      result = { entries, ms: { schema: Math.round(schema), select: Math.round(performance.now() - started - schema) } };
    } else if (method === 'prepared-limit') {
      // Size sums then read only this index instead of every prepared payload.
      db.exec('CREATE INDEX IF NOT EXISTS prepared_size ON prepared(saved_at, bytes)');
      preparedBytes = args.bytes; trimPrepared(args.now);
    } else if (method === 'prepared-read') {
      const row = db.prepare('SELECT payload,saved_at FROM prepared WHERE id=?').get(args.id);
      if (row && row.saved_at <= args.now && args.now - row.saved_at < preparedRetention) result = JSON.parse(row.payload);
    } else if (method === 'write') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const put = db.prepare('INSERT OR REPLACE INTO cache(id,payload) VALUES (?,?)');
        const remove = db.prepare('DELETE FROM cache WHERE id=?');
        const revalidate = db.prepare("UPDATE cache SET payload=json_set(payload,'$.revalidate',json('true')) WHERE id=?");
        const prepare = db.prepare('INSERT OR REPLACE INTO prepared(id,payload,saved_at,bytes) VALUES (?,?,?,?)');
        let prepared = false;
        for (const operation of args.operations) {
          if (operation.deletePrepared) {
            db.prepare('DELETE FROM prepared WHERE id=?').run(operation.id);
            continue;
          }
          if (operation.clearPrepared) {
            db.prepare('DELETE FROM prepared WHERE id LIKE ?').run(operation.id + ':%');
            continue;
          }
          if (operation.prepared && operation.payload) {
            const entry = JSON.parse(operation.payload);
            prepare.run(operation.id, operation.payload, entry.savedAt, Buffer.byteLength(operation.payload));
            prepared = true;
          }
          if (operation.onlyPrepared) continue;
          if (operation.revalidate) revalidate.run(operation.id);
          else if (operation.payload === null) remove.run(operation.id);
          else if (operation.prepared && Buffer.byteLength(operation.payload) > memoryEntryBytes) remove.run(operation.id);
          else put.run(operation.id, operation.payload);
        }
        // Restored hot entries retain their original age; they must not move the clock backwards.
        if (prepared) trimPrepared(args.now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } else if (method === 'maintain') {
      result = maintain(args.idleSeconds);
    } else if (method === 'close') { db?.close(); db = undefined; }
    else throw new Error('Unknown cache storage operation');
    parentPort.postMessage({ id, result });
    if (method === 'close') parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
`;
