import { DatabaseSync } from 'node:sqlite';
import { createSqliteSearchIndex } from '../../src/sqlite-search-index';
import { createSearchIndexer, type SearchBackend, type SearchOp } from '../../src/command-search-service';

/** The worker's index, in this thread, for tests of the indexer. Records every apply. */
export function localSearchBackend(db: DatabaseSync) {
  const index = createSqliteSearchIndex(db);
  const applied: SearchOp[][] = [];
  const backend: SearchBackend & { applied: SearchOp[][]; searches: number } = {
    applied,
    searches: 0,
    feeds: (account) => Promise.resolve(index.feeds(account)),
    apply: (account, ops) => {
      applied.push(structuredClone(ops));
      return Promise.resolve(index.apply(account, ops));
    },
    search: (request) => {
      backend.searches++;
      return Promise.resolve({ account: request.account, ...index.search(request), ignoreBots: request.ignoreBots });
    },
  };
  return backend;
}

/** The indexer over an in-memory index, for tests that only search a fixed queue and history. */
export function localCommandSearch(deps: Omit<Parameters<typeof createSearchIndexer>[0], 'backend' | 'mutedUrls'> & { mutedUrls?: () => ReadonlySet<string> }) {
  const db = new DatabaseSync(':memory:');
  return createSearchIndexer({ mutedUrls: () => new Set(), ...deps, backend: localSearchBackend(db) });
}
