// Browser checks import 'electron' through this module (see scripts/electron-test-build.mjs).
// macOS clamps windows to the screen, so a 1280x1200 test window on a small CI display
// silently shrinks and size-dependent assertions time out. Allow every test window to
// exceed the display so layouts depend only on the sizes the tests ask for.
import * as electron from 'electron';
import fs from 'node:fs';

// A suite may preserve storage across reloads, but must not restore another suite's tabs.
if (process.env.GNOSIS_BROWSER_TEST_PROFILE) {
  electron.app.setPath('userData', process.env.GNOSIS_BROWSER_TEST_PROFILE);
}

// A suite passes only when it says so (#265). The runner reads the code a suite exits with from
// GNOSIS_TEST_RESULT_FILE and fails an Electron exit code of 0 that has no recorded success.
// That closes three ways a failing suite used to exit 0:
// - app.quit() exits 0 whatever process.exitCode says;
// - Electron quits by itself once the last window closes, which can win the race against a
//   suite's own app.exit(1) after `win.destroy(); await cleanup()`;
// - an exception or rejection outside the suite's try block is only logged.
const app = electron.app;
const resultFile = process.env.GNOSIS_TEST_RESULT_FILE;
const report = (code: number) => {
  if (resultFile) fs.writeFileSync(resultFile, String(code));
};
const exit = app.exit.bind(app);
app.exit = (code = 0) => {
  report(code);
  exit(code);
};
const quit = app.quit.bind(app);
app.quit = () => {
  const code = Number(process.exitCode ?? 0);
  if (code) app.exit(code);
  else {
    report(0);
    quit();
  }
};
// Suites end by calling app.exit() or app.quit(); one that forgets times out instead of passing.
app.on('window-all-closed', () => {});
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => {
    console.error(`${event}:`, error);
    app.exit(1);
  });
}

// @ts-expect-error -- Electron's typings use `export =`; esbuild re-exports the CommonJS module at bundle time.
export * from 'electron';

// capturePage() asks the compositor (Viz) for a copy of the current surface. Under Xvfb that
// request occasionally fails with "UnknownVizError", for example while a resize swaps the surface,
// and a later request succeeds. Screenshots are evidence, not assertions, so retry those failures.
const transientCapture = /UnknownVizError|VizSentEmptyBitmap|EmbeddingTokenChanged|Frame Gone|Timeout/;

export class BrowserWindow extends electron.BrowserWindow {
  constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
    super({ enableLargerThanScreen: true, ...options });
    const contents = this.webContents;
    const capturePage = contents.capturePage.bind(contents) as (...args: unknown[]) => Promise<Electron.NativeImage>;
    contents.capturePage = (async (...args: unknown[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await capturePage(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 3 || contents.isDestroyed() || !transientCapture.test(message)) throw error;
          console.warn(`capturePage failed (${message}); retrying`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }) as typeof contents.capturePage;
  }
}
// Electron recognises browser windows by constructor name (`win.constructor.name === 'BrowserWindow'` in
// BrowserWindow.getAllWindows and fromId). esbuild renames this subclass (e.g. "BrowserWindow2"), which would hide
// every test window from those lookups, so keep the name Electron expects.
Object.defineProperty(BrowserWindow, 'name', { value: 'BrowserWindow' });
