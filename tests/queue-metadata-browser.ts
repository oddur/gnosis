import { loadWorkbenchPage } from './workbench-ready';
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
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
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
    assert.ok(await js('!!document.querySelector(\'.queue-comments[aria-label="4 conversation comments"]\')'));
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
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js("getComputedStyle(document.querySelector('.queue-item.is-briefing-generating'), '::after').animationName"), 'none');
    win.webContents.debugger.detach();
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
