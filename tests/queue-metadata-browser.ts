import { loadWorkbenchPage, waitSettled } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const capture = async (name: string) => {
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-queue-metadata-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  /**
   * Rows stay put under the pointer when sync changes them (#549). Background sync adds and removes readiness, review
   * and comment badges, changes the checks label, and moves a PR it saw updated up the list. If a row's height or
   * place changed under the pointer, a click aimed at one row could land on another row's control, such as its Checks
   * button. Rows keep one height whatever their badges say, and the list keeps its order while the pointer is on it.
   */
  const stableRows = async () => {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    // A list long enough to be virtualized, as a real queue is: rows there are placed from their measured heights.
    await loadWorkbenchPage(win, `${url}?github-sync`);
    await wait("document.querySelectorAll('.queue-item').length > 0");
    await js(`(async()=>{
      const queue=await window.electronAPI.workbenchQueue();
      const items=Array.from({length:60},(_,i)=>{
        const item=structuredClone(queue.items[i%queue.items.length]);
        item.subject.id='stable-'+i;
        // The reader's own PRs: their Action group follows their checks and reviews, so sync moves them between groups.
        item.subject.members=item.subject.members.map((m,j)=>({...m,author:'oddur',url:'https://github.com/fixture/stable/pull/'+(100+i*4+j),number:100+i*4+j,headSha:'stablesha-'+i+'-'+j}));
        return item;
      });
      window.__stableItems=items;
      // One sync answer per state. 'plain' has few, short badges; 'busy' has more and longer ones, and comments.
      const readiness={state:'OPEN',isDraft:false,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'CHANGES_REQUESTED',baseBranch:'main',baseSha:'base',behindBy:0,mergeQueue:false,queueState:null};
      window.__stableState=r=>{const n=Number(r.url.split('/').pop());return {
        plain:{...r,checkedAt:Date.now(),comments:0,readiness,checks:{state:'success',passed:2,total:2}},
        busy:{...r,checkedAt:Date.now(),comments:1284,readiness:{...readiness,reviewDecision:['APPROVED','CHANGES_REQUESTED','REVIEW_REQUIRED'][n%3],mergeState:'BLOCKED',behindBy:12},
          checks:n%2?{state:'success',passed:140,total:140}:{state:'failure',passed:120,failed:17,skipped:3,total:140}},
      }};
      window.__stableMode='plain';
      window.electronAPI.getQueueSignals=async requests=>requests.map(r=>window.__stableState(r)[window.__stableMode]);
      window.electronAPI.workbenchQueue=async()=>({...queue,items:structuredClone(items)});
      window.electronAPI.workbenchSnapshot=window.electronAPI.workbenchQueue;
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("!!document.querySelector('[data-queue-total=\"60\"]') && !!document.querySelector('.queue-list [data-queue-id] .queue-checks.is-success')");
    // Rows whose status is on screen: those are the ones that watch sync.
    const rows = `[...document.querySelectorAll('.queue-list [data-queue-id]')].filter(row=>{const r=(row.querySelector('.queue-metadata')??row).getBoundingClientRect(),list=document.querySelector('.queue-list').getBoundingClientRect();return r.bottom>Math.max(0,list.top)&&r.top<Math.min(innerHeight,list.bottom)})`;
    type Row = { id: string; top: number; height: number; status: string };
    const geometry = () =>
      js<Row[]>(`${rows}.map(row=>{const r=row.getBoundingClientRect();return {id:row.dataset.queueId,top:r.top,height:r.height,status:row.querySelector('.queue-metadata')?.textContent??''}})`);
    // GNOSIS_QUEUE_ROW_SHOTS=1 prints the top rows as `QRSHOT <name> <part>/<parts> <base64 PNG part>` lines, for
    // review. Short lines keep other output from splitting them.
    const shot = async (name: string) => {
      if (!process.env.GNOSIS_QUEUE_ROW_SHOTS) return;
      await js('document.fonts.ready');
      const rect = await js<{ x: number; y: number; width: number; height: number }>(
        `(()=>{const r=${rows}.slice(0,3).map(row=>row.getBoundingClientRect());return {x:Math.floor(r[0].left),y:Math.floor(r[0].top),width:Math.ceil(r[0].width),height:Math.ceil(Math.min(innerHeight,r.at(-1).bottom)-r[0].top)}})()`
      );
      const png = (await win.webContents.capturePage(rect)).toPNG().toString('base64');
      const parts = Math.ceil(png.length / 4000);
      for (let i = 0; i < parts; i++) console.log(`QRSHOT ${name} ${i + 1}/${parts} ${png.slice(i * 4000, (i + 1) * 4000)}`);
    };
    // Every visible row gets the sync answer for `mode`; sent again while waiting, since a row that comes into view
    // subscribes after the first send. Waits until each row shows it and the list has settled.
    // Where the pointer rests. Each sync nudges it by a pixel first, as a resting hand does: a pointer that has not
    // moved for 5 s no longer holds the order (components/VirtualReviewQueue.tsx), and a slow runner can take that long.
    let resting: { x: number; y: number } | null = null;
    let nudge = 0;
    const sync = async (mode: 'plain' | 'busy', also = 'true') => {
      if (resting) win.webContents.sendInputEvent({ type: 'mouseMove', x: resting.x + (nudge++ % 2), y: resting.y });
      await js(`(()=>{window.__stableMode=${JSON.stringify(mode)};window.__stableEmit=()=>{
        for(const interest of window.syncFixture.subscriptions.values())if(interest.kind==='signals')
          for(const t of interest.targets)window.syncFixture.emit({kind:'signals',url:t.url,value:window.__stableState({url:t.url,headSha:t.headSha??''})[window.__stableMode]});
      }})()`);
      await wait(`(window.__stableEmit(),${rows}.every(row=>${mode === 'busy' ? '' : '!'}row.querySelector('.queue-comments'))&&(${also}))`);
      await waitSettled(win.webContents, 'queue-list');
    };
    const compare = (label: string, before: Row[], after: Row[]) => {
      assert.ok(before.length >= 3, `${label}: several rows on screen (${before.length})`);
      assert.ok(after.some((row, i) => row.status !== before.at(i)?.status), `${label}: sync changed the rows' badges`);
      const moved = after.flatMap((row, i) => {
        const was = before.at(i);
        return !was || was.id !== row.id || Math.abs(was.top - row.top) >= 0.5 || Math.abs(was.height - row.height) >= 0.5
          ? [`${was?.id}@${Math.round(was?.top ?? -1)}+${Math.round(was?.height ?? -1)} -> ${row.id}@${Math.round(row.top)}+${Math.round(row.height)}`]
          : [];
      });
      assert.deepEqual(moved, [], `${label}: rows keep their place and height`);
    };
    for (const [width, height] of [[1280, 800], [1024, 677], [860, 760], [720, 760]] as const) {
      win.setSize(width, height);
      await wait(`innerWidth===${win.getContentSize()[0]}`);
      resting = null;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
      await sync('plain');
      await js("document.querySelector('.queue-list').scrollTop=0");
      await waitSettled(win.webContents, 'queue-list');
      // The pointer rests on the second row's status line.
      const at = await js<{ x: number; y: number }>(`(()=>{const r=${rows}[1].querySelector('.queue-status-line').getBoundingClientRect();return {x:Math.round(r.left+8),y:Math.round(r.top+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      resting = at;
      const under = `document.elementFromPoint(${at.x},${at.y})?.closest('[data-queue-id]')?.dataset.queueId`;
      await wait(`${under}===${rows}[1].dataset.queueId`);
      const plain = await geometry();
      await shot(`plain-${width}`);
      // The same sync labels the rows on screen and reports the last one updated, which sorts it to the top of its
      // group. It also renames the first row: once the new name shows, the queue has rendered that snapshot.
      const moved = await js<{ id: string; position: number; renamed: string }>(`(()=>{const shown=${rows};const last=shown.at(-1);
        for(const row of shown){const item=window.__stableItems.find(i=>i.subject.id===row.dataset.queueId);
          item.subject.members=item.subject.members.map(m=>({...m,labels:['needs backport to release branches','performance regression','area: transport layer']}));}
        const item=window.__stableItems.find(i=>i.subject.id===last.dataset.queueId);
        item.subject.members=item.subject.members.map(m=>({...m,updatedAt:new Date(Date.now()+60_000).toISOString()}));
        const first=window.__stableItems.find(i=>i.subject.id===shown[0].dataset.queueId);
        first.subject.title=first.subject.members[0].title='Renamed by sync ${width}: keep pending commands in order when the worker restarts';
        window.syncFixture.changed();
        return {id:last.dataset.queueId,position:Number(last.getAttribute('aria-posinset')),renamed:first.subject.id}})()`);
      await sync('busy', `!!document.querySelector('[data-queue-id="${moved.renamed}"]')?.textContent.includes('Renamed by sync ${width}')`);
      const busy = await geometry();
      await shot(`busy-${width}`);
      compare(`${width}px, badges added and a row moved up`, plain, busy);
      assert.equal(await js(under), plain[1].id, 'The row under the pointer is still the one there');
      await sync('plain');
      compare(`${width}px, badges removed`, busy, await geometry());
      // Once the pointer leaves the list, the held order applies: the updated row moves up.
      resting = null;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
      await wait(`Number(document.querySelector('[data-queue-id="${moved.id}"]')?.getAttribute('aria-posinset'))<${moved.position}`);
      console.log(`Rows stay in place at ${width}px: ${plain.length} rows, heights ${[...new Set(plain.map((row) => Math.round(row.height)))].join('/')} px.`);
    }
    win.setSize(1280, 800);
    await wait(`innerWidth===${win.getContentSize()[0]}`);

    // Grouped by Action: sync moves PRs between groups, which fills, empties, adds and removes group headings. While
    // the pointer rests on the list, groups and headings hold too, and j walks the rows as they are drawn.
    await js("document.querySelector('[data-queue-group-by]').click()");
    await wait(`!!document.querySelector('.queue-group-popover input[value="action"]')`);
    await js(`document.querySelector('.queue-group-popover input[value="action"]').click()`);
    await wait(`document.querySelector('[data-queue-group-by]')?.dataset.queueGroupBy==='action'&&!document.querySelector('.queue-group-popover')&&!!document.querySelector('.queue-group-heading')`);
    // The first lines of the list: group headings with their counts, and entries.
    const layoutNow = `JSON.stringify([...document.querySelectorAll('.queue-list [data-queue-group], .queue-list [data-queue-id]')].map(e=>e.dataset.queueGroup ? e.dataset.queueGroup+':'+e.querySelector('.queue-group-count')?.textContent : e.dataset.queueId).slice(0,14))`;
    const layout = () => js<string>(layoutNow);
    resting = null;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    await sync('plain');
    await js("document.querySelector('.queue-list').scrollTop=0");
    await waitSettled(win.webContents, 'queue-list');
    const at = await js<{ x: number; y: number }>(`(()=>{const r=${rows}[1].querySelector('.queue-status-line').getBoundingClientRect();return {x:Math.round(r.left+8),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    resting = at;
    const under = `document.elementFromPoint(${at.x},${at.y})?.closest('[data-queue-id]')?.dataset.queueId`;
    await wait(`${under}===${rows}[1].dataset.queueId`);
    const heldLayout = await layout();
    const before = await geometry();
    await sync('busy');
    compare('Grouped by Action, PRs change groups', before, await geometry());
    assert.equal(await layout(), heldLayout, 'Groups and headings hold while the pointer rests on the list');
    // Down from the row under the pointer, once selected, goes to the next row drawn.
    const from = await js<string>(`${rows}[1].dataset.queueId`);
    await js(`${rows}[1].querySelector('.queue-row-main').click()`);
    await wait(`document.querySelector('[data-queue-id="${from}"] .queue-row-main')?.getAttribute('aria-pressed')==='true'`);
    const next = await js<string>(`(()=>{const ids=[...document.querySelectorAll('.queue-list [data-queue-id]')].sort((a,b)=>Number(a.getAttribute('aria-posinset'))-Number(b.getAttribute('aria-posinset'))).map(e=>e.dataset.queueId);return ids[ids.indexOf(${JSON.stringify(from)})+1]})()`);
    await js(`(()=>{const b=document.querySelector('[data-queue-id="${from}"] .queue-row-main');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`);
    await wait(`document.activeElement?.closest('[data-queue-id]')?.dataset.queueId===${JSON.stringify(next)}`);
    // Not vacuous: once the pointer leaves, the groups sync reported apply.
    resting = null;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    await wait(`${layoutNow}!==${JSON.stringify(heldLayout)}`);
    console.log(`Grouped rows stay in place: ${before.length} rows; held groups ${heldLayout.slice(0, 160)}`);
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await stableRows();
    // Saved status arrives with the first snapshot, so the first commit with rows has its badges.
    await loadWorkbenchPage(win, url + '?saved-signals');
    await wait('!!window.firstQueueFrame');
    const first = await js<{ rows: number; checks: { text: string; label: string; stale: boolean }[] }>('window.firstQueueFrame');
    assert.ok(first.checks.length > 0, 'The first queue frame shows check badges: ' + JSON.stringify(first));
    assert.ok(first.checks.every((check) => !check.text.includes('Checks not loaded')), 'No badge waits for GitHub: ' + JSON.stringify(first.checks));
    assert.ok(first.checks.every((check) => check.stale && /Last checked/.test(check.label)), 'Old saved status is marked out of date: ' + JSON.stringify(first.checks));
    console.log(`Saved badges in the first queue frame: ${first.checks.length} of ${first.rows} rows.`);
    await loadWorkbenchPage(win, url + '?polish');
    win.webContents.setZoomFactor(1);
    await wait("!!document.querySelector('.queue-checks.is-success')");
    assert.match(await js<string>("document.querySelector('.queue-meta').textContent"), /#\d+ opened .* by /);
    assert.ok(await js("document.querySelector('.queue-checks').textContent.includes('130/130')"));
    assert.ok(await js('!!document.querySelector(\'.queue-comments[aria-label="4 comments, including inline review comments"]\')'));
    assert.match(
      await js<string>("document.querySelector('.queue-checks').getAttribute('aria-label')"),
      /129 of 130 checks passed, 1 skipped or neutral/
    );
    assert.ok(
      await js(`(()=>{
      const rows=[...document.querySelectorAll('.queue-item')];
      const ready=rows.find(row=>row.querySelector('.queue-state'));
      const plain=rows.find(row=>!row.querySelector('.queue-state'));
      return ready && plain && Math.abs(ready.querySelector('.queue-metadata-line').getBoundingClientRect().right-plain.querySelector('.queue-metadata-line').getBoundingClientRect().right)<1;
    })()`),
      'Explanation status does not narrow the metadata row'
    );
    await capture('light');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    await js(`(async()=>{
      const queue=await window.electronAPI.workbenchQueue();
      const source=queue.items.find(i=>i.subject.kind==='pr');
      const items=Array.from({length:150},(_,i)=>{
        const item=structuredClone(source);item.subject.id='signals-'+i;item.subject.title='Queue metadata fixture '+i;
        item.subject.members=item.subject.members.map(m=>({...m,url:'https://github.com/fixture/signals/pull/'+(i+1),number:i+1,headSha:'signalsha-'+i,isDraft:i===1,merged:false,state:'open'}));
        if(i===2){item.subject.kind='stack';const m=item.subject.members[0];item.subject.members.push({...m,url:'https://github.com/fixture/signals/pull/1001',number:1001,merged:true,state:'closed'},{...m,url:'https://github.com/fixture/signals/pull/1002',number:1002,state:'closed'});}
        return item;
      });
      window.signalCalls=[];
      window.electronAPI.getQueueSignals=async(requests)=>{window.signalCalls.push(requests);return requests.filter(r=>!r.url.endsWith('/5')).map(r=>({...r,checkedAt:Date.now(),comments:4,checks:{state:r.url.endsWith('/2')?'pending':r.url.endsWith('/3')?'failure':r.url.endsWith('/4')?'neutral':'success',passed:r.url.endsWith('/4')?0:3,total:r.url.endsWith('/4')?0:4}}))};
      window.electronAPI.workbenchQueue=async()=>({...queue,items});document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait(
      "document.querySelector('[data-queue-total=\"150\"]') && window.signalCalls.length>0 && document.querySelector('.queue-checks.is-failure')"
    );
    assert.ok(await js('window.signalCalls.flat().length<25'), 'Only visible rows request status, not the backlog');
    assert.ok(await js('window.signalCalls.every(batch=>batch.length<=25)'));
    // These rows can fall below the scrollport on CI. Status reads are deliberately visible-only.
    await js(`document.querySelector('[data-queue-id="signals-1"]').scrollIntoView({block:'center'})`);
    await wait(`!!document.querySelector('[data-queue-id="signals-1"] .queue-checks.is-pending')`);
    await js(`document.querySelector('[data-queue-id="signals-3"]').scrollIntoView({block:'center'})`);
    await wait(
      `document.querySelector('[data-queue-id="signals-3"] .queue-checks.is-neutral')?.textContent.includes('No checks')`
    );
    await js(`document.querySelector('[data-queue-id="signals-4"]').scrollIntoView({block:'center'})`);
    await wait(
      `document.querySelector('[data-queue-id="signals-4"] .queue-checks')?.textContent.includes('Checks unavailable')`
    );
    await js("document.querySelector('.queue-list').scrollTop=0");
    await wait(`!!document.querySelector('[data-queue-id="signals-0"]')`);
    await capture('states');
    await js('document.querySelector(\'[data-queue-id="signals-2"] .queue-disclosure\').click()');
    await wait("!!document.querySelector('.queue-pr-icon.is-merged')");
    assert.ok(
      await js(
        "!!document.querySelector('.queue-pr-icon.is-draft') && !!document.querySelector('.queue-pr-icon.is-merged') && !!document.querySelector('.queue-pr-icon.is-closed')"
      )
    );
    await capture('expanded');

    const calls = await js<number>('window.signalCalls.length');
    await js("document.querySelector('.queue-toolbar button[aria-label]').click()");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await js('window.signalCalls.length'), calls, 'Queue refresh reuses recent status data');
    win.setSize(1100, 760);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    win.webContents.setZoomFactor(2);
    await capture('zoom');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    win.webContents.setZoomFactor(1);
    win.setSize(1280, 800);
    // Briefing chips: counts from the loaded snapshot that filter the queue through the shared filters.
    await loadWorkbenchPage(win, url + '?briefing-chips');
    await wait("document.querySelectorAll('.briefing-chip').length >= 5 && document.querySelectorAll('.queue-item').length > 0");
    const chipLabels = () => js<string[]>("[...document.querySelectorAll('.briefing-chip')].map(chip => chip.getAttribute('aria-label'))");
    const before = await chipLabels();
    const total = await js<number>("document.querySelectorAll('.queue-item').length");
    assert.deepEqual(before, [`All briefings: ${total}`, 'Generating: 1', 'Queued: 1', 'Ready: 2', 'Paused: 2, daily limit', 'Failed: 1']);
    assert.equal(await js("!!document.querySelector('.workbench-footer')"), false, 'Budget details moved into the chips row');
    assert.equal(await js("document.querySelector('.briefing-chips-budget').textContent"), '0 automatic left · resets at midnight');
    assert.match(await js<string>("document.querySelector('.briefing-chips-budget').title"), /0 of 10 automatic attempts left overall · Resets at midnight/);
    assert.equal(await js("document.querySelectorAll('.queue-item.is-briefing-generating').length"), 1);
    // macOS and Windows CI desktops prefer reduced motion, which removes the shimmer. Test each preference explicitly.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    assert.equal(await js("getComputedStyle(document.querySelector('.queue-item.is-briefing-generating'), '::after').animationName"), 'briefing-shimmer');
    await js("document.querySelector('.briefing-chip[data-state=paused]').click()");
    await wait("document.querySelectorAll('.queue-item').length === 2");
    assert.equal(await js("document.querySelector('.briefing-chip[data-state=paused]').getAttribute('aria-pressed')"), 'true');
    assert.deepEqual(await chipLabels(), before, 'A briefing filter keeps its own counts');
    assert.match(await js<string>("document.querySelector('.queue-filter-toggle').textContent"), /Filters \(1\)/);
    assert.ok(await js("!!document.querySelector('[aria-label=\"Remove Briefing: paused filter\"]')"));
    await capture('briefing-paused');
    await js("document.querySelector('.briefing-chip[data-state=paused]').click()");
    await wait(`document.querySelectorAll('.queue-item').length === ${total}`);
    await js("document.querySelector('.briefing-chip[data-state=generating]').click()");
    await wait("document.querySelectorAll('.queue-item').length === 1 && !!document.querySelector('.queue-item.is-briefing-generating')");
    await js("[...document.querySelectorAll('.queue-active-filters button')].find(button => button.textContent === 'Clear filters').click()");
    await wait(`document.querySelectorAll('.queue-item').length === ${total} && document.querySelector('.briefing-chip[data-state=all]').getAttribute('aria-pressed') === 'true'`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js("getComputedStyle(document.querySelector('.queue-item.is-briefing-generating'), '::after').animationName"), 'none');
    win.webContents.debugger.detach();
    // Merge conflicts filter: complete status for every candidate, shared batches, an explained unknown, saved views.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await loadWorkbenchPage(win, url + '?merge-conflicts');
    win.focus();
    await wait("document.querySelectorAll('.queue-item').length === 7");
    const slowWait = async (code: string, ms = 20_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await js(code)) return;
      throw Error('Timed out: ' + code + '\n' + (await js<string>("document.querySelector('.queue-header')?.parentElement?.innerText.slice(0, 800) ?? document.body.innerText.slice(0, 800)")));
    };
    const key = (keyCode: string, modifiers: ('shift')[] = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    assert.equal(await js("window.mergeCalls.some(call => call.options?.recheckMerge)"), false, 'Off: no merge re-checks');
    // Keyboard: open Filters, focus the Merge conflicts select and choose by typing.
    await js("document.querySelector('.queue-filter-toggle').focus()");
    key('Enter');
    await wait("!!document.querySelector('#queue-filter-panel')");
    const select = "[...document.querySelectorAll('#queue-filter-panel label')].find(label => label.querySelector('span')?.textContent === 'Merge conflicts')?.querySelector('select')";
    assert.deepEqual(await js(`[...${select}.options].map(option => option.textContent)`), ['Any', 'Has conflicts']);
    await js(`${select}.focus()`);
    key('H');
    await wait(`${select}.value === 'conflicts'`);
    await wait("/Checking merge state for \\d+ PRs?…/.test(document.querySelector('.queue-merge-status')?.textContent ?? '')");
    await capture('merge-loading');
    key('Escape');
    await slowWait("document.querySelectorAll('.queue-item').length === 2");
    assert.deepEqual(
      await js("[...document.querySelectorAll('.queue-item')].map(row => row.querySelector('.queue-stack-matches')?.textContent ?? 'pr').sort()"),
      ['1 of 3 PRs match', 'pr'],
      'The stack with one conflicting PR stays whole, and DIRTY with UNKNOWN mergeable counts'
    );
    await slowWait("document.querySelector('.queue-merge-status')?.textContent.includes('1 PR’s merge state is still being computed by GitHub')");
    assert.match(await js<string>("document.querySelector('.queue-merge-status').textContent"), /Checking again shortly/);
    assert.ok(await js("!!document.querySelector('[aria-label=\"Remove Merge conflicts filter\"]')"), 'Removable chip');
    assert.match(await js<string>("document.querySelector('.queue-filter-toggle').textContent"), /Filters \(1\)/);
    await capture('merge-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('merge-dark');
    await js("document.documentElement.classList.remove('dark')");
    // One re-check of just the unknown PR, after a short delay. It is still unknown, so it stays counted, not listed.
    await slowWait("window.mergeCalls.some(call => call.options?.recheckMerge)", 20_000);
    assert.deepEqual(await js("window.mergeCalls.filter(call => call.options?.recheckMerge).map(call => call.urls)"), [['https://github.com/klang/engine/pull/153']]);
    await slowWait("document.querySelector('.queue-merge-status')?.textContent.includes('Not listed until GitHub finishes')");
    assert.equal(await js("document.querySelectorAll('.queue-item').length"), 2);
    // Saved view keeps the filter across a reload.
    await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save view…').click()");
    await wait("!!document.querySelector('.view-name-form input')");
    await js("(()=>{const e=document.querySelector('.view-name-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Conflicts');e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()");
    await js("document.querySelector('.view-name-form').requestSubmit()");
    await wait("document.querySelector('.queue-toolbar h1')?.textContent === 'Conflicts'");
    win.reload();
    await slowWait("document.querySelector('.queue-toolbar h1')?.textContent === 'Conflicts' && !!document.querySelector('[aria-label=\"Remove Merge conflicts filter\"]')");
    await slowWait("document.querySelectorAll('.queue-item').length === 2");
    // Keyboard removal of the chip restores the whole queue and hides the status line.
    await js("document.querySelector('[aria-label=\"Remove Merge conflicts filter\"]').focus()");
    key('Enter');
    await slowWait("document.querySelectorAll('.queue-item').length === 7 && !document.querySelector('.queue-merge-status')");
    win.webContents.debugger.detach();
    console.log('Merge conflicts filter passed: keyboard selection, loading and unknown lines, one delayed re-check, stack rule, chip, saved view.');
    console.log(
      'Queue metadata passed: familiar identity, counts, all PR/check states, visible-only batching, cache reuse, themes and zoom.'
    );
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(1);
  }
});
