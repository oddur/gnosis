import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { DURATION_FILES, NATIVE_PR_SHARDS, NATIVE_SHARDS, browserSuites, shardSuites } from '../scripts/run-browser-suites.mjs';
import { shardRuns, unitShard, unitTestFiles, usesTestPart } from '../scripts/run-unit-tests.mjs';
import { inPart, testPart } from './support/test-part';

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const workflow = readFileSync('.github/workflows/checks.yml', 'utf8');

// CI runs the Windows unit tests in shards (scripts/run-unit-tests.mjs). A file left out of every shard never runs there.
void test('the unit shards run every npm test file, and split the long ones by test', () => {
  const files = unitTestFiles(scripts);
  assert.ok(files.includes('tests/unit-shards.test.ts') && files.length > 100);
  assert.ok(usesTestPart('tests/conflict-resolution.test.ts'), 'the conflict-resolution tests run in parts');
  assert.ok(usesTestPart('tests/conflict-resolution-shallow.test.ts'), 'so does the file that imports them');
  assert.ok(!usesTestPart('tests/pr-state.test.ts'));
  const count = Number(/run-unit-tests\.mjs --shard \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(workflow)?.[1]);
  assert.ok(count >= 2, 'checks.yml runs the unit shards');
  const runs = new Map<string, number>();
  for (let index = 1; index <= count; index++)
    for (const file of unitShard(files, index, count).files) runs.set(file, (runs.get(file) ?? 0) + 1);
  for (const file of files) assert.equal(runs.get(file), usesTestPart(file) ? count : 1, file);
});

void test('the parts of a split file run each of its tests exactly once', () => {
  assert.equal(testPart(''), undefined);
  assert.deepEqual(testPart('2/3'), { index: 2, count: 3 });
  assert.throws(() => testPart('4/3'));
  for (const count of [1, 2, 3]) {
    for (let position = 0; position < 10; position++) {
      const parts = Array.from({ length: count }, (_, i) => i + 1).filter((index) =>
        inPart(position, { index, count })
      );
      assert.equal(parts.length, 1);
    }
  }
});

// The native browser jobs in checks.yml must use the shard counts NATIVE_SHARDS (main) and NATIVE_PR_SHARDS (pull
// requests) name, and balance by a duration file that measures every suite.
void test('the native browser jobs match NATIVE_SHARDS and NATIVE_PR_SHARDS and balance every suite by measured durations', () => {
  const suites = browserSuites(scripts);
  const include = /include: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}/.exec(workflow);
  assert.ok(include, 'checks.yml picks the native matrix by event');
  type Row = { os: string; platform: string; shards: number; shard: number; timeout: number };
  const [pr, main] = [JSON.parse(include[1]) as Row[], JSON.parse(include[2]) as Row[]];
  for (const [rows, counts, label] of [
    [pr, NATIVE_PR_SHARDS, 'pull requests'],
    [main, NATIVE_SHARDS, 'main'],
  ] as const) {
    for (const [platform, name] of [
      ['darwin', 'macos'],
      ['win32', 'windows'],
    ] as const) {
      const count = counts[platform];
      assert.deepEqual(
        rows.filter((row) => row.platform === name).map((row) => [row.shards, row.shard]),
        Array.from({ length: count }, (_, i) => [count, i + 1]),
        `${name} shards on ${label} in checks.yml`
      );
      assert.ok(rows.filter((row) => row.platform === name).every((row) => row.timeout >= 30), `${name} timeouts`);
      assert.equal(DURATION_FILES[platform], `scripts/browser-suite-durations-${name}.json`);
      const durations = JSON.parse(readFileSync(DURATION_FILES[platform], 'utf8')) as Record<string, number>;
      const unmeasured = suites.filter((suite) => typeof durations[suite.key] !== 'number').map((suite) => suite.key);
      assert.deepEqual(unmeasured, [], `Measure these suites on ${name}: ${unmeasured.join(', ')}`);
      const shards = Array.from({ length: count }, (_, i) => shardSuites(suites, durations, i + 1, count).length);
      assert.equal(
        shards.reduce((sum, size) => sum + size, 0),
        suites.length
      );
    }
  }
});

/** Runs `tsx --test` on files with an environment, and returns how many tests passed and failed. */
function runFixture(files: string[], env: NodeJS.ProcessEnv) {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  // Without NODE_TEST_CONTEXT, which marks this process as a test file, the child runs its files as a top-level runner.
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [tsx, '--test', ...files], { env: clean, encoding: 'utf8' });
  const count = (name: string) => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(result.stdout)?.[1] ?? NaN);
  return { pass: count('pass'), fail: count('fail'), output: result.stdout + result.stderr };
}

// GNOSIS_TEST_PART reaches only the process that runs the split files. A file that does not split, even one that
// imports the helpers, runs every test in every shard, also when the variable is already set around the runner.
void test('under a shard, a file that is not split runs in full and a split file runs its part', () => {
  const whole = 'tests/fixtures/test-part/whole.ts';
  const split = 'tests/fixtures/test-part/split.ts';
  const isSplit = (file: string) => file === split;
  let wholeShards = 0;
  for (const index of [1, 2]) {
    const runs = shardRuns([whole, split], index, 2, { ...process.env, GNOSIS_TEST_PART: '1/2' }, isSplit);
    const splitRun = runs.find((run) => run.files.includes(split));
    assert.ok(splitRun && !splitRun.files.includes(whole));
    assert.equal(splitRun.env.GNOSIS_TEST_PART, `${index}/2`);
    const splitResult = runFixture(splitRun.files, splitRun.env);
    assert.deepEqual([splitResult.pass, splitResult.fail], [2, 0], splitResult.output);
    const wholeRun = runs.find((run) => run.files.includes(whole));
    if (!wholeRun) continue;
    wholeShards++;
    assert.equal(wholeRun.env.GNOSIS_TEST_PART, undefined);
    const wholeResult = runFixture(wholeRun.files, wholeRun.env);
    assert.deepEqual([wholeResult.pass, wholeResult.fail], [4, 0], wholeResult.output);
  }
  assert.equal(wholeShards, 1, 'a file that is not split runs in one shard');
});

void test('a split file that uses describe fails with a message instead of running its tests in every part', () => {
  const result = runFixture(['tests/fixtures/test-part/describe.ts'], { ...process.env, GNOSIS_TEST_PART: '1/2' });
  assert.match(result.output, /describe is not supported in a file split by tests\/support\/test-part\.ts/);
});
