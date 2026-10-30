import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { menuAction } from './entry-menu-helpers';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const dir = path.resolve('.impeccable/review/context-menus');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const rightClick = (selector: string) =>
    js(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.x+40,clientY:r.y+20}))})()`
    );
  const escape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait("!document.querySelector('[role=menu]')");
  };
  try {
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      'window.__refreshed=[];const original=window.electronAPI.getPrStatus;window.electronAPI.getPrStatus=async(url,force)=>{if(force)window.__refreshed.push(url);return original(url,force)};void 0'
    );
    await js(`window.__generationRequests=[];window.__briefingRequests=[];
      const originalStart=window.electronAPI.startReview;
      window.electronAPI.startReview=async request=>{window.__generationRequests.push(request);return originalStart(request)};
      window.electronAPI.workbenchBriefing=async id=>{window.__briefingRequests.push(id);return window.electronAPI.workbenchQueue()};void 0`);
    await js("document.querySelector('.queue-row-main').click()");
    await wait("!!document.querySelector('.briefing-panel h2')");
    const preview = await js("document.querySelector('.briefing-panel h2').textContent");
    const selection = 'Add trace context to scheduled jobs';
    await rightClick('.queue-row:has([aria-label="Actions for PR #152"])');
    await wait("!!document.querySelector('[role=menuitem]')");
    assert.equal(await js("document.querySelector('.queue-item.is-selected .queue-title')?.textContent"), selection);
    assert.equal(await js("document.querySelector('.briefing-panel h2')?.textContent"), preview);
    await capture('queue-light');
    await js(
      "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Refresh GitHub status').click()"
    );
    await wait('window.__refreshed.length===1');
    assert.ok((await js<string[]>('window.__refreshed'))[0].endsWith('/152'));
    assert.equal(await js("document.querySelector('.queue-item.is-selected .queue-title')?.textContent"), selection);
    await menuAction(js, 'Actions for PR #152', 'Generate explanation');
    await wait('window.__generationRequests.length===1');
    assert.equal(await js('window.__generationRequests[0].prUrl.endsWith("/152")'), true);
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>window.__generationRequests[0].model===p.model&&window.__generationRequests[0].provider===p.provider)'), true);
    await menuAction(js, 'Actions for PR #152', 'Generate briefing');
    assert.equal(await js('window.electronAPI.workbenchQueue().then(q=>window.__briefingRequests[0]===q.items.find(i=>i.subject.members.some(m=>m.number===152)).subject.id)'), true);
    assert.equal(await js("document.querySelector('.queue-item.is-selected .queue-title')?.textContent"), selection);
    await menuAction(js, 'Stack actions', 'Generate explanation');
    await wait('window.__generationRequests.length===2');
    assert.equal(await js('window.electronAPI.workbenchQueue().then(q=>window.__generationRequests[1].subjectId===q.items.find(i=>i.subject.kind==="stack").subject.id)'), true);
    await js("document.querySelector('.queue-disclosure').click()");
    await menuAction(js, 'Actions for PR #121', 'Generate explanation');
    await wait('window.__generationRequests.length===3');
    assert.equal(await js('window.__generationRequests[2].prUrl.endsWith("/121")&&window.__generationRequests[2].standalone===true&&!window.__generationRequests[2].subjectId'), true);
    await menuAction(js, 'Actions for PR #121', 'Generate stack briefing');
    assert.equal(await js('window.electronAPI.workbenchQueue().then(q=>window.__briefingRequests[1]===q.items.find(i=>i.subject.kind==="stack").subject.id)'), true);
    await rightClick('.queue-member:has([aria-label="Actions for PR #121"])');
    await wait("!!document.querySelector('[role=menuitem]')");
    assert.equal(await js("document.querySelectorAll('[role=menu]').length"), 1);
    assert.equal(
      await js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Mute stack')"),
      false
    );
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Star PR #121').click()");
    await wait(
      '!!document.querySelector(\'.queue-member:has([aria-label="Actions for PR #121"]) .entry-star-marker\')'
    );
    await js(
      "(()=>{const e=document.querySelector('.queue-member-title');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}))})()"
    );
    await wait("!!document.querySelector('[role=menu]')");
    await escape();
    assert.equal(await js("document.activeElement?.classList.contains('entry-menu-trigger')"), true);
    await js("document.documentElement.classList.add('dark')");
    await rightClick('.queue-row:has(.queue-disclosure)');
    await wait("!!document.querySelector('[role=menuitem]')");
    await capture('queue-dark');
    await escape();
    win.setSize(640, 800);
    await rightClick('.queue-row:has([aria-label="Actions for PR #152"])');
    await wait("!!document.querySelector('[role=menuitem]')");
    assert.equal(
      await js(
        "(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"
      ),
      true
    );
    await capture('queue-narrow-dark');
    await escape();
    await js("document.documentElement.classList.remove('dark')");
    await rightClick('.queue-row:has([aria-label="Actions for PR #152"])');
    await wait("!!document.querySelector('[role=menuitem]')");
    await capture('queue-narrow-light');
    await escape();
    win.setSize(1280, 800);
    // Failed asynchronous actions are visible and do not remove the target entry.
    await js("window.electronAPI.getPrStatus=async()=>{throw Error('Try again after GitHub backoff')};void 0");
    await menuAction(js, 'Actions for PR #152', 'Refresh GitHub status');
    await wait("document.body.textContent.includes('Could not refresh github status')");
    assert.equal(await js("document.querySelectorAll('.queue-item').length"), 7);
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?views`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Save view…').click()");
    await wait("!!document.querySelector('.view-name-form input')");
    const nameView = async (name: string) => {
      await js(
        `(()=>{const input=document.querySelector('.view-name-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`
      );
      await js("document.querySelector('.view-name-form').requestSubmit()");
      await wait("!document.querySelector('.view-name-form')");
    };
    await nameView('My work');
    await wait("!!document.querySelector('.saved-view-row')");
    assert.equal(await js("(()=>{const e=document.querySelector('.saved-views-nav');return e.scrollWidth<=e.clientWidth})()"), true);
    await rightClick('.saved-view-row');
    await wait("!!document.querySelector('[role=menu]')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Move up').getAttribute('aria-disabled')"
      ),
      'true'
    );
    await capture('saved-view-menu');
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Rename').click()");
    await wait("!!document.querySelector('.view-name-form input')");
    await wait("document.activeElement===document.querySelector('.view-name-form input')");
    await capture('saved-view-rename');
    await nameView('Focus');
    await menuAction(js, 'Manage Focus', 'Duplicate');
    await wait("document.querySelectorAll('.saved-view-row').length===2");
    await menuAction(js, 'Manage Focus copy', 'Move up');
    await wait("document.querySelector('.saved-view-name').textContent==='Focus copy'");
    await menuAction(js, 'Manage Focus copy', 'Delete view');
    await wait("document.querySelectorAll('.saved-view-row').length===1");
    await js("[...document.querySelectorAll('button')].find(b=>b.title==='Saved reviews').click()");
    await wait("!!document.querySelector('.saved-row')");
    await rightClick('.saved-row');
    await wait("!!document.querySelector('[role=menu]')");
    await capture('saved-review-menu');
    assert.equal(
      await js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Delete saved review')"),
      true
    );
    assert.equal(await js("!!document.querySelector('.pr-overview-heading')"), false);
    await escape();
    console.log(
      'Context menus passed: pointer target, scoped refresh, nested member scope, keyboard, focus, error, light/dark and narrow layouts.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await capture('failure');
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
