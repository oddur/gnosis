import { createHash } from 'node:crypto';
import { isCacheRecord, type CacheChange } from '../lib/github-cache';
import { isDependabot } from '../lib/workbench';
import {
  boundDocument,
  hydrateDestination,
  queueMetaDocuments,
  queueSubjects,
  subjectDocuments,
  threadDocuments,
  type SearchDocument,
  type SearchHit,
} from '../lib/command-search';
import type { QueueItem, WorkbenchQueue } from '../lib/workbench';
import type { ReviewHistoryEntry } from '../lib/types';
import type { GitHubReviewThreads } from '../lib/review-threads';

export interface LocalSearchResponse {
  account: string;
  hits: SearchHit[];
  total: number;
  ignoreBots: boolean;
  warnings: string[];
}
export interface SearchRequest {
  account: string;
  query: string;
  includeBots: boolean;
  recentIds: string[];
  muted: string[];
  ignoreBots: boolean;
  repositoryBotSettings?: Record<string, boolean>;
}
/** The saved-review fields the index reads. Whole entries would clone every snapshot on each change. */
export type SearchReviewEntry = Pick<ReviewHistoryEntry, 'id' | 'prUrl' | 'prTitle' | 'author' | 'prState' | 'savedAt'>;
/** Replaces one feed: a queue entry, a cached response, a PR's threads or a saved review. */
export type SearchOp =
  | { feed: string; hash: string; usedAt: number; pinned: boolean; docs: SearchDocument[] }
  | { feed: string; remove: true }
  | { feed: string; review: { directory: string; entry: SearchReviewEntry }; usedAt: number };
export interface SearchBackend {
  feeds(account: string): Promise<[string, string][]>;
  apply(account: string, ops: SearchOp[]): Promise<{ evicted: number }>;
  search(request: SearchRequest): Promise<LocalSearchResponse>;
}

/** The cached GitHub responses that hold searchable PR data. */
export const SEARCHABLE_RESPONSE = /\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/(files|comments))?(?:\?|$)/;
/**
 * Documents for one cached HTTP response, independent of the rest of the index: the group is the
 * PR URL and the destination opens it. The index hides the PR document when the queue holds the
 * same PR. Diffs and patches are not indexed; a file document holds its path only.
 */
export function httpDocuments(response: { url: string; data: unknown }): SearchDocument[] {
  const match = SEARCHABLE_RESPONSE.exec(response.url);
  if (!match) return [];
  const [, owner, repo, type, number, kind] = match,
    url = `https://github.com/${owner}/${repo}/pull/${number}`,
    source = `${owner}/${repo} #${number}`,
    data = response.data;
  const common = { groupId: url, groupTitle: source, source, sourceUrl: url, destination: { kind: 'home' as const, url } };
  const docs: SearchDocument[] = [];
  if (type === 'pulls' && !kind && isCacheRecord(data) && typeof data.title === 'string') {
    const author = isCacheRecord(data.user) && typeof data.user.login === 'string' ? data.user.login : 'unknown';
    const branch = (value: unknown) => (isCacheRecord(value) && typeof value.ref === 'string' ? value.ref : '');
    const labels = Array.isArray(data.labels)
      ? data.labels.flatMap((label) => (isCacheRecord(label) && typeof label.name === 'string' ? [label.name] : []))
      : [];
    docs.push({
      ...common,
      id: `cached:${url}`,
      kind: 'pr',
      groupTitle: data.title,
      title: data.title,
      text: `${labels.join(' ')} ${branch(data.base)} ${branch(data.head)}\n${typeof data.body === 'string' ? data.body : ''}`,
      author,
      bot: isDependabot(author),
      state: data.merged ? 'Merged' : data.state === 'closed' ? 'Closed' : data.draft ? 'Draft' : 'Open',
    });
  } else if (Array.isArray(data))
    for (const row of data) {
      if (!isCacheRecord(row)) continue;
      if (kind === 'files' && typeof row.filename === 'string')
        docs.push({ ...common, id: `cached-file:${url}:${row.filename}`, kind: 'file', title: row.filename, text: row.filename });
      else if (kind === 'comments' && typeof row.body === 'string')
        docs.push({
          ...common,
          id: `cached-comment:${String(row.id)}`,
          kind: 'comment',
          title: typeof row.path === 'string' ? row.path : 'GitHub discussion',
          text: row.body,
          author: isCacheRecord(row.user) && typeof row.user.login === 'string' ? row.user.login : undefined,
        });
    }
  return docs.map(boundDocument);
}
/** A stored `{ response, freshUntil }` value for a searchable PR response, read in place. */
function searchableResponse(value: unknown): { url: string; data: unknown } | undefined {
  if (!isCacheRecord(value) || !isCacheRecord(value.response)) return;
  const response = value.response;
  if (response.status !== 200 || typeof response.url !== 'string' || !SEARCHABLE_RESPONSE.test(response.url)) return;
  return { url: response.url, data: response.data };
}
/** A stored `review-threads:` value: `{ url, value: GitHubReviewThreads }`, read in place. */
function savedThreads(value: unknown): { url: string; threads: GitHubReviewThreads } | undefined {
  if (!isCacheRecord(value) || typeof value.url !== 'string' || !isCacheRecord(value.value)) return;
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value.url) || !Array.isArray(value.value.threads)) return;
  return { url: value.url, threads: value.value as unknown as GitHubReviewThreads };
}

interface IndexerDeps {
  backend: SearchBackend;
  /** Resolves once saved data and the GitHub cache are open. */
  ready?: () => Promise<unknown>;
  account: () => string;
  directory: () => string;
  queue: () => WorkbenchQueue;
  history: () => readonly ReviewHistoryEntry[];
  /** Read once, by the first build. Later thread changes arrive through the cache hook. */
  threads: (url: string) => GitHubReviewThreads | undefined;
  mutedUrls: () => ReadonlySet<string>;
  ignoreBots: () => boolean;
  repositoryBotSettings?: () => Record<string, boolean>;
  now?: () => number;
  /** Debounces, in milliseconds. Tests shorten them. */
  timing?: { queue?: number; quiet?: number; max?: number };
  onApply?: (stats: { ops: number; docs: number; evicted: number; ms: number }) => void;
  onSearch?: (stats: { ms: number; main: number; first: boolean; hits: number }) => void;
}
type Pending = SearchOp | (() => SearchOp | undefined);
const MAX_DOCS_PER_MESSAGE = 500;
const MAX_OPS_PER_MESSAGE = 100;
const ITEMS_PER_TURN = 100;
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Keeps the worker's search index current from change events, and sends only the feeds that
 * changed. Main never reads the whole GitHub cache: cached responses arrive one at a time from the
 * cache's change hook, and queue entries are compared by the hash of their bounded documents.
 */
export function createSearchIndexer(deps: IndexerDeps) {
  const now = deps.now ?? Date.now;
  const timing = { queue: 1000, quiet: 500, max: 2000, ...deps.timing };
  /** What the worker holds for `account`: feed to hash. */
  const sent = new Map<string, string>();
  const pending = new Map<string, Pending>();
  /** Cache ids of saved threads, so a removal finds its feed. */
  const threadIds = new Map<string, string>();
  let account: string | undefined;
  let seeded: Promise<void> | undefined;
  let built: Promise<void> | undefined;
  let started = false;
  let generation = 0;
  let lastHistory: readonly ReviewHistoryEntry[] | undefined;
  let subjects: Map<string, QueueItem> | undefined;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let queueRun: Promise<void> | undefined;
  let queueAgain = false;
  let sending: Promise<void> = Promise.resolve();
  let mainMs = 0;
  const unref = (timer: ReturnType<typeof setTimeout>) => {
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  /** A different account starts again from the feeds the worker holds for it. */
  function currentAccount(): string {
    const next = deps.account();
    if (next !== account) {
      account = next;
      generation++;
      sent.clear();
      pending.clear();
      seeded = built = undefined;
      lastHistory = undefined;
      subjects = undefined;
      if (started) void start().catch(() => {});
    }
    return next;
  }
  function seed(): Promise<void> {
    const owner = currentAccount(),
      run = generation;
    seeded ??= (async () => {
      await deps.ready?.();
      const feeds = await deps.backend.feeds(owner);
      if (run !== generation) return;
      for (const [feed, hash] of feeds) if (!sent.has(feed)) sent.set(feed, hash);
    })().catch((error: unknown) => {
      if (run === generation) seeded = undefined;
      throw error;
    });
    return seeded;
  }
  function docsOp(feed: string, docs: SearchDocument[], pinned: boolean) {
    return { feed, hash: sha1(JSON.stringify(docs)), usedAt: now(), pinned, docs };
  }
  /** Stage a feed's documents unless the worker already holds the same ones. */
  function stage(feed: string, docs: SearchDocument[], pinned: boolean) {
    const op = docsOp(feed, docs, pinned);
    if (sent.get(feed) === op.hash) pending.delete(feed);
    else pending.set(feed, op);
  }
  function scheduleFlush() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = unref(setTimeout(() => void flush(), timing.quiet));
    maxTimer ??= unref(setTimeout(() => void flush(), timing.max));
  }
  /** Comment documents for a PR's threads, grouped with its queue entry when the queue holds it. */
  function commentDocuments(url: string, threads: GitHubReviewThreads, title = url) {
    const item = subjects && [...subjects.values()].find((i) => i.subject.members.some((m) => m.url === url));
    const parent: SearchDocument = {
      id: `subject:${url}`, kind: 'pr', title, text: '', groupId: url, groupTitle: title,
      source: url, sourceUrl: url, memberUrls: [url], destination: { kind: 'home', url },
    };
    return threadDocuments(url, threads, item ? subjectDocuments(item) : [parent]);
  }

  /** Queue entries, saved views and repositories. The first build also reads cached threads once. */
  async function queuePass(withThreads: boolean) {
    const run = generation;
    let begun = performance.now();
    const queue = deps.queue();
    const items = queueSubjects(queue);
    subjects = items;
    const live = new Set<string>(['queue:meta']);
    stage('queue:meta', queueMetaDocuments(queue), true);
    let count = 0;
    for (const item of items.values()) {
      if (++count % ITEMS_PER_TURN === 0) {
        mainMs += performance.now() - begun;
        await new Promise((resolve) => setImmediate(resolve));
        if (run !== generation) return;
        begun = performance.now();
      }
      const feed = `queue:${item.subject.id}`;
      live.add(feed);
      stage(feed, subjectDocuments(item), true);
    }
    for (const feed of sent.keys()) if (feed.startsWith('queue:') && !live.has(feed)) pending.set(feed, { feed, remove: true });
    if (withThreads) {
      const urls = new Map<string, string>();
      for (const item of items.values()) for (const member of item.subject.members) urls.set(member.url, member.title);
      for (const entry of deps.history()) if (!urls.has(entry.prUrl)) urls.set(entry.prUrl, entry.prTitle);
      count = 0;
      for (const [url, title] of urls) {
        if (++count % ITEMS_PER_TURN === 0) {
          mainMs += performance.now() - begun;
          await new Promise((resolve) => setImmediate(resolve));
          if (run !== generation) return;
          begun = performance.now();
        }
        const threads = deps.threads(url);
        if (threads) stage(`threads:${url}`, commentDocuments(url, threads, title), false);
      }
    }
    mainMs += performance.now() - begun;
  }
  /** Saved reviews: the worker stats each file and rebuilds only the ones that changed. */
  function reviewPass(force = false) {
    const history = deps.history();
    if (!force && history === lastHistory) return;
    lastHistory = history;
    const live = new Set<string>();
    const directory = deps.directory();
    for (const entry of history) {
      if (entry.status !== undefined && entry.status !== 'completed') continue;
      const feed = `review:${entry.id}`;
      live.add(feed);
      const { id, prUrl, prTitle, author, prState, savedAt } = entry;
      pending.set(feed, {
        feed,
        review: { directory, entry: { id, prUrl, prTitle, author, prState, savedAt } },
        usedAt: Date.parse(savedAt) || now(),
      });
    }
    for (const feed of sent.keys()) if (feed.startsWith('review:') && !live.has(feed)) pending.set(feed, { feed, remove: true });
  }
  const rerunRequested = () => queueAgain;
  function runQueuePass(withThreads = false): Promise<void> {
    if (queueRun) {
      queueAgain = true;
      return queueRun;
    }
    queueRun = (async () => {
      let threads = withThreads;
      do {
        queueAgain = false;
        await queuePass(threads);
        threads = false;
        reviewPass();
        // Another queue change may have arrived during the pass.
      } while (rerunRequested());
    })().finally(() => {
      queueRun = undefined;
    });
    return queueRun;
  }
  async function build() {
    const run = generation;
    await seed();
    if (run !== generation) return;
    await runQueuePass(true);
    reviewPass(true);
    await flush();
  }
  function start(): Promise<void> {
    started = true;
    currentAccount();
    built ??= build().catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return built;
  }

  async function send() {
    const owner = currentAccount(),
      run = generation;
    if (!pending.size) return;
    await seed();
    if (run !== generation) return;
    const begun = performance.now();
    const batches: SearchOp[][] = [[]];
    let docs = 0;
    for (const [feed, entry] of pending) {
      pending.delete(feed);
      const op = typeof entry === 'function' ? entry() : entry;
      if (!op) continue;
      if ('remove' in op) {
        if (!sent.has(feed)) continue;
        sent.delete(feed);
      } else if ('docs' in op) {
        if (sent.get(feed) === op.hash) continue;
        sent.set(feed, op.hash);
      } else sent.set(feed, 'review');
      const size = 'docs' in op ? op.docs.length : 0;
      let batch = batches[batches.length - 1];
      if (batch.length && (docs + size > MAX_DOCS_PER_MESSAGE || batch.length >= MAX_OPS_PER_MESSAGE)) {
        batches.push((batch = []));
        docs = 0;
      }
      batch.push(op);
      docs += size;
    }
    mainMs += performance.now() - begun;
    for (const ops of batches) {
      if (!ops.length) continue;
      const applying = performance.now();
      try {
        const { evicted } = await deps.backend.apply(owner, ops);
        deps.onApply?.({
          ops: ops.length,
          docs: ops.reduce((sum, op) => sum + ('docs' in op ? op.docs.length : 0), 0),
          evicted,
          ms: Math.round(performance.now() - applying),
        });
      } catch (error) {
        // Resend these feeds with the next change or search.
        if (run === generation) for (const op of ops) sent.delete(op.feed);
        console.warn('Could not update the search index:', errorText(error));
      }
    }
  }
  /** Send everything pending now. Resolves once the worker has applied it. */
  function flush(): Promise<void> {
    if (quietTimer) clearTimeout(quietTimer);
    if (maxTimer) clearTimeout(maxTimer);
    quietTimer = maxTimer = undefined;
    sending = sending.then(send, send).catch((error: unknown) => {
      console.warn('Could not update the search index:', errorText(error));
    });
    return sending;
  }

  return {
    /** The first build, after startup: seed what the worker holds, then send what changed. */
    start,
    /** From the GitHub cache's change hook. Synchronous and cheap: documents are built at flush. */
    cacheChanged(change: CacheChange) {
      currentAccount();
      if (change.id === '*') {
        const prefix = `http:${change.scope}:`;
        for (const feed of [...sent.keys(), ...pending.keys()])
          if (feed.startsWith(prefix)) pending.set(feed, { feed, remove: true });
        for (const [id, feed] of threadIds)
          if (id.startsWith(`${change.scope}:`)) {
            threadIds.delete(id);
            pending.set(feed, { feed, remove: true });
          }
        scheduleFlush();
        return;
      }
      const response = change.value === undefined ? undefined : searchableResponse(change.value);
      const threads = change.value === undefined || response ? undefined : savedThreads(change.value);
      if (threads) {
        const feed = `threads:${threads.url}`;
        threadIds.set(change.id, feed);
        pending.set(feed, () => docsOp(feed, commentDocuments(threads.url, threads.threads), false));
      } else if (response) {
        const feed = `http:${change.id}`;
        pending.set(feed, () => docsOp(feed, httpDocuments(response), false));
      } else {
        const feed = threadIds.get(change.id) ?? `http:${change.id}`;
        if (change.value !== undefined || (!sent.has(feed) && !pending.has(feed))) return;
        threadIds.delete(change.id);
        pending.set(feed, { feed, remove: true });
      }
      scheduleFlush();
    },
    /** After every queue change. Debounced; only changed entries are sent. */
    queueChanged() {
      if (!started) return;
      if (queueTimer) clearTimeout(queueTimer);
      queueTimer = unref(
        setTimeout(() => {
          queueTimer = undefined;
          currentAccount();
          void runQueuePass().then(scheduleFlush, (error: unknown) =>
            console.warn('Could not index the queue:', errorText(error))
          );
        }, timing.queue)
      );
    },
    flush,
    async search(query: string, includeBots = false, recentIds: string[] = []): Promise<LocalSearchResponse> {
      if (typeof query !== 'string' || query.length > 1000) throw Error('Use a search of 1,000 characters or fewer.');
      const begun = performance.now();
      const owner = currentAccount();
      const first = !built;
      mainMs = 0;
      // A search before the first build waits for it, once.
      await start().catch(() => {});
      await flush();
      const before = performance.now();
      const request: SearchRequest = {
        account: owner,
        query,
        includeBots,
        recentIds,
        muted: [...deps.mutedUrls()],
        ignoreBots: deps.ignoreBots(),
        repositoryBotSettings: deps.repositoryBotSettings?.(),
      };
      mainMs += performance.now() - before;
      const result = await deps.backend.search(request);
      const after = performance.now();
      if (deps.account() !== owner)
        return { account: deps.account(), hits: [], total: 0, ignoreBots: deps.ignoreBots(), warnings: [] };
      // Hydrate only the returned page, from the queue the last pass read.
      const queued = subjects ?? (subjects = queueSubjects(deps.queue()));
      const hits = result.hits.map((hit) => ({
        ...hit,
        document: { ...hit.document, destination: hydrateDestination(hit.document, (id) => queued.get(id)) },
      }));
      const repoBots = request.repositoryBotSettings ?? {};
      mainMs += performance.now() - after;
      deps.onSearch?.({ ms: performance.now() - begun, main: mainMs, first, hits: hits.length });
      return {
        ...result,
        account: owner,
        hits,
        ignoreBots: request.ignoreBots || Object.values(repoBots).some(Boolean),
      };
    },
  };
}
export type SearchIndexer = ReturnType<typeof createSearchIndexer>;
