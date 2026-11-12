import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SearchDocument } from '../../lib/command-search';
import { SEARCH_MAX_DOCUMENTS, createSqliteSearchIndex } from '../../src/sqlite-search-index';

// A full index, searched with a short heap: broad queries keep only the visible page.
const db = new DatabaseSync(process.argv[2]);
const index = createSqliteSearchIndex(db);
const document: SearchDocument = {
  id: 'file',
  kind: 'file',
  title: 'needle.ts',
  text: 'needle ' + 'x'.repeat(590),
  source: 'o/r #1',
  groupId: 'stack',
  groupTitle: 'Stack',
  destination: { kind: 'review', reviewId: 'r', filePath: 'needle.ts' },
};
const request = { account: 'alice', includeBots: true, recentIds: [], muted: [], ignoreBots: false };
for (let feed = 0; feed < SEARCH_MAX_DOCUMENTS / 500; feed++)
  index.apply('alice', [
    {
      feed: `review:${feed}`,
      hash: 'h',
      usedAt: feed,
      pinned: false,
      docs: Array.from({ length: 500 }, (_, i) => ({ ...document, id: `${feed}:${i}` })),
    },
  ]);
if (process.argv[3] === 'broad') {
  for (const query of ['ne', 'needle']) {
    const result = index.search({ ...request, query }, 5);
    assert.equal(result.total, SEARCH_MAX_DOCUMENTS);
    assert.equal(result.hits.length, 5);
  }
} else if (process.argv[3] === 'empty') {
  assert.equal(index.search({ ...request, query: '' }).hits.length, 0);
} else {
  index.apply('alice', Array.from({ length: SEARCH_MAX_DOCUMENTS / 500 }, (_, feed) => ({ feed: `review:${feed}`, remove: true as const })));
  assert.equal(db.prepare('SELECT count(*) AS n FROM search_docs').get()?.n, 0);
}
db.close();
console.log('bounded search memory passed');
