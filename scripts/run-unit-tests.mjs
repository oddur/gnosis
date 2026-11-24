#!/usr/bin/env node
// Runs the unit tests from `npm test`, optionally one shard of them. CI splits the Windows unit tests this way: there,
// spawning git is slow and tests/conflict-resolution.test.ts alone ran for 16 minutes.
//
//   node scripts/run-unit-tests.mjs                 # every file, as npm test
//   node scripts/run-unit-tests.mjs --shard 2/2     # one half
//   node scripts/run-unit-tests.mjs --list --shard 2/2
//
// The file list comes from the `test` script in package.json. A file that uses tests/support/test-part.ts (directly,
// or by importing a test file that does) runs in every shard with GNOSIS_TEST_PART=i/n, so each shard runs its part of
// that file's tests. Every other file runs in one shard, dealt out in package.json order.
import { spawn } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

/**
 * The test files `npm test` runs, in order.
 * @param {Record<string, string>} scripts
 * @returns {string[]}
 */
export function unitTestFiles(scripts) {
  const match = /^tsx --test ((?:tests\/[\w.-]+\.test\.tsx?\s*)+)$/.exec(String(scripts.test ?? '').trim());
  if (!match) throw new Error('The test script in package.json is not `tsx --test <files>`');
  return match[1].trim().split(/\s+/);
}

/**
 * Whether a test file may split its tests by GNOSIS_TEST_PART: it imports tests/support/test-part.ts (any specifier
 * that names it), or imports a test file that does. A file found here runs in every shard; one that only uses the
 * helpers, not its `test`, then runs whole in each, which costs time but loses no test.
 * @param {string} file
 * @returns {boolean}
 */
export function usesTestPart(file, seen = new Set()) {
  const full = path.resolve(root, file);
  if (seen.has(full) || !fs.existsSync(full)) return false;
  seen.add(full);
  const source = fs.readFileSync(full, 'utf8');
  for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    if (specifier.includes('support/test-part')) return true;
    if (specifier.startsWith('.') && /\.test(\.tsx?)?$/.test(specifier)) {
      const target = path.resolve(path.dirname(full), specifier);
      const candidate = [target, `${target}.ts`, `${target}.tsx`].find(
        (f) => fs.existsSync(f) && fs.statSync(f).isFile()
      );
      if (candidate && usesTestPart(path.relative(root, candidate), seen)) return true;
    }
  }
  return false;
}

/**
 * The files shard `index` of `count` runs, and which of them run only their part of the tests.
 * @param {string[]} files
 * @param {number} index
 * @param {number} count
 * @returns {{ files: string[], parted: string[] }}
 */
export function unitShard(files, index, count, split = usesTestPart) {
  const parted = files.filter((file) => split(file));
  const whole = files.filter((file) => !split(file)).filter((_, i) => i % count === index - 1);
  return { files: files.filter((file) => parted.includes(file) || whole.includes(file)), parted };
}

/**
 * The `tsx --test` processes one shard starts: the whole files, with GNOSIS_TEST_PART removed so none of them can lose
 * tests, and the split files, with GNOSIS_TEST_PART=index/count.
 * @param {string[]} files
 * @param {number} index
 * @param {number} count
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string, files: string[], env: NodeJS.ProcessEnv }[]}
 */
export function shardRuns(files, index, count, env = process.env, split = usesTestPart) {
  const { files: selected, parted } = unitShard(files, index, count, split);
  const rest = { ...env };
  delete rest.GNOSIS_TEST_PART;
  const runs = [
    { name: 'whole files', files: selected.filter((file) => !parted.includes(file)), env: rest },
    {
      name: `split files, part ${index}/${count}`,
      files: parted,
      env: { ...rest, GNOSIS_TEST_PART: `${index}/${count}` },
    },
  ];
  return runs.filter((run) => run.files.length > 0);
}

// Spawn tsx's CLI with this Node, not node_modules/.bin/tsx: on Windows that is a .cmd shim that needs a shell.
const tsx = () => createRequire(import.meta.url).resolve('tsx/cli');

/**
 * Runs one `tsx --test` process and resolves with its exit code.
 * @param {{ files: string[], env: NodeJS.ProcessEnv }} run
 * @param {'inherit' | 'pipe'} stdio
 * @returns {Promise<{ code: number, output: string }>}
 */
function runTests(run, stdio) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx(), '--test', ...run.files], { cwd: root, env: run.env, stdio });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.on('exit', (status, signal) => resolve({ code: status ?? (signal ? 1 : 0), output }));
    child.on('error', (error) => resolve({ code: 1, output: output + String(error) }));
  });
}

async function main() {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const files = unitTestFiles(scripts);
  const shard = argument('--shard');
  let runs = [{ name: 'all files', files, env: process.env }];
  if (shard) {
    const [index, count] = shard.split('/').map(Number);
    if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid --shard ${shard}; expected i/n`);
    runs = shardRuns(files, index, count);
  }
  if (process.argv.includes('--list')) {
    for (const run of runs) for (const file of run.files) console.log(`${run.name}\t${file}`);
    return;
  }
  const total = runs.reduce((sum, run) => sum + run.files.length, 0);
  console.log(`Running ${total} of ${files.length} unit test files${shard ? ` (shard ${shard})` : ''}.`);
  // The runs go in parallel. The first prints as it goes; the others print when they finish, so lines don't interleave.
  const results = await Promise.all(runs.map((run, i) => runTests(run, i === 0 ? 'inherit' : 'pipe')));
  results.forEach((result, i) => {
    if (i > 0) console.log(`\n── ${runs[i].name} ──\n${result.output}`);
  });
  const failed = runs.filter((_, i) => results[i].code !== 0).map((run) => run.name);
  if (failed.length) console.log(`\nFailed: ${failed.join(', ')}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
