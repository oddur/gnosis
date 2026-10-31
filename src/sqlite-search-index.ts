import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { searchDocuments, searchHit, type SearchDocument, type SearchHit } from '../lib/command-search';
/** Worker-only index. Trigrams preserve substring/path/code matching; titles retain fuzzy ranking. */
export function createSqliteSearchIndex(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      rowid INTEGER PRIMARY KEY, account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL, search_text TEXT NOT NULL,
      UNIQUE(account,id)
    );
    CREATE TABLE IF NOT EXISTS search_subjects (
      account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id)
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
  type StoredDocument = SearchDocument & { subjectKey?: string };
  return {
    replace(account: string, documents: SearchDocument[]) {
      // Compare inside SQLite: loading the previous payloads can exceed the JS heap.
      const next = new Map(documents.map((document) => [document.id, document]));
      const put = db.prepare(
        'INSERT INTO search_documents(account,id,payload,title,source,author,search_text) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET payload=excluded.payload,title=excluded.title,source=excluded.source,author=excluded.author,search_text=excluded.search_text WHERE search_documents.payload != excluded.payload'
      );
      const putSubject = db.prepare(
        'INSERT INTO search_subjects(account,id,payload) VALUES(?,?,?) ON CONFLICT(account,id) DO NOTHING'
      );
      const subjects = new WeakMap<object, string>();
      const liveSubjects = new Set<string>();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [id, document] of next) {
          let stored: StoredDocument = document;
          if (document.destination.kind === 'home' && document.destination.subject) {
            const subject = document.destination.subject;
            let key = subjects.get(subject);
            if (!key) {
              const payload = JSON.stringify(subject);
              key = createHash('sha256').update(payload).digest('hex');
              subjects.set(subject, key);
              putSubject.run(account, key, payload);
            }
            liveSubjects.add(key);
            stored = { ...document, destination: { ...document.destination, subject: undefined }, subjectKey: key };
          }
          put.run(
            account,
            id,
            JSON.stringify(stored),
            document.title,
            document.source,
            document.author ?? '',
            `${document.title} ${document.source} ${document.source.replace(/ #/g, '#')} ${document.author ?? ''} ${document.text}`
          );
        }
        const remove = db.prepare('DELETE FROM search_documents WHERE account=? AND id=?');
        for (const row of db.prepare('SELECT id FROM search_documents WHERE account=?').iterate(account))
          if (!next.has(String(row.id))) remove.run(account, row.id);
        const removeSubject = db.prepare('DELETE FROM search_subjects WHERE account=? AND id=?');
        for (const row of db.prepare('SELECT id FROM search_subjects WHERE account=?').iterate(account))
          if (!liveSubjects.has(String(row.id))) removeSubject.run(account, row.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    search(account: string, query: string, includeBots: boolean, recentIds: string[], limit = 120) {
      const q = query.trim().toLowerCase();
      const hits: SearchHit[] = [];
      let total = 0;
      const recentRank = (id: string) => {
        const index = recentIds.indexOf(id);
        return index < 0 ? 999 : index;
      };
      const compare = q
        ? (a: SearchHit, b: SearchHit) => b.score - a.score || a.document.title.localeCompare(b.document.title)
        : (a: SearchHit, b: SearchHit) => recentRank(a.document.id) - recentRank(b.document.id);
      const collect = (document: SearchDocument) => {
        let hit: SearchHit | undefined;
        if (!q) {
          if (
            (includeBots || !document.bot || document.botHidden === false) &&
            (['pr', 'stack', 'view', 'repository'].includes(document.kind) || recentIds.includes(document.id))
          )
            hit = searchHit(document);
        } else hit = searchDocuments([document], q, includeBots)[0];
        if (!hit) return;
        total++;
        // Keep only the visible page. Short/common queries must not retain every diff.
        hits.push(hit);
        hits.sort(compare);
        if (hits.length > limit) hits.pop();
      };
      // SQLite trigram tokens count Unicode code points, not grapheme clusters.
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      const terms = q.split(/\s+/).filter((term) => [...term].length >= 3);
      if (terms.length) {
        const match = terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' AND ');
        const ids = new Set<string>();
        for (const row of db
          .prepare(
            'SELECT id,payload FROM search_documents WHERE account=? AND rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)'
          )
          .iterate(account, match)) {
          ids.add(String(row.id));
          collect(JSON.parse(String(row.payload)) as StoredDocument);
        }
        // Scan lightweight metadata for fuzzy titles; load matching bodies one at a time.
        const get = db.prepare('SELECT payload FROM search_documents WHERE account=? AND id=?');
        for (const row of db
          .prepare('SELECT id,title,source,author FROM search_documents WHERE account=?')
          .iterate(account)) {
          if (ids.has(String(row.id))) continue;
          const metadata = {
            id: String(row.id),
            title: String(row.title),
            source: String(row.source),
            author: String(row.author),
            text: '',
            kind: 'pr' as const,
            groupId: '',
            groupTitle: '',
            destination: { kind: 'activity' as const },
          };
          if (searchDocuments([metadata], q, true).length) {
            const saved = get.get(account, row.id);
            if (!saved) continue;
            collect(JSON.parse(String(saved.payload)) as StoredDocument);
          }
        }
      } else {
        for (const row of db.prepare('SELECT payload FROM search_documents WHERE account=?').iterate(account))
          collect(JSON.parse(String(row.payload)) as StoredDocument);
      }
      // One shared navigation snapshot per stack, hydrated only for the visible results.
      const subjects = new Map<
        string,
        NonNullable<Extract<SearchDocument['destination'], { kind: 'home' }>['subject']>
      >();
      const getSubject = db.prepare('SELECT payload FROM search_subjects WHERE account=? AND id=?');
      for (const hit of hits) {
        const { subjectKey, ...document } = hit.document as StoredDocument;
        if (subjectKey && document.destination.kind === 'home') {
          let subject = subjects.get(subjectKey);
          if (!subject) {
            const row = getSubject.get(account, subjectKey);
            if (!row) throw new Error('Search navigation data is unavailable');
            subject = JSON.parse(String(row.payload)) as NonNullable<
              Extract<SearchDocument['destination'], { kind: 'home' }>['subject']
            >;
            subjects.set(subjectKey, subject);
          }
          document.destination = { ...document.destination, subject };
        }
        hit.document = document;
      }
      return { hits, total };
    },
  };
}
export type SqliteSearchIndex = ReturnType<typeof createSqliteSearchIndex>;
