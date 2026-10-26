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
