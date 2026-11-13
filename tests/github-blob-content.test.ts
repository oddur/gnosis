import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClientPool } from './cache-test-pool';
import { createSnapshotFileLoader, matchesPatch } from '../src/snapshot-file-loader';
import { gitBlobSha, readGitHubFile } from '../src/github-file-content';
import { GitHubDiffSource } from '../lib/github';
import type { PrChangeFile, PrChanges } from '../lib/pr-changes';

const url = 'https://github.com/o/r/pull/1';
const base = 'a'.repeat(40),
  merge = 'e'.repeat(40);
const head = (n: number) => n.toString(16).padStart(40, 'f');
const text = (name: string, version = 1) => `export const ${name.replace(/\W/g, '_')} = ${version};\n`;
const sha = (value: string | Buffer) => gitBlobSha(Buffer.from(value));

/** Serves blobs by SHA and files by ref and path, recording every request. */
function server() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, Buffer>>();
  const reads: URL[] = [];
  const pool = createGitHubClientPool({
    fetch: ((input: string) => {
      const u = new URL(input);
      reads.push(u);
      const blob = /\/git\/blobs\/([a-f\d]+)$/.exec(u.pathname);
      const path = /\/contents\/(.+)$/.exec(u.pathname);
      const bytes = blob
        ? blobs.get(blob[1])
        : path && trees.get(u.searchParams.get('ref') ?? '')?.get(decodeURIComponent(path[1]));
      if (!bytes)
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        );
      return Promise.resolve(new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream' } }));
    }) as typeof fetch,
  });
  /** Commits `files` at `ref` and returns their blob SHAs. */
  const commit = (ref: string, files: Record<string, string | Buffer>) => {
    const tree = new Map<string, Buffer>();
    for (const [path, value] of Object.entries(files)) {
      const bytes = Buffer.from(value);
      tree.set(path, bytes);
      blobs.set(sha(bytes), bytes);
    }
    trees.set(ref, tree);
  };
  return {
    client: pool.client('account'),
    reads,
    commit,
    blobReads: () => reads.filter((u) => u.pathname.includes('/git/blobs/')),
    pathReads: (ref: string) => reads.filter((u) => u.pathname.includes('/contents/') && u.searchParams.get('ref') === ref),
  };
}
const snapshot = (headSha: string, files: PrChangeFile[], headRepo = 'o/r'): PrChanges => ({
  version: 1,
  url,
  comparisonBase: merge,
  fetchedAt: 1,
  files,
  metadata: { baseSha: base, headSha, baseRepo: 'o/r', headRepo } as PrChanges['metadata'],
});
const changed = (path: string, content: string): PrChangeFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  changeId: path,
  blobSha: sha(content),
});

void test('after a push that changes 3 of 40 files, only those 3 after sides are downloaded', async () => {
  const s = server();
  const paths = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`);
  const first = Object.fromEntries(paths.map((p) => [p, text(p)]));
  const second = { ...first, [paths[3]]: text(paths[3], 2), [paths[17]]: text(paths[17], 2), [paths[38]]: text(paths[38], 2) };
  s.commit(merge, Object.fromEntries(paths.map((p) => [p, text(p, 0)])));
  s.commit(head(1), first);
  s.commit(head(2), second);
  const load = createSnapshotFileLoader();
  const open = async (headSha: string, contents: Record<string, string>) => {
    const value = snapshot(headSha, paths.map((p) => changed(p, contents[p])));
    for (const file of value.files)
      await load(s.client, { url, path: file.path, baseSha: base, headSha }, value, file);
  };
  await open(head(1), first);
  assert.equal(s.blobReads().length, 40, 'The first revision reads each after side once, by blob SHA');
  assert.equal(s.pathReads(merge).length, 40, 'Before sides are read by ref and path');
  const before = s.reads.length;
  await open(head(2), second);
  const pushed = s.reads.slice(before);
  assert.equal(pushed.length, 3, 'Only the three changed files reach the network');
  assert.deepEqual(
    pushed.map((u) => u.pathname.split('/').pop()).sort(),
    [paths[3], paths[17], paths[38]].map((p) => sha(second[p])).sort()
  );
  assert.equal(s.pathReads(head(2)).length, 0, 'No after side is read by path');
  const reused = 40 - pushed.length;
  console.log(`push reuse: ${reused} of 40 after sides from the blob cache, ${pushed.length} downloaded (before: 40 downloaded)`);
});

void test('renamed and shared content hits the blob cache from any path, revision, or repository', async () => {
  const s = server();
  const content = text('shared');
  s.commit(merge, {});
  s.commit(head(1), { 'a.ts': content });
  const load = createSnapshotFileLoader();
  const added = { ...changed('a.ts', content), status: 'added' as const };
  await load(s.client, { url, path: 'a.ts', baseSha: base, headSha: head(1) }, snapshot(head(1), [added]), added);
  const moved = { ...changed('moved/b.ts', content), status: 'added' as const };
  const fork = snapshot(head(2), [moved], 'fork/r');
  const count = s.reads.length;
  const result = await load(s.client, { url, path: 'moved/b.ts', baseSha: base, headSha: head(2) }, fork, moved);
  assert.deepEqual(result.after, { kind: 'text', content });
  assert.equal(s.reads.length, count, 'Same blob, new path, new head, and a fork: no request');
});

void test('a path read stores its bytes once, under the blob SHA they hash to', async () => {
  const s = server();
  const content = text('path');
  s.commit(head(1), { 'p.ts': content });
  const source = { owner: 'o', repo: 'r', path: 'p.ts', ref: head(1) };
  assert.equal((await readGitHubFile(s.client, source)).toString(), content);
  const { githubCacheFor } = await import('./cache-test-pool');
  const cache = githubCacheFor(s.client);
  const hint = cache?.get(`git-source:v2:${JSON.stringify(['o', 'r', head(1), 'p.ts'])}`, (v): v is { blob: string } => true);
  assert.deepEqual(hint?.value, { blob: sha(content) }, 'The ref and path keep only a hint');
  assert.ok(cache?.get(`git-blob:v1:${sha(content)}`, (v): v is { base64: string } => true));
  // The blob is now known by SHA as well: reading it by SHA needs no request.
  const count = s.reads.length;
  await readGitHubFile(s.client, { ...source, path: 'other.ts', ref: head(9), blobSha: sha(content) });
  await readGitHubFile(s.client, source);
  assert.equal(s.reads.length, count);
});

void test('abbreviated blob SHAs find one cached blob, only when its bytes match the patch', async () => {
  const s = server();
  const content = 'one\ntwo\nthree\n';
  const full = sha(content);
  s.commit(head(1), { 'x.ts': content });
  s.commit(head(2), { 'x.ts': content });
  await readGitHubFile(s.client, { owner: 'o', repo: 'r', path: 'x.ts', ref: head(1), blobSha: full });
  const load = createSnapshotFileLoader();
  const patch = '@@ -1,3 +1,3 @@\n one\n-2\n+two\n three';
  const file: PrChangeFile = { path: 'x.ts', status: 'added', additions: 1, deletions: 1, changeId: 'x', patch, blobSha: full.slice(0, 9) };
  const count = s.reads.length;
  const found = await load(s.client, { url, path: 'x.ts', baseSha: base, headSha: head(2) }, snapshot(head(2), [file]), file);
  assert.deepEqual(found.after, { kind: 'text', content });
  assert.equal(s.reads.length, count, 'A unique prefix is a hit');
  // The same prefix with a patch the cached bytes do not match is read by path.
  const other = { ...file, path: 'y.ts', patch: '@@ -1 +1 @@\n-a\n+different' };
  s.commit(head(3), { 'y.ts': 'different\n' });
  const refused = await load(s.client, { url, path: 'y.ts', baseSha: base, headSha: head(3) }, snapshot(head(3), [other]), other);
  assert.deepEqual(refused.after, { kind: 'text', content: 'different\n' });
  assert.equal(s.pathReads(head(3)).length, 1);
  // A prefix shorter than seven digits, or one without a patch to check, is never used for a lookup.
  const short = await readGitHubFile(s.client, { owner: 'o', repo: 'r', path: 'x.ts', ref: head(2), blobSha: full.slice(0, 6) });
  assert.equal(short.toString(), content);
  assert.equal(s.pathReads(head(2)).length, 1);
});

void test('a prefix two cached blobs share is ambiguous and reads by path', async () => {
  const s = server();
  // These two blobs share the first seven digits: 2acdf8c.
  const one = 'collision 26993\n',
    two = 'collision 30025\n';
  assert.equal(sha(one).slice(0, 7), sha(two).slice(0, 7));
  s.commit(head(1), { 'one.txt': one, 'two.txt': two });
  for (const [path, value] of [['one.txt', one], ['two.txt', two]])
    await readGitHubFile(s.client, { owner: 'o', repo: 'r', path, ref: head(1), blobSha: sha(value) });
  const count = s.reads.length;
  const read = await readGitHubFile(s.client, {
    owner: 'o',
    repo: 'r',
    path: 'one.txt',
    ref: head(1),
    blobSha: sha(one).slice(0, 7),
    verify: () => true,
  });
  assert.equal(read.toString(), one);
  assert.equal(s.reads.length, count + 1, 'Ambiguous: one path read');
  assert.equal(s.reads.at(-1)?.pathname.includes('/contents/'), true);
  // Eight digits tell them apart.
  const exact = await readGitHubFile(s.client, { owner: 'o', repo: 'r', path: 'two.txt', ref: head(5), blobSha: sha(two).slice(0, 8), verify: () => true });
  assert.equal(exact.toString(), two);
  assert.equal(s.reads.length, count + 1);
});

void test('blob reads keep the size limits and detect LFS pointers from the bytes', async () => {
  const s = server();
  const large = Buffer.alloc(1_000_001, 'a');
  const huge = Buffer.alloc(8_000_001, 'b');
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '4'.repeat(64) + '\nsize 12345\n';
  s.commit(merge, {});
  s.commit(head(1), { 'large.txt': large, 'huge.txt': huge, 'model.bin': pointer });
  const lfs = { remote: () => Promise.resolve(undefined) } as unknown as Parameters<typeof createSnapshotFileLoader>[0];
  const load = createSnapshotFileLoader(lfs);
  const value = snapshot(head(1), []);
  const open = (path: string, bytes: string | Buffer) => {
    const file = { ...changed(path, ''), status: 'added' as const, blobSha: sha(bytes) };
    return load(s.client, { url, path, baseSha: base, headSha: head(1) }, { ...value, files: [file] }, file);
  };
  await assert.rejects(open('large.txt', large), /too large to preview/);
  const lfsResult = await open('model.bin', pointer);
  assert.equal(lfsResult.after.kind === 'lfs' ? lfsResult.after.pointer.size : undefined, 12345);
  // Above 8 MB the bytes are never stored, so a later read asks GitHub again.
  await readGitHubFile(s.client, { owner: 'o', repo: 'r', path: 'huge.txt', ref: head(1), blobSha: sha(huge) });
  const count = s.blobReads().length;
  await readGitHubFile(s.client, { owner: 'o', repo: 'r', path: 'huge.txt', ref: head(1), blobSha: sha(huge) });
  assert.equal(s.blobReads().length, count + 1);
});

void test('bytes that do not hash to the requested SHA are returned but never cached', async () => {
  const s = server();
  s.commit(head(1), { 'a.ts': 'real\n' });
  const wrong = 'b'.repeat(40);
  // The fake serves nothing for `wrong`; give it different bytes under that SHA.
  const pool = createGitHubClientPool({
    fetch: (() => Promise.resolve(new Response('not the blob\n'))) as typeof fetch,
  });
  const client = pool.client('account');
  let requests = 0;
  for (let i = 0; i < 2; i++)
    await readGitHubFile(client, { owner: 'o', repo: 'r', path: 'a.ts', ref: head(1), blobSha: wrong }, () => requests++);
  assert.equal(requests, 2);
});

void test('review generation reads after sides by blob SHA, so a push only downloads changed files', async () => {
  const s = server();
  const unchanged = text('same'),
    before = text('changed', 1),
    after = text('changed', 2);
  s.commit(merge, { 'same.ts': text('same', 0), 'changed.ts': before });
  s.commit(head(1), { 'same.ts': unchanged, 'changed.ts': before });
  s.commit(head(2), { 'same.ts': unchanged, 'changed.ts': after });
  const pr = (headSha: string, files: Record<string, string>) => {
    const source = new GitHubDiffSource(url, null, s.client);
    const metadata = { baseSha: base, headSha, baseRepo: 'o/r', headRepo: 'o/r', changedFileCount: 2 } as Awaited<ReturnType<GitHubDiffSource['getMetadata']>>;
    source.getMetadata = () => Promise.resolve(metadata);
    source.getComparisonBase = () => Promise.resolve(merge);
    // The file list is the only metadata this read needs; it comes from GitHub's PR files list.
    (source as unknown as { blobs: Map<string, string> }).blobs = new Map(Object.entries(files).map(([p, c]) => [p, sha(c)]));
    return source;
  };
  const first = pr(head(1), { 'same.ts': unchanged, 'changed.ts': before });
  assert.equal(await first.getFileContent('same.ts', 'head'), unchanged);
  assert.equal(await first.getFileContent('changed.ts', 'head'), before);
  assert.equal(s.blobReads().length, 2);
  const count = s.reads.length;
  const second = pr(head(2), { 'same.ts': unchanged, 'changed.ts': after });
  assert.equal(await second.getFileContent('same.ts', 'head'), unchanged);
  assert.equal(await second.getFileContent('changed.ts', 'head'), after);
  assert.equal(await second.getFileContent('changed.ts', 'base'), before);
  assert.equal(s.reads.length - count, 2, 'One blob for the changed file, one path read for the base side');
  assert.equal(await second.getFileContent('missing.ts', 'base'), null, 'A missing file is still null');
});

void test('the patch check accepts only text whose new-side lines match', () => {
  const patch = '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n\\ No newline at end of file\n@@ -9 +10 @@\n-x\n+y';
  const lines = ['a', 'c', 'd', '4', '5', '6', '7', '8', '9', 'y'];
  assert.equal(matchesPatch(Buffer.from(lines.join('\n')), patch), true);
  assert.equal(matchesPatch(Buffer.from(lines.join('\n').replace('d', 'e')), patch), false);
  assert.equal(matchesPatch(Buffer.from('anything'), ''), false, 'No hunk, nothing to check');
});
