import { flushCaches, closeCaches } from './cache-test-pool';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from './cache-test-pool';
import { createPrChangesService } from '../src/pr-changes-service';
import { GitHubDiffSource, getPrDiff } from '../lib/github';
import { preparedDiff } from '../lib/prepared-pr';
import { fileRevisionKey } from '../lib/pr-changes';
import { registerChangeProgress, markFileViewed, isFileViewed } from '../lib/file-view-progress';
const url = 'https://github.com/o/r/pull/1';
function fixture() {
  const reads: URL[] = [];
  let state = 'open',
    baseBranch = 'main';
  let head = 'head1',
    unstable = false,
    incomplete = false,
    failContent = false,
    moveDuringDiff = false,
    wholeDiff: string | number | undefined;
  const diffReads: URL[] = [];
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
    fetch: (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      reads.push(u);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
        });
      if (new Headers(init?.headers).get('accept')?.includes('diff')) {
        diffReads.push(u);
        if (u.pathname.includes('/compare/') && typeof wholeDiff === 'number')
          return new Response(JSON.stringify({ message: 'Sorry, this diff is unavailable.' }), {
            status: wholeDiff,
            headers: { 'content-type': 'application/json' },
          });
        if (u.pathname.includes('/compare/') && wholeDiff !== undefined)
          return new Response(String(wholeDiff), { headers: { 'content-type': 'application/vnd.github.diff; charset=utf-8' } });
        const diff = `diff for ${head}`;
        if (moveDuringDiff) head = 'moved-during-diff';
        return new Response(diff, { headers: { 'content-type': 'text/plain' } });
      }
      if (u.pathname.endsWith('/files')) {
        const page = Number(u.searchParams.get('page') ?? 1);
        return json(files.slice((page - 1) * 100, page * 100));
      }
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
        base: { ref: baseBranch, sha: 'base', repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: head, repo: { full_name: 'fork/r' } },
        state,
        labels: [],
        changed_files: incomplete ? 3001 : files.length,
      });
    }) as typeof fetch,
  });
  return {
    pool,
    metadata: (nextState: string, nextBase: string) => {
      state = nextState;
      baseBranch = nextBase;
    },
    reads,
    diffReads,
    files,
    wholeDiff: (value: string | number) => (wholeDiff = value),
    move: (v: string) => (head = v),
    unstable: () => (unstable = true),
    incomplete: () => (incomplete = true),
    failContent: () => (failContent = true),
    moveDuringDiff: () => (moveDuringDiff = true),
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
void test('GitHub’s 3,000-file cap leaves an explicitly partial, reusable Changes snapshot', async () => {
  const f = fixture();
  f.incomplete();
  while (f.files.length < 3000)
    f.files.push({ ...f.files[0], filename: `src/file-${f.files.length}.ts` });
  const client = f.pool.client('large'), service = createPrChangesService();
  const snapshot = await service.manifest(client, url);
  assert.equal(snapshot.files.length, 3000);
  assert.equal(snapshot.filesTruncated, true);
  assert.equal(snapshot.metadata.changedFileCount, 3001);
  const reads = f.reads.length;
  assert.deepEqual(await service.manifest(client, url), snapshot);
  assert.equal(f.reads.length, reads, 'A known API cap must not trigger repeated downloads');
  assert.equal(f.reads.filter(u => u.pathname.endsWith('/files')).length, 30, 'Stop at GitHub’s cap without requesting page 31');
  assert.equal((await service.content(client, { url, path: 'src/new.ts', baseSha: 'base', headSha: 'head1' })).after.kind, 'text');
  await service.prepareReview(client, url, snapshot.metadata);
  const source = new GitHubDiffSource(url, null, client);
  await assert.rejects(source.getChangedFiles(), /cannot generate a complete explanation/);
  await assert.rejects(source.getDiff(), /cannot generate a complete explanation/);
  assert.equal(await preparedDiff(client, url, snapshot.metadata), undefined, 'Never cache a partial diff as a complete review');
});
void test('exactly 3,000 changed files is complete when the PR metadata confirms that count', async () => {
  const f = fixture();
  while (f.files.length < 3000)
    f.files.push({ ...f.files[0], filename: `src/file-${f.files.length}.ts` });
  const client = f.pool.client('boundary'), service = createPrChangesService();
  const snapshot = await service.manifest(client, url);
  assert.equal(snapshot.filesTruncated, undefined);
  assert.equal((await new GitHubDiffSource(url, null, client).getChangedFiles()).length, 3000);
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
    await flushCaches();
    await f.pool.setStorage(path.join(dir, 'github-state.json'));
    const service = createPrChangesService(),
      client = f.pool.client('one');
    const saved = await service.manifest(client, url);
    const request = { url, path: 'src/new.ts', baseSha: 'base', headSha: 'head1' };
    const content = await service.content(client, request);
    let reads = 0;
    const restarted = createGitHubClientPool({
      fetch: (async () => {
        reads++;
        throw Error('Offline');
      }) as typeof fetch,
    });
    await flushCaches();
    await restarted.setStorage(path.join(dir, 'github-state.json'));
    const reader = createPrChangesService(),
      reopened = restarted.client('one');
    assert.equal(JSON.stringify(reader.cached(reopened, url, saved.metadata)), JSON.stringify(saved));
    assert.equal(reads, 0, 'Restoring saved inventories makes no network requests');
    assert.equal(JSON.stringify(await reader.manifest(reopened, url)), JSON.stringify(saved));
    assert.deepEqual(await reader.content(reopened, request), content);
    assert.equal(reads, 0);
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('large patch inventories remain pinned in memory when too large for disk cache', async () => {
  const f = fixture();
  f.files[0].patch = 'x'.repeat(1_100_000);
  const service = createPrChangesService(),
    client = f.pool.client('one');
  const first = await service.manifest(client, url);
  assert.equal(first.patchesDeferred, true);
  assert.equal(first.files[0].patch, undefined, 'The inventory must not carry a giant patch into the renderer');
  const reviewFiles = await new GitHubDiffSource(url, null, client).getChangedFiles();
  assert.equal(reviewFiles[0].patch?.length, 1_100_000, 'Explanation evidence must never silently inherit deferred patches');
  const count = f.reads.length;
  f.move('head2');
  assert.equal((await service.manifest(client, url)).metadata.headSha, first.metadata.headSha);
  assert.equal(f.reads.length, count, 'Reopening Changes must not refetch an oversized inventory');
  assert.equal((await service.manifest(client, url, true)).metadata.headSha, 'head2');
});

void test('guided generation reuses the exact prepared revision, including renamed SVG source and absent sides', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  const snapshot = await service.manifest(client, url);
  for (const file of snapshot.files)
    await service.content(client, { url, path: file.path, baseSha: 'base', headSha: 'head1' });
  await service.prepareReview(client, url, snapshot.metadata);
  const start = f.reads.length;
  const source = new GitHubDiffSource(url, null, client);
  assert.equal((await source.getMetadata()).headSha, 'head1');
  assert.equal((await source.getChangedFiles()).length, 4);
  assert.equal(await source.getDiff(), 'diff for head1');
  assert.equal(await source.getComparisonBase(), 'merge-base');
  assert.equal(await source.getFileContent('src/new.ts', 'head'), 'const value = 1;\n');
  assert.equal(await source.getFileContent('src/new.ts', 'base'), null);
  assert.equal(await source.getFileContent('src/old.ts', 'head'), null);
  assert.equal(await source.getFileContent('art/old.svg', 'base'), '<svg/>');
  assert.equal(f.reads.length - start, 1, 'Only the current PR metadata needs a network check');
  await source.assertCurrent();
  assert.equal(f.reads.length - start, 2, 'Generation can verify the revision again before saving');
  const other = new GitHubDiffSource(url, null, f.pool.client('two'));
  await other.getChangedFiles();
  assert.ok(
    f.reads.slice(start + 2).some((u) => u.pathname.endsWith('/files')),
    'Another account cannot reuse this snapshot'
  );
});
void test('new discovery revision bypasses saved latest and stale HTTP diff; old prepared revision stays pinned', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  const old = await service.manifest(client, url);
  await service.prepareReview(client, url, old.metadata);
  // Also seed the mutable HTTP diff endpoint before changing the PR.
  await getPrDiff(client, 'o', 'r', 1);
  f.move('head2');
  const next = await service.manifest(client, url, false, { revision: { baseSha: 'base', headSha: 'head2' } });
  assert.equal(next.metadata.headSha, 'head2');
  await service.prepareReview(client, url, next.metadata);
  assert.equal(await preparedDiff(client, url, old.metadata), 'diff for head1');
  assert.equal(await preparedDiff(client, url, next.metadata), 'diff for head2');
  const source = new GitHubDiffSource(url, null, client);
  assert.equal(await source.getDiff(), 'diff for head2');
  f.move('head3');
  await assert.rejects(source.assertCurrent(), /changed during generation/);
  assert.equal(await new GitHubDiffSource(url, null, client).getDiff(), 'diff for head3');
});
void test('a moving revision cannot poison the prepared review diff cache', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  const snapshot = await service.manifest(client, url);
  f.moveDuringDiff();
  await assert.rejects(service.prepareReview(client, url, snapshot.metadata), /changed while/);
  assert.equal(await preparedDiff(client, url, snapshot.metadata), undefined);
});

void test('refresh reuses immutable files but persists reopened and retargeted PR metadata', async () => {
  const f = fixture(),
    client = f.pool.client('one'),
    service = createPrChangesService();
  f.metadata('closed', 'main');
  const closed = await service.manifest(client, url);
  f.metadata('open', 'release');
  const start = f.reads.length;
  const reopened = await service.manifest(client, url, true);
  assert.equal(reopened.metadata.state, 'open');
  assert.equal(reopened.metadata.baseBranch, 'release');
  assert.deepEqual(reopened.files, closed.files);
  assert.equal(reopened.comparisonBase, closed.comparisonBase);
  assert.ok(reopened.fetchedAt >= closed.fetchedAt);
  assert.equal(
    f.reads.slice(start).filter((u) => u.pathname.endsWith('/files') || u.pathname.includes('/compare/')).length,
    0
  );
  const reader = createPrChangesService();
  // The cache stores JSON, so fields set to `undefined` are absent, as after a restart.
  const saved = JSON.parse(JSON.stringify(reopened.metadata)) as typeof reopened.metadata;
  assert.deepEqual((await reader.manifest(client, url)).metadata, saved, 'latest disk snapshot');
  assert.deepEqual(reader.cached(client, url, closed.metadata)?.metadata, saved, 'revision disk snapshot');
  assert.equal(closed.metadata.state, 'closed', 'already displayed snapshot remains immutable');
});

void test('unviewing a historical file clears only its matching commit completion', async () => {
  const { commitViewedKey } = await import('../lib/pr-commits');
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) },
  });
  const first = commitViewedKey(url, 'commit', 'parent');
  const alternate = commitViewedKey(url, 'commit', 'other-parent');
  const otherPr = commitViewedKey(url + '2', 'commit', 'parent');
  for (const key of [first, alternate, otherPr]) await markFileViewed(key, true);
  await markFileViewed('commit:' + fileRevisionKey(url, 'file.ts', 'parent', 'commit'), false);
  assert.equal(isFileViewed(first), false);
  assert.equal(isFileViewed(alternate), true);
  assert.equal(isFileViewed(otherPr), true);
});

/** A PR whose head can move, recording the order in which reads start. */
function revisionFixture() {
  const base = 'b'.repeat(40);
  let head = 'a'.repeat(40);
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = createGitHubClientPool({
    fetch: (async (input: string) => {
      const u = new URL(input);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
        });
      if (u.pathname.endsWith('/files')) {
        started.push('files');
        await gate;
        return json([{ filename: 'a.ts', status: 'modified', sha: head, patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 }]);
      }
      if (u.pathname.includes('/compare/')) {
        started.push(`compare:${u.pathname.split('/').pop()}`);
        await gate;
        return json({ merge_base_commit: { sha: base } });
      }
      started.push('metadata');
      return json({
        title: 'PR',
        body: '',
        user: { login: 'dev' },
        base: { ref: 'main', sha: base, repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: head, repo: { full_name: 'o/r' } },
        state: 'open',
        labels: [],
        changed_files: 1,
      });
    }) as typeof fetch,
  });
  return {
    client: pool.client('one'),
    started,
    release,
    base,
    head: () => head,
    move: (value: string) => (head = value),
  };
}
void test('lists files and compares in parallel, then confirms once', async () => {
  const f = revisionFixture();
  const read = createPrChangesService().manifest(f.client, url, false, {
    revision: { baseSha: f.base, headSha: f.head() },
  });
  for (let i = 0; i < 20 && f.started.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.started.sort(), [`compare:${f.base}...${f.head()}`, 'files'], 'Files and compare start together');
  f.release();
  const value = await read;
  assert.deepEqual(f.started.slice(2), ['metadata'], 'One metadata read confirms the revision');
  assert.equal(value.metadata.headSha, f.head());
  assert.equal(value.comparisonBase, f.base);
});
void test('restarts from fresh metadata when the head moved', async () => {
  const f = revisionFixture();
  const old = f.head();
  f.move('c'.repeat(40));
  f.release();
  const value = await createPrChangesService().manifest(f.client, url, false, {
    revision: { baseSha: f.base, headSha: old },
  });
  assert.equal(value.metadata.headSha, 'c'.repeat(40), 'The old head is never shown as current');
  assert.equal(value.files[0].changeId.length > 0, true);
  assert.deepEqual(f.started.slice(2), ['metadata', 'files', `compare:${f.base}...${'c'.repeat(40)}`, 'metadata']);
});
void test('the merge base is read from page 2 of the comparison, without its files', async () => {
  const f = fixture(),
    client = f.pool.client('one');
  const snapshot = await createPrChangesService().manifest(client, url);
  assert.equal(snapshot.comparisonBase, 'merge-base');
  const compares = f.reads.filter((u) => u.pathname.includes('/compare/'));
  assert.deepEqual(
    compares.map((u) => [u.searchParams.get('page'), u.searchParams.get('per_page')]),
    [['2', '1']],
    'One request, for page 2, which carries no patches'
  );
});
void test('a comparison page without a merge base falls back to page 1', async () => {
  const { getMergeBase } = await import('../lib/github');
  const pages: (string | null)[] = [];
  const pool = createGitHubClientPool({
    fetch: ((input: string) => {
      const u = new URL(input);
      pages.push(u.searchParams.get('page'));
      const page = u.searchParams.get('page');
      return Promise.resolve(new Response(
        JSON.stringify(page === '2' ? { commits: [] } : { merge_base_commit: { sha: 'from-page-1' }, files: [] }),
        { headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' } }
      ));
    }) as typeof fetch,
  });
  assert.equal(await getMergeBase(pool.client('one'), 'o', 'r', 'base', 'head'), 'from-page-1');
  assert.deepEqual(pages, ['2', null]);
  const empty = createGitHubClientPool({
    fetch: (() =>
      Promise.resolve(new Response(JSON.stringify({ commits: [] }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
      }))) as typeof fetch,
  });
  await assert.rejects(getMergeBase(empty.client('one'), 'o', 'r', 'base', 'head'), /merge base/);
});

/** A PR with `total` files whose list pages answer only when released, recording when each page starts. */
function pagedFixture(total: number, changedFiles = total) {
  const started: number[] = [];
  let flying = 0,
    peak = 0;
  const waiting: (() => void)[] = [];
  let open = false;
  const pool = createGitHubClientPool({
    fetch: (async (input: string) => {
      const u = new URL(input);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
        });
      if (u.pathname.endsWith('/files')) {
        const page = Number(u.searchParams.get('page'));
        started.push(page);
        peak = Math.max(peak, ++flying);
        // Later pages answer first, so the order of arrival never decides the order of files.
        if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
        await new Promise((resolve) => setTimeout(resolve, (40 - page) % 7));
        flying--;
        return json(
          Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => ({
            filename: `f${String((page - 1) * 100 + i).padStart(4, '0')}.ts`,
            status: 'modified',
            sha: 'blob',
            additions: 1,
            deletions: 0,
          }))
        );
      }
      if (u.pathname.includes('/compare/')) return json({ merge_base_commit: { sha: 'merge-base' } });
      return json({
        title: 'PR',
        body: '',
        user: { login: 'dev' },
        base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: 'head', repo: { full_name: 'o/r' } },
        state: 'open',
        labels: [],
        changed_files: changedFiles,
      });
    }) as typeof fetch,
  });
  return {
    client: pool.client('one'),
    started,
    peak: () => peak,
    release: () => {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    settle: async (count: number) => {
      for (let i = 0; i < 50 && started.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}
void test('a known file count requests every page together and assembles them in order', async () => {
  const { getChangedFiles } = await import('../lib/github');
  const f = pagedFixture(250);
  const read = getChangedFiles(f.client, 'o', 'r', 1, true, 250);
  await f.settle(3);
  assert.deepEqual([...f.started].sort(), [1, 2, 3], 'All three pages start before any answers');
  f.release();
  const files = await read;
  assert.equal(files.length, 250);
  assert.deepEqual(
    files.map((file) => file.filename),
    Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(4, '0')}.ts`)
  );
});
void test('without a file count, pages load one at a time', async () => {
  const { getChangedFiles } = await import('../lib/github');
  const f = pagedFixture(250);
  const read = getChangedFiles(f.client, 'o', 'r', 1, true);
  await f.settle(2);
  assert.deepEqual(f.started, [1], 'Page 2 waits for page 1');
  f.release();
  assert.equal((await read).length, 250);
  assert.deepEqual(f.started, [1, 2, 3]);
});
void test('a stale low count continues page by page; the scheduler bounds the burst', async () => {
  const { getChangedFiles } = await import('../lib/github');
  const low = pagedFixture(340);
  low.release();
  const files = await getChangedFiles(low.client, 'o', 'r', 1, true, 200);
  assert.equal(files.length, 340, 'A full last page means the count was stale');
  assert.deepEqual(low.started.slice(2), [3, 4]);
  const high = pagedFixture(150);
  high.release();
  assert.equal((await getChangedFiles(high.client, 'o', 'r', 1, true, 400)).length, 150, 'Empty pages past the end add nothing');
  const large = pagedFixture(950);
  const read = getChangedFiles(large.client, 'o', 'r', 1, true, 950);
  await large.settle(6);
  large.release();
  assert.equal((await read).length, 950);
  assert.equal(large.started.length, 10, 'One request per page, no more');
  assert.ok(large.peak() <= 6, `At most the scheduler's six slots run at once (saw ${large.peak()})`);
});
void test('Changes requests known pages together, then checks the total against the count', async () => {
  const f = pagedFixture(250);
  f.release();
  const snapshot = await createPrChangesService().manifest(f.client, url);
  assert.equal(snapshot.files.length, 250);
  assert.deepEqual([...f.started].sort(), [1, 2, 3]);
  const wrong = pagedFixture(260, 250);
  wrong.release();
  await assert.rejects(createPrChangesService().manifest(wrong.client, url), /incomplete/);
});

/** A whole diff naming `paths`, each a one-line change, with an abbreviated blob SHA per file. */
const wholeDiffOf = (paths: string[]) =>
  paths
    .map(
      (p, i) =>
        `diff --git a/${p} b/${p}\nindex 1111111..${(0xa000000 + i).toString(16)} 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`
    )
    .join('');
function cappedPr() {
  const f = fixture();
  f.incomplete();
  while (f.files.length < 3000) f.files.push({ ...f.files[0], filename: `src/file-${f.files.length}.ts` });
  return f;
}
void test('a PR past GitHub’s 3,000-file cap loads every file from the whole diff of its pinned SHAs', async () => {
  const f = cappedPr();
  f.wholeDiff(wholeDiffOf([...f.files.map((file) => file.filename), 'zz/extra.ts']));
  const client = f.pool.client('whole'),
    service = createPrChangesService();
  const snapshot = await service.manifest(client, url);
  assert.equal(snapshot.files.length, 3001);
  assert.equal(snapshot.filesTruncated, undefined, 'Complete, so not marked partial');
  assert.equal(f.reads.filter((u) => u.pathname.endsWith('/files')).length, 30, 'The JSON list still loads first');
  // The base repository answers for a fork's head SHA.
  assert.deepEqual(f.diffReads.map((u) => u.pathname), ['/repos/o/r/compare/base...head1']);
  const listed = snapshot.files.find((file) => file.path === 'src/old.ts');
  assert.deepEqual([listed?.status, listed?.blobSha, listed?.deletions], ['deleted', undefined, 1], 'Listed files keep the JSON entry');
  assert.equal(snapshot.files.find((file) => file.path === 'src/new.ts')?.blobSha, 'new');
  const extra = snapshot.files.at(-1);
  assert.deepEqual(
    [extra?.path, extra?.status, extra?.additions, extra?.deletions, extra?.patch, extra?.blobSha],
    ['zz/extra.ts', 'modified', 1, 1, '@@ -1 +1 @@\n-a\n+b', 'a000bb8']
  );
  const reads = f.reads.length;
  assert.equal(JSON.stringify(await createPrChangesService().manifest(client, url)), JSON.stringify(snapshot), 'The complete list is saved');
  assert.equal(f.reads.length, reads);
  assert.equal((await service.content(client, { url, path: 'zz/extra.ts', baseSha: 'base', headSha: 'head1' })).after.kind, 'text');
});
void test('a refused or inconsistent whole diff keeps the capped list, marked partial', async () => {
  for (const [i, answer] of [406, 422, 'diff --git a/only.ts b/only.ts\nindex 1111111..2222222 100644\n'].entries()) {
    const f = cappedPr();
    f.wholeDiff(answer);
    const snapshot = await createPrChangesService().manifest(f.pool.client(`refused-${i}`), url);
    assert.equal(snapshot.files.length, 3000);
    assert.equal(snapshot.filesTruncated, true);
    assert.equal(f.diffReads.length, 1);
  }
  // More files than the PR's count is not this revision's list.
  const f = cappedPr();
  f.wholeDiff(wholeDiffOf([...f.files.map((file) => file.filename), 'zz/extra.ts', 'zz/more.ts']));
  const snapshot = await createPrChangesService().manifest(f.pool.client('mismatch'), url);
  assert.equal(snapshot.filesTruncated, true);
});
void test('below the cap, Changes never asks for the whole diff', async () => {
  const f = fixture();
  while (f.files.length < 3000) f.files.push({ ...f.files[0], filename: `src/file-${f.files.length}.ts` });
  f.wholeDiff(wholeDiffOf(['unused.ts']));
  const snapshot = await createPrChangesService().manifest(f.pool.client('below'), url);
  assert.equal(snapshot.files.length, 3000);
  assert.equal(snapshot.filesTruncated, undefined);
  assert.equal(f.diffReads.length, 0, 'Exactly 3,000 confirmed files is complete');
});
void test('files from the whole diff stay within the inventory’s memory bounds', async () => {
  const f = cappedPr();
  const big = Array.from({ length: 20_000 }, (_, i) => `+line ${i}`).join('\n');
  f.wholeDiff(`${wholeDiffOf(f.files.map((file) => file.filename))}diff --git a/zz/big.ts b/zz/big.ts\nnew file mode 100644\nindex 0000000..bbbbbbb\n--- /dev/null\n+++ b/zz/big.ts\n@@ -0,0 +1,20000 @@\n${big}\n`);
  const snapshot = await createPrChangesService().manifest(f.pool.client('bounded'), url);
  const file = snapshot.files.find((entry) => entry.path === 'zz/big.ts');
  assert.deepEqual([file?.additions, file?.patch, snapshot.patchesDeferred], [20_000, undefined, true]);
});
