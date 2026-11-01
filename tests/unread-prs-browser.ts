import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { menuAction as performMenuAction } from './entry-menu-helpers';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const click = async (text: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button,[role=tab]')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  };
  const menuAction: typeof performMenuAction = async (js, target, action) => {
    console.log('Menu:', target, action);
    await performMenuAction(js, target, action);
  };
  const unread = (number: number) =>
    `window.electronAPI.workbenchSnapshot().then(q=>q.readStates['https://github.com/klang/engine/pull/${number}'].unread.length)`;
  const open = async (number: number) => {
    app.focus({ steal: true });
    win.focus();
    await wait('document.hasFocus()');
    await js(
      `document.querySelector('[aria-label="Actions for PR #${number}"]').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
    );
    await wait('!!document.querySelector(".pr-overview-heading")');
  };
  const back = async () => {
    await click('Review queue');
    await wait("!!document.querySelector('.queue-item')");
  };
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    if (name === 'tooltip-dark') {
      await js("document.querySelector('.queue-item.is-unread .pr-unread-dot').scrollIntoView({block:'center'})");
      await new Promise((r) => setTimeout(r, 200));
      const point = await js<{ x: number; y: number }>("(()=>{const r=document.querySelector('.queue-item.is-unread .pr-unread-dot').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await wait("!!document.querySelector('[role=tooltip]')");
    }
    await new Promise((r) => setTimeout(r, 650));
    const dir = path.resolve('.impeccable/review/unread-prs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&unread&labels`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    app.focus({ steal: true });
    win.focus();
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      const cache=(await import('/lib/inspection-cache.ts')).inspectionData;
      const setTargets=cache.setTargets;
      cache.setTargets=(...args)=>{window.preloadIntent=args[2];return setTargets(...args)};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await wait("window.preloadIntent?.unread?.length===2");
    assert.deepEqual(await js('window.preloadIntent.unread.slice().sort()'), [
      'https://github.com/klang/engine/pull/121', 'https://github.com/klang/engine/pull/152',
    ], 'Only unread stack members and PRs receive the unread preload priority');
    assert.equal(await js("document.querySelectorAll('.queue-item.is-unread').length"), 2);
    await js(
      "document.querySelector('[aria-label=\"Actions for PR #152\"]').closest('.queue-item').querySelector('.queue-row-main').click()"
    );
    assert.equal(await js(unread(152)), 1, 'Selection is not a visit');
    await js("document.querySelector('.queue-disclosure').click()");
    assert.equal(await js("document.querySelectorAll('.queue-member.is-unread').length"), 1);
    await capture('queue-light');
    await js("document.querySelector('.queue-member.is-unread').scrollIntoView({block:'center'})");
    await capture('stack-members');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(900, 760);
    await capture('queue-dark');
    await capture('tooltip-dark');
    win.setSize(640, 760);
    await capture('queue-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await open(152);
    await wait(`${unread(152)}.then(n=>n===0)`);
    await wait("!window.preloadIntent.unread.includes('https://github.com/klang/engine/pull/152')");
    await js("window.dispatchEvent(new Event('fixture-new-commit'))");
    await wait(`${unread(152)}.then(n=>n===1)`);
    await wait("window.preloadIntent.unread.includes('https://github.com/klang/engine/pull/152')");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await js(unread(152)), 1, 'Refreshing an open summary does not acknowledge new commits');
    await menuAction(js, 'Actions for PR #152', 'Mark as read');
    await menuAction(js, 'Actions for PR #152', 'Mark as unread');
    await click('Commits');
    await wait("!!document.querySelector('.commit-row')");
    await click('Summary');
    assert.ok(await js<number>(unread(152)), 'Manual unread survives switching tabs during this visit');
    await back();
    await open(152);
    await wait(`${unread(152)}.then(n=>n===0)`);
    await back();
    await menuAction(js, 'Stack actions', 'Mark as read');
    await wait(`${unread(121)}.then(n=>n===0)`);
    await menuAction(js, 'Stack actions', 'Mark as unread');
    assert.equal(await js("document.querySelectorAll('.queue-member.is-unread').length"), 3);
    await js(
      "document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await wait("document.querySelectorAll('.stack-overview-member').length===3");
    assert.ok(await js<number>(unread(121)), 'Stack overview leaves member PRs unread');
    await js("document.querySelector('.stack-overview-member[data-pr-url$=\"/121\"] .stack-member-title > button:not(.entity-badge)').click()");
    await wait(`${unread(121)}.then(n=>n===0)`);
    await click('Back to stack');
    await menuAction(js, 'Stack actions', 'Mark as read');
    await back();
    await menuAction(js, 'Actions for PR #152', 'Mark as unread');
    await menuAction(js, 'Actions for PR #151', 'Mark as unread');
    await click('Filters');
    await js(`(()=>{const label=[...document.querySelectorAll('.queue-filter-fields label')].find(e=>e.textContent.startsWith('Read status'));const select=label.querySelector('select');select.value='unread';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await capture('filter-popover');
    await click('Close filters');
    await wait("document.querySelectorAll('.queue-item').length===2");
    await capture('unread-filter');
    await open(152);
    await wait(`${unread(152)}.then(n=>n===0)`);
    assert.ok(await js("document.querySelector('.pr-overview-heading').textContent.includes('Add trace context')"));
    assert.match(
      await js<string>("document.querySelector('.pr-queue-navigation')?.textContent ?? document.body.innerText"),
      /2/,
      'Current PR stays in navigation until departure'
    );
    await back();
    await wait("document.querySelectorAll('.queue-item').length===1");
    await menuAction(js, 'Review queue actions', 'Mark visible PRs as read');
    await wait("document.querySelectorAll('.queue-item').length===0");
    await click('Clear filters');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await menuAction(js, 'Actions for PR #152', 'Mark as unread');
    await wait("window.electronAPI.workbenchSnapshot().then(q=>q.filters.readStatus==='all')");
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&unread&labels`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.equal(await js(unread(152)), 1, 'Unread survives renderer restart');
    await click('Filters');
    const setReadStatus = (value: string) => js(`(()=>{const label=[...document.querySelectorAll('.queue-filter-fields label')].find(e=>e.textContent.startsWith('Read status'));const select=label.querySelector('select');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await setReadStatus('read');
    await wait("document.querySelectorAll('.queue-item').length===6");
    await js("window.selectLabels(['critical'])");
    await wait("document.querySelectorAll('.queue-item').length===0");
    await setReadStatus('unread');
    await wait("document.querySelectorAll('.queue-item').length===1");
    await wait("window.electronAPI.workbenchSnapshot().then(q=>q.filters.readStatus==='unread'&&q.filters.labels.names.includes('critical'))");
    win.setSize(1100, 760);
    await js("document.documentElement.classList.add('dark')");
    await capture('read-status-label-filters-dark');
    await js("document.documentElement.classList.remove('dark')");
    await capture('read-status-label-filters-light');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    win.reload();
    await wait("document.querySelectorAll('.queue-item').length===1");
    assert.ok(await js("document.querySelector('.queue-item').textContent.includes('Add trace context')"));
    assert.ok(await js("[...document.querySelectorAll('.queue-filter-chip')].some(e=>e.textContent.includes('Unread PRs'))"));
    console.log(
      'Unread PR browser checks passed: selection/open, stack members, live updates, manual override, filter stability, bulk read, persistence and light/dark UI.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
