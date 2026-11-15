import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

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
 */

/** Budgets in milliseconds of Event Timing duration (input to next paint, rounded to 8 ms by the browser), for the
 * slowest sample of each interaction, or the 90th percentile of repeated ones. The fixture runs React in development
 * mode under Xvfb, so these are well above what the packaged app shows; they hold in Docker with headroom. Before
 * #346, returning to Changes took 900-1,100 ms and Checks 300-360 ms; see the numbers this suite prints. */
const budgets: Record<string, number> = {
  'open PR': 300,
  'tab Summary': 200,
  'tab Changes (first)': 650,
  // Showing kept Changes again re-runs the diffs' effects, which rebuild the large file; see the report in #346.
  'tab Changes': 600,
  'tab Checks (first)': 350,
  'tab Checks': 300,
  'tab Feedback (first)': 200,
  'tab Feedback': 150,
  'queue j/k': 200,
  'queue filter keystroke': 200,
  'tree: open large file': 250,
  // Layout and style of 3,000 newly shown lines; see the report in #346.
  'expand large file': 450,
  // About 75 ms of it is one style recalculation per keystroke; see the report in #346.
  'comment keystroke': 150,
  'feedback row': 120,
};

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
  const point = (expression: string) =>
    js<{ x: number; y: number }>(`(()=>{const e=${expression};if(!e)throw Error('Missing target');
      e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
      return {x:Math.round(r.left+Math.min(r.width/2,40)),y:Math.round(r.top+r.height/2)}})()`);
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
  const measure = async (name: string, act: () => Promise<void> | void, done: string) => {
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
    const since = await js<number>('performance.timeOrigin+performance.now()');
    await act();
    await wait(done);
    await js(frames);
    // Event entries arrive after the frame that painted them; the monitor then waits for frame attribution.
    await sleep(160);
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
        checked: durations.length >= 10 ? durations[Math.ceil(durations.length * 0.9) - 1] : durations[durations.length - 1],
        budget: budgets[name],
        worst,
      };
    });
    console.log('Interaction latency (ms, input to next paint):');
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
      b.addEventListener('click',function busyProbe(){const end=performance.now()+180;while(performance.now()<end);});
      document.body.append(b)})()`);
    const probe = await measure('probe', () => mouse("document.querySelector('.perf-probe')"), 'true');
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
      const changes=window.electronAPI.getPrChanges;
      window.electronAPI.getPrChanges=async(url,...rest)=>{const s=await changes(url,...rest);return url===prUrl?{...s,files}:s};
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
      const data={headSha:'head-0',baseSha:'base-0',checkedAt:Date.now(),threads,feedback};
      const cached=window.electronAPI.getCachedReviewThreads,threadsRead=window.electronAPI.getReviewThreads;
      window.electronAPI.getCachedReviewThreads=async(url,...rest)=>url===prUrl?structuredClone(data):cached?.(url,...rest);
      window.electronAPI.getReviewThreads=async(url,...rest)=>url===prUrl?structuredClone(data):threadsRead(url,...rest);
      // A 1,000-row queue. The real PR stays first; the rest are copies with their own URLs.
      const originalQueue=window.electronAPI.workbenchQueue;
      const original=await originalQueue();
      const pr=original.items.find(i=>i.subject.title?.includes('Fix reconnect')||i.subject.members[0].title.includes('Fix reconnect'));
      const description=Array.from({length:60},(_,n)=>'## Section '+n+'\n\nThis change keeps **pending commands** ordered when the worker restarts. It touches \`queue.ts\`, \`dispatch.ts\` and the [scheduler](https://example.com/s'+n+').\n\n| Case | Before | After |\n| --- | --- | --- |\n| Retry | lost | kept |\n| Cancel | leaked | released |\n\n\`\`\`ts\nexport function dispatch'+n+'(command: Command) {\n  return queue.acquire().then(slot => run(command).finally(() => slot.release()));\n}\n\`\`\`').join('\n\n');
      pr.subject.members[0].description=description;
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
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await sleep(300);
    await measure(
      'open PR',
      () => mouse("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open PR overview')"),
      "!!document.querySelector('.pr-summary-page')&&!!document.querySelector('.pr-description')"
    );
    await sleep(800);

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
          await wait("document.querySelectorAll('.feedback-row').length>5");
          await sleep(500);
        }
      }

    // ── Feedback: open conversations ──────────────────────────────
    await mouse(tab('Feedback'));
    await wait("document.querySelectorAll('.feedback-row').length>5");
    const feedbackRows = await js<number>("document.querySelectorAll('.feedback-row').length");
    assert.ok(feedbackRows < 60, `Feedback with 440 conversations mounts only nearby rows: ${feedbackRows}`);
    for (let i = 0; i < 4; i++) {
      const row = `document.querySelectorAll('.feedback-row')[${i + 1}]`;
      const id = await js<string>(`${row}.dataset.feedbackId`);
      await measure(
        'feedback row',
        () => mouse(row),
        `document.querySelector('.feedback-row[aria-current=true]')?.dataset.feedbackId===${JSON.stringify(id)}&&!!document.querySelector('.feedback-conversation')`
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

    // ── Diagnostics export carries the ring buffer ────────────────
    await js(`(async()=>{const {collectRendererDiagnostics}=await import('/lib/diagnostics.ts');await window.electronAPI.exportDiagnostics(await collectRendererDiagnostics())})()`);
    const exported = await js<{ interactions: Interaction[]; monitor: { threshold: number } }>('window.exportedDiagnostics');
    assert.ok(exported.interactions.length >= 20, `The export includes recorded interactions: ${exported.interactions.length}`);
    assert.ok(
      exported.interactions.every((e) => typeof e.target === 'string' && e.duration >= 16 && e.inputDelay + e.processing <= e.duration + 8),
      'Exported interactions carry a target and a consistent split'
    );

    const summary = report();
    if (profiling) await profileSources();
    const over = summary.filter((s) => s.budget && s.checked > s.budget);
    assert.deepEqual(
      over.map((s) => `${s.name}: ${s.checked} ms > ${s.budget} ms`),
      [],
      'Interactions stay within budget'
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
