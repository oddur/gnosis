/**
 * The update channel preference (#404). Renderer-safe: no GitHub client or Node imports.
 * See lib/updater.ts for how each channel picks a build.
 */
import { isPrereleaseVersion } from './version';

export type UpdateChannel = 'stable' | 'prerelease';
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

/** Anything but an explicit `'prerelease'` is the stable channel. */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === 'prerelease' ? 'prerelease' : 'stable';
}

export const UPDATE_CHANNEL_LABEL: Record<UpdateChannel, string> = { stable: 'Stable', prerelease: 'Pre-release' };

/** Plain copy for Settings › Updates. */
export const UPDATE_CHANNEL_DESCRIPTION: Record<UpdateChannel, string> = {
  stable: 'Tested releases. Recommended.',
  prerelease:
    'Early builds from main, before they become a stable release. Expect rough edges, and report problems with Send feedback.',
};

/**
 * On Stable with a pre-release build: Gnosis never goes back to an older version, so it waits for the next stable
 * release. Null when the running build is not a pre-release.
 */
export function stableChannelNote(currentVersion: string): string | null {
  if (!isPrereleaseVersion(currentVersion)) return null;
  const version = currentVersion.replace(/^v/, '');
  const base = version.split(/[-+]/)[0];
  return `You're on v${version}, a pre-release. Gnosis won't go back to an older version: you'll get the next stable release, ${base} or later.`;
}

/** "You're up to date" for the channel. */
export function upToDateMessage(channel: UpdateChannel, currentVersion: string): string {
  if (channel === 'stable') {
    const note = stableChannelNote(currentVersion);
    if (note) return note;
  }
  return `Gnosis v${currentVersion.replace(/^v/, '')} is the newest ${channel === 'stable' ? 'stable release' : 'build'}.`;
}
