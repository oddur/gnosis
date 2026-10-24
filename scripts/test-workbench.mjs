import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';
const diffSpeed = process.argv.includes('--diff-speed');
const commits = process.argv.includes('--commits');
const changes = process.argv.includes('--changes');
const queueMetadata = process.argv.includes('--queue-metadata');
const authors = process.argv.includes('--authors');
const commandCenter = process.argv.includes('--commands');
const performance = process.argv.includes('--performance');
const polish = process.argv.includes('--polish');
const hardening = process.argv.includes('--hardening');
const auth = process.argv.includes('--auth');
const onboarding = process.argv.includes('--onboarding');
const images = process.argv.includes('--images');
const splitDiff = process.argv.includes('--split-diff');
const threads = process.argv.includes('--threads');
const prSummary = process.argv.includes('--pr-summary');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-workbench-test-'));
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const address = server.httpServer.address();
  const outfile = path.join(dir, 'test.cjs');
  await build({
    entryPoints: [
      diffSpeed ? 'tests/diff-navigation-browser.ts' : commits ? 'tests/pr-commits-browser.ts' : changes ? 'tests/pr-changes-browser.ts' : queueMetadata ? 'tests/queue-metadata-browser.ts' : authors ? 'tests/github-author-browser.ts' : commandCenter ? 'tests/command-center-browser.ts' : performance ? 'tests/queue-performance-browser.ts' : polish
        ? 'tests/polish-browser.ts'
        : hardening
          ? 'tests/hardening-browser.ts'
          : auth
            ? 'tests/github-auth-browser.ts'
            : onboarding
              ? 'tests/onboarding-browser.ts'
              : images
                ? 'tests/review-images-browser.ts'
                : prSummary
                  ? 'tests/pr-summary-browser.ts'
                  : threads
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
    const timer = setTimeout(
      () => {
        child.kill();
        reject(new Error('Workbench browser checks timed out'));
      },
      splitDiff || threads ? 90000 : prSummary ? 180000 : 300000
    );
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
