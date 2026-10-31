import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchDocuments, queueDocuments, reviewDocuments, threadDocuments } from '../lib/command-search';
import { createCommandSearchService } from '../src/command-search-service';
import type { WorkbenchQueue } from '../lib/workbench';
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
void test('searches deep saved content, ranks exact titles and preserves destinations', () => {
  const docs = reviewDocuments(review, entry, queue);
  const hits = searchDocuments(docs, 'semaphore.release');
  assert.equal(hits[0].document.kind, 'file');
  assert.deepEqual(hits[0].document.destination, {
    kind: 'review',
    reviewId: 'saved',
    slideId: 'topic-1',
    filePath: 'src/queue.ts',
  });
  assert.equal(searchDocuments(docs, 'DO NOT INDEX THIS HTML').length, 0);
  assert.equal(searchDocuments(docs, 'Release queue slots')[0].document.kind, 'topic');
  assert.equal(
    searchDocuments(docs, 'starvation').some((h) => h.document.kind === 'insight'),
    true
  );
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
void test('disk-only service tolerates missing reviews, invalidates account state, and retains history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-'));
  let account = 'maya';
  try {
    await fs.writeFile(path.join(dir, 'saved.json'), JSON.stringify(review));
    const service = createCommandSearchService({
      directory: () => dir,
      queue: () => queue,
      history: () => [entry, { ...entry, id: 'missing' }],
      account: () => account,
      ignoreBots: () => true,
      threads: () => undefined,
    });
    const result = await service.search('cancellation');
    assert.ok(result.hits.length >= 2);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.account, 'maya');
    account = 'sam';
    assert.equal((await service.search('semaphore')).account, 'sam');
    const recent = await service.search('', false, ['file:saved:topic-1:src/queue.ts']);
    assert.equal(recent.hits[0].document.kind, 'file');
    await assert.rejects(service.search('x'.repeat(1001)), /1,000/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
void test('cached comment matches point to the saved file and exact thread', () => {
  const docs = reviewDocuments(review, entry, queue);
  const threads = {
    headSha: 'head',
    baseSha: 'base',
    threads: [
      {
        id: 'thread',
        path: 'src/queue.ts',
        line: 1,
        diffSide: 'RIGHT',
        comments: [
          {
            id: 'comment',
            body: 'Will this wake a waiter?',
            author: { login: 'sam' },
            url: entry.prUrl + '#discussion_r1',
          },
        ],
      },
    ],
  } as Parameters<typeof threadDocuments>[1];
  const result = threadDocuments(entry.prUrl, threads, docs);
  assert.equal(result[0].kind, 'comment');
  assert.deepEqual(result[0].destination, {
    kind: 'review',
    reviewId: 'saved',
    slideId: 'topic-1',
    filePath: 'src/queue.ts',
    line: 1,
    side: 'RIGHT',
    threadId: 'thread',
  });
  assert.equal(queueDocuments(queue).length, 0);
});

void test('stack comments and inline insights retain the exact member for repeated paths', () => {
  const members = [41, 42].map((number) => ({
    number,
    repo: 'acme/core',
    url: `https://github.com/acme/core/pull/${number}`,
    author: 'maya',
  }));
  const stacked = {
    ...review,
    snapshot: { subject: { id: 'stack', kind: 'stack', title: 'Queue stack', members } },
    slides: [
      {
        ...review.slides[0],
        affectedFiles: [],
        diffHunks: members.map((m) => ({
          ...review.slides[0].diffHunks[0],
          filePath: `PR-acme~core-${m.number}/src/queue.ts`,
        })),
        inlineExplanations: [{ ...review.slides[0].inlineExplanations?.[0], filePath: 'PR-acme~core-42/src/queue.ts' }],
      },
    ],
  } as unknown as ReviewGuide;
  const docs = reviewDocuments(stacked, entry, queue);
  const threads = {
    headSha: 'head',
    baseSha: 'base',
    threads: [
      {
        id: 'thread42',
        path: 'src/queue.ts',
        line: 1,
        diffSide: 'RIGHT',
        comments: [{ id: 'comment42', body: 'Second PR only', author: { login: 'sam' } }],
      },
    ],
  } as Parameters<typeof threadDocuments>[1];
  const comment = threadDocuments(members[1].url, threads, docs)[0];
  assert.equal(comment.source, 'acme/core #42');
  assert.equal(comment.destination.kind === 'review' && comment.destination.filePath, 'PR-acme~core-42/src/queue.ts');
  assert.equal(docs.find((d) => d.kind === 'insight')?.source, 'acme/core #42');
});

void test('search includes existing account HTTP snapshots outside the queue without fetching', async () => {
  const { cachedGitHubDocuments } = await import('../src/command-search-service');
  const snapshots = [
    {
      url: 'https://api.github.com/repos/acme/core/pulls/99',
      data: { title: 'An opened PR', body: 'Preserve cancellation', user: { login: 'maya' }, state: 'open' },
    },
    {
      url: 'https://api.github.com/repos/acme/core/pulls/99/files?page=1',
      data: [{ filename: 'cancel.ts', patch: '+ abort();' }],
    },
    {
      url: 'https://api.github.com/repos/acme/core/issues/99/comments',
      data: [{ id: 5, body: 'Is this idempotent?' }],
    },
    { url: 'https://api.github.com/repos/acme/core/pulls/100', data: 'not metadata' },
  ];
  const docs = cachedGitHubDocuments(snapshots, []);
  assert.equal(docs.length, 3);
  assert.equal(searchDocuments(docs, 'abort')[0].document.kind, 'file');
  assert.equal(searchDocuments(docs, 'idempotent')[0].document.kind, 'comment');
  assert.equal(searchDocuments(docs, '#99')[0].document.kind, 'pr');
  assert.deepEqual(docs[0].destination, { kind: 'home', url: 'https://github.com/acme/core/pull/99' });
});

void test('an account switch during disk indexing cannot return the previous queue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-search-race-'));
  let account = 'maya';
  try {
    await fs.writeFile(path.join(dir, 'saved.json'), JSON.stringify(review));
    const service = createCommandSearchService({
      directory: () => dir,
      queue: () => queue,
      history: () => (account === 'maya' ? [entry] : []),
      account: () => account,
      ignoreBots: () => true,
      threads: () => undefined,
    });
    const pending = service.search('semaphore');
    account = 'sam';
    const result = await pending;
    assert.equal(result.account, 'sam');
    assert.deepEqual(result.hits, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('previews deduplicate stack descriptions and keep code separate from prose',()=>{
  const member={description:'Keep requests bounded.',author:'maya',repo:'acme/core',labels:[],state:'open',title:'Queue'};
  const stack={items:[{subject:{id:'stack-preview',title:'Queue stack',kind:'stack',members:[{...member,number:1},{...member,number:2,description:' Keep requests   bounded. '}],edges:[],warnings:[]},attention:'other'}],warnings:[],remaining:0} as unknown as WorkbenchQueue;
  const doc=queueDocuments(stack)[0];
  assert.equal(doc.preview,'Keep requests bounded.');
  assert.ok(doc.text.includes('Keep requests   bounded.'),'Search retains each source description');
  const file=searchDocuments(reviewDocuments(review,entry,queue),'semaphore')[0];
  assert.equal(file.codeSnippet,'+ semaphore.release();');
});


void test('worker search reads saved files, persists its index and isolates accounts and current mutes', async () => {
  const { createAppDataStore } = await import('../src/app-data-store');
  const { createWorkerCommandSearchService } = await import('../src/command-search-service');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'gnosis-worker-search-'));
  const storage=createAppDataStore();
  let muted=new Set<string>(), account='maya';
  try {
    await fs.writeFile(path.join(dir,'saved.json'),JSON.stringify(review));
    await storage.open(dir);
    const service=createWorkerCommandSearchService({directory:()=>dir,queue:()=>queue,history:()=>[entry],
      account:()=>account,ignoreBots:()=>true,threads:()=>undefined,mutedUrls:()=>muted},request=>storage.search(request));
    const first=await service.search('semaphore.release');
    assert.equal(first.hits[0].document.kind,'file');
    assert.equal(first.hits[0].document.text.includes('DO NOT INDEX THIS HTML'),false);
    muted=new Set([entry.prUrl]);
    assert.equal((await service.search('semaphore')).hits.length,0);
    account='sam'; muted=new Set();
    assert.equal((await service.search('semaphore')).account,'sam');
    assert.ok((await service.search('rqslots')).hits.length>0);
  } finally {await storage.close();await fs.rm(dir,{recursive:true,force:true});}
});

void test('repository Dependabot rules apply to cached reviews and update without a network request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-repo-search-'));
  let ignoreBots = true;
  let repositoryBotSettings: Record<string, boolean> = { 'acme/core': false };
  try {
    const botReview = { ...review, author: 'dependabot[bot]' };
    await fs.writeFile(path.join(dir, 'saved.json'), JSON.stringify(botReview));
    const service = createCommandSearchService({ directory: () => dir, queue: () => queue,
      history: () => [{ ...entry, author: 'dependabot[bot]' }], account: () => 'maya',
      ignoreBots: () => ignoreBots, repositoryBotSettings: () => repositoryBotSettings, threads: () => undefined });
    assert.ok((await service.search('cancellation')).hits.length > 0);
    ignoreBots = false; repositoryBotSettings = { 'acme/core': true };
    assert.equal((await service.search('cancellation')).hits.length, 0);
    assert.ok((await service.search('cancellation', true)).hits.length > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
