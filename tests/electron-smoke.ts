import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createAppDataStore } from '../src/app-data-store';
import { attachWindowHistoryNavigation } from '../src/window-history-navigation';
import { createNotificationService, type DesktopNotificationOptions } from '../src/notification-service';
import { createDeepLinks } from '../src/deep-link-service';
import { notificationSettings } from '../lib/notification-settings';
import { prTarget } from '../lib/deep-link';
import { createAppWindows } from '../src/app-windows';

const directory = process.env.GNOSIS_SMOKE_DIRECTORY;
if (!directory) throw new Error('Run through npm run test:electron-smoke');
const profile = path.join(directory, 'profile with spaces');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

const root: string = directory;
const probes: ChildProcess[] = [];
/** One lock probe (tests/electron-lock-probe.ts): the production single-instance module on its own profile. */
function lockProbe(profileDirectory: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, GNOSIS_SINGLE_INSTANCE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GNOSIS_TEST_RESULT_FILE;
  delete env.GNOSIS_DEV_PROTOCOL;
  const child = spawn(process.execPath, [path.join(root, 'lock-probe.cjs'), `--user-data-dir=${profileDirectory}`, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  probes.push(child);
  const events: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Log lines from the probe are not events.
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const until = async (match: (event: Record<string, unknown>) => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const event = events.find(match);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Lock probe timed out: ${label}`);
  };
  const exit = () => Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Lock probe did not exit')), 20_000))]);
  return { events, until, exit };
}

/**
 * The lock is scoped by --user-data-dir: a second launch on one profile forwards its link and exits 0, and a
 * launch on another profile takes its own lock and keeps running. Developers run two profiles at once.
 */
async function checkLockScoping() {
  const first = path.join(root, 'lock profile a');
  const second = path.join(root, 'lock profile b');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const real = (value: unknown) => fs.realpathSync(String(value));
  const a = lockProbe(first);
  assert.equal(real((await a.until((event) => 'ready' in event, 'first profile ready')).ready), real(first), 'The probe runs on the profile it was given');
  const forwarded = lockProbe(first, 'gnosis-dev://pr/example/repository/7');
  assert.equal(await forwarded.exit(), 0, 'The same profile: the second launch exits 0');
  assert.deepEqual(await a.until((event) => 'link' in event, 'forwarded link'), { link: 'gnosis-dev://pr/example/repository/7', source: 'os' });
  assert.equal(forwarded.events.some((event) => 'ready' in event), false, 'The losing launch never reaches ready');
  const b = lockProbe(second);
  assert.equal(real((await b.until((event) => 'ready' in event, 'second profile ready')).ready), real(second), 'Another profile takes its own lock');
  const plain = lockProbe(first);
  assert.equal(await plain.exit(), 0);
  await a.until((event) => event.show === true, 'a launch without a link focuses the first window');
  assert.equal(b.events.some((event) => 'link' in event || 'show' in event), false, 'The other profile receives nothing');
}

/**
 * The menu bar panel (#308) is a hidden window that is not part of the app. With it present: "show or create"
 * shows the main window, broadcasts skip it, `activate` with only the panel creates a main window, and closing
 * the last app window still reports it, although Electron's `window-all-closed` waits for the panel.
 */
async function checkAppWindows(main: BrowserWindow) {
  const windows = createAppWindows(() => BrowserWindow.getAllWindows());
  let allClosed = 0;
  app.on('window-all-closed', () => allClosed++);
  const panel = new BrowserWindow({
    show: false, width: 360, height: 420, frame: false, skipTaskbar: true,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  windows.exclude(panel);
  await panel.loadURL('data:text/html,<title>Menu bar panel</title>');
  const reached: string[] = [];
  const send = panel.webContents.send.bind(panel.webContents);
  panel.webContents.send = (channel: string, ...args: unknown[]) => {
    reached.push(channel);
    send(channel, ...args);
  };
  assert.deepEqual(windows.list(), [main], 'The hidden panel is not an app window');
  const created: BrowserWindow[] = [];
  const showOrCreate = () => {
    const win = windows.list().at(0);
    if (win) {
      win.show();
      return win;
    }
    const next = new BrowserWindow({ show: false, width: 400, height: 300 });
    created.push(next);
    return next;
  };
  assert.equal(showOrCreate(), main, 'Show or create shows the main window, never the panel');
  assert.equal(panel.isVisible(), false);
  for (const win of windows.list()) win.webContents.send('workbench-changed');
  assert.deepEqual(reached, [], 'A broadcast does not reach the panel');
  let lastClosed = 0;
  windows.watchClose(main, () => lastClosed++);
  const closed = new Promise<void>((resolve) => main.once('closed', () => resolve()));
  main.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lastClosed, 1, 'Closing the last app window is reported while the panel exists');
  assert.equal(allClosed, 0, "Electron's window-all-closed waits for the panel");
  const reopened = showOrCreate();
  assert.deepEqual(created, [reopened], 'Activate with only the panel present creates a main window');
  assert.deepEqual(windows.list(), [reopened]);
  panel.destroy();
  return { main: reopened };
}

void app.whenReady().then(async () => {
  let store = createAppDataStore();
  let window: BrowserWindow | undefined;
  let exitCode = 0;
  try {
    await store.open(profile);
    ipcMain.handle('load-preferences', () => store.read('smoke-preferences'));
    ipcMain.handle('save-preferences', async (_event, value: unknown) => {
      store.write('smoke-preferences', value);
      await store.flush();
    });
    window = new BrowserWindow({
      show: true,
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(directory, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const contents = window.webContents;
    await window.loadURL('data:text/html,<title>Electron smoke test</title><h1>Gnosis preload smoke test</h1>');
    assert.equal(await contents.executeJavaScript('typeof window.electronAPI.loadPreferences'), 'function');
    assert.equal(await contents.executeJavaScript('window.electronAPI.platform'), process.platform);
    assert.equal(await contents.executeJavaScript('typeof window.require'), 'undefined');

    // Exercise the production preload and SQLite worker through real Electron IPC.
    const preferences = { theme: 'dark', watchedRepos: ['example/repository'], label: 'Smoke ✓' };
    await contents.executeJavaScript(`window.electronAPI.savePreferences(${JSON.stringify(preferences)})`);
    assert.deepEqual(await contents.executeJavaScript('window.electronAPI.loadPreferences()'), preferences);
    await store.close();
    store = createAppDataStore();
    await store.open(profile);
    assert.deepEqual(await contents.executeJavaScript('window.electronAPI.loadPreferences()'), preferences);

    attachWindowHistoryNavigation(window, (direction) => contents.send('history-navigate', direction));
    await contents.executeJavaScript(`window.smokeEvents=[];
      window.unsubscribeSmoke=window.electronAPI.onHistoryNavigate(direction=>window.smokeEvents.push(direction)); true;`);
    for (const [event, direction] of [
      ['app-command', 'browser-backward'],
      ['app-command', 'browser-forward'],
      ['swipe', 'left'],
      ['swipe', 'right'],
    ])
      window.emit(event, { preventDefault() {} }, direction);
    await contents.executeJavaScript(`new Promise((resolve,reject)=>{
      const deadline=Date.now()+5000;
      const check=()=>{if(window.smokeEvents.length===4)resolve();
        else if(Date.now()>deadline)reject(Error('Navigation IPC timed out'));else setTimeout(check,20)};check();
    })`);
    assert.deepEqual(await contents.executeJavaScript('window.smokeEvents'), [-1, 1, -1, 1]);
    // Unsubscribing must not hand ipcRenderer (or anything else) back across the context bridge.
    assert.equal(await contents.executeJavaScript('window.unsubscribeSmoke() === undefined'), true);

    // Notification routing against real window focus. A shim records desktop notifications, so none is shown.
    const desktop: DesktopNotificationOptions[] = [];
    const toasts: string[] = [];
    const deepLinks = createDeepLinks({
      show: () => {},
      send: (id, item) => {
        if (id !== contents.id) return false;
        contents.send('deep-link', item);
        return true;
      },
      log: () => {},
    });
    ipcMain.handle('deep-link-take', (event) => deepLinks.take(event.sender.id));
    const notifications = createNotificationService({
      settings: () => notificationSettings({ notifications: true, notificationSettings: { introduced: true } }),
      focus: () => ({ focused: !!BrowserWindow.getFocusedWindow() }),
      desktop: { supported: () => true, create: (options) => { desktop.push(options); return { on: () => {}, show: () => {}, close: () => {} }; } },
      toast: (delivery) => (toasts.push(delivery.title), true),
      open: (target) => deepLinks.open(target, 'notification'),
    });
    const ready = { type: 'explanation-ready' as const, title: 'Smoke PR', at: Date.now(), target: { kind: 'review' as const, reviewId: 'smoke-review' } };
    window.blur();
    if (BrowserWindow.getFocusedWindow()) window.hide();
    assert.equal(BrowserWindow.getFocusedWindow(), null, 'No Gnosis window has focus');
    notifications.local({ ...ready, key: 'explanation|smoke-1' });
    assert.deepEqual(desktop.map((options) => options.title), ['Explanation ready'], 'Unfocused: a desktop notification');
    assert.deepEqual(toasts, []);
    window.show();
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A virtual display may not grant focus; check the focused route only when the window really has it.
    const focused = !!BrowserWindow.getFocusedWindow();
    notifications.local({ ...ready, key: 'explanation|smoke-2' });
    if (focused) {
      assert.equal(desktop.length, 1, 'Focused: no desktop notification');
      assert.deepEqual(toasts, ['Explanation ready']);
    }
    // A click before the renderer is ready waits for its handshake, then later targets arrive at once.
    deepLinks.open(prTarget('https://github.com/example/repository/pull/7', 'checks')!, 'notification');
    await contents.executeJavaScript(`window.smokeLinks=[];window.stopLinks=window.electronAPI.onDeepLink(item=>window.smokeLinks.push(item.target.kind));
      window.electronAPI.takeDeepLinks().then(items=>{window.taken=items.map(item=>item.target.tab);return true})`);
    assert.deepEqual(await contents.executeJavaScript('window.taken'), ['checks']);
    deepLinks.open({ kind: 'review', reviewId: 'smoke-review' }, 'tray');
    await contents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;
      const check=()=>{if(window.smokeLinks.length===1)resolve();else if(Date.now()>deadline)reject(Error('Deep link IPC timed out'));else setTimeout(check,20)};check();})`);
    assert.deepEqual(await contents.executeJavaScript('window.smokeLinks'), ['review']);
    assert.equal(await contents.executeJavaScript('window.stopLinks() === undefined'), true);
    assert.equal(await contents.executeJavaScript('window.electronAPI.linkScheme'), 'gnosis', 'Without --gnosis-link-dev the preload uses the packaged scheme');
    const panelChecks = await checkAppWindows(window);
    window = panelChecks.main;
    await checkLockScoping();
    console.log(
      `PASS: Electron window, isolated production preload, IPC, SQLite worker persistence, native navigation bridge, notification routing by focus${focused ? '' : ' (focused route skipped: no window focus on this display)'}, deep-link handshake, single-instance lock per --user-data-dir, the menu bar panel outside the app's windows`
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    for (const probe of probes) if (probe.exitCode === null) probe.kill();
    window?.destroy();
    await store.close().catch((error: unknown) => {
      console.error(error);
      exitCode = 1;
    });
    app.exit(exitCode);
  }
});
