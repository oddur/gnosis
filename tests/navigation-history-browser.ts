import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { attachWindowHistoryNavigation } from '../src/window-history-navigation';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on('console-message', ({ message }) => { if (/error|failed/i.test(message)) console.error('Renderer:', message); });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  attachWindowHistoryNavigation(win, (direction) => {
    void js(`window.dispatchEvent(new CustomEvent('fixture-history-navigate',{detail:${direction}}))`);
  });
  const mouse = async (button: number) => {
    if (process.env.GNOSIS_NATIVE_SWIPE === '1') {
      win.emit('swipe', { preventDefault() {} }, button === 3 ? 'left' : 'right');
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        button: button === 3 ? 'back' : 'forward',
        x: 800,
        y: 100,
        clickCount: 1,
      });
    }
  };
  const title = () =>
    js<string>("document.querySelector('.pr-summary-title')?.textContent ?? document.querySelector('h1')?.textContent");
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?pr-summary&navigation-history&keep-progress');
    win.webContents.debugger.attach('1.3');
    await waitForWorkbenchQueue(win.webContents);
    await mouse(3);
    assert.ok(await js("!!document.querySelector('.queue-list')"), 'Back at start does nothing');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('[role=tab][aria-selected=true]')");
    const original = await title();
    await js(
      '(()=>{window.historyFilterWrites=0;const save=window.electronAPI.workbenchSetFilters;window.electronAPI.workbenchSetFilters=(...args)=>{window.historyFilterWrites++;return save(...args)}})()'
    );
    await click('Changes');
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Changes'");
    await click('Commits');
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Commits'");
    await mouse(3);
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Changes'");
    await mouse(3);
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Summary'");
    await mouse(3);
    await wait("!!document.querySelector('.queue-list')");
    assert.ok(
      await js("document.querySelector('.queue-row-main[aria-pressed=true]')?.textContent.includes('Fix reconnect')"),
      'Queue selection survives Back'
    );
    await mouse(4);
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Summary'");
    assert.equal(await title(), original);
    assert.equal(
      await js('window.historyFilterWrites'),
      0,
      'Tab and PR history do not rewrite unchanged queue filters'
    );
    // Modals protect pending input, without consuming a history entry.
    await js(
      "(()=>{const d=document.createElement('div');d.id='test-modal';d.setAttribute('role','dialog');d.setAttribute('aria-modal','true');document.body.append(d)})()"
    );
    await mouse(3);
    assert.equal(await title(), original);
    await js("document.getElementById('test-modal').remove()");
    await js(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:']',code:'BracketRight',metaKey:true,bubbles:true,cancelable:true}))"
    );
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Changes'");
    await js(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'[',code:'BracketLeft',metaKey:true,bubbles:true,cancelable:true}))"
    );
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Summary'");
    await mouse(3);
    await wait("!!document.querySelector('.queue-list')");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Reduce allocations')).click()"
    );
    await click('Open PR overview');
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Summary'");
    const another = await title();
    assert.notEqual(another, original);
    await mouse(4);
    assert.equal(await title(), another, 'New navigation clears Forward');
    await mouse(3);
    await wait("!!document.querySelector('.queue-list')");
    await js(
      "[...document.querySelectorAll('.workbench-sidebar button')].find(b=>b.textContent.includes('Saved reviews')).click()"
    );
    await wait(
      "!![...document.querySelectorAll('.saved-row button')].find(b=>b.textContent.includes('Local history fixture'))"
    );
    await js(
      "[...document.querySelectorAll('.saved-row .queue-row-main')].find(b=>b.textContent.includes('Local history fixture')).click()"
    );
    await wait("!document.querySelector('.queue-list') && !!document.querySelector('.workbench-review')");
    await mouse(3);
    await wait("!!document.querySelector('.saved-row')");
    await js("window.dispatchEvent(new CustomEvent('fixture-history-navigate',{detail:1}))");
    await wait("!document.querySelector('.queue-list') && !!document.querySelector('.workbench-review')");
    await mouse(3);
    await wait("!!document.querySelector('.saved-row')");
    await mouse(3);
    await wait("!!document.querySelector('.queue-item') && !document.querySelector('.saved-row')");
    await js("document.querySelector('.saved-view-link').click()");
    await wait("document.querySelector('h1')?.textContent==='History view'");
    await mouse(3);
    await wait("document.querySelector('h1')?.textContent==='Review queue'");
    await mouse(4);
    await wait("document.querySelector('h1')?.textContent==='History view'");
    await wait("document.querySelector('.saved-view-link')?.getAttribute('aria-current')==='page'");
    assert.equal(await js('window.electronAPI.workbenchSnapshot().then(q=>q.savedViews.activeId)'), 'history-view');
    await js("document.querySelector('[aria-label=\"Recently viewed\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))");
    await wait("!!document.querySelector('.recent-history-menu')");
    assert.ok(await js("document.querySelector('.recent-history-menu').textContent.includes('History view')"));
    assert.ok(await js("document.querySelector('.recent-history-menu').textContent.includes('Local history fixture')"));
    assert.equal(await js("[...document.querySelectorAll('.recent-history-name')].filter(e=>e.textContent.includes('Fix reconnect')).length"), 1);
    const capture = async (name: string) => {
      const directory = path.resolve('.impeccable/review/recently-viewed');
      fs.mkdirSync(directory, { recursive: true });
      await js('document.fonts.ready');
      win.focus();
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.writeFileSync(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    await capture('desktop-light');
    win.setSize(900, 760);
    await js("document.documentElement.classList.add('dark')");
    await capture('laptop-dark');
    // Keyboard focus stays within the menu; Enter opens the selected destination.
    await js("[...document.querySelectorAll('.recent-history-item')].find(e=>e.textContent.includes('Fix reconnect')).focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait("!!document.querySelector('.pr-overview-tabs') && !document.querySelector('.recent-history-menu')");
    assert.equal(await title(), original);
    await click('Changes');
    await js("document.querySelector('[aria-label=\"Recently viewed\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))");
    await wait("!!document.querySelector('.recent-history-menu')");
    await js("[...document.querySelectorAll('.recent-history-item')].find(e=>e.textContent.includes('History view')).click()");
    await wait("document.querySelector('h1')?.textContent==='History view'");
    await js("document.querySelector('[aria-label=\"Recently viewed\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))");
    await wait("!!document.querySelector('.recent-history-menu')");
    await js("[...document.querySelectorAll('.recent-history-item')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Changes'");
    win.reload();
    await wait("!!document.querySelector('.queue-list')");
    await js("document.querySelector('[aria-label=\"Recently viewed\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))");
    await wait("!!document.querySelector('.recent-history-menu')");
    assert.ok(await js("document.querySelector('.recent-history-menu').textContent.includes('Fix reconnect')"));
    await js("[...document.querySelectorAll('.recent-history-action')].find(e=>e.textContent.includes('Clear recently')).click()");
    await js("document.querySelector('[aria-label=\"Recently viewed\"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))");
    await wait("!!document.querySelector('.recent-history-empty')");
    console.log(
      'Navigation history passed: mouse back/forward, tab order, queue selection, shortcuts, modal protection and branching.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await js('document.body.innerText.slice(0,1800)'));
    win.destroy();
    app.exit(1);
  }
});
