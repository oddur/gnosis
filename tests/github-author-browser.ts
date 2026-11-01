import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-authors-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?polish');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    win.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{window.profileCalls=0;window.openedProfiles=[];window.copiedValues=[];Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.copiedValues.push(text)}});const load=window.electronAPI.getGitHubProfile;window.electronAPI.getGitHubProfile=(login)=>{window.profileCalls++;return new Promise(resolve=>{window.resolveProfile=()=>resolve(load(login))})};window.electronAPI.openExternal=(url)=>{window.openedProfiles.push(url);return Promise.resolve()}})()`
    );
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await js('window.profileCalls'), 0, 'Rendering authors does not request profiles');
    assert.equal(
      await js("document.querySelectorAll('button .github-author').length"),
      0,
      'Profile links never nest inside row buttons'
    );
    const position = await js<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.queue-meta .github-author [data-slot=avatar]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
    );
    win.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 80));
    win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
    await wait('window.profileCalls === 1');
    assert.equal(
      await js("!!document.querySelector('.github-author-tooltip')"),
      false,
      'No partial card while loading'
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 100));
    await js('window.resolveProfile()');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js("!!document.querySelector('.github-author-tooltip')"),
      false,
      'Leaving while loading prevents a late tooltip'
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
    await wait('window.profileCalls === 2');
    await js('window.resolveProfile()');
    await wait("document.querySelector('.github-author-tooltip')?.textContent.includes('Morgan Developer')");
    assert.equal(await js('window.profileCalls'), 2);
    assert.match(await js<string>("document.querySelector('.github-author-tooltip').textContent"), /Berlin/);
    await capture('tooltip-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('tooltip-dark');
    const selected = await js("document.querySelector('.queue-row-main[aria-pressed=true]')?.textContent");
    await js("document.querySelector('.queue-meta .github-author').click()");
    assert.equal(await js("document.querySelector('.queue-row-main[aria-pressed=true]')?.textContent"), selected);
    assert.equal(await js('window.openedProfiles.length'), 0);
    assert.equal(await js('window.copiedValues.length'), 1);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('.github-author-tooltip')");
    await js('document.activeElement.blur()');
    await js("document.querySelector('.queue-meta .github-author').focus()");
    await wait('window.profileCalls === 3');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise((r) => setTimeout(r, 100));
    await js('window.resolveProfile()');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js("!!document.querySelector('.github-author-tooltip')"),
      false,
      'Escape dismisses a pending tooltip'
    );
    await js("document.activeElement.blur();document.querySelector('.queue-meta .github-author').focus()");
    await wait('window.profileCalls === 4');
    await js('window.resolveProfile()');
    await wait("!!document.querySelector('.github-author-tooltip')");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('.github-author-tooltip')");
    await js(
      "document.activeElement.blur();window.failedProfiles=0;void (window.electronAPI.getGitHubProfile=()=>{window.failedProfiles++;return Promise.reject(new Error('offline'))})"
    );
    await new Promise((r) => setTimeout(r, 300));
    const second = await js<{ x: number; y: number }>(
      "(()=>{const r=document.querySelectorAll('.queue-meta .github-author')[1].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
    );
    win.focus();
    win.webContents.focus();
    await wait('document.hasFocus()');
    win.webContents.sendInputEvent({ type: 'mouseMove', ...second });
    await wait("document.querySelector('.github-author-tooltip')?.textContent.includes('Profile details unavailable')");
    win.setSize(1200, 900);
    win.webContents.setZoomFactor(2);
    await new Promise((r) => setTimeout(r, 200));
    await js("document.querySelectorAll('.queue-meta .github-author')[1].scrollIntoView({block:'center'})");
    await new Promise((r) => setTimeout(r, 200));
    await js('document.activeElement.blur()');
    await new Promise((r) => setTimeout(r, 250));
    win.focus();
    win.webContents.focus();
    await js("document.querySelectorAll('.queue-meta .github-author')[1].focus({preventScroll:true})");
    await wait("document.querySelector('.github-author-tooltip')?.textContent.includes('Profile details unavailable')");
    await capture('zoom');
    assert.ok(
      await js(
        "(()=>{const r=document.querySelector('.github-author-tooltip').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"
      )
    );
    console.log(
      'GitHub authors passed: lazy hover, profile details, keyboard/Escape, copy on click, valid row controls, offline fallback, themes and zoom.'
    );
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.log(
      await js(
        "({focus:document.activeElement?.outerHTML.slice(0,300),tooltips:[...document.querySelectorAll('.github-author-tooltip')].map(t=>t.textContent),calls:window.profileCalls,failed:window.failedProfiles,hasFocus:document.hasFocus()})"
      )
    );
    await capture('failure');
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(1);
  }
});
