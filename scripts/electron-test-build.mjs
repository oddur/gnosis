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
