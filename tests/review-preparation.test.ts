import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReviewContents, startReviewFileMetadata, type ContentProgress } from '../lib/review-preparation';
import { createGitHubClientPool, GitHubBackoffError } from '../lib/github-client';
import { getFileContent } from '../lib/github';
import { githubPriority } from '../lib/github-scheduler';
import type { ChangedFile } from '../lib/types';

const file = (filename: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  filename,
  status,
  additions: 1,
  deletions: 1,
});

void test('file progress counts both sides, skips absent sides and uses the old rename path', async () => {
  const reads: string[] = [],
    progress: ContentProgress[] = [];
  const files = [
    file('new', 'added'),
    file('removed', 'deleted'),
    { ...file('renamed', 'renamed'), previous_filename: 'old' },
  ];
  const result = await loadReviewContents(
    {
      getFileContent: (path, side) => {
        assert.equal(githubPriority(), 'foreground');
        reads.push(`${path}:${side}`);
        return Promise.resolve(path === 'new' ? '' : `${path}:${side}`);
      },
    },
    files,
    new AbortController().signal,
    (p) => progress.push(p)
  );
  assert.deepEqual(reads.sort(), ['new:head', 'old:base', 'removed:base', 'renamed:head']);
  assert.deepEqual(result.fileContents, { removed: 'removed:base', renamed: 'old:base' });
  assert.deepEqual(result.headFileContents, { new: '', renamed: 'renamed:head' });
  assert.deepEqual(
    progress.map((p) => p.completed),
    [0, 1, 2, 3]
  );
  assert.ok(progress.every((p) => p.total === 3));
});

void test('rate-limited contents wait for GitHub and resume without losing progress or retrying completed files', async () => {
  let now = 1_000_000,
    calls = 0;
  const pool = createGitHubClientPool({
    now: () => now,
    minSpacingMs: 0,
    fetch: (() => {
      if (++calls === 1)
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'secondary rate limit' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '60' },
          })
        );
      return Promise.resolve(
        new Response(JSON.stringify({ type: 'file', content: Buffer.from('content').toString('base64') }), {
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch,
  });
  const progress: ContentProgress[] = [];
  const client = pool.client('account');
  const result = await loadReviewContents(
    { getFileContent: (path, ref, signal) => path === 'cached' ? Promise.resolve('saved content') : getFileContent(client, 'o', 'r', path, ref, signal) },
    [file('cached', 'added'), file('one', 'added')],
    new AbortController().signal,
    (p) => progress.push(p),
    {
      now: () => now,
      wait: (ms) => {
        assert.equal(calls, 1, 'No requests while the rate limit is active');
        now += ms;
        return Promise.resolve();
      },
    }
  );
  assert.equal(calls, 2);
  assert.ok(progress.some((p) => (p.waitingUntil ?? 0) >= 1_060_000 && p.completed === 1));
  assert.deepEqual(progress.at(-1), { completed: 2, total: 2 });
  assert.equal(result.headFileContents.one, 'content');
});

void test('a parked content read can be cancelled without making another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const load = loadReviewContents(
    {
      getFileContent: () => {
        calls++;
        return Promise.reject(new GitHubBackoffError(Date.now() + 60_000));
      },
    },
    [file('one', 'added')],
    controller.signal,
    (p) => {
      if (p.waitingUntil) controller.abort();
    }
  );
  await assert.rejects(load, /abort/i);
  assert.equal(calls, 1);
});

void test('optional file history has background priority and never holds up the explanation', async () => {
  let signal: AbortSignal | undefined, resolve!: (value: never[]) => void;
  const metadata = startReviewFileMetadata(
    {
      getFileMetadata: (_files, s) => {
        assert.equal(githubPriority(), 'background');
        signal = s;
        return new Promise<never[]>((r) => {
          resolve = r;
        });
      },
    },
    [file('one')]
  );
  assert.deepEqual(metadata.finish(), [
    { filename: 'one', previousFilename: undefined, status: 'modified', additions: 1, deletions: 1 },
  ]);
  assert.equal(signal?.aborted, true);
  resolve([]);
  await Promise.resolve();
  assert.equal(metadata.finish().length, 1, 'Late metadata cannot replace the delivered inventory');
});

void test('completed optional history is retained', async () => {
  const metadata = startReviewFileMetadata(
    { getFileMetadata: () => Promise.resolve([{ ...file('one'), prCommitCount: 3 }]) },
    [file('one')]
  );
  await Promise.resolve();
  assert.equal(metadata.finish()[0].prCommitCount, 3);
});

void test('a rate-limited merge-base lookup can recover on the same generation source', async () => {
  const { GitHubDiffSource } = await import('../lib/github');
  let now = 1_000_000, comparisons = 0;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const pool = createGitHubClientPool({ now: () => now, minSpacingMs: 0, fetch: ((input: string) => {
    const path = new URL(input).pathname;
    if (path.includes('/compare/')) {
      if (++comparisons === 1) return Promise.resolve(new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
      }));
      return Promise.resolve(json({ merge_base_commit: { sha: 'mergebase' } }));
    }
    return Promise.resolve(json({ title: 'PR', user: { login: 'dev' }, state: 'open', labels: [],
      base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
      head: { ref: 'feature', sha: 'head', repo: { full_name: 'o/r' } },
    }));
  }) as typeof fetch });
  const source = new GitHubDiffSource('https://github.com/o/r/pull/1', 'account', pool.client('account'));
  await assert.rejects(source.getComparisonBase(), GitHubBackoffError);
  now += 62_000;
  assert.equal(await source.getComparisonBase(), 'mergebase');
  assert.equal(comparisons, 2);
});
