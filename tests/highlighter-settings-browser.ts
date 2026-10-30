import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const active = () => js<string>("import('/lib/diff-highlighter.ts').then(m=>m.DIFF_HIGHLIGHTER)");
  const openSettings = async () => {
    await wait("!!document.querySelector('[aria-label=Settings]')");
    await js("document.querySelector('[aria-label=Settings]').click()");
    await wait("!!document.querySelector('[role=dialog]')");
    await js(
      "[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Appearance').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
    );
    await wait("!!document.querySelector('#settings-diff-highlighter')");
  };
  const choose = (value: string) => js(`window.selectOption('#settings-diff-highlighter',${JSON.stringify(value)})`);
  const shots = path.resolve('.impeccable/review/highlighter-settings');
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await wait("!document.querySelector('[data-slot=combobox-content][data-open]')");
    win.webContents.setZoomFactor(1.01);
    await new Promise((resolve) => setTimeout(resolve, 100));
    win.webContents.setZoomFactor(1);
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js("document.querySelector('#settings-diff-highlighter-restart').scrollIntoView({block:'nearest'})");
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    assert.ok(url);
    await win.loadURL(url);
    await openSettings();
    assert.equal(await active(), 'shiki-js');
    assert.equal(await js("document.querySelector('#settings-diff-highlighter').value"), 'shiki-js');
    // Exercise an already initialized backend: selecting the other engine must not dispose it.
    await js("import('/tests/fixtures/highlighter-settings.ts').then(m=>m.loadSelectedHighlighter())");
    await choose('highlights');
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffHighlighter==='highlights')");
    await wait("document.querySelector('#settings-diff-highlighter-restart')?.textContent.includes('Saved.')");
    assert.equal(await active(), 'shiki-js');
    assert.equal(
      await js("import('/tests/fixtures/highlighter-settings.ts').then(m=>m.getHighlighterType())"),
      'shiki-js'
    );
    await capture('light');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(800, 700);
    await capture('dark-narrow');
    assert.equal(
      await js(
        "document.querySelector('[role=dialog]').scrollWidth > document.querySelector('[role=dialog]').clientWidth"
      ),
      false
    );
    await win.loadURL(url);
    await openSettings();
    assert.equal(await active(), 'highlights');
    assert.equal(await js("document.querySelector('#settings-diff-highlighter').value"), 'highlights');
    assert.equal(
      await js("import('/tests/fixtures/highlighter-settings.ts').then(m=>m.loadSelectedHighlighter())"),
      'highlights'
    );
    // A failed save cannot claim the change is saved or switch the active backend.
    await js(
      "window.realSave=window.electronAPI.savePreferences; window.electronAPI.savePreferences=()=>Promise.reject(Error('Disk full')); void 0"
    );
    await choose('shiki-js');
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Your changes have not been saved')");
    assert.equal(
      await js("document.querySelector('#settings-diff-highlighter-restart').textContent.includes('Saved.')"),
      false
    );
    assert.equal(await active(), 'highlights');
    await js(
      "window.electronAPI.savePreferences=window.realSave; [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Retry saving')).click()"
    );
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffHighlighter==='shiki-js')");
    await win.loadURL(url);
    await openSettings();
    assert.equal(await active(), 'shiki-js');
    console.log(
      'Highlighter settings passed: persistence, startup selection, safe deferred switching, save failure/retry, light/dark and narrow layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
