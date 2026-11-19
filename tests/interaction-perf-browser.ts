import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { PERF_BUDGET_SCALE, perfBudget } from './perf-budget';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';

/**
 * Interaction latency on large synthetic fixtures (#345, #346). Every input here is a trusted input event sent
 * through Electron, so the app's own slow-interaction monitor (lib/interaction-latency.ts) measures it with the
 * Event Timing API: from the input to the next paint, split into input delay, handlers and presentation.
 *
 * Fixtures: a 1,000-row queue; one PR with 600 modified files and a 3,000-line added file; a long Markdown
 * description; and 300 review threads with 120 comments and 20 reviews in Feedback.
 *
 * GNOSIS_INTERACTION_PROFILE=1 also samples the main thread and Chromium's style and layout counters for each input
 * and prints where the time went. Run it through Docker with
 * `npm run test:browser:docker -- env GNOSIS_INTERACTION_PROFILE=1 node scripts/test-workbench.mjs --interaction-perf`.
 *
 * Timing budgets hold as written in Docker on a quiet machine. They are scaled outside strict runs like every browser
 * check's (tests/perf-budget.ts; GNOSIS_PERF_STRICT=1 enforces them as written). GNOSIS_INTERACTION_CPU_SLOWDOWN=N
 * slows the renderer's CPU N times, as a slow runner does, and multiplies the budgets by N as well. Structural checks do not
 * scale: listener counts, closed tabs' heap and detached DOM, input-delay attribution, renderer errors, and input
 * delay under background sync relative to the same inputs without it.
 */

/** Budgets in milliseconds of Event Timing duration (input to next paint, rounded to 8 ms by the browser), for the
 * slowest sample of each interaction, or the 90th percentile of repeated ones. The fixture runs React in development
 * mode under Xvfb, so these are well above what the packaged app shows; they hold in Docker with headroom. Before
 * #346, returning to Changes took 900-1,100 ms and Checks 300-360 ms; see the numbers this suite prints. */
const budgets: Record<string, number> = {
  'open PR': 300,
  'tab Summary': 200,
  'tab Changes (first)': 650,
  // Showing kept Changes again re-runs its effects. The diffs keep their rendered lines (#352).
  'tab Changes': 600,
  'tab Checks (first)': 350,
  'tab Checks': 300,
  'tab Feedback (first)': 200,
  'tab Feedback': 150,
  // Leaving Changes while the 3,000-line file shows, for Checks or Summary, and coming back. Before #352 leaving took
  // 104-144 ms: cached check reads rendered the whole PR page five or six more times, and the hidden diff view rendered
  // again. Coming back took 96-192 ms while the diffs' effects rendered the large file again. The diffs now keep
  // their lines while hidden (components/KeptFileDiff.tsx), and coming back takes 104-136 ms: React showing the tab
  // again and running its effects.
  'tab away from large diff': 130,
  'tab back to large diff': 160,
  'queue j/k': 200,
  'queue filter keystroke': 200,
  'tree: open large file': 250,
  // Layout and style of 3,000 newly shown lines; see the report in #346.
  'expand large file': 450,
  // About 75 ms of it is one style recalculation per keystroke; see the report in #346.
  'comment keystroke': 150,
  'feedback next item': 120,
  // Keyboard "Viewed & next" on the 600-file PR, pressed about 250 ms apart as a reader moving through files does.
  'viewed next key': 250,
};

/** Input delay (ms) at the 90th percentile of clicks and key presses in Settings and on queue rows while background
 * sync runs: 540 rows with PR descriptions, five PR tabs, and sync, queue and change-signal events every 2 s. Calibrated in Docker.
 * It is checked above the same inputs' delay without sync, so a slower machine raises both. */
const BACKGROUND_INPUT_DELAY_P90 = 50;
/** One-off interactions measured three times and checked at the median: a single sample swung by about 1.7x between
 * otherwise equal CI runs (open PR 496 ms against a 480 ms budget in run 43859276687). */
const MEDIAN_OF_3 = new Set(['open PR']);

const cpuSlowdown = Math.max(1, Number(process.env.GNOSIS_INTERACTION_CPU_SLOWDOWN) || 1);
/** A budget for this run: scaled outside strict runs (shared CI runners ran these interactions up to about 1.25x slower
 * than Docker, run 43838385276), and by the CPU slowdown. */
const scaledBudget = (ms: number) => Math.round(perfBudget(ms) * cpuSlowdown);

type Interaction = {
  type: string;
  key?: string;
  target: string;
  duration: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  frames?: { count: number; script: number; styleAndLayout: number; render: number };
  scripts: { source: string; invoker: string; duration: number }[];
  delay?: { startedBefore: number; blocking: number; scripts: { source: string; sourceFunctionName?: string; invoker: string; duration: number }[] };
  at: number;
};

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
      throw new Error(code.slice(0, 300) + ': ' + String(error));
    }) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await sleep(40);
    }
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  };
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';

  // ── Trusted input ────────────────────────────────────────────────
  // A sync push can re-render the queue between inputs, so a row or badge is waited for briefly: one Windows run asked
  // for the second visible badge while the list was re-rendering after a click.
  const point = async (expression: string) => {
    await wait(`!!(${expression})`, 50).catch(() => {});
    return js<{ x: number; y: number }>(`(()=>{const e=${expression};if(!e)throw Error('Missing target');
      e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
      return {x:Math.round(r.left+Math.min(r.width/2,40)),y:Math.round(r.top+r.height/2)}})()`);
  };
  const mouse = async (expression: string) => {
    const { x, y } = await point(expression);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const key = (keyCode: string, char = keyCode.length === 1) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) win.webContents.sendInputEvent({ type: 'char', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };

  // ── Measurement ──────────────────────────────────────────────────
  const results = new Map<string, Interaction[]>();
  /** Runs one input and returns the slowest interaction the monitor recorded for it. Interactions under 16 ms
   * are not reported by the browser and count as 16. */
  // GNOSIS_INTERACTION_PROFILE=1 samples the main thread during each measured input and prints where it went.
  const profiling = !!process.env.GNOSIS_INTERACTION_PROFILE;
  const profiles = new Map<string, Map<string, number>>();
  const work = new Map<string, Record<string, number>>();
  const mutations = new Map<string, [string, number][]>();
  /** `slow`: the input is known to take 100 ms or more. The monitor records such an interaction once its frames are
   * attributed, up to a second later when the input waited, so wait for the entry instead of the usual settling time. */
  const measure = async (name: string, act: () => Promise<void> | void, done: string, { slow = false } = {}) => {
    const debug = win.webContents.debugger;
    if (profiling) {
      await debug.sendCommand('Profiler.enable');
      await debug.sendCommand('Profiler.setSamplingInterval', { interval: 250 });
      await debug.sendCommand('Profiler.start');
      await debug.sendCommand('Performance.enable');
    }
    const metrics = async () =>
      Object.fromEntries(
        ((await debug.sendCommand('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value])
      );
    const startMetrics = profiling ? await metrics() : {};
    // Which attributes and nodes change during the input: broad style recalcs start from these.
    if (profiling)
      await js(`(()=>{window.__mutations=new Map();window.__mutationObserver?.disconnect();window.__mutationObserver=new MutationObserver(list=>{for(const m of list){
        if(m.target.closest?.('textarea'))continue;
        const k=window.__perf.describeTarget(m.target.nodeType===1?m.target:m.target.parentElement)+' '+(m.type==='attributes'?'@'+m.attributeName:m.type);
        window.__mutations.set(k,(window.__mutations.get(k)??0)+1)}});
        window.__mutationObserver.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true})})()`);
    // Node's clock, not a round trip to the page: a script call would wait for, and so hide, work already running.
    const since = Date.now() - 5;
    await act();
    await wait(done);
    await js(frames);
    // Event entries arrive after the frame that painted them; the monitor then waits for frame attribution.
    await sleep(160);
    if (slow)
      await wait(`window.__perf.slowInteractions().some(e=>e.at>=${Math.floor(since) - 1}&&e.duration>=100)`, 75).catch(() => {});
    if (profiling) {
      const { profile } = (await debug.sendCommand('Profiler.stop')) as {
        profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] };
      };
      const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
      const self = profiles.get(name) ?? new Map<string, number>();
      profile.samples.forEach((sample, i) => {
        const frame = byId.get(sample);
        if (!frame || frame.functionName === '(idle)') return;
        const where = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.split('?')[0]}:${frame.lineNumber + 1}:${(frame as { columnNumber?: number }).columnNumber ?? 0}@${frame.url}`;
        self.set(where, (self.get(where) ?? 0) + profile.timeDeltas[i] / 1000);
      });
      profiles.set(name, self);
      const end = await metrics();
      const total = work.get(name) ?? {};
      for (const metric of ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'])
        total[metric] = (total[metric] ?? 0) + (end[metric] - startMetrics[metric]) * (metric.endsWith('Duration') ? 1000 : 1);
      work.set(name, total);
      const changed = await js<[string, number][]>('window.__mutationObserver.disconnect(),[...window.__mutations].sort((a,b)=>b[1]-a[1]).slice(0,8)');
      mutations.set(name, [...(mutations.get(name) ?? []), ...changed].slice(0, 12));
    }
    const entries = await js<Interaction[]>(
      `window.__perf.slowInteractions().filter(e=>e.at>=${Math.floor(since) - 1})`
    );
    const slowest = entries.sort((a, b) => b.duration - a.duration)[0] ?? {
      type: '(under 16 ms)',
      target: '',
      duration: 16,
      inputDelay: 0,
      processing: 0,
      presentation: 0,
      scripts: [],
      at: since,
    };
    results.set(name, [...(results.get(name) ?? []), slowest]);
    return slowest;
  };

  const tab = (label: string) =>
    `[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].find(t=>t.textContent.trim().startsWith(${JSON.stringify(label)}))`;
  const deep = `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];void 0`;

  const report = () => {
    const summary = [...results].map(([name, list]) => {
      const durations = list.map((e) => e.duration).sort((a, b) => a - b);
      const worst = [...list].sort((a, b) => b.duration - a.duration)[0];
      return {
        name,
        samples: list.length,
        p50: durations[Math.floor((durations.length - 1) / 2)],
        all: list.map((e) => e.duration).join(','),
        max: durations[durations.length - 1],
        // Repeated inputs (j/k, typing) are checked at the 90th percentile: one sample can meet unrelated background
        // work, such as the fixture hashing the whole queue when it saves filters. Single inputs are checked as they are.
        // Interactions repeated only to steady a one-off measure are checked at the median (see MEDIAN_OF_3).
        checked: durations.length >= 10 ? durations[Math.ceil(durations.length * 0.9) - 1] : MEDIAN_OF_3.has(name) ? durations[Math.floor((durations.length - 1) / 2)] : durations[durations.length - 1],
        budget: name in budgets ? scaledBudget(budgets[name]) : undefined,
        worst,
      };
    });
    console.log(
      `Interaction latency (ms, input to next paint). Budgets x${PERF_BUDGET_SCALE}${PERF_BUDGET_SCALE === 1 ? ' (as written)' : ''}${cpuSlowdown > 1 ? `, x${cpuSlowdown} for the CPU slowdown` : ''}:`
    );
    for (const s of summary)
      console.log(
        `  ${s.name.padEnd(24)} n=${String(s.samples).padStart(2)} p50 ${String(s.p50).padStart(4)}  max ${String(s.max).padStart(4)}  checked ${String(s.checked).padStart(4)}  budget ${s.budget} [${s.all}]` +
          `  worst: input ${s.worst.inputDelay} / handlers ${s.worst.processing} / paint ${s.worst.presentation}` +
          (s.worst.frames ? ` · frames script ${s.worst.frames.script} style+layout ${s.worst.frames.styleAndLayout}` : '')
      );
    const slowest = [...results.entries()]
      .flatMap(([name, list]) => list.map((e) => ({ name, ...e })))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 8);
    console.log('Slowest interactions:');
    for (const e of slowest)
      console.log(
        `  ${e.duration} ms ${e.name} (${e.type}${e.key ? ' ' + e.key : ''} on ${e.target}): ` +
          (e.scripts.slice(0, 3).map((s) => `${s.source} ${s.duration}ms [${s.invoker}]`).join('; ') || 'no long scripts')
      );
    for (const [name, total] of work)
      console.log(`Work ${name}: ` + Object.entries(total).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
    for (const [name, list] of mutations) console.log(`Mutations ${name}: ` + list.map(([k, n]) => `${n}x ${k}`).join('; '));
    for (const [name, self] of profiles)
      console.log(
        `Profile ${name}: ` +
          [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([where, ms]) => `${ms.toFixed(0)}ms ${where.split('@')[0]}`).join('; ')
      );
    return summary;
  };
  /** The transformed source at the hottest frames, since dev-server line numbers do not match the files. */
  const profileSources = async () => {
    const hot = new Map<string, number>();
    for (const self of profiles.values()) for (const [where, ms] of self) hot.set(where, (hot.get(where) ?? 0) + ms);
    for (const [where, ms] of [...hot].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      const [label, url] = where.split('@');
      if (!url || !/\/(lib|components|src|deps)\//.test(url)) continue;
      const [, line, column] = (label.split(' ').pop() ?? '').split(':');
      const text = await js<string>(`fetch(${JSON.stringify(url)}).then(r=>r.text())`).catch(() => '');
      const source = text.split('\n')[Number(line) - 1]?.slice(Math.max(0, Number(column) - 60), Number(column) + 100) ?? '';
      console.log(`  hot ${ms.toFixed(0)}ms ${label}: ${source.trim()}`);
    }
  };

  // ── Background sync (#345 input delay) ─────────────────────────────
  /**
   * Input delay with a real-sized queue and background sync: 540 rows (180 open, a 360-row backlog), five open PR tabs, and every 2 s main's
   * `workbench-changed` with a few rows updated, `github-sync` updates for a third of the watched PRs, and a
   * change-signals tick. Clicks and key presses in Settings and on queue rows must not wait behind that work.
   * Also checks that `github-sync` listeners stay bounded however many views watch GitHub.
   */
  const backgroundSync = async () => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&github-sync&change-signals`);
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (cpuSlowdown > 1) await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{window.__perf=await import('/lib/interaction-latency.ts');
      window.__perf.startInteractionMonitor({threshold:16,capacity:500});window.__perf.clearSlowInteractions()})()`);
    // Every long animation frame from here on, with its scripts.
    await js(`(()=>{window.__frames=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.__frames.push({start:e.startTime,duration:e.duration,
      blocking:e.blockingDuration,scripts:e.scripts.map(s=>({fn:s.sourceFunctionName,url:s.sourceURL,at:s.sourceCharPosition,invoker:s.invoker,type:s.invokerType,duration:s.duration}))})}).observe({type:'long-animation-frame'})})()`);
    // 540 rows, each PR with a 4 KB description. Each read returns a fresh copy, as main's snapshot over IPC does.
    await js(String.raw`(async()=>{
      const original=await window.electronAPI.workbenchQueue();
      const items=Array.from({length:540},(_,i)=>{
        const item=structuredClone(original.items[i%original.items.length]);
        if(i>=original.items.length){
          item.subject.id='bg-'+i;
          item.subject.members=item.subject.members.map((m,j)=>({...m,title:'Background PR '+i,number:20000+i*4+j,url:'https://github.com/fixture/bg/pull/'+(20000+i*4+j)}));
          if(item.subject.kind==='pr')item.subject.title='Background PR '+i;
        }
        item.subject.members=item.subject.members.map(m=>({...m,description:('## Change '+i+'\n\nThis keeps **pending commands** ordered when the worker restarts. ').repeat(50)}));
        item.attention=i<180?'updated':i<300?'requested':'other';
        return item;
      });
      window.__bgItems=items;
      const read=async()=>structuredClone({...original,items});
      window.electronAPI.workbenchQueue=read;
      window.electronAPI.workbenchSnapshot=read;
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("!!document.querySelector('[data-queue-total=\"540\"]')");
    await wait("document.querySelectorAll('.queue-item').length>5");
    /** Listeners and watches, and the JS heap after a full garbage collection, in MB. */
    /** Live objects of a kind, found from one instance's prototype: React fibers, and elements live or detached. */
    const live = async (expression: string) => {
      const debug = win.webContents.debugger;
      // One object group, released after: query results the debugger keeps would hold every element alive.
      const objectGroup = 'heap-check';
      try {
        const proto = (await debug.sendCommand('Runtime.evaluate', { expression, objectGroup })) as { result: { objectId?: string } };
        if (!proto.result.objectId) return -1;
        const found = (await debug.sendCommand('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup })) as {
          objects: { objectId: string };
        };
        const length = (await debug.sendCommand('Runtime.callFunctionOn', {
          objectId: found.objects.objectId,
          functionDeclaration: 'function(){return this.length}',
          returnByValue: true,
          objectGroup,
        })) as { result: { value: number } };
        return length.result.value;
      } finally {
        await debug.sendCommand('Runtime.releaseObjectGroup', { objectGroup });
      }
    };
    const listeners = async () => {
      // One pass can leave megabytes for the next on a busy runner; collect until a pass frees under 1 MB.
      let heap = { usedSize: Infinity };
      for (let pass = 0; pass < 9; pass++) {
        await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
        const next = (await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')) as { usedSize: number };
        const freed = heap.usedSize - next.usedSize;
        heap = next;
        if (freed < 1e6) break;
        await sleep(50);
      }
      const fiber = "(()=>{const r=document.getElementById('root');const k=Object.keys(r).find(k=>k.startsWith('__reactContainer'));return Object.getPrototypeOf(r[k])})()";
      return {
        ...(await js<{ receivers: number; watches: number }>('({receivers:window.syncFixture.receivers.size,watches:window.syncFixture.subscriptions.size})')),
        heapMB: Math.round(heap.usedSize / 1e5) / 10,
        fibers: await live(fiber),
        elements: await live('HTMLElement.prototype'),
      };
    };
    const counts: Record<string, { receivers: number; watches: number; heapMB: number; fibers: number; elements: number }> = { queue: await listeners() };

    // Five PR tabs, each visited once so it mounts, then back to the queue.
    const tabs = "document.querySelectorAll('.workspace-tab-select')";
    const openTabs = async (offset = 0) => {
      // The queue mounts only the rows near the viewport: about 13 in the 681 px a Windows runner gives this window.
      const mounted = await js<number>("document.querySelector('[data-workspace-active=true] .queue-list').querySelectorAll('.queue-row-main').length");
      const start = Math.max(0, Math.min(offset, mounted - 5));
      for (let i = start; i < start + 5; i++) {
        const before = await js<number>(`${tabs}.length`);
        await js(
          `document.querySelector('[data-workspace-active=true] .queue-list').querySelectorAll('.queue-row-main')[${i}].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
        );
        await wait(`${tabs}.length===${before + 1}`);
      }
      const total = await js<number>(`${tabs}.length`);
      for (let i = 1; i < total; i++) {
        await js(`${tabs}[${i}].click()`);
        await wait(`!!document.querySelector('[data-workspace-active=true] .pr-summary-page')`);
        await sleep(400);
      }
      await js(`${tabs}[0].click()`);
      await wait(`!!document.querySelector('[data-workspace-active=true] .queue-list')`);
    };
    const closeTabs = async () => {
      for (let open = await js<number>(`${tabs}.length`); open > 1; open--) {
        await js(`document.querySelectorAll('.workspace-tab-close')[${open - 1}].click()`);
        await wait(`${tabs}.length===${open - 1}`);
      }
      await wait(`!!document.querySelector('[data-workspace-active=true] .queue-list')`);
    };
    await openTabs();
    counts['five tabs'] = await listeners();

    // What main sends while the reader works.
    await js(String.raw`(()=>{
      window.__storm={ticks:0,ms:0};
      const tick=async()=>{
        const started=performance.now();
        const n=++window.__storm.ticks;
        const now=new Date().toISOString();
        const items=window.__bgItems;
        for(let k=0;k<6;k++){const item=items[(n*7+k*13)%items.length];item.subject={...item.subject,members:item.subject.members.map(m=>({...m,updatedAt:now}))};}
        window.syncFixture.changed();
        const watched=new Map();
        for(const interest of window.syncFixture.subscriptions.values())for(const t of interest.targets)watched.set(interest.kind+' '+t.url,{kind:interest.kind,...t});
        const due=[...watched.values()].filter((_,i)=>i%3===n%3);
        const signals=due.filter(t=>t.kind==='signals');
        const values=signals.length?await window.electronAPI.getQueueSignals(signals.map(t=>({url:t.url,headSha:t.headSha??''}))):[];
        for(const value of values)window.syncFixture.emit({kind:'signals',url:value.url,value:{...value,checkedAt:Date.now()}});
        const members=new Map(items.flatMap(i=>i.subject.members).map(m=>[m.url,m]));
        for(const t of due)if(t.kind==='metadata'&&members.has(t.url))window.syncFixture.emit({kind:'metadata',url:t.url,value:{...members.get(t.url),updatedAt:now}});
        await window.changeFixture?.tick(1000);
        window.__storm.ms+=performance.now()-started;
      };
      window.__storm.tick=tick;
      window.__storm.timer=setInterval(()=>void tick(),2000);
    })()`);
    await sleep(3000);

    // A quiet stretch: what runs on the main thread while the reader does nothing.
    const debug = win.webContents.debugger;
    const quietSince = await js<number>('performance.now()');
    if (profiling) {
      await debug.sendCommand('Profiler.enable');
      await debug.sendCommand('Profiler.setSamplingInterval', { interval: 250 });
      await debug.sendCommand('Profiler.start');
    }
    await sleep(12_000);
    if (profiling) {
      const { profile } = (await debug.sendCommand('Profiler.stop')) as {
        profile: {
          nodes: { id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number } }[];
          samples: number[];
          timeDeltas: number[];
        };
      };
      const parent = new Map<number, number>();
      for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
      const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
      const label = (f: { functionName: string; url: string; lineNumber: number }) =>
        `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()?.split('?')[0]}:${f.lineNumber + 1}`;
      const inclusive = new Map<string, number>();
      const self = new Map<string, number>();
      profile.samples.forEach((sample, i) => {
        const ms = profile.timeDeltas[i] / 1000;
        const top = byId.get(sample);
        if (!top || top.functionName === '(idle)' || top.functionName === '(program)') return;
        self.set(label(top), (self.get(label(top)) ?? 0) + ms);
        const seen = new Set<string>();
        for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
          const frame = byId.get(id);
          if (!frame || !/\/(lib|components|src|tests)\//.test(frame.url)) continue;
          const where = label(frame);
          if (seen.has(where)) continue;
          seen.add(where);
          inclusive.set(where, (inclusive.get(where) ?? 0) + ms);
        }
      });
      const top = (map: Map<string, number>, n: number) =>
        [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([where, ms]) => `${ms.toFixed(0)}ms ${where}`).join('; ');
      console.log(`Background profile, 12 s with sync and no input (inclusive, app code): ${top(inclusive, 30)}`);
      console.log(`Background profile (self): ${top(self, 20)}`);
    }
    const quiet = await js<{ count: number; total: number; blocking: number; max: number; top: [string, number, number, number][] }>(`(()=>{
      const frames=window.__frames.filter(f=>f.start>=${quietSince});
      const by=new Map();
      for(const f of frames)for(const s of f.scripts){const k=(s.invoker||s.type)+' · '+(s.fn||'(anonymous)')+' '+s.url.split('/').pop().split('?')[0]+':'+s.at;
        const v=by.get(k)??[0,0,0];v[0]+=s.duration;v[1]++;v[2]=Math.max(v[2],s.duration);by.set(k,v)}
      return {count:frames.length,total:Math.round(frames.reduce((a,f)=>a+f.duration,0)),blocking:Math.round(frames.reduce((a,f)=>a+f.blocking,0)),
        max:Math.round(Math.max(0,...frames.map(f=>f.duration))),top:[...by].sort((a,b)=>b[1][0]-a[1][0]).slice(0,15).map(([k,v])=>[k,Math.round(v[0]),v[1],Math.round(v[2])])}})()`);
    console.log(`Background long frames in 12 s without input: ${quiet.count} frames, ${quiet.total} ms (blocking ${quiet.blocking} ms), longest ${quiet.max} ms`);
    for (const [where, total, n, max] of quiet.top) console.log(`  ${total} ms in ${n} scripts (max ${max}): ${where}`);

    // From here each input lands while a sync event is being handled: the test sends the event, then the input
    // 20-120 ms later, when the queue snapshot it caused is read and rendered. Without this, inputs would mostly fall
    // between events, and the check would pass however long the event's work blocked input.
    await js('clearInterval(window.__storm.timer)');
    const offsets = [20, 45, 70, 95, 120];
    let sent = 0;
    const synced = (prepare: () => Promise<() => void>) => async () => {
      const send = await prepare();
      await js('void window.__storm.tick()');
      await sleep(offsets[sent++ % offsets.length]);
      send();
    };
    const click = (expression: string) => async () => {
      const { x, y } = await point(expression);
      return () => {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      };
    };
    const press = (ch: string) => () => Promise.resolve(() => key(ch, true));

    // ── Settings under background sync ──
    const dialogTab = (label: string) =>
      `[...document.querySelectorAll('[role=dialog] [role=tab]')].find(t=>t.textContent.trim()===${JSON.stringify(label)})`;
    for (let round = 0; round < 3; round++) {
      await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
      await wait("!!document.querySelector('[role=dialog] [role=tab]')");
      await sleep(300);
      for (const label of ['Queue', 'Review', 'Appearance', 'Notifications', 'Diagnostics', 'Integrations']) {
        if (!(await js<boolean>(`!!${dialogTab(label)}`))) continue;
        await measure('bg settings tab', synced(click(dialogTab(label))), `${dialogTab(label)}.getAttribute('aria-selected')==='true'`);
        await sleep(150);
        const description = "[...document.querySelectorAll('[role=dialog] .settings-description')].find(e=>e.checkVisibility())";
        if (await js<boolean>(`!!${description}`)) {
          await measure('bg settings description', synced(click(description)), 'true');
          await sleep(150);
        }
      }
      if (await js<boolean>("!!document.querySelector('#claude-path')")) {
        await measure('bg settings input', synced(click("document.querySelector('#claude-path')")), "document.activeElement?.id==='claude-path'");
        let typed = await js<string>("document.querySelector('#claude-path').value");
        for (const ch of 'claude') {
          typed += ch;
          await measure('bg settings keystroke', synced(press(ch)), `document.querySelector('#claude-path').value===${JSON.stringify(typed)}`);
        }
        for (let i = 0; i < 6; i++) key('Backspace', false);
        await sleep(200);
      }
      key('Escape', false);
      await wait("!document.querySelector('[role=dialog] [role=tab]')");
      await sleep(300);
      counts[`settings closed ${round + 1}`] = await listeners();
    }

    // ── Briefing chips and the queue list, stepped through quickly ──
    // A reader trying filters clicks a chip, then another, or the list, a moment later. The second input meets the
    // first one's follow-up work: the filter save 300 ms later and the queue it returns.
    const chips = await js<string[]>(
      "[...document.querySelectorAll('[data-workspace-active=true] .briefing-chip')].map(c=>c.dataset.state)"
    );
    const chip = (state: string) => `document.querySelector('[data-workspace-active=true] .briefing-chip[data-state="${state}"]')`;
    const list = "document.querySelector('[data-workspace-active=true] section.queue-list')";
    const pressAt = ({ x, y }: { x: number; y: number }) => () => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    const listEdge = await js<{ x: number; y: number }>(
      `(()=>{const r=${list}.getBoundingClientRect();return {x:Math.round(r.right-4),y:Math.round(r.top+r.height/2)}})()`
    );
    const gaps = [40, 120, 200];
    for (let i = 0; i < 12; i++) {
      const state = chips[1 + (i % Math.max(1, chips.length - 1))] ?? chips[0];
      const at = await point(chip(state));
      await measure('bg briefing chip', pressAt(at), 'true');
      await sleep(gaps[i % gaps.length]);
      await measure('bg queue list press', pressAt(listEdge), 'true');
      await sleep(gaps[(i + 1) % gaps.length]);
    }
    await js(`${chip('all')}?.click()`);
    await sleep(500);

    // ── Workspace tabs, switched one after another ──
    for (let round = 0; round < 2; round++)
      for (let i = 1; i < 6; i++) {
        const at = await point(`document.querySelectorAll('.workspace-tab-select')[${i}]`);
        await measure('bg workspace tab', pressAt(at), `document.querySelectorAll('.workspace-tab-select')[${i}].getAttribute('aria-selected')==='true'`);
        await sleep(150);
      }
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait(`!!document.querySelector('[data-workspace-active=true] .queue-list')`);
    await sleep(300);

    // ── Queue rows under background sync ──
    const row = (i: number) =>
      `document.querySelector('[data-workspace-active=true] .queue-list').querySelectorAll('.queue-row-main')[${i}]`;
    const badge = (i: number) =>
      `[...document.querySelectorAll('[data-workspace-active=true] .queue-metadata .merge-readiness-badge, [data-workspace-active=true] .queue-metadata')].filter(e=>e.checkVisibility())[${i}]`;
    // The same inputs with no sync event in flight: what this machine takes anyway.
    const idle = (prepare: () => Promise<() => void>) => async () => (await prepare())();
    for (let i = 0; i < 8; i++) {
      await measure('idle queue row', idle(click(row(i % 8))), 'true');
      await sleep(120);
      await measure('idle queue badge', idle(click(badge(i % 6))), 'true');
      await sleep(120);
    }
    for (let i = 0; i < 16; i++) {
      await measure('bg queue row', synced(click(row(i % 8))), 'true');
      await sleep(120);
      await measure('bg queue badge', synced(click(badge(i % 6))), 'true');
      await sleep(120);
    }

    // Opening and closing tabs again leaves no listeners behind.
    await closeTabs();
    counts['tabs closed'] = await listeners();
    await openTabs();
    counts['five tabs again'] = await listeners();
    await closeTabs();
    counts['tabs closed again'] = await listeners();
    // A longer session: the same cycle three more times. Memory that stays behind grows with every cycle.
    // Different PRs each time, as a reader works through the queue: per-PR caches must stay bounded too.
    for (let cycle = 3; cycle <= 5; cycle++) {
      await openTabs((cycle - 2) * 3);
      await closeTabs();
      counts[`tabs closed ${cycle}`] = await listeners();
    }
    // GNOSIS_HEAP_RETAINERS=1: what keeps the closed tabs' DOM alive, from a heap snapshot.
    if (process.env.GNOSIS_HEAP_RETAINERS) {
      const debug = win.webContents.debugger;
      const chunks: string[] = [];
      const collect = (_event: unknown, method: string, params: { chunk?: string }) => {
        if (method === 'HeapProfiler.addHeapSnapshotChunk' && params.chunk) chunks.push(params.chunk);
      };
      const scripts = new Map<string, string>();
      const parsed = (_event: unknown, method: string, params: { scriptId?: string; url?: string }) => {
        if (method === 'Debugger.scriptParsed' && params.scriptId && params.url) scripts.set(params.scriptId, params.url);
      };
      debug.on('message', parsed);
      await debug.sendCommand('Debugger.enable');
      debug.on('message', collect);
      await debug.sendCommand('HeapProfiler.enable');
      await debug.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      debug.removeListener('message', collect);
      const { detachedRetainers } = await import('./heap-retainers');
      debug.removeListener('message', parsed);
      const named = detachedRetainers(chunks.join('')).map((line) =>
        line.replace(/@(\d+):(\d+):(\d+)/g, (_all, id: string, row: string, column: string) => `@${(scripts.get(id) ?? id).split('/').pop()?.split('?')[0]}:${row}:${column}`)
      );
      console.log('Detached DOM retainers:\n  ' + named.join('\n  '));
    }
    const storm = await js<{ ticks: number; ms: number }>('({ticks:window.__storm.ticks,ms:Math.round(window.__storm.ms)})');
    console.log('Background sync ticks:', JSON.stringify(storm));
    console.log('github-sync listeners (renderer receivers / watches) and JS heap after GC:', JSON.stringify(counts));

    const measured = [...results].filter(([name]) => name.startsWith('bg '));
    const delays = measured.flatMap(([, list]) => list.map((e) => e.inputDelay)).sort((a, b) => a - b);
    const quantile = (values: number[], q: number) => values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
    const idleDelays = [...results].filter(([name]) => name.startsWith('idle ')).flatMap(([, list]) => list.map((e) => e.inputDelay)).sort((a, b) => a - b);
    console.log(`Background input delay (ms): n=${delays.length} p50 ${quantile(delays, 0.5)} p90 ${quantile(delays, 0.9)} max ${delays.at(-1)}`);
    console.log(`Input delay without sync (ms): n=${idleDelays.length} p50 ${quantile(idleDelays, 0.5)} p90 ${quantile(idleDelays, 0.9)} max ${idleDelays.at(-1)}`);
    for (const [name, list] of measured) {
      const d = list.map((e) => e.inputDelay).sort((a, b) => a - b);
      console.log(
        `  ${name.padEnd(26)} input p50 ${quantile(d, 0.5)} p90 ${quantile(d, 0.9)} max ${d.at(-1)} [${list.map((e) => e.inputDelay).join(',')}]`
      );
    }
    const worst = measured
      .flatMap(([name, list]) => list.map((e) => ({ name, ...e })))
      .sort((a, b) => b.inputDelay - a.inputDelay)
      .slice(0, 6);
    for (const e of worst)
      console.log(
        `  input ${e.inputDelay} ms ${e.name} (${e.type} on ${e.target}): ` +
          (e.scripts.slice(0, 4).map((s) => `${s.source} ${s.duration}ms [${s.invoker}]`).join('; ') || 'no long scripts') +
          (e.delay
            ? ` · waited behind work started ${e.delay.startedBefore} ms earlier: ` +
              (e.delay.scripts.map((s) => `${s.source} ${s.duration}ms [${s.invoker}]`).join('; ') || 'no script attributed')
            : '')
      );
    return { p90: quantile(delays, 0.9), idleP90: quantile(idleDelays, 0.9), counts };
  };

  try {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
    await js(deep);
    // The app's own monitor, at the lowest threshold so every interaction is measured.
    await js(`(async()=>{window.__perf=await import('/lib/interaction-latency.ts');
      window.__perf.startInteractionMonitor({threshold:16,capacity:500});window.__perf.clearSlowInteractions()})()`);
    const monitor = await js<{ supported: boolean; frameTiming: boolean }>('window.__perf.interactionMonitorState()');
    assert.ok(monitor.supported, 'The Event Timing API is available');
    console.log('Interaction monitor:', JSON.stringify(monitor));

    // ── The monitor records a slow click with its target, split and the script that caused it ──
    await js(`(()=>{const b=document.createElement('button');b.className='perf-probe';b.dataset.perfProbe='';b.textContent='Probe';
      b.style.cssText='position:fixed;right:8px;bottom:8px;z-index:9999';
      b.addEventListener('click',function busyProbe(){const end=performance.now()+180;while(performance.now()<end);window.__probeClicks=(window.__probeClicks??0)+1});
      document.body.append(b)})()`);
    // Measured once the handler has run: on a slow runner the input can arrive after the measure's settling time.
    await js('window.__probeClicks=0');
    const probe = await measure('probe', () => mouse("document.querySelector('.perf-probe')"), 'window.__probeClicks===1', { slow: true });
    console.log('Probe interaction:', JSON.stringify(probe));
    assert.ok(probe.duration >= 180, `A 180 ms handler is a slow interaction: ${probe.duration}`);
    assert.ok(probe.processing >= 170, `Its time is in the handlers: ${JSON.stringify(probe)}`);
    assert.match(probe.target, /button\.perf-probe\[data-perf-probe\]/, 'The target is a stable selector');
    if (monitor.frameTiming)
      assert.ok(
        probe.scripts.some((s) => s.duration >= 150 && /click/i.test(s.invoker)),
        `Long animation frames name the click handler: ${JSON.stringify(probe.scripts)}`
      );
    await js("document.querySelector('.perf-probe').remove()");
    results.delete('probe');


    // GNOSIS_INTERACTION_ONLY=background runs only the background-sync check below.
    large: {
    if (process.env.GNOSIS_INTERACTION_ONLY === 'background') break large;

    // ── A click that waits behind work already running names that work (input-delay attribution) ──
    await js(`(()=>{const b=document.createElement('button');b.className='perf-probe';b.textContent='Probe';
      b.style.cssText='position:fixed;right:8px;bottom:8px;z-index:9999';window.__probeClicks=0;
      b.addEventListener('click',()=>{window.__probeClicks++});document.body.append(b)})()`);
    const probePoint = await point("document.querySelector('.perf-probe')");
    // The click must reach the page while the timer runs. A fixed head start raced on macOS runners: the click arrived
    // after the timer had finished and waited behind nothing. Instead the timer says when it starts (console messages
    // leave the renderer while its main thread is busy), the click is sent 30 ms later, and the timer runs until the click
    // has been queued for 150 ms (isInputPending), and at least 250 ms. Without isInputPending it runs to the 3 s cap.
    const busyStart = () => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        win.webContents.off('console-message', started);
        reject(new Error('The busy timer never started'));
      }, 10_000);
      function started({ message }: { message: string }) {
        if (message !== 'gnosis-busy-start') return;
        clearTimeout(timeout);
        win.webContents.off('console-message', started);
        resolve();
      }
      win.webContents.on('console-message', started);
    });
    const waited = await measure(
      'probe',
      async () => {
        const busyStarted = busyStart();
        // Awaited below; a failed script call must not also leave this rejection unhandled.
        busyStarted.catch(() => {});
        await js(`window.__busy=undefined;setTimeout(function busyBeforeInput(){console.log('gnosis-busy-start');
          const start=performance.now();let pending=null,now=start;
          while((now=performance.now())-start<3000){
            if(pending===null&&navigator.scheduling?.isInputPending?.())pending=now;
            if(now-start>=250&&pending!==null&&now-pending>=150)break;
          }
          window.__busy={ran:Math.round(now-start),pendingAt:pending===null?null:Math.round(pending-start),inputPendingApi:typeof navigator.scheduling?.isInputPending==='function'};
        },0),void 0`);
        await busyStarted;
        // Well after the work began, so the record can say how long before the input it started.
        await sleep(30);
        win.webContents.sendInputEvent({ type: 'mouseDown', ...probePoint, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...probePoint, button: 'left', clickCount: 1 });
      },
      'window.__probeClicks===1',
      { slow: true }
    );
    const busy = await js<{ ran: number; pendingAt: number | null; inputPendingApi: boolean }>('window.__busy');
    console.log('Input-delay probe:', JSON.stringify(waited), 'busy timer:', JSON.stringify(busy));
    assert.ok(!busy.inputPendingApi || busy.pendingAt !== null, `The click was queued while the busy timer ran: ${JSON.stringify(busy)}`);
    assert.ok(waited.inputDelay >= 100, `The click waited behind the busy timer: ${JSON.stringify({ waited, busy })}`);
    assert.ok(waited.delay && waited.delay.startedBefore > 0, `The record says what it waited behind: ${JSON.stringify(waited)}`);
    if (monitor.frameTiming)
      assert.ok(
        waited.delay.scripts.some((s) => s.sourceFunctionName === 'busyBeforeInput' && /setTimeout/.test(s.invoker) && s.duration >= 200),
        `Input delay names the timer that blocked it: ${JSON.stringify(waited.delay)}`
      );
    await js("document.querySelector('.perf-probe').remove()");
    results.delete('probe');

    // The monitor's own checks above time wall-clock busy loops; the app's interactions from here run on the slowed CPU.
    if (cpuSlowdown > 1) await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });

    // ── Fixtures ──────────────────────────────────────────────────
    await js(String.raw`(async()=>{
      const prUrl='https://github.com/klang/engine/pull/150';
      const lines=(n,f)=>Array.from({length:n},(_,i)=>f(i)).join('\n');
      // 600 modified files in 30 folders, each with one changed line, and one 3,000-line added file.
      const before=i=>lines(60,k=>'export const value'+k+' = '+k+'; // file '+i);
      const files=[];
      for(let i=0;i<600;i++){
        const path='src/area'+(i%30)+'/module'+i+'.ts';
        const patch='@@ -28,7 +28,7 @@\n'+lines(7,k=>k===3?'-export const value30 = 30; // file '+i+'\n+export const value30 = 31; // file '+i:' export const value'+(27+k)+' = '+(27+k)+'; // file '+i);
        files.push({path,status:'modified',additions:1,deletions:1,changeId:'c'+i,patch});
      }
      const huge=lines(3000,k=>'export function generated'+k+'(input: number): number { return input * '+k+' + '+(k%7)+'; }');
      files.splice(5,0,{path:'src/a-generated/huge.ts',status:'added',additions:3000,deletions:0,changeId:'huge',patch:'@@ -0,0 +1,3000 @@\n'+huge.split('\n').map(l=>'+'+l).join('\n')});
      window.bigFiles=files;
      // A revision of its own: the small fixture's content for head-0 may already be prepared, and views open on it (#351).
      const head='head-large';
      const changes=window.electronAPI.getPrChanges,commits=window.electronAPI.getPrCommits;
      window.electronAPI.getPrChanges=async(url,...rest)=>{const s=await changes(url,...rest);return url===prUrl?{...s,files,metadata:{...s.metadata,headSha:head}}:s};
      window.electronAPI.getPrCommits=async(url,...rest)=>{const s=await commits(url,...rest);return url===prUrl?{...s,metadata:{...s.metadata,headSha:head}}:s};
      const read=window.electronAPI.getPrChangeFile;
      window.electronAPI.getPrChangeFile=async r=>{
        if(r.url!==prUrl)return read(r);
        if(r.path==='src/a-generated/huge.ts')return {before:{kind:'absent'},after:{kind:'text',content:huge}};
        const i=Number(r.path.match(/module(\d+)/)?.[1]??0);
        return {before:{kind:'text',content:before(i)},after:{kind:'text',content:before(i).replace('value30 = 30;','value30 = 31;')}};
      };
      // Feedback: 300 inline threads, 120 conversation comments and 20 reviews.
      const stamp='2026-11-03T10:00:00Z';
      const comment=(id,body,login='maya')=>({id,body,author:{login,avatarUrl:''},createdAt:stamp,updatedAt:stamp,url:prUrl+'#'+id});
      const body=n=>'Comment '+n+': the **retry boundary** must hold when the transport reconnects. See \`dispatch()\` and the [design note](https://example.com/'+n+').\n\n- Keep the queue slot\n- Release it on cancel';
      const threads=Array.from({length:300},(_,n)=>({id:'thread-'+n,path:files[(n*7)%files.length].path,line:31,startLine:null,diffSide:'RIGHT',isResolved:n%5===0,isOutdated:n%11===0,viewerCanResolve:true,viewerCanUnresolve:false,
        comments:[{...comment('tc-'+n,body(n)),diffHunk:'@@ -28,4 +28,4 @@\n export const value28 = 28;\n-export const value30 = 30;\n+export const value30 = 31;',pullRequestReview:{id:'r-'+(n%20)},viewerCanUpdate:false,viewerCanDelete:false},
          {...comment('tr-'+n,'Reply '+n+'. Agreed, keeping it.','lena'),pullRequestReview:{id:'r-'+(n%20)},viewerCanUpdate:false,viewerCanDelete:false}]}));
      const feedback={comments:Array.from({length:120},(_,n)=>comment('ic-'+n,body(1000+n),n%3?'sam':'owen')),
        reviews:Array.from({length:20},(_,n)=>({...comment('r-'+n,'Review '+n+'. '+body(2000+n)),state:n%4?'COMMENTED':'CHANGES_REQUESTED',submittedAt:stamp})),
        requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'};
      const data={headSha:head,baseSha:'base-0',checkedAt:Date.now(),threads,feedback};
      const cached=window.electronAPI.getCachedReviewThreads,threadsRead=window.electronAPI.getReviewThreads;
      window.electronAPI.getCachedReviewThreads=async(url,...rest)=>url===prUrl?structuredClone(data):cached?.(url,...rest);
      window.electronAPI.getReviewThreads=async(url,...rest)=>url===prUrl?structuredClone(data):threadsRead(url,...rest);
      // A 1,000-row queue. The real PR stays first; the rest are copies with their own URLs.
      const originalQueue=window.electronAPI.workbenchQueue;
      const original=await originalQueue();
      const pr=original.items.find(i=>i.subject.title?.includes('Fix reconnect')||i.subject.members[0].title.includes('Fix reconnect'));
      const description=Array.from({length:60},(_,n)=>'## Section '+n+'\n\nThis change keeps **pending commands** ordered when the worker restarts. It touches \`queue.ts\`, \`dispatch.ts\` and the [scheduler](https://example.com/s'+n+').\n\n| Case | Before | After |\n| --- | --- | --- |\n| Retry | lost | kept |\n| Cancel | leaked | released |\n\n\`\`\`ts\nexport function dispatch'+n+'(command: Command) {\n  return queue.acquire().then(slot => run(command).finally(() => slot.release()));\n}\n\`\`\`').join('\n\n');
      pr.subject.members[0].description=description;
      pr.subject.members[0].headSha=head;
      const items=[pr,...Array.from({length:999},(_,i)=>{
        const item=structuredClone(pr);
        item.subject.id='synthetic-'+i;
        item.subject.members=item.subject.members.map((m,j)=>({...m,title:'Synthetic PR '+i,description:'Synthetic description '+i,number:10000+i+j,url:'https://github.com/fixture/perf/pull/'+(10000+i+j)}));
        item.subject.title='Synthetic PR '+i;
        item.attention=i<300?'updated':i<700?'requested':'other';
        return item;
      })];
      window.electronAPI.workbenchQueue=async()=>({...await originalQueue(),items});
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("!!document.querySelector('[data-queue-total=\"1000\"]')");
    await wait("document.querySelectorAll('.queue-item').length>5");
    await sleep(500);
    // Long lists render only the rows near the viewport (#346).
    assert.ok((await js<number>("document.querySelectorAll('.queue-item').length")) < 40, 'The 1,000-row queue mounts only nearby rows');

    // ── Queue: j/k ────────────────────────────────────────────────
    await js("document.querySelectorAll('.queue-row-main')[1].click()");
    await sleep(200);
    const focused = "document.activeElement?.closest('[data-queue-id]')?.dataset.queueId";
    for (let i = 0; i < 12; i++) {
      const before = await js<string>(focused);
      const direction = i % 4 === 3 ? 'k' : 'j';
      await measure('queue j/k', () => key(direction), `${focused}&&${focused}!==${JSON.stringify(before)}`);
    }

    // ── Queue: filter ─────────────────────────────────────────────
    await mouse(`document.querySelector('[aria-label="Search PRs and stacks"]')`);
    await wait(`document.activeElement?.getAttribute('aria-label')==='Search PRs and stacks'`);
    let typed = '';
    for (const ch of 'synthetic pr 99') {
      typed += ch;
      await measure(
        'queue filter keystroke',
        () => key(ch === ' ' ? 'Space' : ch, true),
        `document.querySelector('[aria-label="Search PRs and stacks"]').value===${JSON.stringify(typed)}`
      );
    }
    await wait("document.querySelectorAll('.queue-item').length>0&&document.querySelectorAll('.queue-item').length<20");
    for (let i = 0; i < typed.length; i++) key('Backspace', false);
    await wait(`document.querySelector('[aria-label="Search PRs and stacks"]').value===''`);
    await wait("document.querySelectorAll('.queue-item').length>5");
    await sleep(300);

    // ── Open the PR ───────────────────────────────────────────────
    // The PR sorts somewhere in the 1,000 rows; find it with the search box, as a reviewer would.
    await js(`(()=>{const e=document.querySelector('[aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Fix reconnect');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait("document.querySelectorAll('.queue-item').length===1");
    for (let i = 0; i < 3; i++) {
      if (i) {
        key('Escape');
        await wait("!document.querySelector('.pr-summary-page')&&document.querySelectorAll('.queue-item').length===1");
        await sleep(500);
      }
      await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
      await sleep(300);
      await measure(
        'open PR',
        () => mouse("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open PR overview')"),
        "!!document.querySelector('.pr-summary-page')&&!!document.querySelector('.pr-description')"
      );
      await sleep(800);
    }

    // ── Tabs ──────────────────────────────────────────────────────
    const selected = (label: string) => `${tab(label)}?.getAttribute('aria-selected')==='true'`;
    for (let round = 0; round < 2; round++)
      for (const label of ['Changes', 'Checks', 'Feedback', 'Summary']) {
        const first = round === 0 && label !== 'Summary' ? ' (first)' : '';
        await measure(`tab ${label}${first}`, () => mouse(tab(label)), selected(label));
        if (label === 'Changes' && round === 0) {
          await wait("window.deepAll('[role=treeitem]').length>10");
          await sleep(800);
        }
        if (label === 'Feedback' && round === 0) {
          await wait("document.querySelectorAll('.feedback-entry').length>2");
          await sleep(500);
        }
      }

    // ── Feedback: move through the timeline ──────────────────────
    await mouse(tab('Feedback'));
    await wait("document.querySelectorAll('.feedback-entry').length>2");
    const feedbackRows = await js<number>("document.querySelectorAll('.feedback-entry').length");
    assert.ok(feedbackRows < 60, `Feedback with 440 conversations mounts only nearby rows: ${feedbackRows}`);
    for (let i = 0; i < 4; i++) {
      const at = await js<string>("document.querySelector('.feedback-position').textContent");
      await measure(
        'feedback next item',
        () => mouse("document.querySelector('[aria-label=\"Next item\"]')"),
        `document.querySelector('.feedback-position').textContent!==${JSON.stringify('')}+${JSON.stringify(at)}&&!!document.querySelector('.feedback-entry[aria-current=true]')`
      );
    }

    // ── Changes: open the large file from the tree, collapse and expand it ──
    await mouse(tab('Changes'));
    await wait(selected('Changes'));
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='huge.ts')");
    const lists = await js<{ tree: number; files: number }>(
      "({tree:window.deepAll('[role=treeitem]').length,files:document.querySelectorAll('.commit-stream-row').length})"
    );
    console.log('Mounted rows of long lists:', JSON.stringify({ feedback: feedbackRows, ...lists }));
    assert.ok(lists.tree < 120, `The 600-file tree mounts only nearby rows: ${lists.tree}`);
    assert.ok(lists.files < 20, `The 600-file diff stream mounts only nearby files: ${lists.files}`);
    const hugeRow = `document.querySelector('.commit-stream-row[data-file="src/a-generated/huge.ts"]')`;
    await measure(
      'tree: open large file',
      () => mouse("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='huge.ts')"),
      `!!${hugeRow}?.querySelector('diffs-container')`
    );
    await wait(`(${hugeRow}?.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length??0)>50`);
    await sleep(500);
    const viewedBox = `${hugeRow}.querySelector('.changes-file-header input[type=checkbox]')`;
    for (let i = 0; i < 2; i++) {
      await mouse(viewedBox);
      await wait(`${hugeRow}.querySelector('.commit-stream-file-body')?.hidden===true`);
      await sleep(400);
      await measure('expand large file', () => mouse(viewedBox), `${hugeRow}.querySelector('.commit-stream-file-body')?.hidden===false`);
      await sleep(400);
    }

    // ── Tabs: leave Changes while the 3,000-line file shows, and come back (#352) ──
    const hugeLines = `(${hugeRow}?.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length??0)>50`;
    for (let i = 0; i < 6; i++) {
      const label = i % 2 ? 'Summary' : 'Checks';
      await measure('tab away from large diff', () => mouse(tab(label)), `${selected(label)}&&!${hugeRow}.checkVisibility()`);
      await sleep(400);
      await measure('tab back to large diff', () => mouse(tab('Changes')), `${selected('Changes')}&&${hugeLines}&&${hugeRow}.checkVisibility()`);
      await sleep(600);
    }

    // ── Changes: type a comment on a line ─────────────────────────
    const smallRow = `document.querySelector('.commit-stream-row[data-file="src/area0/module0.ts"]')`;
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='module0.ts').click()");
    await wait(`!!${smallRow}?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line-type="change-addition"] [data-column-number], [data-column-number][data-line-type="change-addition"]')`);
    await js(`(()=>{const root=${smallRow}.querySelector('diffs-container').shadowRoot;
      const number=root.querySelector('[data-column-number][data-line-type="change-addition"]')??root.querySelector('[data-line-type="change-addition"] [data-column-number]');
      number.click()})()`);
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    await js("document.querySelector('.changes-comment-composer textarea').focus()");
    let comment = '';
    for (const ch of 'keep the slot when cancel') {
      comment += ch;
      await measure(
        'comment keystroke',
        () => key(ch === ' ' ? 'Space' : ch, true),
        `document.querySelector('.changes-comment-composer textarea').value===${JSON.stringify(comment)}`
      );
    }

    // ── Changes: "Viewed & next" from the keyboard, file after file ──
    // Each press marks the file viewed and moves to the next one, whose button takes focus. The next press comes
    // 250 ms later, so it meets any work the previous one left behind.
    const viewedNext = "[...document.querySelectorAll('.commit-stream-row [data-viewed-next]')].find(b=>b.checkVisibility())";
    await wait(`!!${viewedNext}`);
    await js(`${viewedNext}.focus()`);
    for (let i = 0; i < 8; i++) {
      if (!(await js<boolean>("!!document.activeElement?.matches('[data-viewed-next]')"))) await js(`${viewedNext}?.focus()`);
      await measure('viewed next key', () => key('Enter', true), 'true');
      await sleep(250);
    }

    // ── Diagnostics export carries the ring buffer ────────────────
    await js(`(async()=>{const {collectRendererDiagnostics}=await import('/lib/diagnostics.ts');await window.electronAPI.exportDiagnostics(await collectRendererDiagnostics())})()`);
    const exported = await js<{ interactions: Interaction[]; monitor: { threshold: number } }>('window.exportedDiagnostics');
    assert.ok(exported.interactions.length >= 20, `The export includes recorded interactions: ${exported.interactions.length}`);
    assert.ok(
      exported.interactions.every((e) => typeof e.target === 'string' && e.duration >= 16 && e.inputDelay + e.processing <= e.duration + 8),
      'Exported interactions carry a target and a consistent split'
    );
    }

    const background = await backgroundSync();
    const summary = report();
    if (profiling) await profileSources();
    const over = summary.filter((s) => s.budget && s.checked > s.budget);
    assert.deepEqual(
      over.map((s) => `${s.name}: ${s.checked} ms > ${s.budget} ms`),
      [],
      'Interactions stay within budget'
    );
    // Relative to the same inputs without sync, so a slower machine does not fail it; scaled like the budgets.
    const allowed = scaledBudget(BACKGROUND_INPUT_DELAY_P90);
    assert.ok(
      background.p90 - background.idleP90 <= allowed,
      `Input delay under background sync stays within ${allowed} ms of the same inputs without it at p90: ${background.p90} ms against ${background.idleP90} ms`
    );
    for (const [moment, count] of Object.entries(background.counts))
      assert.ok(count.receivers < 3, `github-sync listeners stay bounded (${moment}): ${count.receivers} for ${count.watches} watches`);
    assert.ok(
      background.counts['tabs closed again'].watches <= background.counts['tabs closed'].watches,
      `Closed tabs leave no watches behind: ${JSON.stringify(background.counts)}`
    );
    // Opening and closing five tabs again must not keep their pages: the heap returns to about where it was.
    assert.ok(
      background.counts['tabs closed 5'].heapMB - background.counts['tabs closed'].heapMB < 8,
      `Closed tabs release their memory: ${JSON.stringify(background.counts)}`
    );
    // Before the PrSummary eviction timer was moved out of the component, each cycle kept about 4,700 detached
    // elements and 10 MB for a minute.
    assert.ok(
      background.counts['tabs closed 5'].elements - background.counts['tabs closed'].elements < 500,
      `Closed tabs leave no detached DOM behind: ${JSON.stringify(background.counts)}`
    );
    assert.deepEqual(errors, [], 'No renderer errors');
    console.log('Interaction performance checks passed');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    report();
    if (profiling) await profileSources().catch(() => {});
    win.destroy();
    app.exit(1);
  }
});
