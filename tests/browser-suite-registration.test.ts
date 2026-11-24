import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  LOCAL_SCRIPTS,
  browserSuites,
  perfSuites,
  suiteFile,
  suiteTimeoutSeconds,
  usesPerfBudget,
  workbenchSuiteFiles,
} from '../scripts/run-browser-suites.mjs';

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const files = workbenchSuiteFiles();
const suites = browserSuites(scripts);

// Every browser suite that scripts/test-workbench.mjs knows about must be run by CI, through
// test:explainer, test:workbench or test:diagrams. A suite left out silently never runs. Long local-only suites, such as
// the conflict gallery, are listed in LOCAL_SCRIPTS instead.
void test('every workbench browser suite is registered in an npm script CI runs', () => {
  const registered = new Set([...suites, ...browserSuites(scripts, LOCAL_SCRIPTS)].map((suite) => `--${suite.key}`));
  const missing = [...files.keys()].filter((flag) => flag !== 'default' && !registered.has(flag));
  assert.deepEqual(missing, [], `Add these suites to test:workbench: ${missing.join(', ')}`);
});

// npm run test:perf picks the suites with budgets from their test files, so each CI suite must name one.
// Performance tests run locally only; see "Performance tests" in docs/continuous-integration.md.
void test('every CI browser suite maps to its test file, so test:perf can find the timed ones', () => {
  const unknown = suites.filter((suite) => !suiteFile(suite, files)).map((suite) => suite.key);
  assert.deepEqual(unknown, [], `scripts/run-browser-suites.mjs cannot tell which file these suites run: ${unknown.join(', ')}`);
  assert.equal(suiteFile({ key: 'default', command: 'node scripts/test-workbench.mjs' }, files), 'tests/workbench-browser.ts');
  assert.equal(suiteFile({ key: 'explainer', command: 'node scripts/test-explainer.mjs' }, files), 'tests/explainer-browser.ts');
  const timed = perfSuites(scripts).map((suite) => suite.key);
  for (const key of ['interaction-perf', 'comment-typing', 'diff-gaps', 'syntax-scope']) assert.ok(timed.includes(key), `${key} has budgets`);
  assert.ok(!timed.includes('default') && !timed.includes('explainer'), 'Suites without budgets are not timed');
});

void test('a test file uses the perf budgets through any import form, a re-export or a local helper', () => {
  assert.equal(usesPerfBudget('tests/group-subjects.test.ts'), true);
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-import.ts'), true, 'an import with the .ts extension');
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-reexport.ts'), true, 'a re-export');
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-helper.ts'), true, 'through a helper that re-exports it');
  assert.equal(usesPerfBudget('tests/workbench-browser.ts'), false);
});

// A hung suite fails alone instead of using up its shard's job timeout (#554).
void test('a suite may run 3× its measured duration, and at least 4 minutes', () => {
  const durations = { short: 10, long: 286, edge: 80, zero: 0 };
  assert.equal(suiteTimeoutSeconds('short', durations), 240, 'a short suite gets the 4-minute floor');
  assert.equal(suiteTimeoutSeconds('edge', durations), 240, '3× 80 s is exactly the floor');
  assert.equal(suiteTimeoutSeconds('long', durations), 858, 'a long suite gets 3× its duration');
  assert.equal(suiteTimeoutSeconds('new', durations), 858, 'an unmeasured suite gets the limit of the slowest suite');
  assert.equal(suiteTimeoutSeconds('zero', durations), 858, 'a zero measurement counts as unmeasured');
  assert.equal(suiteTimeoutSeconds('new', {}), 240, 'with no measurements at all, the floor');
});
