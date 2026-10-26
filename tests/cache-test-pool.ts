import { createGitHubClientPool as createPool } from '../lib/github-client';
export * from '../lib/github-client';
const pools = new Set<ReturnType<typeof createPool>>();
export function createGitHubClientPool(...args: Parameters<typeof createPool>) {
  const pool = createPool(...args);
  pools.add(pool);
  return pool;
}
export async function flushCaches() {
  await Promise.all([...pools].map((pool) => pool.flushStorage()));
}
export async function closeCaches() {
  await Promise.all([...pools].map((pool) => pool.closeStorage()));
  pools.clear();
}
