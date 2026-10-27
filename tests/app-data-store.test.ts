import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAppDataStore } from '../src/app-data-store';
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

test('clearing GitHub data removes derived search rows without deleting review progress', async () => {
  const dir = fixture(),
    store = createAppDataStore();
  try {
    await store.open(dir);
    await store.search({
      account: 'alice',
      query: 'cached',
      includeBots: false,
      recentIds: [],
      muted: [],
      ignoreBots: true,
      input: {
        directory: dir,
        account: 'alice',
        queue: { items: [], warnings: [], remaining: 0 },
        history: [],
        muted: [],
        ignoreBots: true,
        threads: {},
        cachedResponses: [
          {
            url: 'https://api.github.com/repos/o/r/pulls/1',
            data: { title: 'cached PR', body: 'private description', user: { login: 'alice' } },
          },
        ],
      },
    });
    const db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    assert.ok(Number(db.prepare('SELECT count(*) AS n FROM search_documents').get()?.n) > 0);
    db.prepare('INSERT INTO search_subjects(account,id,payload) VALUES(?,?,?)').run('alice', 'stack', '{}');
    await store.saveFileProgress({ aliases: {}, marks: { reviewed: true } });
    await store.clearGitHub();
    assert.equal(db.prepare('SELECT count(*) AS n FROM search_documents').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM search_subjects').get()?.n, 0);
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
