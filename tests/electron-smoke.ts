import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createAppDataStore } from '../src/app-data-store';
import { attachWindowHistoryNavigation } from '../src/window-history-navigation';
import { createNotificationService, type DesktopNotificationOptions } from '../src/notification-service';
import { createDeepLinks } from '../src/deep-link-service';
import { notificationSettings } from '../lib/notification-settings';
import { prTarget } from '../lib/deep-link';

const directory = process.env.GNOSIS_SMOKE_DIRECTORY;
if (!directory) throw new Error('Run through npm run test:electron-smoke');
const profile = path.join(directory, 'profile with spaces');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

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
    console.log(
      `PASS: Electron window, isolated production preload, IPC, SQLite worker persistence, native navigation bridge, notification routing by focus${focused ? '' : ' (focused route skipped: no window focus on this display)'}, deep-link handshake`
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    await store.close().catch((error: unknown) => {
      console.error(error);
      exitCode = 1;
    });
    app.exit(exitCode);
  }
});
