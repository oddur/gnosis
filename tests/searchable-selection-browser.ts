import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { chooseWorkspaceMenuItem } from './workspace-menu';

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
  // Lists what keeps an open model picker from being fully visible: its trigger outside the
  // scrolling pane, or the popup outside the dialog or covered at a corner or at Done.
  const pickerHidden = (label: string) =>
    js<string>(`(() => {
      const trigger = document.querySelector('[aria-label="${label}"]');
      const popup = document.querySelector('.model-picker-popup');
      const box = (element) => element.getBoundingClientRect();
      const t = box(trigger), p = box(popup), pane = box(trigger.closest('.settings-panel')), dialog = box(trigger.closest('[role=dialog]'));
      const hit = (element, x, y) => element.contains(document.elementFromPoint(x, y));
      const problems = [];
      if (t.top < pane.top - 1 || t.bottom > pane.bottom + 1) problems.push('trigger outside pane');
      if (!hit(trigger, t.left + 8, (t.top + t.bottom) / 2)) problems.push('trigger covered');
      if (p.top < dialog.top || p.bottom > dialog.bottom || p.left < dialog.left || p.right > dialog.right) problems.push('popup outside dialog');
      for (const [x, y] of [[p.left + 6, p.top + 6], [p.right - 6, p.top + 6], [p.left + 6, p.bottom - 6], [p.right - 6, p.bottom - 6]])
        if (!hit(popup, x, y)) problems.push('popup clipped at ' + Math.round(x) + ',' + Math.round(y));
      const done = [...popup.querySelectorAll('button')].find((button) => button.textContent === 'Done');
      if (!done || !hit(done, (box(done).left + box(done).right) / 2, (box(done).top + box(done).bottom) / 2)) problems.push('Done hidden');
      const r = (b) => [b.top, b.bottom].map(Math.round);
      return problems.length ? JSON.stringify({ problems, side: popup.dataset.side, trigger: r(t), popup: r(p), pane: r(pane), dialog: r(dialog) }) : '';
    })()`);
  // Waits until Radix has placed the open model picker and its entrance has finished.
  const pickerPlaced = "(p=>p&&!p.parentElement.style.transform.includes('-200%')&&p.getAnimations().length===0)(document.querySelector('.model-picker-popup'))";
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
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog]')");
    await js(
      "[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(t=>t.textContent==='Appearance').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
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
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6.2-sol')");
    await js("window.selectEffort('Review model', 'ultra')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort)"), 'ultra');
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6-luna')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort)"), 'max');
    await js('window.openModelMenu()');
    assert.equal(await js("!!document.querySelector('.workspace-menu-popup [data-effort=ultra]')"), false);
    await js('window.closeModelMenu()');
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[aria-label=\"Use a different model for briefings\"]')");
    await js("window.selectEffort('Briefing model', 'medium')");
    // Near the bottom of the scrolling Settings pane, the picker stays fully visible in the dialog.
    // At 1200px the window has room below the dialog, so a viewport-only check would open downward
    // into the dialog's clipped edge. The dialog animates its entrance and its size after a resize;
    // measure once it has settled.
    const settled = "document.querySelector('.settings-dialog').getAnimations().length===0";
    for (const height of [700, 967, 1200]) {
      win.setContentSize(1176, height);
      await wait(`innerHeight===${height}`);
      await wait(settled);
      await js(
        "(()=>{const p=document.querySelector('[aria-label=\"Briefing model\"]').closest('.settings-panel');p.scrollTop=p.scrollHeight})()"
      );
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await click('[aria-label="Briefing model"]');
      await wait(pickerPlaced);
      const hidden = await pickerHidden('Briefing model');
      await capture(`briefing-picker-${height}-dark`);
      await key('Escape');
      await wait("!document.querySelector('.model-picker-popup')");
      assert.equal(hidden, '', `Briefing model picker is fully visible at ${height}px`);
    }
    win.setContentSize(1280, 800);
    await wait('innerHeight===800');
    await wait(settled);
    await js("[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(e=>e.textContent==='Review').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait("!!document.querySelector('[aria-label=\"Explanation model\"]')");
    assert.equal(await js("document.querySelector('[aria-label=\"Explanation model\"]').querySelector('.model-picker-effort').textContent"), 'Max');
    await js("window.selectEffort('Explanation model', 'xhigh')");
    await capture('effort-settings-dark');
    await click('[data-slot=dialog-close]');
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.effort==='xhigh'&&p.proactiveEffort==='medium')"), true);
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("document.querySelector('[aria-label=\"Briefing model\"] .model-picker-effort')?.textContent==='Medium'");
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
    // The review model moved into the account menu; Settings keeps the searchable model field.
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await js("[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(e=>e.textContent==='Review').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait("!!document.querySelector('[aria-label=\"Explanation model\"]')");
    await wait("document.querySelector('.settings-dialog').getAnimations().length===0");
    await js("document.querySelector('[aria-label=\"Explanation model\"]').scrollIntoView({block:'nearest'})");
    await click('[aria-label="Explanation model"]');
    await wait(pickerPlaced);
    assert.equal(await pickerHidden('Explanation model'), '', 'Explanation model picker is fully visible at 2x zoom');
    await click('[aria-label="Explanation model selection"]');
    await wait("!!document.querySelector('[data-slot=combobox-content]')");
    await capture('zoom-dark');
    assert.ok(
      await js(
        "(()=>{const r=document.querySelector('[data-slot=combobox-content]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"
      )
    );
    // The dialog clips the nested model list too, so it stays inside the dialog, not just the window.
    assert.ok(
      await js(
        "(()=>{const r=document.querySelector('[data-slot=combobox-content]').getBoundingClientRect(),d=document.querySelector('.settings-dialog').getBoundingClientRect();return r.top>=d.top&&r.bottom<=d.bottom&&r.left>=d.left&&r.right<=d.right})()"
      ),
      'Nested model list stays inside the Settings dialog at 2x zoom'
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
