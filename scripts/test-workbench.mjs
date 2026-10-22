import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';
const splitDiff = process.argv.includes('--split-diff');
const threads = process.argv.includes('--threads');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-workbench-test-'));
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const address = server.httpServer.address();
  const outfile = path.join(dir, 'test.cjs');
  await build({
    entryPoints: [
      threads
        ? 'tests/review-threads-browser.ts'
        : splitDiff
          ? 'tests/split-diff-browser.ts'
          : 'tests/workbench-browser.ts',
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = {
    ...process.env,
    GNOSIS_WORKBENCH_URL: `http://127.0.0.1:${address.port}/tests/fixtures/${splitDiff ? 'split-diff' : 'workbench'}.html`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Workbench browser checks timed out'));
    }, 90000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
