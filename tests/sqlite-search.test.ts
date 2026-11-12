import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqliteSearchIndex, SEARCH_MAX_DOCUMENTS } from '../src/sqlite-search-index';
import { searchDocuments, type SearchDocument } from '../lib/command-search';
const docs: SearchDocument[] = [
  {
    id: 'pr',
    kind: 'pr',
    title: 'Release queue slots',
    text: 'Cancellation releases acquired slots',
    source: 'acme/core #42',
    author: 'maya',
    groupId: 'g',
    groupTitle: 'Queue',
    destination: { kind: 'home', url: 'https://github.com/acme/core/pull/42' },
  },
  {
    id: 'file',
    kind: 'file',
    title: 'src/queue.ts',
    text: '+ semaphore.release();\nvalue="quoted";\nfoo_bar',
    code: '+ semaphore.release();',
    source: 'acme/core #42',
    groupId: 'g',
    groupTitle: 'Queue',
    destination: { kind: 'review', reviewId: 'saved', filePath: 'src/queue.ts' },
  },
  {
    id: 'bot',
    kind: 'pr',
    title: 'Update queue package',
    text: 'Dependabot version',
    source: 'acme/core #43',
    bot: true,
    groupId: 'b',
    groupTitle: 'Bot',
    destination: { kind: 'activity' },
  },
];
const ask = (query: string, includeBots = false, recentIds: string[] = [], extra = {}) => ({
  account: 'alice', query, includeBots, recentIds, muted: [] as string[], ignoreBots: true, ...extra,
});
const put = (index: ReturnType<typeof createSqliteSearchIndex>, account: string, documents: SearchDocument[], feed = 'review:a', pinned = false) =>
  index.apply(account, [{ feed, hash: JSON.stringify(documents), usedAt: 1, pinned, docs: documents }]);
// The worker returns each hit's snippet as its text, without code.
const visible = (hits: ReturnType<typeof searchDocuments>) =>
  hits.map((hit) => ({ ...hit, document: { ...hit.document, text: hit.snippet, code: undefined } }));
void test('FTS matches existing substring, code, fuzzy title, number and bot behavior', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    put(index, 'alice', docs);
    for (const query of ['semaphore.release', 'release', 'queue slots', 'rqslots', '#42', 'acme/core#42', 'maya', 're', '"quoted"', 'foo_bar', 'slots OR release', 'nonexistent']) {
      for (const bots of [true, false])
        assert.deepEqual(index.search(ask(query, bots, [], { ignoreBots: false })).hits, visible(searchDocuments(docs.map((d) => d.bot ? { ...d, botHidden: false } : d), query, bots)), query);
    }
    assert.equal(index.search({ ...ask('queue', true), account: 'bob' }).hits.length, 0);
    assert.equal(index.search(ask('', false, ['file'])).hits[0].document.id, 'file');
  } finally {
    db.close();
  }
});
void test('replacing a feed leaves no ghost matches, and accounts stay separate', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    put(index, 'alice', docs);
    put(index, 'alice', [{ ...docs[0], text: 'New unique body' }]);
    assert.equal(index.search(ask('semaphore', true)).hits.length, 0);
    assert.equal(index.search(ask('unique', true)).hits.length, 1);
    put(index, 'bob', docs);
    index.apply('alice', [{ feed: 'review:a', remove: true }]);
    assert.equal(index.search(ask('queue', true)).hits.length, 0);
    assert.deepEqual(index.feeds('alice'), []);
    assert.ok(index.search({ ...ask('queue', true), account: 'bob' }).hits.length > 0);
  } finally {
    db.close();
  }
});

void test('a full index searches within a bounded heap', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-memory-'));
  try {
    for (const mode of ['remove', 'empty', 'broad']) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--max-old-space-size=96', '--import', 'tsx', path.resolve('tests/fixtures/search-memory.ts'), path.join(directory, `${mode}.sqlite`), mode],
        { timeout: 60000, maxBuffer: 100_000 }
      );
      assert.match(stdout, /bounded search memory passed/, mode);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

void test('paged searches retain ranking, exact totals, bots and recent destinations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    const many = Array.from({ length: 180 }, (_, i) => ({ ...docs[i % docs.length], id: String(i), title: `queue ${i}`, bot: i % 5 === 0 }));
    put(index, 'alice', many);
    for (const query of ['queue', 'qu', 'qq', '#42']) {
      for (const bots of [false, true]) {
        const expected = searchDocuments(many.map((d) => (d.bot ? { ...d, botHidden: true } : d)), query, bots);
        const actual = index.search(ask(query, bots), 7);
        assert.equal(actual.total, expected.length);
        assert.deepEqual(actual.hits.map((h) => h.document.id), expected.slice(0, 7).map((h) => h.document.id));
      }
    }
    const recent = index.search(ask('', true, ['179', '178']), 1);
    assert.equal(recent.hits[0].document.id, '179');
    assert.ok(recent.total > recent.hits.length);
  } finally {
    db.close();
  }
});

void test('SQLite search applies repository-specific bot visibility at query time', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    put(index, 'alice', docs);
    for (const query of ['', 'queue'])
      assert.ok(index.search(ask(query, false, [], { repositoryBotSettings: { 'acme/core': false } })).hits.some((h) => h.document.id === 'bot'));
    assert.ok(!index.search(ask('queue')).hits.some((h) => h.document.id === 'bot'));
    assert.ok(index.search(ask('queue', true)).hits.some((h) => h.document.id === 'bot'));
  } finally {
    db.close();
  }
});

void test('evicts the oldest unpinned documents above the cap and never queue documents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    const make = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ ...docs[0], id: `${prefix}:${i}` }));
    index.apply('alice', [{ feed: 'queue:q', hash: 'q', usedAt: 0, pinned: true, docs: make('q', 100) }]);
    let evicted = 0;
    for (let feed = 0; feed < 13; feed++)
      evicted += index.apply('alice', [{ feed: `review:${feed}`, hash: 'h', usedAt: 1000 + feed, pinned: false, docs: make(`r${feed}`, 500) }]).evicted;
    const count = (where: string) => Number(db.prepare(`SELECT count(*) AS n FROM search_docs WHERE ${where}`).get()?.n);
    assert.equal(count('1'), SEARCH_MAX_DOCUMENTS);
    assert.equal(evicted, 100 + 13 * 500 - SEARCH_MAX_DOCUMENTS);
    assert.equal(count('pinned=1'), 100);
    assert.equal(count("feed='review:0'"), 0, 'the oldest feed goes first');
    assert.equal(count("feed='review:12'"), 500);
    assert.equal(index.feeds('alice').length, 14, 'evicted feeds keep their hash');
    assert.equal(count("account='bob'"), 0);
  } finally {
    db.close();
  }
});
