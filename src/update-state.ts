/**
 * App update state for macOS and Windows (Squirrel). Linux has no auto-update and never uses this.
 *
 * Squirrel downloads the update in the background. It installs it only when the app quits. On macOS,
 * ShipIt waits for the app to exit, checks the update's signature (often 15–25 s), and then aborts with
 * "App Still Running Error" if Gnosis has been reopened in the meantime. A natural quit does not relaunch
 * the app, so a quick quit-and-reopen always loses this race. `restartNow` uses `quitAndInstall`, which
 * makes ShipIt relaunch Gnosis itself after the install, so the user never has to reopen it.
 *
 * Squirrel does not tell the next launch that the install was aborted. A marker file records the
 * downloaded version, so the next launch can say that the update did not install.
 */

export const RELEASES_URL = 'https://github.com/oddur/gnosis/releases';

export type AppUpdateStatus =
  | { state: 'idle' }
  | { state: 'downloading' }
  | { state: 'ready'; version: string }
  | { state: 'installing'; version: string }
  | { state: 'failed'; version: string | null; message: string; releaseUrl: string };

/** The part of Electron's `autoUpdater` that the controller uses. */
export interface UpdaterLike {
  on(event: 'update-available', listener: () => void): unknown;
  on(event: 'update-downloaded', listener: (event: unknown, releaseNotes: string, releaseName: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  quitAndInstall(): void;
}

/** Stores the version that was downloaded and should be running after the next launch. */
export interface UpdateMarker {
  read(): string | null;
  write(version: string | null): void;
}

export function supportsAutoUpdate(platform: string, packaged: boolean): boolean {
  return packaged && (platform === 'darwin' || platform === 'win32');
}

export function releaseUrlFor(version: string | null): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`;
}

/** True when `a` is a newer x.y.z version than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l > r;
  }
  return false;
}

function versionFromReleaseName(releaseName: string | undefined): string {
  // update.electronjs.org names releases "Gnosis 0.38.0"; GitHub tags are "v0.38.0".
  const match = /(\d+\.\d+\.\d+[\w.-]*)/.exec(releaseName ?? '');
  return match ? match[1] : (releaseName ?? '').replace(/^v/, '').trim();
}

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  currentVersion: string;
  marker: UpdateMarker;
  /** Confirms with the user and saves work. Resolves true when the app may quit now. */
  prepareToQuit: () => Promise<boolean>;
  onChange: (status: AppUpdateStatus) => void;
  /** Called when the install fails after `prepareToQuit` has closed saved data. */
  onInstallFailed?: (status: Extract<AppUpdateStatus, { state: 'failed' }>) => void;
  /** Dev only: start as if this version had downloaded. */
  fakeReadyVersion?: string | null;
  log?: (message: string) => void;
}

export function createUpdateController(options: UpdateControllerOptions) {
  const { updater, currentVersion, marker, prepareToQuit, onChange, onInstallFailed, log = () => {} } = options;
  let status: AppUpdateStatus = options.fakeReadyVersion ? { state: 'ready', version: options.fakeReadyVersion } : { state: 'idle' };

  const set = (next: AppUpdateStatus) => {
    status = next;
    onChange(status);
  };
  const fail = (version: string | null, message: string) => {
    const failed = { state: 'failed' as const, version, message, releaseUrl: releaseUrlFor(version) };
    set(failed);
    return failed;
  };

  // The previous launch downloaded a newer version, but this launch still runs the old one.
  const expected = options.fakeReadyVersion ? null : marker.read();
  if (expected && isNewerVersion(expected, currentVersion)) {
    log(`Update ${expected} was downloaded but did not install; still running ${currentVersion}`);
    status = {
      state: 'failed',
      version: expected,
      message: `Gnosis v${expected} did not install. This happens when Gnosis is reopened before the update finishes installing.`,
      releaseUrl: releaseUrlFor(expected),
    };
  } else if (expected) {
    marker.write(null);
  }

  updater.on('update-available', () => {
    // Keep a failure from the last launch visible until the new download is ready.
    if (status.state === 'idle') set({ state: 'downloading' });
  });

  updater.on('update-downloaded', (_event, _notes, releaseName) => {
    if (status.state === 'installing') return;
    const version = versionFromReleaseName(releaseName);
    try {
      marker.write(version || null);
    } catch (error) {
      log(`Could not record the downloaded update: ${error instanceof Error ? error.message : String(error)}`);
    }
    set({ state: 'ready', version });
  });

  updater.on('error', (error) => {
    const message = error.message || 'Unknown error';
    log(`Auto-updater error: ${message}`);
    // A failed check (offline, rate limit) is not worth a banner. A failed download or install is.
    if (status.state === 'downloading') {
      fail(null, `Gnosis could not download the update: ${message}`);
    } else if (status.state === 'installing') {
      const failed = fail(status.version || null, `Gnosis could not install v${status.version}: ${message}`);
      onInstallFailed?.(failed);
    }
  });

  return {
    status: (): AppUpdateStatus => status,
    /** Saves work, then quits, installs the downloaded update and relaunches. */
    async restartNow(): Promise<AppUpdateStatus> {
      if (status.state !== 'ready') return status;
      const version = status.version;
      set({ state: 'installing', version });
      let proceed = false;
      try {
        proceed = await prepareToQuit();
      } catch (error) {
        return fail(version || null, `Gnosis could not save your work before restarting: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!proceed) {
        set({ state: 'ready', version });
        return status;
      }
      try {
        updater.quitAndInstall();
      } catch (error) {
        const failed = fail(version || null, `Gnosis could not install v${version}: ${error instanceof Error ? error.message : String(error)}`);
        onInstallFailed?.(failed);
      }
      return status;
    },
  };
}

export type UpdateController = ReturnType<typeof createUpdateController>;

export type UpdateBannerView =
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; message: string; releaseUrl: string }
  | null;

/**
 * What the banner shows for an auto-update status. It promises an install only after the update has
 * downloaded, and never on Linux, which has no auto-update.
 */
export function updateBannerView(status: AppUpdateStatus, platform: string): UpdateBannerView {
  if (platform === 'linux') return null;
  switch (status.state) {
    case 'ready':
      return { kind: 'ready', version: status.version };
    case 'installing':
      return { kind: 'installing', version: status.version };
    case 'failed':
      return { kind: 'failed', message: status.message, releaseUrl: status.releaseUrl };
    default:
      return null;
  }
}
