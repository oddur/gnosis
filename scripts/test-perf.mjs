#!/usr/bin/env node
// Runs the timing and memory checks that CI only reports, with their budgets enforced (GNOSIS_PERF=1).
// Performance tests run locally only; see "Performance tests" in docs/continuous-integration.md.
//
//   npm run test:perf                  # unit timing tests on this machine, then the timed browser suites in Docker
//   npm run test:perf -- --unit        # only the unit timing tests
//   npm run test:perf -- --browser     # only the timed browser suites
//   GNOSIS_PERF_STRICT=1 npm run test:perf          # budgets as written, without the 1.6x local factor
//   GNOSIS_PERF_BUDGET_SCALE=2 npm run test:perf    # another factor
//
// The unit tests are every file in `npm test` that uses tests/perf-budget.ts. The browser suites are the CI suites whose
// test file uses it (npm run test:perf:browser, scripts/run-browser-suites.mjs --perf). They open Electron windows, so on a dev machine they run in Docker (npm run test:browser:docker);
// set GNOSIS_BROWSER_ON_HOST=1 to run them on this machine, as for any browser check.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { browserTestEnvironment } from './browser-test-host.mjs';
import { usesPerfBudget } from './run-browser-suites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const only = (name) => process.argv.includes(name);
const unit = !only('--browser') || only('--unit');
const browser = !only('--unit') || only('--browser');
const env = { ...process.env, GNOSIS_PERF: '1' };

const run = (command, args) => {
  console.log(`\n▶ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const failed = [];
if (unit) {
  const files = [...String(scripts.test).matchAll(/tests\/[\w-]+\.test\.ts/g)]
    .map((match) => match[0])
    .filter((file) => usesPerfBudget(file));
  // One test file at a time, so the timed files do not compete for the CPU.
  if (run(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', ...files])) failed.push('unit timing tests');
}
if (browser) {
  const direct = browserTestEnvironment();
  const suites = ['scripts/run-browser-suites.mjs', '--perf'];
  // test-browser-docker.mjs passes GNOSIS_PERF and the budget variables into the container.
  if (run(process.execPath, direct ? suites : ['scripts/test-browser-docker.mjs', 'node', ...suites])) failed.push('timed browser suites');
}
console.log(failed.length ? `\nPerformance checks failed: ${failed.join(', ')}` : '\nPerformance checks passed.');
process.exitCode = failed.length ? 1 : 0;
