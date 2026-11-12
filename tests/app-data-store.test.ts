import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAppDataStore } from '../src/app-data-store';
import { httpDocuments } from '../src/command-search-service';
import { maintainDatabase } from '../src/sqlite-maintain';
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-state-'));
const queue = (account = 'alice') => ({
  account,
  subjects: [
    { id: 'one', title: 'One' },
    { id: 'two', title: 'Two' },
  ],
  briefs: { brief: { summary: 'Keep this briefing' } },
  overrides: [],
  day: '',
  used: 0,
});
test('legacy queue migrates once; incremental rows survive restart and cache clearing preserves user data', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify(queue()));
    await store.open(dir);
    assert.deepEqual(store.read('workbench:alice'), queue());
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    db.exec(
      'CREATE TABLE audit (id TEXT); CREATE TRIGGER changed AFTER INSERT ON records BEGIN INSERT INTO audit VALUES(new.id); END'
    );
    const next = queue();
    next.subjects[1].title = 'Changed';
    store.write('workbench:alice', next);
    await store.flush();
    assert.deepEqual(
      db
        .prepare('SELECT id FROM audit')
        .all()
        .map((row) => row.id),
      ['subject:two']
    );
    db.close();
    store.write('workbench:bob', queue('bob'));
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual(store.read('workbench:alice'), next);
    assert.equal((store.read('workbench:bob') as { account: string }).account, 'bob');
    await store.clearGitHub();
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    const cleared = store.read('workbench:alice') as ReturnType<typeof queue>;
    assert.deepEqual(cleared.subjects, []);
    assert.deepEqual(cleared.briefs, next.briefs);
    assert.equal(fs.existsSync(path.join(dir, 'workbench.json')), true, 'legacy source remains as a backup');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('failed legacy migration rolls back and leaves original data untouched', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    const file = path.join(dir, 'workbench.json');
    fs.writeFileSync(file, 'corrupt');
    await assert.rejects(store.open(dir));
    assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt');
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrations').get()?.n, 0);
    db.close();
  } finally {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('writes do not use synchronous filesystem operations on the host thread', async (t) => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    await store.open(dir);
    const writes = t.mock.method(fs, 'writeFileSync');
    for (let i = 0; i < 25; i++) store.write('workbench:alice', { ...queue(), used: i });
    await store.flush();
    assert.equal(writes.mock.callCount(), 0);
    assert.equal((store.read('workbench:alice') as ReturnType<typeof queue>).used, 24);
  } finally {
    t.mock.restoreAll();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser drafts and file progress import once and survive edits, deletion, clearing and restart', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  const key = 'gnosis-changes-drafts:alice:https://github.com/o/r/pull/1';
  const local = 'gnosis-changes-drafts:local:local:/working-copy';
  const draft = { id: 'note', body: 'Keep this note', headSha: 'head', baseSha: 'base', baseBranch: 'main' };
  const legacy = {
    [key]: JSON.stringify([draft]),
    [local]: JSON.stringify([{ ...draft, id: 'local' }]),
    'gnosis-file-progress:v1': JSON.stringify({ aliases: { revision: 'content' }, marks: { content: true } }),
  };
  try {
    await store.open(dir);
    const imported = await store.loadReviewState(legacy);
    assert.deepEqual(imported[key], [draft]);
    await store.saveReviewState({ key, value: [] });
    await store.saveFileProgress({
      aliases: { otherRevision: 'otherContent' },
      marks: { content: false, otherContent: true },
    });
    await store.clearGitHub();
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    const restored = await store.loadReviewState(legacy);
    assert.deepEqual(restored[key], [], 'old browser copies must not resurrect deleted drafts');
    assert.deepEqual(restored[local], [{ ...draft, id: 'local' }]);
    assert.deepEqual(restored['gnosis-file-progress:v1'], {
      aliases: { revision: 'content', otherRevision: 'otherContent' },
      marks: { content: false, otherContent: true },
    });
    await assert.rejects(store.saveReviewState({ key: 'unrelated-app-data', value: {} }), /Invalid/);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('a malformed browser import rolls back as a unit and can be retried', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    await store.open(dir);
    await assert.rejects(store.loadReviewState({ 'gnosis-drafts:valid': '[]', 'gnosis-drafts:bad': 'not json' }));
    const restored = await store.loadReviewState({ 'gnosis-drafts:valid': '[{"body":"recovered"}]' });
    assert.deepEqual(restored['gnosis-drafts:valid'], [{ body: 'recovered' }]);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed queue transaction retains the latest snapshot and can be retried', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    await store.open(dir);
    store.write('workbench:alice', queue());
    await store.flush();
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    db.exec(
      "CREATE TRIGGER fail_write BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END"
    );
    const next = { ...queue(), used: 7 };
    store.write('workbench:alice', next);
    await assert.rejects(store.flush(), /simulated disk failure/);
    db.exec('DROP TRIGGER fail_write');
    db.close();
    await store.flush();
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    assert.equal((store.read('workbench:alice') as { used: number }).used, 7);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('clear-github empties the v2 search tables', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    await store.open(dir);
    const docs = httpDocuments({
      url: 'https://api.github.com/repos/o/r/pulls/1',
      data: { title: 'cached PR', body: 'private description', user: { login: 'alice' } },
    });
    await store.searchApply('alice', [{ feed: 'http:x', hash: 'h', usedAt: 1, pinned: false, docs }]);
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    // A profile from before the upgrade still holds the v1 tables until the first maintain.
    db.exec('CREATE TABLE search_documents (id TEXT); INSERT INTO search_documents VALUES (1)');
    assert.equal(db.prepare('SELECT count(*) AS n FROM search_docs').get()?.n, 1);
    await store.saveFileProgress({ aliases: {}, marks: { reviewed: true } });
    await store.clearGitHub();
    for (const table of ['search_docs', 'search_feeds', 'search_documents'])
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0, table);
    assert.deepEqual(await store.searchFeeds('alice'), []);
    assert.equal(
      ((await store.loadReviewState({}))['gnosis-file-progress:v1'] as { marks: { reviewed: boolean } }).marks.reviewed,
      true
    );
    db.close();
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('search-index-v2 drops the old tables once', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    const seed = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    seed.exec(`CREATE TABLE search_documents (rowid INTEGER PRIMARY KEY, account TEXT, id TEXT, payload TEXT, title TEXT, source TEXT, author TEXT, search_text TEXT);
      CREATE TABLE search_subjects (account TEXT, id TEXT, payload TEXT);
      CREATE VIRTUAL TABLE search_fts USING fts5(search_text, content='search_documents', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
      INSERT INTO search_documents VALUES (1,'a','1','{}','t','s','a','old text')`);
    seed.close();
    await store.open(dir);
    const tables = () => {
      const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
      try {
        return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'search_%' AND type IN ('table','trigger') ORDER BY name").all().map((row) => String(row.name));
      } finally {
        db.close();
      }
    };
    assert.ok(tables().includes('search_documents'), 'open leaves the old tables alone');
    assert.equal((await store.maintain(0)).more, true);
    assert.deepEqual(tables().filter((name) => !name.startsWith('search_docs') && name !== 'search_feeds'), []);
    await store.close();
    // A downgraded build may recreate the v1 tables; the migration does not run again.
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    db.exec('CREATE TABLE search_subjects (account TEXT, id TEXT, payload TEXT)');
    db.close();
    store = createAppDataStore();
    await store.open(dir);
    await store.maintain(0);
    assert.ok(tables().includes('search_subjects'));
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('maintain converts an existing file to incremental auto-vacuum and shrinks it', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  const file = path.join(dir, 'workbench.sqlite');
  try {
    const seed = new DatabaseSync(file);
    seed.exec('PRAGMA journal_mode=WAL; CREATE TABLE search_subjects (account TEXT, id TEXT, payload TEXT)');
    const put = seed.prepare('INSERT INTO search_subjects VALUES (?,?,?)');
    seed.exec('BEGIN');
    for (let i = 0; i < 400; i++) put.run('a', String(i), 'x'.repeat(50_000));
    seed.exec('COMMIT');
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seed.close();
    const before = fs.statSync(file).size;
    assert.ok(before > 15_000_000);
    await store.open(dir);
    let result = await store.maintain(0);
    for (let i = 0; result.more && i < 20; i++) result = await store.maintain(0);
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 2);
    db.close();
    assert.ok(result.fileBytes < before / 4, `${result.fileBytes} < ${before}`);
    assert.ok(fs.statSync(file).size < 2_000_000);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('maintain skips VACUUM when disk space is short', () => {
  const dir = fixture();
  const file = path.join(dir, 'workbench.sqlite');
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (randomblob(100000))');
    const state = {};
    const short = () => 1024;
    assert.equal(maintainDatabase(db, file, { idleSeconds: 0, label: 'saved work' }, state, short).vacuumed, undefined);
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 0);
    let asked = 0;
    maintainDatabase(db, file, { idleSeconds: 0, label: 'saved work' }, state, () => (asked++, 1e12));
    assert.equal(asked, 0, 'skipped for the rest of the session');
    assert.equal(warnings.length, 1, 'logged once');
    assert.equal(maintainDatabase(db, file, { idleSeconds: 0, label: 'saved work' }, {}, () => 1e12).vacuumed, true);
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 2);
    db.close();
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('new saved-work files use incremental auto-vacuum', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    await store.open(dir);
    await store.close();
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const mutedName = `muted-prs:${'1'.repeat(64)}`;
/** Records every row the worker inserts, updates or deletes. */
function audit(dir: string) {
  const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
  db.exec(
    "CREATE TABLE audit (id TEXT); CREATE TRIGGER audit_put AFTER INSERT ON records BEGIN INSERT INTO audit VALUES('put:'||new.id); END; CREATE TRIGGER audit_update AFTER UPDATE ON records BEGIN INSERT INTO audit VALUES('update:'||new.id); END; CREATE TRIGGER audit_delete AFTER DELETE ON records BEGIN INSERT INTO audit VALUES('delete:'||old.id); END"
  );
  return {
    rows: () => (db.prepare('SELECT id FROM audit').all() as { id: string }[]).map((row) => row.id).sort(),
    close: () => {
      db.exec('DROP TRIGGER audit_put; DROP TRIGGER audit_update; DROP TRIGGER audit_delete; DROP TABLE audit');
      db.close();
    },
  };
}
void test('patch writes only the listed rows', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    await store.open(dir);
    store.patch(mutedName, { put: { a: { seq: 0 }, b: { seq: 1 }, c: { seq: 2 } } });
    await store.flush();
    const changes = audit(dir);
    store.patch(mutedName, { put: { b: { seq: 1, title: 'changed' } }, remove: ['c'] });
    await store.flush();
    assert.deepEqual(changes.rows(), ['delete:entry:c', 'update:entry:b']);
    changes.close();
    // Only unread progress, mutes and stars accept row changes.
    store.patch('workbench:alice', { put: { a: 1 } });
    await assert.rejects(store.flush(), /Invalid saved change/);
    await store.close().catch(() => {});
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual(store.take(mutedName), { entries: { a: { seq: 0 }, b: { seq: 1, title: 'changed' } } });
  } finally {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('patches coalesce and survive a failed flush', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    await store.open(dir);
    store.patch(mutedName, { put: { a: { v: 1 }, b: { v: 1 } } });
    store.patch(mutedName, { put: { a: { v: 2 } }, remove: ['b'] });
    await store.flush();
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
    store.patch(mutedName, { put: { a: { v: 3 }, c: { v: 1 } } });
    await assert.rejects(store.flush(), /simulated disk failure/);
    // A newer change to the same row wins over the failed one; other failed rows are kept.
    store.patch(mutedName, { put: { a: { v: 4 } }, remove: ['d'] });
    db.exec('DROP TRIGGER fail_write');
    db.close();
    await store.flush();
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual(store.take(mutedName), { entries: { a: { v: 4 }, c: { v: 1 } } });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('close reports a failed final save and still stops the worker', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    await store.open(dir);
    store.patch('workbench:alice', { put: { a: 1 } }); // rejected by the worker on every flush
    await assert.rejects(store.close(), /Invalid saved change/);
    // The worker is gone, so the database is released (Windows refuses to delete an open file).
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
  } finally {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('take hands over without a copy', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  try {
    await store.open(dir);
    store.patch(mutedName, { put: { a: { v: 1 } } });
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    const read = store.read(mutedName);
    assert.notEqual(read, store.read(mutedName), 'Reads are private copies');
    const taken = store.take(mutedName) as { entries: Record<string, unknown> };
    assert.deepEqual(taken, read);
    assert.equal(store.take(mutedName), undefined, 'The store that took it owns it');
    assert.equal(store.read(mutedName), undefined);
    store.patch(mutedName, { put: { b: { v: 2 } } });
    assert.deepEqual(Object.keys(taken.entries), ['a'], 'Patches never touch a taken state');
    // A GitHub cache reset keeps the rows and does not hand them out again.
    await store.clearGitHub();
    assert.equal(store.take(mutedName), undefined);
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual(store.take(mutedName), { entries: { a: { v: 1 }, b: { v: 2 } } });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const legacyHash = 'a'.repeat(64);
void test('legacy store files import once and are renamed', async () => {
  const dir = fixture();
  const member = (n: number) => ({ url: `https://github.com/o/r/pull/${n}`, description: `Description ${n}` });
  const muted = [
    { member: member(2), mutedAt: 'm2' },
    { member: member(1), mutedAt: 'm1' },
    { member: member(2), mutedAt: 'm2-again' },
    { broken: true },
  ];
  const starred = [{ member: member(3), starredAt: 's3' }];
  const views = { views: [{ id: 'v', name: 'Mine' }], activeId: 'v' };
  fs.writeFileSync(path.join(dir, `muted-prs-${legacyHash}.json`), JSON.stringify(muted));
  fs.writeFileSync(path.join(dir, `starred-prs-${legacyHash}.json`), JSON.stringify(starred));
  fs.writeFileSync(path.join(dir, `queue-views-${legacyHash}.json`), JSON.stringify(views));
  let store = createAppDataStore();
  try {
    await store.open(dir);
    assert.deepEqual(store.read(`muted-prs:${legacyHash}`), {
      entries: {
        [member(2).url]: { member: member(2), mutedAt: 'm2-again', seq: 0 },
        [member(1).url]: { member: member(1), mutedAt: 'm1', seq: 1 },
      },
    });
    assert.deepEqual(store.read(`starred-prs:${legacyHash}`), {
      entries: { [member(3).url]: { member: member(3), starredAt: 's3', seq: 0 } },
    });
    assert.deepEqual(store.read(`queue-views:${legacyHash}`), views);
    for (const name of ['muted-prs', 'starred-prs', 'queue-views']) {
      assert.equal(fs.existsSync(path.join(dir, `${name}-${legacyHash}.json`)), false);
      assert.ok(fs.existsSync(path.join(dir, `${name}-${legacyHash}.json.migrated`)), 'Kept as a backup');
    }
    await store.close();
    // Restoring a file by hand does not import it over newer changes.
    fs.writeFileSync(path.join(dir, `starred-prs-${legacyHash}.json`), JSON.stringify([]));
    store = createAppDataStore();
    await store.open(dir);
    assert.equal(
      Object.keys((store.read(`starred-prs:${legacyHash}`) as { entries: object }).entries).length,
      1
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('an unreadable legacy file is skipped', async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, `muted-prs-${legacyHash}.json`), '{ not json');
  fs.writeFileSync(path.join(dir, `queue-views-${legacyHash}.json`), JSON.stringify(['not', 'views']));
  fs.writeFileSync(path.join(dir, `starred-prs-${legacyHash}.json`), JSON.stringify([]));
  const store = createAppDataStore();
  try {
    await store.open(dir);
    assert.equal(store.read(`muted-prs:${legacyHash}`), undefined);
    assert.equal(store.read(`queue-views:${legacyHash}`), undefined);
    assert.deepEqual(store.read(`starred-prs:${legacyHash}`), { entries: {} });
    assert.equal(
      fs.readFileSync(path.join(dir, `muted-prs-${legacyHash}.json`), 'utf8'),
      '{ not json',
      'Left in place, unchanged'
    );
    assert.ok(fs.existsSync(path.join(dir, `queue-views-${legacyHash}.json`)));
    assert.ok(fs.existsSync(path.join(dir, `starred-prs-${legacyHash}.json.migrated`)));
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('writes made while close runs join the final flush; later ones are counted, not rejected', async () => {
  const dir = fixture();
  let store = createAppDataStore();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    await store.open(dir);
    const key = 'gnosis-explanation-position:quit:reading';
    store.write('workbench:alice', queue());
    const closing = store.close();
    // Quit has started: a renderer save and a main-process write both arrive during the final flush.
    const during = store.saveReviewState({ key, value: { top: 900, left: 0 } });
    store.write('workbench:bob', queue('bob'));
    await Promise.resolve();
    store.patch(mutedName, { put: { one: { at: 1 } } });
    await during;
    await closing;
    assert.equal(store.lostWrites(), 0);
    // After close nothing can reach the database. The caller is not failed; the loss is counted.
    await store.saveReviewState({ key, value: { top: 1, left: 0 } });
    await store.saveFileProgress({ aliases: {}, marks: { late: true } });
    store.write('workbench:carol', queue('carol'));
    assert.equal(store.lostWrites(), 3);
    assert.equal(warnings.length, 3);
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual((await store.loadReviewState({}))[key], { top: 900, left: 0 });
    assert.equal((store.read('workbench:bob') as { account: string }).account, 'bob');
    assert.deepEqual(store.take(mutedName), { entries: { one: { at: 1 } } });
    assert.equal(store.read('workbench:carol'), undefined);
  } finally {
    console.warn = warn;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
