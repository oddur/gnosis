import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { BACKGROUND_YIELDED, createConflictResolutionService, conflictSessionDirectory } from '../src/conflict-resolution-service';
import { composeCarried, replayBuckets, restackWorktreePath } from '../src/conflict-restack';
import { CONFLICT_STATS_NAME, createConflictStatsStore } from '../src/conflict-stats-store';
import { blockFingerprints } from '../lib/conflict-stats';
import { createConflictMemory } from '../src/conflict-rerere';
import { conflictFileStage } from '../lib/conflict-markers';
import {
  hasConflictMarkers,
  validateConflictRequest,
  type ConflictFile,
  type ConflictSession,
} from '../lib/conflict-resolution';
import { conflictCount, parseConflicts } from '../lib/conflict-blocks';
import { withProposals } from '../lib/conflict-carry';
import type { PrActionState } from '../lib/pr-actions';
import { blockBuckets, CHECKS_VERSION, unchosenConflicts, verifyProposals } from '../lib/conflict-verify';
import { verdictKey } from '../lib/conflict-verdict-key';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import { conflictChecker, createConflictCheckWorker, moveProposer } from '../src/conflict-checks';
import { canRetryStructural } from '../lib/conflict-flow';
import { cascadeSentence } from '../lib/conflict-cascade';
import * as undoCopy from '../lib/conflict-undo';
import { normalizeRepositorySettings } from '../lib/repository-settings';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const exec = promisify(execFile);
async function fixture(
  t: TestContext,
  deletion = false,
  sample = {
    name: 'sample.ts',
    base: 'export const answer = 0;\n',
    ours: 'export const answer = 1;\n',
    theirs: 'export const answer = 2;\n',
  },
  others: { name: string; base: string; ours: string; theirs: string }[] = []
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflicts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote');
  await fs.mkdir(remote);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: remote })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'uploadpack.allowFilter', 'true');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(remote, sample.name), sample.base);
  for (const other of others) await fs.writeFile(path.join(remote, other.name), other.base);
  await git('add', '.');
  await git('commit', '-m', 'ancestor');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(remote, sample.name), sample.ours);
  for (const other of others) await fs.writeFile(path.join(remote, other.name), other.ours);
  await git('commit', '-am', 'PR changes');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  if (deletion) await git('rm', sample.name);
  else await fs.writeFile(path.join(remote, sample.name), sample.theirs);
  for (const other of others) await fs.writeFile(path.join(remote, other.name), other.theirs);
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
    // The shallow suite (conflict-resolution-shallow.test.ts) runs every test here through the merge-base path.
    ...(process.env.GNOSIS_TEST_CONFLICT_SHALLOW
      ? { mergeBase: async (_repo: string, base: string, head: string) => git('merge-base', base, head) }
      : {}),
    mergiraf: () =>
      path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'),
    suggest: () => Promise.resolve({ contents: 'export const answer = 3;\n', explanation: 'Combine both increments.' }),
  };
  const service = createConflictResolutionService(deps);
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  const { session } = await run({ kind: 'open', url: state.url });
  return { service, run, session, git, state, deps, context, remote };
}
void test('real Git conflicts: draft, proposal, preview and guarded publication preserve clean base changes', async (t) => {
  const f = await fixture(t);
  const cache = await conflictSessionDirectory(f.deps.directory(), 'tester', f.session.id);
  assert.equal(
    await fs.stat(path.join(cache, 'gnosis-objects.json')).then(
      () => 'shallow',
      () => 'full'
    ),
    process.env.GNOSIS_TEST_CONFLICT_SHALLOW ? 'shallow' : 'full'
  );
  assert.equal(f.session.files.length, 1);
  assert.equal(f.session.files[0].unsupported, undefined);
  assert.match(f.session.files[0].original, /<<<<<<< /);
  let session = (await f.run({ kind: 'resolve', engine: 'agent', id: f.session.id, version: f.session.version, path: f.session.files[0].path }))
    .session;
  assert.equal(session.files[0].resolved, false, 'Automatic suggestions always need review');
  // Fail closed: the suggestion is a proposal on the conflict's card; the draft keeps the conflict until you choose.
  assert.ok(hasConflictMarkers(session.files[0].result));
  const proposal = session.files[0].proposals?.[0];
  assert.equal(proposal?.source, 'model');
  await assert.rejects(f.run({ kind: 'preview', id: session.id, version: session.version }), /every file reviewed/);
  // Its text in the draft without your choice is never accepted by default.
  await assert.rejects(
    f.run({ kind: 'save', id: session.id, version: session.version, path: 'sample.ts', contents: proposal.text, resolved: true }),
    /in Check first/
  );
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: proposal.text,
      resolved: true,
      picks: ['proposal'],
    })
  ).session;
  // Your choices are saved with the draft (#445 item 8): Use the proposal is yours after a reopen too.
  assert.deepEqual(session.files[0].picks, ['proposal']);
  assert.throws(() => validateConflictRequest({ kind: 'save', id: session.id, version: 1, path: 'a', contents: '', resolved: false, picks: ['mine'] }));
  // Use the proposal after another choice is a pick too (#445 item 12): the confirmation lists it as yours.
  validateConflictRequest({ kind: 'save', id: session.id, version: 1, path: 'a', contents: '', resolved: false, picks: ['proposal', null] });
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
void test('conflict stats: an open counts its conflicts once, Start over counts, and a push counts (#445 item 2)', async (t) => {
  const f = await fixture(t);
  const store = createConflictStatsStore(f.deps.storage);
  const service = createConflictResolutionService({ ...f.deps, stats: store });
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  // The fixture's first open had no stats: this open counts the one Decide conflict, and the session.
  let session = (await run({ kind: 'open', url: f.state.url })).session;
  assert.deepEqual(session.files[0].statsBlocks?.map((block) => block?.bucket), ['decide']);
  assert.equal(store.get().buckets.decide.shown, 1);
  assert.deepEqual(store.get().sessions, { started: 1, startedOver: 0, pushed: 0 });
  // A reopen counts nothing again; the buckets are saved with the draft.
  session = (await run({ kind: 'open', url: f.state.url })).session;
  assert.equal(store.get().buckets.decide.shown, 1);
  // Load latest changes keeps them; Start over is a fresh merge.
  session = (await run({ kind: 'open', url: f.state.url, restart: true, keep: true })).session;
  assert.deepEqual(store.get().sessions, { started: 1, startedOver: 0, pushed: 0 });
  session = (await run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(store.get().buckets.decide.shown, 2);
  assert.deepEqual(store.get().sessions, { started: 2, startedOver: 1, pushed: 0 });
  // Keep ours, then theirs: re-chosen once, saved on the draft, so a restarted service does not count it again.
  const choice = { id: session.id, path: 'sample.ts', key: blockFingerprints(session.files[0].original)[0], count: 'rechosen' as const };
  service.countChoice(choice);
  service.countChoice(choice);
  createConflictResolutionService({ ...f.deps, stats: store }).countChoice(choice);
  assert.equal(store.get().buckets.decide.rechosen, 1);
  session = (
    await run({ kind: 'save', id: session.id, version: session.version, path: 'sample.ts', contents: 'export const answer = 3;\n', resolved: true })
  ).session;
  const preview = (await run({ kind: 'preview', id: session.id, version: session.version })).preview;
  assert.ok(preview);
  await run({ kind: 'publish', id: session.id, version: session.version, previewToken: preview.token, message: 'Resolve' });
  const stats = store.get();
  assert.deepEqual(stats.sessions, { started: 2, startedOver: 1, pushed: 1 });
  assert.equal(stats.buckets.decide.accepted, 0, 'Decide has no proposal to accept');
  // Counts only: nothing of the PR, the account or the file.
  const draft = f.deps.storage.read(`conflict-draft:tester:${session.id}`) as { files: { statsBlocks: { rechosen?: true }[] }[] };
  assert.equal(draft.files[0].statsBlocks[0].rechosen, true, 'The flag stayed through the save and the push');
  const saved = JSON.stringify(f.deps.storage.read(CONFLICT_STATS_NAME));
  for (const secret of ['sample', 'answer', 'tester', 'github.com', 'feature']) assert.equal(saved.includes(secret), false);
});
void test('conflict stats: a plain open reads the draft no more often than without stats (item 7)', async (t) => {
  const f = await fixture(t);
  const reads = async (stats: boolean) => {
    let n = 0;
    const storage = { ...f.deps.storage, read: (key: string) => (n++, f.deps.storage.read(key)) };
    const service = createConflictResolutionService({ ...f.deps, storage, ...(stats ? { stats: createConflictStatsStore(f.deps.storage) } : {}) });
    await service.run({ kind: 'open', url: f.state.url }, new AbortController().signal);
    return n;
  };
  assert.equal(await reads(true), await reads(false));
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
  // New base commits alone keep the draft usable; preview and publish merge them again.
  f.state.baseSha = 'f'.repeat(40);
  assert.equal((await run({ kind: 'open', url: f.state.url })).session.stale, false);
  f.state.baseSha = saved.baseSha;
  f.state.headSha = 'f'.repeat(40);
  const stale = (await run({ kind: 'open', url: f.state.url })).session;
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'head-moved');
  await assert.rejects(run({ kind: 'preview', id: saved.id, version: saved.version }), /PR branch has new commits/);
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
  // Clean replays had no Check or Decide (#445 item 21): neither update needs its tick, but a tick is still accepted.
  assert.deepEqual(
    session.restack.branches.map((b) => b.review),
    [false, false]
  );
  await assert.rejects(
    f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: [f.urls[0], f.urls[0]],
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

void test('restack reads the whole stack in one batch to prepare and one to publish', async (t) => {
  const f = await stackedFixture(t);
  const batches: string[][] = [];
  let single = 0;
  const service = createConflictResolutionService({
    ...f.deps,
    read: (url) => {
      single++;
      return f.deps.read(url);
    },
    readMany: (urls) => {
      batches.push(urls);
      return urls.map((url) => f.deps.read(url));
    },
  });
  const run = (r: Parameters<typeof service.run>[0]) => service.run(r, new AbortController().signal);
  const { session } = await run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'prepared');
  const before = single;
  const published = await run({
    kind: 'restack-publish',
    id: session.id,
    version: session.version,
    previewToken: session.restack.token,
    reviewed: f.urls,
  });
  assert.equal(published.session.restack?.status, 'published');
  assert.deepEqual(batches, [
    [f.state.url, ...f.urls],
    [f.state.url, ...f.urls],
  ]);
  // Publishing reads nothing one PR at a time; before, it read the root and then each branch in turn.
  assert.equal(single - before, 0);
  assert.equal(await f.git('rev-parse', 'tip^'), await f.git('rev-parse', 'child'));
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
  const result = await f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'mergiraf', path: f.session.files[0].path });
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
  // Only the opening and closing markers removed: the lone `=======` between both sides still blocks the push.
  const leftover = f.session.files[0].original
    .split('\n')
    .filter((line) => !/^(<{7}|>{7}|\|{7})/.test(line))
    .join('\n');
  assert.match(leftover, /^={7}$/m);
  await assert.rejects(
    f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: leftover,
      resolved: true,
    }),
    /remaining conflict markers/
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.run(
      { kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'agent', path: f.session.files[0].path },
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
/** A fixture whose conflict was resolved and pushed: `push` is the history every later reopen must keep. */
async function pushedFixture(t: TestContext) {
  const f = await fixture(t);
  const saved = (
    await f.run({ kind: 'save', id: f.session.id, version: f.session.version, path: 'sample.ts', contents: 'export const answer = 3;\n', resolved: true })
  ).session;
  const { preview } = await f.run({ kind: 'preview', id: saved.id, version: saved.version });
  assert.ok(preview);
  const pushed = (await f.run({ kind: 'publish', id: saved.id, version: saved.version, previewToken: preview.token, message: 'Resolve' })).session;
  assert.equal(pushed.status, 'published');
  assert.equal(pushed.reopened, undefined, 'The push itself shows its result');
  f.state.headSha = await f.git('rev-parse', 'feature');
  const push = { commitSha: f.state.headSha, headSha: pushed.headSha };
  /** Main moves with a change that conflicts with the pushed resolution. */
  const conflictAgain = async () => {
    await fs.writeFile(path.join(f.remote, 'sample.ts'), 'export const answer = 9;\n');
    await f.git('commit', '-am', 'Main changes the answer again');
    Object.assign(f.state, { baseSha: await f.git('rev-parse', 'main'), mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  };
  return { ...f, push, conflictAgain };
}
void test('reopening after an earlier push shows nothing to resolve, or prepares again when main brought new conflicts', async (t) => {
  const f = await pushedFixture(t);
  Object.assign(f.state, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
  const clean = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(clean.reopened, true);
  assert.deepEqual(clean.lastPush, f.push, 'The merge commit and the undo head stay reachable as history');
  await f.conflictAgain();
  const again = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(again.status, 'editing');
  assert.equal(again.reopened, undefined);
  assert.equal(again.headSha, f.state.headSha);
  assert.equal(again.files.length, 1);
  assert.match(again.files[0].original, /<<<<<<< /);
  assert.deepEqual(again.lastPush, f.push, 'The fresh preparation keeps the push as history');
});
void test('reopening while GitHub is still computing keeps the push record', async (t) => {
  const f = await pushedFixture(t);
  Object.assign(f.state, { mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' });
  // Git decides meanwhile, and finds main already merged.
  const computing = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(computing.reopened, undefined);
  assert.equal(computing.preparation, 'up-to-date');
  assert.deepEqual(computing.lastPush, f.push);
  const again = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.deepEqual(again.lastPush, f.push, 'A second reopen while computing keeps it too');
  // GitHub answers: nothing to resolve, with the same history.
  Object.assign(f.state, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
  const clean = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(clean.reopened, true);
  assert.deepEqual(clean.lastPush, f.push);
});
void test('reopening with dependents left to restack prepares again when GitHub reports conflicts', async (t) => {
  const f = await pushedFixture(t);
  Object.assign(f.deps, { dependents: () => ['https://github.com/test/repo/pull/2'] });
  Object.assign(f.state, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
  const pending = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(pending.status, 'published', 'Clean: the published screen offers the restack');
  assert.equal(pending.reopened, undefined);
  await f.conflictAgain();
  const again = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(again.status, 'editing');
  assert.equal(again.files.length, 1);
  assert.deepEqual(
    again.lastPush,
    { ...f.push, unrestacked: ['https://github.com/test/repo/pull/2'] },
    'The restack left undone stays in the history'
  );
});
void test('a restack push recovered on reopen counts as done before GitHub’s new conflicts prepare again', async (t) => {
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
  const run = (request: Parameters<typeof service.run>[0]) => service.run(request, new AbortController().signal);
  await assert.rejects(
    run({ kind: 'restack-publish', id: session.id, version: session.version, previewToken: session.restack.token, reviewed: f.urls }),
    /storage failure/
  );
  Object.assign(f.state, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const again = (await run({ kind: 'open', url: f.state.url })).session;
  assert.equal(again.status, 'editing', 'Conflicts again: a fresh preparation');
  assert.equal(again.lastPush?.commitSha, session.commitSha);
  assert.equal(again.lastPush?.unrestacked, undefined, 'The recovered restack is not reported as left undone');
});
void test('a pending restack stays in the history after someone pushes on top of the resolution', async (t) => {
  const f = await stackedFixture(t);
  const { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'prepared');
  await f.git('checkout', 'feature');
  await fs.writeFile(path.join(f.deps.remote(), 'later.txt'), 'pushed by someone else\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Someone else pushes');
  await f.git('checkout', 'main');
  const stale = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(stale.stale, true, 'The restack plan no longer matches the branches');
  const fresh = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(fresh.status, 'editing');
  assert.deepEqual(fresh.lastPush, { commitSha: session.commitSha, headSha: session.headSha, unrestacked: f.urls });
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
  let session = (await f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'mergiraf', path: f.session.files[0].path }))
    .session;
  // Fail closed: without the checks' Merge, the proposal waits on its card and the draft keeps the conflict.
  const proposal = { result: session.files[0].proposals?.[0]?.text ?? '', resolved: session.files[0].resolved };
  assert.ok(hasConflictMarkers(session.files[0].result));
  assert.deepEqual(JSON.parse(proposal.result), { left: 1, right: 2 }, 'Neither branch’s edit is lost');
  assert.equal(proposal.resolved, false);
  assert.equal((await f.run({ kind: 'open', url: f.state.url })).session.files[0].result, session.files[0].result);
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
      // Fail closed: a proposal is accepted only by choosing it (Use the proposal).
      picks: ['proposal'],
    })
  ).session;
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

void test('preparation runs structural merge on every conflicted file and keeps each result a proposal per conflict', async (t) => {
  const binary = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
  if (!(await fs.stat(binary).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const base = "import { a } from './a';\n\nexport function one() {\n  return 1;\n}\n";
  const f = await fixture(
    t,
    false,
    {
      name: 'numbers.ts',
      base,
      ours: base.replace("'./a';\n", "'./a';\nimport { b } from './b';\n").replace('return 1;', 'return 10;'),
      theirs: base.replace("'./a';\n", "'./a';\nimport { c } from './c';\n").replace('return 1;', 'return 11;'),
    },
    [
      {
        name: 'settings.json',
        base: '{"left":0,"right":0}\n',
        ours: '{"left":1,"right":0}\n',
        theirs: '{"left":0,"right":2}\n',
      },
    ]
  );
  const ts = f.session.files.find((file) => file.path === 'numbers.ts');
  const json = f.session.files.find((file) => file.path === 'settings.json');
  assert.ok(ts && json);
  // The imports combine; the two return values are a real conflict and stay as Git wrote them.
  assert.equal(conflictCount(ts.original), 2);
  assert.deepEqual(
    ts.proposals?.map((p) => p && p.source),
    ['mergiraf', null]
  );
  // Fail closed: without the checks' Merge, proposals wait on their cards; the drafts keep the conflicts.
  assert.equal(conflictCount(ts.result), 2);
  const tsUsed = withProposals(ts.original, ts.proposals ?? []);
  const jsonUsed = withProposals(json.original, json.proposals ?? []);
  assert.match(tsUsed, /import \{ b \} from '\.\/b';\nimport \{ c \} from '\.\/c';/);
  assert.equal(conflictCount(tsUsed), 1);
  assert.deepEqual(JSON.parse(jsonUsed), { left: 1, right: 2 });
  assert.ok(
    f.session.files.every((file) => !file.resolved),
    'Proposals are never reviewed for you'
  );
  await assert.rejects(f.run({ kind: 'preview', id: f.session.id, version: f.session.version }), /every file reviewed/);

  // Review probe: main moves while the draft waits. Files already in the session get their proposals again, so a
  // proposal you kept stays a proposal, not a conflict you decided.
  let session = f.session;
  const kept = tsUsed.replace(
    /<<<<<<< [\s\S]*?>>>>>>> [^\n]*\n/,
    parseConflicts(ts.original).flatMap((s) => (s.kind === 'conflict' ? [s.block.ours] : []))[1]
  );
  // Fail closed: each proposal is accepted by choosing it (Use the proposal).
  for (const [file, contents, picks] of [
    ['numbers.ts', kept, ['proposal', null]],
    ['settings.json', jsonUsed, ['proposal']],
  ] as const)
    session = (
      await f.run({ kind: 'save', id: session.id, version: session.version, path: file, contents, resolved: true, picks: [...picks] })
    ).session;
  await f.git('checkout', 'main');
  await fs.writeFile(path.join(f.remote, 'later.txt'), 'Another PR merged.\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Another PR merged');
  f.state.baseSha = await f.git('rev-parse', 'HEAD');
  // Second review probe: conflicts that did not change keep their proposals; structural merge does not run again.
  const binaryPath = f.deps.mergiraf;
  let structural = 0;
  f.deps.mergiraf = () => {
    structural++;
    return binaryPath();
  };
  const moved = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.equal(structural, 0, 'Unchanged conflicts reuse their proposals');
  assert.equal(moved.baseMoved?.conflicts, 0);
  const after = moved.session.files.find((file) => file.path === 'numbers.ts');
  assert.ok(after);
  assert.equal(after.result, kept);
  assert.deepEqual(
    after.proposals?.map((p) => p && p.source),
    ['mergiraf', null]
  );
  assert.deepEqual(blockBuckets(after, after.result, undefined), ['check', 'decided']);
});

void test('where structural merge leaves both sides’ new functions open, preparation proposes both, the PR’s first', async (t) => {
  const binary = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
  if (!(await fs.stat(binary).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const fn = (name: string, body: string) => `export function ${name}(a: number, b: number) {\n  return ${body};\n}\n\n`;
  const before = (added: string) => `${fn('add', 'a + b')}${added}${fn('subtract', 'a - b')}`;
  const f = await fixture(t, false, {
    name: 'math.ts',
    base: before(''),
    ours: before(fn('multiply', 'a * b')),
    theirs: before(fn('divide', 'a / b')),
  });
  const [file] = f.session.files;
  assert.deepEqual(
    file.proposals?.map((p) => p && p.source),
    ['union']
  );
  assert.equal(withProposals(file.original, file.proposals ?? []), before(fn('multiply', 'a * b') + fn('divide', 'a / b')));
  assert.ok(!file.resolved, 'A union is never reviewed for you');
  // "Try structural merge again" would throw the union away: the service refuses it, as the dialog does (#462).
  assert.equal(canRetryStructural(file, true), false);
  await assert.rejects(
    f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'mergiraf', path: file.path }),
    /Structural merge already ran/
  );
});

// #457: a setext heading outside the conflicts is not a marker; Git's separator left behind still is.
void test('a Markdown heading underlined with ======= can be reviewed, carried and pushed; a leftover separator cannot', async (t) => {
  const f = await fixture(t, false, {
    name: 'README.md',
    base: 'Usage\n=======\n\nRun it 0 times.\n',
    ours: 'Usage\n=======\n\nRun it 1 times.\n',
    theirs: 'Usage\n=======\n\nRun it 2 times.\n',
  });
  const file = f.session.files[0];
  assert.equal(conflictFileStage(file), 'conflicted');
  // Git's separator left between both sides: refused, as in any file.
  const leftover = file.original
    .split('\n')
    .filter((line) => !/^(<{7}|>{7}|\|{7})/.test(line))
    .join('\n');
  await assert.rejects(
    f.run({ kind: 'save', id: f.session.id, version: f.session.version, path: file.path, contents: leftover, resolved: true }),
    /remaining conflict markers/
  );
  const resolved = 'Usage\n=======\n\nRun it 3 times.\n';
  let session = (
    await f.run({ kind: 'save', id: f.session.id, version: f.session.version, path: file.path, contents: resolved, resolved: true })
  ).session;
  assert.equal(conflictFileStage(session.files[0]), 'reviewed');
  // main moves elsewhere: the file stays reviewed, and the push carries the heading.
  await f.git('checkout', 'main');
  await fs.writeFile(path.join(f.remote, 'later.txt'), 'Another PR merged.\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Another PR merged');
  f.state.baseSha = await f.git('rev-parse', 'HEAD');
  const reply = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.equal(reply.baseMoved?.conflicts, 0);
  session = reply.session;
  assert.equal(session.files[0].resolved, true);
  assert.ok(reply.preview);
  const published = await f.run({
    kind: 'publish',
    id: session.id,
    version: session.version,
    previewToken: reply.preview.token,
    message: 'Merge main',
  });
  assert.equal(published.session.status, 'published');
  assert.equal(await f.git('show', 'feature:README.md'), resolved.trimEnd());
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

/** Two conflicts in one file, separated by lines a later base commit can change cleanly, and a third PR-only change. */
const movingSample = (a: number, b: number, c: number, filler = 'filler') =>
  [
    `export const a = ${a};`,
    'const f1 = 1;',
    'const f2 = 2;',
    `const f3 = '${filler}';`,
    'const f4 = 4;',
    'const f5 = 5;',
    `export const b = ${b};`,
    'const g1 = 1;',
    'const g2 = 2;',
    'const g3 = 3;',
    'const g4 = 4;',
    `export const c = ${c};`,
    '',
  ].join('\n');
void test('a background draft is reused when you open the PR, becomes yours, and never replaces your own (#445)', async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  Object.assign(f.deps.storage, { names: () => [`conflict-draft:tester:${f.session.id}`] });
  await f.run({ kind: 'discard', id: f.session.id, version: f.session.version });
  const counts: number[] = [];
  const prepared = await f.service.prepareInBackground(f.state.url, signal, (n) => counts.push(n));
  assert.ok(prepared?.background, 'Saved as a background draft');
  assert.deepEqual(counts, [1], 'The number of conflicted files is reported once Git has merged');
  assert.equal(f.service.draft(f.state.url, f.state.headSha)?.background, prepared.background);
  assert.equal(f.service.draft(f.state.url, '0'.repeat(40)), undefined, 'Only for the head it was prepared on');
  // Prepared again for the same head: nothing changes.
  assert.equal((await f.service.prepareInBackground(f.state.url, signal))?.version, prepared.version);
  // Opening reuses it, and it becomes yours.
  const opened = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(opened.version, prepared.version, 'Opening did not prepare again');
  assert.deepEqual(opened.files, prepared.files);
  assert.equal(opened.background, undefined);
  assert.equal(f.service.draft(f.state.url, f.state.headSha)?.background, undefined);
  // Your draft: background preparation and its clean-up leave it alone.
  const saved = (
    await f.run({ kind: 'save', id: opened.id, version: opened.version, path: 'sample.ts', contents: 'x\n', resolved: false })
  ).session;
  assert.equal((await f.service.prepareInBackground(f.state.url, signal))?.version, saved.version);
  await f.service.forgetBackground(f.state.url);
  await f.service.trimBackground(0);
  assert.equal(f.service.draft(f.state.url, f.state.headSha)?.files[0].result, 'x\n');
  // A background draft beyond the cap leaves with its cache.
  await f.run({ kind: 'discard', id: saved.id, version: saved.version });
  await f.service.prepareInBackground(f.state.url, signal);
  const cache = await conflictSessionDirectory(f.deps.directory(), 'tester', saved.id);
  assert.ok(await fs.stat(cache).catch(() => undefined), 'The background draft has a cache');
  await f.service.trimBackground(0);
  assert.equal(f.service.draft(f.state.url, f.state.headSha), undefined);
  assert.equal(await fs.stat(cache).catch(() => undefined), undefined, 'Its cache is removed');
});

void test('your requests never fail on background work: it stops, or finishes its drop, and yours goes ahead (#445)', async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  Object.assign(f.deps.storage, { names: () => [`conflict-draft:tester:${f.session.id}`] });
  await f.run({ kind: 'discard', id: f.session.id, version: f.session.version });
  // A background preparation in flight: your open stops it and prepares the PR itself.
  const background = f.service.prepareInBackground(f.state.url, signal).then(
    () => 'finished',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  const opened = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(await background, BACKGROUND_YIELDED);
  assert.equal(opened.background, undefined);
  // Your draft: a background preparation does nothing, before any work, and your save goes ahead.
  assert.equal((await f.service.prepareInBackground(f.state.url, signal))?.version, opened.version);
  const saved = await f.run({
    kind: 'save',
    id: opened.id,
    version: opened.version,
    path: 'sample.ts',
    contents: 'x\n',
    resolved: false,
  });
  assert.equal(saved.session.files[0].result, 'x\n');
  // A background drop in flight: your open waits for it, then prepares afresh.
  await f.run({ kind: 'discard', id: saved.session.id, version: saved.session.version });
  await f.service.prepareInBackground(f.state.url, signal);
  const dropping = f.service.trimBackground(0);
  const reopened = (await f.run({ kind: 'open', url: f.state.url })).session;
  await dropping;
  assert.ok(reopened.files.length);
  assert.equal(reopened.background, undefined);
});

void test('evicting a background draft drops it under its own account, never another account’s draft (#445)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-evict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = 'a'.repeat(64);
  const data = new Map<string, unknown>([
    [`conflict-draft:ann:${id}`, { id, account: 'ann', status: 'editing', files: [], background: 1 }],
    [`conflict-draft:bob:${id}`, { id, account: 'bob', status: 'editing', files: [] }],
  ]);
  const service = createConflictResolutionService({
    storage: {
      read: (key: string) => structuredClone(data.get(key)),
      write: (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      flush: async () => {},
      names: () => [...data.keys()],
    },
    directory: () => dir,
    // Bob is signed in; Ann's old background draft is evicted.
    context: () => ({ account: 'bob', token: 'not-a-real-token' }),
    read: () => Promise.reject(new Error('Not used')),
    mergiraf: () => 'missing',
    suggest: () => Promise.reject(new Error('Not used')),
  });
  const [ann, bob] = await Promise.all(['ann', 'bob'].map((account) => conflictSessionDirectory(dir, account, id)));
  await Promise.all([ann, bob].map((d) => fs.mkdir(d, { recursive: true })));
  await service.trimBackground(0);
  assert.equal(data.get(`conflict-draft:ann:${id}`), null);
  assert.equal(await fs.stat(ann).catch(() => undefined), undefined, 'Ann’s cache is removed');
  assert.deepEqual(data.get(`conflict-draft:bob:${id}`), { id, account: 'bob', status: 'editing', files: [] });
  assert.ok(await fs.stat(bob), 'Bob’s cache stays');
});

void test('the service checks proposals itself and saves the verdict with the draft (#445)', async (t) => {
  if (!(await fs.stat(nativeMergiraf).catch(() => undefined))) {
    t.skip('Needs the Mergiraf binary: npm run prepare:mergiraf.');
    return;
  }
  const assets = path.resolve('src/assets/tree-sitter');
  const engine = createSyntaxEngine(TreeSitter, {
    runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
    grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
    tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
  });
  // Opened first by a build without the checks: the draft has proposals and no verdict.
  const f = await fixture(t, false, jsonSample);
  const prepared = f.session.files[0];
  assert.ok(prepared.proposals?.[0], 'Structural merge proposed the conflict');
  assert.equal(prepared.verdict, undefined);
  let disabled: SyntaxLanguage[] = [];
  let failing = false;
  const checked: string[] = [];
  Object.assign(f.deps, {
    verify: (file: ConflictFile, off: SyntaxLanguage[]) => {
      checked.push(file.path);
      return failing ? Promise.resolve(undefined) : conflictChecker(engine, off)(file);
    },
    disabledLanguages: () => disabled,
  });
  // A check that could not run saves nothing, so the next open checks again.
  failing = true;
  let file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.equal(file.verdict, undefined);
  failing = false;
  checked.length = 0;
  // Reopening the draft checks it once; the verdict is saved, so the next open does not check again.
  file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.deepEqual(checked, ['settings.json']);
  assert.equal(file.verdict?.key, verdictKey(file, []));
  assert.ok(file.verdict.key.startsWith(`${CHECKS_VERSION}:`), 'The key names the checks’ version');
  assert.deepEqual(file.verdict.verdict, await verifyProposals(
      file,
      (l, x) => engine.definitions(l, x),
      false,
      (l, a, b) => engine.equivalent(l, a, b)
    ));
  assert.deepEqual(blockBuckets(file, file.result, file.verdict.verdict), [file.verdict.verdict.merged ? 'merged' : 'check']);
  file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.deepEqual(checked, ['settings.json'], 'A saved verdict for the same proposals is not checked again');
  // Turning a language off makes the saved verdict stale: it is checked again, and a language that is off is never
  // parsed.
  disabled = ['json'];
  file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.equal(checked.length, 2);
  assert.deepEqual(file.verdict?.verdict, { merged: false, note: 'Gnosis couldn’t parse this file to check the result.' });
  // The structural proposal json can't check stays on its card; the draft keeps the conflict's markers (fail closed).
  assert.ok(hasConflictMarkers(file.result), 'A proposal the checks did not Merge is never left in the draft');
  // A Suggest result is offered for the open conflict, as a model proposal: checked, never Merged, never in the draft.
  const session = (await f.run({ kind: 'open', url: f.state.url })).session;
  file = (await f.run({ kind: 'resolve', id: session.id, version: session.version, engine: 'agent', path: 'settings.json' }))
    .session.files[0];
  assert.deepEqual(file.proposals?.map((p) => p?.source), ['model']);
  assert.ok(hasConflictMarkers(file.result));
  assert.equal(file.verdict?.verdict.merged, false);
});

void test('an engine that fails answers nothing, so nothing is saved; a file that does not parse still says so (#445)', async () => {
  const definitions = () => Promise.reject(new Error('The grammar did not load'));
  const broken = conflictChecker({ definitions, equivalent: () => Promise.resolve(false) });
  const file = {
    path: 'src/a.ts',
    base: 'export const a = 0;\n',
    ours: 'export const a = 1;\n',
    theirs: 'export const a = 2;\n',
    original: '<<<<<<< pr\nexport const a = 1;\n||||||| base\nexport const a = 0;\n=======\nexport const a = 2;\n>>>>>>> main\n',
    proposals: [{ source: 'mergiraf' as const, text: 'export const a = (;\n' }],
  };
  assert.equal(await broken(file), undefined);
  const assets = path.resolve('src/assets/tree-sitter');
  const engine = createSyntaxEngine(TreeSitter, {
    runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
    grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
    tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
  });
  assert.deepEqual(await conflictChecker(engine)(file), { merged: false, note: 'With the proposals in place, the file doesn’t parse.' });
});

void test('a check that runs out of time answers nothing, and the worker restarts for the files after it (#445)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-check-worker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A stand-in worker: it never answers for `slow.ts` and answers every other file at once.
  const script = path.join(dir, 'worker.js');
  await fs.writeFile(
    script,
    "const { parentPort } = require('node:worker_threads');\n" +
      "parentPort.on('message', (m) => { if (m.file.path !== 'slow.ts') parentPort.postMessage({ id: m.id, verdict: { merged: true, note: m.file.path } }); });\n"
  );
  // Mocked timers: a file runs out of time only when the test moves the clock, however slowly a worker starts.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checks = createConflictCheckWorker(script, () => ({ runtime: '', grammars: '' }), 60_000, 300);
  t.after(() => checks.dispose());
  const file = (name: string) => ({ path: name, base: '', ours: '', theirs: '', original: '' });
  // Each file's time starts when it runs: files queued behind two slow ones still get their verdicts.
  const [slow, a, slowAgain, b] = ['slow.ts', 'a.ts', 'slow.ts', 'b.ts'].map((name) => checks.check(file(name)));
  t.mock.timers.tick(300);
  assert.equal(await slow, undefined);
  assert.deepEqual(await a, { merged: true, note: 'a.ts' });
  // a.ts answered before its own time ran out; the second slow file has the whole 300 ms from its own start.
  t.mock.timers.tick(300);
  assert.equal(await slowAgain, undefined);
  assert.deepEqual(await b, { merged: true, note: 'b.ts' });
  checks.dispose();
  assert.equal(await checks.check(file('a.ts')), undefined, 'After dispose, no worker starts');
});

async function movingFixture(t: TestContext, edit = (text: string) => text) {
  const f = await fixture(
    t,
    false,
    { name: 'sample.ts', base: movingSample(0, 0, 0), ours: movingSample(1, 1, 1), theirs: movingSample(2, 2, 0) },
    [
      {
        name: 'other.ts',
        base: 'export const x = 0;\n',
        ours: 'export const x = 1;\n',
        theirs: 'export const x = 2;\n',
      },
    ]
  );
  assert.deepEqual(f.session.files.map((file) => file.path).sort(), ['other.ts', 'sample.ts']);
  const sample = f.session.files.find((file) => file.path === 'sample.ts') as ConflictFile;
  assert.equal(conflictCount(sample.original), 2);
  // Block a is edited by hand, block b keeps the PR side: both kinds of result carry over.
  let index = 0;
  const resolved = parseConflicts(sample.original)
    .map((segment) =>
      segment.kind === 'text' ? segment.text : index++ === 0 ? 'export const a = 3;\n' : segment.block.ours
    )
    .join('');
  let session = f.session;
  for (const [file, contents] of [
    ['sample.ts', edit(resolved)],
    ['other.ts', 'export const x = 3;\n'],
  ])
    session = (
      await f.run({ kind: 'save', id: session.id, version: session.version, path: file, contents, resolved: true })
    ).session;
  const reply = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.ok(reply.preview);
  assert.equal(reply.baseMoved, undefined);
  /** A new commit on main, as when someone merges another PR. */
  const advanceBase = async (files: Record<string, string>) => {
    await f.git('checkout', 'main');
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(f.remote, name), text);
    await f.git('add', '.');
    await f.git('commit', '-m', 'Another PR merged');
    f.state.baseSha = await f.git('rev-parse', 'HEAD');
    return f.state.baseSha;
  };
  return { ...f, session, preview: reply.preview, advanceBase };
}

void test('base moved before the push, no new conflicts: the merge is redone and pushed with the user’s resolutions', async (t) => {
  const f = await movingFixture(t);
  const from = f.state.baseSha;
  const to = await f.advanceBase({
    'sample.ts': movingSample(2, 2, 0, 'moved'),
    'later.txt': 'A later base commit.\n',
    // The base now agrees with the PR, so this file no longer conflicts.
    'other.ts': 'export const x = 1;\n',
  });
  const published = await f.run({
    kind: 'publish',
    id: f.session.id,
    version: f.session.version,
    previewToken: f.preview.token,
    message: 'Merge main',
  });
  assert.equal(published.session.status, 'published');
  assert.deepEqual(published.baseMoved, { from, to, conflicts: 0, files: [] });
  assert.equal(published.session.baseSha, to);
  assert.equal(await f.git('rev-parse', 'feature^1'), f.state.headSha);
  assert.equal(await f.git('rev-parse', 'feature^2'), to, 'The merge commit has the new base as its second parent');
  const merged = await f.git('show', 'feature:sample.ts');
  assert.match(merged, /export const a = 3;/, 'The hand-edited block carried over');
  assert.match(merged, /export const b = 1;/, 'The chosen side carried over');
  assert.match(merged, /f3 = 'moved'/, 'The new base change is included');
  assert.match(merged, /export const c = 1;/);
  assert.equal(
    await f.git('show', 'feature:other.ts'),
    'export const x = 1;',
    'A file that merges cleanly now is fine'
  );
  assert.equal(await f.git('show', 'feature:later.txt'), 'A later base commit.');
});

void test('base moved with a new conflict: only that conflict reopens, other resolutions are kept, nothing is pushed', async (t) => {
  const f = await movingFixture(t);
  const from = f.state.baseSha;
  const to = await f.advanceBase({ 'sample.ts': movingSample(2, 2, 2, 'moved') });
  const reply = await f.run({
    kind: 'publish',
    id: f.session.id,
    version: f.session.version,
    previewToken: f.preview.token,
    message: 'Merge main',
  });
  assert.equal(reply.session.status, 'editing');
  assert.deepEqual(reply.baseMoved, { from, to, conflicts: 1, files: ['sample.ts'] });
  assert.equal(await f.git('rev-parse', 'feature'), f.state.headSha, 'Nothing was pushed');
  const sample = reply.session.files.find((file) => file.path === 'sample.ts') as ConflictFile;
  const other = reply.session.files.find((file) => file.path === 'other.ts') as ConflictFile;
  assert.equal(sample.resolved, false);
  assert.equal(conflictCount(sample.result), 1, 'Only the new conflict is open');
  assert.match(sample.result, /export const a = 3;/);
  assert.match(sample.result, /export const b = 1;/);
  assert.match(sample.result, /f3 = 'moved'/);
  const open = parseConflicts(sample.result).find((segment) => segment.kind === 'conflict');
  assert.ok(open?.kind === 'conflict');
  assert.equal(open.block.ours, 'export const c = 1;\n');
  assert.equal(open.block.theirs, 'export const c = 2;\n');
  assert.equal(other.resolved, true, 'An unchanged file stays reviewed');
  assert.equal(other.result, 'export const x = 3;\n');
  // Resolving the new conflict publishes against the new base.
  let session = (
    await f.run({
      kind: 'save',
      id: reply.session.id,
      version: reply.session.version,
      path: 'sample.ts',
      contents: sample.result.replace(/<{7}[\s\S]*?>{7}[^\n]*\n/, 'export const c = 3;\n'),
      resolved: true,
    })
  ).session;
  const preview = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.equal(preview.baseMoved, undefined);
  assert.ok(preview.preview);
  session = (
    await f.run({
      kind: 'publish',
      id: session.id,
      version: session.version,
      previewToken: preview.preview.token,
      message: 'Merge main',
    })
  ).session;
  assert.equal(session.status, 'published');
  assert.equal(await f.git('rev-parse', 'feature^2'), to);
  assert.match(await f.git('show', 'feature:sample.ts'), /a = 3;[\s\S]*b = 1;[\s\S]*c = 3;/);
});

void test('edits around the conflicts survive a moved base through a text merge', async (t) => {
  const f = await movingFixture(t, (text) => text.replace('const g3 = 3;', 'const g3 = 30;'));
  await f.advanceBase({ 'sample.ts': movingSample(2, 2, 0, 'moved') });
  const published = await f.run({
    kind: 'publish',
    id: f.session.id,
    version: f.session.version,
    previewToken: f.preview.token,
    message: 'Merge main',
  });
  assert.equal(published.session.status, 'published');
  assert.equal(published.baseMoved?.conflicts, 0);
  const merged = await f.git('show', 'feature:sample.ts');
  assert.match(merged, /a = 3;[\s\S]*f3 = 'moved'[\s\S]*b = 1;[\s\S]*g3 = 30;/);
});

void test('the PR head moved: publishing is blocked and Load latest changes reuses resolutions for review', async (t) => {
  const f = await movingFixture(t);
  await f.git('checkout', 'feature');
  await fs.writeFile(path.join(f.remote, 'readme.md'), 'A teammate’s commit.\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Teammate change');
  const teammate = await f.git('rev-parse', 'HEAD');
  await f.git('checkout', 'main');
  f.state.headSha = teammate;
  await assert.rejects(
    f.run({
      kind: 'publish',
      id: f.session.id,
      version: f.session.version,
      previewToken: f.preview.token,
      message: 'Merge main',
    }),
    /PR branch has new commits/
  );
  assert.equal(await f.git('rev-parse', 'feature'), teammate, 'The teammate’s commit is never overwritten');
  const reloaded = (await f.run({ kind: 'open', url: f.state.url, restart: true, keep: true })).session;
  assert.equal(reloaded.headSha, teammate);
  const sample = reloaded.files.find((file) => file.path === 'sample.ts') as ConflictFile;
  assert.equal(conflictCount(sample.result), 0, 'Unchanged conflicts reuse the earlier resolutions');
  assert.match(sample.result, /export const a = 3;/);
  assert.ok(
    reloaded.files.every((file) => !file.resolved),
    'New PR commits mean every file is reviewed again'
  );
  // Start over drops the draft.
  const fresh = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(conflictCount((fresh.files.find((file) => file.path === 'sample.ts') as ConflictFile).result), 2);
});

void test('a base branch that keeps moving stops after a few merges and pushes nothing', async (t) => {
  const f = await movingFixture(t);
  let reads = 0;
  const read = f.deps.read;
  f.deps.read = async () => {
    reads++;
    await f.advanceBase({ [`later-${reads}.txt`]: `${reads}\n` });
    return read();
  };
  await assert.rejects(
    f.run({
      kind: 'publish',
      id: f.session.id,
      version: f.session.version,
      previewToken: f.preview.token,
      message: 'Merge main',
    }),
    /kept moving/
  );
  assert.equal(reads, 4, 'One check, then one check after each of three merges');
  assert.equal(await f.git('rev-parse', 'feature'), f.state.headSha);
  // The draft is unchanged, so the same review can continue once the base settles.
  f.deps.read = read;
  const reply = await f.run({ kind: 'preview', id: f.session.id, version: f.session.version });
  assert.equal(reply.baseMoved?.conflicts, 0);
  assert.ok(reply.preview);
});

void test('a restack check that fails early waits for every read it started', async () => {
  const { prepareRestack } = await import('../src/conflict-restack');
  const finished: string[] = [];
  const urls = ['https://github.com/test/repo/pull/2', 'https://github.com/test/repo/pull/3'];
  const session = {
    url: 'https://github.com/test/repo/pull/1',
    account: 'tester',
    commitSha: 'a'.repeat(40),
    headRepo: 'test/repo',
    headBranch: 'feature',
  } as Parameters<typeof prepareRestack>[0];
  const read = async (url: string) => {
    // The dependents answer late; the root answers at once from another account, so its check fails first.
    if (url !== session.url) await new Promise((resolve) => setTimeout(resolve, 20));
    finished.push(url);
    return { url, account: url === session.url ? 'someone-else' : 'tester' } as Awaited<
      ReturnType<Parameters<typeof prepareRestack>[2]['read']>
    >;
  };
  await assert.rejects(
    prepareRestack(session, urls, {
      git: () => Promise.reject(new Error('no git expected')),
      read,
      directory: '',
      remote: () => '',
      signal: new AbortController().signal,
      report: () => {},
    }),
    /Cannot update/
  );
  assert.deepEqual(finished.sort(), [session.url, ...urls].sort(), 'no read is still running when the check rejects');
});

/** The reorder case from the conflict lab: the PR moves alpha below beta, and main edits alpha's body. */
const goFunction = (name: string, total = 'value + 1') =>
  `func ${name}(value int) int {\n\ttotal := ${total}\n\tscaled := total * 2\n\treturn scaled - 3\n}\n`;
const goFile = (functions: string[], filler = 'value + 1') =>
  [
    'package lab\n',
    'func filler0(value int) int {\n\treturn value + 0\n}\n',
    ...functions,
    `func filler1(value int) int {\n\treturn ${filler}\n}\n`,
  ].join('\n');
const nativeMergiraf = path.resolve(
  'resources/mergiraf/runtime',
  process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'
);

void test('a structural merge that also moves lines outside the conflicts is a whole-file proposal in Check, never Merged', async (t) => {
  if (!(await fs.stat(nativeMergiraf).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const expected = goFile([goFunction('beta'), goFunction('alpha', 'value + 10')]);
  const f = await fixture(t, false, {
    name: 'reorder.go',
    base: goFile([goFunction('alpha'), goFunction('beta')]),
    ours: goFile([goFunction('beta'), goFunction('alpha')]),
    theirs: goFile([goFunction('alpha', 'value + 10'), goFunction('beta')]),
  });
  const file = f.session.files.find((x) => x.path === 'reorder.go') as ConflictFile;
  assert.equal(file.wholeFile?.text, expected, 'Mergiraf’s whole-file result is kept');
  assert.equal(file.proposals, undefined);
  assert.equal(file.result, file.original, 'The draft stays as Git wrote it until you use the proposal');
  assert.equal(file.resolved, false);
  assert.deepEqual(
    blockBuckets(file, file.result, { merged: false, passed: true, note: 'passed' }),
    ['check'],
    'One thing to check, even when its checks pass'
  );
  let structural = 0;
  f.deps.mergiraf = () => {
    structural++;
    return nativeMergiraf;
  };
  // Using it (Use this result) makes it the draft, unreviewed. The proposal stays for Reset file.
  let session = (
    await f.run({ kind: 'resolve', id: f.session.id, version: f.session.version, engine: 'whole-file', path: file.path })
  ).session;
  let used = session.files.find((x) => x.path === 'reorder.go') as ConflictFile;
  assert.equal(structural, 0, 'The kept result is used; Mergiraf does not run again');
  assert.equal(used.result, expected);
  assert.equal(used.source, 'mergiraf');
  assert.equal(used.resolved, false);
  assert.equal(used.wholeFile?.text, expected, 'Reset file can return to the proposal');
  assert.ok(blockBuckets(used, used.result, undefined).every((bucket) => bucket === 'decided'));

  // Start over, then resolve conflict by conflict instead: the proposal stays beside the draft.
  session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  used = session.files.find((x) => x.path === 'reorder.go') as ConflictFile;
  const theirs = parseConflicts(used.original)
    .map((s) => (s.kind === 'text' ? s.text : s.block.theirs))
    .join('');
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: used.path,
      contents: theirs,
      resolved: true,
    })
  ).session;
  const advance = async (name: string, text: string) => {
    await f.git('checkout', 'main');
    await fs.writeFile(path.join(f.remote, name), text);
    await f.git('add', '.');
    await f.git('commit', '-m', 'Another PR merged');
    f.state.baseSha = await f.git('rev-parse', 'HEAD');
  };
  // The base moves elsewhere: the file's three versions are the same, so the proposal carries and Mergiraf rests.
  structural = 0;
  await advance('later.txt', 'Another PR merged.\n');
  let reply = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.equal(reply.baseMoved?.conflicts, 0);
  assert.equal(structural, 0);
  assert.equal(reply.session.files.find((x) => x.path === 'reorder.go')?.wholeFile?.text, expected);
  // The base changes this file outside the conflict: the old proposal would drop that change, so Mergiraf runs again.
  await advance('reorder.go', goFile([goFunction('alpha', 'value + 10'), goFunction('beta')], 'value + 100'));
  reply = await f.run({ kind: 'preview', id: reply.session.id, version: reply.session.version });
  assert.equal(reply.baseMoved?.conflicts, 0);
  assert.notEqual(structural, 0, 'Mergiraf runs again');
  assert.equal(
    reply.session.files.find((x) => x.path === 'reorder.go')?.wholeFile?.text,
    goFile([goFunction('beta'), goFunction('alpha', 'value + 10')], 'value + 100')
  );
});

void test('a draft saved before the whole-file proposal gets the structural pass once, beside the draft', async (t) => {
  if (!(await fs.stat(nativeMergiraf).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const expected = goFile([goFunction('beta'), goFunction('alpha', 'value + 10')]);
  const f = await fixture(
    t,
    false,
    {
      name: 'reorder.go',
      base: goFile([goFunction('alpha'), goFunction('beta')]),
      ours: goFile([goFunction('beta'), goFunction('alpha')]),
      theirs: goFile([goFunction('alpha', 'value + 10'), goFunction('beta')]),
    },
    [
      {
        name: 'edited.ts',
        base: 'export const a = 0;\n',
        ours: 'export const a = 1;\n',
        theirs: 'export const a = 2;\n',
      },
      {
        name: 'settings.json',
        base: '{"left":0,"right":0}\n',
        ours: '{"left":1,"right":0}\n',
        theirs: '{"left":0,"right":2}\n',
      },
    ]
  );
  // The draft as an older build saved it: no record of the pass, no proposals, one file edited by hand, and one
  // holding a Suggest result.
  const key = `conflict-draft:${f.context.account}:${f.session.id}`;
  const old = structuredClone(f.session);
  for (const file of old.files) {
    delete file.wholeFile;
    delete file.structuralNote;
    delete file.structuralRan;
    delete file.proposals;
    file.result = file.original;
    file.source = 'manual';
  }
  const edited = old.files.find((x) => x.path === 'edited.ts') as ConflictFile;
  edited.result = 'export const a = 3;\n';
  const suggested = old.files.find((x) => x.path === 'settings.json') as ConflictFile;
  Object.assign(suggested, {
    result: '{"left":1,"right":2}\n',
    source: 'mergiraf',
    explanation: 'Mergiraf proposed it.',
  });
  f.deps.storage.write(key, old);
  let structural = 0;
  f.deps.mergiraf = () => {
    structural++;
    return nativeMergiraf;
  };
  const { session } = await f.run({ kind: 'open', url: f.state.url });
  assert.ok(structural > 0);
  const byPath = (path: string) => session.files.find((x) => x.path === path) as ConflictFile;
  assert.equal(byPath('reorder.go').wholeFile?.text, expected);
  assert.equal(byPath('reorder.go').result, byPath('reorder.go').original, 'The pass never writes a draft');
  assert.equal(byPath('reorder.go').structuralRan, true);
  // Your edit and the Suggest result are left exactly as they were.
  assert.equal(byPath('edited.ts').result, 'export const a = 3;\n');
  assert.equal(byPath('edited.ts').structuralRan, undefined);
  assert.equal(byPath('settings.json').result, '{"left":1,"right":2}\n');
  assert.equal(byPath('settings.json').proposals, undefined);
  assert.equal(byPath('settings.json').wholeFile, undefined);
  assert.equal(session.version, old.version + 1);
  // Recorded: the next reopen does not run it again.
  structural = 0;
  await f.run({ kind: 'open', url: f.state.url });
  assert.equal(structural, 0);
});

void test('a file reset to Git’s conflict after a suggestion stays as you left it on reopen', async (t) => {
  if (!(await fs.stat(nativeMergiraf).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const f = await fixture(t, false, {
    name: 'settings.json',
    base: '{"left":0,"right":0}\n',
    ours: '{"left":1,"right":0}\n',
    theirs: '{"left":0,"right":2}\n',
  });
  let session = (
    await f.run({
      kind: 'resolve',
      id: f.session.id,
      version: f.session.version,
      engine: 'mergiraf',
      path: 'settings.json',
    })
  ).session;
  const file = session.files[0];
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: file.path,
      contents: file.original,
      resolved: false,
    })
  ).session;
  let structural = 0;
  f.deps.mergiraf = () => {
    structural++;
    return nativeMergiraf;
  };
  const reopened = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.equal(structural, 0, 'Structural merge already ran for this draft');
  assert.equal(reopened.result, file.original);
  // The suggestion's part stays offered on its card; the draft is as you left it.
  assert.deepEqual(reopened.proposals?.map((p) => p?.source), ['mergiraf']);
});

/** A stand-in Mergiraf that answers by the budget it gets, and logs each budget. */
async function stubMergiraf(t: TestContext, script: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-stub-mergiraf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log');
  const binary = path.join(dir, 'mergiraf');
  await fs.writeFile(
    binary,
    `#!/bin/sh\nfor a in "$@"; do [ "$prev" = "--timeout" ] && budget="$a"; prev="$a"; done\necho "$budget" >> '${log}'\n${script}`,
    { mode: 0o755 }
  );
  return {
    binary,
    budgets: async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
  };
}
const jsonSample = {
  name: 'settings.json',
  base: '{"left":0,"right":0}\n',
  ours: '{"left":1,"right":0}\n',
  theirs: '{"left":0,"right":2}\n',
};

void test('a structural merge that runs out of time is retried with the Suggest budget, then noted on the file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Needs a POSIX shell for the stand-in Mergiraf.');
    return;
  }
  const f = await fixture(t, false, jsonSample, [{ ...jsonSample, name: 'other.json' }]);
  // Hangs on the first budget; answers at once on the retry budget.
  const stub = await stubMergiraf(
    t,
    `[ "$budget" = 10000 ] && { printf '{"left":1,"right":2}\\n'; exit 0; }\nexec sleep 30\n`
  );
  f.deps.mergiraf = () => stub.binary;
  Object.assign(f.deps, { structuralTimeouts: [100, 10_000, 60_000] });
  let files = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session.files;
  assert.deepEqual(await stub.budgets(), ['100', '100', '10000', '10000'], 'Every first try runs before any retry');
  for (const file of files) {
    assert.deepEqual(JSON.parse(file.proposals?.[0]?.text ?? ''), { left: 1, right: 2 }, 'The retry’s proposal is kept');
    assert.equal(file.structuralNote, undefined);
  }
  // No retry time left: the files stay as Git wrote them, and say why.
  Object.assign(f.deps, { structuralTimeouts: [100, 10_000, 0] });
  files = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session.files;
  for (const file of files) {
    assert.equal(file.result, file.original);
    assert.equal(file.structuralNote, 'Structural merge timed out.');
  }
  // Suggest replaces the draft, so the note no longer applies.
  const session = (await f.run({ kind: 'open', url: f.state.url })).session;
  const suggested = (
    await f.run({
      kind: 'resolve',
      id: session.id,
      version: session.version,
      engine: 'mergiraf',
      path: 'settings.json',
    })
  ).session.files.find((x) => x.path === 'settings.json');
  assert.equal(suggested?.structuralNote, undefined);
});

void test('a result that arrives after the budget is Mergiraf’s fallback, not its merge', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Needs a POSIX shell for the stand-in Mergiraf.');
    return;
  }
  const f = await fixture(t, false, jsonSample);
  // Past the first budget it prints a file with no markers, as a line merge may; the retry answers properly.
  const stub = await stubMergiraf(
    t,
    `[ "$budget" = 10000 ] && { printf '{"left":1,"right":2}\\n'; exit 0; }\nsleep 1\nprintf 'not the merge\\n'\n`
  );
  f.deps.mergiraf = () => stub.binary;
  Object.assign(f.deps, { structuralTimeouts: [100, 10_000, 60_000] });
  const file = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session.files[0];
  assert.deepEqual(await stub.budgets(), ['100', '10000']);
  assert.equal(file.wholeFile, undefined);
  assert.deepEqual(JSON.parse(file.proposals?.[0]?.text ?? ''), { left: 1, right: 2 });
});

void test('trying structural merge again keeps the draft when it runs out of time again', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Needs a POSIX shell for the stand-in Mergiraf.');
    return;
  }
  const f = await fixture(t, false, jsonSample);
  // Always past the budget, then Git's line-merge fallback: no markers, and not Mergiraf's merge.
  const stub = await stubMergiraf(t, `sleep 0.4\nprintf 'not the merge\\n'\n`);
  f.deps.mergiraf = () => stub.binary;
  Object.assign(f.deps, { structuralTimeouts: [100, 300, 300] });
  const session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(session.files[0].structuralNote, 'Structural merge timed out.');
  const before = session.files[0];
  const file = (
    await f.run({
      kind: 'resolve',
      id: session.id,
      version: session.version,
      engine: 'mergiraf',
      path: before.path,
    })
  ).session.files[0];
  assert.equal(file.result, before.result, 'The draft stays as it was');
  assert.equal(file.source, before.source);
  assert.equal(file.structuralNote, 'Structural merge timed out again.');
  assert.ok((await stub.budgets()).includes('300'), 'The full budget');
});

void test('a file structural merge proposed nothing for says why, and a base move that changes it runs it again', async (t) => {
  // Both sides changed the same line: Mergiraf leaves the conflict.
  const tail = Array.from({ length: 8 }, (_, i) => `export const keep${i} = ${i};\n`).join('');
  const sample = (answer: number, last = 0) =>
    `export const answer = ${answer};\n${tail}export const last = ${last};\n`;
  const f = await fixture(t, false, { name: 'sample.ts', base: sample(0), ours: sample(1), theirs: sample(2) });
  const native = !!(await fs.stat(nativeMergiraf).catch(() => undefined));
  if (native) assert.equal(f.session.files[0].structuralNote, 'Structural merge couldn’t combine this file.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-failing-mergiraf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  f.deps.mergiraf = () => path.join(dir, 'missing');
  let session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(session.files[0].structuralNote, 'Structural merge isn’t available in this build.');
  if (process.platform === 'win32') return;
  const failing = path.join(dir, 'mergiraf');
  await fs.writeFile(failing, '#!/bin/sh\necho "mergiraf: internal error" >&2\nexit 134\n', { mode: 0o755 });
  let runs = 0;
  f.deps.mergiraf = () => {
    runs++;
    return failing;
  };
  session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  const file = session.files[0];
  assert.equal(file.result, file.original);
  assert.equal(file.structuralNote, 'Structural merge couldn’t combine this file.');
  // Resolve it, then main changes the same file away from the conflict: the note was about other versions.
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: file.path,
      contents: sample(3),
      resolved: true,
    })
  ).session;
  await f.git('checkout', 'main');
  await fs.writeFile(path.join(f.remote, 'sample.ts'), sample(2, 9));
  await f.git('commit', '-am', 'Another PR merged');
  f.state.baseSha = await f.git('rev-parse', 'HEAD');
  runs = 0;
  const reply = await f.run({ kind: 'preview', id: session.id, version: session.version });
  assert.equal(reply.baseMoved?.conflicts, 0);
  assert.notEqual(runs, 0, 'Structural merge ran again on the new versions');
});

void test('a file structural merge gave no result stays eligible, and the next reopen with Mergiraf replaces the note', async (t) => {
  if (process.platform === 'win32' || !(await fs.stat(nativeMergiraf).catch(() => undefined))) {
    t.skip('Needs a POSIX shell and npm run prepare:mergiraf.');
    return;
  }
  const f = await fixture(t, false, jsonSample);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-no-mergiraf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  f.deps.mergiraf = () => path.join(dir, 'missing');
  let file = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session.files[0];
  assert.equal(file.structuralNote, 'Structural merge isn’t available in this build.');
  assert.equal(file.structuralRan, undefined);
  // Out of time with no retry budget left: also no result.
  const stub = await stubMergiraf(t, 'exec sleep 30\n');
  f.deps.mergiraf = () => stub.binary;
  Object.assign(f.deps, { structuralTimeouts: [100, 10_000, 0] });
  file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.deepEqual(await stub.budgets(), ['100']);
  assert.equal(file.structuralNote, 'Structural merge timed out.');
  assert.equal(file.structuralRan, undefined);
  // Mergiraf is back: the pass runs, its proposal waits beside the draft, and the old note is gone.
  f.deps.mergiraf = () => nativeMergiraf;
  file = (await f.run({ kind: 'open', url: f.state.url })).session.files[0];
  assert.equal(file.structuralRan, true);
  assert.equal(file.structuralNote, undefined);
  assert.equal(file.result, file.original);
  assert.ok(file.proposals?.[0]);
});

/** The lab's ts-move-vs-edit-bottom case: the PR moves orderTotal to the end of the file, and main edits it. */
async function movedCase() {
  const dir = path.resolve('tests/fixtures/conflicts/ts-move-vs-edit-bottom');
  const [base, ours, theirs, resolved] = await Promise.all(
    ['base', 'ours', 'theirs', 'resolved'].map((side) => fs.readFile(path.join(dir, side, 'src/pricing.ts'), 'utf8'))
  );
  return { sample: { name: 'pricing.ts', base, ours, theirs }, resolved };
}
const movedEngine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) =>
    new Uint8Array(await fs.readFile(path.resolve('src/assets/tree-sitter', `${language}.wasm`))),
  tags: (name) => fs.readFile(path.resolve('src/assets/tree-sitter', `${name}-tags.scm`), 'utf8'),
});

void test('a move rule proposal is an extra whole-file option: Use applies its text with no structural merge, and the retry stays', async (t) => {
  const { sample, resolved } = await movedCase();
  const f = await fixture(t, false, sample);
  let structural = 0;
  Object.assign(f.deps, {
    // This build has no Mergiraf: the move rule runs on Git's conflicts.
    mergiraf: () => {
      structural++;
      return path.join(os.tmpdir(), 'no-such-mergiraf');
    },
    moved: (file: ConflictFile, disabled: SyntaxLanguage[]) => moveProposer(movedEngine, disabled)(file),
  });
  let session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  let file = session.files.find((x) => x.path === 'pricing.ts') as ConflictFile;
  assert.equal(file.wholeFile?.source, 'moved');
  assert.equal(file.wholeFile.text, resolved);
  assert.equal(file.wholeFile.note, 'The PR moved orderTotal, and main edited it.');
  assert.equal(file.result, file.original, 'The draft stays as Git wrote it');
  assert.equal(file.proposals, undefined);
  assert.equal(file.structuralNote, 'Structural merge isn’t available in this build.', 'The note stays');
  structural = 0;
  session = (
    await f.run({ kind: 'resolve', id: session.id, version: session.version, engine: 'whole-file', path: file.path })
  ).session;
  file = session.files.find((x) => x.path === 'pricing.ts') as ConflictFile;
  assert.equal(structural, 0, 'Using the proposal runs no structural merge');
  assert.equal(file.result, resolved);
  assert.equal(file.resolved, false, 'Using it does not review it');
  assert.equal(file.source, 'manual');
  assert.equal(file.wholeFile?.text, resolved, 'Reset file can return to the proposal');
  // A move rule's proposal doesn't stop "Try structural merge again"; structural merge's own does.
  const timedOut = { ...file, result: file.original, structuralNote: 'Structural merge timed out.' };
  assert.equal(canRetryStructural(timedOut, true), true);
  assert.equal(canRetryStructural({ ...timedOut, wholeFile: { source: 'mergiraf', text: resolved } }, true), false);
});

void test('the move rule never replaces per-conflict proposals or the draft', async (t) => {
  const binary = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
  if (!(await fs.stat(binary).catch(() => undefined))) {
    t.skip('Run npm run prepare:mergiraf for the native integration check.');
    return;
  }
  const fn = (name: string, body: string) => `export function ${name}(a: number, b: number) {\n  return ${body};\n}\n\n`;
  const before = (added: string) => `${fn('add', 'a + b')}${added}${fn('subtract', 'a - b')}`;
  const f = await fixture(t, false, {
    name: 'math.ts',
    base: before(''),
    ours: before(fn('multiply', 'a * b')),
    theirs: before(fn('divide', 'a / b')),
  });
  // A move rule that proposes everywhere: the file keeps its union and its draft.
  Object.assign(f.deps, { moved: () => Promise.resolve({ source: 'moved', text: 'export const x = 1;\n' }) });
  const { session } = await f.run({ kind: 'open', url: f.state.url, restart: true });
  const [file] = session.files;
  assert.deepEqual(
    file.proposals?.map((p) => p && p.source),
    ['union']
  );
  assert.equal(file.wholeFile, undefined);
  assert.equal(withProposals(file.original, file.proposals ?? []), before(fn('multiply', 'a * b') + fn('divide', 'a / b')));
});

// #493: the lines a resolver wrote keep their marks while its text is the baseline, and lose them once it isn't.
void test('a suggestion that declines keeps the marks; Reset clears the resolver text, so a line you type is never marked', async (t) => {
  const { draftWritten, resolverBaseline } = await import('../lib/conflict-diff');
  // Structural merge combines both sides' arguments into one line neither side had.
  const f = await fixture(t, false, {
    name: 'sample.ts',
    base: 'export function run() {\n  return call(1, 2);\n}\n',
    ours: 'export function run() {\n  return call(10, 2);\n}\n',
    theirs: 'export function run() {\n  return call(1, 20);\n}\n',
  });
  const marks = (file: ConflictFile) => [
    ...draftWritten(
      file,
      file.result,
      resolverBaseline(file, file.result),
      file.picks?.map((pick) => pick ?? undefined),
      undefined,
      file.edits
    ),
  ];
  let file = f.session.files[0];
  // Without the checks nothing is Merged: the proposal waits on its card, and nothing in the draft is marked.
  assert.ok(hasConflictMarkers(file.result));
  assert.deepEqual(marks(file), []);
  // Use the proposal: structural merge's line is in the draft now, marked.
  let session = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: file.path,
      contents: withProposals(file.original, file.proposals ?? []),
      resolved: false,
      picks: ['proposal'],
    })
  ).session;
  const prepared = marks(session.files[0]);
  assert.deepEqual(prepared, [2], 'structural merge wrote call(10, 20)');
  // A suggestion that declines keeps the draft, and its marks.
  f.deps.suggest = () => Promise.resolve({ explanation: 'Nothing to change.' } as never);
  session = (await f.run({ kind: 'resolve', engine: 'agent', id: session.id, version: session.version, path: file.path })).session;
  file = session.files[0];
  assert.deepEqual(file.proposals?.map((p) => p?.source), ['mergiraf'], 'A declined suggestion leaves the proposals');
  assert.deepEqual(marks(file), prepared);
  // Back to the original conflict, a suggestion's part is offered on the card, never written into the draft: nothing of
  // it is marked until you use it.
  session = (
    await f.run({ kind: 'save', id: session.id, version: session.version, path: file.path, contents: file.original, resolved: false, picks: [] })
  ).session;
  f.deps.suggest = () => Promise.resolve({ contents: 'export function run() {\n  return call(10, 20);\n}\n', explanation: 'Both.' });
  session = (await f.run({ kind: 'resolve', engine: 'agent', id: session.id, version: session.version, path: file.path })).session;
  file = session.files[0];
  assert.deepEqual(file.proposals?.map((p) => p?.source), ['model']);
  assert.equal(file.result, file.original);
  assert.deepEqual(marks(file), []);
  // Type the same line yourself, in place: it is yours, never marked, even where it reads like the model's.
  const typed = 'export function run() {\n  return call(10, 20);\n}\n';
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: file.path,
      contents: typed,
      resolved: false,
      edits: [{ text: '  return call(10, 20);\n', before: null, pick: null }],
    })
  ).session;
  assert.deepEqual(marks(session.files[0]), [], 'no typed line is marked');
  // A conflict you decided keeps your text: a later suggestion never overrides it, and its note says so.
  f.deps.suggest = () => Promise.resolve({ contents: 'export function run() {\n  return call(11, 22);\n}\n', explanation: 'Other.' });
  session = (await f.run({ kind: 'resolve', engine: 'agent', id: session.id, version: session.version, path: file.path })).session;
  assert.equal(session.files[0].result, typed);
  assert.match(session.files[0].explanation ?? '', /already decided; that one keeps its text/);
  session = (await f.run({ kind: 'save', id: session.id, version: session.version, path: file.path, contents: 'export function run() {\n  return call(10, 2);\n}\n', resolved: false })).session;
  assert.equal(session.files[0].resolverText, undefined);
});

const ACCOUNT =
  'class Account:\n    def __init__(self, owner, balance=0):\n        self.owner = owner\n        self.balance = balance\n\n    def deposit(self, amount):\n        self.balance += amount\n';
const WITHDRAW = '\n    def withdraw(self, amount):\n        self.balance -= amount\n';
const STATEMENT = '\n    def statement(self):\n        return f"{self.owner}: {self.balance}"\n';
/**
 * A 3-PR stack for the restack pipeline (#445 item 21): PR 1 (feature) resolved and pushed, PR 2 (child) changes
 * `file` as `child` where main changed it as `main`, and PR 3 (tip) adds a file of its own. The service checks proposals
 * as the app does, in tree-sitter.
 */
async function pipelineStack(t: TestContext, file: { name: string; base: string; main: string; child: string }) {
  const f = await fixture(t, false, undefined, [{ name: file.name, base: file.base, ours: file.base, theirs: file.main }]);
  Object.assign(f.deps, {
    verify: (checked: ConflictFile, off: SyntaxLanguage[]) => conflictChecker(movedEngine, off)(checked),
    moved: (checked: ConflictFile, off: SyntaxLanguage[]) => moveProposer(movedEngine, off)(checked),
  });
  const remote = f.deps.remote();
  await f.git('checkout', '-b', 'child', f.state.headSha);
  await fs.writeFile(path.join(remote, file.name), file.child);
  await f.git('commit', '-am', 'child change');
  await f.git('checkout', '-b', 'tip');
  await fs.writeFile(path.join(remote, 'tip.txt'), 'tip change\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'tip change');
  await f.git('checkout', 'main');
  const service = createConflictResolutionService(f.deps);
  const signal = new AbortController().signal;
  let session = (await service.run({ kind: 'open', url: f.state.url, restart: true }, signal)).session;
  session = (
    await service.run(
      {
        kind: 'save',
        id: session.id,
        version: session.version,
        path: 'sample.ts',
        contents: 'export const answer = 3;\n',
        resolved: true,
      },
      signal
    )
  ).session;
  const preview = (await service.run({ kind: 'preview', id: session.id, version: session.version }, signal)).preview;
  assert.ok(preview);
  session = (
    await service.run(
      { kind: 'publish', id: session.id, version: session.version, previewToken: preview.token, message: 'Resolve root' },
      signal
    )
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
  const restacking = createConflictResolutionService({ ...f.deps, read, dependents: () => urls });
  return {
    ...f,
    session,
    urls,
    run: (r: Parameters<typeof restacking.run>[0]) => restacking.run(r, new AbortController().signal),
  };
}
const nativeMergirafMissing = async (t: TestContext) => {
  if (await fs.stat(nativeMergiraf).catch(() => undefined)) return false;
  t.skip('Needs the Mergiraf binary: npm run prepare:mergiraf.');
  return true;
};
void test('a paused replay runs the pipeline: a PR whose conflicts the checks merge needs no Reviewed tick (#445)', async (t) => {
  if (await nativeMergirafMissing(t)) return;
  const f = await pipelineStack(t, { name: 'account.py', base: ACCOUNT, main: ACCOUNT + STATEMENT, child: ACCOUNT + WITHDRAW });
  const child = await f.git('rev-parse', 'child');
  // Preimages without a resolution: the root merge's own lookups leave some; the replay must add none.
  const memory = path.join(f.deps.directory(), 'resolution-memory');
  const orphans = async () => {
    const entries = await fs.readdir(memory, { recursive: true }).catch((): string[] => []);
    const resolved = (entry: string) =>
      entries.includes(path.join(path.dirname(entry), path.basename(entry).replace('preimage', 'postimage')));
    return entries.filter((entry) => path.basename(entry).startsWith('preimage') && !resolved(entry)).sort();
  };
  const before = await orphans();
  let { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'prepared', 'Nothing stops for you: both added methods are Merged');
  assert.deepEqual(
    session.restack.branches.map(({ merged, yours, reused, review }) => ({ merged, yours, reused, review })),
    [
      { merged: 1, yours: 0, reused: 0, review: false },
      { merged: 0, yours: 0, reused: 0, review: false },
    ],
    'PR 2 is Merged by the checks and PR 3 replays cleanly: neither needs a tick'
  );
  assert.equal(await f.git('rev-parse', 'child'), child, 'Preparation must not push');
  assert.deepEqual(await orphans(), before, 'The replay leaves no preimage of a result it settled');
  // The checks' result is not remembered as yours: Prepare again merges it again, rather than reusing it.
  session = (await f.run({ kind: 'restack-prepare', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.branches[0].reused, 0);
  assert.equal(session.restack.branches[0].merged, 1);
  await assert.rejects(
    f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: ['https://github.com/test/repo/pull/9'],
    }),
    /Review every/,
    'Only updates in the plan can be ticked'
  );
  session = (
    await f.run({ kind: 'restack-publish', id: session.id, version: session.version, previewToken: session.restack.token, reviewed: [] })
  ).session;
  assert.equal(session.restack?.status, 'published');
  assert.equal(await f.git('show', 'tip:account.py'), (ACCOUNT + STATEMENT + WITHDRAW).trimEnd());
  assert.equal(await f.git('show', 'tip:tip.txt'), 'tip change');
});
void test('a replayed conflict the checks leave in Check pauses the restack, and its PR needs its tick (#445)', async (t) => {
  if (await nativeMergirafMissing(t)) return;
  const imports = (extra: string) => `import { a } from './a';\n${extra}\nexport const x = a;\n`;
  const f = await pipelineStack(t, {
    name: 'imports.ts',
    base: imports(''),
    main: imports("import { b } from './b';\n"),
    child: imports("import { c } from './c';\n"),
  });
  let { session } = await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version });
  assert.equal(session.restack?.status, 'blocked');
  const [file] = session.restack.blocked?.files ?? [];
  assert.equal(file.path, 'imports.ts');
  assert.ok(file.proposals?.[0], 'Structural merge proposed both imports');
  assert.deepEqual(replayBuckets(file), ['check'], 'Order can matter for imports: Check, never Merged');
  // Fail closed: the proposal waits on its card; the paused draft keeps the conflict's markers until you choose.
  assert.ok(hasConflictMarkers(file.result));
  const used = imports("import { b } from './b';\nimport { c } from './c';\n");
  await assert.rejects(
    f.run({ kind: 'restack-save', id: session.id, version: session.version, path: 'imports.ts', contents: used, resolved: true }),
    /in Check first/,
    'An untouched proposal is never accepted by default'
  );
  session = (
    await f.run({
      kind: 'restack-save',
      id: session.id,
      version: session.version,
      path: 'imports.ts',
      contents: used,
      resolved: true,
      picks: ['proposal'],
    })
  ).session;
  session = (await f.run({ kind: 'restack-continue', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.status, 'prepared');
  assert.deepEqual(
    session.restack.branches.map(({ yours, review }) => ({ yours, review })),
    [
      { yours: 1, review: true },
      { yours: 0, review: false },
    ]
  );
  await assert.rejects(
    f.run({ kind: 'restack-publish', id: session.id, version: session.version, previewToken: session.restack.token, reviewed: [] }),
    /Review every/
  );
  session = (
    await f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: [f.urls[0]],
    })
  ).session;
  assert.equal(session.restack?.status, 'published');
  assert.equal(await f.git('show', 'tip:imports.ts'), used.trimEnd());
});
void test('a Continue that fails after Git moved on leaves a stale pause that is never written (#445)', async (t) => {
  const f = await stackedFixture(t, true);
  // PR 2 has a second commit that conflicts again, so Continue moves the replay to another paused step.
  await f.git('checkout', 'child');
  await fs.writeFile(path.join(f.deps.remote(), 'sample.ts'), 'export const answer = 6;\n');
  await f.git('commit', '-am', 'child change 2');
  await f.git('checkout', 'main');
  const child = await f.git('rev-parse', 'child');
  const deps = { ...f.deps, dependents: () => [f.urls[0]] };
  const service = createConflictResolutionService(deps);
  const run = (r: Parameters<typeof service.run>[0]) => service.run(r, new AbortController().signal);
  let session = (await run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version })).session;
  assert.equal(session.restack?.status, 'blocked');
  const paused = session.restack.blocked;
  assert.ok(paused?.commit && paused.head, 'The pause names its commit and HEAD');
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
  // Continue writes the first pause, Git moves on to the second commit, and the pipeline then fails.
  const mergiraf = deps.mergiraf;
  deps.mergiraf = () => {
    throw new Error('structural merge failed');
  };
  await assert.rejects(run({ kind: 'restack-continue', id: session.id, version: session.version }), /structural merge failed/);
  deps.mergiraf = mergiraf;
  assert.ok(session.restack);
  const worktree = await restackWorktreePath(
    await conflictSessionDirectory(f.deps.directory(), 'tester', session.id),
    session.restack.token
  );
  const before = await fs.readFile(path.join(worktree, 'sample.ts'), 'utf8');
  assert.match(before, /<{7}/, 'The worktree is paused on the second commit');
  // The stored plan still describes the first pause: a retry refuses and writes nothing.
  await assert.rejects(
    run({ kind: 'restack-continue', id: session.id, version: session.version }),
    /The replay moved on since this pause; prepare again/
  );
  assert.equal(await fs.stat(worktree).catch(() => undefined), undefined, 'The stale worktree is aborted and removed');
  assert.equal(await f.git('rev-parse', 'child'), child, 'Nothing was pushed');
  await assert.rejects(
    run({ kind: 'restack-continue', id: session.id, version: session.version }),
    /moved on since this pause/,
    'It keeps refusing'
  );
  // Prepare again starts over; your choice for the first commit still applies.
  session = (await run({ kind: 'restack-prepare', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.status, 'blocked');
  assert.notEqual(session.restack.blocked?.commit, paused.commit, 'It pauses on the second commit');
  const blocked = session.restack.blocked;
  assert.equal(
    (blocked?.reused ?? 0) + (blocked?.yours ?? 0),
    1,
    'Your choice for the first commit is reused (rerere recorded it when Continue committed it), as yours'
  );
});
void test('a partly carried file is built from its conflicts, not by splitting a draft again (#445)', () => {
  // Both conflicts and the line between them read the same: splitting a draft of them is ambiguous.
  const block = '<<<<<<< parent\nx\n||||||| base\ny\n=======\nz\n>>>>>>> pr\n';
  const original = `${block}x\n${block}`;
  assert.equal(composeCarried(original, ['x\n'], [null, { text: 'x\nz\n' }]), 'x\nx\nx\nz\n');
  assert.equal(composeCarried(original, [undefined, 'z\n'], undefined), `${block}x\nz\n`);
});
void test('a clean replay that recreates a merge commit still needs its tick (#445)', async (t) => {
  const f = await stackedFixture(t);
  // PR 2 gets a merge commit of its own: a side branch merged with --no-ff, which the replay recreates cleanly.
  await f.git('checkout', '-b', 'side', 'child');
  await fs.writeFile(path.join(f.deps.remote(), 'side.txt'), 'side change\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'side change');
  await f.git('checkout', 'child');
  await f.git('merge', '--no-ff', '-m', 'Merge side', 'side');
  await f.git('checkout', 'main');
  const service = createConflictResolutionService({ ...f.deps, dependents: () => [f.urls[0]] });
  const { session } = await service.run(
    { kind: 'restack-prepare', id: f.session.id, version: f.session.version },
    new AbortController().signal
  );
  assert.equal(session.restack?.status, 'prepared');
  const [branch] = session.restack.branches;
  assert.equal(branch.merges, 1);
  assert.equal(branch.merged, 0);
  assert.equal(branch.review, true, 'A recreated merge can lose what the original merge added');
  await assert.rejects(
    service.run(
      { kind: 'restack-publish', id: session.id, version: session.version, previewToken: session.restack.token, reviewed: [] },
      new AbortController().signal
    ),
    /Review every/
  );
});
void test('Prepare again that fails keeps the paused plan and your carried choices (#445)', async (t) => {
  const f = await stackedFixture(t, true);
  let session = (await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version })).session;
  session = (
    await f.run({
      kind: 'restack-save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: 'export const answer = 5;\n',
      resolved: true,
    })
  ).session;
  const dependents = f.deps.dependents;
  // A stack that names a PR twice: preparing throws after the old plan was set aside.
  f.deps.dependents = () => [f.urls[0], f.urls[0]];
  await assert.rejects(f.run({ kind: 'restack-prepare', id: session.id, version: session.version }), /single linear stack/);
  f.deps.dependents = dependents;
  session = (await f.run({ kind: 'open', url: f.state.url })).session;
  assert.equal(session.restack?.status, 'blocked', 'The paused plan comes back');
  assert.equal(session.restack.blocked?.files[0].result, 'export const answer = 5;\n');
  assert.equal(
    (session.restack as { carry?: unknown }).carry,
    undefined,
    'The carried choices stay in the main process, never in the reply'
  );
  // Its worktree is still there: Continue works.
  const continued = (await f.run({ kind: 'restack-continue', id: session.id, version: session.version })).session;
  assert.equal(continued.restack?.status, 'prepared');
  assert.equal(continued.restack.branches[0].yours, 1);
});
void test('your choice in a paused replay carries to the same conflict after Prepare again, as yours (#445)', async (t) => {
  const f = await stackedFixture(t, true);
  let session = (await f.run({ kind: 'restack-prepare', id: f.session.id, version: f.session.version })).session;
  assert.equal(session.restack?.status, 'blocked');
  session = (
    await f.run({
      kind: 'restack-save',
      id: session.id,
      version: session.version,
      path: 'sample.ts',
      contents: 'export const answer = 5;\n',
      resolved: true,
      picks: [null],
    })
  ).session;
  // Prepare again replaces the paused plan: Git's rerere has not recorded the choice, the carry has.
  session = (await f.run({ kind: 'restack-prepare', id: session.id, version: session.version })).session;
  assert.equal(session.restack?.status, 'prepared', 'The carried choice settles the conflict: nothing stops');
  assert.deepEqual(
    session.restack.branches.map(({ merged, yours, reused, review }) => ({ merged, yours, reused, review })),
    [
      { merged: 0, yours: 1, reused: 0, review: true },
      { merged: 0, yours: 0, reused: 0, review: false },
    ],
    'A carried choice is yours, never Merged: its PR needs its tick'
  );
  await assert.rejects(
    f.run({ kind: 'restack-publish', id: session.id, version: session.version, previewToken: session.restack.token, reviewed: [] }),
    /Review every/
  );
  session = (
    await f.run({
      kind: 'restack-publish',
      id: session.id,
      version: session.version,
      previewToken: session.restack.token,
      reviewed: [f.urls[0]],
    })
  ).session;
  assert.equal(await f.git('show', 'tip:sample.ts'), 'export const answer = 5;');
  assert.equal(f.deps.storage.read(`conflict-restack-carry:tester:${session.id}`), null, 'Publishing clears the carry');
});
void test('replay buckets fail closed: only an unchanged, checked proposal is Merged', () => {
  const original = '<<<<<<< HEAD\na\n||||||| base\nx\n=======\nb\n>>>>>>> pr\n';
  const file: ConflictFile = {
    path: 'f.ts',
    mode: '100644',
    base: 'x\n',
    ours: 'a\n',
    theirs: 'b\n',
    original,
    result: 'a\nb\n',
    resolved: false,
    source: 'mergiraf',
    proposals: [{ source: 'union', text: 'a\nb\n' }],
  };
  assert.deepEqual(replayBuckets(file), ['check'], 'No verdict yet');
  const merged = { ...file, verdict: { key: '', verdict: { merged: true, note: '', blocks: [{ merged: true, note: '' }] } } };
  assert.deepEqual(replayBuckets(merged), ['merged']);
  assert.deepEqual(replayBuckets({ ...merged, result: 'b\na\n' }), ['decide'], 'A text the pipeline did not write');
  assert.deepEqual(replayBuckets({ ...merged, result: original }), ['check'], 'Open, its proposal waits on the card');
  assert.deepEqual(replayBuckets(merged, [0]), ['yours'], 'Carried is yours, even where a proposal passed');
  assert.deepEqual(replayBuckets({ ...merged, unsupported: 'binary' }), ['decide']);
});
/**
 * A 4-PR stack whose root (PR 1, feature) is resolved but not pushed (#445 item 22). Above it: PR 2 (child) adds a
 * method where main added another, which the checks merge; PR 3 (mid) changes the line PR 1 resolved, a new Decide;
 * PR 4 (tip) adds a file through a merge commit of its own.
 */
async function cascadeStack(t: TestContext) {
  const f = await fixture(t, false, undefined, [{ name: 'account.py', base: ACCOUNT, ours: ACCOUNT, theirs: ACCOUNT + STATEMENT }]);
  Object.assign(f.deps, {
    verify: (checked: ConflictFile, off: SyntaxLanguage[]) => conflictChecker(movedEngine, off)(checked),
    moved: (checked: ConflictFile, off: SyntaxLanguage[]) => moveProposer(movedEngine, off)(checked),
  });
  const remote = f.deps.remote();
  const commit = async (branch: string, from: string, name: string, text: string) => {
    await f.git('checkout', '-b', branch, from);
    await fs.writeFile(path.join(remote, name), text);
    await f.git('add', '.');
    await f.git('commit', '-m', `${branch} change`);
  };
  await commit('child', 'feature', 'account.py', ACCOUNT + WITHDRAW);
  await commit('mid', 'child', 'sample.ts', 'export const answer = 4;\n');
  await commit('side', 'mid', 'tip.txt', 'tip change\n');
  await f.git('checkout', '-b', 'tip', 'mid');
  await f.git('merge', '--no-ff', '-m', 'Merge side', 'side');
  await f.git('checkout', 'main');
  const urls = [2, 3, 4].map((n) => `https://github.com/test/repo/pull/${n}`);
  /** Holds the dry run inside its replay, at its read of the dependent PRs, until released. */
  let gate: { reached: () => void; open: Promise<void> } | undefined;
  const hold = () => {
    let release = () => {};
    let reached = () => {};
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    gate = { reached, open: new Promise<void>((resolve) => (release = resolve)) };
    return {
      arrived,
      release: () => {
        gate = undefined;
        release();
      },
    };
  };
  const read = async (url: string) => {
    const index = [f.state.url, ...urls].indexOf(url);
    // Another PR of the same repository, on the same branches.
    if (index < 0) return { ...f.state, url };
    if (index === 1 && gate) {
      gate.reached();
      await gate.open;
    }
    const branch = ['feature', 'child', 'mid', 'tip'][index],
      baseBranch = ['main', 'feature', 'child', 'mid'][index];
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
  const signal = new AbortController().signal;
  let session = (await service.run({ kind: 'open', url: f.state.url, restart: true }, signal)).session;
  session = (
    await service.run(
      { kind: 'save', id: session.id, version: session.version, path: 'sample.ts', contents: 'export const answer = 3;\n', resolved: true },
      signal
    )
  ).session;
  const cache = await conflictSessionDirectory(f.deps.directory(), 'tester', session.id);
  /** Every ref in the remote and in the session's repository, the session's worktrees, and restack directories. */
  const refs = async () => ({
    remote: await f.git('for-each-ref', '--format=%(refname) %(objectname)'),
    cache: (await exec('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: cache })).stdout,
    worktrees: (await exec('git', ['worktree', 'list', '--porcelain'], { cwd: cache })).stdout,
    restacks: (await fs.readdir(cache)).filter((name) => name.startsWith('restack-')),
  });
  return { ...f, deps, service, session, urls, refs, cache, hold };
}
void test('the cascade preview dry-runs the stack before the push and changes nothing (#445 item 22)', async (t) => {
  if (await nativeMergirafMissing(t)) return;
  const f = await cascadeStack(t);
  const before = await f.refs();
  const memory = path.join(f.deps.directory(), 'resolution-memory');
  const memoryFiles = async () => (await fs.readdir(memory, { recursive: true }).catch((): string[] => [])).sort();
  const remembered = await memoryFiles();
  const signal = new AbortController().signal;
  let preview = await f.service.previewCascade(f.session.id, f.session.version, signal);
  assert.ok(preview);
  assert.deepEqual(
    preview.prs.map(({ outcome, conflicts, merges, review }) => ({ outcome, conflicts, merges, review })),
    [
      { outcome: 'merged', conflicts: undefined, merges: 0, review: false },
      { outcome: 'conflicts', conflicts: 1, merges: 0, review: true },
      { outcome: 'waiting', conflicts: undefined, merges: 0, review: true },
    ],
    'PR 2 is Merged by the checks, PR 3 stops on a Decide, and PR 4 waits for it'
  );
  assert.equal(cascadeSentence(preview), 'Resolving #1 also settles #2. #3 has 1 new conflict. #4 waits for #3.');
  assert.deepEqual(await f.refs(), before, 'No ref or branch changes, and the private worktree is gone');
  assert.deepEqual(await memoryFiles(), remembered, 'Nothing is remembered: no preimage, no resolution');
  const saved = f.deps.storage.read(`conflict-draft:tester:${f.session.id}`) as ConflictSession;
  assert.equal(saved.version, f.session.version, 'The draft is unchanged');
  assert.equal(saved.status, 'editing');
  assert.equal(saved.restack, undefined);
  assert.equal(saved.commitSha, undefined);

  // Your choice for PR 3's conflict, carried as in a restack (matched on the conflict's text, not its labels): PR 3 is
  // settled by it, and PR 4 replays.
  const conflict = '<<<<<<< parent\nexport const answer = 3;\n||||||| base\nexport const answer = 1;\n=======\nexport const answer = 4;\n>>>>>>> pr\n';
  f.deps.storage.write(`conflict-restack-carry:tester:${f.session.id}`, [
    { path: 'sample.ts', mode: '', base: '', ours: '', theirs: '', original: conflict, result: 'export const answer = 5;\n', resolved: true, source: 'manual' },
  ]);
  preview = await f.service.previewCascade(f.session.id, f.session.version, signal);
  assert.ok(preview);
  assert.deepEqual(
    preview.prs.map(({ outcome, merges, review }) => ({ outcome, merges, review })),
    [
      { outcome: 'merged', merges: 0, review: false },
      { outcome: 'carried', merges: 0, review: true },
      { outcome: 'clean', merges: 1, review: true },
    ],
    'A carried choice is yours, and a recreated merge commit still needs its tick'
  );
  assert.equal(cascadeSentence(preview), 'Resolving #1 also settles #2, #3 and #4.');
  assert.deepEqual(await f.refs(), before);
  assert.deepEqual(await memoryFiles(), remembered);
  await assert.rejects(f.service.previewCascade(f.session.id, f.session.version + 1, signal), /resolution changed/);

  // The restack after the push decides by the same rule: PR 2 needs no tick, and PR 3 stops for you.
  f.deps.storage.write(`conflict-restack-carry:tester:${f.session.id}`, null);
  const run = (r: Parameters<typeof f.service.run>[0]) => f.service.run(r, signal);
  const shown = (await run({ kind: 'preview', id: f.session.id, version: f.session.version })).preview;
  assert.ok(shown);
  const pushed = (
    await run({ kind: 'publish', id: f.session.id, version: f.session.version, previewToken: shown.token, message: 'Resolve root' })
  ).session;
  const restack = (await run({ kind: 'restack-prepare', id: pushed.id, version: pushed.version })).session.restack;
  assert.equal(restack?.status, 'blocked');
  assert.deepEqual(
    restack.branches.map(({ url, review }) => ({ url, review })),
    [{ url: f.urls[0], review: false }]
  );
  assert.equal(restack.blocked?.url, f.urls[1]);
});
void test('a request of yours stops a running cascade preview, which gives way (#445 item 22)', async (t) => {
  const f = await cascadeStack(t);
  const before = await f.refs();
  const running = f.service.previewCascade(f.session.id, f.session.version, new AbortController().signal);
  const { session } = await f.service.run(
    { kind: 'save', id: f.session.id, version: f.session.version, path: 'sample.ts', contents: 'export const answer = 7;\n', resolved: true },
    new AbortController().signal
  );
  await assert.rejects(running, (error: Error) => error.message === BACKGROUND_YIELDED);
  assert.equal(session.version, f.session.version + 1, 'Your save went through');
  assert.deepEqual(await f.refs(), before, 'The stopped run removed its worktree and changed no ref');
  // Nothing to preview while the draft has a file that isn't reviewed.
  const open = (
    await f.service.run(
      { kind: 'save', id: session.id, version: session.version, path: 'sample.ts', contents: 'export const answer = 7;\n', resolved: false },
      new AbortController().signal
    )
  ).session;
  await assert.rejects(f.service.previewCascade(open.id, open.version, new AbortController().signal), /every file reviewed/);
});
void test('a running cascade preview never holds the resolution memory: other PRs of the repository open (#445 item 22)', async (t) => {
  const f = await cascadeStack(t);
  const held = f.hold();
  const running = f.service.previewCascade(f.session.id, f.session.version, new AbortController().signal);
  await held.arrived;
  // The preview is inside its replay. Opening another PR of the repository uses the resolution memory.
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The open waited for the preview')), 20_000).unref());
  const other = await Promise.race([
    f.service.run({ kind: 'open', url: 'https://github.com/test/repo/pull/9' }, new AbortController().signal),
    timeout,
  ]);
  assert.equal(other.session.files.length, 1);
  held.release();
  assert.ok(await running);
  // The repository uses the shared memory again, and the private copy is gone.
  const link = await fs.readlink(path.join(f.cache, 'rr-cache'));
  assert.equal(path.dirname(path.resolve(f.cache, link)), path.join(f.deps.directory(), 'resolution-memory'));
  assert.deepEqual((await fs.readdir(f.cache)).filter((name) => name.startsWith('rr-cache-preview-')), []);
});
void test('startup cleanup removes a dry run left by a quit, and restores the resolution memory (#445 item 22)', async (t) => {
  if (await nativeMergirafMissing(t)) return;
  const f = await cascadeStack(t);
  assert.ok(await f.service.previewCascade(f.session.id, f.session.version, new AbortController().signal));
  const before = await f.refs();
  // As a quit would leave it: a dry-run worktree, and rr-cache pointing at a private copy.
  const leftover = path.join(f.cache, `restack-${'e'.repeat(16)}`);
  await exec('git', ['worktree', 'add', '--detach', leftover, f.session.headSha], { cwd: f.cache });
  const shared = await fs.readlink(path.join(f.cache, 'rr-cache'));
  const copy = path.join(f.cache, 'rr-cache-preview-0123456789abcdef');
  await fs.cp(path.resolve(f.cache, shared), copy, { recursive: true });
  await fs.unlink(path.join(f.cache, 'rr-cache'));
  await fs.symlink(copy, path.join(f.cache, 'rr-cache'));
  Object.assign(f.deps.storage, { names: () => [`conflict-draft:tester:${f.session.id}`] });
  await f.service.maintain();
  assert.equal(await fs.stat(leftover).catch(() => undefined), undefined, 'The leftover worktree is gone');
  assert.equal(await fs.stat(copy).catch(() => undefined), undefined, 'So is the memory copy');
  // A full-history draft cache goes whole at startup (it is rebuilt); a shared-store one stays, cleaned.
  if (await fs.stat(f.cache).catch(() => undefined)) {
    assert.deepEqual(await f.refs(), before, 'Git no longer lists the worktree');
    assert.equal(path.resolve(f.cache, await fs.readlink(path.join(f.cache, 'rr-cache'))), path.resolve(f.cache, shared));
  } else assert.equal(process.env.GNOSIS_TEST_CONFLICT_SHALLOW, undefined);
  // The draft still previews.
  assert.ok(await f.service.previewCascade(f.session.id, f.session.version, new AbortController().signal));
});
void test('a wait for the resolution memory stops on abort, and never lets two tasks run at once (#445 item 22)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-memory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const memory = createConflictMemory(() => dir);
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  let release = () => {};
  let running = 0;
  let most = 0;
  let started = () => {};
  const holds = new Promise<void>((resolve) => (started = resolve));
  const holding = memory.withRepository('scope', repo, async () => {
    running++;
    await new Promise<void>((resolve) => {
      release = resolve;
      started();
    });
    running--;
  });
  await holds;
  const controller = new AbortController();
  const waiting = memory.snapshot('scope', repo, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/, 'The wait stops at once, while the lock is still held');
  const after = memory.withRepository('scope', repo, () => {
    most = Math.max(most, ++running);
    running--;
    return Promise.resolve();
  });
  release();
  await holding;
  await after;
  assert.equal(most, 1, 'The next task ran only after the first let go');
  assert.deepEqual((await fs.readdir(repo)).filter((name) => name.startsWith('rr-cache-preview-')), []);
});

// Undo this update (#445 item 25): the previous head goes back with a lease on the merge commit.
async function undoFixture(t: TestContext, allowUndo: ((repo: string) => boolean) | null = () => true) {
  const f = await fixture(t);
  const saved = (
    await f.run({
      kind: 'save',
      id: f.session.id,
      version: f.session.version,
      path: 'sample.ts',
      contents: 'export const answer = 1;\n',
      resolved: true,
      picks: ['ours'],
    })
  ).session;
  const { preview } = await f.run({ kind: 'preview', id: saved.id, version: saved.version });
  assert.ok(preview);
  const pushed = (await f.run({ kind: 'publish', id: saved.id, version: saved.version, previewToken: preview.token, message: 'Resolve' })).session;
  const previous = f.state.headSha;
  const merge = await f.git('rev-parse', 'feature');
  assert.equal(pushed.commitSha, merge);
  f.state.headSha = merge;
  // null: the setting is not wired at all.
  const service = createConflictResolutionService({ ...f.deps, ...(allowUndo ? { allowUndo } : {}) });
  const undo = (report?: (text: string) => void) =>
    service.run({ kind: 'undo-publish', id: pushed.id, version: pushed.version }, new AbortController().signal, report);
  /** Someone pushes a commit on top of the merge commit. */
  const pushOnTop = () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.remote }).toString().trim();
    git('checkout', '-q', 'feature');
    writeFileSync(path.join(f.remote, 'ci.txt'), 'Formatted by CI.\n');
    git('add', 'ci.txt');
    git('commit', '-qm', 'CI formatting');
    git('checkout', '-q', 'main');
    return git('rev-parse', 'feature');
  };
  const draft = () =>
    f.deps.storage.read(`conflict-draft:tester:${pushed.id}`) as { status: string; commitSha?: string; undoing?: boolean };
  return { ...f, service, undo, pushed, previous, merge, pushOnTop, draft };
}
void test('undo after a push moves the branch back to its previous head, and the draft is editable with its picks', async (t) => {
  const f = await undoFixture(t);
  assert.deepEqual(f.service.pushed(f.state.url, f.merge), {
    id: f.pushed.id,
    version: f.pushed.version,
    url: f.state.url,
    headRepo: 'test/repo',
    baseRepo: 'test/repo',
    headBranch: 'feature',
    baseBranch: 'main',
    headSha: f.previous,
    commitSha: f.merge,
  });
  assert.equal(f.service.pushed(f.state.url, f.previous), undefined, 'Only while the merge commit is the head');
  const steps: string[] = [];
  const { session } = await f.undo((text) => steps.push(text));
  assert.equal(await f.git('rev-parse', 'feature'), f.previous, 'The remote branch is back at the previous head');
  assert.equal(session.status, 'editing');
  assert.equal(session.commitSha, undefined);
  assert.equal(session.undoing, undefined);
  assert.equal(session.headSha, f.previous);
  assert.deepEqual(session.files[0].picks, ['ours'], 'Your choices are intact');
  assert.equal(session.files[0].resolved, true);
  assert.equal(session.files[0].result, 'export const answer = 1;\n');
  assert.ok(steps.some((step) => step.startsWith('Checking that the merge commit')));
  assert.equal(f.service.pushed(f.state.url, f.merge), undefined, 'Nothing left to undo');
  // GitHub sees the old head again: the reopened draft is the same, and it can be fixed and pushed again.
  f.state.headSha = f.previous;
  const signal = new AbortController().signal;
  const reopened = (await f.service.run({ kind: 'open', url: f.state.url }, signal)).session;
  assert.equal(reopened.status, 'editing');
  assert.equal(reopened.stale, false);
  assert.deepEqual(reopened.files[0].picks, ['ours']);
  const fixed = (
    await f.service.run(
      { kind: 'save', id: reopened.id, version: reopened.version, path: 'sample.ts', contents: 'export const answer = 3;\n', resolved: true },
      signal
    )
  ).session;
  const { preview } = await f.service.run({ kind: 'preview', id: fixed.id, version: fixed.version }, signal);
  assert.ok(preview);
  const again = (
    await f.service.run(
      { kind: 'publish', id: fixed.id, version: fixed.version, previewToken: preview.token, message: 'Resolve again' },
      signal
    )
  ).session;
  assert.equal(again.status, 'published');
  assert.equal(await f.git('show', 'feature:sample.ts'), 'export const answer = 3;');
  assert.equal(await f.git('rev-parse', 'feature^1'), f.previous);
});
void test('undo is refused when someone pushed after the merge commit, and nothing changes', async (t) => {
  const f = await undoFixture(t);
  // GitHub's read lags, but the remote has a new commit: the live read refuses before any push.
  const top = f.pushOnTop();
  await assert.rejects(f.undo(), /New commits are on the PR branch/);
  assert.equal(await f.git('rev-parse', 'feature'), top);
  // GitHub reports the new head: refused too.
  f.state.headSha = top;
  await assert.rejects(f.undo(), /New commits are on the PR branch/);
  assert.equal(await f.git('rev-parse', 'feature'), top);
  assert.equal(f.draft().status, 'published');
  assert.equal(f.draft().commitSha, f.merge);
  assert.equal(f.draft().undoing, undefined);
});
void test('undo of a merged or closed PR, or a deleted branch, says so, even when the branch moved', async (t) => {
  const f = await undoFixture(t);
  const top = f.pushOnTop();
  f.state.state = 'MERGED';
  await assert.rejects(f.undo(), (error: Error) => error.message === undoCopy.UNDO_CLOSED);
  assert.equal(await f.git('rev-parse', 'feature'), top, 'Nothing was pushed');
  f.state.state = 'OPEN';
  await f.git('update-ref', '-d', 'refs/heads/feature');
  await assert.rejects(f.undo(), (error: Error) => error.message === undoCopy.UNDO_CLOSED);
  assert.equal(f.draft().undoing, undefined);
});
void test('undo: the lease refuses a push that lands between the live read and the force push', async (t) => {
  const f = await undoFixture(t);
  let top = '';
  // Right before the push, CI pushes on top. The lease on the merge commit refuses the force push.
  const raced = f.undo((text) => {
    if (text.startsWith('Moving ')) top = f.pushOnTop();
  });
  await assert.rejects(raced, (error: Error) => {
    assert.equal(error.message, undoCopy.UNDO_MOVED);
    assert.equal(undoCopy.describeUndoError(error.message, { headBranch: 'feature', headRepo: 'a/b', headSha: 'aaaaaaaaaa' }).title, 'feature has new commits after the merge commit.');
    return true;
  });
  assert.ok(top);
  assert.equal(await f.git('rev-parse', 'feature'), top, 'The commit on top stays');
  assert.equal(f.draft().status, 'published');
  assert.equal(f.draft().undoing, undefined, 'A refused undo leaves the update as it was');
});
void test('undo is refused when the repository does not allow it, when the PR closed, or after a restack', async (t) => {
  for (const allow of [null, () => false]) {
    const f = await undoFixture(t, allow);
    await assert.rejects(f.undo(), (error: Error) => error.message === undoCopy.UNDO_OFF);
    assert.equal(await f.git('rev-parse', 'feature'), f.merge, 'Nothing was pushed');
  }
  const f = await undoFixture(t);
  for (const state of ['MERGED', 'CLOSED'] as const) {
    f.state.state = state;
    await assert.rejects(f.undo(), (error: Error) => error.message === undoCopy.UNDO_CLOSED);
  }
  assert.equal(await f.git('rev-parse', 'feature'), f.merge);
  f.state.state = 'OPEN';
  const key = `conflict-draft:tester:${f.pushed.id}`;
  f.deps.storage.write(key, {
    ...(f.deps.storage.read(key) as object),
    restack: { token: 't', status: 'published', rootSha: f.merge, expected: [], branches: [] },
  });
  assert.equal(f.service.pushed(f.state.url, f.merge), undefined, 'A restacked push offers no undo');
  await assert.rejects(f.undo(), (error: Error) => error.message === undoCopy.UNDO_RESTACKED);
  assert.equal(await f.git('rev-parse', 'feature'), f.merge);
});
void test('undo shows GitHub’s message when branch protection refuses the force push', async (t) => {
  const f = await undoFixture(t);
  await fs.writeFile(
    path.join(f.remote, '.git', 'hooks', 'pre-receive'),
    '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/feature." >&2\necho "error: Cannot force-push to this branch" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  await assert.rejects(f.undo(), (error: Error) => {
    const copy = undoCopy.describeUndoError(error.message, { headBranch: 'feature', headRepo: 'a/b', headSha: 'aaaaaaaaaa' });
    assert.equal(copy.title, 'GitHub refused to rewrite feature.');
    assert.match(
      copy.body ?? '',
      /GitHub says: “GH006: Protected branch update failed for refs\/heads\/feature\. Cannot force-push to this branch”/
    );
    return true;
  });
  assert.equal(await f.git('rev-parse', 'feature'), f.merge);
  assert.equal(f.draft().status, 'published');
  assert.equal(f.draft().undoing, undefined);
});
void test('reopening finishes an undo whose reply was lost, or drops it when the push never landed', async (t) => {
  const f = await undoFixture(t);
  const key = `conflict-draft:tester:${f.pushed.id}`;
  const signal = new AbortController().signal;
  // The push never landed: the merge commit is still the head, and the update stays.
  f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  Object.assign(f.state, { mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
  const kept = (await f.service.run({ kind: 'open', url: f.state.url }, signal)).session;
  assert.equal(kept.status, 'published');
  assert.equal(kept.undoing, undefined);
  // It landed: GitHub reports the previous head, and the draft is editable with its picks.
  f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  await f.git('update-ref', 'refs/heads/feature', f.previous);
  Object.assign(f.state, { headSha: f.previous, mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const finished = (await f.service.run({ kind: 'open', url: f.state.url }, signal)).session;
  assert.equal(finished.status, 'editing');
  assert.equal(finished.commitSha, undefined);
  assert.deepEqual(finished.files[0].picks, ['ours']);
});
void test('undo copy and settings: off unless set, and the request validates', () => {
  validateConflictRequest({ kind: 'undo-publish', id: 'a'.repeat(64), version: 3 });
  assert.throws(() => validateConflictRequest({ kind: 'undo-publish', id: 'nope', version: 3 }));
  assert.equal(undoCopy.undoAllowed(undefined), false);
  assert.equal(undoCopy.undoAllowed({}), false);
  assert.equal(undoCopy.undoAllowed({ allowConflictUndo: true }), true);
  assert.deepEqual(
    normalizeRepositorySettings({
      'a/b': { allowConflictUndo: true },
      'c/d': { allowConflictUndo: 'yes' },
      'e/f': { allowConflictUndo: false },
    }),
    { 'a/b': { allowConflictUndo: true } }
  );
  assert.equal(
    undoCopy.remoteMessage('To github.com:a/b.git\nremote: error: GH006: Protected branch update failed.\nremote: \n ! [remote rejected]'),
    'GH006: Protected branch update failed.'
  );
  assert.equal(
    undoCopy.describeUndoError(`Error invoking remote method 'conflict-resolution': Error: ${undoCopy.UNDO_OFF}`, { headBranch: 'x', headRepo: 'a/b', headSha: 'aaaaaaaaaa' }).title,
    undoCopy.UNDO_OFF
  );
  assert.match(undoCopy.describeUndoError('Git could not complete this operation. fatal: unable to access', { headBranch: 'x', headRepo: 'a/b', headSha: 'aaaaaaaaaa' }).title, /lost the connection/);
  // No revert to paste: a refusal names the safe way left, a reset by someone who may force-push, and links the docs.
  const refused = undoCopy.describeUndoError('remote: error: GH006: Protected branch update failed', { headBranch: 'x', headRepo: 'a/b', headSha: 'aaaaaaaaaa' });
  assert.match(refused.body ?? '', /Ask the PR’s author, or someone who can push to a\/b, to reset x to aaaaaaa\.$/);
  assert.equal(refused.docs, true);
  const moved = undoCopy.describeUndoError(undoCopy.UNDO_MOVED, { headBranch: 'x', headRepo: 'a/b', headSha: 'aaaaaaaaaa' });
  assert.doesNotMatch(`${moved.title} ${moved.body}`, /revert|reset x to/i);
  assert.equal(undoCopy.describeUndoError(undoCopy.UNDO_CLOSED, { headBranch: 'x', headRepo: 'a/b', headSha: 'aaaaaaaaaa' }).docs, false);
  assert.doesNotMatch(undoCopy.UNDO_OFF, /revert/i);
});
void test('undo works after startup cleanup removed the PR’s private cache', async (t) => {
  const f = await undoFixture(t);
  await fs.rm(await conflictSessionDirectory(f.deps.directory(), 'tester', f.pushed.id), { recursive: true, force: true });
  const { session } = await f.undo();
  assert.equal(session.status, 'editing');
  assert.equal(await f.git('rev-parse', 'feature'), f.previous);
});
void test('an interrupted undo is settled from the remote, never from GitHub’s lagging read, and never in the background', async (t) => {
  const f = await undoFixture(t);
  const key = `conflict-draft:tester:${f.pushed.id}`;
  const signal = new AbortController().signal;
  const pending = () => f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  // Background preparation, even with GitHub reporting conflicts, leaves a pending undo and its draft alone.
  pending();
  Object.assign(f.state, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const before = JSON.stringify(f.deps.storage.read(key));
  await f.service.prepareInBackground(f.state.url, signal);
  assert.equal(JSON.stringify(f.deps.storage.read(key)), before, 'The background never replaces or settles it');
  // The undo landed, but GitHub still reports the merge commit: the remote decides, and the draft is editable.
  await f.git('update-ref', 'refs/heads/feature', f.previous);
  const landed = (await f.service.run({ kind: 'open', url: f.state.url }, signal)).session;
  assert.equal(landed.status, 'editing');
  assert.equal(landed.stale, false, 'Not mistaken for someone else’s push');
  assert.deepEqual(landed.files[0].picks, ['ours']);
});
void test('an interrupted undo whose branch is at neither commit keeps the draft and says so', async (t) => {
  const f = await undoFixture(t);
  const key = `conflict-draft:tester:${f.pushed.id}`;
  f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  // Someone moved the branch to a commit on the old head: neither the merge commit nor the commit before it.
  const top = await f.git('commit-tree', `${f.previous}^{tree}`, '-p', f.previous, '-m', 'Someone else');
  await f.git('update-ref', 'refs/heads/feature', top);
  Object.assign(f.state, { headSha: top, mergeable: 'MERGEABLE', mergeState: 'CLEAN' });
  const kept = (await f.service.run({ kind: 'open', url: f.state.url }, new AbortController().signal)).session;
  assert.equal(kept.status, 'published');
  assert.equal(kept.undoing, true, 'Still pending');
  assert.equal(kept.undoUnsettled, 'elsewhere', 'The branch was read: it is at another commit');
  assert.deepEqual(kept.files[0].picks, ['ours']);
  assert.equal(undoCopy.undoTarget(kept), undefined, 'No undo is offered while one is unsettled');
  assert.equal(await f.git('rev-parse', 'feature'), top);
  // The way out: start over from the branch as it is, with your resolutions carried. Nothing is pushed.
  const signal = new AbortController().signal;
  Object.assign(f.state, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const fresh = (await f.service.run({ kind: 'open', url: f.state.url, restart: true, keep: true }, signal)).session;
  assert.equal(fresh.status, 'editing');
  assert.equal(fresh.undoing, undefined);
  assert.equal(fresh.headSha, top);
  assert.deepEqual(fresh.files[0].picks, ['ours'], 'Your choices carry onto the fresh preparation');
  assert.equal(await f.git('rev-parse', 'feature'), top, 'Nothing was pushed');
});
void test('an unsettled undo whose branch can’t be read says so, and can be discarded without a push', async (t) => {
  const f = await undoFixture(t);
  const key = `conflict-draft:tester:${f.pushed.id}`;
  f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  const unreadable = createConflictResolutionService({ ...f.deps, remote: () => path.join(f.remote, 'missing') });
  const signal = new AbortController().signal;
  const kept = (await unreadable.run({ kind: 'open', url: f.state.url }, signal)).session;
  assert.equal(kept.undoing, true);
  assert.equal(kept.undoUnsettled, 'unread');
  assert.match(undoCopy.unsettledUndoCopy('unread', 'feature'), /^Gnosis couldn’t read feature/);
  assert.match(undoCopy.unsettledUndoCopy('elsewhere', 'feature'), /^feature is at another commit/);
  await unreadable.run({ kind: 'discard', id: kept.id, version: kept.version }, signal);
  assert.equal(f.deps.storage.read(key), null);
  assert.equal(await f.git('rev-parse', 'feature'), f.merge, 'Nothing was pushed');
});
void test('undo trusts the remote, not GitHub’s lagging head, and matches the exact branch ref', async (t) => {
  const f = await undoFixture(t);
  // GitHub still reports the old head right after the push; the remote is at the merge commit: the undo goes ahead.
  f.state.headSha = f.previous;
  const { session } = await f.undo();
  assert.equal(session.status, 'editing');
  assert.equal(await f.git('rev-parse', 'feature'), f.previous);
});
void test('undo reads only the branch’s own ref when another ref ends the same way', async (t) => {
  const f = await undoFixture(t);
  // ls-remote matches `refs/heads/feature` as a suffix: this ref sorts first and points elsewhere.
  await f.git('update-ref', 'refs/heads/a/refs/heads/feature', f.previous);
  const { session } = await f.undo();
  assert.equal(session.status, 'editing');
  assert.equal(await f.git('rev-parse', 'refs/heads/feature'), f.previous);
});
void test('a retried undo after a lost reply finishes the undo that landed', async (t) => {
  const f = await undoFixture(t);
  const key = `conflict-draft:tester:${f.pushed.id}`;
  f.deps.storage.write(key, { ...(f.deps.storage.read(key) as object), undoing: true });
  await f.git('update-ref', 'refs/heads/feature', f.previous);
  f.state.headSha = f.previous;
  const { session } = await f.undo();
  assert.equal(session.status, 'editing');
  assert.equal(session.undoing, undefined);
  assert.deepEqual(session.files[0].picks, ['ours']);
  assert.equal(await f.git('rev-parse', 'feature'), f.previous);
});
void test('undo is refused while any restack plan exists, and pushed() is cached per head', async (t) => {
  const f = await undoFixture(t);
  assert.ok(f.service.pushed(f.state.url, f.merge));
  const key = `conflict-draft:tester:${f.pushed.id}`;
  let reads = 0;
  const read = f.deps.storage.read;
  const counting = createConflictResolutionService({
    ...f.deps,
    allowUndo: () => true,
    storage: { ...f.deps.storage, read: (name: string) => (reads++, read(name)) },
  });
  counting.pushed(f.state.url, f.merge);
  counting.pushed(f.state.url, f.merge);
  assert.equal(reads, 1, 'One draft read per head');
  for (const status of ['prepared', 'blocked'] as const) {
    f.deps.storage.write(key, {
      ...(f.deps.storage.read(key) as object),
      restack: { token: 'a'.repeat(64), status, rootSha: f.merge, expected: [], branches: [] },
    });
    // A new service: the first one's cache has not seen this write, which went around it.
    const service = createConflictResolutionService({ ...f.deps, allowUndo: () => true });
    assert.equal(service.pushed(f.state.url, f.merge), undefined);
    await assert.rejects(
      service.run({ kind: 'undo-publish', id: f.pushed.id, version: f.pushed.version }, new AbortController().signal),
      (error: Error) => error.message === undoCopy.UNDO_RESTACKED
    );
  }
  assert.equal(await f.git('rev-parse', 'feature'), f.merge);
});

// Fail closed: a proposal nobody chose stays in the draft only when the checks Merged it.
void test('an untouched Check proposal is never in the pushed text and never counts as yours; a suggestion never overrides a Keep', async (t) => {
  if (await nativeMergirafMissing(t)) return;
  const f = await fixture(t, false, jsonSample);
  const prepared = f.session.files[0];
  const proposal = prepared.proposals?.[0];
  assert.ok(proposal, 'Structural merge proposed the conflict');
  // The checks don't Merge it: on the next open the draft has the conflict's markers back; the proposal waits on its card.
  Object.assign(f.deps, { verify: () => Promise.resolve({ merged: false, note: 'Check the order.' }) });
  let { session } = await f.run({ kind: 'open', url: f.state.url, restart: true });
  let file = session.files[0];
  assert.ok(hasConflictMarkers(file.result));
  assert.deepEqual(file.proposals?.map((p) => p?.text), [proposal.text]);
  assert.deepEqual(blockBuckets(file, file.result, file.verdict?.verdict), ['check']);
  assert.deepEqual(unchosenConflicts(file, file.result, file.verdict?.verdict), [0]);
  // Its text without your choice is refused as reviewed, so it can never reach the push as "You decided".
  await assert.rejects(
    f.run({ kind: 'save', id: session.id, version: session.version, path: file.path, contents: proposal.text, resolved: true }),
    /in Check first/
  );
  await assert.rejects(f.run({ kind: 'preview', id: session.id, version: session.version }), /every file reviewed/);
  // A save that puts it back unchosen is taken back by the checks: it is never left in the draft.
  session = (
    await f.run({ kind: 'save', id: session.id, version: session.version, path: file.path, contents: proposal.text, resolved: false })
  ).session;
  assert.ok(hasConflictMarkers(session.files[0].result));
  // Use the proposal: yours, and then it is what is pushed.
  session = (
    await f.run({
      kind: 'save',
      id: session.id,
      version: session.version,
      path: file.path,
      contents: proposal.text,
      resolved: true,
      picks: ['proposal'],
    })
  ).session;
  file = session.files[0];
  assert.equal(file.result, proposal.text);
  assert.deepEqual(blockBuckets(file, file.result, file.verdict?.verdict, ['proposal']), ['decided']);
  // A proposal the checks Merge stays in place, as before.
  Object.assign(f.deps, { verify: () => Promise.resolve({ merged: true, note: 'Merged.', blocks: [{ merged: true, note: 'Merged.' }] }) });
  session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  assert.equal(session.files[0].result, proposal.text);

  // A Keep you made is never overridden by a suggestion: the draft keeps it, and the note says the suggestion differed.
  Object.assign(f.deps, { verify: () => Promise.resolve({ merged: false, note: 'Check the order.' }) });
  session = (await f.run({ kind: 'open', url: f.state.url, restart: true })).session;
  const kept = jsonSample.theirs;
  session = (
    await f.run({ kind: 'save', id: session.id, version: session.version, path: 'settings.json', contents: kept, resolved: false, picks: ['theirs'] })
  ).session;
  f.deps.suggest = () => Promise.resolve({ contents: jsonSample.ours, explanation: 'The PR’s value.' });
  session = (await f.run({ kind: 'resolve', engine: 'agent', id: session.id, version: session.version, path: 'settings.json' })).session;
  assert.equal(session.files[0].result, kept, 'Your Keep stands');
  assert.deepEqual(session.files[0].picks, ['theirs']);
  assert.match(session.files[0].explanation ?? '', /already decided; that one keeps its text/);
});
