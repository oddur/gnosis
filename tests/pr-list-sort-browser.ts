import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (text: string) => js(`[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  const sort = async (key: string) => {
    if (!await js("!!document.querySelector('#pr-sort-key')")) await js("document.querySelector('[aria-label^=\"Sort: \"]').click()");
    await js(`window.selectOption('#pr-sort-key',${JSON.stringify(key)})`);
  };
  const rows = () => js<string[]>("[...document.querySelectorAll('.queue-list [role=listitem][data-queue-id]')].map(e=>e.dataset.queueId)");
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await win.loadURL(url);
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.ok(await js("!!document.querySelector('[aria-label=\"Sort: Priority\"]')"));
    await sort('title');
    assert.equal(await js("document.querySelectorAll('.queue-section-title').length"), 0);
    const ascending = await rows();
    await js("document.querySelector('[aria-label=\"Sort direction: A–Z\"]').click()");
    assert.deepEqual(await rows(), [...ascending].reverse());
    await js("document.querySelector('[aria-label=\"Sort PRs\"] input[type=checkbox]').click()");
    await click('Done');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.sort.key==='title'&&q.filters.sort.direction==='desc'&&!q.filters.sort.starredFirst)");
    win.reload();
    await wait("!!document.querySelector('[aria-label=\"Sort: Title\"]')");
    assert.deepEqual(await rows(), [...ascending].reverse(), 'Queue sort survives reload');

    await click('Save view…');
    await wait("!!document.querySelector('.view-name-form input')");
    await js(`(()=>{const e=document.querySelector('.view-name-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'By title');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await js("document.querySelector('.view-name-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    await wait("document.querySelector('.queue-toolbar h1')?.textContent==='By title'");
    await sort('created'); await click('Done');
    await wait("document.querySelector('.view-modified')?.textContent.includes('View changed')");
    await click('Restore saved filters');
    await wait("!!document.querySelector('[aria-label=\"Sort: Title\"]')&&!document.querySelector('.view-modified')");
    assert.deepEqual(await rows(), [...ascending].reverse());

    // Updated metadata must not move a menu target until its menu closes.
    await sort('title'); await click('Done');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.sort.key==='title'&&q.filters.sort.direction==='asc')");
    await js(`(async()=>{
      window.sortFixture=await window.electronAPI.workbenchQueue();
      const original=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async()=>({...await original(),items:window.sortFixture.items});
      window.sortTarget=document.querySelector('.queue-list [data-queue-id]').dataset.queueId;
      const b=document.querySelector('.queue-item .entry-menu-trigger');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    })()`);
    await wait("!!document.querySelector('[role=menu]')");
    const before = await rows();
    await js(`(()=>{
      const item=window.sortFixture.items.find(i=>i.subject.id===window.sortTarget);
      item.subject.title=item.subject.members[0].title='ZZZZ moves to end';
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("document.querySelector('.queue-list').textContent.includes('ZZZZ moves to end')");
    assert.deepEqual(await rows(), before, 'Menu keeps entry positions stable during updates');
    await js("document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=menu]')");
    await wait("[...document.querySelectorAll('.queue-list [role=listitem][data-queue-id]')].at(-1)?.dataset.queueId===window.sortTarget");

    await js("document.querySelector('[title=\"Saved reviews\"]').click()");
    await wait("document.querySelector('.queue-toolbar h1')?.textContent==='Saved reviews'");
    await sort('generated');
    await wait("window.electronAPI.loadPreferences().then(p=>p.savedReviewSort?.key==='generated')");
    assert.ok(await js("!!document.querySelector('[aria-label=\"Sort direction: Newest first\"]')"));
    win.setSize(850, 700);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"));
    assert.ok(await js("(()=>{const r=document.querySelector('[aria-label=\"Sort PRs\"]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"));
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-pr-sorting.png'), (await win.webContents.capturePage()).toPNG());
    await click('Done');
    console.log('PR sorting passed: direction, grouping, persistence, saved views, menu stability, saved reviews, laptop layout.');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
