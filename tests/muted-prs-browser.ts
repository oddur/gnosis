import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
  const click = async (label: string) => {
    if (/^(Unstar|Star) PR #/.test(label)) {
      return menuAction(js, `Actions for PR #${label.split('#')[1]}`, label);
    }
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.getAttribute('title')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const dir = path.resolve('.impeccable/review/muted-prs');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const menu = async (label: string, action: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing menu');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`
    );
    await wait("!!document.querySelector('[role=menuitem]')");
    await capture('menu');
    await js(
      `(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent===${JSON.stringify(action)});if(!item)throw Error('Missing action');item.click()})()`
    );
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await click('Star PR #152');
    await menu('Actions for PR #152', 'Mute PR');
    await wait("document.querySelectorAll('.queue-item').length===6");
    assert.equal(await js('!!document.querySelector(\'[aria-label="Actions for PR #152"]\')'), false);
    await click('Muted PRs');
    await wait("document.querySelectorAll('.muted-pr-list li').length===1");
    await capture('desktop');
    win.reload();
    await wait("document.querySelectorAll('.queue-item').length===6");
    await click('Muted PRs');
    await wait("document.querySelectorAll('.muted-pr-list li').length===1");
    await click('Unmute PR #152');
    await wait("document.querySelector('.muted-prs h2')?.textContent==='No muted PRs'");
    await capture('empty');
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.ok(await js('!!document.querySelector(\'[aria-label="Actions for PR #152"]\')'));
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Add trace')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-overview-heading')");
    await menu('Actions for PR #152', 'Mute PR');
    await wait(
      "!document.querySelector('.pr-overview-heading') && document.querySelectorAll('.queue-item').length===6"
    );
    await click('Muted PRs');
    await click('Unmute PR #152');
    await click('Review queue');
    await js("document.querySelector('.queue-disclosure').click()");
    await menu('Actions for PR #121', 'Mute PR');
    await wait("document.querySelectorAll('.queue-member').length===2");
    assert.equal(await js('!!document.querySelector(\'[aria-label="Actions for PR #121"]\')'), false);
    await menu('Stack actions', 'Mute stack');
    await wait("!document.querySelector('.queue-disclosure')");
    await click('Muted PRs');
    await wait("document.querySelectorAll('.muted-pr-list li').length===3");
    await capture('stack');
    await js("window.electronAPI.workbenchMutePrs=async()=>{throw Error('Disk is full')};void 0");
    await click('Unmute PR #121');
    await wait("document.querySelector('.muted-prs [role=alert]')?.textContent.includes('Disk is full')");
    assert.equal(await js("document.querySelectorAll('.muted-pr-list li').length"), 3);
    await capture('save-error');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(640, 800);
    await capture('narrow');
    assert.ok(await js('document.documentElement.scrollWidth <= window.innerWidth'));
    console.log('Muted PR browser checks passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
