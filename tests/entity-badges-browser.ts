import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const shots = path.resolve('.impeccable/review/entity-badges');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await js('getSelection()?.removeAllRanges()');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const installClipboard = () =>
    js(
      `(()=>{window.copies=[];window.external=[];window.copyFails=false;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{if(window.copyFails)throw Error('denied');window.copies.push(text)}});window.electronAPI.openExternal=async url=>{window.external.push(url)}})()`
    );
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture');
    await loadWorkbenchPage(win, url + '?pr-summary&entity-badges');
    await waitForWorkbenchQueue(win.webContents);
    await installClipboard();
    assert.equal(await js("document.querySelectorAll('button button, a button').length"), 0);
    const selected = await js("document.querySelector('.queue-row-main[aria-pressed=true]')?.textContent");
    const pr = '.queue-meta .entity-badge-pr';
    await js(`document.querySelector('${pr}').click()`);
    await wait('window.copies.length===1');
    assert.match(await js<string>('window.copies[0]'), /^https:\/\/github.com\/klang\/engine\/pull\/\d+$/);
    assert.equal(await js("document.querySelector('.queue-row-main[aria-pressed=true]')?.textContent"), selected);
    const width = await js(`document.querySelector('${pr}').getBoundingClientRect().width`);
    await js(`document.querySelector('${pr}').click()`);
    assert.equal(await js(`document.querySelector('${pr}').getBoundingClientRect().width`), width);
    // Keyboard access to the same context menu must not open the row's advanced actions.
    await js(
      `document.querySelector('${pr}').focus();document.querySelector('${pr}').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`
    );
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Copy PR number')");
    assert.equal(
      await js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Mute PR')"),
      false
    );
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Copy title').click()");
    await wait('window.copies.length===3');
    assert.ok((await js<string>('window.copies[2]')).length > 12);
    await js(
      `document.querySelector('${pr}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:240}))`
    );
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Open on GitHub')");
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Open on GitHub').click()");
    await wait('window.external.length===1');
    assert.equal(await js('window.external[0]'), await js('window.copies[0]'));
    await js('document.activeElement.blur()');
    await capture('queue-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('queue-dark');
    await js(
      "document.documentElement.classList.remove('dark');[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-branches .entity-badge-branch')");
    assert.equal(
      await js("document.querySelectorAll('.pr-description .entity-badge').length"),
      0,
      'Authored Markdown remains untouched'
    );
    await capture('summary-light');
    const branch = '.pr-branches .entity-badge-branch';
    await js(`window.copyFails=true;document.querySelector('${branch}').click()`);
    await wait(`document.querySelector('${branch}').dataset.copyState==='failed'`);
    assert.match(await js<string>(`document.querySelector('${branch} [role=status]').textContent`), /Could not copy/);
    await js(`window.copyFails=false;document.querySelector('${branch}').focus()`);
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(`document.querySelector('${branch}').dataset.copyState==='copied'`);
    await js("document.documentElement.classList.add('dark')");
    win.setSize(960, 720);
    await js("document.querySelector('.pr-metadata').scrollIntoView({block:'center'})");
    await capture('summary-narrow-dark');
    assert.equal(
      await js('window.copies.at(-1)'),
      'feature/streaming-worker-command-queue/cancellation-aware-backpressure'
    );
    assert.ok(
      await js(
        "(()=>{const b=document.querySelector('.pr-branches .entity-badge-branch'),start=b.querySelector('.entity-badge-start');return start.scrollWidth>start.clientWidth && b.getBoundingClientRect().right<=innerWidth})()"
      ),
      'Long names truncate in the middle without overflowing'
    );
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'), 'No horizontal overflow');
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await click('Commits');
    await wait(
      "document.querySelectorAll('.commit-row').length===3 && !!document.querySelector('.commit-detail-title')"
    );
    const commit = await js("document.querySelector('.commit-row[aria-pressed=true]').dataset.commitId");
    await js("document.querySelectorAll('.commit-entry .entity-badge-commit')[1].click()");
    await wait('window.copies.at(-1).length===40');
    assert.equal(
      await js("document.querySelector('.commit-row[aria-pressed=true]').dataset.commitId"),
      commit,
      'Copying another SHA does not select that commit'
    );
    assert.equal(await js("document.querySelectorAll('button button, a button').length"), 0);
    await capture('commits-light');
    await js(
      "document.querySelector('.commit-baseline .entity-badge-pr').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:340}))"
    );
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Copy title')");
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Copy title').click()");
    await wait("window.copies.at(-1)==='Fix reconnect handling after transport shutdown'");
    await js("document.querySelector('.pr-summary-context .entity-badge-repository').click()");
    await wait("window.copies.at(-1)==='klang/engine'");
    await js("document.querySelector('.pr-summary-context .github-author').click()");
    await wait("window.copies.at(-1)==='lena'");
    console.log(
      'Entity badges passed: exact copying, keyboard, error recovery, stable widths, context menus, row isolation, themes and laptop layout.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.log(
      await js(
        "({focus:document.activeElement?.outerHTML,hasFocus:document.hasFocus(),copies:window.copies,branch:document.querySelector('.pr-branches .entity-badge')?.outerHTML})"
      )
    );
    await capture('failure');
    win.destroy();
    app.exit(1);
  }
});
