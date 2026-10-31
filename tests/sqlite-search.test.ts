import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqliteSearchIndex } from '../src/sqlite-search-index';
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
void test('FTS matches existing substring, code, fuzzy title, number and bot behavior', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    index.replace('alice', docs);
    for (const query of [
      'semaphore.release',
      'release',
      'queue slots',
      'rqslots',
      '#42',
      'acme/core#42',
      'maya',
      're',
      '"quoted"',
      'foo_bar',
      'slots OR release',
      'nonexistent',
    ]) {
      for (const bots of [true, false])
        assert.deepEqual(index.search('alice', query, bots, []).hits, searchDocuments(docs, query, bots), query);
    }
    assert.equal(index.search('bob', 'queue', true, []).hits.length, 0);
    assert.equal(index.search('alice', '', false, ['file']).hits[0].document.id, 'file');
  } finally {
    db.close();
  }
});
void test('unchanged index documents cause no writes; updates and deletions do not leave ghost matches', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    index.replace('alice', docs);
    const changes = () => db.prepare('SELECT total_changes() AS n').get()?.n;
    const before = changes();
    index.replace('alice', docs);
    assert.equal(changes(), before);
    index.replace('alice', [{ ...docs[0], text: 'New unique body' }]);
    assert.equal(index.search('alice', 'semaphore', true, []).hits.length, 0);
    assert.equal(index.search('alice', 'unique', true, []).hits.length, 1);
    index.replace('bob', docs);
    index.replace('alice', []);
    assert.equal(index.search('alice', 'queue', true, []).hits.length, 0);
    assert.ok(index.search('bob', 'queue', true, []).hits.length > 0);
  } finally {
    db.close();
  }
});

void test('large legacy indexes update and search within a bounded heap', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-memory-'));
  try {
    for (const mode of ['replace', 'empty', 'broad']) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--max-old-space-size=96',
          '--import',
          'tsx',
          path.resolve('tests/fixtures/search-memory.ts'),
          path.join(directory, `${mode}.sqlite`),
          mode,
        ],
        { timeout: 30000, maxBuffer: 100_000 }
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
    const many = Array.from({ length: 180 }, (_, i) => ({
      ...docs[i % docs.length],
      id: String(i),
      title: `queue ${i}`,
      bot: i % 5 === 0,
    }));
    index.replace('alice', many);
    for (const query of ['queue', 'qu', 'qq', '#42']) {
      for (const bots of [false, true]) {
        const expected = searchDocuments(many, query, bots);
        const actual = index.search('alice', query, bots, [], 7);
        assert.equal(actual.total, expected.length);
        assert.deepEqual(actual.hits, expected.slice(0, 7));
      }
    }
    const recent = index.search('alice', '', true, ['179', '178'], 1);
    assert.equal(recent.hits[0].document.id, '179');
    assert.ok(recent.total > recent.hits.length);
  } finally {
    db.close();
  }
});

void test('SQLite and in-memory search agree on repository-specific bot visibility', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    const visible = docs.map(d => d.bot ? { ...d, botHidden: false } : d);
    index.replace('alice', visible);
    for (const query of ['', 'queue']) {
      const hits = index.search('alice', query, false, []).hits;
      assert.ok(hits.some(h => h.document.id === 'bot'));
    }
    index.replace('alice', docs.map(d => d.bot ? { ...d, botHidden: true } : d));
    assert.ok(!index.search('alice', 'queue', false, []).hits.some(h => h.document.id === 'bot'));
    assert.ok(index.search('alice', 'queue', true, []).hits.some(h => h.document.id === 'bot'));
  } finally { db.close(); }
});
