import fs from 'node:fs';
import path from 'node:path';

const marker = 'clear-github-cache.json';
function savedWorkbench(directory: string): Record<string, unknown> | undefined {
  const file = path.join(directory, 'workbench.json');
  if (!fs.existsSync(file)) return;
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Could not read the review queue. Its saved briefings have not been deleted.');
  return value as Record<string, unknown>;
}
/** Defer deletion until startup, when no old request can write its response back. */
export function requestGitHubCacheClear(directory: string) {
  savedWorkbench(directory); // Fail before restarting if we cannot preserve generated/user data.
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, marker), '1', { mode: 0o600 });
}
export async function applyPendingGitHubCacheClear(directory: string, clearBrowserCache: () => Promise<void>) {
  const request = path.join(directory, marker);
  if (!fs.existsSync(request)) return false;
  const state = savedWorkbench(directory);
  if (state) {
    const retained = Object.fromEntries(
      ['account', 'credentialKey', 'overrides', 'briefs', 'day', 'used', 'filters']
        .filter((key) => key in state)
        .map((key) => [key, state[key]])
    );
    const file = path.join(directory, 'workbench.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...retained, subjects: [] }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  for (const name of ['github-cache.json', 'github-cache.json.tmp', 'workbench.json.tmp'])
    fs.rmSync(path.join(directory, name), { force: true });
  await clearBrowserCache();
  // Keep the request after a failure so the next launch can retry safely.
  fs.rmSync(request);
  return true;
}
