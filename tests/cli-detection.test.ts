import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCliInstalled, resolveBinaryPath, setBinaryOverride } from '../lib/providers/shared';

void test('retry discovers a newly installed tool and updates the generation lookup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-cli-check-'));
  const name = `gnosis-fixture-${path.basename(directory)}`;
  const binary = path.join(directory, 'tool');
  t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('Not on shell PATH');
  });
  t.after(() => {
    setBinaryOverride(name, '');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(checkCliInstalled(name, [binary]).installed, false);
  fs.writeFileSync(binary, 'fixture');
  assert.equal(checkCliInstalled(name, [binary]).installed, false, 'ordinary checks can reuse the cache');
  assert.deepEqual(checkCliInstalled(name, [binary], true), { installed: true, resolvedPath: binary });
  assert.equal(resolveBinaryPath(name), binary, 'generation uses the refreshed path');

  const replacement = path.join(directory, 'moved-tool');
  fs.renameSync(binary, replacement);
  assert.deepEqual(checkCliInstalled(name, [binary, replacement], true), {
    installed: true,
    resolvedPath: replacement,
  });
  assert.equal(resolveBinaryPath(name), replacement);

  setBinaryOverride(name, binary);
  assert.deepEqual(
    checkCliInstalled(name, [replacement], true),
    { installed: false, resolvedPath: binary },
    'retry must not replace an explicit custom path with another installation'
  );
  fs.writeFileSync(binary, 'fixture');
  assert.deepEqual(checkCliInstalled(name, [replacement], true), { installed: true, resolvedPath: binary });
});
