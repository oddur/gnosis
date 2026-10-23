import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitHubClientPool, githubCacheFor } from '../lib/github-client';
import { createReviewImageService } from '../src/review-image-service';
import { includeImageChanges, imageMimeType } from '../lib/review-images';
import type { ReviewGuide } from '../lib/types';
import { memberPrefix } from '../lib/workbench';

const base = 'a'.repeat(40),
  head = 'b'.repeat(40),
  merge = 'c'.repeat(40);
function review() {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    baseSha: base,
    headSha: head,
    slides: [],
    changedFiles: [
      { filename: 'art/new.svg', previousFilename: 'art/old.svg', status: 'renamed', additions: 1, deletions: 1 },
    ],
  } as unknown as ReviewGuide & { changedFiles: NonNullable<ReviewGuide['changedFiles']> };
}
function fakeGitHub() {
  const reads: { url: URL; init: RequestInit }[] = [];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((input: string, init: RequestInit) => {
      const url = new URL(input);
      reads.push({ url, init });
      if (url.pathname.includes('/compare/'))
        return Promise.resolve(
          new Response(JSON.stringify({ merge_base_commit: { sha: merge } }), {
            headers: { 'content-type': 'application/json' },
          })
        );
      return Promise.resolve(
        new Response(`<svg xmlns="http://www.w3.org/2000/svg"><text>${url.searchParams.get('ref')}</text></svg>`, {
          headers: { 'content-type': 'image/svg+xml' },
        })
      );
    }) as typeof fetch,
  });
  return { pool, reads };
}
void test('image revisions use the PR merge base, previous rename path and fork head; reads coalesce per account', async () => {
  const { pool, reads } = fakeGitHub();
  const saved = review();
  saved.headRepo = 'fork/r';
  let client = pool.client('a');
  const writes: unknown[] = [];
  const disk = githubCacheFor(client);
  assert.ok(disk);
  const write = disk.set.bind(disk);
  disk.set = (...args: Parameters<typeof disk.set>) => {
    writes.push(args);
    write(...args);
  };
  const load = createReviewImageService({ loadReview: () => saved, client: () => client });
  const [one, two] = await Promise.all([load('review', 'art/new.svg'), load('review', 'art/new.svg')]);
  assert.deepEqual(one, two);
  assert.equal(one.before.status, 'ready');
  assert.equal(one.after.status, 'ready');
  const images = reads.filter((r) => r.url.pathname.includes('/contents/'));
  assert.equal(images.length, 2);
  assert.ok(
    images.some(
      (r) =>
        decodeURIComponent(r.url.pathname) === '/repos/o/r/contents/art/old.svg' &&
        r.url.searchParams.get('ref') === merge
    )
  );
  assert.ok(
    images.some(
      (r) =>
        decodeURIComponent(r.url.pathname) === '/repos/fork/r/contents/art/new.svg' &&
        r.url.searchParams.get('ref') === head
    )
  );
  assert.ok(images.every((r) => new Headers(r.init.headers).get('authorization')));
  await load('review', 'art/new.svg');
  assert.equal(reads.length, 3);
  assert.equal(writes.length, 1, 'Only the comparison JSON, never image bytes, enters the API disk cache');
  client = pool.client('b');
  await load('review', 'art/new.svg');
  assert.equal(reads.length, 6);
});
void test('added/deleted images load only their existing side; unknown revisions and paths fail without mutable fallbacks', async () => {
  const { pool, reads } = fakeGitHub();
  const saved = review();
  saved.changedFiles[0].status = 'added';
  const load = createReviewImageService({ loadReview: () => saved, client: () => pool.client('a') });
  const added = await load('r', 'art/new.svg');
  assert.equal(added.before.status, 'absent');
  assert.equal(reads.length, 1);
  saved.changedFiles[0].status = 'deleted';
  const deleted = await load('r', 'art/new.svg');
  assert.equal(deleted.after.status, 'absent');
  saved.changedFiles[0].status = 'modified';
  delete saved.baseSha;
  const old = await load('r', 'art/new.svg');
  assert.equal(old.before.status, 'error');
  assert.equal(old.after.status, 'ready');
  await assert.rejects(load('../other', 'art/new.svg'), /Invalid review/);
  await assert.rejects(load('r', 'secret.png'), /not part/);
});
void test('stack images keep repeated paths and rename origins attached to their source PR', async () => {
  const { pool, reads } = fakeGitHub();
  const saved = review();
  const members = [1, 2].map((number) => ({
    repo: 'o/r',
    number,
    url: `https://github.com/o/r/pull/${number}`,
    headSha: String(number).repeat(40),
    baseSha: base,
  }));
  saved.snapshot = { subject: { members } } as ReviewGuide['snapshot'];
  saved.changedFiles = members.map((m) => ({
    filename: memberPrefix(m as never) + 'art/new.svg',
    previousFilename: memberPrefix(m as never) + 'art/old.svg',
    status: 'renamed',
    additions: 1,
    deletions: 1,
  }));
  const load = createReviewImageService({ loadReview: () => saved, client: () => pool.client('a') });
  await load('r', saved.changedFiles[1].filename);
  assert.ok(reads.some((r) => r.url.searchParams.get('ref') === '2'.repeat(40)));
  assert.ok(reads.every((r) => !r.url.pathname.includes('PR-')));
});
void test('failures remain retryable and image previews obey the shared GitHub cooldown', async () => {
  let calls = 0;
  const saved = review();
  saved.changedFiles[0].status = 'added';
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: (() => {
      calls++;
      return Promise.resolve(new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }));
    }) as typeof fetch,
  });
  const load = createReviewImageService({ loadReview: () => saved, client: () => pool.client('a') });
  assert.equal((await load('r', 'art/new.svg')).after.status, 'error');
  assert.equal((await load('r', 'art/new.svg')).after.status, 'error');
  assert.equal(calls, 1);
});
void test('binary bytes survive local git reads and before uses the merge base, not the advanced base branch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-image-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture');
    const before = Buffer.from([137, 80, 78, 71, 0, 255, 1]);
    const after = Buffer.from([137, 80, 78, 71, 0, 254, 2]);
    fs.writeFileSync(path.join(dir, 'image.png'), before);
    git('add', '.');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'change');
    fs.writeFileSync(path.join(dir, 'image.png'), after);
    git('commit', '-am', 'head');
    const headSha = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from('not the original'));
    git('commit', '-am', 'advance');
    const saved = {
      ...review(),
      prUrl: `local:${dir}#main..change`,
      baseSha: git('rev-parse', 'HEAD'),
      headSha,
      changedFiles: [{ filename: 'image.png', status: 'modified', additions: 0, deletions: 0 }],
    } as ReviewGuide;
    const load = createReviewImageService({
      loadReview: () => saved,
      client: () => {
        throw Error('No network');
      },
    });
    const images = await load('r', 'image.png');
    assert.equal(images.before.status, 'ready');
    assert.equal(images.after.status, 'ready');
    {
      assert.equal(images.before.dataUrl, `data:image/png;base64,${before.toString('base64')}`);
      assert.equal(images.after.dataUrl, `data:image/png;base64,${after.toString('base64')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
void test('images without hunks become reachable exactly once, while exclusions and existing topics are respected', () => {
  const saved = review();
  saved.changedFiles.push({ filename: 'art/a.png', status: 'added', additions: 0, deletions: 0 });
  saved.slides = [{ affectedFiles: ['art/new.svg'], diffHunks: [] } as unknown as ReviewGuide['slides'][0]];
  includeImageChanges(saved);
  includeImageChanges(saved);
  assert.equal(saved.slides.length, 2);
  assert.deepEqual(saved.slides[1].affectedFiles, ['art/a.png']);
  assert.equal(imageMimeType('art/ICON.SVG'), 'image/svg+xml');
  assert.equal(imageMimeType('code.ts'), undefined);
  saved.slides = [];
  saved.imageFiles = [];
  includeImageChanges(saved);
  assert.equal(saved.slides.length, 0);
});

void test('GitHub raw media preserves binary bytes and a missing side does not hide the other image', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128]);
  let fail = true;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((input: string) => {
      const url = new URL(input);
      if (url.pathname.includes('/compare/'))
        return Promise.resolve(
          new Response(JSON.stringify({ merge_base_commit: { sha: merge } }), {
            headers: { 'content-type': 'application/json' },
          })
        );
      if (fail && url.searchParams.get('ref') === head)
        return Promise.resolve(new Response('missing', { status: 404 }));
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/vnd.github.raw+json' } }));
    }) as typeof fetch,
  });
  const saved = review();
  saved.changedFiles = [{ filename: 'art/photo.png', status: 'modified', additions: 0, deletions: 0 }];
  const load = createReviewImageService({ loadReview: () => saved, client: () => pool.client('binary') });
  const first = await load('r', 'art/photo.png');
  assert.equal(first.before.status, 'ready');
  assert.equal(first.before.dataUrl, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal(first.after.status, 'error');
  fail = false;
  assert.equal((await load('r', 'art/photo.png')).after.status, 'ready');
});
