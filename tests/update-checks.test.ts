import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecks, type FeedUpdater } from '../src/update-checks';
import { createUpdateController, type AppUpdateStatus, type UpdaterLike } from '../src/update-state';
import { macUpdateManifestName, type ReleaseLike, type UpdateChannel } from '../lib/updater';

const RELEASES = 'https://github.com/oddur/gnosis/releases';

function release(tag: string, assets?: string[]): ReleaseLike {
  const version = tag.replace(/^v/, '');
  const prerelease = version.includes('-');
  const names = assets ?? [`Gnosis-darwin-arm64-${version}.zip`, ...(prerelease ? [macUpdateManifestName('arm64')] : []), 'RELEASES', `gnosis-${version.replace(/\.(\d+)$/, '$1')}-full.nupkg`];
  return { tag_name: tag, html_url: `${RELEASES}/tag/${tag}`, draft: false, prerelease, assets: names.map((name) => ({ name, browser_download_url: `${RELEASES}/download/${tag}/${name}` })) };
}

type Listener = (...args: unknown[]) => void;
function fakeSquirrel() {
  const listeners = new Map<string, Listener[]>();
  const calls: string[] = [];
  const updater = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
    setFeedURL({ url }: { url: string }) {
      calls.push(`feed ${url}`);
    },
    checkForUpdates() {
      calls.push('check');
    },
    quitAndInstall() {
      calls.push('quitAndInstall');
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    calls,
  };
  return updater as typeof updater & UpdaterLike & FeedUpdater;
}

function setup({ platform = 'darwin', arch = 'arm64', current = '0.41.0', channel = 'stable' as UpdateChannel, releases = [] as ReleaseLike[], status = null as AppUpdateStatus | null } = {}) {
  const squirrel = fakeSquirrel();
  const state = { channel, releases, listed: 0, fail: null as Error | null };
  const controller = createUpdateController({
    updater: squirrel,
    currentVersion: current,
    marker: { read: () => null, write: () => {} },
    prepareToQuit: () => Promise.resolve(true),
    onChange: () => {},
  });
  const checks = createUpdateChecks({
    updater: squirrel,
    platform,
    arch,
    currentVersion: current,
    channel: () => state.channel,
    listReleases: () => {
      state.listed++;
      return state.fail ? Promise.reject(state.fail) : Promise.resolve(state.releases);
    },
    status: () => status ?? controller.status(),
    now: () => 1_000,
  });
  return { squirrel, state, checks, controller };
}

void test('Stable sets the update.electronjs.org feed and never lists releases', async () => {
  const { squirrel, state, checks } = setup({ releases: [release('v0.42.0-beta.1')] });
  const result = await checks.check();
  assert.equal(state.listed, 0, 'Stable must make no request that could return a prerelease');
  assert.deepEqual(squirrel.calls, ['feed https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.41.0', 'check']);
  assert.equal(result.outcome, 'checking');
  squirrel.emit('update-not-available');
  assert.equal(checks.lastCheck()?.outcome, 'up-to-date');
  assert.equal(checks.lastCheck()?.message, 'Gnosis v0.41.0 is the newest stable release.');
  // A later check keeps the same feed and does not recreate the updater.
  await checks.check();
  assert.deepEqual(squirrel.calls.slice(2), ['check']);
});

void test('Pre-release points Squirrel.Mac at the newest prerelease manifest and checks', async () => {
  const { squirrel, checks } = setup({ channel: 'prerelease', releases: [release('v0.42.0-beta.2'), release('v0.41.0')] });
  const result = await checks.check();
  assert.deepEqual(squirrel.calls, [`feed ${RELEASES}/download/v0.42.0-beta.2/Gnosis-darwin-arm64-update.json`, 'check']);
  assert.equal(result.outcome, 'checking');
  assert.equal(result.version, '0.42.0-beta.2');
  squirrel.emit('update-available');
  assert.equal(checks.lastCheck()?.message, 'Downloading v0.42.0-beta.2 (pre-release)…');
  squirrel.emit('update-downloaded', {}, '', 'Gnosis 0.42.0-beta.2');
  assert.deepEqual(checks.lastCheck(), { at: 1_000, outcome: 'ready', version: '0.42.0-beta.2', prerelease: true, message: 'v0.42.0-beta.2 (pre-release) is ready. Restart Gnosis to install it.' });
});

void test('Pre-release on Windows reads the release download folder; the downloaded NuGet version reads back as semver', async () => {
  const { squirrel, checks, controller } = setup({ platform: 'win32', arch: 'x64', channel: 'prerelease', releases: [release('v0.42.0-beta.10')] });
  await checks.check();
  assert.deepEqual(squirrel.calls, [`feed ${RELEASES}/download/v0.42.0-beta.10`, 'check']);
  // Electron on Windows passes Squirrel's NuGet version as the release name.
  squirrel.emit('update-downloaded', {}, '', '0.42.0-beta10');
  assert.deepEqual(controller.status(), { state: 'ready', version: '0.42.0-beta.10' });
});

void test('Pre-release with nothing newer does not touch Squirrel', async () => {
  const { squirrel, checks } = setup({ current: '0.42.0-beta.2', channel: 'prerelease', releases: [release('v0.42.0-beta.2'), release('v0.42.0-beta.1'), release('v0.41.0')] });
  const result = await checks.check();
  assert.deepEqual(squirrel.calls, []);
  assert.equal(result.outcome, 'up-to-date');
  assert.equal(result.message, 'Gnosis v0.42.0-beta.2 is the newest build.');
});

void test('Pre-release moves to a newer stable release through update.electronjs.org', async () => {
  const { squirrel, checks } = setup({ current: '0.42.0-beta.3', channel: 'prerelease', releases: [release('v0.42.0'), release('v0.42.0-beta.3')] });
  await checks.check();
  assert.deepEqual(squirrel.calls, ['feed https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.42.0-beta.3', 'check']);
});

void test('switching Pre-release → Stable goes back to the stable feed and promises no downgrade', async () => {
  const { squirrel, state, checks } = setup({ current: '0.42.0-beta.3', channel: 'prerelease', releases: [release('v0.42.0-beta.4'), release('v0.41.0')] });
  await checks.check();
  state.channel = 'stable';
  state.listed = 0;
  await checks.check();
  assert.equal(state.listed, 0);
  assert.deepEqual(squirrel.calls.slice(2), ['feed https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.42.0-beta.3', 'check']);
  // update.electronjs.org answers 204 because 0.41.0 is older than 0.42.0-beta.3.
  squirrel.emit('update-not-available');
  assert.equal(
    checks.lastCheck()?.message,
    "You're on v0.42.0-beta.3, a pre-release. Gnosis won't go back to an older version: you'll get the next stable release, 0.42.0 or later."
  );
});

void test('does not swap feeds while an update downloads or installs', async () => {
  for (const status of [{ state: 'downloading' }, { state: 'installing', version: '0.42.0-beta.2' }] as AppUpdateStatus[]) {
    const { squirrel, state, checks } = setup({ channel: 'prerelease', releases: [release('v0.42.0-beta.2')], status });
    await checks.check();
    assert.deepEqual(squirrel.calls, [], status.state);
    assert.equal(state.listed, 0);
  }
});

void test('Stable keeps checking during a download, as before, but never swaps a feed under it', async () => {
  const status: { value: AppUpdateStatus } = { value: { state: 'idle' } };
  const squirrel = fakeSquirrel();
  let channel: UpdateChannel = 'stable';
  const checks = createUpdateChecks({
    updater: squirrel,
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.41.0',
    channel: () => channel,
    listReleases: () => Promise.resolve([release('v0.42.0-beta.1')]),
    status: () => status.value,
  });
  await checks.check();
  status.value = { state: 'downloading' };
  await checks.check();
  assert.deepEqual(squirrel.calls, ['feed https://update.electronjs.org/oddur/gnosis/darwin-arm64/0.41.0', 'check', 'check']);
  channel = 'prerelease';
  await checks.check();
  status.value = { state: 'installing', version: '0.41.1' };
  channel = 'stable';
  await checks.check();
  assert.equal(squirrel.calls.length, 3);
});

void test('does not download a pre-release that is already downloaded', async () => {
  const { squirrel, checks } = setup({ channel: 'prerelease', releases: [release('v0.42.0-beta.2')], status: { state: 'ready', version: '0.42.0-beta.2' } });
  const result = await checks.check();
  assert.deepEqual(squirrel.calls, []);
  assert.equal(result.outcome, 'ready');
});

void test('offers the release page when the prerelease has no update files', async () => {
  const { squirrel, checks } = setup({ channel: 'prerelease', releases: [release('v0.42.0-beta.2', ['Gnosis-darwin-arm64-0.42.0-beta.2.zip'])] });
  const result = await checks.check();
  assert.deepEqual(squirrel.calls, []);
  assert.equal(result.outcome, 'available');
  assert.equal(result.releaseUrl, `${RELEASES}/tag/v0.42.0-beta.2`);
});

void test('a failed release listing is reported and leaves Squirrel alone', async () => {
  const { squirrel, state, checks } = setup({ channel: 'prerelease' });
  state.fail = new Error('API rate limit exceeded');
  const result = await checks.check();
  assert.deepEqual(squirrel.calls, []);
  assert.equal(result.outcome, 'failed');
  assert.match(result.message, /rate limit/);
});

void test('a Squirrel error during a check is reported', async () => {
  const { squirrel, checks } = setup();
  await checks.check();
  squirrel.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(checks.lastCheck()?.outcome, 'failed');
});

void test('calls made while a check runs share it', async () => {
  const { state, checks } = setup({ channel: 'prerelease', releases: [release('v0.42.0-beta.2')] });
  const [a, b] = await Promise.all([checks.check(), checks.check()]);
  assert.equal(a, b);
  assert.equal(state.listed, 1);
});
