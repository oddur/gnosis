import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  reviewDocuments,
  searchDocuments,
  searchHit,
  threadFile,
  type SearchDocument,
  type SearchHit,
} from '../lib/command-search';
import type { ReviewGuide } from '../lib/types';
import type { SearchOp, SearchRequest } from './command-search-service';

/** Documents per account. Queue documents are pinned and never evicted. */
export const SEARCH_MAX_DOCUMENTS = 6000;
export const SEARCH_INDEX_MIGRATION = 'search-index-v2';
/** The v1 index stored full diffs and queue snapshots. `maintain` drops it once, never `open`. */
export function dropLegacySearchIndex(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS search_insert; DROP TRIGGER IF EXISTS search_delete; DROP TRIGGER IF EXISTS search_update;
    DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_documents; DROP TABLE IF EXISTS search_subjects;
  `);
}
/** Empty every search table, v1 and v2, that exists. Runs inside the caller's transaction. */
export function clearSearchIndex(db: DatabaseSync): void {
  for (const table of ['search_documents', 'search_subjects', 'search_docs', 'search_feeds'])
    if (db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table))
      db.exec(`DELETE FROM ${table}`);
}
const docUrl = (document: SearchDocument) =>
  document.sourceUrl ??
  (document.destination.kind === 'home' ? (document.destination.focusUrl ?? document.destination.url) : undefined) ??
  null;
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
type Prepared =
  | { feed: string; hash: string; usedAt: number; pinned: boolean; docs: SearchDocument[] }
  | { feed: string; remove: true };

/**
 * Worker-only index of bounded documents, grouped into feeds that main updates incrementally.
 * Trigrams preserve substring and path matching; titles keep fuzzy ranking.
 */
export function createSqliteSearchIndex(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_docs(
      rowid INTEGER PRIMARY KEY, account TEXT NOT NULL, id TEXT NOT NULL, feed TEXT NOT NULL,
      kind TEXT NOT NULL, url TEXT, pinned INTEGER NOT NULL, used_at INTEGER NOT NULL,
      payload TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, author TEXT NOT NULL,
      search_text TEXT NOT NULL, UNIQUE(account,id));
    CREATE INDEX IF NOT EXISTS search_docs_feed ON search_docs(account,feed);
    CREATE INDEX IF NOT EXISTS search_docs_url ON search_docs(account,url);
    CREATE INDEX IF NOT EXISTS search_docs_age ON search_docs(account,pinned,used_at);
    CREATE TABLE IF NOT EXISTS search_feeds(
      account TEXT NOT NULL, feed TEXT NOT NULL, hash TEXT NOT NULL, used_at INTEGER NOT NULL,
      PRIMARY KEY(account,feed));
    CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts
      USING fts5(search_text, content='search_docs', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS search_docs_insert AFTER INSERT ON search_docs BEGIN
      INSERT INTO search_docs_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_docs_delete AFTER DELETE ON search_docs BEGIN
      INSERT INTO search_docs_fts(search_docs_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS search_docs_update AFTER UPDATE ON search_docs BEGIN
      INSERT INTO search_docs_fts(search_docs_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
      INSERT INTO search_docs_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
    END;
  `);
  /** Saved reviews that could not be indexed, per account and feed. Each launch's first build repeats them. */
  const warnings = new Map<string, Map<string, string>>();
  const warn = (account: string, feed: string, message?: string) => {
    let byFeed = warnings.get(account);
    if (!byFeed) warnings.set(account, (byFeed = new Map<string, string>()));
    if (message) byFeed.set(feed, message);
    else byFeed.delete(feed);
  };
  const storedHash = (account: string, feed: string) =>
    db.prepare('SELECT hash FROM search_feeds WHERE account=? AND feed=?').get(account, feed)?.hash;

  /** Stat a saved review, and read and build it only when the file or its entry changed. */
  function resolveReview(account: string, op: Extract<SearchOp, { review: unknown }>): Prepared | undefined {
    const { directory, entry } = op.review;
    const unavailable = (): Prepared => {
      warn(account, op.feed, `Saved review unavailable: ${entry.prTitle}`);
      return { feed: op.feed, remove: true };
    };
    if (path.basename(entry.id) !== entry.id) return unavailable();
    const file = path.join(directory, `${entry.id}.json`);
    let hash: string;
    try {
      const stat = fs.statSync(file);
      hash = `${stat.mtimeMs}:${stat.size}:${sha1(JSON.stringify(entry)).slice(0, 12)}`;
    } catch {
      return unavailable();
    }
    warn(account, op.feed);
    if (storedHash(account, op.feed) === hash) return;
    try {
      const review = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGuide;
      return { feed: op.feed, hash, usedAt: op.usedAt, pinned: false, docs: reviewDocuments(review, entry) };
    } catch {
      warn(account, op.feed, `Could not index saved review: ${entry.prTitle}`);
      return { feed: op.feed, remove: true };
    }
  }

  return {
    feeds(account: string): [string, string][] {
      return db
        .prepare('SELECT feed,hash FROM search_feeds WHERE account=?')
        .all(account)
        .map((row) => [String(row.feed), String(row.hash)]);
    },
    /** One transaction: replace each feed's documents, record its hash, then evict above the cap. */
    apply(account: string, ops: readonly SearchOp[], now = Date.now()) {
      // Saved reviews are read before the transaction, so a slow disk does not hold the write lock.
      const prepared = ops.flatMap((op): Prepared[] => {
        if ('review' in op) {
          const resolved = resolveReview(account, op);
          return resolved ? [resolved] : [];
        }
        if ('remove' in op) warn(account, op.feed);
        return [op];
      });
      const removeFeed = db.prepare('DELETE FROM search_docs WHERE account=? AND feed=?');
      const forgetFeed = db.prepare('DELETE FROM search_feeds WHERE account=? AND feed=?');
      const put = db.prepare(`INSERT INTO search_docs(account,id,feed,kind,url,pinned,used_at,payload,title,source,author,search_text)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET feed=excluded.feed,kind=excluded.kind,
        url=excluded.url,pinned=excluded.pinned,used_at=excluded.used_at,payload=excluded.payload,title=excluded.title,
        source=excluded.source,author=excluded.author,search_text=excluded.search_text`);
      const record = db.prepare(
        'INSERT INTO search_feeds(account,feed,hash,used_at) VALUES(?,?,?,?) ON CONFLICT(account,feed) DO UPDATE SET hash=excluded.hash,used_at=excluded.used_at'
      );
      let docs = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const op of prepared) {
          removeFeed.run(account, op.feed);
          if ('remove' in op) {
            forgetFeed.run(account, op.feed);
            continue;
          }
          const usedAt = Number.isFinite(op.usedAt) ? op.usedAt : now;
          for (const document of op.docs) {
            put.run(
              account,
              document.id,
              op.feed,
              document.kind,
              docUrl(document),
              op.pinned ? 1 : 0,
              usedAt,
              JSON.stringify(document),
              document.title,
              document.source,
              document.author ?? '',
              `${document.title} ${document.source} ${document.source.replace(/ #/g, '#')} ${document.author ?? ''} ${document.text}`
            );
            docs++;
          }
          record.run(account, op.feed, op.hash, usedAt);
        }
        // Evicted feeds keep their hash, so main does not resend a feed that has not changed.
        const evicted = db
          .prepare(
            `DELETE FROM search_docs WHERE rowid IN (
              SELECT rowid FROM search_docs WHERE account=? AND pinned=0
              ORDER BY used_at LIMIT max(0, (SELECT count(*) FROM search_docs WHERE account=?) - ?))`
          )
          .run(account, account, SEARCH_MAX_DOCUMENTS).changes;
        db.exec('COMMIT');
        return { evicted: Number(evicted), docs };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** Mutes, bot rules and queue precedence apply here, at query time, so they never need a rebuild. */
    search(request: SearchRequest, limit = 120) {
      const { account, includeBots, recentIds } = request;
      const q = request.query.trim().toLowerCase();
      const muted = new Set(request.muted);
      const repoBots = request.repositoryBotSettings ?? {};
      // Saved reviews and cached responses for a PR the queue holds show the queue's document instead.
      const pinnedUrls = new Set(
        db
          .prepare('SELECT DISTINCT url FROM search_docs WHERE account=? AND pinned=1 AND url IS NOT NULL')
          .all(account)
          .map((row) => String(row.url))
      );
      const unpinned = new WeakSet<SearchDocument>();
      const visible = (row: Record<string, unknown>): SearchDocument | undefined => {
        const pinned = !!row.pinned;
        if (!pinned && (row.kind === 'pr' || row.kind === 'stack') && typeof row.url === 'string' && pinnedUrls.has(row.url))
          return;
        const document = JSON.parse(String(row.payload)) as SearchDocument;
        if (
          (document.sourceUrl && muted.has(document.sourceUrl)) ||
          (document.destination.kind === 'home' && document.destination.url && muted.has(document.destination.url)) ||
          document.memberUrls?.some((url) => muted.has(url))
        )
          return;
        let result = document;
        if (document.bot) {
          const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(document.sourceUrl ?? document.source)?.[1]?.toLowerCase();
          const repos = repo
            ? [repo]
            : [...document.source.matchAll(/(?:^| · )([\w.-]+\/[\w.-]+) #/g)].map((match) => match[1].toLowerCase());
          const botHidden = (name: string) => (Object.hasOwn(repoBots, name) ? repoBots[name] : request.ignoreBots);
          result = { ...document, botHidden: repos.length ? repos.every(botHidden) : request.ignoreBots };
        }
        if (!pinned) unpinned.add(result);
        return result;
      };
      const hits: SearchHit[] = [];
      let total = 0;
      const recentRank = (id: string) => {
        const index = recentIds.indexOf(id);
        return index < 0 ? 999 : index;
      };
      const compare = q
        ? (a: SearchHit, b: SearchHit) => b.score - a.score || a.document.title.localeCompare(b.document.title)
        : (a: SearchHit, b: SearchHit) => recentRank(a.document.id) - recentRank(b.document.id);
      const collect = (row: Record<string, unknown>) => {
        const document = visible(row);
        if (!document) return;
        let hit: SearchHit | undefined;
        if (!q) {
          if (includeBots || !document.bot || document.botHidden === false) hit = searchHit(document);
        } else hit = searchDocuments([document], q, includeBots)[0];
        if (!hit) return;
        total++;
        // Keep only the visible page.
        hits.push(hit);
        hits.sort(compare);
        if (hits.length > limit) hits.pop();
      };
      // SQLite trigram tokens count Unicode code points, not grapheme clusters.
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      const terms = q.split(/\s+/).filter((term) => [...term].length >= 3);
      if (!q) {
        for (const row of db
          .prepare(
            `SELECT payload,pinned,kind,url FROM search_docs WHERE account=? AND
              (kind IN ('pr','stack','view','repository') OR id IN (SELECT value FROM json_each(?)))`
          )
          .iterate(account, JSON.stringify(recentIds)))
          collect(row);
      } else if (terms.length) {
        const match = terms.map((term) => '"' + term.replace(/"/g, '""') + '"').join(' AND ');
        const ids = new Set<string>();
        for (const row of db
          .prepare(
            'SELECT id,payload,pinned,kind,url FROM search_docs WHERE account=? AND rowid IN (SELECT rowid FROM search_docs_fts WHERE search_docs_fts MATCH ?)'
          )
          .iterate(account, match)) {
          ids.add(String(row.id));
          collect(row);
        }
        // Scan lightweight metadata for fuzzy titles; load matching bodies one at a time.
        const get = db.prepare('SELECT payload,pinned,kind,url FROM search_docs WHERE account=? AND id=?');
        for (const row of db.prepare('SELECT id,title,source,author FROM search_docs WHERE account=?').iterate(account)) {
          if (ids.has(String(row.id))) continue;
          const metadata: SearchDocument = {
            id: String(row.id),
            title: String(row.title),
            source: String(row.source),
            author: String(row.author),
            text: '',
            kind: 'pr',
            groupId: '',
            groupTitle: '',
            destination: { kind: 'activity' },
          };
          if (!searchDocuments([metadata], q, true).length) continue;
          const saved = get.get(account, row.id);
          if (saved) collect(saved);
        }
      } else {
        for (const row of db.prepare('SELECT payload,pinned,kind,url FROM search_docs WHERE account=?').iterate(account))
          collect(row);
      }
      const group = db.prepare(
        "SELECT payload FROM search_docs WHERE account=? AND url=? AND pinned=1 AND kind IN ('pr','stack') LIMIT 1"
      );
      const files = db.prepare("SELECT payload FROM search_docs WHERE account=? AND url=? AND kind='file'");
      return {
        hits: hits.map((hit) => {
          const { thread, ...document } = hit.document;
          delete document.memberUrls;
          // A cached PR or saved review joins the group of the queue entry with the same URL.
          const url = docUrl(document);
          if (url && unpinned.has(hit.document) && pinnedUrls.has(url)) {
            const row = group.get(account, url);
            if (row) {
              const pinned = JSON.parse(String(row.payload)) as SearchDocument;
              document.groupId = pinned.groupId;
              document.groupTitle = pinned.groupTitle;
            }
          }
          // A GitHub comment opens its thread in the saved review file, when one exists.
          if (thread && document.sourceUrl) {
            const saved = files
              .all(account, document.sourceUrl)
              .map((row) => JSON.parse(String(row.payload)) as SearchDocument);
            const file = threadFile(document.sourceUrl, thread.path, saved);
            if (file?.destination.kind === 'review') {
              document.destination = { ...file.destination, line: thread.line, side: thread.side, threadId: thread.id };
              document.source = file.source;
            }
          }
          return { ...hit, document: { ...document, text: hit.snippet, code: undefined } };
        }),
        total,
        warnings: [...(warnings.get(account)?.values() ?? [])],
      };
    },
  };
}
export type SqliteSearchIndex = ReturnType<typeof createSqliteSearchIndex>;
