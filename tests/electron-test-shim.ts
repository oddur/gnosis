// Browser checks import 'electron' through this module (see scripts/electron-test-build.mjs).
// macOS clamps windows to the screen, so a 1280x1200 test window on a small CI display
// silently shrinks and size-dependent assertions time out. Allow every test window to
// exceed the display so layouts depend only on the sizes the tests ask for.
import * as electron from 'electron';

// A suite may preserve storage across reloads, but must not restore another suite's tabs.
if (process.env.GNOSIS_BROWSER_TEST_PROFILE) {
  electron.app.setPath('userData', process.env.GNOSIS_BROWSER_TEST_PROFILE);
}

// Electron's app.quit() exits with code 0 whatever process.exitCode says, so a suite that
// records a failure and then quits would pass (#265). Every suite goes through this shim, so
// make quit() honour a failure code here rather than relying on each suite calling app.exit(1).
const quit = electron.app.quit.bind(electron.app);
electron.app.quit = () => {
  const code = Number(process.exitCode ?? 0);
  if (code) electron.app.exit(code);
  else quit();
};

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
