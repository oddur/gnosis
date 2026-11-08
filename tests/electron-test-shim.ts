// Browser checks import 'electron' through this module (see scripts/electron-test-build.mjs).
// macOS clamps windows to the screen, so a 1280x1200 test window on a small CI display
// silently shrinks and size-dependent assertions time out. Allow every test window to
// exceed the display so layouts depend only on the sizes the tests ask for.
import * as electron from 'electron';

// A suite may preserve storage across reloads, but must not restore another suite's tabs.
if (process.env.GNOSIS_BROWSER_TEST_PROFILE) {
  electron.app.setPath('userData', process.env.GNOSIS_BROWSER_TEST_PROFILE);
}

// @ts-expect-error -- Electron's typings use `export =`; esbuild re-exports the CommonJS module at bundle time.
export * from 'electron';

export class BrowserWindow extends electron.BrowserWindow {
  constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
    super({ enableLargerThanScreen: true, ...options });
  }
}
