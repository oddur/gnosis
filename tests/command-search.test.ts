import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { searchDocuments, queueDocuments, reviewDocuments, threadDocuments, boundDocument, subjectDocuments, hydrateDestination } from '../lib/command-search';
import { createSearchIndexer, httpDocuments } from '../src/command-search-service';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import { localSearchBackend } from './fixtures/search-backend';
import type { ReviewGuide, ReviewHistoryEntry } from '../lib/types';

const entry: ReviewHistoryEntry = {
  id: 'saved',
  prTitle: 'Queue scheduling',
  prUrl: 'https://github.com/acme/core/pull/42',
  author: 'maya',
  riskLevel: 'low',
  savedAt: '2026-10-24T00:00:00Z',
  status: 'completed',
};
const review = {
  riskLevel: 'low',
  totalFilesChanged: 1,
  totalLinesChanged: 1,
  prTitle: entry.prTitle,
  prUrl: entry.prUrl,
  prDescription: 'Bound requests',
  author: 'maya',
  summary: 'Avoid starvation',
  riskRationale: 'Ordering matters',
  slides: [
    {
      id: 'topic-1',
      slideNumber: 1,
      slideType: 'foundation',
      dependsOn: [],
      title: 'Release queue slots',
      narrative: 'Cancellation releases acquired slots',
      reviewFocus: null,
      affectedFiles: ['src/queue.ts'],
      contextSnippets: [],
      educationNotes: [],
      diffHunks: [
        {
          filePath: 'src/queue.ts',
          content: '+ semaphore.release();',
          hunkHeader: '@@ -1 +1 @@',
          language: 'typescript',
          renderedHtml: 'DO NOT INDEX THIS HTML',
        },
      ],
      inlineExplanations: [
        {
          filePath: 'src/queue.ts',
          line: 1,
          side: 'RIGHT',
          code: 'semaphore.release();',
          text: 'Release on cancellation prevents starvation',
        },
      ],
    },
  ],
} as ReviewGuide;
const queue: WorkbenchQueue = { items: [], warnings: [], remaining: 0 };
const member = (number: number, extra: Partial<ReviewMember> = {}) =>
  ({
    url: `https://github.com/acme/core/pull/${number}`, number, repo: 'acme/core', title: `Change ${number}`, author: 'maya',
    labels: ['perf'], description: 'Describe the change', baseBranch: 'main', headBranch: `feature-${number}`, state: 'open',
    merged: false, isDraft: false, ...extra,
  }) as ReviewMember;
const item = (id: string, members: ReviewMember[], kind: 'pr' | 'stack' = members.length > 1 ? 'stack' : 'pr'): QueueItem =>
  ({ attention: 'other', subject: { id, kind, title: `Subject ${id}`, members, edges: [], warnings: [] } }) as unknown as QueueItem;

void test('searches saved content by path and prose, ranks exact titles and preserves destinations', () => {
  const docs = reviewDocuments(review, entry, queue);
  const hits = searchDocuments(docs, 'src/queue.ts');
  assert.equal(hits[0].document.kind, 'file');
  assert.deepEqual(hits[0].document.destination, { kind: 'review', reviewId: 'saved', slideId: 'topic-1', filePath: 'src/queue.ts' });
  assert.equal(searchDocuments(docs, 'semaphore.release').length, 0, 'diff contents are not searchable');
  assert.equal(searchDocuments(docs, 'DO NOT INDEX THIS HTML').length, 0);
  assert.equal(searchDocuments(docs, 'Release queue slots')[0].document.kind, 'topic');
  assert.equal(searchDocuments(docs, 'starvation').some((h) => h.document.kind === 'insight'), true);
  assert.equal(searchDocuments(docs, 'rqslots')[0].document.kind, 'topic');
});
void test('bot exclusion is explicit and does not alter the underlying index', () => {
  const docs = reviewDocuments(review, entry, queue).map((d) => ({ ...d, bot: true }));
  assert.equal(searchDocuments(docs, 'queue').length, 0);
  assert.ok(searchDocuments(docs, 'queue', true).length > 0);
});
void test('exact PR number and repo-qualified number rank ahead of body mentions', () => {
  const [doc] = reviewDocuments(review, entry, queue);
  const pr = { ...doc, id: 'pr:42', kind: 'pr' as const, source: 'acme/core #42' };
  assert.equal(searchDocuments([doc, pr], '#42')[0].document.id, 'pr:42');
  assert.equal(searchDocuments([doc, pr], 'acme/core#42')[0].document.id, 'pr:42');
});
void test('cached comment matches point to the saved file and exact thread', () => {
  const docs = reviewDocuments(review, entry, queue);
  const threads = {
    headSha: 'head', baseSha: 'base',
    threads: [{ id: 'thread', path: 'src/queue.ts', line: 1, diffSide: 'RIGHT', comments: [{ id: 'comment', body: 'Will this wake a waiter?', author: { login: 'sam' }, url: entry.prUrl + '#discussion_r1' }] }],
  } as Parameters<typeof threadDocuments>[1];
  const result = threadDocuments(entry.prUrl, threads, docs);
  assert.equal(result[0].kind, 'comment');
  assert.deepEqual(result[0].destination, { kind: 'review', reviewId: 'saved', slideId: 'topic-1', filePath: 'src/queue.ts', line: 1, side: 'RIGHT', threadId: 'thread' });
  assert.equal(queueDocuments(queue).length, 0);
});
void test('stack comments and inline insights retain the exact member for repeated paths', () => {
  const members = [41, 42].map((number) => ({ number, repo: 'acme/core', url: `https://github.com/acme/core/pull/${number}`, author: 'maya' }));
  const stacked = {
    ...review,
    snapshot: { subject: { id: 'stack', kind: 'stack', title: 'Queue stack', members } },
    slides: [{
      ...review.slides[0], affectedFiles: [],
      diffHunks: members.map((m) => ({ ...review.slides[0].diffHunks[0], filePath: `PR-acme~core-${m.number}/src/queue.ts` })),
      inlineExplanations: [{ ...review.slides[0].inlineExplanations?.[0], filePath: 'PR-acme~core-42/src/queue.ts' }],
    }],
  } as unknown as ReviewGuide;
  const docs = reviewDocuments(stacked, entry, queue);
  const threads = {
    headSha: 'head', baseSha: 'base',
    threads: [{ id: 'thread42', path: 'src/queue.ts', line: 1, diffSide: 'RIGHT', comments: [{ id: 'comment42', body: 'Second PR only', author: { login: 'sam' } }] }],
  } as Parameters<typeof threadDocuments>[1];
  const comment = threadDocuments(members[1].url, threads, docs)[0];
  assert.equal(comment.source, 'acme/core #42');
  assert.equal(comment.destination.kind === 'review' && comment.destination.filePath, 'PR-acme~core-42/src/queue.ts');
  assert.equal(docs.find((d) => d.kind === 'insight')?.source, 'acme/core #42');
});
void test('cached HTTP responses build self-contained documents without patches', () => {
  const docs = [
    { url: 'https://api.github.com/repos/acme/core/pulls/99', data: { title: 'An opened PR', body: 'Preserve cancellation', user: { login: 'maya' }, state: 'open' } },
    { url: 'https://api.github.com/repos/acme/core/pulls/99/files?page=1', data: [{ filename: 'cancel.ts', patch: '+ abort();' }] },
    { url: 'https://api.github.com/repos/acme/core/issues/99/comments', data: [{ id: 5, body: 'Is this idempotent?' }] },
    { url: 'https://api.github.com/repos/acme/core/pulls/100', data: 'not metadata' },
  ].flatMap(httpDocuments);
  assert.equal(docs.length, 3);
  assert.equal(searchDocuments(docs, 'cancel.ts')[0].document.kind, 'file');
  assert.equal(searchDocuments(docs, 'abort').length, 0, 'patches are not searchable');
  assert.equal(searchDocuments(docs, 'idempotent')[0].document.kind, 'comment');
  assert.equal(searchDocuments(docs, '#99')[0].document.kind, 'pr');
  assert.deepEqual(docs[0].destination, { kind: 'home', url: 'https://github.com/acme/core/pull/99' });
  assert.ok(docs.every((d) => d.groupId === 'https://github.com/acme/core/pull/99'));
});
void test('previews deduplicate stack descriptions', () => {
  const m = { description: 'Keep requests bounded.', author: 'maya', repo: 'acme/core', labels: [], state: 'open', title: 'Queue' };
  const stack = { items: [{ subject: { id: 'stack-preview', title: 'Queue stack', kind: 'stack', members: [{ ...m, number: 1 }, { ...m, number: 2, description: ' Keep requests   bounded. ' }], edges: [], warnings: [] }, attention: 'other' }], warnings: [], remaining: 0 } as unknown as WorkbenchQueue;
  const doc = queueDocuments(stack)[0];
  assert.equal(doc.preview, 'Keep requests bounded.');
  assert.ok(doc.text.includes('Keep requests bounded.'));
});

void test('bounds every document to 600 text characters and stores no code', () => {
  const long = 'word '.repeat(2000);
  const big = {
    ...review,
    prDescription: long,
    slides: [{ ...review.slides[0], title: 't'.repeat(1000), narrative: long, fileSummaries: [{ filePath: 'src/queue.ts', summary: long }],
      diffHunks: [{ ...review.slides[0].diffHunks[0], content: long }] }],
  } as unknown as ReviewGuide;
  const queued = { items: [item('one', [member(1, { description: long, title: 'x'.repeat(800) })])], warnings: [], remaining: 0 } as WorkbenchQueue;
  const docs = [...reviewDocuments(big, entry), ...queueDocuments(queued),
    ...httpDocuments({ url: 'https://api.github.com/repos/a/b/pulls/1', data: { title: 'T', body: long } })];
  for (const doc of docs) {
    assert.ok(doc.text.length <= 600, doc.id);
    assert.ok(doc.title.length <= 300, doc.id);
    assert.ok((doc.preview ?? '').length <= 300, doc.id);
    assert.equal('code' in doc, false, doc.id);
    assert.ok(!/\s{2}/.test(doc.text), 'whitespace is collapsed');
  }
  assert.equal(boundDocument({ ...docs[0], text: '😀'.repeat(400) }).text.length % 2, 0, 'never splits a surrogate pair');
});

void test('keeps labels and branches when the description is truncated', () => {
  const [doc] = subjectDocuments(item('one', [member(7, { description: 'filler '.repeat(500), labels: ['needs-design'], headBranch: 'perf/bounded-search' })]));
  assert.ok(doc.text.length <= 600);
  for (const term of ['needs-design', 'perf/bounded-search', 'main', 'acme/core #7']) assert.ok(doc.text.includes(term), term);
  assert.equal(searchDocuments([doc], 'needs-design').length, 1);
});

const harness = (state: { queue: WorkbenchQueue; history?: ReviewHistoryEntry[]; muted?: Set<string>; account?: string; dir?: string }) => {
  const db = new DatabaseSync(':memory:');
  const backend = localSearchBackend(db);
  const indexer = createSearchIndexer({
    backend,
    account: () => state.account ?? 'maya',
    directory: () => state.dir ?? os.tmpdir(),
    queue: () => state.queue,
    history: () => state.history ?? [],
    threads: () => undefined,
    mutedUrls: () => state.muted ?? new Set(),
    ignoreBots: () => true,
    timing: { queue: 1, quiet: 1, max: 5 },
  });
  return { db, backend, indexer };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

void test('applies only changed feeds and removes dropped feeds', async () => {
  const state = { queue: { items: [item('one', [member(1)]), item('two', [member(2)])], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, backend, indexer } = harness(state);
  try {
    await indexer.start();
    const feeds = () => backend.applied.flat().map((op) => ('remove' in op ? `-${op.feed}` : op.feed)).sort();
    assert.deepEqual(feeds(), ['queue:meta', 'queue:one', 'queue:two']);
    backend.applied.length = 0;
    state.queue = { ...state.queue, items: [{ ...state.queue.items[0] }, item('three', [member(3, { title: 'A new title' })])] };
    indexer.queueChanged();
    await settle();
    await indexer.flush();
    assert.deepEqual(feeds(), ['-queue:two', 'queue:three'], 'an unchanged entry is not sent again');
    assert.equal((await indexer.search('A new title')).hits[0].document.id, 'subject:three');
    assert.equal((await indexer.search('Change 2')).hits.length, 0);
  } finally {
    db.close();
  }
});

void test('does not resend an evicted unchanged feed', async () => {
  const state = { queue: { items: [], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, backend, indexer } = harness(state);
  try {
    await indexer.start();
    const cached = { response: { status: 200, url: 'https://api.github.com/repos/acme/core/pulls/5', headers: {}, data: { title: 'Cached five', body: '' } }, freshUntil: 0 };
    indexer.cacheChanged({ scope: 's', id: 's:five', value: cached });
    await indexer.flush();
    db.exec('DELETE FROM search_docs'); // as if the cap evicted it
    backend.applied.length = 0;
    indexer.cacheChanged({ scope: 's', id: 's:five', value: structuredClone(cached) });
    await indexer.flush();
    assert.deepEqual(backend.applied, []);
    // A restarted indexer seeds the same hashes from the worker.
    const again = createSearchIndexer({ backend, account: () => 'maya', directory: () => '', queue: () => state.queue, history: () => [],
      threads: () => undefined, mutedUrls: () => new Set(), ignoreBots: () => true });
    again.cacheChanged({ scope: 's', id: 's:five', value: structuredClone(cached) });
    await again.flush();
    assert.deepEqual(backend.applied, []);
    indexer.cacheChanged({ scope: 's', id: 's:five' });
    await indexer.flush();
    assert.deepEqual(backend.applied.flat(), [{ feed: 'http:s:five', remove: true }]);
  } finally {
    db.close();
  }
});

void test('indexes the response as it was cached, even if the caller changes its object before the flush', async () => {
  const state = { queue: { items: [], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, indexer } = harness(state);
  try {
    await indexer.start();
    const cached = { response: { status: 200, url: 'https://api.github.com/repos/acme/core/pulls/6', headers: {}, data: { title: 'Original six', body: '' } }, freshUntil: 0 };
    indexer.cacheChanged({ scope: 's', id: 's:six', value: cached });
    cached.response.data.title = 'Edited after caching';
    await indexer.flush();
    assert.equal((await indexer.search('Original six')).hits.length, 1);
    assert.equal((await indexer.search('Edited after caching')).hits.length, 0);
  } finally {
    db.close();
  }
});

void test('hides a cached PR when the queue has the same URL', async () => {
  const state = { queue: { items: [item('stack', [member(1), member(2)])], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, indexer } = harness(state);
  try {
    await indexer.start();
    for (const [n, title] of [[2, 'Change 2'], [9, 'Change 9']] as const)
      indexer.cacheChanged({ scope: 's', id: `s:${n}`, value: { response: { status: 200, url: `https://api.github.com/repos/acme/core/pulls/${n}`, data: { title, body: 'b' } } } });
    indexer.cacheChanged({ scope: 's', id: 's:c', value: { response: { status: 200, url: 'https://api.github.com/repos/acme/core/issues/2/comments', data: [{ id: 1, body: 'Grouped comment' }] } } });
    const two = (await indexer.search('Change 2')).hits.map((h) => h.document.id);
    assert.ok(two.includes('subject:https://github.com/acme/core/pull/2'));
    assert.ok(!two.includes('cached:https://github.com/acme/core/pull/2'), 'the queue document wins');
    assert.deepEqual((await indexer.search('Change 9')).hits.map((h) => h.document.id), ['cached:https://github.com/acme/core/pull/9']);
    assert.equal((await indexer.search('Grouped comment')).hits[0].document.groupId, 'stack', 'joins the queue group');
  } finally {
    db.close();
  }
});

void test('hydrates stack member destinations from the current queue', async () => {
  const members = [member(1), member(2)];
  const state = { queue: { items: [item('stack', members)], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, indexer } = harness(state);
  try {
    await indexer.start();
    const stored = db.prepare("SELECT payload FROM search_docs WHERE id='subject:https://github.com/acme/core/pull/2'").get();
    assert.deepEqual((JSON.parse(String(stored?.payload)) as { destination: unknown }).destination,
      { kind: 'home', subjectId: 'stack', focusUrl: members[1].url }, 'no queue snapshot is stored');
    const hit = (await indexer.search('#2')).hits[0];
    assert.equal(hit.document.destination.kind === 'home' && hit.document.destination.subject?.subject.id, members[1].url);
    assert.equal(hit.document.destination.kind === 'home' && hit.document.destination.subject?.parentStack?.id, 'stack');
    const whole = (await indexer.search('Subject stack')).hits[0];
    assert.equal(whole.document.destination.kind === 'home' && whole.document.destination.subject?.subject.id, 'stack');
    // A document whose subject has left the queue opens its PR by URL.
    const gone = hydrateDestination({ ...hit.document, destination: { kind: 'home', subjectId: 'gone', focusUrl: members[1].url } }, () => undefined);
    assert.deepEqual(gone, { kind: 'home', url: members[1].url });
  } finally {
    db.close();
  }
});

void test('filters muted and bot documents at query time', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-mute-'));
  const muted = new Set<string>();
  const bot = member(3, { author: 'dependabot[bot]', title: 'Bump queue lib' });
  const state = { dir, muted, history: [entry], queue: { items: [item('stack', [member(41), member(42)]), item('bot', [bot])], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, backend, indexer } = harness(state);
  try {
    await fs.writeFile(path.join(dir, 'saved.json'), JSON.stringify(review));
    await indexer.start();
    assert.ok((await indexer.search('cancellation')).hits.length >= 1);
    assert.ok((await indexer.search('Change 41')).hits.length >= 1);
    const applies = backend.applied.length;
    muted.add('https://github.com/acme/core/pull/42');
    assert.equal((await indexer.search('Change 41')).hits.length, 0, 'muting one member hides its stack');
    muted.add(entry.prUrl);
    assert.equal((await indexer.search('cancellation')).hits.length, 0);
    assert.equal(backend.applied.length, applies, 'mutes need no reindex');
    assert.equal((await indexer.search('Bump queue')).hits.length, 0);
    assert.equal((await indexer.search('Bump queue', true)).hits.length, 1);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('first search waits for the first build and posts no cached responses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-first-'));
  const db = new DatabaseSync(':memory:');
  try {
    await fs.writeFile(path.join(dir, 'saved.json'), JSON.stringify(review));
    const backend = localSearchBackend(db);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    let cachedReads = 0;
    const indexer = createSearchIndexer({
      backend, ready: () => ready, account: () => 'maya', directory: () => dir,
      queue: () => ({ items: [item('one', [member(1)])], warnings: [], remaining: 0 }),
      history: () => [entry, { ...entry, id: 'missing' }],
      threads: () => { cachedReads++; return undefined; },
      mutedUrls: () => new Set(), ignoreBots: () => true,
    });
    const pending = indexer.search('cancellation');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(backend.searches, 0, 'waits for the build');
    release();
    const result = await pending;
    assert.ok(result.hits.length >= 1);
    assert.equal(result.warnings.length, 1);
    const posted = JSON.stringify(backend.applied);
    assert.ok(!posted.includes('responses') && !posted.includes('semaphore.release'), 'no cached responses or diffs are posted');
    assert.ok(cachedReads <= 2, 'thread reads happen once, in the first build');
    await indexer.search('cancel');
    assert.ok(cachedReads <= 2);
    await assert.rejects(indexer.search('x'.repeat(1001)), /1,000/);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('an account switch during indexing cannot return the previous account', async () => {
  const state = { account: 'maya', queue: { items: [item('one', [member(1)])], warnings: [], remaining: 0 } as WorkbenchQueue };
  const { db, indexer } = harness(state);
  try {
    const pending = indexer.search('Change 1');
    state.account = 'sam';
    const result = await pending;
    assert.equal(result.account, 'sam');
    assert.deepEqual(result.hits, []);
    assert.equal((await indexer.search('Change 1')).account, 'sam');
  } finally {
    db.close();
  }
});
