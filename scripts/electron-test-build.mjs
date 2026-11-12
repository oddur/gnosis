import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';

const shim = path.resolve('tests/electron-test-shim.ts');

/** Routes test imports of 'electron' through the display-independent shim. */
export const electronTestShim = {
  name: 'electron-test-shim',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, (args) =>
      args.importer === shim ? { path: 'electron', external: true } : { path: shim }
    );
  },
};

/** Where tests/electron-test-shim.ts records the code a suite exited with. */
export const suiteResultVariable = 'GNOSIS_TEST_RESULT_FILE';

/**
 * Electron's own exit code is not enough: it is 0 when the app quits by itself or through app.quit().
 * A suite passes only when Electron exits 0 and the suite recorded success through the shim.
 */
export function suiteExitCode(code, resultFile) {
  if (code !== 0) return 1;
  const reported = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null;
  if (reported === '0') return 0;
  console.error(
    reported === null
      ? 'Electron exited 0, but the suite never reported success. End it with app.exit(0), or app.exit(1) on failure.'
      : `Electron exited 0, but the suite reported exit code ${reported}.`
  );
  return 1;
}
