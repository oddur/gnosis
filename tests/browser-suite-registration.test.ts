import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const runner = readFileSync('scripts/test-workbench.mjs', 'utf8');
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const flags = (names: string[]) => new Set([...names.map(name => scripts[name] ?? '').join(' && ').matchAll(/test-workbench\.mjs (--[a-z0-9-]+)/g)].map(match => match[1]));
const ci = flags(['test:explainer', 'test:workbench', 'test:diagrams']);
// Performance tests run locally only; see "Performance tests" in docs/continuous-integration.md.
const perf = flags(['test:perf:browser']);

/** Each suite flag and the test file it builds, from both forms scripts/test-workbench.mjs uses. */
function suiteFiles() {
  const files = new Map<string, string>();
  for (const [, flag, file] of runner.matchAll(/process\.argv\.includes\('(--[a-z0-9-]+)'\) \? '(tests\/[\w-]+\.ts)'/g)) files.set(flag, file);
  for (const [, name, flag] of runner.matchAll(/const (\w+) = process\.argv\.includes\('(--[a-z0-9-]+)'\)/g)) {
    const file = new RegExp(`[:?(]\\s*${name}\\s*\\?\\s*'(tests/[\\w-]+\\.ts)'`).exec(runner)?.[1];
    if (file && !files.has(flag)) files.set(flag, file);
  }
  return files;
}

// Every browser suite that scripts/test-workbench.mjs knows about must run somewhere: in CI, through test:explainer,
// test:workbench or test:diagrams, or locally as a perf suite through test:perf:browser. A suite left out silently
// never runs.
void test('every workbench browser suite is registered in an npm script CI runs, or as a local perf suite', () => {
  const mapped = new Set([...runner.matchAll(/process\.argv\.includes\('(--[a-z0-9-]+)'\) \? 'tests\//g)].map(match => match[1]));
  const missing = [...mapped].filter(flag => !ci.has(flag) && !perf.has(flag));
  assert.deepEqual(missing, [], `Add these suites to test:workbench: ${missing.join(', ')}`);
});

// A browser suite with timing or memory budgets (it imports tests/perf-budget.ts) must be in test:perf:browser, so
// `npm run test:perf` enforces its budgets. CI only reports them.
void test('every browser suite with timing budgets runs in npm run test:perf', () => {
  const timed = [...suiteFiles()].filter(([, file]) => /from '\.\/perf-budget'/.test(readFileSync(file, 'utf8'))).map(([flag]) => flag);
  assert.ok(timed.length > 0, 'The suite files were found');
  const missing = timed.filter(flag => !perf.has(flag));
  assert.deepEqual(missing, [], `Add these suites to test:perf:browser: ${missing.join(', ')}`);
});

// The local perf category: suites that exist only to measure performance. Only test:perf:browser lists them, so CI's
// suite list and shards (scripts/run-browser-suites.mjs) leave them out. Changing the category is a deliberate edit here.
void test('the local perf suites are the perf-only suites, and CI does not run them', () => {
  const local = [...perf].filter(flag => !ci.has(flag));
  assert.deepEqual(local, ['--interaction-perf', '--comment-typing']);
});
