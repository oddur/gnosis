// Shared offline renderer for live evaluations. Electron runs only in the browser-test environment.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import electron from 'electron';
import { requireBrowserTestEnvironment } from './browser-test-host.mjs';

requireBrowserTestEnvironment();
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: render-illustration.mjs input.json output.json');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-svg-render-'));
try {
  const outfile = path.join(temp, 'render.cjs');
  await build({
    stdin: {
      contents: `import {app} from 'electron';import fs from 'node:fs';import {validateSvgIllustrationInBrowser} from './src/explainer-validation';app.whenReady().then(async()=>{try{const result=await validateSvgIllustrationInBrowser(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));fs.writeFileSync(process.argv[3],JSON.stringify(result));app.exit(0);}catch(error){console.error(String(error));app.exit(1);}});`,
      resolveDir: process.cwd(),
    },
    outfile,
    bundle: true,
    platform: 'node',
    external: ['electron'],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile, path.resolve(input), path.resolve(output)], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Illustration rendering timed out'));
    }, 90_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Illustration rendering failed'));
    });
  });
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
