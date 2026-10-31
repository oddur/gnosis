import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { createConflictResolutionService, conflictSessionDirectory } from '../src/conflict-resolution-service';
import { restackWorktreePath } from '../src/conflict-restack';
import { createConflictMemory } from '../src/conflict-rerere';
import { hasConflictMarkers, conflictFileStage, type ConflictFile } from '../lib/conflict-resolution';
import type { PrActionState } from '../lib/pr-actions';
const exec = promisify(execFile);
async function fixture(
  t: TestContext,
  deletion = false,
  sample = {
    name: 'sample.ts',
    base: 'export const answer = 0;\n',
    ours: 'export const answer = 1;\n',
    theirs: 'export const answer = 2;\n',
  }
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflicts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote');
  await fs.mkdir(remote);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: remote })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(remote, sample.name), sample.base);
  await git('add', '.');
  await git('commit', '-m', 'ancestor');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(remote, sample.name), sample.ours);
  await git('commit', '-am', 'PR changes');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  if (deletion) await git('rm', sample.name);
  else await fs.writeFile(path.join(remote, sample.name), sample.theirs);
  await fs.writeFile(path.join(remote, 'from-main.txt'), 'Retain this clean base change.\n');
  await git('add', '.');
  await git('commit', '-m', 'base changes');
  const base = await git('rev-parse', 'HEAD');
  const state = {
    account: 'tester',
    url: 'https://github.com/test/repo/pull/1',
    repository: 'test/repo',
    headRepo: 'test/repo',
    title: 'Answer',
    headSha: head,
    baseSha: base,
    headBranch: 'feature',
    baseBranch: 'main',
    state: 'OPEN',
    archived: false,
    canUpdateBranch: true,
  } as PrActionState;
  const data = new Map<string, unknown>();
  const context = { account: 'tester', token: 'not-a-real-token' };
  const deps = {
    storage: {
      read: (key: string) => structuredClone(data.get(key)),
      write: (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      flush: async () => {},
    },
    directory: () => path.join(dir, 'cache'),
    context: () => context,
    read: () => Promise.resolve({ ...state }),
    remote: () => remote,
    mergiraf: () =>
      path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'),
    suggest: () => Promise.resolve({ contents: 'export const answer = 3;\n', explanation: 'Combine both increments.' }),
  };
  const service = createConflictResolutionService(deps);
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  const { session } = await run({ kind: 'open', url: state.url });
  return { service, run, session, git, state, deps, context };
}
void test('real Git conflicts: draft, proposal, preview and guarded publication preserve clean base changes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.session.files.length, 1);
  assert.equal(f.session.files[0].unsupported, undefined);
  assert.match(f.session.files[0].original, /<<<<<<< /);
  let session = (await f.run({ kind: 'resolve', engine: 'agent', id: f.session.id, version: f.session.version }))
    .session;
  assert.equal(session.files[0].resolved, false, 'Automatic suggestions always need review');
  await assert.rejects(f.run({ kind: 'preview', id: session.id, version: session.version }), /every file reviewed/);
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: session.files[0].result,
      resolved: true,
    })
  ).session;
  const preview = (await f.run({ kind: 'preview', id: session.id, version: session.version })).preview;
  assert.ok(preview);
  assert.match(preview.patch, /from-main.txt/);
  assert.equal(preview.files.length, 2);
  await assert.rejects(
    f.run({ kind: 'publish', id: session.id, version: session.version, previewToken: 'wrong', message: 'Merge base' }),
    /Review the complete/
  );
  const published = await f.run({
    kind: 'publish',
    id: session.id,
    version: session.version,
    previewToken: preview.token,
    message: 'Resolve conflicts',
  });
  assert.equal(published.session.status, 'published');
  assert.equal(await f.git('show', 'feature:sample.ts'), 'export const answer = 3;');
  assert.equal(await f.git('show', 'feature:from-main.txt'), 'Retain this clean base change.');
  assert.equal(await f.git('rev-parse', 'feature^1'), f.state.headSha);
  assert.equal(await f.git('rev-parse', 'feature^2'), f.state.baseSha);
});
void test('drafts survive service restart; stale revisions and accounts cannot publish or overwrite them', async (t) => {
  const f = await fixture(t);
  const saved = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'export const answer = 3;\n',
      resolved: true,
    })
  ).session;
  const service = createConflictResolutionService(f.deps);
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  assert.equal((await run({ kind: 'open', url: f.state.url })).session.files[0].result, saved.files[0].result);
  await assert.rejects(
    run({ kind: 'save', id: saved.id, version: f.session.version, path: 'sample.ts', contents: '', resolved: true }),
    /saved resolution changed/
  );
  f.state.baseSha = 'f'.repeat(40);
  assert.equal((await run({ kind: 'open', url: f.state.url })).session.stale, true);
  await assert.rejects(run({ kind: 'preview', id: saved.id, version: saved.version }), /base branch changed/);
  f.context.account = 'different';
  await assert.rejects(run({ kind: 'preview', id: saved.id, version: saved.version }), /Open this PR/);
});
void test('unsupported conflicts and leftover markers cannot be marked resolved', async (t) => {
  const f = await fixture(t, true);
  assert.ok(f.session.files.some((file) => file.unsupported));
  await assert.rejects(
    f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'resolved',
      resolved: true,
    }),
    /cannot be saved/
  );
  await assert.rejects(f.run({ kind: 'preview', id: f.session.id, version: f.session.version }), /every file/);
});
void test('push lease rejects a remote change even if the metadata recheck races it', async (t) => {
  const f = await fixture(t);
  const session = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'export const answer = 3;\n',
      resolved: true,
    })
  ).session;
  const preview = (await f.run({ kind: 'preview', id: session.id, version: session.version })).preview;
  assert.ok(preview);
  await f.git('update-ref', 'refs/heads/feature', f.state.baseSha);
  await assert.rejects(
    f.run({
      kind: 'publish',
      id: session.id,
      version: session.version,
      previewToken: preview.token,
      message: 'Resolve',
    }),
    /could not complete/
  );
  assert.equal(await f.git('rev-parse', 'feature'), f.state.baseSha);
});

async function stackedFixture(t: TestContext, conflict = false) {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'child', f.state.headSha);
  const remote = f.deps.remote();
  await fs.writeFile(
    path.join(remote, conflict ? 'sample.ts' : 'child.txt'),
    conflict ? 'export const answer = 4;\n' : 'child change\n'
  );
  await f.git('add', '.');
  await f.git('commit', '-m', 'child change');
  const child = await f.git('rev-parse', 'HEAD');
  await f.git('checkout', '-b', 'tip');
  await fs.writeFile(path.join(remote, 'tip.txt'), 'tip change\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'tip change');
  const tip = await f.git('rev-parse', 'HEAD');
  await f.git('checkout', 'main');
  let session = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'export const answer = 3;\n',
      resolved: true,
    })
  ).session;
  const preview = (await f.run({ kind: 'preview', id: session.id, version: session.version })).preview;
  assert.ok(preview);
  session = (
    await f.run({
      kind: 'publish',
      id: session.id,
      version: session.version,
      previewToken: preview.token,
      message: 'Resolve root',
    })
  ).session;
  const urls = ['https://github.com/test/repo/pull/2', 'https://github.com/test/repo/pull/3'];
  const read = async (url: string) => {
    const index = [f.state.url, ...urls].indexOf(url);
    assert.ok(index >= 0);
    const branch = ['feature', 'child', 'tip'][index],
      baseBranch = ['main', 'feature', 'child'][index];
    return {
      ...f.state,
      url,
      title: branch,
      headBranch: branch,
      baseBranch,
      headSha: await f.git('rev-parse', branch),
      baseSha: await f.git('rev-parse', baseBranch),
    };
  };
  const deps = { ...f.deps, read, dependents: () => urls };
  const service = createConflictResolutionService(deps);
  return {
    ...f,
    session,
    child,
    tip,
    urls,
    deps,
    run: (r: Parameters<typeof service.run>[0]) => service.run(r, new AbortController().signal),
  };
}

void test('restack replays only each PR’s commits and publishes all branches after review', async (t) => {
  const f = await stackedFixture(t);
  const { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'prepared');
  assert.equal(session.restack.branches.length, 2);
  assert.equal(await f.git('rev-parse', 'child'), f.child, 'Preparation must not push');
  assert.equal(await f.git('rev-parse', 'tip'), f.tip);
  assert.deepEqual(
    session.restack.branches.map((b) => b.commits),
    [1, 1]
  );
  assert.match(session.restack.branches[0].patch, /answer = 3/);
  await assert.rejects(
    f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: [],
    }),
    /Review every/
  );
  await assert.rejects(
    f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: 'wrong',
      reviewed: f.urls,
    }),
    /Prepare and review/
  );
  const published = await f.run({
    kind: 'restack-publish',
    id: session.id,
    version: session.version,
    previewToken: session.restack.token,
    reviewed: f.urls,
  });
  assert.equal(published.session.restack?.status, 'published');
  assert.equal(await f.git('rev-parse', 'child^'), f.session.commitSha);
  assert.equal(await f.git('rev-parse', 'tip^'), await f.git('rev-parse', 'child'));
  assert.equal(await f.git('show', 'tip:sample.ts'), 'export const answer = 3;');
  assert.equal(await f.git('show', 'tip:child.txt'), 'child change');
  assert.equal(await f.git('show', 'tip:tip.txt'), 'tip change');
});

void test('a dependent PR already based on the resolved parent keeps its commits unchanged', async (t) => {
  const f = await stackedFixture(t);
  assert.ok(f.session.commitSha);
  await f.git('rebase', '--onto', f.session.commitSha, f.state.headSha, 'child');
  const current = await f.git('rev-parse', 'child');
  await f.git('checkout', 'main');
  const service = createConflictResolutionService({ ...f.deps, dependents: () => [f.urls[0]] });
  const { session } = await service.run(
    { kind: 'restack-prepare', id: f.session.id, version: f.session.version },
    new AbortController().signal
  );
  assert.equal(session.restack?.branches[0].oldSha, current);
  assert.equal(session.restack.branches[0].newSha, current);
  assert.equal(session.restack.branches[0].commits, 1);
  assert.equal(session.restack.branches[0].files.length, 0);
});

void test('restack stops on a new conflict without pushing any prepared branches', async (t) => {
  const f = await stackedFixture(t, true);
  const { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'blocked');
  assert.deepEqual(session.restack.blocked?.paths, ['sample.ts']);
  assert.equal(session.restack.blocked.url, f.urls[0]);
  assert.equal(await f.git('rev-parse', 'child'), f.child);
  assert.equal(await f.git('rev-parse', 'tip'), f.tip);
  await assert.rejects(
    f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: [],
    }),
    /Prepare and review/
  );
});

void test('paused restack survives restart, accepts reviewed edits and reuses them on another preparation', async (t) => {
  const f = await stackedFixture(t, true);
  let session = (await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version })).session;
  assert.equal(session.restack?.blocked?.files[0].unsupported, undefined);
  const service = createConflictResolutionService(f.deps);
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  session = (await run({ kind: 'open', url: f.state.url })).session;
  assert.equal(session.restack?.status, 'blocked');
  await assert.rejects(run({ kind: 'restack-continue', id: session.id, version: session.version }), /review every/);
  session = (
    await run({
      kind: 'restack-save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: 'export const answer = 5;\n',
      resolved: true,
    })
  ).session;
  session = (await run({ kind: 'restack-continue', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.status, 'prepared');
  assert.equal(await f.git('rev-parse', 'child'), f.child);
  // Replaying the same conflict now uses actual Git rerere and still requires branch review.
  session = (await run({ kind: 'restack-prepare', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.status, 'prepared');
  assert.equal(session.restack.branches[0].reused, 1);
  session = (
    await run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: f.urls,
    })
  ).session;
  assert.equal(session.restack?.status, 'published');
  assert.equal(await f.git('show', 'tip:sample.ts'), 'export const answer = 5;');
});

void test('rerere remembers reviewed resolutions across PRs without marking the proposal reviewed', async (t) => {
  const f = await stackedFixture(t);
  const service = createConflictResolutionService({
    ...f.deps,
    read: (url) => Promise.resolve({ ...f.state, url, headBranch: 'copy' }),
    dependents: () => [],
  });
  const { session } = await service.run(
    { kind: 'open', url: 'https://github.com/test/repo/pull/4' },
    new AbortController().signal
  );
  assert.equal(session.files[0].source, 'rerere');
  assert.equal(session.files[0].result, 'export const answer = 3;\n');
  assert.equal(session.files[0].resolved, false);
});

void test('resolution memory keeps the latest reviewed result and isolates accounts and repositories', async (t) => {
  const f = await fixture(t);
  const memory = createConflictMemory(() => path.join(f.deps.directory(), 'memory-test'));
  const signal = new AbortController().signal;
  const file = { ...f.session.files[0], result: 'export const answer = 3;\n', resolved: true };
  await memory.record('tester:test/repo', [file], signal);
  file.result = 'export const answer = 5;\n';
  await memory.record('tester:test/repo', [file], signal);
  assert.equal((await memory.apply('tester:test/repo', [file], signal)).get(file.path), file.result);
  assert.equal((await memory.apply('other:test/repo', [file], signal)).size, 0);
  assert.equal((await memory.apply('tester:test/other', [file], signal)).size, 0);
});

void test('restack rejects a remote race atomically even when metadata still reports old heads', async (t) => {
  const f = await stackedFixture(t);
  const { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  const states = new Map(
    await Promise.all([f.state.url, ...f.urls].map(async (url) => [url, await f.deps.read(url)] as const))
  );
  assert.ok(session.restack);
  await f.git('update-ref', 'refs/heads/tip', f.state.baseSha);
  const service = createConflictResolutionService({
    ...f.deps,
    read: (url) => {
      const state = states.get(url);
      assert.ok(state);
      return Promise.resolve(state);
    },
  });
  await assert.rejects(
    service.run(
      {
        kind: 'restack-publish',
        id: session.id,
        version: session.version,
        previewToken: session.restack.token,
        reviewed: f.urls,
      },
      new AbortController().signal
    ),
    /could not complete/
  );
  assert.equal(await f.git('rev-parse', 'child'), f.child);
  assert.equal(await f.git('rev-parse', 'tip'), f.state.baseSha);
});

void test('reopen recovers an atomic restack push after local persistence fails', async (t) => {
  const f = await stackedFixture(t);
  const { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.ok(session.restack);
  let fail = true;
  const service = createConflictResolutionService({
    ...f.deps,
    storage: {
      ...f.deps.storage,
      write: (key, value) => {
        if (fail && (value as { restack?: { status: string } }).restack?.status === 'published') {
          fail = false;
          throw new Error('Simulated storage failure');
        }
        f.deps.storage.write(key, value);
      },
    },
  });
  await assert.rejects(
    service.run(
      {
        kind: 'restack-publish',
        id: session.id,
        version: session.version,
        previewToken: session.restack.token,
        reviewed: f.urls,
      },
      new AbortController().signal
    ),
    /storage failure/
  );
  const reopened = await service.run({ kind: 'open', url: f.state.url }, new AbortController().signal);
  assert.equal(reopened.session.restack?.status, 'published');
  assert.equal(await f.git('rev-parse', 'tip'), session.restack.branches[1].newSha);
});

void test('reopening after the source branch changes preserves paused restack drafts', async (t) => {
  const f = await stackedFixture(t, true);
  let session = (await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version })).session;
  session = (
    await f.run({
      kind: 'restack-save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: 'saved human draft\n',
      resolved: false,
    })
  ).session;
  await f.git('update-ref', 'refs/heads/feature', f.state.baseSha);
  const reopened = await f.run({ kind: 'open', url: f.state.url });
  assert.equal(reopened.session.stale, true);
  assert.equal(reopened.session.restack?.blocked?.files[0].result, 'saved human draft\n');
  await assert.rejects(
    f.run({ kind: 'restack-continue', id: session.id, version: session.version }),
    /resolved PR changed/
  );
});
void test('Mergiraf executable returns a saved proposal without auto-approving it', async (t) => {
  const binary = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
  if (!(await fs.stat(binary).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const f = await fixture(t);
  const result = await f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'mergiraf' });
  assert.equal(result.session.files[0].source, 'mergiraf');
  assert.equal(result.session.files[0].resolved, false);
  assert.ok(hasConflictMarkers(result.session.files[0].result), 'Incompatible changes remain visible for a human');
  await assert.rejects(
    f.run({
      kind: 'save',
      id: result.session.id,
      version: result.session.version,
      path: 'sample.ts',
      contents: result.session.files[0].result,
      resolved: true,
    }),
    /remaining conflict markers/
  );
});
void test('rejects malformed IPC, leftover markers and cancelled operations without changing the draft', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.run(null as unknown as Parameters<typeof f.run>[0], new AbortController().signal),
    /Invalid conflict/
  );
  await assert.rejects(
    f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: f.session.files[0].original,
      resolved: true,
    }),
    /remaining conflict markers/
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.run(
      { kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'agent' },
      controller.signal
    ),
    /abort/i
  );
  assert.equal((await f.run({ kind: 'open', url: f.state.url })).session.version, f.session.version);
});
void test('reopen recognizes a successful push when saving the published state fails', async (t) => {
  const f = await fixture(t);
  const session = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'export const answer = 3;\n',
      resolved: true,
    })
  ).session;
  const { preview } = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.ok(preview);
  const write = f.deps.storage.write;
  f.deps.storage.write = (key, value) => {
    if ((value as { status: string }).status === 'published') throw new Error('Disk temporarily unavailable');
    write(key, value);
  };
  await assert.rejects(
    f.run({
      kind: 'publish',
      id: session.id,
      version: session.version,
      previewToken: preview.token,
      message: 'Resolve',
    }),
    /Disk temporarily/
  );
  f.state.headSha = await f.git('rev-parse', 'feature');
  f.deps.storage.write = write;
  const reopened = await f.run({ kind: 'open', url: f.state.url });
  assert.equal(reopened.session.status, 'published');
  assert.equal(reopened.session.commitSha, f.state.headSha);
});
void test('distinguishes a clean local merge from an already incorporated base and refuses an empty update', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', 'feature', '--', 'sample.ts');
  await f.git('commit', '-am', 'Base now agrees with PR change');
  f.state.baseSha = await f.git('rev-parse', 'main');
  const clean = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(clean.files.length, 0);
  assert.equal(clean.preparation, 'clean-merge');
  assert.match(
    (await f.run({ kind: 'preview', id: clean.id, version: clean.version })).preview?.patch ?? '',
    /from-main.txt/
  );
  f.state.baseSha = await f.git('rev-parse', 'feature^');
  const upToDate = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(upToDate.preparation, 'up-to-date', 'An empty draft is refreshed against current branch revisions');
  await assert.rejects(f.run({ kind: 'preview', id: upToDate.id, version: upToDate.version }), /No update is needed/);
  await assert.rejects(
    f.run({
      kind: 'publish',
      id: upToDate.id,
      version: upToDate.version,
      previewToken: 'not-reviewed',
      message: 'Empty update',
    }),
    /No update is needed/
  );
});

void test('Mergiraf structurally combines both JSON edits, persists the proposal and publishes only after review', async (t) => {
  const binary = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
  if (!(await fs.stat(binary).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const f = await fixture(t, false, {
    name: 'settings.json',
    base: '{"left":0,"right":0}\n',
    ours: '{"left":1,"right":0}\n',
    theirs: '{"left":0,"right":2}\n',
  });
  assert.equal(f.session.files.length, 1);
  assert.ok(hasConflictMarkers(f.session.files[0].original), 'Native Git must first report a real text conflict');
  let session = (await f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'mergiraf' }))
    .session;
  const proposal = session.files[0];
  assert.equal(hasConflictMarkers(proposal.result), false);
  assert.deepEqual(JSON.parse(proposal.result), { left: 1, right: 2 }, 'Neither branch’s edit is lost');
  assert.equal(proposal.resolved, false);
  assert.equal((await f.run({ kind: 'open', url: f.state.url })).session.files[0].result, proposal.result);
  assert.equal(await f.git('rev-parse', 'feature'), f.state.headSha, 'Proposing never pushes');
  await assert.rejects(f.run({ kind: 'preview', id: session.id, version: session.version }), /every file reviewed/);
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: 'settings.json',
      contents: proposal.result,
      resolved: true,
    })
  ).session;
  assert.equal(session.files[0].source, 'mergiraf', 'Reviewing unchanged contents preserves proposal provenance');
  const { preview } = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.ok(preview);
  await f.run({
    kind: 'publish',
    id: session.id,
    version: session.version,
    previewToken: preview.token,
    message: 'Resolve independent settings edits',
  });
  assert.deepEqual(JSON.parse(await f.git('show', 'feature:settings.json')), { left: 1, right: 2 });
  assert.equal(await f.git('show', 'feature:from-main.txt'), 'Retain this clean base change.');
});

void test('file stages distinguish unresolved code, automatic proposals, human review, and later edits', () => {
  const file: ConflictFile = {
    path: 'a.ts',
    mode: '100644',
    base: '',
    ours: '',
    theirs: '',
    original: '',
    result: 'const x = 1;',
    resolved: false,
    source: 'mergiraf',
  };
  assert.equal(conflictFileStage(file), 'resolved', 'Automatic success still needs human review');
  file.resolved = true;
  assert.equal(conflictFileStage(file), 'reviewed');
  assert.equal(conflictFileStage(file, 'const x = 2;'), 'resolved', 'Unsaved edits invalidate review');
  assert.equal(conflictFileStage(file, '<<<<<<< PR\nconst x = 2;\n=======\nconst x = 3;\n>>>>>>> main'), 'conflicted');
  assert.equal(
    conflictFileStage({ ...file, unsupported: 'Binary conflict' }),
    'conflicted',
    'Unsupported conflicts cannot appear resolved without markers'
  );
});

void test('restack paths stay compact and preserve existing paused worktrees', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-restack-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  assert.equal(await restackWorktreePath(directory, token), path.join(directory, `restack-${token.slice(0, 16)}`));
  const legacy = path.join(directory, `restack-${token}`);
  await fs.mkdir(legacy);
  assert.equal(await restackWorktreePath(directory, token), legacy);
});

void test('conflict session directories reserve room for Git metadata and retain legacy caches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-session-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'a'.repeat(64);
  const directory = await conflictSessionDirectory(root, 'tester', id);
  assert.equal(path.relative(root, directory).length, 'sessions/'.length + 64);
  assert.notEqual(directory, await conflictSessionDirectory(root, 'other', id));
  assert.notEqual(directory, await conflictSessionDirectory(root, 'tester', 'b'.repeat(64)));
  const legacy = path.join(root, crypto.createHash('sha256').update('tester').digest('hex'), id);
  await fs.mkdir(legacy, { recursive: true });
  assert.equal(await conflictSessionDirectory(root, 'tester', id), legacy);
});
