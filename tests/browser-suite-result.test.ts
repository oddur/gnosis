import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { suiteExitCode } from '../scripts/electron-test-build.mjs';

const exitCode = suiteExitCode as (code: number | null, resultFile: string) => number;

void test('a browser suite passes only when Electron exits 0 and the suite reported success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-suite-result-'));
  const file = path.join(dir, 'result');
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(exitCode(0, file), 1, 'Exit 0 with no recorded result, as after app.quit() or an automatic quit');
    fs.writeFileSync(file, '1');
    assert.equal(exitCode(0, file), 1, 'Exit 0 although the suite recorded a failure');
    assert.equal(exitCode(1, file), 1);
    assert.equal(exitCode(null, file), 1, 'Killed by a signal');
    fs.writeFileSync(file, '0');
    assert.equal(exitCode(0, file), 0);
    assert.equal(exitCode(1, file), 1, 'A crash after reporting success still fails');
  } finally {
    console.error = quiet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('every Electron browser runner checks the reported suite result', () => {
  for (const runner of ['test-workbench.mjs', 'test-explainer.mjs', 'test-electron-smoke.mjs']) {
    const source = fs.readFileSync(path.join('scripts', runner), 'utf8');
    assert.match(source, /suiteExitCode\(/, `${runner} must not trust Electron's exit code alone`);
    assert.match(source, /\[suiteResultVariable\]/, `${runner} must give the suite a result file`);
  }
});
