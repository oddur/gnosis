/**
 * Points Squirrel at the right feed for the chosen update channel and records what the last check found (#404).
 *
 * Stable never lists releases: it sets the update.electronjs.org feed that Gnosis has always used and lets Squirrel
 * check. That service serves stable releases only, and answers "no update" unless its newest stable release is newer
 * than the running version, so moving from Pre-release back to Stable never downgrades.
 *
 * Pre-release lists GitHub releases, picks the newest with `resolveUpdate`, and checks only when that build is strictly
 * newer than the running one. Squirrel.Mac's default server type downloads whatever its feed names without comparing
 * versions, so Gnosis must never leave it pointed at an older build.
 */
import { resolveUpdate, updateFeedFor, type ReleaseLike, type UpdateChannel } from '../lib/updater';
import { isPrereleaseVersion } from '../lib/version';
import { upToDateMessage as upToDate } from '../lib/update-channel';
import type { UpdateCheckResult } from '../lib/types';
import type { AppUpdateStatus } from './update-state';

/** The part of Electron's `autoUpdater` that switches feeds. */
export interface FeedUpdater {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  on(event: 'update-not-available' | 'update-available', listener: () => void): unknown;
  on(event: 'update-downloaded', listener: (event: unknown, releaseNotes: string, releaseName: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateChecksOptions {
  updater: FeedUpdater;
  platform: string;
  arch: string;
  currentVersion: string;
  channel: () => UpdateChannel;
  /** GitHub releases, newest first. Called only on the Pre-release channel. */
  listReleases: () => Promise<ReleaseLike[]>;
  /** The update controller's status. */
  status: () => AppUpdateStatus;
  onResult?: (result: UpdateCheckResult) => void;
  now?: () => number;
  log?: (message: string) => void;
}

const label = (version: string, prerelease = isPrereleaseVersion(version)) => `v${version}${prerelease ? ' (pre-release)' : ''}`;

export function createUpdateChecks(options: UpdateChecksOptions) {
  const { updater, platform, arch, currentVersion, channel, listReleases, status, onResult, now = Date.now, log = () => {} } = options;
  let feedUrl: string | null = null;
  let last: UpdateCheckResult | null = null;
  let running: Promise<UpdateCheckResult> | null = null;
  /** The build the current Squirrel check is fetching, when the resolver chose it. */
  let target: { version: string; prerelease: boolean } | null = null;

  const record = (result: Omit<UpdateCheckResult, 'at'>): UpdateCheckResult => {
    last = { ...result, at: now() };
    onResult?.(last);
    return last;
  };
  const checking = () => last?.outcome === 'checking';

  updater.on('update-not-available', () => {
    if (checking()) record({ outcome: 'up-to-date', message: upToDate(channel(), currentVersion) });
  });
  updater.on('update-available', () => {
    if (checking()) record({ outcome: 'downloading', version: target?.version, prerelease: target?.prerelease, message: target ? `Downloading ${label(target.version, target.prerelease)}…` : 'Downloading an update…' });
  });
  updater.on('update-downloaded', () => {
    const current = status();
    const version = current.state === 'ready' ? current.version : target?.version;
    record({ outcome: 'ready', version, prerelease: version ? isPrereleaseVersion(version) : undefined, message: version ? `${label(version)} is ready. Restart Gnosis to install it.` : 'An update is ready. Restart Gnosis to install it.' });
  });
  updater.on('error', (error) => {
    if (checking() || last?.outcome === 'downloading') record({ outcome: 'failed', message: `Could not check for updates: ${error.message || 'unknown error'}` });
  });

  const pointAt = (url: string) => {
    if (feedUrl === url) return;
    updater.setFeedURL({ url });
    feedUrl = url;
  };

  async function run(): Promise<UpdateCheckResult> {
    const current = status();
    const busy = current.state === 'downloading' || current.state === 'installing';
    const inProgress = () => last ?? record({ outcome: 'downloading', message: 'Downloading an update…' });
    const chosen = channel();
    if (chosen === 'stable') {
      const choice = updateFeedFor({ channel: 'stable', platform, arch, currentVersion, target: null });
      if (choice.kind !== 'feed') return record({ outcome: 'up-to-date', message: upToDate(chosen, currentVersion) });
      // Never swap feeds under a download or an install. With the stable feed already set, check as Gnosis always has.
      if (current.state === 'installing' || (busy && feedUrl !== choice.url)) return inProgress();
      target = null;
      try {
        pointAt(choice.url);
      } catch (error) {
        return record({ outcome: 'failed', message: `Could not set the update feed: ${message(error)}` });
      }
      const result = record({ outcome: 'checking', message: 'Checking for a newer stable release…' });
      updater.checkForUpdates();
      return result;
    }

    if (busy) return inProgress();
    let releases: ReleaseLike[];
    try {
      releases = await listReleases();
    } catch (error) {
      return record({ outcome: 'failed', message: `Could not list releases on GitHub: ${message(error)}` });
    }
    const resolved = resolveUpdate('prerelease', currentVersion, releases);
    const choice = updateFeedFor({ channel: 'prerelease', platform, arch, currentVersion, target: resolved });
    if (choice.kind === 'none') return record({ outcome: 'up-to-date', message: upToDate(chosen, currentVersion) });
    if (choice.kind === 'manual') {
      log(`Update ${choice.target.version} cannot install automatically: ${choice.reason}`);
      return record({
        outcome: 'available',
        version: choice.target.version,
        prerelease: choice.target.prerelease,
        releaseUrl: choice.target.releaseUrl,
        message: `${label(choice.target.version, choice.target.prerelease)} is available. Download it from GitHub.`,
      });
    }
    const resolvedTarget = choice.target;
    if (!resolvedTarget) return record({ outcome: 'up-to-date', message: upToDate(chosen, currentVersion) });
    // Already downloaded: do not fetch it again.
    const latest = status();
    if (latest.state === 'ready' && latest.version === resolvedTarget.version) {
      return record({ outcome: 'ready', version: latest.version, prerelease: resolvedTarget.prerelease, message: `${label(latest.version, resolvedTarget.prerelease)} is ready. Restart Gnosis to install it.` });
    }
    target = { version: resolvedTarget.version, prerelease: resolvedTarget.prerelease };
    try {
      pointAt(choice.url);
    } catch (error) {
      return record({ outcome: 'failed', message: `Could not set the update feed: ${message(error)}` });
    }
    log(`Pre-release channel: updating to ${resolvedTarget.version} from ${choice.url}`);
    const result = record({ outcome: 'checking', version: target.version, prerelease: target.prerelease, message: `Found ${label(target.version, target.prerelease)}. Checking…` });
    updater.checkForUpdates();
    return result;
  }

  return {
    /** Checks once. Calls made while a check runs share it. */
    check(): Promise<UpdateCheckResult> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    lastCheck: (): UpdateCheckResult | null => last,
    /** The feed Squirrel reads now, for logs and tests. */
    feedUrl: (): string | null => feedUrl,
  };
}

export type UpdateChecks = ReturnType<typeof createUpdateChecks>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
