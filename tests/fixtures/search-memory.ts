import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SearchDocument } from '../../lib/command-search';
import { createSqliteSearchIndex } from '../../src/sqlite-search-index';

// Legacy indexes repeated the complete stack in each cached file destination.
// Seed on disk without materializing those copies together in JavaScript.
const db = new DatabaseSync(process.argv[2]);
const index = createSqliteSearchIndex(db);
const document = {
  id: 'file',
  kind: 'file',
  title: 'needle.ts',
  text: 'needle',
  source: 'o/r #1',
  groupId: 'stack',
  groupTitle: 'Stack',
  destination: { kind: 'home', subject: { description: 'x'.repeat(1024 * 1024) } },
};
const payload = JSON.stringify(document);
const put = db.prepare(
  'INSERT INTO search_documents(account,id,payload,title,source,author,search_text) VALUES(?,?,?,?,?,?,?)'
);
db.exec('BEGIN');
for (let i = 0; i < 160; i++) put.run('alice', String(i), payload, 'needle.ts', 'o/r #1', '', 'needle');
db.exec('COMMIT');
if (process.argv[3] === 'replace') {
  index.replace('alice', []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_documents').get()?.n, 0);
} else if (process.argv[3] === 'broad') {
  const documents = Array.from({ length: 160 }, (_, i) => ({ ...document, id: String(i) })) as SearchDocument[];
  index.replace('alice', documents);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_subjects').get()?.n, 1);
  assert.ok(Number(db.prepare('SELECT sum(length(payload)) AS n FROM search_documents').get()?.n) < 100_000);
  const writes = db.prepare('SELECT total_changes() AS n').get()?.n;
  index.replace('alice', documents);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, writes);
  // Large diff bodies must also be streamed, independently of shared navigation data.
  const code = 'x'.repeat(1024 * 1024);
  index.replace(
    'alice',
    documents.map((entry) => ({ ...entry, code }))
  );
  for (const query of ['ne', 'needle']) {
    const result = index.search('alice', query, true, [], 5);
    assert.equal(result.total, 160);
    assert.equal(result.hits.length, 5);
    assert.deepEqual(result.hits[0].document.destination, document.destination);
    assert.equal(result.hits[0].document.destination.kind, 'home');
    if (result.hits[1].document.destination.kind === 'home')
      assert.equal(result.hits[0].document.destination.subject, result.hits[1].document.destination.subject);
  }
  index.replace('alice', []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_subjects').get()?.n, 0);
} else {
  assert.equal(index.search('alice', '', true, []).hits.length, 0);
}
db.close();
console.log('bounded search memory passed');
