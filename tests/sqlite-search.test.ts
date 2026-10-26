import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
test('FTS matches existing substring, code, fuzzy title, number and bot behavior', () => {
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
        assert.deepEqual(index.search('alice', query, bots, []), searchDocuments(docs, query, bots), query);
    }
    assert.equal(index.search('bob', 'queue', true, []).length, 0);
    assert.equal(index.search('alice', '', false, ['file'])[0].document.id, 'file');
  } finally {
    db.close();
  }
});
test('unchanged index documents cause no writes; updates and deletions do not leave ghost matches', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const index = createSqliteSearchIndex(db);
    index.replace('alice', docs);
    const changes = () => db.prepare('SELECT total_changes() AS n').get()?.n;
    const before = changes();
    index.replace('alice', docs);
    assert.equal(changes(), before);
    index.replace('alice', [{ ...docs[0], text: 'New unique body' }]);
    assert.equal(index.search('alice', 'semaphore', true, []).length, 0);
    assert.equal(index.search('alice', 'unique', true, []).length, 1);
    index.replace('bob', docs);
    index.replace('alice', []);
    assert.equal(index.search('alice', 'queue', true, []).length, 0);
    assert.ok(index.search('bob', 'queue', true, []).length > 0);
  } finally {
    db.close();
  }
});
