import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitHubClientPool, closeCaches } from './cache-test-pool';
import {
  createLocalClones,
  inspectLocalClone,
  normalizeLocalClones,
  parseGitHubRemote,
  splitPatches,
  type LocalCloneEntry,
} from '../lib/local-clone';
import { createLocalCloneStore } from '../src/local-clone-store';
import { createPrChangesService } from '../src/pr-changes-service';
import { createPrCommitsService } from '../src/pr-commits-service';
import { createStackChangesService } from '../src/stack-changes-service';
import { GitHubBackoffError } from '../lib/github-client';
import { withGitHubPriority } from '../lib/github-scheduler';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

const url = 'https://github.com/o/r/pull/1';
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: '123+dev-login@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
delete env.GIT_INDEX_FILE;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const commit = (dir: string, message: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
};

/** A real upstream and an older clone of it, so missing commits must travel over a real fetch. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-clone-'));
  const upstream = path.join(root, 'upstream.git');
  const work = path.join(root, 'work');
  const clone = path.join(root, 'clone');
  git(root, 'init', '-q', '--bare', '-b', 'main', upstream);
  git(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(root, 'clone', '-q', upstream, work);
  git(work, 'checkout', '-q', '-B', 'main');
  write(work, 'keep.ts', 'one\ntwo\nthree\n');
  write(work, 'gone.ts', 'bye\n');
  write(work, 'name with space é.ts', 'old\n');
  write(work, 'link-target', 'plain\n');
  write(work, 'moved/from.ts', 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
  const base = commit(work, 'Base');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', upstream, clone);
  git(work, 'checkout', '-qb', 'one');
  write(work, 'keep.ts', 'one\nchanged\nthree\n');
  fs.rmSync(path.join(work, 'gone.ts'));
  write(work, 'name with space é.ts', 'new\n');
  write(work, 'image.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
  fs.mkdirSync(path.join(work, 'moved/to'));
  fs.renameSync(path.join(work, 'moved/from.ts'), path.join(work, 'moved/to/from.ts'));
  fs.rmSync(path.join(work, 'link-target'));
  fs.symlinkSync('keep.ts', path.join(work, 'link-target'));
  write(work, 'after-type-change.ts', 'still attributed correctly\n');
  const first = commit(work, 'First\n\nBody text');
  write(work, 'keep.ts', 'one\nchanged again\nthree\n');
  const second = commit(work, 'Second');
  git(work, 'checkout', '-qb', 'two');
  write(work, 'stacked.ts', 'stacked\n');
  const third = commit(work, 'Third');
  git(work, 'push', '-q', 'origin', 'one', 'two');
  const entry: LocalCloneEntry = { repo: 'o/r', path: clone, remote: 'origin' };
  const clones = createLocalClones();
  clones.configure([entry]);
  return { root, upstream, work, clone, base, first, second, third, entry, clones };
}
function member(number: number, baseSha: string, headSha: string, commits: number) {
  return {
    url: `https://github.com/o/r/pull/${number}`,
    number,
    repo: 'o/r',
    baseRepo: 'o/r',
    headRepo: 'o/r',
    baseBranch: 'main',
    headBranch: 'one',
    baseSha,
    headSha,
    title: `PR ${number}`,
    description: 'From discovery',
    author: 'dev',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    state: 'open',
    merged: false,
    isDraft: false,
    labels: [],
    requestedReviewers: [],
    requestedTeams: [],
    commitCount: commits,
    role: 'review-requested',
  } as unknown as ReviewMember;
}
/** Answers PR details only. Everything else proves the clone was bypassed. */
function github(prs: Record<number, ReviewMember>, options: { limited?: boolean } = {}) {
  const reads: string[] = [];
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((input: string) => {
      const u = new URL(input);
      reads.push(u.pathname);
      const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', ...headers },
        });
      if (options.limited)
        return Promise.resolve(json({ message: 'API rate limit exceeded' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        }));
      const match = /\/pulls\/(\d+)$/.exec(u.pathname);
      const pr = match && prs[Number(match[1])];
      if (!pr) return Promise.resolve(json({ message: `Unexpected GitHub read: ${u.pathname}` }, 500));
      return Promise.resolve(json({
        title: pr.title,
        body: 'From GitHub',
        user: { login: 'dev' },
        base: { ref: 'main', sha: pr.baseSha, repo: { full_name: 'o/r' } },
        head: { ref: pr.headBranch, sha: pr.headSha, repo: { full_name: 'o/r' } },
        state: 'open',
        labels: [],
        commits: pr.commitCount,
        changed_files: 3,
        html_url: pr.url,
      }));
    }) as typeof fetch,
  });
  return { client: pool.client('token'), reads };
}

test.after(closeCaches);

void test('parseGitHubRemote accepts GitHub remotes and rejects lookalike hosts', () => {
  for (const remote of [
    'git@github.com:o/r.git',
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'ssh://git@github.com/o/r.git',
    'ssh://git@ssh.github.com:443/o/r.git',
    'https://user:secret@github.com/o/r.git',
  ])
    assert.equal(parseGitHubRemote(remote), 'o/r', remote);
  for (const remote of ['git@github.com.evil.org:o/r.git', 'https://notgithub.com/o/r', 'https://github.com/o', '/srv/o/r.git'])
    assert.equal(parseGitHubRemote(remote), undefined, remote);
});

void test('splitPatches keeps a trailing blank context line and ignores content that resembles a header', () => {
  const diff = [
    'diff --git a/a b/a',
    'index 1..2 100644',
    '--- a/a',
    '+++ b/a',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+diff --git a/x b/x',
    ' ',
    'diff --git a/image b/image',
    'Binary files a/image and b/image differ',
    '',
  ].join('\n');
  assert.deepEqual(splitPatches(diff), ['@@ -1,2 +1,2 @@\n-old\n+diff --git a/x b/x\n ', undefined]);
});

void test('normalizeLocalClones drops unsafe entries and keeps one clone per repository', () => {
  assert.deepEqual(
    normalizeLocalClones([
      { repo: 'o/r', path: '/a', remote: 'origin' },
      { repo: 'O/R', path: '/b', remote: 'origin' },
      { repo: 'bad', path: '/c', remote: 'origin' },
      { repo: 'o/x', path: 'relative', remote: 'origin' },
      { repo: 'o/y', path: '/d', remote: '--upload-pack=x' },
    ]),
    [{ repo: 'O/R', path: '/b', remote: 'origin' }]
  );
});

void test('changes match GitHub file semantics, including renames, type changes, and unusual names', async () => {
  const f = fixture();
  const changes = await f.clones.read('O/R', (clone) => clone.changes(f.base, f.second));
  assert.ok(changes);
  assert.equal(changes.mergeBase, f.base);
  const byName = new Map(changes.files.map((file) => [file.filename, file]));
  assert.equal(byName.get('gone.ts')?.status, 'removed');
  assert.ok(byName.get('gone.ts')?.sha);
  assert.equal(byName.get('image.png')?.status, 'added');
  assert.equal(byName.get('image.png')?.patch, undefined);
  assert.equal(byName.get('moved/to/from.ts')?.status, 'renamed');
  assert.equal(byName.get('moved/to/from.ts')?.previous_filename, 'moved/from.ts');
  assert.equal(byName.get('link-target')?.status, 'modified');
  const spaced = byName.get('name with space é.ts');
  assert.equal(spaced?.status, 'modified');
  assert.deepEqual([spaced.additions, spaced.deletions], [1, 1]);
  assert.match(spaced.patch ?? '', /^@@ .*\n-old\n\+new$/);
  // Sections after a type change must not shift onto the wrong file.
  assert.match(byName.get('keep.ts')?.patch ?? '', /\+changed again/);
  assert.match(byName.get('after-type-change.ts')?.patch ?? '', /\+still attributed correctly/);
});

void test('missing commits are fetched by SHA without touching refs, FETCH_HEAD, or the working tree', async () => {
  const f = fixture();
  const refs = git(f.clone, 'for-each-ref');
  const status = git(f.clone, 'status', '--porcelain');
  assert.throws(() => git(f.clone, 'cat-file', '-e', `${f.second}^{commit}`));
  const diff = await f.clones.read('o/r', (clone) => clone.diff(f.base, f.second));
  assert.match(diff ?? '', /^diff --git /);
  git(f.clone, 'cat-file', '-e', `${f.second}^{commit}`);
  assert.equal(git(f.clone, 'for-each-ref'), refs);
  assert.equal(git(f.clone, 'status', '--porcelain'), status);
  assert.equal(fs.existsSync(path.join(f.clone, '.git/FETCH_HEAD')), false);
  assert.deepEqual(f.clones.status()[0].reads, 1);
});

void test('concurrent readers share fetches, and a bad SHA only affects its own reader', async () => {
  const f = fixture();
  const missing = 'f'.repeat(40);
  const [good, bad] = await Promise.all([
    f.clones.read('o/r', (clone) => clone.commits(f.base, f.second)),
    f.clones.read('o/r', (clone) => clone.blob(missing, 'keep.ts')),
  ]);
  assert.equal(good?.length, 2);
  assert.equal(bad, undefined);
  assert.equal(f.clones.status()[0].fallbacks, 1);
  // The cooldown answers without another network attempt.
  git(f.clone, 'remote', 'set-url', 'origin', '/nonexistent');
  assert.equal(await f.clones.read('o/r', (clone) => clone.blob(missing, 'keep.ts')), undefined);
  assert.match(f.clones.status()[0].lastError ?? '', /recently failed/);
});

void test('an interactive reader stops waiting for a slow fetch; a background reader does not', async () => {
  const f = fixture();
  // A fetch through a remote helper that sleeps first.
  const slow = path.join(f.root, 'slow.sh');
  fs.writeFileSync(slow, `#!/bin/sh\nsleep 1\nexec git upload-pack "$@"\n`, { mode: 0o755 });
  // Git runs this setting through a shell; Windows separators must not become escapes.
  git(f.clone, 'config', 'remote.origin.uploadpack', `sh "${slow.replaceAll('\\', '/')}"`);
  const clones = createLocalClones({ interactiveFetchWaitMs: 50 });
  clones.configure([f.entry]);
  const started = Date.now();
  const interactive = await withGitHubPriority('interactive', () => clones.read('o/r', (clone) => clone.mergeBase(f.base, f.second)));
  assert.equal(interactive, undefined);
  assert.ok(Date.now() - started < 900);
  const background = await withGitHubPriority('background', () => clones.read('o/r', (clone) => clone.mergeBase(f.base, f.second)));
  assert.equal(background, f.base);
});

void test('commits normalize to GitHub fields and derive logins from noreply addresses', async () => {
  const f = fixture();
  const commits = await f.clones.read('o/r', (clone) => clone.commits(f.base, f.second));
  assert.deepEqual(commits?.map((c) => c.sha), [f.first, f.second]);
  assert.equal(commits[0].message, 'First\n\nBody text');
  assert.deepEqual(commits[0].parents, [f.base]);
  assert.equal(commits[0].author.login, 'dev-login');
  assert.equal(commits[0].url, `https://github.com/o/r/commit/${f.first}`);
  assert.match(commits[0].authoredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

void test('blobs return raw bytes and null for an absent path', async () => {
  const f = fixture();
  const image = await f.clones.read('o/r', (clone) => clone.blob(f.second, 'image.png'));
  assert.deepEqual(image, Buffer.from([0x89, 0x50, 0, 1, 2]));
  assert.equal(await f.clones.read('o/r', (clone) => clone.blob(f.second, 'nope.ts')), null);
  assert.equal(f.clones.status()[0].fallbacks, 0);
});

void test('file history counts commits per file, treats added files as new, and takes names literally', async () => {
  const f = fixture();
  const history = await f.clones.read('o/r', (clone) => clone.fileHistory(f.base, f.second, [
    { filename: 'keep.ts', status: 'modified' },
    { filename: 'image.png', status: 'added' },
    { filename: '*.ts', status: 'modified' },
  ]));
  assert.deepEqual(history?.map((item) => item.commitCount), [2, 1, 1]);
  assert.match(history[0].lastModified ?? '', /^\d{4}-/);
  assert.deepEqual(history.slice(1).map((item) => item.lastModified), [null, null]);
});

void test('settings can show why a clone failed', async () => {
  const f = fixture();
  fs.rmSync(f.clone, { recursive: true });
  assert.equal(await f.clones.read('o/r', (clone) => clone.mergeBase(f.base, f.second)), undefined);
  assert.match(f.clones.status()[0].lastError ?? '', /Cannot open/);
});

void test('a clone that becomes shallow after registration falls back to GitHub', async () => {
  const f = fixture();
  let time = 1000;
  const clones = createLocalClones({ now: () => time });
  clones.configure([f.entry]);
  assert.equal(await clones.read('o/r', (clone) => clone.mergeBase(f.base, f.base)), f.base);
  fs.writeFileSync(path.join(f.clone, '.git/shallow'), `${f.base}\n`);
  time += 61_000;
  assert.equal(await clones.read('o/r', (clone) => clone.mergeBase(f.base, f.base)), undefined);
  assert.match(clones.status()[0].lastError ?? '', /now shallow/);
  fs.rmSync(path.join(f.clone, '.git/shallow'));
  assert.equal(await clones.read('o/r', (clone) => clone.mergeBase(f.base, f.base)), f.base);
});

void test('inspectLocalClone reads remotes and rejects unusable folders', async () => {
  const f = fixture();
  await assert.rejects(inspectLocalClone(f.root), /not a Git repository/);
  await assert.rejects(inspectLocalClone(f.clone), /no github\.com remote/);
  git(f.clone, 'remote', 'set-url', 'origin', 'git@github.com:Owner/Name.git');
  git(f.clone, 'remote', 'add', 'upstream', 'https://github.com/org/name.git');
  git(f.clone, 'remote', 'add', 'other', 'https://gitlab.com/org/name.git');
  const entries = await inspectLocalClone(path.join(f.clone));
  assert.deepEqual(
    entries.map((e) => [e.repo, e.remote]).sort(),
    [['Owner/Name', 'origin'], ['org/name', 'upstream']]
  );
  // Native realpath expands Windows 8.3 temporary directory aliases on both sides.
  assert.equal(fs.realpathSync.native(entries[0].path), fs.realpathSync.native(f.clone));
  const shallow = path.join(f.root, 'shallow');
  git(f.root, 'clone', '-q', '--depth', '1', `file://${f.upstream}`, shallow);
  await assert.rejects(inspectLocalClone(shallow), /shallow/);
});

void test('the store persists registrations and removes every remote of a folder', async () => {
  const f = fixture();
  git(f.clone, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  const file = path.join(f.root, 'data', 'local-clones.json');
  const store = createLocalCloneStore(() => file);
  const added = await store.add(f.clone);
  assert.equal(added[0].repo, 'o/r');
  assert.deepEqual(createLocalCloneStore(() => file).load(), added);
  assert.deepEqual(store.remove(added[0].path), []);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(store.load(), []);
});

void test('PR changes and contents come from the clone; GitHub is asked only for PR details', async () => {
  const f = fixture();
  const pr = member(1, f.base, f.second, 2);
  const { client, reads } = github({ 1: pr });
  const service = createPrChangesService(f.clones);
  const snapshot = await service.manifest(client, url);
  assert.equal(snapshot.metadata.description, 'From GitHub');
  assert.equal(snapshot.comparisonBase, f.base);
  assert.ok(snapshot.files.some((file) => file.path === 'gone.ts' && file.status === 'deleted'));
  const request = { url, baseSha: f.base, headSha: f.second };
  const keep = await service.content(client, { ...request, path: 'keep.ts' });
  assert.deepEqual(keep.after, { kind: 'text', content: 'one\nchanged again\nthree\n' });
  assert.deepEqual(keep.before, { kind: 'text', content: 'one\ntwo\nthree\n' });
  const moved = await service.content(client, { ...request, path: 'moved/to/from.ts' });
  assert.equal(moved.before.kind, 'text');
  const image = await service.content(client, { ...request, path: 'image.png' });
  assert.equal(image.after.kind, 'image');
  assert.deepEqual([...new Set(reads)], ['/repos/o/r/pulls/1']);
  assert.equal(reads.length, 1);
});

void test('an LFS pointer from the clone still reaches the LFS path instead of being shown as text', async () => {
  const f = fixture();
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`;
  git(f.work, 'checkout', '-q', 'two');
  write(f.work, 'model.bin', pointer);
  const head = commit(f.work, 'LFS');
  git(f.work, 'push', '-q', 'origin', 'two');
  const { client } = github({ 1: member(1, f.third, head, 1) });
  const service = createPrChangesService(f.clones);
  await service.manifest(client, url);
  const contents = await service.content(client, { url, baseSha: f.third, headSha: head, path: 'model.bin' });
  assert.equal(contents.after.kind, 'lfs');
});

void test('the prepared review diff comes from the clone without any GitHub read', async () => {
  const f = fixture();
  const { client, reads } = github({});
  const service = createPrChangesService(f.clones);
  await service.prepareReview(client, url, { baseSha: f.base, headSha: f.second });
  assert.deepEqual(reads, []);
});

void test('a clone that cannot answer falls back to GitHub', async () => {
  const f = fixture();
  fs.rmSync(f.clone, { recursive: true });
  const { client, reads } = github({ 1: member(1, f.base, f.second, 2) });
  await assert.rejects(createPrChangesService(f.clones).manifest(client, url));
  assert.ok(reads.some((read) => read.endsWith('/pulls/1/files')));
  assert.equal(f.clones.status()[0].fallbacks, 1);
});

void test('a paused API does not stop a clone when discovery already knows the revision', async () => {
  const f = fixture();
  const pr = member(1, f.base, f.second, 2);
  const { client } = github({}, { limited: true });
  const changes = await createPrChangesService(f.clones).manifest(client, url, false, { revision: pr });
  assert.equal(changes.metadata.description, 'From discovery');
  const commits = await createPrCommitsService(f.clones).list(client, url, false, { revision: pr });
  assert.equal(commits.commits.length, 2);
  // Without a known revision, or without a clone, the pause still applies.
  const { client: other } = github({}, { limited: true });
  await assert.rejects(createPrChangesService(f.clones).manifest(other, url), GitHubBackoffError);
  const { client: third } = github({}, { limited: true });
  await assert.rejects(createPrChangesService(createLocalClones()).manifest(third, url, false, { revision: pr }), GitHubBackoffError);
});

void test('a queued revision reads from the clone without waiting for GitHub; a refresh still asks', async () => {
  const f = fixture();
  const pr = member(1, f.base, f.second, 2);
  const { client, reads } = github({ 1: pr });
  const changes = createPrChangesService(f.clones);
  const commits = createPrCommitsService(f.clones);
  const snapshot = await changes.manifest(client, url, false, { revision: pr });
  const list = await commits.list(client, url, false, { revision: pr });
  assert.equal(snapshot.metadata.description, 'From discovery');
  assert.equal(snapshot.comparisonBase, f.base);
  assert.equal(list.commits.length, 2);
  assert.deepEqual(reads, []);
  // A bare revision has no details to show, so it still needs GitHub.
  const { client: bare, reads: bareReads } = github({ 1: pr });
  await createPrCommitsService(f.clones).list(bare, url, false, { revision: { baseSha: f.base, headSha: f.second } });
  assert.deepEqual(bareReads, ['/repos/o/r/pulls/1']);
  const { client: fresh, reads: freshReads } = github({ 1: pr });
  const refreshed = await createPrCommitsService(f.clones).list(fresh, url, true, { revision: pr });
  assert.equal(refreshed.metadata.description, 'From GitHub');
  assert.deepEqual(freshReads, ['/repos/o/r/pulls/1']);
});

void test('a queued revision with a disagreeing commit count defers to GitHub', async () => {
  const f = fixture();
  const stale = member(1, f.base, f.second, 5);
  const { client, reads } = github({ 1: member(1, f.base, f.second, 2) });
  const list = await createPrCommitsService(f.clones).list(client, url, false, { revision: stale });
  assert.equal(list.commits.length, 2);
  assert.equal(list.metadata.description, 'From GitHub');
  assert.deepEqual(reads, ['/repos/o/r/pulls/1']);
});

void test('a clone that cannot answer a queued revision uses fresh GitHub details', async () => {
  const f = fixture();
  fs.rmSync(f.clone, { recursive: true });
  const pr = member(1, f.base, f.second, 2);
  const { client, reads } = github({ 1: pr });
  await assert.rejects(createPrChangesService(f.clones).manifest(client, url, false, { revision: pr }));
  assert.equal(reads[0], '/repos/o/r/pulls/1');
  assert.ok(reads.some((read) => read.endsWith('/pulls/1/files')));
});

void test('commit lists and comparisons come from the clone', async () => {
  const f = fixture();
  const { client, reads } = github({ 1: member(1, f.base, f.second, 2) });
  const service = createPrCommitsService(f.clones);
  const list = await service.list(client, url);
  assert.equal(list.commits.length, 2);
  const selection = { url, prBaseSha: f.base, prHeadSha: f.second, firstSha: f.second, lastSha: f.second };
  const single = await service.comparison(client, selection);
  assert.deepEqual(single.files.map((file) => file.path), ['keep.ts']);
  assert.equal(single.comparisonBase, f.first);
  const range = await service.comparison(client, { ...selection, firstSha: f.first, lastSha: f.second });
  assert.ok(range.files.length > 1);
  const contents = await service.content(client, { url, baseSha: f.first, headSha: f.second, path: 'keep.ts', comparison: selection });
  assert.deepEqual(contents.after, { kind: 'text', content: 'one\nchanged again\nthree\n' });
  assert.deepEqual([...new Set(reads)], ['/repos/o/r/pulls/1']);
});

void test('a commit count that disagrees with GitHub defers to GitHub', async () => {
  const f = fixture();
  const { client, reads } = github({ 1: member(1, f.base, f.second, 5) });
  await assert.rejects(createPrCommitsService(f.clones).list(client, url));
  assert.ok(reads.some((read) => read.endsWith('/pulls/1/commits')));
});

void test('combined stack changes need no comparison requests, and a broken stack keeps its error', async () => {
  const f = fixture();
  const one = member(1, f.base, f.second, 2);
  const two = { ...member(2, f.second, f.third, 1), baseBranch: 'one', headBranch: 'two' };
  const subject: ReviewSubject = {
    id: 'stack',
    kind: 'stack',
    title: 'Stack',
    members: [one, two],
    edges: [{ parent: one.url, child: two.url, evidence: 'branch' }],
    warnings: [],
  };
  const { client, reads } = github({ 1: one, 2: two });
  const prs = createPrChangesService(f.clones);
  const stack = createStackChangesService(prs, f.clones);
  const combined = await stack.read(client, subject);
  assert.equal(combined.comparisonBase, f.base);
  assert.equal(combined.filesTruncated, false);
  assert.ok(combined.files.some((file) => file.path === 'stacked.ts'));
  assert.ok(reads.every((read) => /\/pulls\/\d+$/.test(read)));

  // The child no longer contains its parent's head: a sibling, not a stack.
  git(f.work, 'checkout', '-q', '-b', 'sibling', f.first);
  write(f.work, 'sibling.ts', 'x\n');
  const sibling = commit(f.work, 'Sibling');
  git(f.work, 'push', '-q', 'origin', 'sibling');
  const stale = { ...two, baseSha: f.first, headSha: sibling };
  const { client: other } = github({ 1: one, 2: stale });
  await assert.rejects(
    createStackChangesService(createPrChangesService(f.clones), f.clones).read(other, { ...subject, members: [one, stale] }),
    /does not include the current commits/
  );
});
