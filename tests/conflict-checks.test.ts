// The conflict checks' worker (src/conflict-checks.ts, src/conflict-check-worker.ts) with the real grammars: how long a
// check takes in it, and what a cancelled check costs the checks after it (#464).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { createConflictCheckWorker, type CheckedFile } from '../src/conflict-checks';
import { assertPerf, perfBudget } from './perf-budget';

/** The worker as Vite builds it for the app: one script, with the tag queries inlined (`?raw`). */
async function workerScript(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-check-worker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'conflict-check-worker.mjs');
  await build({
    entryPoints: [path.resolve('src/conflict-check-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: script,
    banner: {
      js: "import { createRequire as __require } from 'node:module'; const require = __require(import.meta.url);",
    },
    logLevel: 'warning',
    plugins: [
      {
        name: 'raw',
        setup(b) {
          b.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
            namespace: 'raw',
          }));
          b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
            contents: await fs.readFile(args.path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  return script;
}
const treeSitter = () => ({
  runtime: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  grammars: path.resolve('src/assets/tree-sitter'),
});

/** A TypeScript file of `functions` functions above one conflict on `x`, with structural merge's proposal. */
function conflictFile(name: string, functions: number): CheckedFile {
  const before = Array.from(
    { length: functions },
    (_, i) => `export function f${i}(a: number, b: string): string {\n  const x = a * ${i};\n  return b + x;\n}\n`
  ).join('');
  const side = (value: number) => `${before}export const x = ${value};\n`;
  return {
    path: `${name}.ts`,
    base: side(0),
    ours: side(1),
    theirs: side(2),
    original: `${before}<<<<<<< pr\nexport const x = 1;\n||||||| base\nexport const x = 0;\n=======\nexport const x = 2;\n>>>>>>> main\n`,
    proposals: [{ source: 'mergiraf', text: 'export const x = 1;\n' }],
  };
}

void test('a check in the worker: the first one starts the worker and loads the grammar, the next ones parse (#464)', async (t) => {
  const checks = createConflictCheckWorker(await workerScript(t), treeSitter);
  t.after(() => checks.dispose());
  let started = performance.now();
  const first = await checks.check(conflictFile('first', 1));
  const cold = performance.now() - started;
  assert.ok(first, 'The worker answers with a verdict');
  started = performance.now();
  const small = await checks.check(conflictFile('small', 1));
  const warm = performance.now() - started;
  assert.ok(small);
  started = performance.now();
  const large = await checks.check(conflictFile('large', 1000));
  const big = performance.now() - started;
  assert.ok(large);
  assertPerf('conflict check: first check, worker and grammar cold', cold, perfBudget(400));
  assertPerf('conflict check: small file, worker warm', warm, perfBudget(50));
  assertPerf('conflict check: 4,000-line file, worker warm', big, perfBudget(500));
});

void test('a cancelled check stops in the worker, so the next one does not wait for it (#464)', async (t) => {
  const checks = createConflictCheckWorker(await workerScript(t), treeSitter);
  t.after(() => checks.dispose());
  // Warm: the measurement below is the cancelled file's cost, not the grammar's.
  assert.ok(await checks.check(conflictFile('warm', 1)));
  const controller = new AbortController();
  const slow = checks.check(conflictFile('slow', 4000), [], controller.signal);
  // Queued behind the slow one, then cancelled: it never runs.
  const queued = new AbortController();
  const dropped = checks.check(conflictFile('dropped', 1), [], queued.signal);
  queued.abort();
  controller.abort();
  const started = performance.now();
  const next = await checks.check(conflictFile('next', 1));
  const waited = performance.now() - started;
  assert.ok(next, 'The check after a cancelled one still answers');
  assert.equal(await slow, undefined, 'A cancelled check answers nothing');
  assert.equal(await dropped, undefined, 'A cancelled queued check answers nothing');
  assertPerf('conflict check: next answer after cancelling a 16,000-line check', waited, perfBudget(250));
  // A signal that is already aborted never starts a job.
  assert.equal(await checks.check(conflictFile('late', 1), [], AbortSignal.abort()), undefined);
  // After dispose, every kind of job answers at once and none hangs.
  checks.dispose();
  assert.equal(await checks.definitions('late.ts', 'export const x = 1;\n'), undefined);
  assert.deepEqual(
    await checks.noise([{ language: 'typescript', after: 'export const x = 1;\n', hunks: [], imports: false }]),
    [null]
  );
});
