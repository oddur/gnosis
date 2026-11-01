import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise(r => setTimeout(r, 40));
    }
    throw Error('Timed out: ' + code);
  };
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = '.queue-target-branch input';
  const fill = (selector: string, value: string) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`);
  const capture = async (name: string) => {
    win.focus();
    await js('document.fonts.ready');
    await new Promise(r => setTimeout(r, 200));
    assert.ok(await js("document.querySelector('.queue-target-branch')?.checkVisibility({visibilityProperty:true})"));
    assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"));
    const dir = path.resolve('.impeccable/review/target-branch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?target-branch');
    win.focus();
    await waitForWorkbenchQueue(win.webContents);
    await click('.queue-filter-toggle');
    await wait(`!!document.querySelector('${input}')`);
    await capture('before');
    await fill(input, 'release/*');
    await wait("document.querySelectorAll('.queue-item').length===2");
    await wait("document.querySelector('.queue-filter-chip')?.textContent.includes('Target branch: release/*')");
    assert.equal(await js(`document.activeElement === document.querySelector('${input}')`), true);
    await capture('desktop');
    await fill(input, 'release/1.?');
    await wait("document.querySelectorAll('.queue-item').length===1");
    await fill(input, 'no-such-branch/*');
    await wait("document.querySelectorAll('.queue-item').length===0");
    await capture('empty');
    await fill(input, 'release/*');
    await wait("document.querySelectorAll('.queue-item').length===2");
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(800, 700);
    await capture('narrow');
    await click('[aria-label="Close filters"]');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save view…').click()");
    await wait("!!document.querySelector('.view-name-form input')");
    await fill('.view-name-form input', 'All hot fixes');
    await js("document.querySelector('.view-name-form').requestSubmit()");
    await wait("document.querySelector('.queue-toolbar h1')?.textContent==='All hot fixes'");
    win.reload();
    await wait("document.querySelectorAll('.queue-item').length===2");
    await click('.queue-filter-toggle');
    await wait(`document.querySelector('${input}')?.value==='release/*'`);
    await click('[aria-label="Close filters"]');
    await click('.queue-filter-chip');
    await wait("document.querySelectorAll('.queue-item').length===7");
    console.log('Target branch passed: wildcard filtering, empty state, removable chip, saved view reload, light/dark and narrow layout.');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
