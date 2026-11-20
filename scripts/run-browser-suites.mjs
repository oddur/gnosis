#!/usr/bin/env node
// Runs the browser suites from `test:explainer`, `test:workbench` and `test:diagrams`, optionally one
// shard of them. The suite list comes from package.json, so nothing else needs updating when a suite
// is added. Every suite in the shard runs even after a failure; failures are listed at the end.
//
//   node scripts/run-browser-suites.mjs                 # all suites
//   node scripts/run-browser-suites.mjs --shard 2/6     # one balanced sixth
//   node scripts/run-browser-suites.mjs --list --shard 2/6
//   node scripts/run-browser-suites.mjs --durations out.json   # also record measured seconds
//   node scripts/run-browser-suites.mjs --perf          # suites with timing budgets, enforced (npm run test:perf)
//
// Performance tests run locally only; see "Performance tests" in docs/continuous-integration.md. CI runs every suite,
// with timing assertions report-only; --perf picks the suites whose test file uses tests/perf-budget.ts.
import { spawn } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

/** The npm scripts whose suites CI runs, in shards. */
export const CI_SCRIPTS = ['test:explainer', 'test:workbench', 'test:diagrams'];
/** A `scripts/test-workbench.mjs --flag` suite flag. */
export const SUITE_FLAG = /--[a-z0-9-]+/;
const workbenchCommand = new RegExp(`scripts/test-workbench\\.mjs(?:\\s+(${SUITE_FLAG.source}))?\\s*$`);

/** Every browser suite CI runs as `{ key, command }`, in package.json order. */
export function browserSuites(scripts) {
  const suites = [];
  for (const script of CI_SCRIPTS) {
    for (const part of String(scripts[script] ?? '').split('&&')) {
      const command = part.trim();
      if (!command) continue;
      const flag = workbenchCommand.exec(command)?.[1];
      const key = /test-workbench\.mjs/.test(command)
        ? (flag?.slice(2) ?? 'default')
        : /test-explainer\.mjs/.test(command)
          ? 'explainer'
          : command.replace(/^tsx --test tests\//, '').replace(/\.test\.ts$/, '') + '-unit';
      suites.push({ key, command });
    }
  }
  return suites;
}

/**
 * Each `scripts/test-workbench.mjs` flag and the test file it builds, from both forms the runner uses:
 * `process.argv.includes('--x') ? 'tests/x.ts'` and `const x = process.argv.includes('--x')` with `x ? 'tests/x.ts'`.
 */
export function workbenchSuiteFiles(runner = fs.readFileSync(path.join(root, 'scripts/test-workbench.mjs'), 'utf8')) {
  /** @type {Map<string, string>} */
  const files = new Map();
  const flag = `'(${SUITE_FLAG.source})'`;
  for (const [, name, file] of runner.matchAll(new RegExp(`process\\.argv\\.includes\\(${flag}\\) \\? '(tests/[\\w-]+\\.ts)'`, 'g')))
    files.set(name, file);
  const includes = `process\\.argv\\.includes\\('${SUITE_FLAG.source}'\\)`;
  for (const [, variable, test] of runner.matchAll(new RegExp(`const (\\w+) = (${includes}(?: \\|\\| ${includes})*);`, 'g'))) {
    const file = new RegExp(`[:?(]\\s*${variable}\\s*\\?\\s*'(tests/[\\w-]+\\.ts)'`).exec(runner)?.[1];
    for (const [name] of test.matchAll(new RegExp(SUITE_FLAG.source, 'g'))) if (file && !files.has(name)) files.set(name, file);
  }
  // With no flag the runner builds its last entry point.
  const fallback = /:\s*'(tests\/[\w-]+\.ts)',\s*\]/.exec(runner)?.[1];
  if (fallback) files.set('default', fallback);
  return files;
}

/** The test file a suite runs, or undefined when it cannot be told from the scripts. */
export function suiteFile(suite, files = workbenchSuiteFiles()) {
  if (suite.key === 'explainer') {
    const source = fs.readFileSync(path.join(root, 'scripts/test-explainer.mjs'), 'utf8');
    return [...source.matchAll(/'(tests\/[\w-]+-browser\.ts)'/g)].at(-1)?.[1];
  }
  if (suite.key.endsWith('-unit')) return /tests\/[\w-]+\.test\.ts/.exec(suite.command)?.[0];
  return files.get(suite.key === 'default' ? 'default' : `--${suite.key}`);
}

/**
 * Whether a test file uses tests/perf-budget.ts: it imports or re-exports it (with or without `.ts`), directly or
 * through another local module it imports.
 */
export function usesPerfBudget(file, seen = new Set()) {
  const full = path.resolve(root, file);
  if (seen.has(full) || !fs.existsSync(full)) return false;
  seen.add(full);
  const source = fs.readFileSync(full, 'utf8');
  for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (/(^|\/)perf-budget(\.ts)?$/.test(specifier)) return true;
    const target = path.resolve(path.dirname(full), specifier);
    const candidate = [target, `${target}.ts`, `${target}.tsx`].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (candidate && /\.(ts|tsx)$/.test(candidate) && usesPerfBudget(path.relative(root, candidate), seen)) return true;
  }
  return false;
}

/** The CI suites with timing or memory budgets: `npm run test:perf` runs these with the budgets enforced. */
export function perfSuites(scripts) {
  const files = workbenchSuiteFiles();
  return browserSuites(scripts).filter((suite) => {
    const file = suiteFile(suite, files);
    return file !== undefined && usesPerfBudget(file);
  });
}

/**
 * Greedy longest-first balancing over measured durations. Suites without a measurement get the
 * median, so a new suite lands in the lightest shard. The result is deterministic.
 */
export function shardSuites(suites, durations, index, count) {
  const known = suites
    .map((s) => durations[s.key])
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 20;
  const weight = (s) => (typeof durations[s.key] === 'number' ? durations[s.key] : median);
  const shards = Array.from({ length: count }, () => ({ total: 0, suites: [] }));
  const ordered = suites
    .map((s, order) => ({ ...s, order }))
    .sort((a, b) => weight(b) - weight(a) || a.order - b.order);
  for (const suite of ordered) {
    const lightest = shards.reduce((best, shard, i) => (shard.total < shards[best].total ? i : best), 0);
    shards[lightest].total += weight(suite);
    shards[lightest].suites.push(suite);
  }
  // Keep package.json order inside a shard so related suites stay together.
  return shards[index - 1].suites.sort((a, b) => a.order - b.order);
}

async function main() {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const durations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/browser-suite-durations.json'), 'utf8'));
  let all = browserSuites(scripts);
  const verify = argument('--verify');
  if (verify) {
    // Every suite must land in exactly one shard, or a CI shard silently skips it.
    const count = Number(verify);
    const seen = new Map();
    for (let i = 1; i <= count; i++)
      for (const s of shardSuites(all, durations, i, count)) seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
    const missing = all.filter((s) => seen.get(s.key) !== 1).map((s) => s.key);
    const keys = new Set(all.map((s) => s.key));
    if (missing.length || keys.size !== all.length)
      throw new Error(`Shards do not cover each suite exactly once: ${missing.join(', ') || 'duplicate suite keys'}`);
    const unmeasured = all.filter((s) => typeof durations[s.key] !== 'number').map((s) => s.key);
    console.log(
      `${all.length} browser suites cover ${count} shards exactly once.${unmeasured.length ? ` Unmeasured (median weight): ${unmeasured.join(', ')}` : ''}`
    );
    return;
  }
  if (process.argv.includes('--perf')) {
    // Timing assertions fail the run here, also in a container or on a runner (tests/perf-budget.ts).
    process.env.GNOSIS_PERF = '1';
    all = perfSuites(scripts);
  }
  const shard = argument('--shard');
  let selected = all;
  if (shard) {
    const [index, count] = shard.split('/').map(Number);
    if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid --shard ${shard}; expected i/n`);
    selected = shardSuites(all, durations, index, count);
  }
  if (process.argv.includes('--list')) {
    for (const suite of selected) console.log(`${String(durations[suite.key] ?? '?').padStart(4)}s  ${suite.key}`);
    return;
  }
  // Windows names the variable `Path`; extend whichever spelling exists so the child sees one entry.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [pathKey]: `${path.join(root, 'node_modules/.bin')}${path.delimiter}${process.env[pathKey] ?? ''}` };
  const measured = {};
  const failed = [];
  for (const suite of selected) {
    console.log(`\n▶ ${suite.key}: ${suite.command}`);
    const started = performance.now();
    const code = await new Promise((resolve) => {
      const child = spawn(suite.command, { cwd: root, env, shell: true, stdio: 'inherit' });
      child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
      child.on('error', () => resolve(1));
    });
    const seconds = Math.round((performance.now() - started) / 1000);
    measured[suite.key] = seconds;
    console.log(`${code === 0 ? '✔' : '✖'} ${suite.key} (${seconds}s)`);
    if (code !== 0) failed.push(suite.key);
  }
  const out = argument('--durations');
  if (out) fs.writeFileSync(out, JSON.stringify(measured, null, 2) + '\n');
  console.log(
    `\n${selected.length - failed.length}/${selected.length} browser suites passed${shard ? ` in shard ${shard}` : ''}.`
  );
  if (failed.length) {
    console.log(`Failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
