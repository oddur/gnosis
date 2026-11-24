#!/usr/bin/env node
// Runs the browser suites the macOS and Windows CI jobs run, natively on this machine, with the same shards and
// test-window size. Run it before opening a PR that changes more than docs: the native jobs on a PR take about 20
// minutes, and a failure there costs a whole round. The suites open real Electron windows that take focus.
//
//   npm run test:native-local                       # every suite (about an hour)
//   npm run test:native-local -- --shard 1/4        # the suites of CI's "Browser (macos-latest 1/4)"
//   npm run test:native-local -- --list --shard 1/4
//   npm run test:native-local -- --work-area 1280x800
//
// On macOS, test windows open no larger than the runner's work area, 1024x677 (GNOSIS_TEST_WORK_AREA, see
// tests/electron-test-shim.ts). Timing budgets are report-only, as on CI. Measured seconds go to
// browser-suite-durations-local.json; copy them into the platform's duration file only from CI runs.
import { spawn } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DURATION_FILES, NATIVE_SHARDS, browserSuites, shardSuites } from './run-browser-suites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argument = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The work area of the CI runner's screen, where it is known. */
const RUNNER_WORK_AREA = { darwin: '1024x677' };
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows' };

const platform = process.platform;
if (!NATIVE_SHARDS[platform]) {
  console.error('The native browser jobs run on macOS and Windows. On Linux, use npm run test:browser:docker.');
  process.exit(1);
}

const weights = DURATION_FILES[platform];
const shard = argument('--shard');
const workArea = argument('--work-area') ?? process.env.GNOSIS_TEST_WORK_AREA ?? RUNNER_WORK_AREA[platform];
if (workArea && !/^\d+x\d+$/.test(workArea)) throw new Error(`Invalid work area ${workArea}; expected WIDTHxHEIGHT`);

const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const durations = JSON.parse(fs.readFileSync(path.join(root, weights), 'utf8'));
let suites = browserSuites(scripts);
if (shard) {
  const [index, count] = shard.split('/').map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid --shard ${shard}; expected i/n`);
  suites = shardSuites(suites, durations, index, count);
  if (count !== NATIVE_SHARDS[platform])
    console.log(`Note: CI splits ${PLATFORM_NAMES[platform]} into ${NATIVE_SHARDS[platform]} shards, not ${count}.`);
}
const predicted = suites.reduce((sum, suite) => sum + (durations[suite.key] ?? 0), 0);
console.log(
  `Native pre-flight on ${PLATFORM_NAMES[platform]}: ${suites.length} suites${shard ? ` (shard ${shard})` : ''}, ` +
    `about ${Math.round(predicted / 60)} min on a CI runner; test windows ${workArea ? `at most ${workArea}` : 'unclamped'}.`
);

const forwarded = args.filter((arg, i) => arg !== '--work-area' && args[i - 1] !== '--work-area');
const env = {
  ...process.env,
  // This command exists to open the windows here; see scripts/browser-test-host.mjs.
  GNOSIS_BROWSER_ON_HOST: '1',
  // Timing budgets log and do not fail, as on CI (tests/perf-budget.ts).
  GNOSIS_PERF: process.env.GNOSIS_PERF ?? '0',
  ...(workArea ? { GNOSIS_TEST_WORK_AREA: workArea } : {}),
};
const runner = [path.join(root, 'scripts/run-browser-suites.mjs'), '--weights', weights, ...forwarded];
if (!args.includes('--durations') && !args.includes('--list'))
  runner.push('--durations', 'browser-suite-durations-local.json');
const child = spawn(process.execPath, runner, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (status, signal) => process.exit(status ?? (signal ? 1 : 0)));
