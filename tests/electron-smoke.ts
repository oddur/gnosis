import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createAppDataStore } from '../src/app-data-store';
import { attachWindowHistoryNavigation } from '../src/window-history-navigation';

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
    await contents.executeJavaScript('window.unsubscribeSmoke()');
    console.log(
      'PASS: Electron window, isolated production preload, IPC, SQLite worker persistence, native navigation bridge'
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
