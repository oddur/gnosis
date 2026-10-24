import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (text: string) => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await win.loadURL(url);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(async()=>{
      const original=await window.electronAPI.workbenchQueue();
      const pr=original.items.find(i=>i.subject.kind==='pr');
      const stack=original.items.find(i=>i.subject.kind==='stack');
      const items=Array.from({length:1000},(_,i)=>{
        const item=structuredClone(i===500?stack:pr);
        item.subject.id='synthetic-'+i;
        item.subject.title='Synthetic PR '+i+(i%7===0?' with a very long title that wraps when the briefing pane opens and the queue becomes narrower':'');
        item.subject.members=item.subject.members.map((m,j)=>({...m,id:'member-'+i+'-'+j,number:10000+i+j,url:'https://github.com/fixture/audit/pull/'+(10000+i+j)}));
        item.attention=i<300?'updated':i<700?'requested':'other';
        return item;
      });
      window.electronAPI.workbenchQueue=async()=>({...original,items});
      window.syntheticQueue=items;
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("document.querySelector('[data-queue-total=\"1000\"]')");
    assert.ok(await js("document.querySelectorAll('.queue-item').length<40"), 'Large queue mounts only nearby rows');
    // Row wrapping and window chrome differ across CI operating systems.
    // Seek using mounted row indices rather than assuming a fixed pixel offset.
    await js(`(async()=>{
      const queue=document.querySelector('.queue-list');
      queue.scrollTop=500*104;
      for(let attempt=0;attempt<30;attempt++){
        await new Promise(resolve=>setTimeout(resolve,50));
        if(document.querySelector('[data-queue-id="synthetic-500"]'))return;
        const candidates=[...document.querySelectorAll('[data-index]')].filter(el=>Number(el.dataset.index)>0);
        candidates.sort((a,b)=>Math.abs(a.getBoundingClientRect().top-queue.getBoundingClientRect().top)-Math.abs(b.getBoundingClientRect().top-queue.getBoundingClientRect().top));
        const anchor=candidates[0];
        if(anchor)queue.scrollTop+=(500-Number(anchor.dataset.index))*104;
      }
    })()`);
    await wait("!!document.querySelector('[data-queue-id=\"synthetic-500\"]')");
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').click()");
    await wait("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').getAttribute('aria-pressed')==='true'");
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-disclosure').click()");
    await wait("document.querySelectorAll('[data-queue-id=\"synthetic-500\"] .queue-member').length===3");
    assert.ok(await js(`(()=>{const a=document.querySelector('[data-queue-id="synthetic-500"]'),b=document.querySelector('[data-queue-id="synthetic-501"]');return !b||a.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+1})()`), 'Expanded stack cannot overlap the next row');
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').focus()");
    for (let i = 0; i < 25; i++) {
      await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
      await wait(`document.activeElement?.closest('[data-queue-id]')?.dataset.queueId==='synthetic-${501+i}'`);
    }
    assert.ok(await js(`(()=>{const r=document.activeElement.getBoundingClientRect(),q=document.querySelector('.queue-list').getBoundingClientRect();return r.top>=q.top&&r.bottom<=q.bottom+1})()`), 'Keyboard selection scrolls into view');
    const offset = await js<number>("document.querySelector('.queue-list').scrollTop");
    await js("document.querySelector('.queue-toolbar button[aria-label]').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(Math.abs(await js<number>("document.querySelector('.queue-list').scrollTop") - offset) < 2, 'Cache refresh retains scroll position');
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    await js("document.querySelector('.pr-summary-page button').click()");
    await wait("!!document.querySelector('.queue-list')");
    await wait("!!document.querySelector('[data-queue-id=\"synthetic-525\"]')");
    await wait(`Math.abs(document.querySelector('.queue-list').scrollTop-${offset})<5`);
    win.setSize(850, 700);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"), 'Resizing does not overflow the window');
    await js(`(()=>{const e=document.querySelector('[aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Synthetic PR 999');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait("document.querySelectorAll('.queue-item').length===1");
    assert.match(await js<string>("document.querySelector('.queue-item').textContent"), /Synthetic PR 999/);
    assert.equal(await js("document.querySelector('.queue-row-main').tabIndex"), 0, 'Filtered queue retains an entry tab stop');
    console.log('Large queue passed: bounded DOM, dynamic stacks, offscreen keyboard navigation, refresh/return scroll restoration, resize, filtering.');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); win.destroy(); app.exit(1);
  }
});
