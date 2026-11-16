import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { perfBudget } from './perf-budget';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Large files and context gaps in Changes (#353, #299), on the synthetic files in tests/fixtures/diff-gaps.ts.
 *
 * Large file: opening a 3,000-line file and showing it again after Viewed paints the lines in view first and adds
 * the rest without one long task. A long-task observer records every main-thread task over 50 ms from the input
 * until the file has settled; this suite prints them as the before and after numbers.
 *
 * Gaps: each gap between hunks reveals 20 lines, or all of it, from the after side only, in one request per file.
 */
// Scaled outside strict runs; see tests/perf-budget.ts.
const LONG_TASK_BUDGET = Number(process.env.GNOSIS_LONG_TASK_BUDGET ?? perfBudget(200));

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(code.slice(0, 400) + ': ' + String(error));
    }) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (expression: string, tries = 250) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await sleep(40);
    }
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width&&(e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e)throw Error('Missing '+${JSON.stringify(label)});e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click()})()`
    );
    await sleep(50);
  };
  // Trusted input, so Event Timing and long tasks attribute the work to the input.
  const mouse = async (expression: string) => {
    const { x, y } = await js<{ x: number; y: number }>(`(()=>{const e=${expression};if(!e)throw Error('Missing target');
      e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
      return {x:Math.round(r.left+Math.min(r.width/2,40)),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  // GNOSIS_DIFF_GAPS_SHOT=1 prints PNGs of the gap file as base64 lines, since Docker keeps no files.
  const shot = async (name: string, selector: string) => {
    if (!process.env.GNOSIS_DIFF_GAPS_SHOT) return;
    await js(frames);
    await sleep(300);
    const r = await js<{ x: number; y: number; width: number; height: number }>(
      `(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,Math.round(b.left)),y:Math.max(0,Math.round(b.top)),width:Math.round(Math.min(b.width,innerWidth-b.left)),height:Math.round(Math.min(b.height,innerHeight-Math.max(0,b.top)))}})()`
    );
    const dark = await js<boolean>("document.documentElement.classList.contains('dark')");
    for (const theme of [dark, !dark]) {
      await js(`document.documentElement.classList.toggle('dark',${theme})`);
      await js(frames);
      await sleep(200);
      console.log(`SHOT ${name}-${theme ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
    }
    await js(`document.documentElement.classList.toggle('dark',${dark})`);
  };
  type Sample = { firstPaint: number; settled: number; longest: number; total: number; tasks: number[]; event: number; shift: number };
  const results: Record<string, Sample[]> = {};
  /** Runs one input; returns the time to the first painted lines, the time until every line is in the DOM, and the
   * long tasks in between. */
  // GNOSIS_DIFF_GAPS_TRACE=1 records a Chromium trace of each measured input and prints what the longest task did.
  const tracing = !!process.env.GNOSIS_DIFF_GAPS_TRACE;
  type TraceEvent = { name: string; ph: string; ts: number; dur?: number; tid: number; pid: number; args?: { data?: { functionName?: string; url?: string } } };
  let traceEvents: TraceEvent[] = [];
  const debug = win.webContents.debugger;
  if (tracing) {
    debug.attach('1.3');
    debug.on('message', (_event, method, params: { value?: TraceEvent[] }) => {
      if (method === 'Tracing.dataCollected' && params.value) traceEvents.push(...params.value);
    });
  }
  const startTrace = async () => {
    if (!tracing) return;
    traceEvents = [];
    await debug.sendCommand('Tracing.start', { categories: 'toplevel,devtools.timeline,blink,v8.execute', transferMode: 'ReportEvents' });
  };
  const stopTrace = async (name: string) => {
    if (!tracing) return;
    const done = new Promise<void>((resolve) => {
      const listener = (_event: unknown, method: string) => {
        if (method !== 'Tracing.tracingComplete') return;
        debug.removeListener('message', listener);
        resolve();
      };
      debug.on('message', listener);
    });
    await debug.sendCommand('Tracing.end');
    await done;
    const tasks = traceEvents.filter((e) => e.ph === 'X' && /RunTask/.test(e.name) && (e.dur ?? 0) > 50_000);
    for (const task of tasks.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0)).slice(0, 2)) {
      const inside = traceEvents.filter((e) => e.ph === 'X' && e.tid === task.tid && e.pid === task.pid && e.ts >= task.ts && e.ts + (e.dur ?? 0) <= task.ts + (task.dur ?? 0) && e !== task);
      const sums = new Map<string, number>();
      for (const e of inside) {
        const label = e.name === 'FunctionCall' ? `FunctionCall ${e.args?.data?.functionName ?? ''} ${(e.args?.data?.url ?? '').split('/').slice(-2).join('/')}` : e.name;
        sums.set(label, (sums.get(label) ?? 0) + (e.dur ?? 0));
      }
      console.log(`${name} trace: task ${Math.round((task.dur ?? 0) / 1000)} ms:`, JSON.stringify([...sums].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, Math.round(v / 100) / 10])));
    }
  };
  const measure = async (name: string, act: () => Promise<void>, painted: string, settled: string) => {
    await js('window.__longTasks=[];window.__events=[];window.__t0=performance.now();void 0');
    await startTrace();
    await act();
    await wait(painted);
    await js(frames);
    const firstPaint = await js<number>('performance.now()-window.__t0');
    // The first line in view must stay where it is while the rest of the file fills in.
    await js(`(()=>{const top=document.querySelector('.commit-diff-stream').getBoundingClientRect().top;
      window.__anchor=window.firstLineInView(top+60);
      window.__anchorTop=window.__anchor?.getBoundingClientRect().top})()`);
    await wait(settled, 500);
    await js(frames);
    const settledAt = await js<number>('performance.now()-window.__t0');
    const shift = await js<number>('window.__anchor?.isConnected?Math.round(window.__anchor.getBoundingClientRect().top-window.__anchorTop):-1');
    await sleep(300);
    await stopTrace(name);
    const tasks = await js<number[]>('window.__longTasks.filter(t=>t.start>=window.__t0-5).map(t=>Math.round(t.duration))');
    const event = await js<number>(
      "Math.max(0,...window.__events.filter(e=>e.start>=window.__t0-5&&/pointer|mouse|click/.test(e.name)).map(e=>e.duration))"
    );
    const sample = {
      firstPaint: Math.round(firstPaint),
      settled: Math.round(settledAt),
      longest: Math.max(0, ...tasks),
      total: tasks.reduce((a, b) => a + b, 0),
      tasks,
      event,
      shift,
    };
    (results[name] ??= []).push(sample);
    console.log(`${name}: ${JSON.stringify(sample)}`);
    return sample;
  };

  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&diff-gaps`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.__longTasks=[];window.__events=[];
      new PerformanceObserver(l=>{for(const e of l.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask'});
      new PerformanceObserver(l=>{for(const e of l.getEntries())window.__events.push({name:e.name,start:e.startTime,duration:e.duration})}).observe({type:'event',durationThreshold:16});
      window.row=p=>document.querySelector('.commit-stream-row[data-file="'+p+'"]');
      // Probes read no geometry inside slices that are not in view, so they never force their style or layout.
      window.lines=p=>[...(window.row(p)?.querySelectorAll('diffs-container')??[])].reduce((n,h)=>n+(h.shadowRoot?.querySelectorAll('[data-line]').length??0),0);
      window.firstLineInView=top=>{
        const view=document.querySelector('.commit-diff-stream').getBoundingClientRect();
        for(const box of document.querySelectorAll('.commit-stream-row .changes-slice, .commit-stream-row .changes-code > diffs-container, .commit-stream-row .changes-diff > diffs-container')){
          const b=box.getBoundingClientRect();if(b.bottom<top||b.top>view.bottom||!b.height)continue;
          const host=box.matches('diffs-container')?box:box.querySelector('diffs-container');
          const line=[...(host?.shadowRoot?.querySelectorAll('[data-line]')??[])].find(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.top>=top});
          if(line)return line;
        }
      };
      window.reads=[];window.afterReads=[];
      // Queue preparation reads both sides in the background, which would leave nothing for a reveal to read. It is
      // refused for the gap file, so every read of it below is one the reader causes.
      {const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async(r,...rest)=>{if(rest[0]&&r.path==='src/gaps.ts')throw Error('Not prepared in this suite');if(!rest[0])window.reads.push(r.path);return read(r,...rest)};}
      if(window.electronAPI.getPrChangeFileAfter){const read=window.electronAPI.getPrChangeFileAfter;window.electronAPI.getPrChangeFileAfter=async(r,...rest)=>{window.afterReads.push(r.path);await new Promise(x=>setTimeout(x,150));return read(r,...rest)};}
      void 0;`);
    // Preparation may already have read the gap file's both sides; start with a cold renderer cache.
    await js("(async()=>{(await import('/lib/inspection-cache.ts')).inspectionFiles.clear()})()");
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='huge.ts')");
    await sleep(800);

    // ── #353: a 3,000-line file ─────────────────────────────────────
    const huge = "window.row('zz/huge.ts')";
    // DOM only: the frame that follows paints them, and its task is what the long-task observer measures.
    const inView = `window.lines('zz/huge.ts')`;
    const allLines = `window.lines('zz/huge.ts')>=3000`;
    await measure(
      'open large file',
      () => mouse("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='huge.ts')"),
      `${inView}>10`,
      allLines
    );
    await sleep(500);
    const viewed = `${huge}.querySelector('.changes-file-header input[type=checkbox]')`;
    for (let i = 0; i < 3; i++) {
      await mouse(viewed);
      await wait(`${huge}.querySelector('.commit-stream-file-body')?.hidden===true`);
      await sleep(400);
      await measure(
        'expand large file',
        () => mouse(viewed),
        `${huge}.querySelector('.commit-stream-file-body')?.hidden===false&&${inView}>10`,
        allLines
      );
      await sleep(400);
    }
    // Every line stays in the DOM, so find in page reaches all of them, and the last line is numbered 3,000.
    assert.equal(
      await js<number>(`window.deepAll('[data-line]',${huge}).filter(e=>e.textContent.includes('generated2999(')).length`),
      1,
      'The last line of the large file is in the DOM'
    );
    console.log('Large file summary:', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
      firstPaint: v.map((s) => s.firstPaint), settled: v.map((s) => s.settled), longest: v.map((s) => s.longest), total: v.map((s) => s.total), event: v.map((s) => s.event), shift: v.map((s) => s.shift),
    }]))));
    // GNOSIS_DIFF_GAPS_MEASURE_ONLY=1 prints the numbers above on a build without slices, for a before measurement.
    if (process.env.GNOSIS_DIFF_GAPS_MEASURE_ONLY) return;
    for (const [name, samples] of Object.entries(results)) {
      const worst = Math.max(...samples.map((s) => s.longest));
      assert.ok(worst <= LONG_TASK_BUDGET, `${name}: the longest task was ${worst} ms (budget ${LONG_TASK_BUDGET} ms)`);
      assert.ok(samples.every((s) => s.shift === 0), `${name}: the first line in view moved: ${samples.map((s) => s.shift).join(', ')}`);
    }
    // A slice's placeholder height is its laid-out height, so mounting it moves nothing.
    const heights = await js<{ estimate: number; actual: number }[]>(`(()=>{
      return [...${huge}.querySelectorAll('.changes-slice')].slice(0,3).map(e=>{const host=e.querySelector('diffs-container');
        return {estimate:parseFloat(e.style.containIntrinsicBlockSize.replace('auto','')),actual:host?Math.round(host.getBoundingClientRect().height):-1}})})()`);
    assert.ok(heights.length === 3, 'The large file renders in slices');
    for (const { estimate, actual } of heights)
      assert.ok(Math.abs(estimate - actual) <= 1, `Slice estimate ${estimate}px, laid out ${actual}px`);
    assert.equal(await js<number>(`${huge}.querySelectorAll('.changes-slice').length`), 15);

    // ── #299: gaps reveal 20 lines, or all, from the after side only ──
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='gaps.ts').click()");
    const gapsRow = "window.row('src/gaps.ts')";
    await wait(`(${gapsRow}?.querySelectorAll('.diff-gap[data-gap]').length??0)===3&&window.lines('src/gaps.ts')>0`);
    const bars = () => js<string[]>(`[...${gapsRow}.querySelectorAll('.diff-gap[data-gap]')].map(e=>e.dataset.gap+': '+e.getAttribute('aria-label'))`);
    assert.deepEqual(await js('window.reads.filter(p=>p.endsWith("gaps.ts"))'), [], 'Viewing a modified file reads neither side');
    assert.deepEqual(await js('window.afterReads'), []);
    assert.deepEqual(await bars(), ['0: 46 lines hidden', '1: 93 lines hidden', '2: More lines may follow']);
    await js(`${gapsRow}.scrollIntoView({block:'start'})`);
    await shot('gaps-initial', '.commit-stream-row[data-file="src/gaps.ts"]');
    // Only a hunk whose lines overflow scrolls sideways and shows a scrollbar; the others end flush (no gutter).
    const scrollers = () =>
      js<{ overflows: boolean; bar: number; bottom: number }[]>(`[...${gapsRow}.querySelectorAll('.changes-diff > diffs-container')].map(h=>{
        const c=h.shadowRoot.querySelector('[data-code]');return {overflows:c.scrollWidth>c.clientWidth,bar:c.offsetHeight-c.clientHeight,bottom:parseFloat(getComputedStyle(c).paddingBottom)}})`);
    const nowrap = await scrollers();
    assert.deepEqual(nowrap.map((s) => s.overflows), [false, true], JSON.stringify(nowrap));
    assert.equal(nowrap[0].bar, 0, 'A hunk that fits has no scrollbar track');
    assert.ok(nowrap[1].bar > 0 && nowrap[1].bar <= 12, `The long hunk has a thin scrollbar: ${nowrap[1].bar}px`);
    assert.equal(nowrap[0].bottom, 8);
    // It scrolls sideways, and the page still scrolls from the keyboard.
    assert.ok(await js<boolean>(`(()=>{const c=${gapsRow}.querySelectorAll('.changes-diff > diffs-container')[1].shadowRoot.querySelector('[data-code]');c.scrollLeft=200;const moved=c.scrollLeft>0;c.scrollLeft=0;return moved})()`));
    await js(`${gapsRow}.querySelectorAll('.changes-diff > diffs-container')[1].scrollIntoView({block:'start'})`);
    await shot('gaps-overflow', '.commit-stream-row[data-file="src/gaps.ts"] .changes-diff > diffs-container:nth-of-type(2)');
    const before = await js<number>("document.querySelector('.commit-diff-stream').scrollTop");
    await js("document.querySelector('.commit-diff-stream').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
    await wait(`document.querySelector('.commit-diff-stream').scrollTop>${before}`);
    await js(`${gapsRow}.scrollIntoView({block:'start'})`);
    // Wrapped lines never overflow, so no hunk has a scrollbar.
    const setWrap = async (on: boolean) => {
      await click('Diff appearance');
      await wait("!!document.querySelector('[aria-label=\"Show surrounding lines\"]')");
      await js(`(()=>{const box=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith('Wrap long lines'))?.querySelector('input');if(!box)throw Error('No wrap option');if(box.checked!==${on})box.click()})()`);
      await js("document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    };
    await setWrap(true);
    await wait(`(()=>{const h=${gapsRow}.querySelectorAll('.changes-diff > diffs-container')[1];const c=h?.shadowRoot.querySelector('[data-code]');return !!c&&c.scrollWidth<=c.clientWidth&&c.offsetHeight===c.clientHeight})()`);
    await js(`${gapsRow}.querySelectorAll('.changes-diff > diffs-container')[1].scrollIntoView({block:'start'})`);
    await shot('gaps-wrapped', '.commit-stream-row[data-file="src/gaps.ts"] .changes-diff > diffs-container:nth-of-type(2)');
    await setWrap(false);
    await wait(`(()=>{const c=${gapsRow}.querySelectorAll('.changes-diff > diffs-container')[1]?.shadowRoot.querySelector('[data-code]');return !!c&&c.scrollWidth>c.clientWidth})()`);
    const press = (gap: number, label: string) =>
      js(`(()=>{const b=[...${gapsRow}.querySelectorAll('.diff-gap[data-gap="${gap}"] button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing ${label}');b.click()})()`);
    // A line's numbers on each side it shows on: the new number in Unified, both in Split.
    const lineAt = (text: string) =>
      js<string | null>(`[...new Set(window.deepAll('[data-line]',${gapsRow}).filter(e=>e.textContent.trim()===${JSON.stringify(text)}).map(e=>e.dataset.line))].sort((a,b)=>a-b).join(',')||null`);
    // Two reveals while the after side loads: both apply when it arrives, from one request.
    await press(1, 'Show 20 lines below the change above');
    await press(1, 'Show 20 lines above the change below');
    await wait(`${gapsRow}.querySelector('.diff-gap[data-gap="1"]')?.getAttribute('aria-busy')==='true'`);
    await wait(`${gapsRow}.querySelector('.diff-gap[data-gap="1"]')?.getAttribute('aria-label')==='53 lines hidden'`);
    assert.deepEqual(await js('window.afterReads'), ['src/gaps.ts'], 'One read, of the after side');
    await js(`${gapsRow}.querySelector('.diff-gap[data-gap="1"]').scrollIntoView({block:'center'})`);
    await shot('gaps-revealed', '.commit-stream-row[data-file="src/gaps.ts"]');
    // New line 55 is old line 54: the first change added a line.
    assert.match(String(await lineAt('export const g54 = 54;')), /^(55|54,55)$/);
    assert.match(String(await lineAt('export const g73 = 73;')), /^(74|73,74)$/);
    assert.equal(await lineAt('export const g74 = 74;'), null, 'Line 75 stays hidden');
    assert.match(String(await lineAt('export const g127 = 127;')), /^(128|127,128)$/);
    await press(1, 'Show all');
    await wait(`!${gapsRow}.querySelector('.diff-gap[data-gap="1"]')`);
    assert.match(String(await lineAt('export const g100 = 100;')), /^(101|100,101)$/);
    await press(0, 'Show 20 lines above the change below');
    await wait(`${gapsRow}.querySelector('.diff-gap[data-gap="0"]')?.getAttribute('aria-label')==='26 lines hidden'`);
    assert.equal(await lineAt('export const g27 = 27;'), '27');
    assert.deepEqual(await bars(), ['0: 26 lines hidden', '2: 47 lines hidden'], 'The after side gives the last gap its size');
    await press(2, 'Show all');
    await wait(`!${gapsRow}.querySelector('.diff-gap[data-gap="2"]')`);
    assert.match(String(await lineAt('export const g200 = 200;')), /^(201|200,201)$/);
    assert.deepEqual(await js('window.afterReads'), ['src/gaps.ts'], 'Every reveal used the one after-side read');
    assert.deepEqual(await js('window.reads.filter(p=>p.endsWith("gaps.ts"))'), [], 'The before side is never read');
    // One diff per hunk: the revealed middle joined both hunks.
    assert.equal(await js<number>(`${gapsRow}.querySelectorAll('.changes-code diffs-container').length`), 1);
    assert.deepEqual(errors, [], 'No console errors');
    console.log('Diff gap browser checks passed: slices without long tasks, 20-line and full reveals from one after-side read.');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
