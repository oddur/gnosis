import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
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
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(message);
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw Error(`${code}: ${String(error)}`);
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.checkVisibility()&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  const context = async (path: string, keyboard = false) => {
    await js(
      `(()=>{const row=window.deepAll('[data-item-path]').find(e=>e.dataset.itemPath===${JSON.stringify(path)}&&e.getAttribute('role')==='treeitem');if(!row)throw Error('Missing row '+${JSON.stringify(path)});row.focus();const r=row.getBoundingClientRect();row.dispatchEvent(${keyboard ? "new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,composed:true})" : "new MouseEvent('contextmenu',{button:2,bubbles:true,composed:true,clientX:r.x+40,clientY:r.y+10})"})})()`
    );
    await wait("!!document.querySelector('[role=menu]')");
  };
  const progress = (count: number) =>
    wait(`document.querySelector('.changes-progress')?.textContent.includes('${count} / 5')`);
  const query = async (value: string) => {
    await js(
      `(()=>{const e=document.querySelector('input[aria-label="Find changed files"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  const openPr = async () => {
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])]; [...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click(); void 0"
    );
    await click('Open PR overview');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
  };
  try {
    const url = `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters&keep-progress`;
    await loadWorkbenchPage(win, url.replace('&keep-progress', ''));
    await openPr();
    await progress(0);
    await js("window.deepAll('[role=treeitem]').find(e=>e.dataset.itemPath==='tests/').click()");
    await context('tests/');
    assert.match(await js<string>("document.querySelector('[role=menu]').textContent"), /2 files match/);
    const shots = path.resolve('.impeccable/review/folder-viewed');
    fs.mkdirSync(shots, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(shots, 'menu.png'), (await win.webContents.capturePage()).toPNG());
    await click('Mark folder as viewed');
    await progress(2);
    await context('tests/', true);
    win.focus();
    await wait("!!document.activeElement?.closest('[role=menu]')");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await wait("document.activeElement?.getAttribute('role')==='menuitem'");
    // Base UI keeps disabled actions focusable so their availability is discoverable.
    assert.equal(await js("document.activeElement?.getAttribute('aria-disabled')"), 'true');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await wait("document.activeElement?.textContent==='Mark folder as unviewed'");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await progress(0);
    // Generated files remain unviewed when the user hides them.
    await click('Filter files');
    await js("document.querySelectorAll('.raw-file-filter-popover input')[0].click()");
    await wait("![...document.querySelectorAll('.raw-file-filter-popover input')].some(e=>e.disabled)");
    await js(
      "document.querySelector('.raw-file-filter-popover').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.raw-file-filter-popover')");
    await context('tests/');
    assert.match(await js<string>("document.querySelector('[role=menu]').textContent"), /1 file matches/);
    await click('Mark folder as viewed');
    await progress(1);
    await query('worker');
    await context('src/');
    assert.match(await js<string>("document.querySelector('[role=menu]').textContent"), /1 file matches/);
    await click('Mark folder as viewed');
    await progress(2);
    await query('');
    // Filtered-away files were never marked; restore them and mark only the unviewed remainder.
    await click('Filter files');
    await click('Show hidden files');
    await js(
      "document.querySelector('.raw-file-filter-popover')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await js(
      "[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Unviewed only')).querySelector('input').click()"
    );
    await context('tests/__snapshots__/');
    await click('Mark folder as viewed');
    await progress(3);
    await wait("!document.querySelector('[role=menu]')");
    await wait("!window.deepAll('[data-item-path]').some(e=>e.dataset.itemPath==='tests/')");
    await loadWorkbenchPage(win, url);
    await openPr();
    await progress(3);
    await click('Commits');
    await wait("!!document.querySelector('.commit-row') && !!document.querySelector('.changes-file-tree')");
    await progress(0);
    await context('src/');
    await click('Mark folder as viewed');
    await progress(2);
    await click('Changes');
    await progress(3);
    console.log(
      'Folder Viewed checks passed: nested/collapsed folders, keyboard menu, filters/search, unviewed-only, persistence and commit scope.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
