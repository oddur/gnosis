import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConflictResolutionService, conflictSessionDirectory } from '../src/conflict-resolution-service';
import {
  SHARED_LAYOUT_FILE,
  conflictStoreDirectory,
  conflictStoreRefPrefix,
  localCloneObjectDirectory,
} from '../src/conflict-object-store';
import type { ConflictSession } from '../lib/conflict-resolution';
import type { PrActionState } from '../lib/pr-actions';

const exec = promisify(execFile);
const account = 'tester';
const repo = 'test/repo';

/** A remote with history on both sides and content, rename, delete, mode, binary and symlink conflicts. */
async function remoteFixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflict-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote');
  await fs.mkdir(remote);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: remote })).stdout.trim();
  const write = (file: string, text: string | Buffer) =>
    fs
      .mkdir(path.dirname(path.join(remote, file)), { recursive: true })
      .then(() => fs.writeFile(path.join(remote, file), text));
  const commit = async (message: string) => {
    await git('add', '-A');
    await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'uploadpack.allowFilter', 'true');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  // Old history the shallow path must not need.
  for (let i = 0; i < 5; i++) {
    await write(`history/${i}.txt`, `old ${i}\n`);
    await commit(`history ${i}`);
  }
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  await write('content.ts', lines.join('\n') + '\n');
  await write('renamed.txt', 'rename me\n'.repeat(20));
  await write('deleted.txt', 'shared text\n'.repeat(10));
  await write('mode.sh', 'echo base\n');
  await write('binary.bin', Buffer.from([0, 1, 2, 3, 0, 5]));
  await write('link.txt', 'regular file\n');
  await write('clean.txt', 'unchanged\n');
  const ancestor = await commit('ancestor');
  await git('checkout', '-q', '-b', 'feature');
  await write('content.ts', lines.map((line, i) => (i === 10 ? 'ours 10' : line)).join('\n') + '\n');
  await git('mv', 'renamed.txt', 'renamed-ours.txt');
  await write('deleted.txt', 'shared text\n'.repeat(10) + 'ours\n');
  await write('mode.sh', 'echo ours\n');
  await write('binary.bin', Buffer.from([0, 1, 2, 3, 0, 6]));
  await git('add', '-A');
  // Set the executable bit and the symlink in the index, not the file system: Windows has neither, so
  // chmod and symlink there would quietly commit plain files and the fixture would lose its mode and
  // type conflicts. Commit the index directly; `commit()` would re-add from the work tree.
  await git('update-index', '--chmod=+x', 'mode.sh');
  await write('.link-target', 'content.ts');
  const linkBlob = await git('hash-object', '-w', '.link-target');
  await fs.rm(path.join(remote, '.link-target'));
  await git('update-index', '--cacheinfo', `120000,${linkBlob},link.txt`);
  await git('commit', '-q', '-m', 'PR changes');
  // Match the work tree to the committed symlink so later `add -A` calls keep it.
  await git('checkout', '-q', '--', 'link.txt', 'mode.sh').catch(() => undefined);
  await write('feature-only.txt', 'more PR history\n');
  const head = await commit('more PR changes');
  await git('checkout', '-q', 'main');
  await write('content.ts', lines.map((line, i) => (i === 10 ? 'theirs 10' : line)).join('\n') + '\n');
  await git('mv', 'renamed.txt', 'renamed-theirs.txt');
  await git('rm', '-q', 'deleted.txt');
  await write('mode.sh', 'echo theirs\n');
  await write('binary.bin', Buffer.from([0, 1, 2, 3, 0, 7]));
  await write('link.txt', 'theirs file\n');
  await commit('base changes');
  await write('main-only.txt', 'more base history\n');
  const base = await commit('more base changes');
  return { dir, remote, git, write, commit, ancestor, head, base };
}

function service(
  remote: { dir: string; remote: string; git: (...args: string[]) => Promise<string> },
  options: {
    cache?: string;
    shallow?: boolean;
    mergeBase?: (repo: string, base: string, head: string) => Promise<string | undefined>;
    localClone?: string;
    data?: Map<string, unknown>;
    states?: Map<string, PrActionState>;
  } = {}
) {
  const data = options.data ?? new Map<string, unknown>();
  const states = options.states ?? new Map<string, PrActionState>();
  const deps = {
    storage: {
      read: (key: string) => structuredClone(data.get(key)),
      write: (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      flush: async () => {},
      names: () => [...data.keys()],
    },
    directory: () => options.cache ?? path.join(remote.dir, 'cache'),
    context: () => ({ account, token: 'not-a-real-token' }),
    read: (url: string) => {
      const value = states.get(url);
      return value ? Promise.resolve({ ...value }) : Promise.reject(new Error(`No PR state for ${url}`));
    },
    remote: () => remote.remote,
    mergiraf: () => '/nonexistent',
    suggest: () => Promise.resolve({ explanation: '' }),
    localClone: options.localClone ? () => options.localClone : undefined,
    ...(options.mergeBase || options.shallow
      ? {
          mergeBase:
            options.mergeBase ?? ((_repo: string, base: string, head: string) => remote.git('merge-base', base, head)),
        }
      : {}),
  };
  const conflicts = createConflictResolutionService(deps);
  const reports: string[] = [];
  return {
    deps,
    data,
    states,
    reports,
    maintain: () => conflicts.maintain(),
    run: (request: Parameters<typeof conflicts.run>[0]) =>
      conflicts.run(request, new AbortController().signal, (text) => reports.push(text)),
  };
}

function state(url: string, head: string, base: string, headBranch = 'feature'): PrActionState {
  return {
    account,
    url,
    repository: repo,
    headRepo: repo,
    title: 'PR',
    headSha: head,
    baseSha: base,
    headBranch,
    baseBranch: 'main',
    state: 'OPEN',
    archived: false,
    canUpdateBranch: true,
  } as PrActionState;
}

const url = 'https://github.com/test/repo/pull/1';
const summary = (session: ConflictSession) => ({
  tree: session.tree,
  preparation: session.preparation,
  files: session.files.map(({ path, mode, base, ours, theirs, original, unsupported }) => ({
    path,
    mode,
    base,
    ours,
    theirs,
    original,
    unsupported,
  })),
});
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false
  );

void test('the shallow three-commit path finds exactly the conflicts of the full-history path', async (t) => {
  const f = await remoteFixture(t);
  const pr = state(url, f.head, f.base);
  const full = service(f, { cache: path.join(f.dir, 'full') });
  full.states.set(url, pr);
  const shallow = service(f, { cache: path.join(f.dir, 'shallow'), shallow: true });
  shallow.states.set(url, pr);
  const expected = (await full.run({ kind: 'open', url })).session;
  const actual = (await shallow.run({ kind: 'open', url })).session;
  assert.deepEqual(summary(actual), summary(expected));
  // Every kind of conflict appears, and only the content conflict is editable.
  const files = new Map(actual.files.map((file) => [file.path, file]));
  assert.equal(files.get('content.ts')?.unsupported, undefined);
  assert.match(files.get('content.ts')?.original ?? '', /<<<<<<< /);
  for (const file of ['deleted.txt', 'mode.sh', 'binary.bin', 'link.txt', 'renamed.txt'])
    assert.ok(files.get(file)?.unsupported, `${file} needs a local merge tool`);
  assert.ok([...files.keys()].some((file) => file.startsWith('renamed-')));
  // The store holds three commits without their history, and the session only borrows them.
  const store = conflictStoreDirectory(path.join(f.dir, 'shallow'), account, repo);
  assert.equal((await fs.readFile(path.join(store, 'shallow'), 'utf8')).trim().split('\n').length, 3);
  const { stdout } = await exec('git', ['rev-list', '--count', f.head], { cwd: store });
  assert.equal(stdout.trim(), '1');
  const session = await conflictSessionDirectory(path.join(f.dir, 'shallow'), account, actual.id);
  assert.ok(await exists(path.join(session, SHARED_LAYOUT_FILE)));
  assert.equal(
    (await fs.readFile(path.join(session, 'objects', 'info', 'alternates'), 'utf8')).trim(),
    path.join(store, 'objects')
  );
  assert.ok(shallow.reports.includes('Fetching 3 commits from GitHub.'));
});

void test('a resolution prepared from the shallow store publishes a merge commit with both parents', async (t) => {
  const g = await remoteFixture(t);
  await g.git('checkout', '-q', '-b', 'simple', g.ancestor);
  await g.write('content.ts', 'simple PR\n');
  const head = await g.commit('only a content conflict');
  await g.git('checkout', '-q', 'main');
  const p = service(g, { shallow: true });
  p.states.set(url, state(url, head, g.base, 'simple'));
  let session = (await p.run({ kind: 'open', url })).session;
  assert.deepEqual(
    session.files.map((file) => [file.path, file.unsupported]),
    [['content.ts', undefined]]
  );
  session = (
    await p.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: 'content.ts',
      contents: 'merged\n',
      resolved: true,
    })
  ).session;
  const preview = (await p.run({ kind: 'preview', id: session.id, version: session.version })).preview;
  assert.ok(preview);
  const published = await p.run({
    kind: 'publish',
    id: session.id,
    version: session.version,
    previewToken: preview.token,
    message: 'Resolve',
  });
  assert.equal(published.session.status, 'published');
  assert.equal(await g.git('rev-parse', 'simple^1'), head);
  assert.equal(await g.git('rev-parse', 'simple^2'), g.base);
  assert.equal(await g.git('show', 'simple:main-only.txt'), 'more base history');
  assert.equal(await g.git('show', 'simple:content.ts'), 'merged');
  await g.git('fsck', '--connectivity-only');
});

void test('a missing merge base or a failed fetch falls back to the full-history path', async (t) => {
  const f = await remoteFixture(t);
  const pr = state(url, f.head, f.base);
  const full = service(f, { cache: path.join(f.dir, 'full') });
  full.states.set(url, pr);
  const expected = summary((await full.run({ kind: 'open', url })).session);
  const cases: [string, () => Promise<string | undefined>][] = [
    ['unknown', () => Promise.resolve(undefined)],
    ['error', () => Promise.reject(new Error('GitHub did not return the merge base'))],
    ['malformed', () => Promise.resolve('not a sha')],
    // GitHub names a commit the remote does not have, so the shallow fetch fails.
    ['unfetchable', () => Promise.resolve('1'.repeat(40))],
  ];
  for (const [name, mergeBase] of cases) {
    const s = service(f, { cache: path.join(f.dir, name), mergeBase });
    s.states.set(url, pr);
    const session = (await s.run({ kind: 'open', url })).session;
    assert.deepEqual(summary(session), expected, name);
    const dir = await conflictSessionDirectory(path.join(f.dir, name), account, session.id);
    assert.equal(await exists(path.join(dir, SHARED_LAYOUT_FILE)), false, name);
    assert.equal(await exists(path.join(dir, 'objects', 'info', 'alternates')), false, name);
    assert.ok(s.reports.includes('Fetching the PR and base history into a private Git cache.'), name);
    // The failed attempt leaves no refs behind in the store.
    const store = conflictStoreDirectory(path.join(f.dir, name), account, repo);
    if (await exists(store)) {
      const { stdout } = await exec('git', ['for-each-ref', 'refs/gnosis/'], { cwd: store });
      assert.equal(stdout.trim(), '', name);
    }
  }
});

void test('PRs in one repository share a store without sharing refs, and concurrent preparation does not race', async (t) => {
  const f = await remoteFixture(t);
  await f.git('checkout', '-q', '-b', 'second', f.head);
  await f.write('content.ts', 'second PR\n');
  const second = await f.commit('second PR');
  await f.git('checkout', '-q', 'main');
  const urls = ['https://github.com/test/repo/pull/1', 'https://github.com/test/repo/pull/2'];
  const s = service(f, { shallow: true });
  s.states.set(urls[0], state(urls[0], f.head, f.base));
  s.states.set(urls[1], state(urls[1], second, f.base, 'second'));
  const sessions = (await Promise.all(urls.map((url) => s.run({ kind: 'open', url })))).map((reply) => reply.session);
  const store = conflictStoreDirectory(s.deps.directory(), account, repo);
  assert.deepEqual(await fs.readdir(path.dirname(store)), [path.basename(store)]);
  const refs = async () =>
    (await exec('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gnosis/'], { cwd: store })).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
  const [one, two] = sessions.map((session) => conflictStoreRefPrefix(account, session.id));
  const listed = await refs();
  assert.ok(listed.includes(`${one}head ${f.head}`));
  assert.ok(listed.includes(`${two}head ${second}`));
  assert.equal(listed.filter((ref) => ref.startsWith(one)).length, 3);
  for (const session of sessions) {
    const dir = await conflictSessionDirectory(s.deps.directory(), account, session.id);
    const { stdout } = await exec('git', ['for-each-ref'], { cwd: dir });
    assert.equal(stdout.trim(), '', 'a session repository has no refs of its own');
    assert.ok(session.files.some((file) => file.path === 'content.ts'));
  }
  // A third PR reuses the base and merge base and fetches only its own head.
  await f.git('checkout', '-q', '-b', 'third', f.head);
  await f.write('content.ts', 'third PR\n');
  const third = await f.commit('third PR');
  await f.git('checkout', '-q', 'main');
  const thirdUrl = 'https://github.com/test/repo/pull/3';
  s.states.set(thirdUrl, state(thirdUrl, third, f.base, 'third'));
  s.reports.length = 0;
  await s.run({ kind: 'open', url: thirdUrl });
  assert.ok(s.reports.includes('Fetching 1 commit from GitHub.'), s.reports.join('\n'));
  // Discarding one session drops only its refs.
  await s.run({ kind: 'discard', id: sessions[0].id, version: sessions[0].version });
  const after = await refs();
  assert.equal(after.filter((ref) => ref.startsWith(one)).length, 0);
  assert.equal(after.filter((ref) => ref.startsWith(two)).length, 3);
});

void test('a linked local clone supplies the commits as an alternate and is never written', async (t) => {
  const f = await remoteFixture(t);
  const clone = path.join(f.dir, 'clone');
  await exec('git', ['clone', '-q', '--no-local', f.remote, clone]);
  await exec('git', ['fetch', '-q', 'origin', 'feature:feature'], { cwd: clone });
  // List every file under .git with Node; `find` is a different program on Windows.
  const snapshot = async () =>
    (await fs.readdir(path.join(clone, '.git'), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(clone, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort()
      .join('\n');
  const before = await snapshot();
  const s = service(f, { shallow: true, localClone: clone });
  s.states.set(url, state(url, f.head, f.base));
  const session = (await s.run({ kind: 'open', url })).session;
  assert.ok(s.reports.includes('Reading objects from your local clone.'));
  assert.ok(!s.reports.some((text) => /commits? from GitHub/.test(text)), s.reports.join('\n'));
  const dir = await conflictSessionDirectory(s.deps.directory(), account, session.id);
  const alternates = (await fs.readFile(path.join(dir, 'objects', 'info', 'alternates'), 'utf8')).trim().split('\n');
  assert.ok(alternates.includes(path.join(clone, '.git', 'objects')));
  assert.equal(await snapshot(), before);
  const reference = service(f, { cache: path.join(f.dir, 'reference') });
  reference.states.set(url, state(url, f.head, f.base));
  assert.deepEqual(summary(session), summary((await reference.run({ kind: 'open', url })).session));
  // Worktrees and bare clones resolve to the shared object directory.
  const worktree = path.join(f.dir, 'worktree');
  await exec('git', ['worktree', 'add', '-q', '--detach', worktree, 'HEAD'], { cwd: clone });
  assert.equal(
    await fs.realpath((await localCloneObjectDirectory(worktree)) ?? ''),
    await fs.realpath(path.join(clone, '.git', 'objects'))
  );
  assert.equal(await localCloneObjectDirectory(path.join(clone, '.git')), path.join(clone, '.git', 'objects'));
  assert.equal(await localCloneObjectDirectory(path.join(f.dir, 'missing')), undefined);
  assert.equal(await localCloneObjectDirectory('relative/path'), undefined);
});

void test('startup cleanup removes unneeded caches; a draft rebuilds its merge from the shared store', async (t) => {
  const f = await remoteFixture(t);
  const cache = path.join(f.dir, 'cache');
  const data = new Map<string, unknown>();
  const urls = Array.from({ length: 4 }, (_, i) => `https://github.com/test/repo/pull/${i + 1}`);
  // Old layout: full-history caches written before this change.
  const old = service(f, { cache, data });
  for (const url of urls) old.states.set(url, state(url, f.head, f.base));
  const sessions = [];
  for (const url of urls) sessions.push((await old.run({ kind: 'open', url })).session);
  const dirs = await Promise.all(sessions.map((session) => conflictSessionDirectory(cache, account, session.id)));
  // A pre-sessions/ legacy directory with no saved record.
  const legacy = path.join(cache, 'a'.repeat(64), 'b'.repeat(64));
  await fs.mkdir(legacy, { recursive: true });
  // 0 stays a draft; 1 is discarded; 2 is published; 3 has a paused restack.
  data.delete(`conflict-draft:${account}:${sessions[1].id}`);
  const published = { ...sessions[2], status: 'published', commitSha: f.head };
  data.set(`conflict-draft:${account}:${sessions[2].id}`, published);
  const paused = { ...sessions[3], status: 'published', commitSha: f.head, restack: { status: 'blocked' } };
  data.set(`conflict-draft:${account}:${sessions[3].id}`, paused);
  await fs.mkdir(path.join(cache, 'resolution-memory', 'keep'), { recursive: true });

  const s = service(f, { cache, data, shallow: true });
  for (const url of urls) s.states.set(url, state(url, f.head, f.base));
  const { removed } = await s.maintain();
  assert.deepEqual(new Set(removed), new Set([dirs[0], dirs[1], dirs[2], legacy]));
  assert.equal(await exists(path.dirname(legacy)), false);
  assert.ok(await exists(dirs[3]), 'a paused restack keeps its worktree');
  assert.ok(await exists(path.join(cache, 'resolution-memory', 'keep')));

  // The draft still previews: its merge comes back from the shallow store with the same tree.
  let draft = sessions[0];
  for (const file of draft.files.filter((file) => !file.unsupported))
    draft = (
      await s.run({
        kind: 'save',
        id: draft.id,
        version: draft.version,
        path: file.path,
        contents: 'x\n',
        resolved: true,
      })
    ).session;
  await assert.rejects(s.run({ kind: 'preview', id: draft.id, version: draft.version }), /every file reviewed/);
  const restored = { ...draft, files: draft.files.filter((file) => !file.unsupported) };
  data.set(`conflict-draft:${account}:${draft.id}`, restored);
  const preview = (await s.run({ kind: 'preview', id: draft.id, version: draft.version })).preview;
  assert.ok(preview);
  assert.ok(s.reports.includes('Restoring this PR’s private Git cache.'));
  assert.ok(await exists(path.join(dirs[0], SHARED_LAYOUT_FILE)));

  // A second cleanup keeps the rebuilt draft and the store refs it borrows.
  assert.deepEqual((await s.maintain()).removed, []);
  const store = conflictStoreDirectory(cache, account, repo);
  const refs = (await exec('git', ['for-each-ref', 'refs/gnosis/'], { cwd: store })).stdout.trim().split('\n');
  assert.equal(refs.length, 3);
  // Once the draft is gone, the store goes too.
  data.delete(`conflict-draft:${account}:${draft.id}`);
  const last = await s.maintain();
  assert.ok(last.removed.includes(store));
  assert.equal(await exists(store), false);
});
