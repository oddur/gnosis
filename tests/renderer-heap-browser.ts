import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

/**
 * Renderer heap in a long session (#355). A reader opens 20 PRs with large diffs one after another, each in a workspace
 * tab, reads a few files in Changes, steps through the queue so neighbours are predicted, and closes old tabs as new
 * ones open. The JS heap is measured after a full garbage collection, before, during and after.
 *
 * Checks, all on the heap after a full garbage collection:
 * - with six large PRs open, it stays under a budget;
 * - once every tab closes, it returns near where it started;
 * - what the inspection caches still hold then is bounded: dropping every PR from them (as 15 idle minutes do) frees
 *   less than a budget. Before #355 they kept about 45 MB here, and the heap stayed 25 MB over the baseline.
 * Byte budgets do not depend on the machine's speed, so they are not scaled like timing budgets (tests/perf-budget.ts);
 * they leave room for V8's own variation between runs, a few MB.
 *
 * GNOSIS_HEAP_SNAPSHOT_DIR=dir also writes heap snapshots at the peak and after the tabs close, for a closer look.
 */
const PRS = 20;
const KEEP_TABS = 6;
const FILES_PER_PR = 300;

/** Heap budgets in MB. Calibrated in Docker; see the numbers this suite prints. */
// Six hidden PR tabs stay mounted, with their Changes views; in this development build that is most of the peak.
const PEAK_OVER_BASELINE_MB = 170;
const CLOSED_OVER_BASELINE_MB = 30;
// The renderer's inspection caches hold at most about 24 MB of ASCII text by their bounds (lib/inspection-limits.ts);
// here they keep about 17 MB. Before #355 they kept about 45 MB.
const CACHED_AFTER_CLOSE_MB = 30;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(code.slice(0, 300) + ': ' + String(error));
    }) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (expression: string, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await sleep(40);
    }
    const page = await js<string>("JSON.stringify({tabs:[...document.querySelectorAll('[role=tab]')].map(t=>t.textContent.trim()+':'+t.getAttribute('aria-selected')+':'+!!t.closest('[data-workspace-active=true]')),text:(document.querySelector('[data-workspace-active=true]')??document.body).innerText.slice(0,400)})");
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}\n${page}`);
  };
  try {
    if (process.platform === 'darwin') app.show();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    const debug = win.webContents.debugger;
    debug.attach('1.3');
    // Predictions wait for a focused window; CI windows may never get focus.
    await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);

    /** The JS heap after a full garbage collection, in MB, and what the renderer's caches report. */
    const measure = async () => {
      // Collect until the heap settles: just after tabs close, React's passive cleanup and weak callbacks free more on
      // later passes. On CI a single settled-looking pass still held about 18 MB that the next ones freed.
      const used = async () => {
        await debug.sendCommand('HeapProfiler.collectGarbage');
        return ((await debug.sendCommand('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
      };
      let heap = { usedSize: await used() };
      for (let pass = 0; pass < 8; pass++) {
        await sleep(400);
        const next = await used();
        const settled = heap.usedSize - next < 1e6;
        heap = { usedSize: Math.min(heap.usedSize, next) };
        if (settled) break;
      }
      const caches = await js<Record<string, unknown>>(
        `(async()=>(await (await import('/lib/diagnostics.ts')).collectRendererDiagnostics()).caches)()`
      );
      return { heapMB: Math.round(heap.usedSize / 1e5) / 10, caches };
    };
    const snapshot = async (name: string) => {
      const dir = process.env.GNOSIS_HEAP_SNAPSHOT_DIR;
      if (!dir) return;
      const chunks: string[] = [];
      const collect = (_event: unknown, method: string, params: { chunk?: string }) => {
        if (method === 'HeapProfiler.addHeapSnapshotChunk' && params.chunk) chunks.push(params.chunk);
      };
      debug.on('message', collect);
      await debug.sendCommand('HeapProfiler.enable');
      await debug.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      debug.removeListener('message', collect);
      await debug.sendCommand('HeapProfiler.disable');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.heapsnapshot`), chunks.join(''));
    };

    // ── Fixtures: 24 PRs with large diffs ─────────────────────────
    // Each PR has 300 modified files with 40-line patches, about 1 MB of inventory, as in the export in #355, and one
    // 3,000-line file. Every read returns fresh objects, as IPC does.
    await js(String.raw`(async()=>{
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];
      const lines=(n,f)=>Array.from({length:n},(_,i)=>f(i)).join('\n');
      const line=(pr,file,k)=>'export const value'+k+' = computeSomething('+k+', "pr '+pr+' file '+file+'"); // keeps the line long enough';
      const before=(pr,file)=>lines(400,k=>line(pr,file,k));
      const patch=(pr,file)=>'@@ -100,40 +100,40 @@\n'+lines(40,k=>k%8===3?'-'+line(pr,file,100+k)+'\n+'+line(pr,file,100+k).replace('keeps','holds'):' '+line(pr,file,100+k));
      const huge=pr=>lines(3000,k=>'export function generated'+k+'(input: number): number { return input * '+k+' + '+pr+'; }');
      const prUrl=n=>'https://github.com/fixture/heap/pull/'+(30000+n);
      const prOf=url=>{const m=/\/heap\/pull\/(\d+)$/.exec(url);return m?Number(m[1])-30000:-1};
      const files=pr=>[{path:'src/a-generated/huge.ts',status:'added',additions:3000,deletions:0,changeId:'huge-'+pr},
        ...Array.from({length:${FILES_PER_PR}},(_,i)=>({path:'src/area'+(i%25)+'/module'+i+'.ts',status:'modified',additions:5,deletions:5,changeId:'c'+pr+'-'+i,patch:patch(pr,i)}))];
      const api=window.electronAPI;
      const changes=api.getPrChanges,commits=api.getPrCommits,read=api.getPrChangeFile,after=api.getPrChangeFileAfter,comparison=api.getCommitComparison;
      api.getPrChanges=async(url,...rest)=>{const s=await changes(url,...rest);const pr=prOf(url);return pr<0?s:{...s,files:files(pr),metadata:{...s.metadata,headSha:'heap-head-'+pr}}};
      api.getPrCommits=async(url,...rest)=>{const s=await commits(url,...rest);const pr=prOf(url);return pr<0?s:{...s,metadata:{...s.metadata,headSha:'heap-head-'+pr}}};
      api.getCommitComparison=async(selection,...rest)=>{const s=await comparison(selection,...rest);const pr=prOf(selection.url);return pr<0?s:{...s,files:files(pr)}};
      const contents=r=>{const pr=prOf(r.url);
        if(r.path==='src/a-generated/huge.ts')return {before:{kind:'absent'},after:{kind:'text',content:huge(pr)}};
        const i=Number(r.path.match(/module(\d+)/)?.[1]??0);
        return {before:{kind:'text',content:before(pr,i)},after:{kind:'text',content:before(pr,i).replaceAll('keeps','holds')}}};
      api.getPrChangeFile=async(r,...rest)=>prOf(r.url)<0?read(r,...rest):contents(r);
      api.getPrChangeFileAfter=async(r,...rest)=>prOf(r.url)<0?after(r,...rest):contents(r).after;
      const originalQueue=api.workbenchQueue;
      const original=await originalQueue();
      const template=original.items.find(i=>i.subject.kind==='pr')??original.items[0];
      const items=[...Array.from({length:24},(_,n)=>{
        const item=structuredClone(template);
        item.subject.id='heap-'+n;
        item.subject.members=[{...item.subject.members[0],title:'Heap PR '+n,number:30000+n,url:prUrl(n),headSha:'heap-head-'+n,
          description:('## Heap PR '+n+'\n\nThis change keeps **pending commands** ordered when the worker restarts.\n\n').repeat(20)}];
        item.subject.title='Heap PR '+n;
        item.attention='requested';
        return item;
      }),...original.items];
      api.workbenchQueue=async()=>structuredClone({...await originalQueue(),items});
      api.workbenchSnapshot=api.workbenchQueue;
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait(`!!document.querySelector('[data-queue-total="${24 + 7}"]')`);
    await wait("document.querySelectorAll('.queue-item').length>5");
    await sleep(1500);

    const tabs = "document.querySelectorAll('.workspace-tab-select')";
    const prTab = (label: string) =>
      `[...document.querySelectorAll('[data-workspace-active=true] .pr-overview-tabs [role=tab]')].find(t=>t.textContent.trim().startsWith(${JSON.stringify(label)}))`;
    const press = (expression: string) =>
      js(`(()=>{const b=${expression};if(!b)throw Error('Missing target');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
    const search = (text: string) =>
      js(`(()=>{const e=document.querySelector('[data-workspace-active=true] [aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const toQueue = async () => {
      await js(`${tabs}[0].click()`);
      await wait(`!!document.querySelector('[data-workspace-active=true] .queue-list')`);
    };
    const closeTab = async (index: number) => {
      const before = await js<number>(`${tabs}.length`);
      await js(`document.querySelectorAll('.workspace-tab-close')[${index}].click()`);
      await wait(`${tabs}.length===${before - 1}`);
    };

    const baseline = await measure();
    const samples: Record<string, number> = { baseline: baseline.heapMB };
    let peak = baseline;
    for (let n = 0; n < PRS; n++) {
      // Find the PR, as a reader does, and open it in a tab of its own.
      await toQueue();
      await search(`Heap PR ${n}`);
      await wait(`[...document.querySelectorAll('[data-workspace-active=true] .queue-row-main')].some(b=>b.textContent.includes('Heap PR ${n}'))`);
      const before = await js<number>(`${tabs}.length`);
      await js(
        `[...document.querySelectorAll('[data-workspace-active=true] .queue-row-main')].find(b=>/Heap PR ${n}(?!\\d)/.test(b.textContent)).dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
      );
      await wait(`${tabs}.length===${before + 1}`);
      await js(`${tabs}[${before}].click()`);
      await wait(`!!document.querySelector('[data-workspace-active=true] .pr-summary-page')`);
      await press(prTab('Changes'));
      await wait(`window.deepAll('[role=treeitem]').filter(e=>e.checkVisibility()).length>10`);
      await sleep(400);
      // Read the large file and a few others from the tree.
      for (const name of ['huge.ts', 'module1.ts', 'module26.ts', 'module51.ts']) {
        await js(`window.deepAll('[role=treeitem]').find(e=>e.checkVisibility()&&e.getAttribute('aria-label')===${JSON.stringify(name)})?.click()`);
        await sleep(250);
      }
      await press(prTab('Summary'));
      await sleep(200);
      // Back in the queue, step over the next rows so their PRs are predicted as neighbours.
      await toQueue();
      await search('Heap PR');
      await wait("document.querySelectorAll('[data-workspace-active=true] .queue-row-main').length>3");
      await js("document.querySelectorAll('[data-workspace-active=true] .queue-row-main')[0].focus()");
      for (let k = 0; k < 3; k++) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'j' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: 'j' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'j' });
        await sleep(300);
      }
      await search('');
      // Keep the most recent tabs, as a reader closes old ones.
      if ((await js<number>(`${tabs}.length`)) > KEEP_TABS + 1) await closeTab(1);
      if (n % 5 === 4) {
        const sample = await measure();
        samples[`after ${n + 1} PRs`] = sample.heapMB;
        if (sample.heapMB > peak.heapMB) peak = sample;
      }
    }
    await sleep(1000);
    const open = await measure();
    samples['tabs open'] = open.heapMB;
    if (open.heapMB > peak.heapMB) peak = open;
    await snapshot('peak');
    for (let count = await js<number>(`${tabs}.length`); count > 1; count--) await closeTab(count - 1);
    await toQueue();
    await sleep(3000);
    const closed = await measure();
    samples['tabs closed'] = closed.heapMB;
    await snapshot('closed');
    // What the caches still hold: the PRs the queue tab showed and the neighbours predicted for it. Fifteen idle
    // minutes drop them.
    const idle = await js<string[]>(
      `(async()=>(await import('/lib/inspection-cache.ts')).sweepIdleInspection(Date.now()+24*3600_000))()`
    );
    const swept = await measure();
    samples['idle PRs dropped'] = swept.heapMB;

    console.log('Renderer heap after GC (MB):', JSON.stringify(samples));
    console.log('Caches at the peak:', JSON.stringify(peak.caches));
    console.log('Caches after the tabs closed:', JSON.stringify(closed.caches));
    console.log(`Idle sweep dropped ${idle.length} PRs:`, JSON.stringify(swept.caches));
    assert.deepEqual(errors, [], 'No renderer errors');
    assert.ok(
      peak.heapMB - baseline.heapMB < PEAK_OVER_BASELINE_MB,
      `The heap with ${KEEP_TABS} large PRs open stays within ${PEAK_OVER_BASELINE_MB} MB of the baseline: ${JSON.stringify(samples)}`
    );
    assert.ok(
      closed.heapMB - baseline.heapMB < CLOSED_OVER_BASELINE_MB,
      `After the tabs close the heap returns within ${CLOSED_OVER_BASELINE_MB} MB of the baseline: ${JSON.stringify(samples)}`
    );
    assert.ok(
      closed.heapMB - swept.heapMB < CACHED_AFTER_CLOSE_MB,
      `After the tabs close the inspection caches hold less than ${CACHED_AFTER_CLOSE_MB} MB: ${JSON.stringify(samples)}`
    );
    assert.equal((swept.caches.inspection as { prs: number }).prs, 0, 'Idle PRs leave every inspection cache');
    console.log('Renderer heap checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
