import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: true,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') console.error(message); });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error('Timed out: ' + code);
  };
  const click = async (selector: string) => {
    await js(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));element.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));element.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1}))})()`
    );
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const fill = (value: string) =>
    js(
      `(()=>{const input=document.querySelector('[data-slot=combobox-input]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}))})()`
    );
  const key = async (keyCode: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const shots = path.resolve('.impeccable/review/searchable-selection');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
    assert.ok(fixtureUrl, 'GNOSIS_WORKBENCH_URL must point to the running fixture');
    await loadWorkbenchPage(win, fixtureUrl + '?filters');
    win.webContents.setZoomFactor(1);
    win.focus();
    await waitForWorkbenchQueue(win.webContents);
    await js('document.querySelector(\'[aria-label="Filter repository"]\').focus()');
    await key('e');
    await wait("document.activeElement?.getAttribute('data-slot')==='combobox-input'");
    assert.equal(await js("document.querySelector('[data-slot=combobox-input]').value"), 'e');
    assert.equal(await js('document.querySelector(\'[aria-label="Filter repository"]\').value'), 'all');
    await key('Escape');
    await wait("!document.querySelector('[data-slot=combobox-content]')");
    assert.equal(await js('document.querySelector(\'[aria-label="Filter repository"]\').value'), 'all');
    await click('[aria-label="Filter repository"]');
    await wait("document.activeElement?.getAttribute('data-slot')==='combobox-input'");
    await fill('ENGINE');
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length===1");
    await capture('repository-light');
    await key('Enter');
    await wait("document.querySelector('[aria-label=\"Filter repository\"]').value==='klang/engine'");
    assert.equal(await js("!!document.querySelector('[data-slot=combobox-content]')"), false);
    await js("window.selectOption('[aria-label=\"Filter repository\"]','all')");
    await click('.queue-filter-toggle');
    await wait("!!document.querySelector('.queue-filter-popover')");
    await click('[aria-label="Author"]');
    await wait("!!document.querySelector('[data-slot=combobox-input]')");
    const authors = await js<string[]>(
      "[...document.querySelectorAll('[data-slot=combobox-item]')].map(o=>o.textContent)"
    );
    assert.deepEqual(
      authors.slice(1),
      [...authors.slice(1)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    );
    await fill('no-such-author');
    await wait("document.querySelector('[data-slot=combobox-empty]')?.textContent.includes('No matches')");
    assert.equal(
      await js("document.querySelector('[aria-label=Author]').value"),
      'all',
      'Typing never commits a filter'
    );
    await capture('empty-light');
    await key('Escape');
    await wait("!document.querySelector('[data-slot=combobox-content]')");
    assert.ok(await js("!!document.querySelector('.queue-filter-popover')"), 'Escape dismisses only the nested picker');
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Author');
    await click('[aria-label="Author"]');
    await fill('MAYA');
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length===1");
    await capture('author-light');
    await key('Enter');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.author==='maya')");
    assert.ok(await js("!!document.querySelector('.queue-filter-popover')"), 'Choosing an author leaves filters open');
    await click('[aria-label="GitHub labels"]');
    await fill('bug');
    await wait(
      "document.querySelector('[data-slot=combobox-item][data-highlighted]')?.getAttribute('data-value')==='label:bug'"
    );
    await key('Enter');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.labels.names.includes('bug'))");
    await key('Escape');
    await click('[aria-label="Close filters"]');
    await click('[aria-label="Settings"]');
    await wait("!!document.querySelector('[role=dialog]')");
    await js(
      "[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Appearance').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
    );
    await wait('!!document.querySelector(\'[aria-label="Code theme"]\')');
    await click('[aria-label="Code theme"]');
    await wait("document.activeElement?.getAttribute('data-slot')==='combobox-input'");
    await fill('github');
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length>0");
    await capture('settings-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('settings-dark');
    await key('Escape');
    assert.ok(await js("!!document.querySelector('[role=dialog]')"), 'Escape preserves Settings');
    await click('[aria-label="Code font"]');
    await fill('JetBrains');
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length===1");
    await key('Enter');
    await wait("!document.querySelector('[data-slot=combobox-content]')");
    await click('[data-slot=dialog-close]');
    // Model and effort are saved together, including when changing harnesses.
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6.1-sol')");
    await js("window.selectOption('[aria-label=\"Review model effort\"]', 'ultra')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort)"), 'ultra');
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6-luna')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort)"), 'max');
    await click('[aria-label="Review model effort"]');
    assert.equal(await js("!!document.querySelector('[role=option][data-value=ultra]')"), false);
    await key('Escape');
    await click('[aria-label="Settings"]');
    await wait("!!document.querySelector('[aria-label=\"Use a different model for briefings\"]')");
    await js("window.selectOption('[aria-label=\"Briefing model effort\"]', 'medium')");
    await js("[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent==='Review').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait("!!document.querySelector('[aria-label=\"Explanation model effort\"]')");
    assert.equal(await js("document.querySelector('[aria-label=\"Explanation model effort\"]').value"), 'max');
    await js("window.selectOption('[aria-label=\"Explanation model effort\"]', 'xhigh')");
    await capture('effort-settings-dark');
    await click('[data-slot=dialog-close]');
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort==='xhigh'&&p.proactiveEffort==='medium')"), true);
    await click('[aria-label="Settings"]');
    await wait("document.querySelector('[aria-label=\"Briefing model effort\"]')?.value==='medium'");
    await capture('briefing-effort-dark');
    await click('[data-slot=dialog-close]');
    // A saved selection stays visible even when the cached option list no longer contains it.
    await js(
      "window.electronAPI.workbenchQueue().then(q=>window.electronAPI.workbenchSetFilters({...q.filters,author:'contributor-no-longer-in-the-queue'}))"
    );
    await loadWorkbenchPage(win, fixtureUrl + '?filters');
    await wait("!!document.querySelector('.queue-filter-toggle')");
    await js("document.documentElement.classList.add('dark')");
    await click('.queue-filter-toggle');
    await wait("document.querySelector('[aria-label=Author]')?.value==='contributor-no-longer-in-the-queue'");
    await click('[aria-label="Author"]');
    await wait("!!document.querySelector('[data-slot=combobox-item][data-selected]')");
    await capture('author-dark');
    await key('Escape');
    win.setContentSize(640, 800);
    await wait('innerWidth===640');
    await click('[aria-label="Author"]');
    await wait("!!document.querySelector('[data-slot=combobox-content]')");
    const bounds = await js<{ left: number; right: number; top: number; bottom: number }>(
      "document.querySelector('[data-slot=combobox-content]').getBoundingClientRect().toJSON()"
    );
    assert.ok(
      bounds.left >= 0 && bounds.right <= 640 && bounds.top >= 0 && bounds.bottom <= 800,
      JSON.stringify(bounds)
    );
    await capture('narrow-dark');
    await key('Escape');
    await click('[aria-label="Close filters"]');
    win.setContentSize(1280, 800);
    win.webContents.setZoomFactor(2);
    await click('[aria-label="Review model"]');
    await wait("!!document.querySelector('[data-slot=combobox-content]')");
    await capture('zoom-dark');
    assert.ok(
      await js(
        "(()=>{const r=document.querySelector('[data-slot=combobox-content]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"
      )
    );
    console.log(
      'Searchable selections passed: keyboard search, cancellation, nested popovers/dialogs, saved values, light/dark, laptop and zoom.'
    );
    win.webContents.setZoomFactor(1);
    app.exit(0);
  } catch (e) {
    console.error(e);
    try {
      if (!win.isDestroyed()) {
        await capture('failure');
        console.error(await js('document.body.innerText'));
      }
    } finally {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(1);
      app.exit(1);
    }
  }
});
