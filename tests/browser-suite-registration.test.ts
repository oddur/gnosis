import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { browserSuites, perfSuites, suiteFile, usesPerfBudget, workbenchSuiteFiles } from '../scripts/run-browser-suites.mjs';

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const files = workbenchSuiteFiles();
const suites = browserSuites(scripts);

// Every browser suite that scripts/test-workbench.mjs knows about must be run by CI, through
// test:explainer, test:workbench or test:diagrams. A suite left out silently never runs.
void test('every workbench browser suite is registered in an npm script CI runs', () => {
  const registered = new Set(suites.map((suite) => `--${suite.key}`));
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
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-import.ts'), true, "import from './perf-budget.ts'");
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-reexport.ts'), true, 'export … from');
  assert.equal(usesPerfBudget('tests/fixtures/perf-budget-helper.ts'), true, 'through a helper that re-exports it');
  assert.equal(usesPerfBudget('tests/workbench-browser.ts'), false);
});
