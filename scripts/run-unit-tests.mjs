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
 * Whether a test file splits its tests by GNOSIS_TEST_PART: it takes `test` from tests/support/test-part.ts, or imports a
 * test file that does.
 * @param {string} file
 * @returns {boolean}
 */
export function usesTestPart(file, seen = new Set()) {
  const full = path.resolve(root, file);
  if (seen.has(full) || !fs.existsSync(full)) return false;
  seen.add(full);
  const source = fs.readFileSync(full, 'utf8');
  if (/^import\s*\{\s*test\s*\}\s*from\s*['"]\.\/support\/test-part(\.ts)?['"]/m.test(source)) return true;
  for (const [, specifier] of source.matchAll(/(?:\bfrom|^import)\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    if (/\.test(\.tsx?)?$/.test(specifier)) {
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

async function main() {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const files = unitTestFiles(scripts);
  const shard = argument('--shard');
  let selected = files;
  let parted = [];
  const env = { ...process.env };
  if (shard) {
    const [index, count] = shard.split('/').map(Number);
    if (!(count >= 1 && index >= 1 && index <= count)) throw new Error(`Invalid --shard ${shard}; expected i/n`);
    ({ files: selected, parted } = unitShard(files, index, count));
    env.GNOSIS_TEST_PART = `${index}/${count}`;
  }
  if (process.argv.includes('--list')) {
    for (const file of selected) console.log(`${parted.includes(file) ? `part ${shard}` : 'whole'}\t${file}`);
    return;
  }
  console.log(`Running ${selected.length} of ${files.length} unit test files${shard ? ` (shard ${shard})` : ''}.`);
  // Spawn tsx's CLI with this Node, not node_modules/.bin/tsx: on Windows that is a .cmd shim that needs a shell.
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, '--test', ...selected], { cwd: root, env, stdio: 'inherit' });
    child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
  process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
