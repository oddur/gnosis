import console from 'node:console';
import path from 'node:path';
import process from 'node:process';

const suites = new Set([
  'test:explainer',
  'test:workbench',
  'test:diagrams',
  'test:browser-smoke',
  'test:electron-smoke',
]);

/**
 * Browser checks open real Electron windows that take focus, so on a dev machine they run in
 * Docker (npm run test:browser:docker). CI and the container run them directly; set
 * GNOSIS_BROWSER_ON_HOST=1 to run them on this machine anyway.
 */
export function requireBrowserTestEnvironment() {
  if (process.env.CI || process.env.GNOSIS_IN_DOCKER || process.env.GNOSIS_BROWSER_ON_HOST) return;
  const script = path.relative(process.cwd(), process.argv[1]).split(path.sep).join('/');
  const args = process.argv.slice(2);
  const event = process.env.npm_lifecycle_event;
  const command = suites.has(event)
    ? `npm run test:browser:docker -- npm run ${event}`
    : script === 'scripts/test-workbench.mjs' && args.length
      ? `npm run test:browser:docker -- ${args.join(' ')}`
      : `npm run test:browser:docker -- node ${[script, ...args].join(' ')}`;
  console.error(
    `Browser checks open Electron windows that take focus. Run them in Docker instead:\n\n  ${command}\n\n` +
      'Set GNOSIS_BROWSER_ON_HOST=1 to run them on this machine.'
  );
  process.exit(1);
}
