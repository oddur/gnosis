import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConflictResolutionService } from '../src/conflict-resolution-service';
import type { PrActionState } from '../lib/pr-actions';
const exec = promisify(execFile);
async function fixture(t: TestContext, deletion = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflicts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote');
  await fs.mkdir(remote);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: remote })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(remote, 'sample.ts'), 'export const answer = 0;\n');
  await git('add', '.');
  await git('commit', '-m', 'ancestor');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(remote, 'sample.ts'), 'export const answer = 1;\n');
  await git('commit', '-am', 'PR changes');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  if (deletion) await git('rm', 'sample.ts');
  else await fs.writeFile(path.join(remote, 'sample.ts'), 'export const answer = 2;\n');
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
  assert.ok(result.session.files[0].result);
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
