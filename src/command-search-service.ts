import fs from 'node:fs/promises';
import { isCacheRecord } from '../lib/github-cache';
import { isDependabot } from '../lib/workbench';
import path from 'node:path';
import {
  searchHit,
  queueDocuments,
  reviewDocuments,
  searchDocuments,
  threadDocuments,
  type SearchDocument,
  type SearchHit,
} from '../lib/command-search';
import type { WorkbenchQueue } from '../lib/workbench';
import type { ReviewGuide, ReviewHistoryEntry } from '../lib/types';
import type { GitHubReviewThreads } from '../lib/review-threads';

interface Deps {
  cachedResponses?: () => { url: string; data: unknown }[];
  directory: () => string;
  queue: () => WorkbenchQueue;
  history: () => ReviewHistoryEntry[];
  account: () => string;
  ignoreBots: () => boolean;
  threads: (url: string) => GitHubReviewThreads | undefined;
}
export interface LocalSearchResponse {
  account: string;
  hits: SearchHit[];
  total: number;
  ignoreBots: boolean;
  warnings: string[];
}
/** Disk-only index: no discovery, highlighting, generation, or network calls. */
export function createCommandSearchService(deps: Deps) {
  const files = new Map<string, { stamp: string; review: ReviewGuide }>();
  let checkedAt = 0;
  let indexed: { account: string; signature: string; documents: SearchDocument[]; warnings: string[] } | undefined;
  let building: Promise<void> | undefined;
  let httpDocuments: SearchDocument[] = [];
  async function refresh() {
    const queue = deps.queue(),
      history = deps.history().filter((e) => e.status === undefined || e.status === 'completed');
    const account = deps.account();
    const stamps = await Promise.all(
      history.map(async (entry) => {
        if (path.basename(entry.id) !== entry.id) return { entry, stamp: 'missing' };
        try {
          const stat = await fs.stat(path.join(deps.directory(), `${entry.id}.json`));
          return { entry, stamp: `${stat.mtimeMs}:${stat.size}` };
        } catch {
          return { entry, stamp: 'missing' };
        }
      })
    );
    const signature = JSON.stringify([
      account,
      queue.items.map(({ subject, review, briefing }) => ({ subject, review, briefing: briefing?.summary })),
      queue.savedViews?.views,
      stamps.map((s) => [s.entry, s.stamp]),
    ]);
    if (indexed?.signature === signature) {
      httpDocuments = cachedGitHubDocuments(deps.cachedResponses?.() ?? [], indexed.documents);
      return;
    }
    const documents = queueDocuments(queue),
      warnings: string[] = [];
    const live = new Set(history.map((e) => e.id));
    for (const id of files.keys()) if (!live.has(id)) files.delete(id);
    for (const { entry, stamp } of stamps) {
      if (stamp === 'missing') {
        warnings.push(`Saved review unavailable: ${entry.prTitle}`);
        continue;
      }
      try {
        let cached = files.get(entry.id);
        if (cached?.stamp !== stamp) {
          const review = JSON.parse(
            await fs.readFile(path.join(deps.directory(), `${entry.id}.json`), 'utf8')
          ) as ReviewGuide;
          cached = { stamp, review };
          files.set(entry.id, cached);
        }
        documents.push(...reviewDocuments(cached.review, entry, queue));
      } catch {
        warnings.push(`Could not index saved review: ${entry.prTitle}`);
      }
    }
    if (account !== deps.account()) return;
    httpDocuments = cachedGitHubDocuments(deps.cachedResponses?.() ?? [], documents);
    indexed = { account, signature, documents, warnings };
  }
  return {
    async search(query: string, includeBots = false, recentIds: string[] = []): Promise<LocalSearchResponse> {
      if (typeof query !== 'string' || query.length > 1000) throw Error('Use a search of 1,000 characters or fewer.');
      if (indexed?.account !== deps.account()) {
        indexed = undefined;
        checkedAt = 0;
      }
      if (!building && (!indexed || Date.now() - checkedAt > 2000)) {
        checkedAt = Date.now();
        building = refresh().finally(() => {
          building = undefined;
        });
      }
      await building;
      // An account may change while disk reads are in flight. Never return its old index.
      if (!indexed || indexed.account !== deps.account()) {
        await refresh();
      }
      const base = [...(indexed?.account === deps.account() ? indexed.documents : [])];
      base.push(...httpDocuments);
      const docs = [...base];
      const urls = new Set(
        base.flatMap((d) =>
          d.sourceUrl
            ? [d.sourceUrl]
            : d.destination.kind === 'home' && d.destination.subject
              ? d.destination.subject.subject.members.map((m) => m.url)
              : []
        )
      );
      for (const url of urls) {
        const threads = deps.threads(url);
        if (threads) {
          const group = base.find(
            (d) =>
              d.sourceUrl === url ||
              (d.destination.kind === 'home' && d.destination.subject?.subject.members.some((m) => m.url === url))
          )?.groupId;
          docs.push(
            ...threadDocuments(
              url,
              threads,
              base.filter((d) => d.groupId === group)
            )
          );
        }
      }
      const bots = includeBots || !deps.ignoreBots();
      const hits = query.trim()
        ? searchDocuments(docs, query, bots)
        : docs
            .filter(
              (d) =>
                (['pr', 'stack', 'view', 'repository'].includes(d.kind) || recentIds.includes(d.id)) && (bots || !d.bot)
            )
            .sort((a, b) => {
              const ai = recentIds.indexOf(a.id),
                bi = recentIds.indexOf(b.id);
              return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
            })
            .map((document) => searchHit(document));
      return {
        account: deps.account(),
        hits: hits.slice(0, 120).map((h) => ({ ...h, document: { ...h.document, text: h.snippet, code: undefined } })),
        total: hits.length,
        ignoreBots: deps.ignoreBots(),
        warnings: indexed?.warnings ?? [],
      };
    },
  };
}

/** Search HTTP snapshots too, including PRs opened outside discovery and cached issue comments. */
export function cachedGitHubDocuments(
  responses: { url: string; data: unknown }[],
  existing: SearchDocument[]
): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const parentFor = (url: string) =>
    [...existing, ...docs].find(
      (d) =>
        ['pr', 'stack'].includes(d.kind) &&
        (d.sourceUrl === url ||
          (d.destination.kind === 'home' &&
            (d.destination.url === url || d.destination.subject?.subject.members.some((m) => m.url === url))))
    );
  for (const response of responses) {
    const match = /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\?|$)/.exec(response.url);
    if (!match || !isCacheRecord(response.data) || typeof response.data.title !== 'string') continue;
    const [, owner, repo, number] = match,
      url = `https://github.com/${owner}/${repo}/pull/${number}`,
      data = response.data;
    if (parentFor(url)) continue;
    const author = isCacheRecord(data.user) && typeof data.user.login === 'string' ? data.user.login : 'unknown';
    docs.push({
      id: `cached:${url}`,
      kind: 'pr',
      groupId: url,
      groupTitle: response.data.title,
      title: response.data.title,
      text: typeof data.body === 'string' ? data.body : '',
      source: `${owner}/${repo} #${number}`,
      sourceUrl: url,
      author,
      bot: isDependabot(author),
      state: data.merged ? 'Merged' : data.state === 'closed' ? 'Closed' : data.draft ? 'Draft' : 'Open',
      destination: { kind: 'home', url },
    });
  }
  for (const response of responses) {
    const match = /\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/(files|comments))?(?:\?|$)/.exec(response.url);
    if (!match) continue;
    const [, owner, repo, , number, kind] = match,
      url = `https://github.com/${owner}/${repo}/pull/${number}`,
      parent = parentFor(url);
    if (!parent) continue;
    if (Array.isArray(response.data))
      for (const row of response.data) {
        if (!isCacheRecord(row)) continue;
        if (kind === 'files' && typeof row.filename === 'string') {
          const filename = row.filename;
          const file = existing.find(
            (d) =>
              d.kind === 'file' && d.sourceUrl === url && (d.title === row.filename || d.title.endsWith('/' + filename))
          );
          if (!file)
            docs.push({
              ...parent,
              id: `cached-file:${url}:${row.filename}`,
              kind: 'file',
              title: row.filename,
              text: typeof row.patch === 'string' ? row.patch : '',
              code: typeof row.patch === 'string' ? row.patch : undefined,
              preview: undefined,
              source: `${owner}/${repo} #${number}`,
              sourceUrl: url,
            });
        } else if (kind === 'comments' && typeof row.body === 'string')
          docs.push({
            ...parent,
            id: `cached-comment:${String(row.id)}`,
            kind: 'comment',
            title: typeof row.path === 'string' ? row.path : 'GitHub discussion',
            text: row.body,
            source: `${owner}/${repo} #${number}`,
            sourceUrl: url,
          });
      }
    // A diff response is a string, and is already represented by saved file documents when present.
    if (!kind && typeof response.data === 'string' && !existing.some((d) => d.kind === 'file' && d.sourceUrl === url))
      docs.push({
        ...parent,
        id: `cached-diff:${url}`,
        kind: 'file',
        title: `Diff · ${parent.title}`,
        text: response.data,
        code: response.data,
        preview: undefined,
        sourceUrl: url,
      });
  }
  return docs;
}
