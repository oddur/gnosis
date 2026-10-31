import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-highlights-benchmark-'));
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const address = server.httpServer.address();
  const outfile = path.join(directory, 'benchmark.cjs');
  await build({
    entryPoints: ['scripts/benchmark-highlights-electron.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = {
    ...process.env,
    GNOSIS_BENCHMARK_URL: `http://127.0.0.1:${address.port}/tests/fixtures/highlights-benchmark.html`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Highlighter benchmark timed out'));
    }, 300_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
} finally {
  await server.close();
  await fs.rm(directory, { recursive: true, force: true });
}
