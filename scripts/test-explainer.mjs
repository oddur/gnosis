import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-browser-test-'));
try {
  const outfile = path.join(dir, 'explainer.cjs');
  await build({
    entryPoints: ['tests/fixtures/explainer-ui.tsx'],
    outfile: path.join(dir, 'ui.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
  });
  fs.writeFileSync(
    path.join(dir, 'ui.html'),
    '<html><body><div id="root"></div><script src="ui.js"></script></body></html>'
  );
  await build({
    entryPoints: ['tests/explainer-browser.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Browser tests timed out'));
    }, 60000);
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
  fs.rmSync(dir, { recursive: true, force: true });
}
