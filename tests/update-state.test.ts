import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUpdateController,
  isNewerVersion,
  releaseUrlFor,
  supportsAutoUpdate,
  updateBannerView,
  type AppUpdateStatus,
  type UpdaterLike,
} from '../src/update-state';

type Listener = (...args: unknown[]) => void;

function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  const calls: string[] = [];
  const updater = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
    quitAndInstall() {
      calls.push('quitAndInstall');
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    calls,
  };
  return updater as typeof updater & UpdaterLike;
}

function setup({ current = '0.37.0', marker = null as string | null, prepare = (): Promise<boolean> => Promise.resolve(true) } = {}) {
  const updater = fakeUpdater();
  const stored = { version: marker };
  const statuses: AppUpdateStatus[] = [];
  const installFailures: AppUpdateStatus[] = [];
  const controller = createUpdateController({
    updater,
    currentVersion: current,
    marker: { read: () => stored.version, write: (version) => { stored.version = version; } },
    prepareToQuit: () => {
      updater.calls.push('prepareToQuit');
      return prepare();
    },
    onChange: (status) => statuses.push(status),
    onInstallFailed: (status) => installFailures.push(status),
  });
  return { updater, controller, stored, statuses, installFailures };
}

void test('promises an install only after the update has downloaded', () => {
  const { updater, controller } = setup();
  assert.equal(updateBannerView(controller.status(), 'darwin'), null);
  updater.emit('update-available');
  assert.equal(controller.status().state, 'downloading');
  assert.equal(updateBannerView(controller.status(), 'darwin'), null);
  updater.emit('update-downloaded', {}, '', 'Gnosis 0.38.0');
  assert.deepEqual(controller.status(), { state: 'ready', version: '0.38.0' });
  assert.deepEqual(updateBannerView(controller.status(), 'darwin'), { kind: 'ready', version: '0.38.0', prerelease: false });
});

void test('reads the version from GitHub tags and update.electronjs.org release names', () => {
  for (const name of ['v0.38.0', 'Gnosis 0.38.0', '0.38.0']) {
    const { updater, controller } = setup();
    updater.emit('update-downloaded', {}, '', name);
    assert.deepEqual(controller.status(), { state: 'ready', version: '0.38.0' });
  }
});

void test('Restart now saves work first, then calls quitAndInstall', async () => {
  const { updater, controller, stored } = setup();
  updater.emit('update-available');
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  assert.equal(stored.version, '0.38.0');
  const status = await controller.restartNow();
  assert.deepEqual(updater.calls, ['prepareToQuit', 'quitAndInstall']);
  assert.deepEqual(status, { state: 'installing', version: '0.38.0' });
});

void test('Restart now does not install before the flush has finished', async () => {
  let finish: (value: boolean) => void = () => {};
  const { updater, controller } = setup({ prepare: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  const restarting = controller.restartNow();
  await Promise.resolve();
  assert.deepEqual(updater.calls, ['prepareToQuit']);
  assert.equal(controller.status().state, 'installing');
  finish(true);
  await restarting;
  assert.deepEqual(updater.calls, ['prepareToQuit', 'quitAndInstall']);
});

void test('Restart now stays ready when the user keeps the app open', async () => {
  const { updater, controller } = setup({ prepare: () => Promise.resolve(false) });
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  const status = await controller.restartNow();
  assert.deepEqual(updater.calls, ['prepareToQuit']);
  assert.deepEqual(status, { state: 'ready', version: '0.38.0' });
});

void test('Restart now does nothing before an update has downloaded', async () => {
  const { updater, controller } = setup();
  updater.emit('update-available');
  await controller.restartNow();
  assert.deepEqual(updater.calls, []);
});

void test('a failed download surfaces with a GitHub link', () => {
  const { updater, controller } = setup();
  updater.emit('update-available');
  updater.emit('error', new Error('Code signature at URL did not pass validation'));
  const status = controller.status();
  assert.equal(status.state, 'failed');
  assert.deepEqual(updateBannerView(status, 'darwin'), {
    kind: 'failed',
    message: 'Gnosis could not download the update: Code signature at URL did not pass validation',
    releaseUrl: 'https://github.com/oddur/gnosis/releases/latest',
  });
});

void test('a failed install surfaces and is reported to main', async () => {
  const { updater, controller, installFailures } = setup();
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  await controller.restartNow();
  updater.emit('error', new Error("No update available, can't quit and install"));
  assert.deepEqual(controller.status(), {
    state: 'failed',
    version: '0.38.0',
    message: "Gnosis could not install v0.38.0: No update available, can't quit and install",
    releaseUrl: 'https://github.com/oddur/gnosis/releases/tag/v0.38.0',
  });
  assert.equal(installFailures.length, 1);
});

void test('a quitAndInstall that throws surfaces as a failure', async () => {
  const { updater, controller, installFailures } = setup();
  updater.quitAndInstall = () => { throw new Error('boom'); };
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  const status = await controller.restartNow();
  assert.equal(status.state, 'failed');
  assert.equal(installFailures.length, 1);
});

void test('a failed check without an update stays quiet', () => {
  const { updater, controller } = setup();
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.deepEqual(controller.status(), { state: 'idle' });
});

void test('says so when the last downloaded update did not install', () => {
  const { updater, controller, stored } = setup({ current: '0.37.0', marker: '0.38.0' });
  const status = controller.status();
  assert.ok(status.state === 'failed' && /v0\.38\.0 did not install/.test(status.message));
  // The failure stays until the new download is ready, then Restart now is offered again.
  updater.emit('update-available');
  assert.equal(controller.status().state, 'failed');
  updater.emit('update-downloaded', {}, '', 'v0.38.0');
  assert.deepEqual(controller.status(), { state: 'ready', version: '0.38.0' });
  assert.equal(stored.version, '0.38.0');
});

void test('clears the marker once the update is running', () => {
  const { controller, stored } = setup({ current: '0.38.0', marker: '0.38.0' });
  assert.deepEqual(controller.status(), { state: 'idle' });
  assert.equal(stored.version, null);
});

void test('makes no auto-update promise on Linux', () => {
  assert.equal(supportsAutoUpdate('linux', true), false);
  assert.equal(supportsAutoUpdate('darwin', false), false);
  assert.equal(supportsAutoUpdate('darwin', true), true);
  assert.equal(supportsAutoUpdate('win32', true), true);
  const statuses: AppUpdateStatus[] = [
    { state: 'ready', version: '0.38.0' },
    { state: 'installing', version: '0.38.0' },
    { state: 'failed', version: '0.38.0', message: 'x', releaseUrl: releaseUrlFor('0.38.0') },
  ];
  for (const status of statuses) assert.equal(updateBannerView(status, 'linux'), null);
});

void test('compares versions numerically', () => {
  assert.equal(isNewerVersion('0.38.0', '0.37.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.37.0', '0.37.0'), false);
  assert.equal(isNewerVersion('0.36.5', '0.37.0'), false);
});

// #404: pre-release versions.
void test('compares pre-release versions by semver precedence', () => {
  assert.equal(isNewerVersion('0.42.0-beta.10', '0.42.0-beta.2'), true);
  assert.equal(isNewerVersion('0.42.0', '0.42.0-beta.10'), true);
  assert.equal(isNewerVersion('0.42.0-beta.2', '0.42.0'), false);
  assert.equal(isNewerVersion('0.42.0-beta.2', '0.42.0-beta.2'), false);
});

void test('says so when a pre-release did not install over an older pre-release', () => {
  const { controller, stored } = setup({ current: '0.42.0-beta.1', marker: '0.42.0-beta.2' });
  const status = controller.status();
  assert.ok(status.state === 'failed' && /v0\.42\.0-beta\.2 did not install/.test(status.message));
  assert.equal(status.releaseUrl, 'https://github.com/oddur/gnosis/releases/tag/v0.42.0-beta.2');
  assert.equal(stored.version, '0.42.0-beta.2');
});

void test('says so when stable did not install over its pre-release', () => {
  const { controller } = setup({ current: '0.42.0-beta.10', marker: '0.42.0' });
  assert.equal(controller.status().state, 'failed');
});

void test('clears the marker once the pre-release is running, or a newer one is', () => {
  for (const current of ['0.42.0-beta.2', '0.42.0-beta.10', '0.42.0']) {
    const { controller, stored } = setup({ current, marker: '0.42.0-beta.2' });
    assert.deepEqual(controller.status(), { state: 'idle' }, current);
    assert.equal(stored.version, null, current);
  }
});

void test('records the semver version when Squirrel.Windows reports its NuGet version', () => {
  const { updater, controller, stored } = setup({ current: '0.42.0-beta.9' });
  updater.emit('update-downloaded', {}, '', '0.42.0-beta10');
  assert.deepEqual(controller.status(), { state: 'ready', version: '0.42.0-beta.10' });
  assert.equal(stored.version, '0.42.0-beta.10');
});

void test('the banner marks a pre-release', () => {
  assert.deepEqual(updateBannerView({ state: 'ready', version: '0.42.0-beta.2' }, 'darwin'), { kind: 'ready', version: '0.42.0-beta.2', prerelease: true });
  assert.deepEqual(updateBannerView({ state: 'installing', version: '0.42.0-beta.2' }, 'win32'), { kind: 'installing', version: '0.42.0-beta.2', prerelease: true });
  assert.deepEqual(updateBannerView({ state: 'ready', version: '0.42.0' }, 'darwin'), { kind: 'ready', version: '0.42.0', prerelease: false });
});
