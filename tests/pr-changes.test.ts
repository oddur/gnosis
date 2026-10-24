import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from '../lib/github-client';
import { createPrChangesService } from '../src/pr-changes-service';
import { fileRevisionKey } from '../lib/pr-changes';
import { registerChangeProgress, markFileViewed, isFileViewed } from '../lib/file-view-progress';
const url = 'https://github.com/o/r/pull/1';
function fixture() {
  const reads: URL[] = [];
  let head = 'head1',
    unstable = false,
    incomplete = false,
    failContent = false;
  const files = [
    { filename: 'src/new.ts', status: 'added', sha: 'new', patch: '@@ +1 @@\n+new', additions: 1, deletions: 0 },
    { filename: 'src/old.ts', status: 'removed', sha: 'old', patch: '@@ -1 @@\n-old', additions: 0, deletions: 1 },
    {
      filename: 'art/new.svg',
      previous_filename: 'art/old.svg',
      status: 'renamed',
      sha: 'svg',
      patch: '@@ -1 +1 @@\n-old\n+new',
      additions: 1,
      deletions: 1,
    },
    {
      filename: 'pnpm-lock.yaml',
      status: 'modified',
      sha: 'lock',
      patch: '@@ -1 +1 @@\n-old\n+new',
      additions: 1,
      deletions: 1,
    },
  ];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (input: string) => {
      const u = new URL(input);
      reads.push(u);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
        });
      if (u.pathname.endsWith('/files')) return json(files);
      if (u.pathname.includes('/compare/')) {
        if (unstable) head = 'moved';
        return json({ merge_base_commit: { sha: 'merge-base' } });
      }
      if (u.pathname.includes('/contents/')) {
        if (failContent)
          return new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(u.pathname.endsWith('.svg') ? '<svg/>' : 'const value = 1;\n', {
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return json({
        title: 'PR',
        body: 'Description',
        user: { login: 'dev' },
        base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: head, repo: { full_name: 'fork/r' } },
        state: 'open',
        labels: [],
        changed_files: incomplete ? 3001 : files.length,
      });
    }) as typeof fetch,
  });
  return {
    pool,
    reads,
    files,
    move: (v: string) => (head = v),
    unstable: () => (unstable = true),
    incomplete: () => (incomplete = true),
    failContent: () => (failContent = true),
  };
}
void test('Changes is cached, complete, account scoped, and pins content to merge base and fork head', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  const [a, b] = await Promise.all([service.manifest(client, url), service.manifest(client, url)]);
  assert.deepEqual(a, b);
  assert.equal(a.files.length, 4);
  assert.equal(a.files[1].status, 'deleted');
  const calls = f.reads.length;
  await createPrChangesService().manifest(client, url);
  assert.equal(f.reads.length, calls, 'snapshot reuse requires no API requests');
  const request = { url, path: 'art/new.svg', baseSha: 'base', headSha: 'head1' };
  const image = await service.content(client, request);
  assert.equal(image.before.kind, 'image');
  assert.ok(
    f.reads.some(
      (u) =>
        decodeURIComponent(u.pathname).endsWith('/o/r/contents/art/old.svg') &&
        u.searchParams.get('ref') === 'merge-base'
    )
  );
  assert.ok(
    f.reads.some(
      (u) =>
        decodeURIComponent(u.pathname).endsWith('/fork/r/contents/art/new.svg') && u.searchParams.get('ref') === 'head1'
    )
  );
  const count = f.reads.length;
  await service.content(client, request);
  assert.equal(f.reads.length, count);
  await assert.rejects(service.content(f.pool.client('two'), request), /Reload/);
  f.move('head2');
  assert.equal((await service.manifest(client, url)).metadata.headSha, 'head1');
  assert.equal((await service.manifest(client, url, true)).metadata.headSha, 'head2');
  assert.equal((await service.content(client, request)).before.kind, 'image', 'pinned prior revisions remain readable');
});
void test('additions and deletions have genuinely absent sides; request failures never become empty files', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  await service.manifest(client, url);
  const request = { url, baseSha: 'base', headSha: 'head1' };
  const added = await service.content(client, { ...request, path: 'src/new.ts' });
  assert.equal(added.before.kind, 'absent');
  assert.equal(added.after.kind, 'text');
  const removed = await service.content(client, { ...request, path: 'src/old.ts' });
  assert.equal(removed.after.kind, 'absent');
  assert.equal(removed.before.kind, 'text');
  f.failContent();
  await assert.rejects(service.content(client, { ...request, path: 'pnpm-lock.yaml' }));
  await assert.rejects(service.content(client, { ...request, path: 'not-listed.ts' }), /Reload/);
});
void test('incomplete inventories and mid-load commit changes are rejected', async () => {
  const f = fixture();
  f.incomplete();
  await assert.rejects(createPrChangesService().manifest(f.pool.client('one'), url), /incomplete/);
  const g = fixture();
  g.unstable();
  await assert.rejects(createPrChangesService().manifest(g.pool.client('one'), url), /changed while/);
});
void test('Viewed is shared by revision, retained only for unchanged content, and isolated across stack members', async () => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) },
  });
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  const first = await service.manifest(client, url);
  const key = (u: string, p: string, h: string) => fileRevisionKey(u, p, 'base', h);
  markFileViewed(key(url, 'src/new.ts', 'head1'), true);
  registerChangeProgress(first);
  f.move('head2');
  f.files[1].patch += 'changed';
  const next = await service.manifest(client, url, true);
  markFileViewed(key(url, 'src/old.ts', 'head1'), true);
  registerChangeProgress(next);
  assert.equal(isFileViewed(key(url, 'src/new.ts', 'head2')), true);
  assert.equal(isFileViewed(key(url, 'src/old.ts', 'head2')), false);
  assert.equal(isFileViewed(key(url + '2', 'src/new.ts', 'head2')), false);
  markFileViewed(key(url, 'src/new.ts', 'head2'), false);
  assert.equal(isFileViewed(key(url, 'src/new.ts', 'head1')), false);
});

void test('cached inventories and opened contents survive a process restart without network access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-changes-cache-'));
  try {
    const f = fixture();
    f.pool.setStorage(path.join(dir, 'github-state.json'));
    const service = createPrChangesService(),
      client = f.pool.client('one');
    const saved = await service.manifest(client, url);
    const request = { url, path: 'src/new.ts', baseSha: 'base', headSha: 'head1' };
    const content = await service.content(client, request);
    let reads = 0;
    const restarted = createGitHubClientPool({
      minSpacingMs: 0,
      fetch: (async () => {
        reads++;
        throw Error('Offline');
      }) as typeof fetch,
    });
    restarted.setStorage(path.join(dir, 'github-state.json'));
    const reader = createPrChangesService(),
      reopened = restarted.client('one');
    assert.equal(JSON.stringify(await reader.manifest(reopened, url)), JSON.stringify(saved));
    assert.deepEqual(await reader.content(reopened, request), content);
    assert.equal(reads, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('large patch inventories remain pinned in memory when too large for disk cache', async () => {
  const f = fixture();
  f.files[0].patch = 'x'.repeat(1_100_000);
  const service = createPrChangesService(),
    client = f.pool.client('one');
  const first = await service.manifest(client, url);
  const count = f.reads.length;
  f.move('head2');
  assert.equal((await service.manifest(client, url)).metadata.headSha, first.metadata.headSha);
  assert.equal(f.reads.length, count, 'Reopening Changes must not refetch an oversized inventory');
  assert.equal((await service.manifest(client, url, true)).metadata.headSha, 'head2');
});
