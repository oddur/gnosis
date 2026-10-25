import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseLfsPointer, LFS_VERSION } from '../lib/git-lfs';
import { createLfsService, MAX_LFS_PREVIEW_BYTES } from '../src/git-lfs-service';
import { createGitHubClientPool, githubCacheFor } from '../lib/github-client';
import { createSnapshotFileLoader } from '../src/snapshot-file-loader';
import { createReviewImageService } from '../src/review-image-service';
import { createPrFileCache } from '../lib/pr-file-cache';
import type { PrChanges, PrFileContents } from '../lib/pr-changes';
import type { ReviewGuide } from '../lib/types';

const bytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="blue"/></svg>'
);
const pointer = { oid: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
const pointerText = `${LFS_VERSION}\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
const base = 'a'.repeat(40),
  head = 'b'.repeat(40),
  merge = 'c'.repeat(40);
function fixture() {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const downloads: { url: string; init?: RequestInit }[] = [];
  let body: Uint8Array = bytes,
    href = 'https://github-cloud.s3.amazonaws.com/object',
    missing = false;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    // eslint-disable-next-line @typescript-eslint/require-await -- asynchronous fetch mock
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname.endsWith('/objects/batch'))
        return new Response(
          JSON.stringify({
            objects: [
              {
                ...pointer,
                ...(missing
                  ? { error: { code: 404 } }
                  : { actions: { download: { href, header: { 'x-lfs-test': 'scoped' } } } }),
              },
            ],
          }),
          { headers: { 'content-type': 'application/vnd.git-lfs+json' } }
        );
      if (url.pathname.includes('/compare/'))
        return new Response(JSON.stringify({ merge_base_commit: { sha: merge } }), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response(pointerText, { headers: { 'content-type': 'application/octet-stream' } });
    }) as typeof fetch,
  });
  // eslint-disable-next-line @typescript-eslint/require-await -- asynchronous fetch mock
  const lfs = createLfsService((async (url: string | URL | Request, init?: RequestInit) => {
    downloads.push({ url: url instanceof Request ? url.url : url.toString(), init });
    return new Response(body as BodyInit);
  }) as typeof fetch);
  return {
    pool,
    lfs,
    requests,
    downloads,
    body: (value: Uint8Array) => {
      body = value;
    },
    href: (value: string) => {
      href = value;
    },
    missing: () => {
      missing = true;
    },
  };
}
void test('LFS pointers require the v1 signature, SHA-256 oid and a safe byte size', () => {
  assert.deepEqual(parseLfsPointer(pointerText), pointer);
  assert.deepEqual(parseLfsPointer(pointerText.replace(/\n/g, '\r\n')), pointer);
  for (const text of [
    'hello',
    pointerText.replace('sha256:', 'sha1:'),
    pointerText.replace(`size ${pointer.size}`, 'size -1'),
    pointerText.replace(`size ${pointer.size}`, 'size 9007199254740992'),
    pointerText + 'size 1\n',
    'x'.repeat(1025),
  ])
    assert.equal(parseLfsPointer(text), undefined);
});
void test('LFS downloads are explicit, coalesced, authenticated, account scoped and do not invalidate GitHub cache', async () => {
  const f = fixture(),
    client = f.pool.client('secret');
  const cache = githubCacheFor(client);
  assert.ok(cache);
  let revalidations = 0;
  const revalidate = cache.revalidate.bind(cache);
  cache.revalidate = () => {
    revalidations++;
    revalidate();
  };
  assert.equal(await f.lfs.remote(client, 'fork/repo', pointer, false), undefined);
  assert.equal(f.requests.length, 0);
  const [one, two] = await Promise.all([
    f.lfs.remote(client, 'fork/repo', pointer, true),
    f.lfs.remote(client, 'fork/repo', pointer, true),
  ]);
  assert.deepEqual(one, bytes);
  assert.deepEqual(two, bytes);
  assert.equal(f.requests.length, 1);
  assert.equal(f.downloads.length, 1);
  assert.equal(revalidations, 0);
  assert.equal(f.requests[0].url.href, 'https://github.com/fork/repo.git/info/lfs/objects/batch');
  assert.equal(
    new Headers(f.requests[0].init?.headers).get('authorization'),
    `Basic ${Buffer.from('x-access-token:secret').toString('base64')}`
  );
  assert.deepEqual(JSON.parse(f.requests[0].init?.body as string), {
    operation: 'download',
    transfers: ['basic'],
    objects: [pointer],
  });
  assert.equal(new Headers(f.downloads[0].init?.headers).get('authorization'), null);
  assert.equal(new Headers(f.downloads[0].init?.headers).get('x-lfs-test'), 'scoped');
  assert.equal(f.downloads[0].init?.redirect, 'error');
  assert.deepEqual(await f.lfs.remote(client, 'fork/repo', pointer, false), bytes);
  assert.equal(f.requests.length, 1);
  await f.lfs.remote(f.pool.client('other'), 'fork/repo', pointer, true);
  assert.equal(f.requests.length, 2);
});
void test('LFS verifies content, bounds downloads, rejects unsafe URLs and permits retries', async () => {
  const f = fixture(),
    client = f.pool.client('secret');
  f.body(Buffer.alloc(bytes.length));
  await assert.rejects(f.lfs.remote(client, 'o/r', pointer, true), /does not match/);
  f.body(Buffer.alloc(bytes.length + 1));
  await assert.rejects(f.lfs.remote(client, 'o/r', pointer, true), /larger than expected/);
  f.body(bytes);
  assert.deepEqual(await f.lfs.remote(client, 'o/r', pointer, true), bytes);
  const count = f.requests.length;
  await assert.rejects(f.lfs.remote(client, 'o/r', { ...pointer, size: MAX_LFS_PREVIEW_BYTES + 1 }, true), /8 MB/);
  assert.equal(f.requests.length, count);
  const unsafe = fixture();
  unsafe.href('http://127.0.0.1/private');
  await assert.rejects(unsafe.lfs.remote(unsafe.pool.client('secret'), 'o/r', pointer, true), /unsupported/);
  assert.equal(unsafe.downloads.length, 0);
  const missing = fixture();
  missing.missing();
  await assert.rejects(missing.lfs.remote(missing.pool.client('secret'), 'o/r', pointer, true), /unavailable/);
});
function snapshot(): PrChanges {
  return {
    version: 1,
    url: 'https://github.com/o/r/pull/1',
    fetchedAt: 1,
    comparisonBase: merge,
    metadata: { baseSha: base, headSha: head, baseRepo: 'o/r', headRepo: 'fork/r' } as PrChanges['metadata'],
    files: [
      { path: 'new.svg', previousPath: 'old.svg', status: 'renamed', additions: 1, deletions: 1, changeId: 'lfs' },
    ],
  };
}
void test('Changes and commits detect pointers and download pinned rename/base/fork revisions on demand', async () => {
  const f = fixture(),
    client = f.pool.client('secret'),
    load = createSnapshotFileLoader(f.lfs),
    s = snapshot();
  const req = { url: s.url, baseSha: base, headSha: head, path: 'new.svg' };
  const deferred = await load(client, req, s, s.files[0]);
  assert.deepEqual(deferred, { before: { kind: 'lfs', pointer }, after: { kind: 'lfs', pointer }, lfs: true });
  assert.equal(f.downloads.length, 0);
  const result = await load(client, { ...req, downloadLfs: true }, s, s.files[0]);
  assert.equal(result.before.kind, 'image');
  assert.equal(result.after.kind, 'image');
  assert.ok(
    f.requests.some((r) => r.url.pathname === '/repos/o/r/contents/old.svg' && r.url.searchParams.get('ref') === merge)
  );
  assert.ok(
    f.requests.some(
      (r) => r.url.pathname === '/repos/fork/r/contents/new.svg' && r.url.searchParams.get('ref') === head
    )
  );
  assert.ok(f.requests.some((r) => r.url.pathname === '/fork/r.git/info/lfs/objects/batch'));
  const calls = f.requests.length;
  assert.deepEqual(await load(client, req, s, s.files[0]), result);
  assert.equal(f.requests.length, calls, 'Downloaded contents are reused');
  // A commit comparison must use its direct parent, not the PR merge base.
  const comparison = { url: s.url, prBaseSha: base, prHeadSha: head, firstSha: head, lastSha: head };
  await load(client, { ...req, comparison }, { ...s, comparison, comparisonBase: 'd'.repeat(40) }, s.files[0]);
  assert.ok(f.requests.some((r) => r.url.searchParams.get('ref') === 'd'.repeat(40)));
});
void test('LFS text renders as text after downloading and added/deleted sides stay absent', async () => {
  const f = fixture(),
    client = f.pool.client('secret'),
    load = createSnapshotFileLoader(f.lfs),
    s = snapshot();
  s.files[0] = { ...s.files[0], path: 'data.txt', status: 'added' };
  const req = { url: s.url, baseSha: base, headSha: head, path: 'data.txt', downloadLfs: true };
  const result = await load(client, req, s, s.files[0]);
  assert.equal(result.before.kind, 'absent');
  assert.deepEqual(result.after, { kind: 'text', content: bytes.toString() });
  assert.equal(result.lfs, true);
  s.files[0] = { ...s.files[0], path: 'deleted.txt', status: 'deleted' };
  const removed = await load(client, { ...req, path: 'deleted.txt' }, s, s.files[0]);
  assert.equal(removed.after.kind, 'absent');
});
void test('Explanation images defer LFS and share downloads with inspection', async () => {
  const f = fixture(),
    client = f.pool.client('secret'),
    s = snapshot();
  const review = {
    prUrl: s.url,
    headSha: head,
    baseSha: base,
    headRepo: 'fork/r',
    slides: [],
    changedFiles: [{ filename: 'new.svg', previousFilename: 'old.svg', status: 'renamed', additions: 1, deletions: 1 }],
  } as unknown as ReviewGuide;
  const load = createReviewImageService({ loadReview: () => review, client: () => client, lfs: f.lfs });
  const deferred = await load('saved', 'new.svg');
  assert.equal(deferred.before.status, 'lfs');
  assert.equal(deferred.after.status, 'lfs');
  assert.equal(f.downloads.length, 0);
  const result = await load('saved', 'new.svg', true);
  assert.equal(result.before.status, 'ready');
  assert.equal(result.after.status, 'ready');
  const downloads = f.downloads.length;
  await createSnapshotFileLoader(f.lfs)(
    client,
    { url: s.url, baseSha: base, headSha: head, path: 'new.svg' },
    s,
    s.files[0]
  );
  assert.equal(f.downloads.length, downloads);
});
void test('Renderer cache does not let a slower pointer read replace a downloaded resource', async () => {
  let finish: (v: PrFileContents) => void = () => {};
  const pointerResult: PrFileContents = { before: { kind: 'absent' }, after: { kind: 'lfs', pointer }, lfs: true };
  const ready: PrFileContents = {
    before: { kind: 'absent' },
    after: { kind: 'image', dataUrl: 'data:image/svg+xml;base64,AA==' },
    lfs: true,
  };
  const cache = createPrFileCache((r) =>
    r.downloadLfs
      ? Promise.resolve(ready)
      : new Promise((resolve) => {
          finish = resolve;
        })
  );
  const req = { url: 'https://github.com/o/r/pull/1', baseSha: base, headSha: head, path: 'image.svg' };
  const background = cache.read(req, true);
  await cache.read({ ...req, downloadLfs: true });
  finish(pointerResult);
  assert.deepEqual(await background, ready);
  assert.deepEqual(cache.peek(req), ready);
});
let hasLfs = true;
try {
  execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
} catch {
  hasLfs = false;
}
void test('Local LFS previews use the exact object without modifying the working tree', { skip: !hasLfs }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-lfs-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    const objectDir = path.join(dir, '.git/lfs/objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4));
    fs.mkdirSync(objectDir, { recursive: true });
    fs.writeFileSync(path.join(objectDir, pointer.oid), bytes);
    fs.writeFileSync(path.join(dir, 'image.svg'), pointerText);
    const lfs = createLfsService();
    assert.equal(await lfs.local(dir, pointer, false), undefined);
    assert.deepEqual(await lfs.local(dir, pointer, true), bytes);
    assert.equal(fs.readFileSync(path.join(dir, 'image.svg'), 'utf8'), pointerText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('Saved explanations preview LFS text and preserve failed downloads for retry', async () => {
  const f = fixture(),
    client = f.pool.client('secret');
  const review = {
    prUrl: 'https://github.com/o/r/pull/1',
    headSha: head,
    baseSha: base,
    slides: [{ diffHunks: [{ filePath: 'data.txt', content: '+' + pointerText }] }],
    changedFiles: [{ filename: 'data.txt', status: 'added', additions: 3, deletions: 0 }],
  } as unknown as ReviewGuide;
  const load = createReviewImageService({ loadReview: () => review, client: () => client, lfs: f.lfs });
  const deferred = await load('saved', 'data.txt');
  assert.equal(deferred.after.status, 'lfs');
  f.body(Buffer.alloc(bytes.length));
  const failed = await load('saved', 'data.txt', true);
  assert.equal(failed.after.status, 'lfs');
  assert.match(failed.after.error ?? '', /does not match/);
  f.body(bytes);
  const result = await load('saved', 'data.txt', true);
  assert.equal(result.before.status, 'absent');
  assert.deepEqual(result.after, { status: 'text', content: bytes.toString(), path: 'data.txt', revision: head });
});
