import type { DatabaseSync } from 'node:sqlite';
import { searchDocuments, searchHit, type SearchDocument, type SearchHit } from '../lib/command-search';
/** Worker-only index. Trigrams preserve substring/path/code matching; titles retain fuzzy ranking. */
export function createSqliteSearchIndex(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      rowid INTEGER PRIMARY KEY, account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL, search_text TEXT NOT NULL,
      UNIQUE(account,id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(search_text, content='search_documents', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_update AFTER UPDATE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
      INSERT INTO search_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
    END;
  `);
  return {
    replace(account: string, documents: SearchDocument[]) {
      const previous = new Map(
        (
          db.prepare('SELECT id,payload FROM search_documents WHERE account=?').all(account) as {
            id: string;
            payload: string;
          }[]
        ).map((row) => [row.id, row.payload])
      );
      const next = new Map(documents.map((document) => [document.id, document]));
      const put = db.prepare(
        'INSERT INTO search_documents(account,id,payload,title,source,author,search_text) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET payload=excluded.payload,title=excluded.title,source=excluded.source,author=excluded.author,search_text=excluded.search_text'
      );
      const remove = db.prepare('DELETE FROM search_documents WHERE account=? AND id=?');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [id, document] of next) {
          const payload = JSON.stringify(document);
          if (payload === previous.get(id)) continue;
          put.run(
            account,
            id,
            payload,
            document.title,
            document.source,
            document.author ?? '',
            `${document.title} ${document.source} ${document.source.replace(/ #/g, '#')} ${document.author ?? ''} ${document.text}`
          );
        }
        for (const id of previous.keys()) if (!next.has(id)) remove.run(account, id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    search(account: string, query: string, includeBots: boolean, recentIds: string[]): SearchHit[] {
      const q = query.trim().toLowerCase();
      if (!q) {
        const documents = (
          db.prepare('SELECT payload FROM search_documents WHERE account=?').all(account) as { payload: string }[]
        ).map((row) => JSON.parse(row.payload) as SearchDocument);
        return documents
          .filter(
            (d) =>
              (['pr', 'stack', 'view', 'repository'].includes(d.kind) || recentIds.includes(d.id)) &&
              (includeBots || !d.bot)
          )
          .sort((a, b) => {
            const ai = recentIds.indexOf(a.id),
              bi = recentIds.indexOf(b.id);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
          })
          .map((d) => searchHit(d));
      }
      // SQLite trigram tokens count Unicode code points, not grapheme clusters.
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      const terms = q.split(/\s+/).filter((term) => [...term].length >= 3);
      let candidates: SearchDocument[];
      if (terms.length) {
        const match = terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' AND ');
        candidates = (
          db
            .prepare(
              'SELECT payload FROM search_documents WHERE account=? AND rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)'
            )
            .all(account, match) as { payload: string }[]
        ).map((row) => JSON.parse(row.payload) as SearchDocument);
        // Fuzzy matching only needs titles, not every saved diff and explanation body.
        const metadata = db
          .prepare('SELECT id,title,source,author FROM search_documents WHERE account=?')
          .all(account) as { id: string; title: string; source: string; author: string }[];
        const fuzzy = searchDocuments(
          metadata.map((row) => ({
            ...row,
            text: '',
            kind: 'pr',
            groupId: '',
            groupTitle: '',
            destination: { kind: 'activity' },
          })),
          q,
          true
        );
        const ids = new Set(candidates.map((d) => d.id));
        const get = db.prepare('SELECT payload FROM search_documents WHERE account=? AND id=?');
        for (const hit of fuzzy)
          if (!ids.has(hit.document.id)) {
            const row = get.get(account, hit.document.id) as { payload: string };
            candidates.push(JSON.parse(row.payload) as SearchDocument);
          }
      } else
        candidates = (
          db.prepare('SELECT payload FROM search_documents WHERE account=?').all(account) as { payload: string }[]
        ).map((row) => JSON.parse(row.payload) as SearchDocument);
      return searchDocuments(candidates, q, includeBots);
    },
  };
}
export type SqliteSearchIndex = ReturnType<typeof createSqliteSearchIndex>;
