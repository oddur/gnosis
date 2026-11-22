import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConflictResolutionService, conflictSessionDirectory } from '../src/conflict-resolution-service';
import {
  CRASHED,
  FROM_FORK,
  INCOMPLETE,
  NO_DEPENDENCIES,
  REFERENCES,
  TypeCheckSkipped,
  withoutRoots,
  NOT_SUPPORTED,
  TIMED_OUT,
  checkedText,
  conflictLines,
  newErrors,
  parseDiagnostics,
  rootStripper,
  sortedUnions,
  type RunScript,
} from '../src/conflict-type-check';
import { blockBuckets, typeCheckKey, typeErrorOf, withTypeError } from '../lib/conflict-verify';
import type { ConflictFile } from '../lib/conflict-resolution';
import type { ConflictSession, ConflictTypeCheck } from '../lib/conflict-resolution';
import type { PrActionState } from '../lib/pr-actions';
import { preparedBuckets } from '../lib/conflict-stats';
import { applyChoices, parseConflicts } from '../lib/conflict-blocks';
import { assertPerf } from './perf-budget';

const exec = promisify(execFile);
const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, types: [], lib: ['es2020'], skipLibCheck: true },
  include: ['*.ts'],
});
// The PR makes `limit` a string; main adds a use of it as a number right below. Structural merge keeps both lines.
const SAMPLE = {
  base: 'export const limit: number = 1;\nexport const b = 2;\n',
  ours: "export const limit: string = 'one';\nexport const b = 2;\n",
  theirs: 'export const limit: number = 1;\nexport const doubled: number = limit * 2;\nexport const b = 2;\n',
};

/** A linked clone with the repository's own TypeScript compiler copied in, or with `tsc` as given. */
async function clone(t: TestContext, options: { remote?: string; modules?: boolean; tsc?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-type-clone-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await exec('git', ['remote', 'add', 'origin', `https://github.com/${options.remote ?? 'test/repo'}.git`], { cwd: dir });
  if (options.modules === false) return dir;
  await installCompiler(dir, options.tsc);
  return dir;
}
/** The repository's own TypeScript compiler, copied into a clone's node_modules, or `tsc` as given. */
async function installCompiler(dir: string, tsc?: string) {
  const lib = path.join(dir, 'node_modules', 'typescript', 'lib');
  await fs.mkdir(lib, { recursive: true });
  if (tsc !== undefined) return fs.writeFile(path.join(lib, 'tsc.js'), tsc);
  const source = path.resolve('node_modules/typescript');
  await fs.copyFile(path.join(source, 'package.json'), path.join(dir, 'node_modules', 'typescript', 'package.json'));
  for (const name of await fs.readdir(path.join(source, 'lib')))
    if (/^(_?tsc\.js|lib\..*\.d\.ts)$/.test(name)) await fs.copyFile(path.join(source, 'lib', name), path.join(lib, name));
}
/** Node runs the compiler, as the service does in tests. */
const realRun: RunScript = async (script, args, o) => {
  const { runConflictProcess } = await import('../src/conflict-process');
  const r = await runConflictProcess(process.execPath, [script, ...args], o);
  return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
};

async function fixture(
  t: TestContext,
  options: {
    clone?: string;
    /** The root tsconfig.json; false: none. */
    tsconfig?: boolean | string;
    headRepo?: string;
    /** Extra files: name → [base, PR, main]. */
    files?: Record<string, [string, string, string]>;
    timeout?: number;
    run?: RunScript;
    /** Milliseconds before a changed draft is checked again. */
    delay?: number;
  } = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-type-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote');
  await fs.mkdir(remote);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: remote })).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await git('config', 'uploadpack.allowFilter', 'true');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  const write = async (version: 0 | 1 | 2) => {
    await fs.writeFile(path.join(remote, 'sample.ts'), [SAMPLE.base, SAMPLE.ours, SAMPLE.theirs][version]);
    for (const [name, texts] of Object.entries(options.files ?? {})) await fs.writeFile(path.join(remote, name), texts[version]);
  };
  if (options.tsconfig !== false)
    await fs.writeFile(path.join(remote, 'tsconfig.json'), typeof options.tsconfig === 'string' ? options.tsconfig : TSCONFIG);
  await write(0);
  await git('add', '.');
  await git('commit', '-qm', 'ancestor');
  await git('checkout', '-qb', 'feature');
  await write(1);
  await git('commit', '-qam', 'PR');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', '-q', 'main');
  await write(2);
  await git('add', '.');
  await git('commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD');
  const state = {
    account: 'tester',
    url: 'https://github.com/test/repo/pull/1',
    repository: 'test/repo',
    headRepo: options.headRepo ?? 'test/repo',
    title: 'Limit',
    headSha: head,
    baseSha: base,
    headBranch: 'feature',
    baseBranch: 'main',
    state: 'OPEN',
    archived: false,
    canUpdateBranch: true,
  } as PrActionState;
  const data = new Map<string, unknown>();
  const runs: string[] = [];
  const changed: string[] = [];
  let listener: (() => void) | undefined;
  /** Settings › Local clones and the GitHub account, which a test may change while a check runs. */
  const live = { clone: options.clone, account: 'tester' };
  const deps = {
    storage: {
      read: (key: string) => structuredClone(data.get(key)),
      write: (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      flush: async () => {},
      names: () => [...data.keys()],
    },
    directory: () => path.join(dir, 'cache'),
    context: () => ({ account: live.account, token: 'not-a-real-token' }),
    read: () => Promise.resolve({ ...state }),
    remote: () => remote,
    // The shallow path, as in the app: the worktree's checkout fetches file contents on demand.
    mergeBase: async (_repo: string, base: string, head: string) => git('merge-base', base, head),
    mergiraf: () => path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'),
    suggest: () => Promise.resolve({ explanation: '' }),
    // Every proposal passes the syntax checks here: the type check is what demotes it.
    verify: () => Promise.resolve({ merged: true, note: 'Passed.' }),
    typeCheckClone: (repo: string) => (repo === 'test/repo' ? live.clone : undefined),
    typeCheckTimeout: options.timeout,
    typeCheckDelay: options.delay ?? 20,
    runScript: ((script, args, o) => {
      runs.push(script);
      return (options.run ?? realRun)(script, args, o);
    }) as RunScript,
    typeCheckChanged: (id: string) => {
      changed.push(id);
      listener?.();
    },
  };
  const service = createConflictResolutionService(deps);
  const { session } = await service.run({ kind: 'open', url: state.url }, new AbortController().signal);
  /** The type check's status once it is no longer running. */
  const settled = async () => {
    for (;;) {
      const status = service.typeCheck(session.id);
      if (status?.state !== 'running') return status;
      await new Promise<void>((resolve) => (listener = resolve));
    }
  };
  const sessionDir = await conflictSessionDirectory(deps.directory(), 'tester', session.id);
  const saved = () => data.get(`conflict-draft:tester:${session.id}`) as ConflictSession;
  /** Waits until the compiler has started `count` times. */
  const started = async (count = 1) => {
    for (let i = 0; i < 400 && runs.length < count; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(runs.length, count, 'The compiler started');
  };
  const open = (restart = false) => service.run({ kind: 'open', url: state.url, restart }, new AbortController().signal);
  return { service, session, settled, started, open, runs, changed, sessionDir, saved, state, deps, live };
}

/** No worktree is left behind: Git lists only the session repository, and the private folder is gone. */
async function cleanedUp(sessionDir: string) {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: sessionDir });
  assert.equal(stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1, stdout);
  await assert.rejects(fs.stat(path.join(sessionDir, 'type-check')));
  await assert.rejects(fs.stat(path.join(sessionDir, 'worktrees')), 'No worktree entry is left');
}
/** Waits for a check that was stopped to let go of its worktree. */
async function eventuallyCleanedUp(sessionDir: string) {
  for (let i = 0; i < 200; i++) {
    if (!(await fs.stat(path.join(sessionDir, 'type-check')).catch(() => undefined))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await cleanedUp(sessionDir);
}
const HANG = 'setInterval(() => {}, 1000);\n';
/** A file's buckets as the view shows them: the checks' verdict with the type check's demotion (`typeErrorOf`). */
const shown = (file: ConflictFile, status?: ConflictTypeCheck | null) =>
  blockBuckets(file, file.result, withTypeError(file.verdict?.verdict, typeErrorOf(file, status)));

void test('type check: a Merged proposal that breaks types is demoted to Check with the error; errors elsewhere are information', async (t) => {
  const linked = await clone(t);
  const f = await fixture(t, {
    clone: linked,
    // Main also uses the PR's `limit` as a number in a file without conflicts: a new error, but no proposal to demote.
    files: {
      'use.ts': ['export const n = 1;\n', 'export const n = 1;\n', "import { limit } from './sample';\nexport const n: number = limit;\n"],
    },
  });
  const file = f.session.files.find((x) => x.path === 'sample.ts');
  assert.ok(file?.proposals?.[0], 'Structural merge proposed both lines');
  assert.deepEqual(blockBuckets(file, file.result, file.verdict?.verdict), ['merged'], 'Merged before the type check');
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.equal(status.count, 2);
  assert.equal(status.preExisting, 0);
  assert.ok(status.errors.some((line) => line.startsWith('use.ts:2 TS2322')), status.errors.join('\n'));
  assert.deepEqual(
    status.files.map((x) => x.path),
    ['sample.ts'],
    'Only the conflicted file is demoted'
  );
  assert.match(status.files[0].note, /^The type check found a new error in this file: sample\.ts:2 TS2362 /);
  // The error is inside the conflict, so it is that conflict's.
  assert.match(status.files[0].blocks?.[0] ?? '', /^The type check found a new error in this conflict: sample\.ts:2 TS2362 /);
  // The saved draft carries it as an overlay: the file's proposal is Check, with the compiler's error as its note. The
  // checks' own verdict is unchanged.
  const saved = f.saved().files.find((x) => x.path === 'sample.ts');
  assert.ok(saved?.verdict);
  assert.deepEqual(saved.typeError, { key: status.files[0].key, note: status.files[0].note, blocks: status.files[0].blocks });
  assert.equal(saved.verdict.verdict.merged, true);
  assert.deepEqual(shown(saved), ['check']);
  assert.equal(withTypeError(saved.verdict.verdict, typeErrorOf(saved, status))?.note, status.files[0].blocks?.[0]);
  // A later check of the same proposals, after a save, keeps it in Check.
  const { session } = await f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: saved.result, resolved: false, picks: [null, null] },
    new AbortController().signal
  );
  const after = session.files.find((x) => x.path === 'sample.ts');
  assert.ok(after?.verdict);
  assert.deepEqual(shown(after), ['check']);
  // The PR head and the base were checked too, and every worktree is gone.
  assert.equal(f.runs.length, 3);
  await cleanedUp(f.sessionDir);
  // The shallow cache checked out the files it needed, and your clone is as it was.
  await fs.stat(path.join(f.sessionDir, 'gnosis-objects.json'));
  assert.ok((await fs.stat(path.join(linked, 'node_modules', 'typescript', 'lib', 'tsc.js'))).isFile());
  assert.deepEqual((await fs.readdir(linked)).sort(), ['.git', 'node_modules']);
  // A reopen of the same draft keeps the result and runs nothing again.
  await f.service.run({ kind: 'open', url: f.state.url }, new AbortController().signal);
  assert.equal(f.service.typeCheck(f.session.id)?.state, 'errors');
  assert.equal(f.runs.length, 3);
});

void test('type check: errors the PR head already has do not demote', async (t) => {
  const f = await fixture(t, {
    clone: await clone(t),
    files: {
      // The PR adds an error in a file main leaves alone, and one in the conflicted file, away from the conflict.
      'other.ts': ['export const ok = 1;\n', "export const ok = 1;\nexport const bad: number = 'x';\n", 'export const ok = 1;\n'],
      'sample.ts': [
        SAMPLE.base + 'export const end = 0;\n',
        SAMPLE.ours + "export const end = 0;\nexport const worse: number = 'y';\n",
        // This merge is type-correct: main's line uses `limit` without arithmetic.
        'export const limit: number = 1;\nexport const label = `${limit}`;\nexport const b = 2;\nexport const end = 0;\n',
      ],
    },
  });
  const status = await f.settled();
  assert.deepEqual(status, { state: 'passed', preExisting: 2, checked: { 'sample.ts': typeCheckKey(f.saved().files[0]) } });
  const saved = f.saved().files.find((x) => x.path === 'sample.ts');
  assert.ok(saved?.verdict);
  assert.equal(saved.typeError, undefined);
  assert.deepEqual(blockBuckets(saved, saved.result, saved.verdict.verdict), ['merged']);
  assert.equal(f.runs.length, 2, 'The PR head was checked to tell old errors from new');
  await cleanedUp(f.sessionDir);
});

void test('type check: no node_modules in the clone is skipped, not a failure', async (t) => {
  const f = await fixture(t, { clone: await clone(t, { modules: false }) });
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: NO_DEPENDENCIES });
  assert.equal(f.runs.length, 0);
  const saved = f.saved().files[0];
  assert.ok(saved.verdict);
  assert.deepEqual(blockBuckets(saved, saved.result, saved.verdict.verdict), ['merged']);
});

void test('type check: a repository without a root tsconfig.json is not supported yet', async (t) => {
  const f = await fixture(t, { clone: await clone(t), tsconfig: false });
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: NOT_SUPPORTED });
  assert.equal(f.runs.length, 0);
});

void test('type check: off by default, it never runs', async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.typeCheck(f.session.id), undefined);
  assert.deepEqual(f.changed, []);
  assert.equal(f.runs.length, 0);
  await assert.rejects(fs.stat(path.join(f.sessionDir, 'type-check')));
});

void test('type check: never runs for a fork, or with a clone whose remote is another repository', async (t) => {
  const fork = await fixture(t, { clone: await clone(t), headRepo: 'someone/repo' });
  assert.deepEqual(await fork.settled(), { state: 'skipped', reason: FROM_FORK });
  assert.equal(fork.runs.length, 0);
  const other = await fixture(t, { clone: await clone(t, { remote: 'other/repo' }) });
  assert.deepEqual(await other.settled(), { state: 'skipped', reason: 'your clone has no remote for test/repo' });
  assert.equal(other.runs.length, 0);
});

void test('type check: a compiler that hangs times out, and Stop cancels it; the worktree is removed either way', async (t) => {
  const hang = HANG;
  const slow = await fixture(t, { clone: await clone(t, { tsc: hang }), timeout: 1500 });
  assert.deepEqual(await slow.settled(), { state: 'skipped', reason: TIMED_OUT } satisfies ConflictTypeCheck);
  await cleanedUp(slow.sessionDir);
  const stopped = await fixture(t, { clone: await clone(t, { tsc: hang }) });
  for (let i = 0; i < 200 && !stopped.runs.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(stopped.runs.length, 1, 'The compiler started');
  stopped.service.cancelTypeCheck(stopped.session.id);
  assert.deepEqual(await stopped.settled(), { state: 'cancelled' });
  await cleanedUp(stopped.sessionDir);
  // Nothing was demoted.
  const saved = stopped.saved().files[0];
  assert.equal(saved.typeError, undefined);
});

void test('type check: each run has its own folder, and its cleanup touches nothing else (round 1, item 1)', async (t) => {
  let other = '';
  const f = await fixture(t, {
    clone: await clone(t),
    run: async (script, args, o) => {
      // Another run's folder beside this one, made while this one runs.
      other ||= path.join(o.cwd, '..', '..', 'other-run');
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(other, 'keep.txt'), 'another run');
      return realRun(script, args, o);
    },
  });
  assert.equal((await f.settled())?.state, 'errors');
  assert.equal(await fs.readFile(path.join(other, 'keep.txt'), 'utf8'), 'another run');
  assert.deepEqual(await fs.readdir(path.join(f.sessionDir, 'type-check')), ['other-run']);
  await fs.rm(path.join(f.sessionDir, 'type-check'), { recursive: true });
  await cleanedUp(f.sessionDir);
});

void test('type check: a head run whose output is cut off, or whose exit code contradicts it, is skipped (item 4)', async (t) => {
  let calls = 0;
  const cut = await fixture(t, {
    clone: await clone(t),
    run: async (script, args, o) =>
      ++calls === 1 ? realRun(script, args, o) : { code: 2, stdout: 'sample.ts(1,1): error TS1005: Cut', stderr: '' },
  });
  assert.deepEqual(await cut.settled(), { state: 'skipped', reason: INCOMPLETE });
  assert.equal(cut.saved().files[0].typeError, undefined, 'Nothing is demoted on output that was cut off');
  await cleanedUp(cut.sessionDir);
  const contradicts = await fixture(t, {
    clone: await clone(t),
    run: () => Promise.resolve({ code: 0, stdout: 'sample.ts(1,1): error TS2322: Wrong.\n', stderr: '' }),
  });
  assert.deepEqual(await contradicts.settled(), { state: 'skipped', reason: INCOMPLETE });
  // A crashed compiler (the utility process's 'error') is skipped too.
  const crashed = await fixture(t, {
    clone: await clone(t),
    run: () => Promise.reject(new TypeCheckSkipped(CRASHED)),
  });
  assert.deepEqual(await crashed.settled(), { state: 'skipped', reason: CRASHED });
  await cleanedUp(crashed.sessionDir);
});

void test('type check: a new preparation stops the running check before its folder goes (item 5)', async (t) => {
  const f = await fixture(t, { clone: await clone(t, { tsc: HANG }) });
  await f.started();
  const { session } = await f.open(true);
  // The new preparation's own check runs; the first one's result is never used.
  await f.started(2);
  assert.equal(f.service.typeCheck(session.id)?.state, 'running');
  f.service.cancelTypeCheck(session.id);
  assert.deepEqual(await f.settled(), { state: 'cancelled' });
  await eventuallyCleanedUp(f.sessionDir);
});

void test('type check: a skipped check runs again on the next open (item 6)', async (t) => {
  const linked = await clone(t, { modules: false });
  const f = await fixture(t, { clone: linked });
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: NO_DEPENDENCIES });
  await installCompiler(linked);
  await f.open();
  assert.equal((await f.settled())?.state, 'errors');
  assert.equal(f.runs.length, 2, 'The merge and the head: the only error is inside the conflict');
});

void test('type check: turning the setting off, or another clone, stops the check at once (item 7)', async (t) => {
  for (const next of [undefined, '/elsewhere']) {
    const f = await fixture(t, { clone: await clone(t, { tsc: HANG }) });
    await f.started();
    f.live.clone = next;
    f.service.typeCheckSettingsChanged();
    assert.equal(f.service.typeCheck(f.session.id), undefined, 'Gone at once');
    await eventuallyCleanedUp(f.sessionDir);
    assert.equal(f.service.typeCheck(f.session.id), undefined, 'No late result');
  }
});

void test('type check: a solution tsconfig that checks no file of its own is not supported yet (item 8)', async (t) => {
  const f = await fixture(t, {
    clone: await clone(t),
    tsconfig: JSON.stringify({ files: [], references: [{ path: './tsconfig.lib.json' }] }),
    files: {
      'tsconfig.lib.json': Array(3).fill(
        JSON.stringify({ compilerOptions: { composite: true, strict: true, types: [], lib: ['es2020'] }, include: ['*.ts'] })
      ) as [string, string, string],
    },
  });
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: REFERENCES });
  await cleanedUp(f.sessionDir);
});

void test('type check: the time limit covers Git too (item 9)', async (t) => {
  const f = await fixture(t, { clone: await clone(t), timeout: 1 });
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: TIMED_OUT });
  assert.equal(f.runs.length, 0, 'Stopped before the compiler');
  await cleanedUp(f.sessionDir);
});

void test('type check: cleanup survives an account change, and startup removes leftovers (item 10)', async (t) => {
  const linked = await clone(t, { tsc: HANG });
  const f = await fixture(t, { clone: linked, timeout: 1500 });
  await f.started();
  // The account changes while the compiler runs; the run times out and still removes its worktree.
  f.live.account = 'someone-else';
  await eventuallyCleanedUp(f.sessionDir);
  f.live.account = 'tester';
  assert.deepEqual(await f.settled(), { state: 'skipped', reason: TIMED_OUT });
  // What a crash leaves: a worktree with its link to the clone, and a folder of the first layout with one.
  const leftover = path.join(f.sessionDir, 'type-check', 'crashed', 'merge');
  await exec('git', ['worktree', 'add', '--no-checkout', '--detach', leftover, f.state.headSha], { cwd: f.sessionDir });
  await fs.symlink(path.join(linked, 'node_modules'), path.join(leftover, 'node_modules'));
  await fs.mkdir(path.join(f.sessionDir, 'type-check', 'legacy'));
  await fs.symlink(path.join(linked, 'node_modules'), path.join(f.sessionDir, 'type-check', 'legacy', 'node_modules'));
  await f.service.maintain();
  await cleanedUp(f.sessionDir);
  assert.ok((await fs.stat(path.join(linked, 'node_modules', 'typescript', 'lib', 'tsc.js'))).isFile(), 'The clone is untouched');
});

void test('type check: paths are compared without the folder they were checked in (item 2)', () => {
  const merge = [{ file: 'a.ts', line: 1, code: 'TS2307', message: "Cannot find module '/tmp/s/type-check/r1/merge/gen/x'." }];
  const head = [{ file: 'a.ts', line: 3, code: 'TS2307', message: "Cannot find module '/tmp/s/type-check/r1/head/gen/x'." }];
  const clean = (d: typeof merge, root: string) => withoutRoots(d, [[root, ''], ['/clone', '<clone>']]);
  assert.deepEqual(clean(merge, '/tmp/s/type-check/r1/merge')[0].message, "Cannot find module 'gen/x'.");
  assert.deepEqual(newErrors(clean(merge, '/tmp/s/type-check/r1/merge'), clean(head, '/tmp/s/type-check/r1/head')), []);
  assert.equal(
    withoutRoots([{ file: '/clone/node_modules/x.d.ts', code: 'TS1', message: 'In /clone/node_modules/x.d.ts' }], [['/clone', '<clone>']])[0]
      .message,
    'In <clone>/node_modules/x.d.ts'
  );
});

void test('type check: demotions clear when the check is turned off, and when a later run passes (round 2, item 1)', async (t) => {
  const linked = await clone(t);
  const f = await fixture(t, { clone: linked });
  assert.equal((await f.settled())?.state, 'errors');
  assert.deepEqual(shown(f.saved().files[0]), ['check']);
  // Off: the demotion goes, and the checks' verdict applies again.
  f.live.clone = undefined;
  f.service.typeCheckSettingsChanged();
  assert.equal(f.saved().files[0].typeError, undefined);
  assert.deepEqual(shown(f.saved().files[0]), ['merged']);
  // On again, a demotion, then a run that passes: Merged again. The passing compiler lists the file and finds nothing.
  f.live.clone = linked;
  await f.open();
  assert.equal((await f.settled())?.state, 'errors');
  assert.deepEqual(shown(f.saved().files[0]), ['check']);
  f.live.clone = await clone(t, {
    tsc: "process.stdout.write(require('path').join(process.cwd(), 'sample.ts') + '\\n');\n",
  });
  f.service.typeCheckSettingsChanged();
  assert.deepEqual(shown(f.saved().files[0]), ['check'], 'Still demoted until a run says otherwise');
  await f.open();
  const status = await f.settled();
  assert.equal(status?.state, 'passed', JSON.stringify(status));
  assert.equal(f.saved().files[0].typeError, undefined, 'A passing run clears the demotion');
  assert.deepEqual(shown(f.saved().files[0]), ['merged']);
});

void test('type check: errors that finish while a request runs are dropped after opt-out (round 2, item 1)', async (t) => {
  const f = await fixture(t, { clone: await clone(t) });
  // A save holds the draft while the check finishes: its errors are queued for the next write.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = true;
  const flush = f.deps.storage.flush;
  f.deps.storage.flush = async () => {
    if (holding) await held;
    return flush();
  };
  const saving = f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: f.saved().files[0].result, resolved: false },
    new AbortController().signal
  );
  assert.equal((await f.settled())?.state, 'errors');
  f.live.clone = undefined;
  f.service.typeCheckSettingsChanged();
  holding = false;
  release();
  await saving;
  assert.equal(f.saved().files[0].typeError, undefined, 'The queued demotion was dropped');
  assert.deepEqual(shown(f.saved().files[0]), ['merged']);
});

void test('type check: an options error means it couldn’t check, never passed (round 2, item 2)', async (t) => {
  const f = await fixture(t, {
    clone: await clone(t),
    tsconfig: JSON.stringify({
      compilerOptions: { composite: true, emitDeclarationOnly: true, strict: true, types: [], lib: ['es2020'] },
      include: ['*.ts'],
    }),
  });
  const status = await f.settled();
  assert.ok(status?.state === 'unchecked', JSON.stringify(status));
  assert.match(status.reason, /^TS5\d{3} in tsconfig\.json: /);
  assert.equal(f.saved().files[0].typeError, undefined, 'Nothing is demoted');
  await cleanedUp(f.sessionDir);
});

void test('type check: diagnostics, new errors and the checked text', () => {
  const output =
    "sample.ts(2,31): error TS2362: The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.\n" +
    "use.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    "  Some continuation.\n" +
    'error TS5058: The specified path does not exist.\n';
  const parsed = parseDiagnostics(output);
  assert.deepEqual(parsed[1], {
    file: 'use.ts',
    line: 2,
    code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'. Some continuation.",
  });
  assert.deepEqual(parsed[2], { code: 'TS5058', message: 'The specified path does not exist.' });
  // Lines move in a merge: an error at another line is the same error.
  const moved = { ...parsed[1], line: 9 };
  assert.deepEqual(newErrors([parsed[0], moved, moved], [parsed[1]]), [parsed[0], moved]);
  assert.equal(
    checkedText('a\n<<<<<<< feature\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> main\nb\n'),
    'a\nours\nb\n'
  );
  // Only Merged proposals are demoted; Check stays as it was.
  assert.deepEqual(
    withTypeError({ merged: false, note: 'File', blocks: [{ merged: true, note: 'ok' }, { merged: false, note: 'no' }] }, { note: 'Types' }),
    { merged: false, note: 'File', blocks: [{ merged: false, note: 'Types' }, { merged: false, note: 'no' }] }
  );
  assert.deepEqual(withTypeError({ merged: false, note: 'no' }, { note: 'Types' }), { merged: false, note: 'no' });
});

/** sample.ts with two conflicts: the `limit` one, and both sides adding a line at the end. `use` adds main's use of
 * `limit` as a number between them, outside every conflict. */
function twoConflicts(use = false): Record<string, [string, string, string]> {
  const filler = Array.from({ length: 10 }, (_, i) =>
    use && i === 5 ? 'export const f5: number = limit * 5;\n' : `export const f${i} = ${i};\n`
  ).join('');
  const plain = Array.from({ length: 10 }, (_, i) => `export const f${i} = ${i};\n`).join('');
  return {
    'sample.ts': [
      SAMPLE.base + plain + 'export const z = 0;\n',
      SAMPLE.ours + plain + 'export const z = 0;\nexport const fromPr = 1;\n',
      SAMPLE.theirs + filler + 'export const z = 0;\nexport const fromMain = 2;\n',
    ],
  };
}

void test('type check: an error inside a conflict demotes only that conflict (#499)', async (t) => {
  const f = await fixture(t, { clone: await clone(t), files: twoConflicts() });
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  const { blocks } = status.files[0];
  assert.ok(blocks?.length === 2, JSON.stringify(status.files[0]));
  assert.match(blocks[0] ?? '', /^The type check found a new error in this conflict: sample\.ts:2 TS2362 /);
  assert.equal(blocks[1], null);
  const saved = f.saved().files[0];
  assert.deepEqual(blockBuckets(saved, saved.result, saved.verdict?.verdict), ['merged', 'merged'], 'Both Merged before');
  assert.deepEqual(shown(saved, status), ['check', 'merged']);
  assert.deepEqual(shown(saved), ['check', 'merged'], 'The saved demotion is the same');
  assert.deepEqual(preparedBuckets(saved, []), ['check', 'merged'], 'The stats read it too');
});

void test('type check: an error outside every conflict demotes the file; a fixed draft is checked again, and the demotion holds until that run finishes (#499)', async (t) => {
  // The compiler waits for the test once the draft is fixed, so the run can be seen while it runs.
  const gate: { hold?: Promise<void> } = {};
  const f = await fixture(t, {
    clone: await clone(t),
    files: twoConflicts(true),
    run: async (script, args, o) => {
      await gate.hold;
      return realRun(script, args, o);
    },
  });
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.equal(status.files[0].blocks, undefined, 'An error outside every conflict is the whole file’s');
  assert.match(status.files[0].note, /^The type check found 2 new errors in this file: sample\.ts:2 TS2362 .* · sample\.ts:9 TS2362 /);
  assert.deepEqual(shown(f.saved().files[0]), ['check', 'check']);
  assert.equal(f.runs.length, 3);
  // Keep the PR's `limit` and drop main's use of it in the conflict: one error is left, outside the conflicts.
  let release!: () => void;
  gate.hold = new Promise((resolve) => (release = resolve));
  const file = f.saved().files[0];
  const fixed = applyChoices(parseConflicts(file.original), ['ours', 'proposal'], file.proposals);
  const { session } = await f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: fixed, resolved: false, picks: ['ours', null] },
    new AbortController().signal
  );
  assert.notEqual(typeCheckKey(session.files[0]), status.files[0].key, 'The draft is part of the key');
  // The last result is for the older draft: the saved demotion holds.
  assert.deepEqual(shown(session.files[0], f.service.typeCheck(f.session.id)), ['decided', 'check']);
  await f.started(4);
  assert.equal(f.service.typeCheck(f.session.id)?.state, 'running', 'A changed draft is checked again');
  // Meanwhile the saved demotion holds: the untouched Merged conflict stays in Check.
  assert.deepEqual(shown(session.files[0], f.service.typeCheck(f.session.id)), ['decided', 'check']);
  release();
  const again = await f.settled();
  assert.ok(again?.state === 'errors', JSON.stringify(again));
  assert.equal(again.count, 1);
  assert.equal(again.files[0].key, typeCheckKey(f.saved().files[0]));
  assert.deepEqual(shown(f.saved().files[0], again), ['decided', 'check']);
  // Main's use goes too: the run passes, and the conflict is Merged again.
  const clean = fixed.replace('export const f5: number = limit * 5;\n', 'export const f5 = 5;\n');
  await f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: clean, resolved: false },
    new AbortController().signal
  );
  await f.started(7);
  assert.equal((await f.settled())?.state, 'passed');
  assert.equal(f.saved().files[0].typeError, undefined);
  await cleanedUp(f.sessionDir);
});

void test('type check: errors the base already has are not new (#499)', async (t) => {
  const f = await fixture(t, {
    clone: await clone(t),
    // Main imports a module that isn't there, such as generated code that isn't built. The PR head doesn't have it.
    files: { 'gen.ts': ['export const g = 1;\n', 'export const g = 1;\n', "import { x } from './missing';\nexport const g = x;\n"] },
  });
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.equal(status.count, 1, status.errors.join('\n'));
  assert.equal(status.preExisting, 1);
  assert.ok(!status.errors.some((line) => line.includes('TS2307')), status.errors.join('\n'));
  assert.equal(f.runs.length, 3, 'The merge, the PR head and the base');
  await cleanedUp(f.sessionDir);
});

void test('type check: unions in another order are the same error (#499)', () => {
  assert.equal(
    sortedUnions(`Type '"b" | "a" | Array<string | number>' is not assignable to type '(x: B | A) => void | C'.`),
    `Type '"a" | "b" | Array<string | number>' is not assignable to type '(x: B | A) => void | C'.`
  );
  const error = (message: string) => ({ file: 'a.ts', line: 1, code: 'TS2322', message });
  assert.deepEqual(newErrors([error(`Type '"b" | "a"' is wrong.`)], [error(`Type '"a" | "b"' is wrong.`)]), []);
  // Each baseline on its own: an error both have once is one known error.
  assert.equal(newErrors([error('x'), error('x')], [error('x')], [error('x')]).length, 1);
});

void test('type check: each conflict’s lines in the checked draft (#499)', () => {
  const original = 'a\n<<<<<<< pr\nb\n=======\nc\n>>>>>>> main\nd\n<<<<<<< pr\ne\n=======\nf\n>>>>>>> main\ng\n';
  const proposals = [{ source: 'union' as const, text: 'b\nc\n' }, null];
  // The first holds its proposal (two lines), the second is open and checked with the PR's side.
  const draft = 'a\nb\nc\nd\n<<<<<<< pr\ne\n=======\nf\n>>>>>>> main\ng\n';
  assert.deepEqual(conflictLines({ original, proposals, result: draft }), [[2, 3], [5, 5]]);
  // Edited by hand: nothing can be traced to a conflict.
  assert.equal(conflictLines({ original, proposals, result: 'a\nb\nc\nd\nhand\ng\n' }), undefined);
});

void test('type check: the key is remembered per file object while its inputs are the same (#499)', () => {
  let reads = 0;
  const file = {
    original: 'a\n',
    get proposals() {
      reads++;
      return undefined;
    },
    result: 'a\n',
  };
  const key = typeCheckKey(file);
  reads = 0;
  assert.equal(typeCheckKey(file), key);
  assert.equal(reads, 1, 'Only compared, not hashed again');
  file.result = 'b\n';
  assert.notEqual(typeCheckKey(file), key, 'A changed draft is a new key');
});

void test('type check: the root stripper orders the roots once and strips like withoutRoots (#499)', () => {
  const roots: [string, string][] = [['/tmp/w', ''], ['/tmp/w/inner', ''], ['/clone', '<clone>']];
  const strip = rootStripper(roots);
  assert.equal(strip('/tmp/w/inner/a.ts'), 'a.ts');
  assert.equal(strip('/clone/node_modules/x.d.ts'), '<clone>/node_modules/x.d.ts');
  assert.equal(strip('elsewhere/a.ts'), 'elsewhere/a.ts');
  const lines = Array.from({ length: 50_000 }, (_, i) => `/tmp/w/src/file${i}.ts`);
  const started = performance.now();
  const stripped = lines.map(strip);
  assertPerf('type check: strip 50k --listFiles lines', performance.now() - started, 200);
  assert.equal(stripped[49_999], 'src/file49999.ts');
});

void test('type check: before its status is read, the view shows the saved demotion; a result for an older draft does not clear it (#499)', () => {
  const file = {
    path: 'a.ts',
    original: 'a\n',
    result: 'a\n',
    typeError: { key: 'old', note: 'Saved.' },
  };
  assert.equal(typeErrorOf(file, undefined)?.note, 'Saved.', 'Not read yet: no flash to Merged');
  assert.equal(typeErrorOf(file, { state: 'running' })?.note, 'Saved.');
  const errors = (key: string): ConflictTypeCheck => ({
    state: 'errors',
    checked: { 'a.ts': key },
    count: 1,
    preExisting: 0,
    errors: [],
    files: [{ path: 'a.ts', key, note: 'Run.' }],
  });
  assert.equal(typeErrorOf(file, errors('older'))?.note, 'Saved.');
  assert.equal(typeErrorOf(file, errors(typeCheckKey(file)))?.note, 'Run.');
  assert.equal(typeErrorOf(file, { state: 'passed', preExisting: 0, checked: { 'a.ts': typeCheckKey(file) } }), undefined);
  // A pass for another draft, or one that doesn't say what it checked, clears nothing.
  assert.equal(typeErrorOf(file, { state: 'passed', preExisting: 0, checked: { 'a.ts': 'older' } })?.note, 'Saved.');
  assert.equal(typeErrorOf(file, { state: 'passed', preExisting: 0 })?.note, 'Saved.');
  assert.equal(typeErrorOf(file, null), undefined, 'Off');
});

void test('type check: a result for an older draft never clears the demotion of the draft saved since (#505 review, 1)', async (t) => {
  const gate: { hold?: Promise<void> } = {};
  const f = await fixture(t, {
    clone: await clone(t),
    files: twoConflicts(true),
    delay: 0,
    run: async (script, args, o) => {
      await gate.hold;
      return realRun(script, args, o);
    },
  });
  assert.equal((await f.settled())?.state, 'errors');
  const broken = f.saved().files[0].result;
  assert.deepEqual(shown(f.saved().files[0]), ['check', 'check']);
  // D2 fixes every error; its run waits in the compiler.
  let release!: () => void;
  gate.hold = new Promise((resolve) => (release = resolve));
  const file = f.saved().files[0];
  const clean = applyChoices(parseConflicts(file.original), ['ours', 'proposal'], file.proposals).replace(
    'export const f5: number = limit * 5;\n',
    'export const f5 = 5;\n'
  );
  const save = (contents: string) =>
    f.service.run(
      { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents, resolved: false },
      new AbortController().signal
    );
  await save(clean);
  await f.started(4);
  // D3 brings the errors back, and D2's run finishes while D3's save still holds the draft: its result is queued.
  f.deps.typeCheckDelay = 60_000;
  let flushed!: () => void;
  const held = new Promise<void>((resolve) => (flushed = resolve));
  const flush = f.deps.storage.flush;
  f.deps.storage.flush = async () => {
    await held;
    return flush();
  };
  const saving = save(broken);
  release();
  assert.equal((await f.settled())?.state, 'passed', 'D2 passed');
  flushed();
  await saving;
  assert.ok(f.saved().files[0].typeError, 'D3 keeps its demotion');
  assert.deepEqual(shown(f.saved().files[0], f.service.typeCheck(f.session.id)), ['check', 'check'], 'Nothing reads as Merged');
  f.service.cancelTypeCheck(f.session.id);
});

void test('type check: a base that can’t be checked leaves the errors the head comparison found (#505 review, 2)', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    clone: await clone(t),
    // Main's use of `limit` in a file without conflicts: an error outside the conflicts, so the base is checked.
    files: {
      'use.ts': ['export const n = 1;\n', 'export const n = 1;\n', "import { limit } from './sample';\nexport const n: number = limit;\n"],
    },
    run: async (script, args, o) =>
      // The merge and the head run; the base's output is cut off.
      ++calls <= 2 ? realRun(script, args, o) : { code: 2, stdout: 'sample.ts(1,1): error TS1005: Cut', stderr: '' },
  });
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.equal(calls, 3);
  assert.deepEqual(shown(f.saved().files[0]), ['check']);
  await cleanedUp(f.sessionDir);
});

void test('type check: an error in a conflict that isn’t a Merged proposal demotes the file’s Merged conflicts (#505 review, 3)', async (t) => {
  // In the lib: a mark for a conflict that is no longer Merged falls back to the whole file.
  assert.deepEqual(
    withTypeError(
      { merged: false, note: 'File', blocks: [{ merged: false, note: 'Decide' }, { merged: true, note: 'ok' }] },
      { note: 'Types', blocks: ['In the first', null] }
    ),
    { merged: false, note: 'File', blocks: [{ merged: false, note: 'Decide' }, { merged: false, note: 'Types' }] }
  );
  // In the run: you keep both sides of the first conflict, which breaks inside it; the Merged second one is Check too.
  const f = await fixture(t, { clone: await clone(t), files: twoConflicts() });
  assert.equal((await f.settled())?.state, 'errors');
  const file = f.saved().files[0];
  const both = applyChoices(parseConflicts(file.original), ['both', 'proposal'], file.proposals);
  await f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: both, resolved: false, picks: ['both', null] },
    new AbortController().signal
  );
  await f.started(3);
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.equal(status.files[0].blocks, undefined, 'Not traced to the decided conflict');
  assert.deepEqual(shown(f.saved().files[0], status), ['decided', 'check']);
});

void test('type check: the base never excuses an error inside a conflict (#505 review, 4)', async (t) => {
  const f = await fixture(t, {
    clone: await clone(t),
    files: {
      // Main adds a broken line where the PR adds its own: the union keeps both, so the conflict holds main's error.
      'sample.ts': [
        'export const z = 0;\n',
        'export const z = 0;\nexport const fromPr = 1;\n',
        "export const z = 0;\nexport const fromMain: number = 'x';\n",
      ],
    },
  });
  const status = await f.settled();
  assert.ok(status?.state === 'errors', JSON.stringify(status));
  assert.ok(status.errors.some((line) => line.startsWith('sample.ts:') && line.includes('TS2322')), status.errors.join('\n'));
  assert.equal(f.runs.length, 2, 'No base run: nothing outside the conflicts to excuse');
});

void test('type check: the dialog and the header read the same status (#505 review, 5)', async (t) => {
  const f = await fixture(t);
  // Off: null for both.
  assert.equal(f.service.typeCheckStatus(f.session.id), null);
  assert.equal(f.service.typeCheckStatus(f.session.id, 'test/repo'), null);
  // On, but not run since the app started: undefined, so the saved demotions apply.
  f.live.clone = '/somewhere';
  assert.equal(f.service.typeCheckStatus(f.session.id), undefined);
  assert.equal(f.service.typeCheckStatus(f.session.id, 'test/repo'), undefined);
});

void test('type check: saves in a row start one run, after the changes stop (#505 review, 6)', async (t) => {
  const f = await fixture(t, { clone: await clone(t), delay: 300 });
  assert.equal((await f.settled())?.state, 'errors');
  const first = f.runs.length;
  const file = f.saved().files[0];
  for (const choice of ['ours', 'theirs', 'ours'] as const) {
    await f.service.run(
      {
        kind: 'save',
        id: f.session.id,
        version: f.saved().version,
        path: 'sample.ts',
        contents: applyChoices(parseConflicts(file.original), [choice], file.proposals),
        resolved: false,
        picks: [choice],
      },
      new AbortController().signal
    );
    assert.notEqual(f.service.typeCheck(f.session.id)?.state, 'running', 'Not on every save');
  }
  await f.started(first + 1);
  const status = await f.settled();
  assert.equal(status?.state, 'passed', JSON.stringify(status));
  assert.equal(f.runs.length, first + 1, 'One run, for the last draft');
});
