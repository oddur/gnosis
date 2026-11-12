#!/usr/bin/env node
// Measures window-resize cost in a running Gnosis renderer over the Chrome DevTools Protocol.
//
// Start the app with a remote debugging port, then for example:
//   node scripts/measure-resize.mjs --port 9344 --review <id> --scroll section:9 --runs 3 --label step-1
//
// One step changes the emulated viewport width and waits two animation frames, so resize observers,
// style, layout and paint all run. Waiting two frames puts a floor of one to two frame intervals (about
// 17-33 ms at 60 Hz) under the step time, so `work` also reports the main thread's busy time per step
// (TaskDuration). A step whose work fits in one frame reads about 33 ms or less. The sweep goes from --from down by --delta in --step increments and back.
// Options:
//   --port <n>          remote debugging port (default 9222)
//   --label <text>      label printed with each result
//   --review <id>       open this saved review first (through the renderer's command navigation)
//   --view <name>       select a review tab first: explanation, changes or summary
//   --scroll <where>    top | section:<n> (Explanation only) | px:<n> (largest scroll container).
//                       A comma list visits each place in order, e.g. section:10,section:9 mounts both sections.
//   --into <px>         extra scroll into the section for --scroll section:<n> (default 4000)
//   --from <px>         sweep start width (default: current width)
//   --height <px>       emulated height (default: current height)
//   --delta <px>        sweep depth (default 600)
//   --step <px>         step size (default 40)
//   --runs <n>          repeat the sweep and report the median of each metric (default 1)
//   --reload            reload the renderer before each run, for a clean mount state
//   --settle <ms>       wait after navigation and scrolling (default 4000)
//   --profile           print the top self-time functions from a CPU profile of the last run
//   --json              print one JSON object instead of text
/* global console, fetch, WebSocket */
import process from 'node:process';
import { setTimeout } from 'node:timers';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const port = option('port', '9222');
const label = option('label', 'run');
const review = option('review');
const view = option('view');
const scroll = option('scroll');
const into = Number(option('into', '4000'));
const runs = Math.max(1, Number(option('runs', '1')));
const settle = Number(option('settle', '4000'));
const json = flag('json');
const log = (...values) => {
  if (!json) console.log(...values);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error(`No page target on port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let id = 0;
const pending = new Map();
const events = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method) events.get(message.method)?.(message.params);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (message) =>
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)
    );
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
  return result.result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metrics = async () =>
  Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

const navigateExpression = (reviewId) => `(async () => {
  const shell = document.querySelector('.workspace-shell');
  if (!shell) return 'no workspace';
  const key = Object.keys(shell).find((k) => k.startsWith('__reactFiber$'));
  let fiber = shell[key];
  while (fiber && !(fiber.memoizedProps && typeof fiber.memoizedProps.navigate === 'function' && fiber.memoizedProps.commands)) fiber = fiber.return;
  if (!fiber) return 'no navigate';
  await fiber.memoizedProps.navigate({ kind: 'review', reviewId: ${JSON.stringify(reviewId)} });
  return 'ok';
})()`;
const selectView = (name) => `(() => {
  const label = ${JSON.stringify(name)}.toLowerCase();
  const tab = [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim().toLowerCase() === label);
  if (!tab) return 'missing';
  tab.click();
  return 'ok';
})()`;
const scrollExpression = (where, offset = into) => `(() => {
  const where = ${JSON.stringify(where)};
  const largest = () => [...document.querySelectorAll('*')].filter((e) => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (where === 'top') { const s = document.querySelector('.explanation-document') ?? largest(); if (s) s.scrollTop = 0; return s ? s.scrollTop : -1; }
  if (where.startsWith('px:')) { const s = largest(); if (s) s.scrollTop = Number(where.slice(3)); return s ? s.scrollTop : -1; }
  const index = Number(where.split(':')[1]);
  const container = document.querySelector('.explanation-document');
  const target = container?.querySelector('[data-explanation-section="' + index + '"]');
  if (!container || !target) return -1;
  container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top + ${offset};
  return container.scrollTop;
})()`;
const describe = `(() => {
  const sections = [...document.querySelectorAll('.explanation-section')];
  return {
    w: innerWidth,
    h: innerHeight,
    sections: sections.length,
    tallest: Math.max(0, ...sections.map((s) => s.offsetHeight)),
    nodes: document.getElementsByTagName('*').length,
    svgs: document.querySelectorAll('svg').length,
    diffHosts: document.querySelectorAll('diffs-container').length,
    scrollTop: Math.round(document.querySelector('.explanation-document')?.scrollTop ?? -1),
  };
})()`;

const frame = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))';
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function prepare() {
  if (flag('reload')) {
    await send('Page.enable');
    const loaded = new Promise((resolve) => events.set('Page.loadEventFired', resolve));
    await send('Page.reload', { ignoreCache: false });
    await loaded;
    events.delete('Page.loadEventFired');
    for (let i = 0; i < 120 && !(await evaluate('!!document.querySelector(".workspace-shell")')); i++) await wait(250);
    await wait(1500);
  }
  if (review) {
    const result = await evaluate(navigateExpression(review));
    if (result !== 'ok') throw new Error(`navigation: ${result}`);
    await wait(settle);
  }
  if (view) {
    const result = await evaluate(selectView(view));
    if (result !== 'ok') throw new Error(`view ${view}: ${result}`);
    await wait(settle);
  }
}

async function sweep(withProfile) {
  const current = await evaluate('({ w: innerWidth, h: innerHeight })');
  const from = Number(option('from', String(current.w)));
  const height = Number(option('height', String(current.h)));
  const delta = Number(option('delta', '600'));
  const step = Number(option('step', '40'));
  const widths = [];
  for (let w = from; w >= from - delta; w -= step) widths.push(w);
  for (let w = from - delta; w <= from; w += step) widths.push(w);
  try {
    // Settle at the start size before measuring, so the first step is not a jump from the real window size.
    await send('Emulation.setDeviceMetricsOverride', { width: from, height, deviceScaleFactor: 0, mobile: false });
    await evaluate(frame);
    // Visit each place in order. Visiting mounts lazy code, so the last place is applied again once settled.
    const places = scroll ? scroll.split(',') : [];
    for (const place of places) {
      // Reach the section's top first so its lazy code mounts, then move into it.
      if (place.startsWith('section:')) {
        await evaluate(scrollExpression(place, 0));
        await wait(settle);
      }
      await evaluate(scrollExpression(place));
      await wait(settle);
    }
    if (places.length) {
      await evaluate(scrollExpression(places[places.length - 1]));
      await wait(1000);
    }
    const shape = await evaluate(describe);
    if (withProfile) {
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: 200 });
      await send('Profiler.start');
    }
    const before = await metrics();
    const steps = [];
    let previous = before;
    for (const width of widths) {
      const t0 = await evaluate('performance.now()');
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
      const t1 = await evaluate(frame);
      const sample = await metrics();
      steps.push({
        width,
        ms: t1 - t0,
        layouts: (sample.LayoutCount ?? 0) - (previous.LayoutCount ?? 0),
        styles: (sample.RecalcStyleCount ?? 0) - (previous.RecalcStyleCount ?? 0),
        // Main-thread busy time, including this script's own small evaluate tasks.
        work: ((sample.TaskDuration ?? 0) - (previous.TaskDuration ?? 0)) * 1000,
      });
      previous = sample;
    }
    const after = previous;
    const profile = withProfile ? (await send('Profiler.stop')).profile : undefined;
    const d = (k) => ((after[k] ?? 0) - (before[k] ?? 0)) * 1000;
    const times = steps.map((s) => s.ms).sort((a, b) => a - b);
    const work = steps.map((s) => s.work).sort((a, b) => a - b);
    return {
      shape,
      steps: steps.length,
      p50: percentile(times, 0.5),
      p90: percentile(times, 0.9),
      max: times[times.length - 1],
      workP50: percentile(work, 0.5),
      workP90: percentile(work, 0.9),
      workMax: work[work.length - 1],
      layout: d('LayoutDuration'),
      style: d('RecalcStyleDuration'),
      script: d('ScriptDuration'),
      layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
      styleRecalcs: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
      maxLayoutsPerStep: Math.max(...steps.map((s) => s.layouts)),
      maxStylesPerStep: Math.max(...steps.map((s) => s.styles)),
      profile,
    };
  } finally {
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
}

function topSelfTime(profile, count = 18) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((sample, i) => {
    const f = byId.get(sample).callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-1)[0].split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, count);
}

const fmt = (r) =>
  `p50=${r.p50.toFixed(0)} p90=${r.p90.toFixed(0)} max=${r.max.toFixed(0)} work p50=${r.workP50.toFixed(1)} p90=${r.workP90.toFixed(1)} max=${r.workMax.toFixed(1)} layout=${r.layout.toFixed(0)}ms style=${r.style.toFixed(0)}ms script=${r.script.toFixed(0)}ms layouts=${r.layouts} styleRecalcs=${r.styleRecalcs} (max/step ${r.maxLayoutsPerStep}/${r.maxStylesPerStep})`;
const results = [];
try {
  await send('Performance.enable');
  for (let run = 0; run < runs; run++) {
    if (run === 0 || flag('reload')) await prepare();
    const result = await sweep(flag('profile') && run === runs - 1);
    results.push(result);
    log(`[${label}] run ${run + 1}/${runs} page=${JSON.stringify(result.shape)}`);
    log(`[${label}] run ${run + 1}/${runs} steps=${result.steps} ${fmt(result)}`);
  }
  const keys = [
    'p50',
    'p90',
    'max',
    'workP50',
    'workP90',
    'workMax',
    'layout',
    'style',
    'script',
    'layouts',
    'styleRecalcs',
    'maxLayoutsPerStep',
    'maxStylesPerStep',
  ];
  const summary = Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k]))]));
  const last = results[results.length - 1];
  if (json) {
    console.log(
      JSON.stringify({
        label,
        runs,
        shape: last.shape,
        median: summary,
        runsDetail: results.map((r) => ({ ...r, profile: undefined })),
      })
    );
  } else {
    console.log(`[${label}] median of ${runs}: ${fmt(summary)}`);
    if (last.profile) {
      console.log(`[${label}] top self time (ms):`);
      for (const [k, v] of topSelfTime(last.profile)) console.log(`  ${v.toFixed(1).padStart(8)}  ${k}`);
    }
  }
} finally {
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  ws.close();
}
