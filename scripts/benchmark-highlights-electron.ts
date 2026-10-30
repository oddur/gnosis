import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { HighlightSample } from '../tests/fixtures/highlights-benchmark';

app.on('window-all-closed', () => {
  /* Keep the benchmark alive between trials. */
});

const cut = (source: string, max: number) => source.slice(0, source.lastIndexOf('\n', max));
const samples: HighlightSample[] = [
  {
    name: 'PrFileInspection.tsx',
    lang: 'tsx',
    source: fs.readFileSync('components/PrFileInspection.tsx', 'utf8').trimEnd(),
  },
  {
    name: 'PrFileInspection-added.tsx',
    lang: 'tsx',
    source: fs.readFileSync('components/PrFileInspection.tsx', 'utf8').trimEnd(),
    added: true,
  },
  { name: 'main-excerpt.ts', lang: 'typescript', source: cut(fs.readFileSync('src/main.ts', 'utf8'), 80_000) },
  { name: 'globals-excerpt.css', lang: 'css', source: cut(fs.readFileSync('src/globals.css', 'utf8'), 80_000) },
  {
    name: 'package-lock-excerpt.json',
    lang: 'json',
    source: cut(fs.readFileSync('package-lock.json', 'utf8'), 80_000),
  },
  { name: 'main-large.ts', lang: 'typescript', source: fs.readFileSync('src/main.ts', 'utf8').trimEnd() },
  { name: 'globals-large.css', lang: 'css', source: fs.readFileSync('src/globals.css', 'utf8').trimEnd() },
  { name: 'package-lock-large.json', lang: 'json', source: fs.readFileSync('package-lock.json', 'utf8').trimEnd() },
];
void app.whenReady().then(async () => {
  const output = process.env.GNOSIS_BENCHMARK_OUTPUT ?? '/tmp/gnosis-highlights-results.json';
  const url = process.env.GNOSIS_BENCHMARK_URL;
  if (!url) throw new Error('Missing benchmark URL');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const runs: unknown[] = [];
  let win: BrowserWindow | undefined;
  try {
    // Alternate order to reduce systematic warm-up/thermal bias. Each trial has its own renderer.
    for (const backend of ['shiki-js', 'highlights', 'highlights', 'shiki-js', 'shiki-js', 'highlights']) {
      win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: true,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      win.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) console.log(message);
      });
      await win.loadURL(url);
      for (let i = 0; !(await win.webContents.executeJavaScript('!!window.benchmarkHighlights')); i++) {
        if (i > 600) throw new Error('Benchmark page did not initialize');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const result: unknown = await win.webContents.executeJavaScript(
        `window.benchmarkHighlights(${JSON.stringify(backend)},${JSON.stringify(samples)},5)`
      );
      runs.push(result);
      // capturePage can otherwise return the previous compositor frame on macOS.
      if (process.platform === 'darwin') app.show();
      win.show();
      win.focus();
      await new Promise((resolve) => setTimeout(resolve, 250));
      fs.writeFileSync(
        output.replace(/\.json$/, '') + `-${backend}.png`,
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`Completed ${backend} trial ${runs.length}/6`);
      win.destroy();
      win = undefined;
    }
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          versions: process.versions,
          platform: process.platform,
          arch: process.arch,
          cpu: os.cpus()[0]?.model,
          date: new Date().toISOString(),
          samples: samples.map(({ name, lang, source, added }) => ({
            name,
            lang,
            added: !!added,
            characters: source.length,
            lines: source.split('\n').length,
            sha256: createHash('sha256').update(source).digest('hex'),
          })),
          runs,
        },
        null,
        2
      )
    );
    console.log(`Results: ${output}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    win?.destroy();
    app.exit(1);
  }
});
