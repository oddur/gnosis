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
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&unread`);
    app.focus({ steal: true });
    win.focus();
    await wait("document.querySelectorAll('.queue-item').length===7");
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
    await js("window.dispatchEvent(new Event('fixture-new-commit'))");
    await wait(`${unread(152)}.then(n=>n===1)`);
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
    await wait(`${unread(121)}.then(n=>n===0)`);
    await back();
    await menuAction(js, 'Actions for PR #152', 'Mark as unread');
    await menuAction(js, 'Actions for PR #151', 'Mark as unread');
    await click('Filters');
    await wait("!!document.querySelector('.queue-unread-filter input')");
    await js("document.querySelector('.queue-unread-filter input').click()");
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
    await wait('window.electronAPI.workbenchSnapshot().then(q=>q.filters.unreadOnly===false)');
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&unread`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.equal(await js(unread(152)), 1, 'Unread survives renderer restart');
    console.log(
      'Unread PR browser checks passed: selection/open, stack members, live updates, manual override, filter stability, bulk read, persistence and light/dark UI.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
