import { flushCaches, closeCaches } from './cache-test-pool';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitHubClientPool, githubCacheFor } from './cache-test-pool';
import { createPrCommitsService } from '../src/pr-commits-service';
import { ownedCommits, selectedCommits, type CommitSelection } from '../lib/pr-commits';
import type { ReviewSubject } from '../lib/workbench';
import { createPrFileCache } from '../lib/pr-file-cache';
const url = 'https://github.com/o/r/pull/1';
const sha = (n: number) => n.toString(16).padStart(40, '0');
function fixture(count = 3) {
  const reads: URL[] = [];
  const commits = Array.from({ length: count }, (_, i) => ({
    sha: sha(i + 1),
    html_url: `https://github.com/o/r/commit/${sha(i + 1)}`,
    parents: [{ sha: sha(i) }],
    author: { login: 'dev', avatar_url: '' },
    commit: {
      message: `Commit ${i + 1}`,
      author: { name: 'Developer', date: '2026-10-20T10:00:00Z' },
      committer: { name: 'Developer', date: '2026-10-20T10:00:00Z' },
      verification: { verified: true },
    },
  }));
  const files = [
    { filename: 'new.ts', status: 'added', additions: 1, deletions: 0, sha: null, patch: '@@ -0,0 +1 @@\n+new' },
    {
      filename: 'art/new.svg',
      previous_filename: 'art/old.svg',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      sha: sha(99),
      patch: '@@ -1 +1 @@\n-old\n+new',
    },
  ];
  let head = sha(count),
    incomplete = false,
    unstable = false,
    wrongBase = false,
    cap = 0;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (async (input: string) => {
      const u = new URL(input);
      reads.push(u);
      const json = (data: unknown, next = false) =>
        new Response(JSON.stringify(data), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-cache',
            ...(next
              ? {
                  link: `<${u.origin}${u.pathname}?page=${Number(u.searchParams.get('page') || 1) + 1}&per_page=100>; rel="next"`,
                }
              : {}),
          },
        });
      if (u.pathname.endsWith('/pulls/1/commits')) {
        const page = Number(u.searchParams.get('page') || 1);
        if (unstable) head = sha(999);
        return json(
          commits.slice((page - 1) * 100, Math.min(page * 100, commits.length) - (incomplete ? 1 : 0)),
          page * 100 < commits.length
        );
      }
      if (u.pathname.includes('/commits/')) {
        const ref = u.pathname.split('/').pop();
        const page = Number(u.searchParams.get('page') || 1);
        return json(
          {
            sha: ref,
            files: cap
              ? Array.from({ length: cap }, (_, i) => ({ ...files[0], filename: `${i}.ts` }))
              : [files[page - 1]],
          },
          !cap && page === 1
        );
      }
      if (u.pathname.includes('/compare/')) {
        const [base] = u.pathname.split('/').pop()!.split('...');
        const page = Number(u.searchParams.get('page') || 1),
          listing = u.searchParams.get('per_page') === '100';
        return json(
          {
            merge_base_commit: { sha: wrongBase ? sha(888) : base },
            commits: listing ? commits.slice((page - 1) * 100, page * 100) : [],
            files: cap ? Array.from({ length: cap }, (_, i) => ({ ...files[0], filename: `${i}.ts` })) : files,
          },
          listing && page * 100 < commits.length
        );
      }
      if (u.pathname.includes('/contents/'))
        return new Response(u.pathname.endsWith('.svg') ? '<svg/>' : 'new\n', {
          headers: { 'content-type': 'application/octet-stream' },
        });
      return json({
        title: 'PR',
        body: 'Description',
        user: { login: 'dev' },
        base: { ref: 'main', sha: sha(0), repo: { full_name: 'o/r' } },
        head: { ref: 'feature', sha: head, repo: { full_name: 'fork/r' } },
        state: 'open',
        labels: [],
        commits: count,
        changed_files: files.length,
      });
    }) as typeof fetch,
  });
  return {
    pool,
    reads,
    commits,
    files,
    move: () => (head = sha(999)),
    incomplete: () => (incomplete = true),
    unstable: () => (unstable = true),
    wrongBase: () => (wrongBase = true),
    cap: (n: number) => (cap = n),
  };
}
const selection = (first = 1, last = first): CommitSelection => ({
  url,
  prBaseSha: sha(0),
  prHeadSha: sha(3),
  firstSha: sha(first),
  lastSha: sha(last),
});
void test('commit lists coalesce, paginate beyond 100, and use paginated comparisons beyond the PR endpoint cap', async () => {
  for (const count of [3, 125, 251]) {
    const f = fixture(count),
      service = createPrCommitsService(),
      client = f.pool.client('one');
    const [a, b] = await Promise.all([service.list(client, url), service.list(client, url)]);
    assert.deepEqual(a, b);
    assert.equal(a.commits.length, count);
    assert.equal(a.commits.at(-1)?.sha, sha(count));
    const reads = f.reads.length;
    await service.list(client, url);
    assert.equal(f.reads.length, reads);
    assert.equal(
      f.reads.some((u) => u.pathname.includes('/compare/')),
      count > 250
    );
  }
});
void test('single commit pagination, range endpoints, merge parents, and file sides remain exact', async () => {
  const f = fixture(),
    service = createPrCommitsService(),
    client = f.pool.client('one');
  f.commits[2].parents.push({ sha: sha(55) });
  await service.list(client, url);
  const single = await service.comparison(client, selection(2));
  assert.equal(single.files.length, 2);
  assert.equal(single.comparisonBase, sha(1));
  assert.equal(single.metadata.headSha, sha(2));
  const request = { url, path: 'art/new.svg', baseSha: sha(1), headSha: sha(2), comparison: selection(2) };
  const image = await service.content(client, request);
  assert.equal(image.before.kind, 'image');
  assert.ok(
    f.reads.some(
      (u) =>
        decodeURIComponent(u.pathname).endsWith('/o/r/contents/art/old.svg') && u.searchParams.get('ref') === sha(1)
    )
  );
  assert.ok(
    f.reads.some(
      (u) =>
        decodeURIComponent(u.pathname).endsWith('/o/r/contents/art/new.svg') && u.searchParams.get('ref') === sha(2)
    )
  );
  const added = await service.content(client, { ...request, path: 'new.ts' });
  assert.equal(added.before.kind, 'absent');
  const range = await service.comparison(client, selection(1, 3));
  assert.equal(range.comparisonBase, sha(0));
  assert.equal(range.metadata.headSha, sha(3));
  const merge = await service.comparison(client, { ...selection(3), parentSha: sha(55) });
  assert.equal(merge.comparisonBase, sha(55));
  assert.ok(f.reads.some((u) => u.pathname.endsWith(`${sha(55)}...${sha(3)}`)));
  f.move();
  await service.list(client, url, true);
  assert.equal((await service.content(client, request)).before.kind, 'image');
});
void test('invalid membership, parents, reverse ranges, wrong baseline, and file injection are rejected', async () => {
  const f = fixture(),
    service = createPrCommitsService(),
    client = f.pool.client('one');
  await service.list(client, url);
  for (const s of [
    { ...selection(), firstSha: sha(500) },
    selection(3, 1),
    { ...selection(), parentSha: sha(50) },
    { ...selection(), firstSha: 'abc' },
  ])
    await assert.rejects(service.comparison(client, s));
  f.wrongBase();
  await assert.rejects(service.comparison(client, selection(1, 3)), /ancestry/);
  await service.comparison(client, selection(2));
  const request = { url, path: 'nope', baseSha: sha(1), headSha: sha(2), comparison: selection(2) };
  await assert.rejects(() => service.find(client, request), /Reload/);
  await assert.rejects(() => service.find(client, { ...request, path: 'new.ts', baseSha: sha(0) }), /Reload/);
  await assert.rejects(() => service.find(f.pool.client('two'), { ...request, path: 'new.ts' }), /Reload/);
});
void test('incomplete inventories, racing pushes, and file caps never present a partial comparison as complete', async () => {
  for (const kind of ['incomplete', 'unstable'] as const) {
    const f = fixture();
    f[kind]();
    await assert.rejects(
      createPrCommitsService().list(f.pool.client('one'), url),
      kind === 'incomplete' ? /incomplete/ : /changed while/
    );
  }
  for (const cap of [300, 3000]) {
    const f = fixture(),
      service = createPrCommitsService(),
      client = f.pool.client('one');
    await service.list(client, url);
    f.cap(cap);
    await assert.rejects(service.comparison(client, cap === 300 ? selection(1, 3) : selection(1)), /file limit/);
  }
});
void test('initial commit has no before side; initial-commit ranges give an explicit limitation', async () => {
  const f = fixture(),
    service = createPrCommitsService(),
    client = f.pool.client('one');
  f.commits[0].parents = [];
  await service.list(client, url);
  const result = await service.comparison(client, selection(1));
  assert.equal(result.comparisonBase, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(
    (
      await service.content(client, {
        url,
        path: 'new.ts',
        baseSha: result.comparisonBase,
        headSha: sha(1),
        comparison: selection(1),
      })
    ).before.kind,
    'absent'
  );
  await assert.rejects(service.comparison(client, selection(1, 2)), /first commit/);
});
void test('commit lists, comparisons, and opened files survive restart; latest catalog recovers a missing canonical entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-commits-'));
  try {
    const f = fixture(),
      client = f.pool.client('one'),
      service = createPrCommitsService();
    await flushCaches();
    await f.pool.setStorage(path.join(dir, 'cache.json'));
    const list = await service.list(client, url),
      result = await service.comparison(client, selection(2));
    const request = { url, path: 'new.ts', baseSha: sha(1), headSha: sha(2), comparison: selection(2) };
    const file = await service.content(client, request);
    const pool = createGitHubClientPool({
      minSpacingMs: 0,
      fetch: (async () => {
        throw Error('Must not fetch');
      }) as typeof fetch,
    });
    await flushCaches();
    await pool.setStorage(path.join(dir, 'cache.json'));
    const reopened = createPrCommitsService(),
      next = pool.client('one');
    assert.equal(JSON.stringify(await reopened.list(next, url)), JSON.stringify(list));
    assert.equal(JSON.stringify(await reopened.comparison(next, selection(2))), JSON.stringify(result));
    assert.deepEqual(await reopened.content(next, request), file);
    // Only the latest entry can survive disk eviction. Reading it must repin the canonical catalog.
    githubCacheFor(client)?.set(`pr-commits:v1:${url}:${sha(0)}:${sha(3)}`, null);
    const recovered = createPrCommitsService();
    await recovered.list(client, url);
    assert.equal((await recovered.comparison(client, selection(3))).metadata.headSha, sha(3));
  } finally {
    await closeCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('stack deduplication follows ancestors, not siblings; range uses chronological unfiltered order', async () => {
  const f = fixture(),
    list = await createPrCommitsService().list(f.pool.client('one'), url);
  const urls = [url, url + '2', url + '3'];
  const subject = {
    members: urls.map((url) => ({ url })),
    edges: [
      { parent: urls[0], child: urls[1] },
      { parent: urls[0], child: urls[2] },
    ],
  } as ReviewSubject;
  const lists = [
    { ...list, commits: list.commits.slice(0, 1) },
    { ...list, url: urls[1] },
    { ...list, url: urls[2] },
  ];
  const groups = ownedCommits(subject, lists);
  assert.deepEqual(
    groups.map((g) => g.commits.length),
    [1, 2, 2]
  );
  assert.deepEqual(
    groups.map((g) => g.omitted),
    [0, 1, 1]
  );
  assert.deepEqual(
    groups.map((g) => g.inheritedFrom.map((source) => [source.member.url, source.count])),
    [[], [[url, 1]], [[url, 1]]]
  );
  assert.deepEqual(
    groups.map((g) => g.parents.map((parent) => parent.url)),
    [[], [url], [url]]
  );
  assert.deepEqual(
    selectedCommits(list, selection(1, 3)).map((c) => c.sha),
    [sha(1), sha(2), sha(3)]
  );
});
void test('commit content cache cannot alias full-PR content with the same base/head identifiers', async () => {
  let calls = 0;
  const cache = createPrFileCache(async () => {
    calls++;
    return { before: { kind: 'absent' }, after: { kind: 'text', content: String(calls) } };
  });
  const request = { url, path: 'new.ts', baseSha: sha(0), headSha: sha(1) };
  const pr = await cache.read(request),
    commit = await cache.read({ ...request, comparison: selection(1) });
  assert.notDeepEqual(pr, commit);
  assert.equal(calls, 2);
});

void test('speculative reads respect the background budget while cached comparisons and files remain accessible', async () => {
  const f = fixture(),
    service = createPrCommitsService(),
    client = f.pool.client('one');
  await service.list(client, url);
  const deny = () => {
    throw Error('Background budget reserve');
  };
  const reads = f.reads.length;
  await assert.rejects(service.comparison(client, selection(2), deny), /budget reserve/);
  assert.equal(f.reads.length, reads);
  await service.comparison(client, selection(2));
  assert.equal((await service.comparison(client, selection(2), deny)).metadata.headSha, sha(2));
  const request = { url, path: 'new.ts', baseSha: sha(1), headSha: sha(2), comparison: selection(2) };
  await assert.rejects(service.content(client, request, deny), /budget reserve/);
  await service.content(client, request);
  assert.equal((await service.content(client, request, deny)).after.kind, 'text');
});

void test('a newly discovered revision bypasses the previous saved commit catalog', async () => {
  const f = fixture(),
    service = createPrCommitsService(),
    client = f.pool.client('one');
  await service.list(client, url);
  f.move();
  const next = await service.list(client, url, false, { revision: { baseSha: sha(0), headSha: sha(999) } });
  assert.equal(next.metadata.headSha, sha(999));
});
