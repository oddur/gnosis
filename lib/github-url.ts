/**
 * Build a base URL for linking to files on GitHub at a specific commit.
 * Returns null when headSha is missing (e.g. loaded reviews without SHA).
 */
export function buildFileUrlBase(prUrl: string, headSha?: string): string | null {
  if (!headSha) return null;
  const match = prUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\//);
  if (!match) return null;
  return `${match[1]}/blob/${headSha}/`;
}
