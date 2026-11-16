import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Typing in a line comment inside a large Changes view (#354). A key must not restyle the diff: every key used to
 * cost a full style recalculation of the page. This types 20 characters into an inline comment on a 600-file PR
 * with a large file and checks the per-key event duration and style time.
 */
const KEYS = 20;
/** Per-key budgets at the 90th percentile, for a 1280x800 window without CPU throttling. */
const STYLE_BUDGET_MS = 16;
const LAYOUT_BUDGET_MS = 8;
const EVENT_BUDGET_MS = 64;

type TraceEvent = {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown> & { data?: Record<string, unknown>; elementCount?: number };
};

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const js = <T = unknown>(code: string) =>
    (win.webContents.executeJavaScript(code) as Promise<T>).catch((error: unknown) => {
      throw new Error(code.slice(0, 300) + ': ' + String(error));
    });
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  };
  const cdp = win.webContents.debugger;
  const trace = async (categories: string[], run: () => Promise<void>) => {
    const events: TraceEvent[] = [];
    let complete!: () => void;
    const done = new Promise<void>((resolve) => (complete = resolve));
    const listener = (_event: unknown, method: string, params: { value?: TraceEvent[] }) => {
      if (method === 'Tracing.dataCollected' && params.value) events.push(...params.value);
      if (method === 'Tracing.tracingComplete') complete();
    };
    cdp.on('message', listener);
    await cdp.sendCommand('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories },
    });
    try {
      await run();
    } finally {
      await cdp.sendCommand('Tracing.end');
      await done;
      cdp.removeListener('message', listener);
    }
    return events;
  };
  const frame = () => js('new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)))');
  const typeKeys = async (text: string) => {
    for (const ch of text) {
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await frame();
      await frame();
    }
  };
  /** Style time on the renderer main thread, per key: style work from one keydown to the next. */
  const perKey = (events: TraceEvent[]) => {
    const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain' &&
      events.some((x) => x.pid === e.pid && x.name === 'EventDispatch'));
    assert.ok(main, 'The trace has the renderer main thread');
    const own = events.filter((e) => e.pid === main.pid && e.tid === main.tid).sort((a, b) => a.ts - b.ts);
    const keys = own.filter((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'keydown').map((e) => e.ts);
    const style = own.filter((e) => e.ph === 'X' && (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles'));
    const layout = own.filter((e) => e.ph === 'X' && e.name === 'Layout');
    const sum = (list: TraceEvent[], from: number, to: number) =>
      list.filter((e) => e.ts >= from && e.ts < to).reduce((total, e) => total + (e.dur ?? 0) / 1000, 0);
    return keys.map((from, i) => {
      const to = keys[i + 1] ?? Infinity;
      const recalcs = style.filter((e) => e.ts >= from && e.ts < to);
      return {
        style: sum(style, from, to),
        layout: sum(layout, from, to),
        elements: recalcs.reduce((n, e) => n + (e.args?.elementCount ?? 0), 0),
      };
    });
  };
  const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;

  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    if (process.env.GNOSIS_TYPING_CPU_SLOWDOWN)
      await cdp.sendCommand('Emulation.setCPUThrottlingRate', { rate: Number(process.env.GNOSIS_TYPING_CPU_SLOWDOWN) });
    await waitForWorkbenchQueue(win.webContents);
    // A synthetic 600-file PR. The first file is large: 4,000 lines with a change every 8 lines.
    await js(String.raw`(()=>{
      const big='src/core/engine.ts';
      const before=Array.from({length:4000},(_,i)=>'export const value'+i+' = compute('+i+', "segment-'+(i%17)+'");').join('\n');
      const after=before.split('\n').map((line,i)=>i%8===3?line.replace('compute(','computeNext('):line).join('\n');
      const small='@@ -33,7 +33,7 @@\n const value32 = 32;\n const value33 = 33;\n const value34 = 34;\n-const value35 = 35;\n+const value35 = 36;\n const value36 = 36;\n const value37 = 37;\n const value38 = 38;';
      const files=[{path:big,status:'modified',additions:500,deletions:500,changeId:'big-v1'},
        ...Array.from({length:599},(_,i)=>({path:'src/feature'+String(Math.floor(i/20)).padStart(2,'0')+'/module'+String(i).padStart(3,'0')+'.ts',status:'modified',additions:1,deletions:1,changeId:'small-'+i,patch:small}))];
      const changes=window.electronAPI.getPrChanges,file=window.electronAPI.getPrChangeFile;
      window.electronAPI.getPrChanges=async(...args)=>{const s=await changes(...args);return {...s,files}};
      window.electronAPI.getPrChangeFile=async r=>r.path===big?{before:{kind:'text',content:before},after:{kind:'text',content:after}}:file(r);
    })()`);
    const click = (label: string) =>
      js(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await js(
      `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];void 0`
    );
    // Background preparation may have read the small fixture PR already; load the large one.
    await click('Update changes');
    await wait("document.querySelectorAll('.commit-stream-row[data-file^=\"src/\"]').length>0 && !document.querySelector('.commit-stream-row[data-file=\"src/new.ts\"]')");
    await wait(
      "!!document.querySelector('.commit-stream-row[data-file=\"src/core/engine.ts\"] diffs-container')?.shadowRoot?.querySelector('[data-line-type=change-addition]')"
    );
    // Comment on a changed line inside the large file.
    await js(`(()=>{const row=document.querySelector('.commit-stream-row[data-file="src/core/engine.ts"]');
      const line=[...row.querySelectorAll('diffs-container')].flatMap(host=>[...host.shadowRoot.querySelectorAll('[data-column-number][data-line-type=change-addition]')])[6];
      line.scrollIntoView({block:'center'});line.click()})()`);
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    await js("document.querySelector('.changes-comment-composer textarea').focus()");
    await wait("document.activeElement===document.querySelector('.changes-comment-composer textarea')");
    const size = await js<{ light: number; shadow: number; files: number }>(
      `({light:document.querySelectorAll('*').length,shadow:window.deepAll('*').length,files:document.querySelectorAll('.changes-file-tree').length})`
    );
    console.log('Fixture DOM:', JSON.stringify(size));
    // The large file renders as 200-row slices that mount in the background, so count its slices rather than the
    // elements mounted so far.
    const slices = await js<number>(`document.querySelectorAll('.commit-stream-row[data-file="src/core/engine.ts"] .changes-slice').length`);
    assert.ok(slices >= 15 && size.light > 1_000, `The fixture is a large Changes view: ${slices} slices, ${JSON.stringify(size)}`);
    // The large file is still filling in when typing starts: its remaining slices mount in the background, and must
    // wait while the reader types (#360). Typing here is measured against that pending work.
    const pending = `document.querySelectorAll('.commit-stream-row[data-file="src/core/engine.ts"] .changes-slice:not([data-mounted])').length`;
    const pendingAtStart = await js<number>(pending);
    console.log('Slices still to mount when typing starts:', pendingAtStart);
    assert.ok(pendingAtStart > 0, 'Typing starts while the large file is still mounting');
    // Settle: the first key enables the buttons, so it is typed before measuring.
    await typeKeys('K');
    await new Promise((r) => setTimeout(r, 300));
    await js(`window.keyEvents=[];new PerformanceObserver(list=>{for(const e of list.getEntries())if(['keydown','keypress','input','keyup','beforeinput'].includes(e.name))window.keyEvents.push({name:e.name,id:e.interactionId,duration:e.duration})}).observe({type:'event',durationThreshold:16});void 0`);
    const text = 'eep the retry bounda'.slice(0, KEYS);
    // GNOSIS_TYPING_INVALIDATIONS=1 records invalidations during the measured keys and prints them. With
    // GNOSIS_TYPING_CPU_SLOWDOWN=4 the renderer runs as on a slow CI runner.
    const inspect = !!process.env.GNOSIS_TYPING_INVALIDATIONS;
    const events = await trace(
      ['devtools.timeline', 'disabled-by-default-devtools.timeline', ...(inspect ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : [])],
      () => typeKeys(text)
    );
    if (inspect) {
      const counts = new Map<string, number>();
      for (const e of events) {
        if (!/InvalidationTracking/.test(e.name)) continue;
        const d = e.args?.data ?? {};
        const stack = (d.stackTrace as { functionName?: string; url?: string }[] | undefined)?.slice(0, 3).map((f) => `${f.functionName ?? ''}@${(f.url ?? '').split('/').pop()}`).join('<') ?? '';
        const subtree = (d.invalidationList as { allDescendantsMightBeInvalid?: boolean }[] | undefined)?.some((i) => i.allDescendantsMightBeInvalid);
        const changed = d.changedPseudo ?? d.changedAttribute ?? d.changedClass ?? d.changedId ?? '';
        const key = [e.name, d.reason, d.nodeName, changed, subtree ? 'whole subtree' : '', stack].join(' | ');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      console.log('Invalidations while typing:');
      for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${count}x ${key.slice(0, 400)}`);
    }
    await wait(`document.querySelector('.changes-comment-composer textarea').value===${JSON.stringify('K' + text)}`);
    console.log('Slices still to mount after typing:', await js<number>(pending));
    // Mounting resumes once typing pauses.
    await wait(`${pending}===0`);
    await new Promise((r) => setTimeout(r, 200));
    const keys = perKey(events);
    const durations = await js<{ name: string; id: number; duration: number }[]>('window.keyEvents');
    const byKey = new Map<number, number>();
    for (const e of durations) byKey.set(e.id, Math.max(byKey.get(e.id) ?? 0, e.duration));
    const eventDurations = [...byKey.values()];
    while (eventDurations.length < KEYS) eventDurations.push(0);
    const result = {
      keys: keys.length,
      styleP90: round(p90(keys.map((k) => k.style))),
      styleMax: round(Math.max(...keys.map((k) => k.style))),
      layoutP90: round(p90(keys.map((k) => k.layout))),
      elementsP90: p90(keys.map((k) => k.elements)),
      eventP90: round(p90(eventDurations)),
    };
    console.log('Typing in a large Changes view:', JSON.stringify(result));
    console.log('Style ms and elements per key:', JSON.stringify(keys.map((k) => [round(k.style), k.elements])));
    if (result.styleP90 > STYLE_BUDGET_MS || result.layoutP90 > LAYOUT_BUDGET_MS) {
      // Name what invalidated the style: the element, the reason, the changed state and the script that changed it.
      const detail = await trace(
        ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking'],
        () => typeKeys('xyz')
      );
      const counts = new Map<string, number>();
      for (const e of detail) {
        if (!/InvalidationTracking/.test(e.name)) continue;
        const d = e.args?.data ?? {};
        const stack = (d.stackTrace as { functionName?: string }[] | undefined)?.[0]?.functionName ?? '';
        const subtree = (d.invalidationList as { allDescendantsMightBeInvalid?: boolean }[] | undefined)?.some((i) => i.allDescendantsMightBeInvalid);
        const changed = d.changedPseudo ?? d.changedAttribute ?? d.changedClass ?? d.changedId ?? '';
        const key = [e.name, d.reason, d.nodeName, changed, subtree ? 'whole subtree' : '', stack].join(' | ');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      console.log('Invalidations (3 keys):');
      for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${count}x ${key.slice(0, 400)}`);
    }
    assert.equal(keys.length, KEYS, 'Each key is traced');
    assert.ok(result.styleP90 <= STYLE_BUDGET_MS, `Style per key p90 ${result.styleP90} ms is over ${STYLE_BUDGET_MS} ms`);
    assert.ok(result.layoutP90 <= LAYOUT_BUDGET_MS, `Layout per key p90 ${result.layoutP90} ms is over ${LAYOUT_BUDGET_MS} ms`);
    assert.ok(result.eventP90 <= EVENT_BUDGET_MS, `Key event p90 ${result.eventP90} ms is over ${EVENT_BUDGET_MS} ms`);
    console.log('Comment typing passed: style, layout and event time per key stay within budget in a 600-file Changes view.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'));
    app.exit(1);
  }
});
