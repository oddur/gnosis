import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 120; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`
    );
  const fill = (selector: string, value: string) =>
    js(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-hardening-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  try {
    const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
    if (!fixtureUrl) throw new Error('Missing fixture URL');
    await loadWorkbenchPage(win, fixtureUrl + '?hardening');
    win.webContents.setZoomFactor(1);
    await wait('innerWidth > 1000');
    await wait("!!document.querySelector('.chat-sheet')");
    await js(`(async()=>{
      window.savedPrefs=structuredClone(await window.electronAPI.loadPreferences());window.saveCount=0;window.failSave=false;window.failLoad=false;
      window.electronAPI.loadPreferences=async()=>{if(window.failLoad)throw Error('Read failed');return structuredClone(window.savedPrefs)};
      window.electronAPI.savePreferences=async prefs=>{window.saveCount++;await new Promise(r=>setTimeout(r,60));if(window.failSave)throw Error('Disk full');window.savedPrefs=structuredClone(prefs)};
    })()`);
    await click('Open settings');
    await wait('!!document.querySelector(\'[aria-label="Automatic briefings"]\')');
    await js(
      `(()=>{document.querySelector('[aria-label="Ignore Dependabot PRs"]').click();document.querySelector('[aria-label="Automatic briefings"]').click();})()`
    );
    await wait('window.saveCount===2');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js('window.savedPrefs.ignoreDependabotPrs'),
      false,
      'Rapid settings edits must not overwrite an earlier change'
    );
    assert.equal(await js('window.savedPrefs.autoBriefings'), false);
    // Failed saves keep the desired values, offer retry, and prevent accidental draft loss.
    await js('window.failSave=true');
    await js('document.querySelector(\'[aria-label="Ignore Dependabot PRs"]\').click()');
    await wait("!!document.querySelector('.settings-save-error')");
    assert.equal(
      await js("document.querySelector('[aria-label=\"Ignore Dependabot PRs\"]').getAttribute('aria-checked')"),
      'true'
    );
    await capture('save-error-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('save-error-dark');
    await js('window.failSave=false');
    await click('Retry saving');
    await wait('window.savedPrefs.ignoreDependabotPrs===true && !document.querySelector(".settings-save-error")');
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait('!document.querySelector("[role=dialog]")');
    // Escape cannot discard a failed edit; explicit discard restores persisted values.
    await click('Open settings');
    await wait('!!document.querySelector(".settings-tabs")');
    await js('window.failSave=true');
    await js('document.querySelector(\'[aria-label="Ignore Dependabot PRs"]\').click()');
    await wait('!!document.querySelector(".settings-save-error")');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await js('!!document.querySelector("[role=dialog]")'), true);
    await click('Discard unsaved changes');
    await wait('!document.querySelector("[role=dialog]")');
    assert.equal(await js('window.savedPrefs.ignoreDependabotPrs'), true);
    await js('window.failSave=false');
    await click('Open settings');
    await wait('!!document.querySelector(".settings-tabs")');
    assert.equal(
      await js('document.querySelector(\'[aria-label="Ignore Dependabot PRs"]\').getAttribute("aria-checked")'),
      'true'
    );
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait('!document.querySelector("[role=dialog]")');
    // Loading failure cannot expose editable defaults; retry loads the real preferences.
    await js('window.failLoad=true');
    await click('Open settings');
    await wait('!!document.querySelector(".settings-load-error")');
    assert.equal(await js('!!document.querySelector(".settings-tabs")'), false);
    await js('window.failLoad=false');
    await click('Retry loading settings');
    await wait('!!document.querySelector(".settings-tabs")');
    // Slow autocomplete responses must not replace the latest query's results.
    await js(
      'void (window.electronAPI.searchRepos=(query)=>new Promise((resolve,reject)=>{(window.searches??={})[query]={resolve,reject}}))'
    );
    await js("[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Repositories').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await click('Add repository');
    await fill('#watched-repos', 'old');
    await wait('!!window.searches?.old');
    await fill('#watched-repos', 'new');
    await wait('!!window.searches?.new');
    await js("window.searches.new.resolve([{fullName:'team/new',description:'最新のリポジトリ',private:false}])");
    await wait("document.querySelector('.settings-dialog').textContent.includes('team/new')");
    await js("window.searches.old.resolve([{fullName:'team/old',description:'old',private:false}])");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await js("document.querySelector('.settings-dialog').textContent.includes('team/old')"), false);
    await fill('#watched-repos', 'offline');
    await wait('!!window.searches?.offline');
    await js("window.searches.offline.reject(Error('Offline'))");
    await wait('!!document.querySelector(".settings-search-error")');
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait('!document.querySelector("[role=dialog]")');
    // Composition Enter confirms a CJK character; it must not send the question.
    await fill('.chat-sheet textarea', '日本語の質問 🧪');
    await js(
      "document.querySelector('.chat-sheet textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('#sent-count').textContent"), '0');
    assert.equal(await js("document.querySelector('.chat-sheet textarea').value"), '日本語の質問 🧪');
    await click('Toggle streaming');
    await js(
      "document.querySelector('.chat-sheet textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('.chat-sheet textarea').value"), '日本語の質問 🧪');
    await click('Toggle streaming');
    await js(
      "document.querySelector('.chat-sheet textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
    );
    await wait("document.querySelector('#sent-count').textContent==='1'");
    // Electron's real mouse input exercises pointer capture; synthesized cancellation
    // and window blur verify that the following gesture still works.
    await js(
      "document.body.style.cursor='crosshair';document.body.style.userSelect='text';document.addEventListener('pointerdown',e=>{if(e.isPrimary)window.lastPointer=e.pointerId})"
    );
    const handle = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('[aria-label="Collapse chat panel"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+30)}})()`
    );
    const beginDrag = async () => {
      win.webContents.sendInputEvent({ type: 'mouseMove', ...handle });
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...handle });
      await wait("document.body.style.cursor==='col-resize'");
    };
    await beginDrag();
    await js("window.dispatchEvent(new Event('blur'))");
    assert.equal(await js('document.body.style.cursor'), 'crosshair');
    assert.equal(await js('document.body.style.userSelect'), 'text');
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...handle });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js('!!document.querySelector(\'[aria-label="Collapse chat panel"]\')'),
      true,
      'Canceled resize must not collapse the panel on release'
    );
    await beginDrag();
    await js("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.lastPointer}))");
    assert.equal(await js('document.body.style.cursor'), 'crosshair');
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...handle });
    await new Promise((r) => setTimeout(r, 100));
    await beginDrag();
    // A second pointer cannot take over or end the primary drag.
    await js(`(()=>{const h=document.querySelector('[aria-label="Collapse chat panel"]');
      h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,isPrimary:false,button:0,bubbles:true}));
      window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:99}));})()`);
    assert.equal(await js('document.body.style.cursor'), 'col-resize');
    // Releasing actual capture restores body styles and leaves the next drag usable.
    await js(
      'document.querySelector(\'[aria-label="Collapse chat panel"]\').releasePointerCapture(window.lastPointer)'
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', ...handle });
    await wait("document.body.style.cursor==='crosshair'");
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...handle });
    await new Promise((r) => setTimeout(r, 100));
    const previousWidth = await js<number>('document.querySelector(".chat-sheet").getBoundingClientRect().width');
    await js(
      'document.querySelector(\'[aria-label="Collapse chat panel"]\').dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))'
    );
    await wait(`document.querySelector('.chat-sheet').getBoundingClientRect().width > ${previousWidth + 30}`);
    await js("document.body.style.cursor='';document.body.style.userSelect=''");
    // Dialog content and its final action stay reachable at 200% zoom.
    win.setSize(800, 600);
    win.webContents.setZoomFactor(2);
    await wait('innerWidth <= 400');
    await click('Open long dialog');
    await wait('!!document.querySelector("[role=dialog]")');
    await capture('long-dialog-zoom');
    assert.ok(
      await js(
        `(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1})()`
      ),
      'Long dialog must stay inside the zoomed viewport'
    );
    await js("document.querySelector('[role=dialog]').scrollTop=10000");
    await click('Return to review');
    await wait('!document.querySelector("[role=dialog]")');
    console.log(
      'Hardening checks passed: concurrent settings, save/load recovery, stale search, IME input, and long dialogs.'
    );
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(1);
  }
});
