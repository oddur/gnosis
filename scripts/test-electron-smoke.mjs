import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import electron from 'electron';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-electron-smoke-'));
try {
  for (const [entry, output] of [
    ['tests/electron-smoke.ts', 'smoke.cjs'],
    ['src/preload.ts', 'preload.cjs'],
    ['src/app-data-worker.ts', 'app-data-worker.js'],
  ]) {
    await build({
      entryPoints: [entry],
      outfile: path.join(directory, output),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
  }
  const env = { ...process.env, GNOSIS_SMOKE_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(directory, 'smoke.cjs')], { env, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Electron smoke test timed out'));
      else resolve(code);
    });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
