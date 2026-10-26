/** Disk budget for disposable GitHub data; independent of the renderer memory cache. */
export const GITHUB_CACHE_SIZES_MB = [128, 256, 512, 1024, 2048, 4096] as const;
export const DEFAULT_GITHUB_CACHE_MB = 512;
export function normalizeGitHubCacheMB(value: unknown): number {
  return typeof value === 'number' && GITHUB_CACHE_SIZES_MB.some(size => size === value) ? value : DEFAULT_GITHUB_CACHE_MB;
}
