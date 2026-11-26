#!/usr/bin/env node
// Captures the documentation screenshots from the real app UI, rendered from the browser-test fixtures with synthetic
// data. It runs in the Docs screenshots workflow (.github/workflows/docs-screenshots.yml) on a macOS runner; like the
// browser suites, it opens Electron windows, so it does not run on a developer's machine (scripts/browser-test-host.mjs).
//
//   node scripts/capture-docs-screenshots.mjs                    # every recipe in scripts/docs-screenshots.json
//   node scripts/capture-docs-screenshots.mjs --only queue,overview
//   DOCS_SCREENSHOTS_ONLY="queue overview" node scripts/capture-docs-screenshots.mjs
//
// For each recipe and theme it writes site/public/docs/screenshots/<name>-<theme>.webp (1600w) and
// <name>-<theme>-small.webp (960w), WebP quality 86, each with a .json provenance sidecar. An image whose pixels did
// not change keeps its old file and sidecar, so a run that changes nothing leaves the tree clean. It prints a summary
// and writes it to --report (JSON) for the workflow's pull request; it exits 1, naming each recipe, if any scene did
// not render.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import console from 'node:console';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import electron from 'electron';
import { createServer } from 'vite';
import { requireBrowserTestEnvironment } from './browser-test-host.mjs';
import { electronTestShim, suiteResultVariable } from './electron-test-build.mjs';
import {
  OUTPUT_WIDTHS,
  THEMES,
  WEBP_QUALITY,
  imagePaths,
  provenance,
  selectRecipes,
  validateRecipes,
} from './docs-screenshot-recipes.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

/** sharp is not an app dependency. The workflow installs it outside node_modules and names it in GNOSIS_SHARP_DIR. */
async function loadSharp() {
  const from = process.env.GNOSIS_SHARP_DIR ? path.join(path.resolve(process.env.GNOSIS_SHARP_DIR), 'package.json') : import.meta.url;
  try {
    const sharp = createRequire(from)('sharp');
    return sharp.default ?? sharp;
  } catch (error) {
    throw new Error(`sharp is needed to write WebP files: install it (npm install --prefix <dir> sharp) and set GNOSIS_SHARP_DIR=<dir>. ${error.message}`);
  }
}

/** True when two images have the same size and nearly the same pixels: rendering noise is not a change. */
async function samePixels(sharp, a, b) {
  const [left, right] = await Promise.all([a, b].map((input) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return false;
  let different = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (Math.max(Math.abs(left.data[i] - right.data[i]), Math.abs(left.data[i + 1] - right.data[i + 1]), Math.abs(left.data[i + 2] - right.data[i + 2]), Math.abs(left.data[i + 3] - right.data[i + 3])) > 8) different++;
  }
  return different <= (left.info.width * left.info.height) / 2000;
}

const recipesFile = 'scripts/docs-screenshots.json';
const { sceneNames } = await import('./docs-screenshot-steps.ts').catch(() => ({ sceneNames: undefined }));
const all = validateRecipes(JSON.parse(fs.readFileSync(recipesFile, 'utf8')), sceneNames ? { scenes: sceneNames } : {});
const selected = selectRecipes(all, argument('--only') ?? process.env.DOCS_SCREENSHOTS_ONLY);
const report = argument('--report');
const placeholders = selected.filter((recipe) => recipe.placeholder);
const recipes = selected.filter((recipe) => !recipe.placeholder);
console.log(`Docs screenshots: ${recipes.length} recipe(s) in ${THEMES.length} themes${placeholders.length ? `; placeholders skipped: ${placeholders.map((r) => r.name).join(', ')}` : ''}`);

requireBrowserTestEnvironment();
const sharp = await loadSharp();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-docs-screenshots-'));
const shots = path.join(dir, 'shots');
fs.mkdirSync(shots);

// The same fixed moment as the browser suites (scripts/test-workbench.mjs), so fixture dates read the same.
const fixtureClockOffset = String(Date.parse('2026-11-20T12:00:00Z') - Date.now());
const fixtureClock = {
  name: 'fixture-clock',
  transformIndexHtml: () => [
    {
      tag: 'script',
      attrs: { type: 'module' },
      children: `import { shiftClock } from '/tests/fixture-clock.ts'; shiftClock(${fixtureClockOffset});`,
      injectTo: 'head-prepend',
    },
  ],
};

let results = [];
const server = await createServer({
  configFile: 'vite.renderer.config.ts',
  plugins: [fixtureClock],
  cacheDir: path.resolve('node_modules/.vite-workbench', createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)),
  server: { host: '127.0.0.1', port: 0 },
});
try {
  await server.listen();
  const { port } = server.httpServer.address();
  const outfile = path.join(dir, 'capture.cjs');
  await build({ entryPoints: ['scripts/docs-screenshot-capture.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [electronTestShim] });
  const env = {
    ...process.env,
    GNOSIS_BROWSER_TEST_PROFILE: path.join(dir, 'profile'),
    GNOSIS_FIXTURE_CLOCK_OFFSET: fixtureClockOffset,
    [suiteResultVariable]: path.join(dir, 'result'),
    GNOSIS_WORKBENCH_URL: `http://127.0.0.1:${port}/tests/fixtures/workbench.html`,
    GNOSIS_DOCS_FIXTURES: `http://127.0.0.1:${port}/tests/fixtures/`,
    GNOSIS_DOCS_RECIPES: JSON.stringify(recipes),
    GNOSIS_DOCS_OUT: shots,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // A scene loads its fixture and settles in seconds; two minutes per capture leaves room for a stalled load's retry.
  // Capped below the workflow's 90-minute job limit, so a slow run still writes the scenes it captured and its report.
  const timeoutMs = Math.min(120_000 + recipes.length * THEMES.length * 120_000, 80 * 60_000);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      console.error(`Docs screenshot capture timed out after ${timeoutMs / 60000} minutes; keeping the scenes it captured.`);
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const resultsFile = path.join(shots, 'results.json');
  results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
  if (code !== 0 && !results.some((result) => result.error)) console.error(`Electron exited with ${code} before it reported every capture.`);
} finally {
  await server.close();
}

const createdAt = new Date().toISOString();
const written = [];
const unchanged = [];
for (const result of results.filter((entry) => entry.png)) {
  const recipe = recipes.find((entry) => entry.name === result.name);
  const files = imagePaths(result.name, result.theme);
  for (const [size, file] of Object.entries(files)) {
    const width = OUTPUT_WIDTHS[size];
    const webp = await sharp(result.png).resize({ width, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer();
    if (fs.existsSync(file) && (await samePixels(sharp, webp, fs.readFileSync(file)))) {
      unchanged.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, webp);
    const { width: actual } = await sharp(webp).metadata();
    fs.writeFileSync(`${file}.json`, `${JSON.stringify(provenance({ recipe, theme: result.theme, commit, width: actual ?? width, createdAt }), null, 2)}\n`);
    written.push(file);
  }
}
const captured = new Set(results.filter((entry) => entry.png).map((entry) => `${entry.name}:${entry.theme}`));
const failed = [
  ...results.filter((entry) => entry.error),
  ...recipes.flatMap((recipe) => THEMES.filter((theme) => !captured.has(`${recipe.name}:${theme}`) && !results.some((entry) => entry.name === recipe.name && entry.theme === theme)).map((theme) => ({ name: recipe.name, theme, error: 'not captured: the capture stopped before this scene' }))),
];
fs.rmSync(dir, { recursive: true, force: true });

const summary = { commit, written, unchanged, placeholders: placeholders.map((recipe) => recipe.name), failed };
if (report) fs.writeFileSync(report, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Docs screenshots: ${written.length} file(s) written, ${unchanged.length} unchanged.`);
if (failed.length) {
  console.error(`${failed.length} scene(s) did not render:\n${failed.map((entry) => `  recipe "${entry.name}" (${entry.theme}): ${entry.error}`).join('\n')}`);
  process.exitCode = 1;
}
