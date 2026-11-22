import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConflictResolutionService, conflictSessionDirectory } from '../src/conflict-resolution-service';
import {
  FROM_FORK,
  NO_DEPENDENCIES,
  NOT_SUPPORTED,
  TIMED_OUT,
  checkedText,
  newErrors,
  parseDiagnostics,
  type RunScript,
} from '../src/conflict-type-check';
import { blockBuckets, withTypeError } from '../lib/conflict-verify';
import type { ConflictSession, ConflictTypeCheck } from '../lib/conflict-resolution';
import type { PrActionState } from '../lib/pr-actions';

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
  const lib = path.join(dir, 'node_modules', 'typescript', 'lib');
  await fs.mkdir(lib, { recursive: true });
  if (options.tsc !== undefined) await fs.writeFile(path.join(lib, 'tsc.js'), options.tsc);
  else {
    const source = path.resolve('node_modules/typescript');
    await fs.copyFile(path.join(source, 'package.json'), path.join(dir, 'node_modules', 'typescript', 'package.json'));
    for (const name of await fs.readdir(path.join(source, 'lib')))
      if (/^(_?tsc\.js|lib\..*\.d\.ts)$/.test(name)) await fs.copyFile(path.join(source, 'lib', name), path.join(lib, name));
  }
  return dir;
}

async function fixture(
  t: TestContext,
  options: {
    clone?: string;
    tsconfig?: boolean;
    headRepo?: string;
    /** Extra files: name → [base, PR, main]. */
    files?: Record<string, [string, string, string]>;
    timeout?: number;
    run?: RunScript;
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
  if (options.tsconfig !== false) await fs.writeFile(path.join(remote, 'tsconfig.json'), TSCONFIG);
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
  const deps = {
    storage: {
      read: (key: string) => structuredClone(data.get(key)),
      write: (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      flush: async () => {},
    },
    directory: () => path.join(dir, 'cache'),
    context: () => ({ account: 'tester', token: 'not-a-real-token' }),
    read: () => Promise.resolve({ ...state }),
    remote: () => remote,
    // The shallow path, as in the app: the worktree's checkout fetches file contents on demand.
    mergeBase: async (_repo: string, base: string, head: string) => git('merge-base', base, head),
    mergiraf: () => path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'),
    suggest: () => Promise.resolve({ explanation: '' }),
    // Every proposal passes the syntax checks here: the type check is what demotes it.
    verify: () => Promise.resolve({ merged: true, note: 'Passed.' }),
    typeCheckClone: (repo: string) => (repo === 'test/repo' ? options.clone : undefined),
    typeCheckTimeout: options.timeout,
    runScript: (async (script, args, o) => {
      runs.push(script);
      const { runConflictProcess } = await import('../src/conflict-process');
      const result = await (options.run ?? (async () => {
        const r = await runConflictProcess(process.execPath, [script, ...args], o);
        return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
      }))(script, args, o);
      return result;
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
  return { service, session, settled, runs, changed, sessionDir, saved, state, deps };
}

/** No worktree is left behind: Git lists only the session repository, and the private folder is gone. */
async function cleanedUp(sessionDir: string) {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: sessionDir });
  assert.equal(stdout.split('\n').filter((line) => line.startsWith('worktree ')).length, 1, stdout);
  await assert.rejects(fs.stat(path.join(sessionDir, 'type-check')));
}

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
  // The saved draft carries it: the file's proposal is Check, with the compiler's error as its note.
  const saved = f.saved().files.find((x) => x.path === 'sample.ts');
  assert.ok(saved?.verdict);
  assert.equal(saved.typeError?.note, status.files[0].note);
  assert.deepEqual(blockBuckets(saved, saved.result, saved.verdict.verdict), ['check']);
  assert.equal(saved.verdict.verdict.note, status.files[0].note);
  // A later check of the same proposals, after a save, keeps it in Check.
  const { session } = await f.service.run(
    { kind: 'save', id: f.session.id, version: f.saved().version, path: 'sample.ts', contents: saved.result, resolved: false, picks: [null, null] },
    new AbortController().signal
  );
  const after = session.files.find((x) => x.path === 'sample.ts');
  assert.ok(after?.verdict);
  assert.deepEqual(blockBuckets(after, after.result, after.verdict.verdict), ['check']);
  // The PR head was checked too, and both worktrees are gone.
  assert.equal(f.runs.length, 2);
  await cleanedUp(f.sessionDir);
  // The shallow cache checked out the files it needed, and your clone is as it was.
  await fs.stat(path.join(f.sessionDir, 'gnosis-objects.json'));
  assert.ok((await fs.stat(path.join(linked, 'node_modules', 'typescript', 'lib', 'tsc.js'))).isFile());
  assert.deepEqual((await fs.readdir(linked)).sort(), ['.git', 'node_modules']);
  // A reopen of the same draft keeps the result and runs nothing again.
  await f.service.run({ kind: 'open', url: f.state.url }, new AbortController().signal);
  assert.equal(f.service.typeCheck(f.session.id)?.state, 'errors');
  assert.equal(f.runs.length, 2);
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
  assert.deepEqual(status, { state: 'passed', preExisting: 2 });
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
  const hang = 'setInterval(() => {}, 1000);\n';
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
    withTypeError({ merged: false, note: 'File', blocks: [{ merged: true, note: 'ok' }, { merged: false, note: 'no' }] }, 'Types'),
    { merged: false, note: 'File', blocks: [{ merged: false, note: 'Types' }, { merged: false, note: 'no' }] }
  );
  assert.deepEqual(withTypeError({ merged: false, note: 'no' }, 'Types'), { merged: false, note: 'no' });
});
