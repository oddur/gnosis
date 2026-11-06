import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool, githubCacheFor } from './cache-test-pool';
import { createSnapshotFileLoader } from '../src/snapshot-file-loader';
import type { PrChanges } from '../lib/pr-changes';

const base = 'a'.repeat(40),
  first = 'b'.repeat(40),
  second = 'c'.repeat(40);
const file = { path: 'file.ts', status: 'modified' as const, additions: 1, deletions: 1, changeId: 'change' };
const snapshot = (headSha: string, repo = 'o/r'): PrChanges => ({
  version: 1,
  url: 'https://github.com/o/r/pull/1',
  comparisonBase: base,
  fetchedAt: 1,
  files: [file],
  metadata: { baseSha: base, headSha, baseRepo: repo, headRepo: repo } as PrChanges['metadata'],
});
void test('new revisions reuse unchanged file sides through the actual Changes loader', async () => {
  const refs: string[] = [];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((url: string) => {
      refs.push(new URL(url).searchParams.get('ref') ?? '');
      return Promise.resolve(
        new Response('const value = 1;', { headers: { 'content-type': 'application/octet-stream' } })
      );
    }) as typeof fetch,
  });
  const load = createSnapshotFileLoader(),
    client = pool.client('account');
  const read = (head: string, repo?: string) => {
    const value = snapshot(head, repo);
    return load(client, { url: value.url, path: file.path, baseSha: base, headSha: head }, value, file);
  };
  await read(first);
  await read(second);
  assert.deepEqual(refs, [base, first, second], 'Updating one side must not download the unchanged side again');
  // Compare the same revisions in a different review scope: underlying source remains identical.
  const value = snapshot(second);
  await load(client, { url: value.url + '0', path: file.path, baseSha: base, headSha: second }, value, file);
  assert.equal(refs.length, 3);
  githubCacheFor(client)?.clear();
  await read(first);
  assert.equal(refs.length, 5, 'Clear cache removes source blobs too');
});

void test('source bytes are scoped by repository and account, while concurrent readers share a download', async () => {
  const { readGitHubFile } = await import('../src/github-file-content');
  let calls = 0;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (() => {
      calls++;
      return Promise.resolve(new Response('source'));
    }) as typeof fetch,
  });
  const source = { owner: 'o', repo: 'r', path: 'file.ts', ref: first };
  const client = pool.client('one');
  const [a, b] = await Promise.all([readGitHubFile(client, source), readGitHubFile(client, source)]);
  assert.equal(a.toString(), b.toString());
  assert.equal(calls, 1);
  await readGitHubFile(client, { ...source, owner: 'fork' });
  await readGitHubFile(pool.client('two'), source);
  assert.equal(calls, 3);
  const mutable = { ...source, ref: 'main' };
  await readGitHubFile(client, mutable);
  await readGitHubFile(client, mutable);
  assert.equal(calls, 5, 'Branch names are not immutable source identities');
});

void test('shared source bytes survive restart in the existing disk cache', async () => {
  const { readGitHubFile } = await import('../src/github-file-content');
  const { flushCaches, closeCaches } = await import('./cache-test-pool');
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-source-cache-'));
  const file = path.join(dir, 'budget.json');
  const source = { owner: 'o', repo: 'r', path: 'file.ts', ref: first };
  let calls = 0;
  const create = () =>
    createGitHubClientPool({
      minSpacingMs: 0,
      fetch: (() => {
        calls++;
        return Promise.resolve(new Response('immutable source'));
      }) as typeof fetch,
    });
  try {
    const original = create();
    await original.setStorage(file);
    await readGitHubFile(original.client('one'), source);
    await flushCaches();
    const restart = create();
    await restart.setStorage(file);
    assert.equal(
      (await readGitHubFile(restart.client('one'), source, () => assert.fail('No network needed'))).toString(),
      'immutable source'
    );
    assert.equal(calls, 1);
  } finally {
    await closeCaches();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
