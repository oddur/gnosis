import { loadWorkbenchPage } from './workbench-ready';
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
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log(
      await js(
        `(async()=>({calls:window.syncCalls,heading:document.querySelector('h1')?.textContent,header:document.querySelector('header')?.outerHTML?.slice(-2200),visible:document.visibilityState,sync:(await window.electronAPI.workbenchQueue()).sync,label:document.querySelector('.github-sync-status')?.textContent,error:document.querySelector('[role=alert]')?.textContent}))()`
      )
    );
    throw new Error(`Timed out: ${code}`);
  };
  const dir = path.resolve('.impeccable/review/github-sync');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const state = async (status: string) => {
    await js(
      `window.syncState={status:${JSON.stringify(status)},checkedAt:Date.now()-60_000,retryAt:Date.now()+120_000};document.dispatchEvent(new Event('visibilitychange'))`
    );
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await js(`{
      const original=window.electronAPI.workbenchQueue;
      window.syncCalls=0;window.electronAPI.workbenchQueue=async(...args)=>{window.syncCalls++;return {...await original(...args),sync:window.syncState}};
      void 0;
    }`);
    await state('idle');
    await wait("document.querySelector('.github-sync-status')?.textContent.includes('Checked 1m ago')");
    const position = await js<{ x: number; width: number }>(
      '(()=>{const b=document.querySelector(\'[aria-label="Refresh queue"]\').getBoundingClientRect();return{x:b.x,width:b.width}})()'
    );
    await capture('idle-light');
    await state('checking');
    await wait("document.querySelector('.github-sync-status')?.textContent.includes('Checking GitHub')");
    assert.equal(await js("!!document.querySelector('.github-sync-status .animate-spin')"), false);
    const checking = await js<{ x: number; width: number }>(
      '(()=>{const b=document.querySelector(\'[aria-label="Refresh queue"]\').getBoundingClientRect();return{x:b.x,width:b.width}})()'
    );
    assert.deepEqual(checking, position, 'Sync copy must not shift adjacent actions');
    await capture('checking-light');
    await state('paused');
    await wait("document.querySelector('.github-sync-status')?.textContent.includes('Updates paused')");
    await js("document.documentElement.classList.add('dark');document.querySelector('.github-sync-status').focus()");
    await wait("!!document.querySelector('[role=tooltip]')");
    assert.match(await js<string>("document.querySelector('[role=tooltip]').textContent"), /Updates resume after/);
    await capture('paused-dark');
    win.setSize(800, 650);
    await js("document.querySelector('.github-sync-status').blur()");
    await capture('compact');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await state('error');
    await wait("document.querySelector('.github-sync-status')?.textContent.includes('Update failed')");
    assert.match(
      await js<string>("document.querySelector('.github-sync-status').getAttribute('aria-label')"),
      /Select to retry/
    );
    console.log(
      'GitHub sync browser checks passed: freshness, progress, cooldown, error, keyboard tooltip, stable controls, compact layout.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
