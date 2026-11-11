import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
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
    await loadWorkbenchPage(win, url);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      const cache=(await import('/lib/inspection-cache.ts')).inspectionData;
      const setTargets=cache.setTargets;
      cache.setTargets=(...args)=>{window.preloadIntent=args[2];return setTargets(...args)};
      const originalQueue=window.electronAPI.workbenchQueue;
      window.originalQueue=originalQueue;
      const original=await originalQueue();
      const pr=original.items.find(i=>i.subject.kind==='pr');
      const stack=original.items.find(i=>i.subject.kind==='stack');
      const items=Array.from({length:1000},(_,i)=>{
        const item=structuredClone(i===500?stack:pr);
        item.subject.id='synthetic-'+i;
        item.subject.title='Synthetic PR '+i+(i%7===0?' with a very long title that wraps when the briefing pane opens and the queue becomes narrower':'');
        item.subject.members=item.subject.members.map((m,j)=>({...m,title:'Synthetic PR '+i,id:'member-'+i+'-'+j,number:10000+i+j,url:'https://github.com/fixture/audit/pull/'+(10000+i+j)}));
        item.attention=i<300?'updated':i<700?'requested':'other';
        return item;
      });
      window.electronAPI.workbenchQueue=async()=>({...await originalQueue(),items});
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
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"]').scrollIntoView({block:'center'})");
    await wait("window.preloadIntent?.visible?.some(url=>url.includes('/pull/10500'))");
    assert.ok(await js("!window.preloadIntent.visible.some(url=>url.endsWith('/pull/10000'))"), 'Offscreen selected rows are not counted as visible');
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').click()");
    await wait("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').getAttribute('aria-pressed')==='true'");
    await wait("window.preloadIntent?.active?.some(url=>url.includes('/pull/10500'))");
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-disclosure').click()");
    await wait("document.querySelectorAll('[data-queue-id=\"synthetic-500\"] .queue-member').length===3");
    // ResizeObserver delivers measurements after the expanded children mount.
    await wait(`(()=>{const a=document.querySelector('[data-queue-id="synthetic-500"]'),b=document.querySelector('[data-queue-id="synthetic-501"]');return !b||a.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+1})()`);
    await js("document.querySelector('[data-queue-id=\"synthetic-500\"] .queue-row-main').focus()");
    for (let i = 0; i < 25; i++) {
      await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
      await wait(`document.activeElement?.closest('[data-queue-id]')?.dataset.queueId==='synthetic-${501+i}'`);
    }
    assert.ok(await js(`(()=>{const r=document.activeElement.getBoundingClientRect(),q=document.querySelector('.queue-list').getBoundingClientRect();return r.top>=q.top&&r.bottom<=q.bottom+1})()`), 'Keyboard selection scrolls into view');
    await js("document.querySelector('[aria-label^=\"Sort: \"]').click()");
    await js("window.selectOption('#pr-sort-key','title')");
    await click('Done');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.sort.key==='title')");
    const selectedOffset = await js<number>("document.querySelector('[data-queue-id=\"synthetic-525\"]').getBoundingClientRect().top-document.querySelector('.queue-list').getBoundingClientRect().top");
    await js("window.syntheticQueue[525].subject.members[0].title='Synthetic PR 50.5';document.querySelector('.queue-toolbar button[aria-label]').click()");
    await wait("document.querySelector('[data-queue-id=\"synthetic-525\"]').dataset.index==='51'");
    await new Promise(resolve => setTimeout(resolve, 700));
    await wait(`Math.abs(document.querySelector('[data-queue-id="synthetic-525"]').getBoundingClientRect().top-document.querySelector('.queue-list').getBoundingClientRect().top-${selectedOffset})<5`);
    const offset = await js<number>("document.querySelector('.queue-list').scrollTop");
    await js("document.querySelector('.queue-toolbar button[aria-label]').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(Math.abs(await js<number>("document.querySelector('.queue-list').scrollTop") - offset) < 2, 'Cache refresh retains scroll position');
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    const returnFrames = await js<Array<{ rows: number; visible: number; loading: boolean }>>(`new Promise(resolve => {
      const frames = [];
      // Returning must use the queue already in memory, even if backend reads stall.
      const methods = ['workbenchQueue', 'workbenchSnapshot'];
      const originals = methods.map(name => window.electronAPI[name]);
      methods.forEach(name => { window.electronAPI[name] = () => new Promise(() => {}); });
      document.querySelector('.pr-summary-page button').click();
      function sample() {
        const queue = document.querySelector('.queue-list');
        if (queue) {
          const bounds = queue.getBoundingClientRect();
          const rows = [...queue.querySelectorAll('.queue-item')];
          frames.push({ rows: rows.length, visible: rows.filter(row => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          }).length, loading: queue.textContent.includes('Loading') });
        }
        if (frames.length === 12) {
          methods.forEach((name, index) => { window.electronAPI[name] = originals[index]; });
          resolve(frames);
        }
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`);
    assert.ok(returnFrames.every(frame => frame.visible > 0 && !frame.loading),
      'Returning to the queue must never paint blank: ' + JSON.stringify(returnFrames));
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
    // Sync pushes: unchanged content must cost no rows and no reads; one changed entry costs one row.
    await js(`(()=>{const e=document.querySelector('[aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait("document.querySelectorAll('.queue-item').length>5");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await js(`(()=>{
      window.counts={snapshots:0,reviews:0};
      const snapshot=window.electronAPI.workbenchSnapshot;
      window.electronAPI.workbenchSnapshot=(...args)=>{window.counts.snapshots++;return snapshot(...args)};
      const reviews=window.electronAPI.listReviews;
      window.electronAPI.listReviews=(...args)=>{if(!window.fixtureInternalRead)window.counts.reviews++;return reviews(...args)};
      window.resetCounts=()=>{window.counts.snapshots=0;window.counts.reviews=0;window.__queueRowRenders=0};
      window.__countRenders=true;window.resetCounts();
    })()`);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
    type Counts = { snapshots: number; reviews: number; rows: number };
    const counts = () => js<Counts>('({...window.counts,rows:window.__queueRowRenders})');
    const revisions = await js<{ revision: string; historyRevision: string }>(
      `window.electronAPI.workbenchQueue().then(q=>({revision:q.revision,historyRevision:q.historyRevision}))`
    );
    await js('window.resetCounts()');
    for (let i = 0; i < 5; i++)
      await js(`window.dispatchEvent(new CustomEvent('fixture-workbench-change',{detail:${JSON.stringify(revisions)}}))`);
    await settle();
    const withRevisions = await counts();
    assert.deepEqual(withRevisions, { snapshots: 0, reviews: 0, rows: 0 }, 'An unchanged push with revisions reads and renders nothing');
    await js('window.resetCounts()');
    for (let i = 0; i < 5; i++) await js("window.dispatchEvent(new Event('fixture-workbench-change'))");
    await settle();
    const withoutRevisions = await counts();
    assert.ok(withoutRevisions.snapshots <= 1 && withoutRevisions.reviews === 0 && withoutRevisions.rows === 0,
      'An unchanged push without revisions reads one snapshot and renders nothing: ' + JSON.stringify(withoutRevisions));
    const changedId = await js<string>("document.querySelector('[data-queue-id] .queue-item').closest('[data-queue-id]').dataset.queueId");
    await js(`(()=>{window.resetCounts();const item=window.syntheticQueue.find(i=>i.subject.id===${JSON.stringify(changedId)});
      item.briefing={key:'fresh',status:'ready',summary:'Fresh briefing from sync',updatedAt:new Date().toISOString()};
      window.dispatchEvent(new Event('fixture-workbench-change'));})()`);
    await wait(`document.querySelector('[data-queue-id=${JSON.stringify(changedId)}]')?.textContent.includes('Fresh briefing from sync')`);
    await settle();
    const oneChanged = await counts();
    assert.equal(oneChanged.rows, 1, 'Only the changed row renders: ' + JSON.stringify(oneChanged));
    assert.ok(oneChanged.snapshots <= 1 && oneChanged.reviews === 0, 'One changed entry reads one snapshot: ' + JSON.stringify(oneChanged));
    // Opening a PR and returning reveals the same queue: same row node, same scroll, no reload.
    await js(`window.keptRow=document.querySelector('[data-queue-id="synthetic-525"] .queue-row-main');window.keptScroll=document.querySelector('.queue-list').scrollTop;window.resetCounts();`);
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    await js("document.querySelector('.pr-summary-page button').click()");
    await wait("!document.querySelector('.pr-summary-page')&&!!document.querySelector('.queue-list')?.checkVisibility()");
    await settle();

    assert.equal(await js('window.keptRow.isConnected&&document.querySelector(\'[data-queue-id="synthetic-525"] .queue-row-main\')===window.keptRow'), true, 'Returning keeps the same row element');
    assert.ok(Math.abs(await js<number>("document.querySelector('.queue-list').scrollTop-window.keptScroll")) < 2, 'Returning keeps the queue scroll position');
    const returned = await counts();
    assert.ok(returned.snapshots <= 1 && returned.reviews === 0, 'Returning does not reload the queue: ' + JSON.stringify(returned));
    console.log('Sync push counts (snapshots, saved-review reads, row renders):', JSON.stringify({ withRevisions, withoutRevisions, oneChanged, returned }));
    // A portaled popover opened from the queue must hide with the queue when a PR opens.
    await js("document.querySelector('.queue-filter-toggle').click()");
    await wait("!!document.querySelector('.queue-filter-popover')?.checkVisibility()");
    await js("document.querySelector('[data-queue-id=\\'synthetic-525\\'] .queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.pr-summary-page')");
    // Activity does not hide portaled content; the queue must hide its own popover.
    assert.equal(await js("!!document.querySelector('.queue-filter-popover')?.checkVisibility()"), false, 'A popover from the hidden queue is hidden');
    await js("document.querySelector('.pr-summary-page button').click()");
    await wait("!!document.querySelector('.queue-list')?.checkVisibility()");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await js("document.querySelector('.queue-filter-popover [aria-label=\\'Close filters\\']')?.click()");
    await wait("!document.querySelector('.queue-filter-popover')?.checkVisibility()");
    // Kept PR tabs: Changes keeps its element and scroll position across a visit to Feedback.
    await js('window.__countRenders=false;window.electronAPI.workbenchQueue=window.originalQueue;document.querySelector(\'.queue-toolbar button[aria-label]\').click()');
    await wait(`!document.querySelector('[data-queue-id^="synthetic-"]')&&!!document.querySelector('.queue-row-main')`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    const tab = (name: string) =>
      js(`(()=>{const t=[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(t=>t.textContent.trim().startsWith(${JSON.stringify(name)}));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await tab('Changes');
    // The diff stream is the reading position. A wheel event marks the scroll as the reader's own.
    const scroller = `document.querySelector('.pr-changes .commit-diff-stream')`;
    await wait(`(()=>{const e=${scroller};return !!e&&e.scrollHeight>e.clientHeight+200})()`);
    await js(`(()=>{window.keptChanges=document.querySelector('.pr-changes');window.keptScroller=${scroller};window.keptScroller.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true}));window.keptScroller.scrollTop=120;})()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const changesScroll = await js<number>('window.keptScroller.scrollTop');
    assert.ok(changesScroll > 0, 'The changes pane scrolled');
    await tab('Feedback');
    await wait("!!document.querySelector('.pr-changes-tab[data-state=active]')&&!window.keptChanges.checkVisibility()");
    // Hidden content has no layout. Record what Chromium reports, which is why kept tabs restore scroll.
    console.log('Hidden Changes pane scrollTop:', await js<number>('window.keptScroller.scrollTop'));
    await tab('Changes');
    await wait('window.keptChanges.checkVisibility()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await js("document.querySelector('.pr-changes')===window.keptChanges"), true, 'Changes stays mounted across tabs');
    assert.equal(await js<number>('window.keptScroller.scrollTop'), changesScroll, 'Changes keeps its scroll position');
    console.log('Large queue passed: bounded DOM, dynamic stacks, offscreen keyboard navigation, refresh/return scroll restoration, resize, filtering, sync push render counts, kept queue and PR tabs.');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); win.destroy(); app.exit(1);
  }
});
