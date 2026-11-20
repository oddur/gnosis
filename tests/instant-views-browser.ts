import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { withinPerf } from './perf-budget';

/**
 * Instant views (#343, #344). Saved copies render at once while a slow GitHub revalidates, and neighbours and hovered
 * rows are prepared before the reader gets there. Every measurement is printed as one `[instant-views]` line, so a run
 * on an older build reports its numbers even where the assertions fail.
 */
/**
 * Main's snapshot answers this long after it is asked. The startup checks are about order, not speed: the saved queue
 * and the last open PR must show before main answers. That holds on any runner, however slowly the dev server
 * compiles the PR screen, because nothing the reader sees waits for main. The times are printed for comparison.
 */
const SLOW_START = 5000;
const SLOW_NETWORK = 1200;
/** Generous ceilings that only catch a regression to waiting, never a slow runner. */
const QUEUE_BUDGET_MS = 2000;
/** Switching to a prepared PR or tab. Instant means no loading state and a predictor hit; this only bounds it. */
const SWITCH_BUDGET_MS = 1000;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const state = await js(`({reads:window.instantViews?.reads.slice(-25).map(r=>[r.name,r.mode,r.url?.split('/').pop(),Math.round(performance.now()-r.at)]),
      loading:[...document.querySelectorAll('.loading-state,.changes-loading,.loading-indicator')].filter(e=>e.offsetParent!==null).map(e=>e.className+':'+e.textContent.slice(0,60)),
      text:document.querySelector('[role=tabpanel] main, main')?.innerText.slice(0,1500)})`);
    throw new Error(`Timed out: ${code}\n${JSON.stringify(state)}`);
  };
  const click = (label: string) =>
    js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.offsetParent!==null);if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  // Each measurement prints as it is taken, so a build that stalls part-way still reports what it reached.
  const metrics = new Proxy<Record<string, unknown>>({}, {
    set: (target, key, value) => { target[key as string] = value; console.log(`[instant-views] ${String(key)} ${JSON.stringify(value)}`); return true; },
  });
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const base = `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&instant-views`;
  const slow = `${base}&keep-progress&slow-start=${SLOW_START}&slow-network=${SLOW_NETWORK}`;
  /** Time to content after `action`, and whether a loading state showed first. Content is `ready`, checked each frame. */
  // Radix tabs switch on mousedown.
  const tabs = "window.openTab=name=>{const t=[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent.trim().startsWith(name)&&t.offsetParent!==null);if(!t)throw Error('Missing tab '+name);t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()};";
  const timeTo = (ready: string, action: string) => js<{ ms: number; loading: string[] }>(`${tabs}new Promise(async resolve=>{
    const loading=[];const start=performance.now();
    const seen=()=>{for(const e of document.querySelectorAll('.loading-state,.changes-loading,.commits-loading'))if(e.offsetParent!==null&&!e.closest('.commit-stream-row:not([data-active=true])')){const t=e.textContent.trim().slice(0,60);if(!loading.includes(t))loading.push(t)}};
    const observer=new MutationObserver(seen);observer.observe(document.body,{subtree:true,childList:true,attributes:true});
    ${action};
    const tick=()=>{seen();if(${ready}){observer.disconnect();resolve({ms:Math.round(performance.now()-start),loading})}else if(performance.now()-start>15000){observer.disconnect();resolve({ms:-1,loading})}else requestAnimationFrame(tick)};
    tick();
  })`);
  const changesReady = "!!document.querySelector('.commit-stream-row[data-active=true] .changes-file-header')&&!document.querySelector('.commit-stream-row[data-active=true] .changes-loading')";
  try {
    if (process.platform === 'darwin') app.show();
    // 1. A first launch saves the queue. Nothing is slow yet.
    await loadWorkbenchPage(win, base);
    // Intent predictions (neighbours, hovered rows) wait for a focused window, and a CI runner's window may never get
    // focus, as on macOS runners. The page is told it has focus: this suite is about what is prepared. Attached after
    // the first load, since a window that has never navigated does not answer CDP commands.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
    // The copy is saved two seconds after the queue or its rows' status last changed.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const lastChecks = await js<string[]>("[...document.querySelectorAll('.queue-checks')].map(e=>e.textContent)");

    // 2. Restart with the snapshot and GitHub slow. The saved queue paints before main answers.
    await loadWorkbenchPage(win, slow);
    await wait('window.instantViews?.firstQueueRow!==undefined', 200);
    const start = await js<{ firstRender: number; queue: number; loading: { title: string; at: number }[]; refreshing?: [number, number?]; snapshot?: number }>(`({
      firstRender: window.instantViews.marks['first-render'], queue: window.instantViews.firstQueueRow, loading: window.instantViews.loading,
      refreshing: window.instantViews.refreshing, snapshot: window.instantViews.snapshotAnswered,
    })`);
    metrics.queueAfterFirstRenderMs = Math.round(start.queue - start.firstRender);
    metrics.queueFromNavigationMs = Math.round(start.queue);
    metrics.queueLoadingStates = start.loading.map((entry) => entry.title);
    check(start.snapshot === undefined || start.queue < start.snapshot, 'The saved queue paints before main answers');
    check(withinPerf('instant views: saved queue after first render', start.queue - start.firstRender, QUEUE_BUDGET_MS), 'The saved queue paints within its budget');
    check(!start.loading.some((entry) => entry.title.includes('Loading review queue')), 'No queue loading screen with a saved queue');
    const firstChecks = await js<string[]>('window.instantViews.firstChecks');
    metrics.firstFrameChecks = firstChecks;
    metrics.lastSessionChecks = lastChecks;
    check(firstChecks.length > 0 && firstChecks.join('|') === lastChecks.join('|'),
      'Saved rows show the check state they showed last session in the first frame');
    await wait('window.instantViews.refreshing?.[1]!==undefined', 400).catch(() => {});
    const refreshing = await js<[number, number?] | undefined>('window.instantViews.refreshing');
    const answered = await js<number | undefined>('window.instantViews.snapshotAnswered');
    metrics.refreshingShownMs = refreshing && [Math.round(refreshing[0] - start.firstRender), refreshing[1] && Math.round(refreshing[1] - start.firstRender)];
    metrics.snapshotAnsweredMs = answered && Math.round(answered - start.firstRender);
    check(!!refreshing && refreshing[0] <= start.queue + 50 && !!answered && (refreshing[1] ?? 0) >= answered,
      'The saved queue shows Refreshing… from its first frame until main answers');
    await wait("!document.querySelector('.queue-freshness.is-refreshing')", 400).catch(() => check(false, 'Refreshing… clears once the snapshot arrives'));
    await waitForWorkbenchQueue(win.webContents);

    // 3. Open a PR, then restart: the last open PR is restored from saved state before the snapshot arrives.
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    // Its Changes were read once, so main's cache has them for the next launch. Back to Summary, which is restored.
    await timeTo(changesReady, "window.openTab('Changes')");
    await timeTo("!!document.querySelector('.pr-description')", "window.openTab('Summary')");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await loadWorkbenchPage(win, slow);
    await wait('window.instantViews?.firstDescription!==undefined', 200).catch(() => {});
    const restored = await js<{ firstRender: number; description?: number; loading: { title: string; at: number }[] }>(
      "({firstRender:window.instantViews.marks['first-render'],description:window.instantViews.firstDescription,loading:window.instantViews.loading})");
    metrics.restoredPrAfterFirstRenderMs = restored.description === undefined ? null : Math.round(restored.description - restored.firstRender);
    metrics.restoredPrLoadingStates = restored.loading.map((entry) => `${entry.title} @${Math.round(entry.at - restored.firstRender)}`);
    metrics.restoredFirstRenderMs = Math.round(restored.firstRender);
    const restoredAnswer = await js<number | undefined>('window.instantViews.snapshotAnswered');
    check(restored.description !== undefined && (restoredAnswer === undefined || restored.description < restoredAnswer),
      'The last open PR shows before main answers');
    check(!restored.loading.some((entry) => entry.title.includes('Loading review queue') || entry.title.includes('Opening workspace')),
      `The last open PR waits for nothing but its screen's code: ${JSON.stringify(metrics.restoredPrLoadingStates)}`);
    await waitForWorkbenchQueue(win.webContents);
    await wait("!!document.querySelector('.pr-description')");

    // 4. Feedback opens on its saved discussion while GitHub is slow.
    const feedback = await timeTo("document.body.innerText.includes('Saved discussion for this PR.')", "window.openTab('Summary')");
    metrics.feedbackSavedCopy = feedback;
    check(feedback.ms >= 0 && !feedback.loading.length, 'Feedback shows its saved discussion with no loading state');

    // 5. j/k: the next PR is prepared while this one is open, so moving to it on Changes shows the diff at once.
    const changesTab = await timeTo(changesReady, "window.openTab('Changes')");
    metrics.restoredPrChangesTab = changesTab;
    await wait(changesReady, 1200);
    await wait('window.__gnosisPredict.idle()', 400).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, SLOW_NETWORK + 600));
    await wait('window.__gnosisPredict.idle()', 400).catch(() => {});
    const jMove = await timeTo(changesReady + "&&!document.querySelector('.pr-overview-heading h1')?.textContent.includes('Fix reconnect')",
      "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
    metrics.jToNeighbourChanges = jMove;
    const neighbourReads = await js<Read[]>("window.instantViews.reads.filter(r=>['changes','commits','file'].includes(r.name))");
    metrics.neighbourPreparedReads = neighbourReads.filter((read) => read.mode === 'pr-neighbour').length;
    const records = await js<{ key: string; outcome: string; ttcMs: number }[]>('window.__gnosisPredict.records()');
    const arrival = records.filter((record) => record.key.startsWith('pr-open:')).at(-1);
    metrics.neighbourArrival = arrival;
    check(jMove.ms >= 0 && !jMove.loading.length && arrival?.outcome === 'hit',
      'j to a prepared neighbour shows its diff with no loading state (a predictor hit)');
    check(withinPerf('instant views: j to a prepared neighbour', jMove.ms, SWITCH_BUDGET_MS), 'j to a prepared neighbour is within its budget');
    // And back with k: the PR we came from is still prepared.
    const kMove = await timeTo(changesReady + "&&!!document.querySelector('.pr-overview-heading h1')?.textContent.includes('Fix reconnect')",
      "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}))");
    metrics.kBackChanges = kMove;
    check(kMove.ms >= 0 && !kMove.loading.length, 'k back to the previous PR shows with no loading state');
    check(withinPerf('instant views: k back to the previous PR', kMove.ms, SWITCH_BUDGET_MS), 'k back to the previous PR is instant');

    // 6. Hover: resting on a row prepares it once; a quick sweep while scrolling prepares nothing.
    await click('Review queue');
    await wait("!!document.querySelector('.queue-row-main')");
    const hoverTitle = 'Handle empty batches';
    const row = (title: string) => `[...document.querySelectorAll('[data-queue-id]')].find(r=>r.textContent.includes(${JSON.stringify(title)}))`;
    await js('window.instantViews.intents.length=0;window.hoverReadsFrom=window.instantViews.reads.length');
    await js(`(async()=>{
      const row=${row(hoverTitle)};
      for(const target of [row.querySelector('.queue-row-main'),row,row.querySelector('.queue-row-main')]){target.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await new Promise(r=>setTimeout(r,40))}
      await new Promise(r=>setTimeout(r,400));
    })()`);
    // The fixture's reads are sequential and slow; a real hover usually rests about as long as they take.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await wait('window.__gnosisPredict.idle()', 600).catch(() => {});
    const hover = await js<{ intents: (string[] | null)[]; reads: Read[] }>("({intents:window.instantViews.intents,reads:window.instantViews.reads.slice(window.hoverReadsFrom)})");
    const hoverUrl = await js<string>(`${row(hoverTitle)}.querySelector('a[href*="/pull/"]')?.href ?? ''`).catch(() => '');
    metrics.hoverIntents = hover.intents;
    metrics.hoverReads = hover.reads.map((read) => `${read.name}:${String(read.mode)}:${read.url?.split('/').pop() ?? ''}`);
    check(hover.intents.filter(Boolean).length === 1, 'Resting on a row sends one intent');
    // Inventories already on disk send nothing; whatever is missing is read once, labelled as a predicted PR open.
    const predicted = hover.reads.filter((read) => read.mode === 'pr-open');
    check(predicted.length > 0 && new Set(predicted.map((read) => read.name)).size === predicted.length,
      `Hover prepares the PR's inventory and first file once: ${JSON.stringify(metrics.hoverReads)} ${hoverUrl}`);
    await js(`${row(hoverTitle)}.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}))`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await js('window.instantViews.intents.length=0');
    await js(`(async()=>{
      const list=document.querySelector('.queue-list');
      // A slow wheel scroll: each row stays under the still pointer for longer than the hover delay.
      for(const row of [...document.querySelectorAll('[data-queue-id]')]){list.dispatchEvent(new Event('scroll'));row.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await new Promise(r=>setTimeout(r,200))}
      await new Promise(r=>setTimeout(r,300));
    })()`);
    metrics.sweepIntents = await js<unknown[]>('window.instantViews.intents');
    check((metrics.sweepIntents as unknown[]).filter(Boolean).length === 0, 'A scroll sweep across rows prepares nothing');

    // 7. Switching to a prepared PR from the queue shows its summary and Changes at once.
    await js(`${row(hoverTitle)}.querySelector('.queue-row-main').click()`);
    const open = await timeTo("!!document.querySelector('.pr-description')", "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Open PR overview').click()");
    metrics.openHoveredPr = open;
    check(open.ms >= 0 && !open.loading.length, 'A hovered PR opens with no loading state');
    check(withinPerf('instant views: open a hovered PR', open.ms, SWITCH_BUDGET_MS), 'A hovered PR opens within its budget');
    const changes = await timeTo(changesReady, "window.openTab('Changes')");
    metrics.hoveredPrChanges = changes;
    check(changes.ms >= 0 && !changes.loading.length, 'Changes of a hovered PR opens with no loading state');

    console.log(`[instant-views] ${JSON.stringify(metrics)}`);
    assert.deepEqual(failures, [], `Instant views: ${failures.length} checks failed`);
    console.log('Instant views browser checks passed: saved queue and last PR at startup, saved Feedback, j/k neighbours, hover once, no sweep preloads.');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.log(`[instant-views] ${JSON.stringify(metrics)}`);
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
type Read = { name: string; url?: string; mode?: unknown; at: number };
