/**
 * Which Gnosis build to update to, per update channel (#404).
 *
 * - **Stable** (the default) is unchanged: Squirrel reads update.electronjs.org on macOS and Windows, and Linux reads
 *   GitHub's latest release. update.electronjs.org skips GitHub prereleases and answers 204 unless its newest stable
 *   release is newer than the running version, so a stable user is never offered a prerelease and never downgraded.
 * - **Pre-release** lists the repository's releases, takes the newest by semver precedence (`resolveUpdate`), and
 *   points Squirrel at that release only when it is strictly newer than the running build (`updateFeedFor`).
 *
 * See docs/releasing.md for the release side.
 */
import type { UpdateInfo } from './types';
import { getGitHubClient } from './github-client';
import { isNewerVersion, isPrereleaseVersion, normalizeReleaseVersion, parseVersion, compareVersions } from './version';
import type { UpdateChannel } from './update-channel';

export { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel, type UpdateChannel } from './update-channel';

export const UPDATE_OWNER = 'oddur';
export const UPDATE_REPO = 'gnosis';
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** The fields of a GitHub release that the resolver reads. */
export interface ReleaseLike {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface ResolvedRelease {
  version: string;
  tag: string;
  /** A GitHub prerelease, or a version with a prerelease part. */
  prerelease: boolean;
  releaseUrl: string;
  assets: ReleaseAsset[];
}

/** True when a stable-channel user may ever see this release. Both the GitHub flag and the version must say stable. */
export function isStableRelease(release: ReleaseLike): boolean {
  return release.prerelease !== true && !isPrereleaseVersion(release.tag_name);
}

/**
 * The newest release the channel allows that is strictly newer than `currentVersion`, or null.
 * Both channels skip drafts and tags that are not versions. Stable skips every prerelease.
 * Pre-release takes the newest of either kind, so stable 0.42.0 replaces 0.42.0-beta.3.
 */
export function resolveUpdate(channel: UpdateChannel, currentVersion: string, releases: readonly ReleaseLike[]): ResolvedRelease | null {
  let best: { release: ReleaseLike; version: string } | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const version = normalizeReleaseVersion(release.tag_name);
    if (!parseVersion(version)) continue;
    if (channel === 'stable' && !isStableRelease(release)) continue;
    if (!best || (compareVersions(version, best.version) ?? 0) > 0) best = { release, version };
  }
  if (!best || !isNewerVersion(best.version, currentVersion)) return null;
  return {
    version: best.version,
    tag: best.release.tag_name,
    prerelease: !isStableRelease(best.release),
    releaseUrl: best.release.html_url,
    assets: best.release.assets ?? [],
  };
}

/** The feed Squirrel has always used: update.electronjs.org, which serves stable releases only. */
export function stableFeedUrl(platform: string, arch: string, currentVersion: string): string {
  return `https://update.electronjs.org/${UPDATE_OWNER}/${UPDATE_REPO}/${platform}-${arch}/${currentVersion}`;
}

/**
 * The Squirrel.Mac manifest the Release workflow attaches to each prerelease: `{"url": "<zip>", "name": "Gnosis <version>"}`.
 * Squirrel.Mac's default server type downloads whatever URL such a response names, so Gnosis points at it only after
 * `resolveUpdate` has chosen a newer release.
 */
export function macUpdateManifestName(arch: string): string {
  return `Gnosis-darwin-${arch}-update.json`;
}

export function releaseDownloadDirectory(tag: string): string {
  return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${encodeURIComponent(tag)}`;
}

export type FeedChoice =
  /** Point Squirrel at `url` and check. */
  | { kind: 'feed'; url: string; target: ResolvedRelease | null }
  /** Nothing newer on this channel: do not check, so Squirrel never fetches an older build. */
  | { kind: 'none' }
  /** A newer build exists, but this platform cannot install it automatically. Offer the release page. */
  | { kind: 'manual'; target: ResolvedRelease; reason: string };

/**
 * Where Squirrel should look. Stable always uses update.electronjs.org, without listing releases.
 * Pre-release uses it too when the newest build is a stable release, and otherwise the chosen prerelease's own assets:
 * on macOS its JSON manifest, on Windows its download directory, which holds `RELEASES` and the `.nupkg`.
 */
export function updateFeedFor(options: {
  channel: UpdateChannel;
  platform: string;
  arch: string;
  currentVersion: string;
  target: ResolvedRelease | null;
}): FeedChoice {
  const { channel, platform, arch, currentVersion, target } = options;
  if (channel === 'stable') return { kind: 'feed', url: stableFeedUrl(platform, arch, currentVersion), target: null };
  if (!target || !isNewerVersion(target.version, currentVersion)) return { kind: 'none' };
  if (!target.prerelease) return { kind: 'feed', url: stableFeedUrl(platform, arch, currentVersion), target };
  if (platform === 'darwin') {
    const manifest = target.assets.find((asset) => asset.name === macUpdateManifestName(arch));
    return manifest
      ? { kind: 'feed', url: manifest.browser_download_url, target }
      : { kind: 'manual', target, reason: `v${target.version} has no macOS ${arch} update manifest` };
  }
  if (platform === 'win32') {
    const names = target.assets.map((asset) => asset.name);
    return names.includes('RELEASES') && names.some((name) => name.endsWith('-full.nupkg'))
      ? { kind: 'feed', url: releaseDownloadDirectory(target.tag), target }
      : { kind: 'manual', target, reason: `v${target.version} has no Windows update package` };
  }
  return { kind: 'manual', target, reason: 'This platform updates by download' };
}

/** The first page of releases, newest first. Enough to find the newest build; drafts are not visible without push access. */
export async function listReleases(token?: string): Promise<ReleaseLike[]> {
  const { data } = await getGitHubClient(token).repos.listReleases({ owner: UPDATE_OWNER, repo: UPDATE_REPO, per_page: 30 });
  return data;
}

/** Linux, which has no auto-update: the newer release to offer as a download, or null. */
export async function checkForUpdate(currentVersion: string, token?: string, channel: UpdateChannel = 'stable'): Promise<UpdateInfo | null> {
  try {
    if (channel === 'prerelease') {
      const target = resolveUpdate('prerelease', currentVersion, await listReleases(token));
      return target ? { version: target.version, releaseUrl: target.releaseUrl, prerelease: target.prerelease } : null;
    }
    // GitHub's "latest" release is never a prerelease or a draft.
    const { data } = await getGitHubClient(token).repos.getLatestRelease({ owner: UPDATE_OWNER, repo: UPDATE_REPO });
    const target = resolveUpdate('stable', currentVersion, [data]);
    return target ? { version: target.version, releaseUrl: target.releaseUrl, prerelease: false } : null;
  } catch {
    return null;
  }
}
