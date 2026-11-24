import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DURATION_FILES, NATIVE_SHARDS, browserSuites, shardSuites } from '../scripts/run-browser-suites.mjs';
import { unitShard, unitTestFiles, usesTestPart } from '../scripts/run-unit-tests.mjs';
import { inPart, testPart } from './support/test-part';

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const workflow = readFileSync('.github/workflows/checks.yml', 'utf8');

// CI runs the Windows unit tests in shards (scripts/run-unit-tests.mjs). A file left out of every shard never runs there.
void test('the unit shards run every npm test file, and split the long ones by test', () => {
  const files = unitTestFiles(scripts);
  assert.ok(files.includes('tests/unit-shards.test.ts') && files.length > 100);
  assert.ok(usesTestPart('tests/conflict-resolution.test.ts'), 'the conflict-resolution tests run in parts');
  assert.ok(usesTestPart('tests/conflict-resolution-shallow.test.ts'), 'so does the file that imports them');
  assert.ok(!usesTestPart('tests/unit-shards.test.ts'));
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

// The native browser jobs in checks.yml must use the shard counts NATIVE_SHARDS names (npm run test:native-local
// prints them), and balance by a duration file that measures every suite.
void test('the native browser jobs match NATIVE_SHARDS and balance every suite by measured durations', () => {
  const suites = browserSuites(scripts);
  for (const [platform, name] of [
    ['darwin', 'macos'],
    ['win32', 'windows'],
  ] as const) {
    const rows = [
      ...workflow.matchAll(
        new RegExp(`\\{ os: \\w+-latest, platform: ${name}, shards: (\\d+), shard: (\\d+) \\}`, 'g')
      ),
    ];
    const count = NATIVE_SHARDS[platform];
    assert.deepEqual(
      rows.map((row) => [Number(row[1]), Number(row[2])]),
      Array.from({ length: count }, (_, i) => [count, i + 1]),
      `${name} shards in checks.yml`
    );
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
});
