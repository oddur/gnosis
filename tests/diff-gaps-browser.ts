import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { assertPerf, perfBudget } from './perf-budget';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Large files and context gaps in Changes (#353, #299), on the synthetic files in tests/fixtures/diff-gaps.ts.
 *
 * Large file: opening a 3,000-line file and showing it again after Viewed paints the lines in view first and adds
 * the rest without one long task. A long-task observer records every main-thread task over 50 ms from the input
 * until the file has settled; this suite prints them as the before and after numbers.
 *
 * Accessibility (#366): the suite turns renderer accessibility on, as an accessibility client on a Mac does, and
 * also measures scrolling through the file. Chromium rebuilds the accessibility nodes of every element it restyles,
 * so mounting the rest of the file must restyle only what it adds, not the page and the slice in view. Lines that
 * scroll into view, or that find in page shows, are in the accessibility tree.
 *
 * Gaps: each gap between hunks reveals 20 lines, or all of it, from the after side only, in one request per file.
 *
 * Stale diffs: files whose after side disagrees with their patch refresh the PR once, together, at the view tier. A
 * file that matches after it reveals its lines; one that still does not shows "Couldn’t match" with a manual Refresh,
 * and never refreshes again by itself.
 */
// Scaled outside strict runs; see tests/perf-budget.ts.
const LONG_TASK_BUDGET = Number(process.env.GNOSIS_LONG_TASK_BUDGET ?? perfBudget(200));
/**
 * Accessibility work from one input until the large file settles. In Docker, opening the file took 150-200 ms of it
 * while each slice mounted restyled the page, and 50-60 ms after; showing it again took 40-50 ms, and 12-30 ms once
 * each line was one text node. Macs spend several times more on the same work (#366), so this is set for them; the
 * restyle count and the text nodes per line below are exact everywhere.
 */
const ACCESSIBILITY_BUDGET = perfBudget(200);
/**
 * Accessibility work in one scroll pass through the large file, as each 200-row slice comes into view. In Docker it
 * was 620-720 ms while each token of a line was its own text node, about 9,000 accessibility nodes a slice, and
 * 200-450 ms with one text node a line (#366). Set for Macs like the budget above.
 */
const SCROLL_ACCESSIBILITY_BUDGET = perfBudget(400);
/**
 * Style recalculations of more elements than a 200-row slice has (SLICE_ELEMENTS) while the large file opens. Each slice
 * that mounted used to restyle all 6,600 elements of the page and the slice in view, 15 times (#366): Tailwind's
 * `group-has-*` variants compile to `:is(:where(.group):has(…) *)`, and Chromium answers any insertion under such
 * a rule by restyling the document. tests/tailwind-has.test.ts keeps those variants out.
 */
const PAGE_RESTYLE_LIMIT = 2;
/** More than one 200-row slice of the large file and its file header restyle (about 1,200 elements, 4,400 before each
 * line was one text node), and less than the page with a slice in view (about 2,500). */
const SLICE_ELEMENTS = 1800;

void app.whenReady().then(async () => {
  // GNOSIS_DIFF_GAPS_ACCESSIBILITY=0 leaves accessibility to the machine, to measure without it.
  if (process.env.GNOSIS_DIFF_GAPS_ACCESSIBILITY !== '0') app.setAccessibilitySupportEnabled(true);
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
  type Sample = {
    firstPaint: number; settled: number; longest: number; total: number; tasks: number[]; event: number; shift: number;
    /** With accessibility on: the longest renderer task less its accessibility work, that work at most in one task,
     * and in all tasks. */
    withoutAccessibility?: number; accessibility?: number; accessibilityTotal?: number;
    /** Style recalculations of more elements than one slice has. */
    pageRestyles?: number;
    largestRestyle?: number;
  };
  const results: Record<string, Sample[]> = {};
  /** Runs one input; returns the time to the first painted lines, the time until every line is in the DOM, and the
   * long tasks in between. */
  // GNOSIS_DIFF_GAPS_TRACE=1 records a Chromium trace of each measured input and prints what the longest task did.
  const tracing = !!process.env.GNOSIS_DIFF_GAPS_TRACE;
  /**
   * Chromium builds an accessibility tree once an assistive client asks for one. macOS runners and many Macs have
   * such a client, and this suite turns it on everywhere. Its work grows with the lines in the tree and Macs spend
   * several times more on it than Linux (#366), so it has its own budget, ACCESSIBILITY_BUDGET. With accessibility
   * on, each input is traced: the long-task budget applies to the longest task less its accessibility work.
   */
  // Set by checkAccessibility, so the type is widened for the checks after it.
  let accessibility = false as boolean;
  type TraceEvent = { name: string; ph: string; ts: number; dur?: number; tid: number; pid: number; args?: { name?: string; data?: { functionName?: string; url?: string } } };
  let traceEvents: TraceEvent[] = [];
  const debug = win.webContents.debugger;
  const collect = (_event: unknown, method: string, params: { value?: TraceEvent[] }) => {
    if (method === 'Tracing.dataCollected' && params.value) traceEvents.push(...params.value);
  };
  if (tracing) {
    debug.attach('1.3');
    debug.on('message', collect);
  }
  const traced = () => tracing || accessibility;
  const startTrace = async () => {
    if (!traced()) return;
    traceEvents = [];
    await debug.sendCommand('Tracing.start', {
      categories: tracing ? 'toplevel,devtools.timeline,blink,v8.execute,accessibility,__metadata' : 'toplevel,blink,devtools.timeline,__metadata',
      transferMode: 'ReportEvents',
    });
  };
  const rendererMain = () =>
    new Set(traceEvents.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  /** The element counts of the renderer's style recalculations in the last trace. */
  const restyles = () => {
    const main = rendererMain();
    return traceEvents
      .filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree' && main.has(`${e.pid}:${e.tid}`))
      .map((e) => (e.args as { elementCount?: number } | undefined)?.elementCount ?? 0);
  };
  /** The renderer's longest task over 50 ms, with and without the accessibility work inside it. */
  const accessibilityCost = () => {
    const main = rendererMain();
    let withoutAccessibility = 0;
    let most = 0;
    let found = false;
    const accessibilityTotal = traceEvents
      .filter((e) => e.ph === 'X' && e.name === 'LocalFrameView::RunAccessibilitySteps' && main.has(`${e.pid}:${e.tid}`))
      .reduce((total, e) => total + (e.dur ?? 0), 0);
    for (const task of traceEvents) {
      if (task.ph !== 'X' || !/RunTask/.test(task.name) || (task.dur ?? 0) <= 50_000 || !main.has(`${task.pid}:${task.tid}`)) continue;
      found = true;
      const end = task.ts + (task.dur ?? 0);
      const steps = traceEvents
        .filter((e) => e.ph === 'X' && e.name === 'LocalFrameView::RunAccessibilitySteps' && e.pid === task.pid && e.tid === task.tid && e.ts >= task.ts && e.ts + (e.dur ?? 0) <= end)
        .reduce((total, e) => total + (e.dur ?? 0), 0);
      withoutAccessibility = Math.max(withoutAccessibility, ((task.dur ?? 0) - steps) / 1000);
      most = Math.max(most, steps / 1000);
    }
    // A trace that names no renderer task leaves the long-task observer's number to be checked.
    return found
      ? { withoutAccessibility: Math.round(withoutAccessibility), accessibility: Math.round(most), accessibilityTotal: Math.round(accessibilityTotal / 1000) }
      : { accessibilityTotal: Math.round(accessibilityTotal / 1000) };
  };
  const stopTrace = async (name: string) => {
    if (!traced()) return;
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
    if (!tracing) return;
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
  const checkAccessibility = () => {
    // Chromium turns accessibility on shortly after launch when a client asks, so this is checked before each input.
    if (!accessibility && app.isAccessibilitySupportEnabled()) {
      accessibility = true;
      console.log('Accessibility support is on: long tasks are traced and its work is reported apart');
      if (!tracing) {
        if (!debug.isAttached()) debug.attach('1.3');
        debug.on('message', collect);
      }
    }
  };
  /** The large file's line numbers, from 0, that are in the accessibility tree, and the names of its regions. */
  const accessibleTree = async () => {
    if (!debug.isAttached()) debug.attach('1.3');
    await debug.sendCommand('Accessibility.enable');
    try {
      const { nodes } = (await debug.sendCommand('Accessibility.getFullAXTree')) as {
        nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
      };
      const lines = new Set<number>();
      for (const node of nodes) {
        const line = /\bgenerated(\d+)\b/.exec(node.name?.value ?? '')?.[1];
        if (!node.ignored && line) lines.add(Number(line));
      }
      const regions = nodes.filter((n) => !n.ignored && n.role?.value === 'region').map((n) => n.name?.value ?? '');
      const text = nodes.filter((n) => n.role?.value === 'StaticText' || n.role?.value === 'InlineTextBox').length;
      return { lines, regions, nodes: nodes.length, text };
    } finally {
      await debug.sendCommand('Accessibility.disable');
    }
  };
  const measure = async (name: string, act: () => Promise<void>, painted: string, settled: string) => {
    checkAccessibility();
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
    const cost = traced() && accessibility ? accessibilityCost() : {};
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
      ...cost,
      ...(traced() ? { pageRestyles: restyles().filter((count) => count > SLICE_ELEMENTS).length, largestRestyle: Math.max(0, ...restyles()) } : {}),
    };
    (results[name] ??= []).push(sample);
    console.log(`${name}: ${JSON.stringify(sample)}`);
    return sample;
  };

  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&diff-gaps`);
    // The slice heights below assume lines that fit the code column: a line wider than it adds a 10px scrollbar under
    // its slice. Size the page itself and wait for it, since a new window can open smaller than asked (on a native
    // Windows runner a slice measured 10px over, with a scrollbar, though the lines fit at 1280).
    win.setContentSize(1280, 800);
    await wait('innerWidth===1280 && innerHeight===800');
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
        for(const box of document.querySelectorAll('.commit-stream-row .changes-slice, .commit-stream-row .changes-code > diffs-container, .commit-stream-row .changes-diff .diff-hunk > diffs-container')){
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
    // This suite checks that reveals read the after side. Code structure would load it as soon as a file shows (#393,
    // checked in --syntax-scope), so it is off here.
    await js(`(async()=>{const prefs=await window.electronAPI.loadPreferences();const next={...prefs,codeIntelligence:{enabled:false}};
      await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}));
      (await import('/lib/use-syntax-contents.ts')).applyCodeIntelligence({enabled:false,disabled:[]})})()`);
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
    // The lines in view are in the accessibility tree, in the file's labeled region (#366).
    // Each highlighted line is one text node, colored by a gradient instead of a span per token (#366).
    const lineText = `(()=>{const lines=[...${huge}.querySelector('diffs-container').shadowRoot.querySelectorAll('[data-code] [data-line]')];
      const texts=l=>{let n=0;const w=document.createTreeWalker(l,NodeFilter.SHOW_TEXT);while(w.nextNode())n++;return n};
      return {lines:lines.length,single:lines.filter(l=>texts(l)===1).length,colored:lines.filter(l=>l.querySelector('[data-tokens]')).length}})()`;
    await wait(`${lineText}.colored>=200`);
    const flat = await js<{ lines: number; single: number; colored: number }>(lineText);
    assert.ok(flat.lines >= 200 && flat.single === flat.lines && flat.colored === flat.lines, `Each line of the large file is one colored text node: ${JSON.stringify(flat)}`);
    // The text itself is transparent, so selected text needs a color of its own.
    const selected = await js<string>(`getComputedStyle(${huge}.querySelector('diffs-container').shadowRoot.querySelector('[data-tokens]'),'::selection').color`);
    assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(selected), `Selected text in a colored line is visible: ${selected}`);
    const opened = await accessibleTree();
    console.log(`Accessibility tree after opening: ${opened.nodes} nodes, ${opened.text} of them text, ${opened.lines.size} lines of the large file`);
    assert.ok(opened.regions.includes('zz/huge.ts'), `The file is a labeled region: ${JSON.stringify(opened.regions)}`);
    assert.ok(opened.lines.has(0) && opened.lines.has(20), 'The lines in view are in the accessibility tree');
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
    // Find in page reaches a line that is out of the tree, and brings it in.
    assert.ok(!(await accessibleTree()).lines.has(2999), 'The last line is not in the accessibility tree yet');
    const found = await new Promise<number>((resolve) => {
      const listener = (_event: unknown, result: Electron.Result) => {
        if (!result.finalUpdate) return;
        win.webContents.off('found-in-page', listener);
        resolve(result.matches);
      };
      win.webContents.on('found-in-page', listener);
      win.webContents.findInPage('generated2999(');
    });
    assert.equal(found, 1, 'Find in page finds the last line');
    await js(frames);
    await sleep(300);
    win.webContents.stopFindInPage('clearSelection');
    assert.ok((await accessibleTree()).lines.has(2999), 'The line find in page shows is in the accessibility tree');
    // Scrolling through the whole file brings every line into view once.
    checkAccessibility();
    const scrolls: { duration: number; longest: number; total: number; accessibility?: number; accessibilityTotal?: number }[] = [];
    for (let i = 0; i < 2; i++) {
      await js(`${huge}.scrollIntoView({block:'start'})`);
      await js(frames);
      await sleep(500);
      await js('window.__longTasks=[];window.__t0=performance.now();void 0');
      await startTrace();
      await js(`(async()=>{const s=document.querySelector('.commit-diff-stream');
        const end=()=>${huge}.getBoundingClientRect().bottom-s.getBoundingClientRect().top+s.scrollTop-s.clientHeight;
        while(s.scrollTop<end()-1){const before=s.scrollTop;s.scrollTop=Math.min(end(),s.scrollTop+600);await ${frames};if(s.scrollTop===before)break}})()`);
      const duration = await js<number>('performance.now()-window.__t0');
      await sleep(300);
      await stopTrace('scroll large file');
      const cost = traced() && accessibility ? accessibilityCost() : {};
      const tasks = await js<number[]>('window.__longTasks.filter(t=>t.start>=window.__t0-5).map(t=>Math.round(t.duration))');
      const sample = { duration: Math.round(duration), longest: Math.max(0, ...tasks), total: tasks.reduce((a, b) => a + b, 0), ...cost };
      scrolls.push(sample);
      console.log(`scroll large file: ${JSON.stringify(sample)}`);
    }
    // Lines join the accessibility tree as they scroll into view.
    const scrolled = await accessibleTree();
    const range = (lines: Set<number>) => (lines.size ? `${lines.size} lines, ${Math.min(...lines)}-${Math.max(...lines)}` : 'no lines');
    console.log(`Accessibility tree at the end of the file: ${range(scrolled.lines)}`);
    assert.ok(scrolled.lines.has(2999), `At the end of the file, the last line is in the accessibility tree: ${range(scrolled.lines)}`);
    // Every line stays in the DOM, so find in page reaches all of them, and the last line is numbered 3,000.
    assert.equal(
      await js<number>(`window.deepAll('[data-line]',${huge}).filter(e=>e.textContent.includes('generated2999(')).length`),
      1,
      'The last line of the large file is in the DOM'
    );
    console.log('Large file summary:', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
      firstPaint: v.map((s) => s.firstPaint), settled: v.map((s) => s.settled), longest: v.map((s) => s.longest), total: v.map((s) => s.total), event: v.map((s) => s.event), shift: v.map((s) => s.shift),
      ...(accessibility ? { withoutAccessibility: v.map((s) => s.withoutAccessibility), accessibility: v.map((s) => s.accessibility), accessibilityTotal: v.map((s) => s.accessibilityTotal) } : {}),
      ...(traced() ? { pageRestyles: v.map((s) => s.pageRestyles) } : {}),
    }]))));
    console.log('Scroll summary:', JSON.stringify({ duration: scrolls.map((s) => s.duration), longest: scrolls.map((s) => s.longest), total: scrolls.map((s) => s.total), accessibility: scrolls.map((s) => s.accessibility), accessibilityTotal: scrolls.map((s) => s.accessibilityTotal) }));
    // GNOSIS_DIFF_GAPS_MEASURE_ONLY=1 prints the numbers above on a build without slices, for a before measurement.
    if (process.env.GNOSIS_DIFF_GAPS_MEASURE_ONLY) return;
    for (const [name, samples] of Object.entries(results)) {
      const worst = Math.max(...samples.map((s) => (accessibility ? (s.withoutAccessibility ?? s.longest) : s.longest)));
      const spent = accessibility ? `, ${Math.max(...samples.map((s) => s.accessibility ?? 0))} ms more of accessibility work (#366)` : '';
      assertPerf(`diff gaps: longest task, ${name}`, worst, LONG_TASK_BUDGET, { detail: spent.slice(2) });
      assert.ok(samples.every((s) => s.shift === 0), `${name}: the first line in view moved: ${samples.map((s) => s.shift).join(', ')}`);
      const restyled = Math.max(...samples.map((s) => s.pageRestyles ?? 0));
      assert.ok(restyled <= PAGE_RESTYLE_LIMIT, `${name}: ${restyled} style recalculations of more than one slice (at most ${PAGE_RESTYLE_LIMIT}, #366)`);
      if (!accessibility) continue;
      const most = Math.max(...samples.map((s) => s.accessibilityTotal ?? 0));
      assertPerf(`diff gaps: accessibility work, ${name} (#366)`, most, ACCESSIBILITY_BUDGET);
    }
    if (accessibility) {
      const most = Math.max(...scrolls.map((s) => s.accessibilityTotal ?? 0));
      assertPerf('diff gaps: accessibility work in one scroll pass (#366)', most, SCROLL_ACCESSIBILITY_BUDGET);
    }
    // A slice's placeholder height is its laid-out height, so mounting it moves nothing.
    const heights = await js<{ estimate: number; actual: number; code: string }[]>(`(()=>{
      return [...${huge}.querySelectorAll('.changes-slice')].slice(0,3).map(e=>{const host=e.querySelector('diffs-container');const c=host?.shadowRoot?.querySelector('[data-code]');
        return {estimate:parseFloat(e.style.containIntrinsicBlockSize.replace('auto','')),actual:host?Math.round(host.getBoundingClientRect().height):-1,
          code:c?'code '+c.scrollWidth+'px wide in '+c.clientWidth+'px, scrollbar '+(c.offsetHeight-c.clientHeight)+'px, window '+innerWidth+'x'+innerHeight:'no code'}})})()`);
    assert.ok(heights.length === 3, 'The large file renders in slices');
    for (const { estimate, actual, code } of heights)
      assert.ok(Math.abs(estimate - actual) <= 1, `Slice estimate ${estimate}px, laid out ${actual}px (${code})`);
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
    // Selected text in a line colored by a gradient stays readable.
    if (process.env.GNOSIS_DIFF_GAPS_SHOT) {
      await js(`(()=>{const lines=[...${gapsRow}.querySelector('.changes-diff .diff-hunk > diffs-container').shadowRoot.querySelectorAll('[data-code] [data-line]')];
        const text=l=>{const w=document.createTreeWalker(l,NodeFilter.SHOW_TEXT);return w.nextNode()};
        const range=document.createRange();range.setStart(text(lines[0]),7);range.setEnd(text(lines[2]),12);
        getSelection().removeAllRanges();getSelection().addRange(range)})()`);
      await shot('gaps-selected', '.commit-stream-row[data-file="src/gaps.ts"]');
      await js('getSelection().removeAllRanges()');
    }
    // Only a hunk whose lines overflow scrolls sideways and shows a scrollbar; the others end flush (no gutter).
    const scrollers = () =>
      js<{ overflows: boolean; bar: number; bottom: number }[]>(`[...${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')].map(h=>{
        const c=h.shadowRoot.querySelector('[data-code]');return {overflows:c.scrollWidth>c.clientWidth,bar:c.offsetHeight-c.clientHeight,bottom:parseFloat(getComputedStyle(c).paddingBottom)}})`);
    const nowrap = await scrollers();
    assert.deepEqual(nowrap.map((s) => s.overflows), [false, true], JSON.stringify(nowrap));
    assert.equal(nowrap[0].bar, 0, 'A hunk that fits has no scrollbar track');
    assert.ok(nowrap[1].bar > 0 && nowrap[1].bar <= 12, `The long hunk has a thin scrollbar: ${nowrap[1].bar}px`);
    assert.equal(nowrap[0].bottom, 8);
    // It scrolls sideways, and the page still scrolls from the keyboard.
    assert.ok(await js<boolean>(`(()=>{const c=${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')[1].shadowRoot.querySelector('[data-code]');c.scrollLeft=200;const moved=c.scrollLeft>0;c.scrollLeft=0;return moved})()`));
    await js(`${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')[1].scrollIntoView({block:'start'})`);
    await shot('gaps-overflow', '.commit-stream-row[data-file="src/gaps.ts"] .changes-diff .diff-hunk:nth-of-type(2) > diffs-container');
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
    await wait(`(()=>{const h=${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')[1];const c=h?.shadowRoot.querySelector('[data-code]');return !!c&&c.scrollWidth<=c.clientWidth&&c.offsetHeight===c.clientHeight})()`);
    await js(`${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')[1].scrollIntoView({block:'start'})`);
    await shot('gaps-wrapped', '.commit-stream-row[data-file="src/gaps.ts"] .changes-diff .diff-hunk:nth-of-type(2) > diffs-container');
    await setWrap(false);
    await wait(`(()=>{const c=${gapsRow}.querySelectorAll('.changes-diff .diff-hunk > diffs-container')[1]?.shadowRoot.querySelector('[data-code]');return !!c&&c.scrollWidth>c.clientWidth})()`);
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
    // The bar below the last hunk is one quiet row: "47 more lines · Show".
    await press(2, 'Show');
    await wait(`!${gapsRow}.querySelector('.diff-gap[data-gap="2"]')`);
    assert.match(String(await lineAt('export const g200 = 200;')), /^(201|200,201)$/);
    assert.deepEqual(await js('window.afterReads'), ['src/gaps.ts'], 'Every reveal used the one after-side read');
    assert.deepEqual(await js('window.reads.filter(p=>p.endsWith("gaps.ts"))'), [], 'The before side is never read');
    // One diff per hunk: the revealed middle joined both hunks.
    assert.equal(await js<number>(`${gapsRow}.querySelectorAll('.changes-code diffs-container').length`), 1);

    // ── A stale diff refreshes by itself, once ─────────────────────────
    // Two files whose after sides disagree with their patch at line 48 (a context line of the first hunk). The first
    // matches once refreshed; the second never does, and must end at the manual message without looping.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&diff-gaps&stale-diff`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.row=p=>document.querySelector('.commit-stream-row[data-file="'+p+'"]');
      window.staleReads=[];window.changeReads=[];
      const stale=p=>p==='src/stale-a.ts'||p==='src/stale-b.ts';
      {const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async(r,...rest)=>{if(rest[0]&&stale(r.path))throw Error('Not prepared in this suite');return read(r,...rest)};}
      {const read=window.electronAPI.getPrChangeFileAfter;window.electronAPI.getPrChangeFileAfter=async(r,...rest)=>{
        const side=await read(r,...rest);if(!stale(r.path))return side;
        const n=window.staleReads.filter(x=>x.path===r.path).length;window.staleReads.push({path:r.path,mode:rest[0]??false});
        await new Promise(x=>setTimeout(x,150));
        return r.path==='src/stale-b.ts'||n===0?{...side,content:side.content.replace('export const g48 = 48;','export const g48 = 4800;')}:side}}
      {const read=window.electronAPI.getPrChanges;window.electronAPI.getPrChanges=(url,refresh,options)=>{if(refresh)window.changeReads.push({view:!!options?.view,recheck:options?.recheck?.paths??null});return read(url,refresh,options)};}
      void 0;`);
    await js(`(async()=>{const prefs=await window.electronAPI.loadPreferences();const next={...prefs,codeIntelligence:{enabled:false}};
      await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}));
      (await import('/lib/use-syntax-contents.ts')).applyCodeIntelligence({enabled:false,disabled:[]})})()`);
    await js("(async()=>{(await import('/lib/inspection-cache.ts')).inspectionFiles.clear()})()");
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    const staleA = "window.row('src/stale-a.ts')",
      staleB = "window.row('src/stale-b.ts')";
    for (const name of ['stale-a.ts', 'stale-b.ts']) {
      await wait(`window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='${name}')`);
      await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='${name}').click()`);
      await wait(`(window.row('src/${name}')?.querySelectorAll('.diff-gap[data-gap]').length??0)===3`);
    }
    // Refreshes of the PR's changes, automatic or manual.
    const changeReads = () => js<{ view: boolean; recheck: string[] | null }[]>('window.changeReads');
    assert.deepEqual(await changeReads(), [], 'Nothing refreshed before the files went stale');
    // Both files go stale within the debounce: one refresh for the PR.
    await js(`(()=>{for(const row of [${staleA},${staleB}]){const b=[...row.querySelectorAll('.diff-gap[data-gap="1"] button')].find(b=>b.getAttribute('aria-label')==='Show 20 lines below the change above');if(!b)throw Error('Missing reveal');b.click()}})()`);
    await wait(`${staleB}.querySelector('.diff-gap[data-gap="1"]')?.textContent.includes('Updating to the latest version…')`);
    assert.equal(await js(`${staleB}.querySelector('.diff-gap[data-gap="1"]').getAttribute('aria-busy')`), 'true');
    assert.ok(!(await js<boolean>(`${staleB}.textContent.includes('changed on GitHub')`)), 'The stale message never shows while it refreshes');
    // The first file matches once refreshed: its reveal applies.
    await wait(`${staleA}?.querySelector('.diff-gap[data-gap="1"]')?.getAttribute('aria-label')==='73 lines hidden'`);
    await wait(`${staleB}?.querySelector('.diff-gap[data-gap="1"]')?.textContent.includes('Couldn’t match this file to its diff.')`);
    assert.ok(await js<boolean>(`[...${staleB}.querySelectorAll('.diff-gap[data-gap="1"] button')].some(b=>b.textContent.trim()==='Refresh')`), 'A manual Refresh');
    // Nothing loops: wait longer than the debounce and the reads, then count.
    await sleep(2000);
    const refreshes = await changeReads();
    assert.deepEqual(refreshes, [{ view: true, recheck: ['src/stale-a.ts', 'src/stale-b.ts'] }], `One automatic refresh at the view tier: ${JSON.stringify(refreshes)}`);
    const staleReads = () => js<{ path: string; mode: unknown }[]>('window.staleReads');
    assert.deepEqual(
      (await staleReads()).map((r) => `${r.path} ${String(r.mode)}`).sort(),
      ['src/stale-a.ts false', 'src/stale-a.ts view', 'src/stale-b.ts false', 'src/stale-b.ts view'],
      'Each file read once on reveal and once, at the view tier, after the refresh'
    );
    assert.ok(await js<boolean>(`window.deepAll('[data-line]',${staleA}).some(e=>e.textContent.trim()==='export const g60 = 60;')`), 'The refreshed file reveals its lines');
    // The reader's Refresh tries once more, interactively, and stops again.
    await js(`[...${staleB}.querySelectorAll('.diff-gap[data-gap="1"] button')].find(b=>b.textContent.trim()==='Refresh').click()`);
    await wait(`window.staleReads.filter(r=>r.path==='src/stale-b.ts').length===3`);
    await wait(`${staleB}?.querySelector('.diff-gap[data-gap="1"]')?.textContent.includes('Couldn’t match this file to its diff.')`);
    await sleep(1500);
    assert.deepEqual((await changeReads()).slice(1), [{ view: false, recheck: ['src/stale-b.ts'] }], 'One interactive refresh');
    assert.equal((await staleReads()).length, 5);
    const diagnostics = await js<{ refreshes: number; mismatches: { path: string; headSha: string; line?: number; lineEndingsDiffer: boolean }[] }>(
      "(async()=>(await import('/lib/use-stale-diff-refresh.ts')).staleDiffRefresh.stats())()"
    );
    assert.deepEqual(
      diagnostics.mismatches.map((m) => [m.path, m.line, m.lineEndingsDiffer]),
      [['src/stale-b.ts', 48, false], ['src/stale-b.ts', 48, false]],
      'Each attempt that ends stale is in the diagnostics export, with its first mismatching line'
    );
    assert.deepEqual(errors, [], 'No console errors');
    console.log('Diff gap browser checks passed: slices without long tasks, 20-line and full reveals from one after-side read, stale diffs refresh once by themselves.');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
