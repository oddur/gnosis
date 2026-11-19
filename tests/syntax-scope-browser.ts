import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Enclosing definitions in Changes (#393), on the synthetic files in tests/fixtures/syntax-scope.ts.
 *
 * - Each hunk's bar is a breadcrumb of the file and the definitions around the hunk, in TypeScript and Rust; deleted
 *   lines use the old file's tree. The whole chain shows while it fits, and folds from the outside when not; the whole
 *   chain is the tooltip and the accessible label. A crumb reveals its definition.
 * - "Show whole function" reveals the definition; past 150 lines it shows the signature only.
 * - Short definitions open whole by default, and the line at the top of the view stays where it is when they do.
 * - A file without a grammar is unchanged.
 * - Parsing runs in the worker: a 3,000-line file's parse leaves no long task on the main thread.
 * - Contents nothing prepared (`?syntax-lazy`, 165 files): a file that comes into view loads its after side once, and
 *   both sides when its hunk only deletes; at most two reads run at once; files that flash past are not read. Then
 *   prefetch reads every other file once, in diff order, pausing while the reader scrolls, so a file never scrolled
 *   to has its breadcrumb when it shows. Revisits read nothing again.
 * - Turning a language off in Settings removes its breadcrumbs, and nothing in it is parsed.
 * - Pinned hunk headers (#395), in the PR's Changes and in the stack's: scrolled into the middle of a long hunk, its
 *   header sits right under the file header with its breadcrumb, and hides its expand controls; the next hunk's header
 *   replaces it; a line scrolled to lands below both headers; a file with no grammar pins its hunks' line ranges. At a
 *   narrow width the file header wraps taller and the hunk header still sits right under it.
 * - Pinned crumbs (#417) are buttons: a click, Enter or Space scrolls the definition's first line right under the pinned
 *   headers, or, hidden in a gap, its gap's bar into the pinned place, revealing nothing; deleted lines use the old
 *   file's definitions; a sliced hunk's far slice lands as exactly. Tab reaches them, focus stays on them, and the
 *   header keeps its height.
 */
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
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  // GNOSIS_SYNTAX_SCOPE_SHOT=1 prints PNGs of the scope file as base64 lines, since Docker keeps no files.
  const shot = async (name: string, selector: string) => {
    if (!process.env.GNOSIS_SYNTAX_SCOPE_SHOT) return;
    await js(frames);
    await sleep(300);
    const r = await js<{ x: number; y: number; width: number; height: number }>(
      `(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,Math.round(b.left)),y:Math.max(0,Math.round(b.top)),width:Math.round(Math.min(b.width,innerWidth-b.left)),height:Math.round(Math.min(b.height,innerHeight-Math.max(0,b.top)))}})()`
    );
    for (const dark of [true, false]) {
      await js(`document.documentElement.classList.toggle('dark',${dark})`);
      await js(frames);
      await sleep(200);
      console.log(
        `SHOT ${name}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`
      );
    }
  };
  const PATHS = ['src/scope.ts', 'src/store.rs', 'src/notes.rb', 'src/large.ts'];
  // Each hunk header of a file in the stream, relative to its file header's bottom edge, and whether it is pinned.
  const installSticky = () =>
    js(`window.stream=()=>document.querySelector('.commit-diff-stream');
      // Rows of a stack's files carry their PR in the key: the selected row ending in the path.
      window.stickyRow=p=>{const rows=[...document.querySelectorAll('.commit-stream-row')].filter(r=>r.dataset.file===p||r.dataset.file?.endsWith(p));return rows.find(r=>r.dataset.active==='true')??rows[0]};
      window.headerLabel=h=>h.querySelector('.diff-gap-symbol')?[...h.querySelectorAll('.diff-gap-symbol .diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '):h.querySelector('.diff-gap-range > [aria-hidden]')?.textContent.trim();
      window.headers=p=>{const row=window.stickyRow(p);const file=row.querySelector('.changes-file-header').getBoundingClientRect();
        return [...row.querySelectorAll('.diff-hunk')].map(section=>{const h=section.querySelector(':scope > [data-hunk-header]');if(!h)return null;const r=h.getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+12,r.top+r.height/2);
          return {offset:Math.round(r.top-file.bottom),fileTop:Math.round(file.top-window.stream().getBoundingClientRect().top),height:Math.round(r.height),stuck:h.hasAttribute('data-stuck'),label:window.headerLabel(h),
            onTop:!!hit&&h.contains(hit),controls:[...h.querySelectorAll(':is(.diff-gap-gutter,.diff-gap-act,.diff-gap-controls) > button')].map(b=>getComputedStyle(b).opacity)}})};
      window.toMiddle=(p,i)=>{const s=window.stream();const section=window.stickyRow(p).querySelectorAll('.diff-hunk')[i];const r=section.getBoundingClientRect();
        s.scrollTop+=r.top-s.getBoundingClientRect().top+r.height/2};
      void 0;`);
  const settle = async () => {
    await js(frames);
    await sleep(150);
    await js(frames);
  };
  type Header = { offset: number; fileTop: number; height: number; stuck: boolean; label?: string; onTop: boolean; controls: string[] };
  const headers = (path: string) => js<(Header | null)[]>(`window.headers(${JSON.stringify(path)})`);
  /** Scrolls into the middle of each long hunk of `path` in turn and checks its header is pinned right under the file
   * header, with `labels[i]`, and that every other header is not. */
  const checkPinned = async (surface: string, path: string, labels: string[]) => {
    for (const [index, label] of labels.entries()) {
      await js(`window.toMiddle(${JSON.stringify(path)},${index})`);
      await settle();
      const all = await headers(path);
      const header = all[index]!;
      assert.equal(header.label, label, `${surface}: hunk ${index + 1} of ${path} keeps its header: ${JSON.stringify(all)}`);
      assert.ok(header.stuck, `${surface}: the header is marked pinned: ${JSON.stringify(header)}`);
      assert.ok(Math.abs(header.offset + 1) <= 1, `${surface}: it sits right under the file header: ${JSON.stringify(header)}`);
      assert.ok(Math.abs(header.fileTop) <= 1, `${surface}: the file header is at the top: ${JSON.stringify(header)}`);
      assert.ok(header.onTop, `${surface}: nothing covers the pinned header`);
      assert.ok(header.controls.every((v) => v === '0'), `${surface}: a pinned header hides its expand controls: ${header.controls}`);
      for (const [other, value] of all.entries())
        if (value && other !== index) assert.ok(!value.stuck, `${surface}: only the hunk on screen pins its header (${other}: ${JSON.stringify(value)})`);
    }
  };
  /**
   * Hunk header review: with GNOSIS_HUNK_HEADER_SHOTS=1, renders hunk headers at 1280 and 760 px in light and dark as
   * `HHSHOT <name> <base64 PNG>` lines, with what each breadcrumb folded as `HHINFO`, and skips the checks.
   */
  const hunkHeaderShots = async () => {
    const capture = async (name: string, rect: string) => {
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js(frames);
        await sleep(250);
        const r = await js<{ x: number; y: number; width: number; height: number }>(rect);
        console.log(`HHSHOT ${name}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
      }
    };
    const around = (selector: string, above = 70, below = 70) =>
      `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const y=Math.max(Math.round(s.top),Math.round(b.top-${above}));return {x:Math.round(s.left),y,width:Math.round(s.width),height:Math.round(Math.min(b.bottom+${below},s.bottom)-y)}})()`;
    const streamTop = (height: number) =>
      `(()=>{const b=document.querySelector('.commit-diff-stream').getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:${height}}})()`;
    const select = async (name: string) => {
      await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
      await sleep(1700);
    };
    const toTop = (selector: string, offset: number) =>
      js(`(()=>{const s=document.querySelector('.commit-diff-stream');const b=document.querySelector(${JSON.stringify(selector)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-${offset}})()`);
    const folded = (selector: string) =>
      js(`(()=>{const s=document.querySelector(${JSON.stringify(selector)}+' .diff-gap-symbol');return {chain:[...s.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent).join(' › '),folded:[...s.querySelectorAll(':scope > [data-collapsed]')].map(g=>g.textContent.replace('›','').trim()),right:s.closest('.diff-gap').querySelector('.diff-gap-controls').textContent+' | '+s.closest('.diff-gap').querySelector('.diff-gap-end')?.textContent}})()`);
    win.setContentSize(1280, 800);
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`);
    await installSticky();
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='Navmesh.cs')");
    const navmesh = '.commit-stream-row[data-file="src/Navmesh.cs"] [data-hunk-header]';
    const store = '.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-gap]:has(.diff-gap-gutter button):has([data-show-definition])';
    for (const [width, label] of [[1280, '1280'], [760, '760']] as const) {
      win.setContentSize(width, 800);
      await sleep(400);
      // A long C# chain: whole where it fits, folded from the outside where it does not.
      await select('Navmesh.cs');
      await toTop(navmesh, 120);
      await settle();
      console.log(`HHINFO navmesh ${label}: ${JSON.stringify(await folded(navmesh))}`);
      await capture(`chain-${label}`, around(navmesh));
      // The right side, and Show whole function after the breadcrumb.
      await select('store.rs');
      await wait(`!!document.querySelector(${JSON.stringify(store)})`);
      await toTop(store, 120);
      await settle();
      console.log(`HHINFO store ${label}: ${JSON.stringify(await folded(store))}`);
      await capture(`controls-${label}`, around(store));
      // Pinned mid-hunk.
      await select('sticky.ts');
      await js(`window.toMiddle('src/sticky.ts',1)`);
      await settle();
      await capture(`pinned-${label}`, streamTop(230));
    }
    await js(`document.documentElement.classList.toggle('dark',false)`);
  };
  /**
   * File header review: with GNOSIS_FILE_HEADER_SHOTS=1, renders the sticky file header's cases in light and dark as
   * `FHSHOT <name> <base64 PNG>` lines, and its colours as `FHMETRIC <json>`, and skips the checks.
   */
  const fileHeaderShots = async () => {
    const capture = async (name: string, rect: string) => {
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js(frames);
        await sleep(250);
        const r = await js<{ x: number; y: number; width: number; height: number }>(rect);
        console.log(`FHSHOT ${name}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
      }
    };
    const streamTop = (height: number) =>
      `(()=>{const b=document.querySelector('.commit-diff-stream').getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:${height}}})()`;
    const around = (selector: string, above = 80, below = 80) =>
      `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const y=Math.max(Math.round(s.top),Math.round(b.top-${above}));return {x:Math.round(s.left),y,width:Math.round(s.width),height:Math.round(Math.min(b.bottom+${below},s.bottom)-y)}})()`;
    const toTop = (selector: string, offset = 140) =>
      js(`(()=>{const s=document.querySelector('.commit-diff-stream');const b=document.querySelector(${JSON.stringify(selector)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-${offset}})()`);
    const select = async (name: string) => {
      await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
      await sleep(1700);
    };
    const open = async (query: string) => {
      win.setContentSize(1280, 800);
      await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?${query}`);
      await waitForWorkbenchQueue(win.webContents);
      await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`);
      await installSticky();
    };
    // Colours and target sizes, read as sRGB through a canvas.
    const measure = (label: string) =>
      js<Record<string, unknown>>(`(()=>{const c=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const rgb=v=>{if(!v)return null;c.clearRect(0,0,1,1);c.fillStyle='#000';c.fillStyle=v;c.fillRect(0,0,1,1);const d=c.getImageData(0,0,1,1).data;return '#'+[d[0],d[1],d[2]].map(n=>n.toString(16).padStart(2,'0')).join('')};
        const q=s=>document.querySelector(s);const color=s=>q(s)?rgb(getComputedStyle(q(s)).color):null;const bg=s=>q(s)?rgb(getComputedStyle(q(s)).backgroundColor):null;
        const hit=(s,pseudo)=>{const e=q(s);if(!e)return null;const r=e.getBoundingClientRect();const a=getComputedStyle(e,'::after');
          const inset=a.content&&a.content!=='none'?parseFloat(a.top)||0:0;return {w:Math.round(r.width),h:Math.round(r.height),hitH:Math.round(r.height-2*inset),hitW:Math.round(r.width-2*(parseFloat(a.left)||0))}};
        const box=q('.changes-file-actions input[type=checkbox]');
        return {label:${JSON.stringify(label)},file:bg('.changes-file-header'),hunk:bg('.diff-gap[data-hunk-header]'),added:color('.diff-gap-added'),deleted:color('.diff-gap-deleted'),
          outline:box?rgb(getComputedStyle(q('[data-viewed-next]')).borderTopColor):null,checkbox:box?rgb(getComputedStyle(box).borderTopColor):null,
          chevron:hit('.diff-gap-gutter .diff-context-button'),crumb:hit('button.diff-gap-crumb'),viewed:hit('.changes-file-actions label'),
          viewedTop:box?Math.round(q('.changes-file-actions label').getBoundingClientRect().top-q('[data-viewed-next]').getBoundingClientRect().top):null,
          viewedMid:box?Math.round((q('.changes-file-actions label').getBoundingClientRect().top+q('.changes-file-actions label').getBoundingClientRect().bottom)/2-(q('[data-viewed-next]').getBoundingClientRect().top+q('[data-viewed-next]').getBoundingClientRect().bottom)/2):null}})()`);
    const metric = async (label: string) => console.log(`FHMETRIC ${JSON.stringify(await measure(label))}`);

    // ── Pinned mid-hunk, before and after the reader crosses into the second function ──
    await open('pr-summary&syntax-scope&syntax-span');
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='span.ts')");
    await select('span.ts');
    for (const [name, line] of [['pinned-alpha', 30], ['pinned-beta', 100]] as const) {
      await js(`(()=>{const section=window.stickyRow('src/span.ts').querySelector('.diff-hunk');
        window.deepAll('[data-line]',section).find(e=>e.dataset.line==='${line}'&&e.dataset.lineType!=='change-deletion'&&e.getBoundingClientRect().height>0).scrollIntoView({block:'start',behavior:'instant'})})()`);
      await settle();
      await sleep(150);
      await capture(name, streamTop(200));
    }
    // ── A hunk header with what it changes, and a top-level hunk ──
    await select('store.rs');
    await toTop('.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-hunk-header]:has(.diff-gap-counts)', 120);
    await settle();
    await capture('counts', around('.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-hunk-header]:has(.diff-gap-counts)', 60, 60));
    await metric('store.rs');
    await select('imports.ts');
    await toTop('.commit-stream-row[data-file="src/imports.ts"] .diff-gap[data-hunk-header]', 120);
    await settle();
    await capture('top-level', around('.commit-stream-row[data-file="src/imports.ts"] .diff-gap[data-hunk-header]', 60, 60));
    // ── A file boundary in a single PR: the trailing bar, the space, the next file ──
    const trailing = '.commit-stream-row .diff-gap[data-trailing]';
    await js(`document.querySelector(${JSON.stringify(trailing)}).closest('.commit-stream-row').setAttribute('data-shot-boundary','')`);
    await toTop(`.commit-stream-row[data-shot-boundary] .diff-gap[data-trailing]`, 260);
    await settle();
    await capture('file-boundary', around(`.commit-stream-row[data-shot-boundary] .diff-gap[data-trailing]`, 100, 160));
    // ── Keyboard focus on the Viewed checkbox ──
    await select('worker.ts');
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const r=window.stickyRow('src/worker.ts');s.scrollTop+=r.getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    await settle();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    await sleep(50);
    await js(`window.stickyRow('src/worker.ts').querySelector('.changes-file-actions input[type=checkbox]').focus({preventScroll:true})`);
    await capture('focus-viewed', streamTop(120));
    await metric('worker.ts');
    await js('document.activeElement.blur()');
    // ── Narrow, pinned, with the Ask icon ──
    win.setContentSize(760, 800);
    await sleep(400);
    await select('sticky.ts');
    await js(`window.toMiddle('src/sticky.ts',1)`);
    await settle();
    await capture('narrow-pinned', streamTop(220));
    // ── A stack's combined view: each file names the PRs that changed it, with their commits ──
    await open('pr-summary&syntax-scope');
    // The fixture has no combined comparison: this one is store.rs from the root PR, and worker.ts from every PR.
    await js(`(()=>{const source=window.electronAPI.getPrChanges;
      window.electronAPI.getStackChanges=async(subject)=>{const snapshots=await Promise.all(subject.members.map(m=>source(m.url)));const root=snapshots[0],tip=snapshots.at(-1);
        const files=root.files.filter(f=>f.path==='src/store.rs'||f.path==='src/worker.ts');
        const sources={'src/store.rs':[subject.members[0].url],'src/worker.ts':subject.members.map(m=>m.url)};
        return {version:1,url:tip.url,metadata:{...tip.metadata,baseSha:root.metadata.baseSha,baseBranch:root.metadata.baseBranch},comparisonBase:root.metadata.baseSha,fetchedAt:Date.now(),files,
          stackComparison:{key:'b'.repeat(64),subjectId:subject.id,members:snapshots.map(s=>({metadata:s.metadata,comparisonBase:s.comparisonBase})),fileSources:sources}}};})()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('bounded command queue')).click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open stack overview')");
    await click('Open stack overview');
    await wait("!!document.querySelector('.pr-overview-tabs')");
    await click('Changes');
    await wait("!!document.querySelector('.commit-diff-stream .changes-file-header')", 500);
    await wait("!!document.querySelector('.stack-changes-switch')", 500);
    await js("[...document.querySelectorAll('.stack-changes-switch button')].find(b=>b.textContent.trim()==='Combined').click()");
    await wait("!!document.querySelector('.stack-comparison-context')", 500);
    await sleep(1500);
    console.log('HHINFO combined:', JSON.stringify(await js(`({switch:document.querySelector('.stack-changes-switch')?.textContent,pressed:document.querySelector('.stack-changes-switch [aria-pressed=true]')?.textContent,
      rows:[...document.querySelectorAll('.commit-stream-row')].slice(0,3).map(r=>({file:r.dataset.file,context:r.querySelector('.changes-file-context')?.textContent??null}))})`)));
    await wait("!!document.querySelector('.changes-file-context .changes-source-pr')", 500);
    await sleep(1700);
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const r=document.querySelector('.commit-stream-row[data-file*="worker.ts"]')??document.querySelector('.commit-stream-row');s.scrollTop+=r.getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    await settle();
    await capture('combined-chips', around('.commit-stream-row[data-file*="worker.ts"] .changes-file-context', 40, 90));
    await js(`document.documentElement.classList.toggle('dark',false)`);
  };
  /**
   * Structure load on a large PR (`?syntax-large`, tests/fixtures/syntax-large.ts): 168 files in six languages, some
   * 2,400 lines, some deleting lines, none prepared. Reads take `latency` ms (±50%), as GitHub's would. From the click
   * on Changes, it times the first file's breadcrumbs; a second after, it jumps to a file mid-PR and times its
   * breadcrumbs; and it counts the files whose after side is parsed 2, 5 and 10 s after the click. Each file's steps
   * come from lib/structure-trace.ts.
   */
  const structureLoad = async (latency: number) => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-large`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.blockPrepare=true;window.latency=${latency};
      const large=p=>p.startsWith('src/large/');
      const slow=async read=>{await new Promise(r=>setTimeout(r,window.latency*(0.5+Math.random())));return read()};
      for(const name of ['getPrChangeFile','getPrChangeFileAfter']){const read=window.electronAPI[name];window.electronAPI[name]=async(r,...rest)=>{
        if(!large(r.path))return read(r,...rest);
        if(rest[0]&&window.blockPrepare)throw Error('This file is too large to preview. Open it on GitHub.');
        return slow(()=>read(r,...rest))}}
      window.treeClick=async name=>{const item=()=>window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);
        const first=window.deepAll('[role=treeitem]')[0];let box=first?.parentElement;while(box&&box.scrollHeight<=box.clientHeight)box=box.parentElement;
        if(box)box.scrollTop=0;for(let i=0;i<80&&!item()&&box;i++){box.scrollTop+=200;await new Promise(r=>requestAnimationFrame(r))}
        const target=item();if(!target)throw Error('Missing tree item '+name);target.click()};
      // Each large file's first frame with parsed breadcrumbs, and whether it ever showed Loading structure….
      window.appear={};window.loadingShown={};
      const watch=()=>{for(const row of document.querySelectorAll('.commit-stream-row[data-file^="src/large/"]')){const p=row.dataset.file;
        if(!window.loadingShown[p]&&row.querySelector('[data-structure=loading]'))window.loadingShown[p]=performance.now();
        if(window.appear[p]===undefined&&row.querySelector('.diff-gap-scope:not([data-provisional]) .diff-gap-symbol'))window.appear[p]=performance.now()}
        requestAnimationFrame(watch)};requestAnimationFrame(watch);
      void 0;`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await sleep(1500);
    const MID = 'src/large/api/f091.rs';
    // Reads refused while the queue prepared (the predicted next PR's warm-up among them) are forgotten, so every
    // large file starts unread and unrefused.
    await js(`(async()=>{(await import('/lib/inspection-cache.ts')).inspectionFiles.clear();(await import('/lib/use-syntax-contents.ts')).syntaxContents.forget();
      (await import('/lib/structure-trace.ts')).clearStructureTraces()})()`);
    const t0 = await js<number>(`(()=>{window.blockPrepare=false;const t=performance.now();
      const e=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width&&(e.textContent.trim()==='Changes'||e.getAttribute('aria-label')==='Changes'));
      e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click();return t})()`);
    // The first large file in the stream is the one the reader sees first.
    await wait(`document.querySelector('.commit-stream-row[data-file^="src/large/"]')`, 500);
    const FIRST = await js<string>(`document.querySelector('.commit-stream-row[data-file^="src/large/"]').dataset.file`);
    const debug = async (path: string) =>
      console.log(
        'STRUCTURE DEBUG',
        path,
        JSON.stringify(
          await js(`(async()=>{const t=(await import('/lib/structure-trace.ts')).structureTraces();const c=(await import('/lib/use-syntax-contents.ts')).syntaxContents.stats();
            const p=${JSON.stringify(path)};const row=document.querySelector('.commit-stream-row[data-file="'+p+'"]');
            return {now:performance.now(),trace:Object.entries(t).filter(([k])=>k.includes(p)),reads:c.log.filter(e=>e.key.includes(p)),running:c.running,queued:c.queued,
              row:!!row,note:row?.querySelector('[data-structure]')?.textContent,provisional:row?.querySelectorAll('.diff-gap-scope[data-provisional]').length,scopes:row?.querySelectorAll('.diff-gap-scope').length}})()`)
        )
      );
    try {
      await wait(`window.appear[${JSON.stringify(FIRST)}]!==undefined`, 500);
    } catch (error) {
      await debug(FIRST);
      throw error;
    }
    await sleep(Math.max(0, 1000 - ((await js<number>('performance.now()')) - t0)));
    const tJump = await js<number>('performance.now()');
    await js(`window.treeClick('f091.rs')`);
    try {
      await wait(`window.appear[${JSON.stringify(MID)}]!==undefined`, 500);
    } catch (error) {
      await debug(MID);
      throw error;
    }
    await sleep(Math.max(0, 10_500 - ((await js<number>('performance.now()')) - t0)));
    type Trace = Record<string, number | string | undefined>;
    const data = await js<{ traces: Record<string, Trace>; appear: Record<string, number>; loading: Record<string, number> }>(
      `(async()=>({traces:(await import('/lib/structure-trace.ts')).structureTraces(),appear:window.appear,loading:window.loadingShown}))()`
    );
    const byPath = new Map<string, Trace>();
    for (const [key, trace] of Object.entries(data.traces)) {
      const path = (JSON.parse(key) as string[])[1];
      if (path?.startsWith('src/large/')) byPath.set(path, trace);
    }
    const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
    const phases = (path: string, start: number) => {
      const t = byPath.get(path) ?? {};
      const readStart = num(t.readStart), readEnd = num(t.readEnd), posted = num(t.parsePosted), done = num(t.parseDone);
      const worker = (num(t.workerWait) ?? 0) + (num(t.load) ?? 0) + (num(t.parse) ?? 0) + (num(t.query) ?? 0);
      const at = (value: number | undefined) => (value === undefined ? undefined : Math.max(start, value));
      const span = (from: number | undefined, to: number | undefined) => (from === undefined || to === undefined ? undefined : Math.round(Math.max(0, to - from)));
      return {
        total: span(start, data.appear[path]),
        beforeRead: span(start, at(readStart)),
        read: span(at(readStart), at(readEnd)),
        toWorker: span(at(readEnd), at(posted)),
        workerQueue: done !== undefined && done > start ? Math.round(num(t.workerWait) ?? 0) : 0,
        parse: done !== undefined && done > start ? Math.round(worker - (num(t.workerWait) ?? 0)) : 0,
        message: done !== undefined && done > start && posted !== undefined ? Math.round(Math.max(0, done - Math.max(start, posted) - worker)) : 0,
        before: span(at(done), at(num(t.beforeDone))),
        react: span(at(Math.max(done ?? 0, num(t.beforeDone) ?? 0)), data.appear[path]),
        tier: t.tier,
        steps: Object.fromEntries(Object.entries(t).map(([name, value]) => [name, typeof value === 'number' && name !== 'workerWait' && name !== 'load' && name !== 'parse' && name !== 'query' ? Math.round(value - start) : value])),
      };
    };
    const resolved = (ms: number) => [...byPath.values()].filter((t) => num(t.parseDone) !== undefined && num(t.parseDone)! - t0 <= ms).length;
    const doneTimes = [...byPath.values()].map((t) => num(t.parseDone)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    return {
      first: phases(FIRST, t0),
      mid: phases(MID, tJump),
      resolved: { '2s': resolved(2000), '5s': resolved(5000), '10s': resolved(10_000) },
      lastParse: doneTimes.length ? Math.round(doneTimes[doneTimes.length - 1] - t0) : undefined,
      parsed: doneTimes.length,
      // Distinct frames (16 ms) in which files resolved: one frame for all of them would be "all at once".
      frames: new Set(doneTimes.map((v) => Math.floor(v / 16))).size,
      loadingFlashes: Object.keys(data.loading).filter((p) => data.appear[p] !== undefined && data.appear[p] - data.loading[p] < 150).length,
      firstPath: FIRST,
    };
  };
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  };
  try {
    // GNOSIS_STRUCTURE_BENCH=<runs> times the large PR that many times at GitHub-like and cached read latencies, prints
    // the numbers, and skips the checks.
    if (process.env.GNOSIS_STRUCTURE_BENCH) {
      const runs = Number(process.env.GNOSIS_STRUCTURE_BENCH) || 5;
      for (const latency of [200, 5]) {
        const results: Awaited<ReturnType<typeof structureLoad>>[] = [];
        for (let i = 0; i < runs; i++) {
          const result = await structureLoad(latency);
          console.log(`BENCH run latency=${latency} ${JSON.stringify(result)}`);
          results.push(result);
        }
        const stat = (pick: (r: (typeof results)[number]) => number | undefined) => {
          const values = results.map(pick).filter((v): v is number => v !== undefined);
          return { p50: percentile(values, 50), p95: percentile(values, 95) };
        };
        console.log(
          `BENCH summary latency=${latency} ${JSON.stringify({
            first: stat((r) => r.first.total),
            mid: stat((r) => r.mid.total),
            resolved2s: stat((r) => r.resolved['2s']),
            resolved5s: stat((r) => r.resolved['5s']),
            resolved10s: stat((r) => r.resolved['10s']),
            lastParse: stat((r) => r.lastParse),
          })}`
        );
      }
      return;
    }
    if (process.env.GNOSIS_HUNK_HEADER_SHOTS) {
      await hunkHeaderShots();
      return;
    }
    if (process.env.GNOSIS_FILE_HEADER_SHOTS) {
      await fileHeaderShots();
      return;
    }
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.__longTasks=[];
      new PerformanceObserver(l=>{for(const e of l.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask'});
      window.row=p=>document.querySelector('.commit-stream-row[data-file="'+p+'"]');
      window.lineTexts=p=>window.deepAll('[data-line]',window.row(p)).map(e=>e.textContent);
      // Breadcrumbs from parsed definitions; provisional ones, from the patch's hunk headers, are listed apart.
      window.symbols=p=>[...(window.row(p)?.querySelectorAll('.diff-gap-scope:not([data-provisional]) .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      window.provisional=p=>[...(window.row(p)?.querySelectorAll('.diff-gap-scope[data-provisional] .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      window.structureNote=p=>[...(window.row(p)?.querySelectorAll('[data-structure]')??[])].map(e=>e.dataset.structure+': '+e.textContent.trim());
      window.firstLineInView=top=>{
        const view=document.querySelector('.commit-diff-stream').getBoundingClientRect();
        for(const host of document.querySelectorAll('.commit-stream-row .changes-diff .diff-hunk > diffs-container')){
          const b=host.getBoundingClientRect();if(b.bottom<top||b.top>view.bottom||!b.height)continue;
          const line=[...(host.shadowRoot?.querySelectorAll('[data-line]')??[])].find(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.top>=top});
          if(line)return line;
        }
      };
      // Reads the reader's view makes: none of these files may be read for their scopes.
      window.reads=[];window.afterReads=[];window.afterKeys=[];window.prepared=new Set();
      {const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async(r,...rest)=>{if(!rest[0])window.reads.push(r.path);const value=await read(r,...rest);window.prepared.add(r.path);return value};}
      {const read=window.electronAPI.getPrChangeFileAfter;window.electronAPI.getPrChangeFileAfter=async(r,...rest)=>{window.afterReads.push(r.path);window.afterKeys.push(r.url+" "+r.path);return read(r,...rest)};}
      // Parse requests are held until released, so the suite can see the diff before and after its scopes arrive.
      window.held=[];window.holding=true;
      {const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(message,...rest){
        if(window.holding&&message&&message.type==='definitions'){window.held.push(()=>post.call(this,message,...rest));return}
        return post.call(this,message,...rest)};}
      window.release=()=>{window.holding=false;for(const send of window.held.splice(0))send()};
      void 0;`);
    // Contents and definitions the predicted next PR warmed while the page loaded leave, so the checks below see
    // scopes arrive.
    await js(
      "(async()=>{(await import('/lib/inspection-cache.ts')).inspectionFiles.clear();(await import('/lib/syntax-scope-client.ts')).clearDefinitions()})()"
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    // Queue preparation reads both sides of each file in the background; scopes use only what it read.
    await wait(`${JSON.stringify(PATHS)}.every(p=>window.prepared.has(p))`, 500);
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='scope.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='scope.ts').click()");
    const scope = "window.row('src/scope.ts')";
    await wait(`(${scope}?.querySelectorAll('.diff-gap[data-gap]').length??0)>=4`);
    await wait('window.held.length>0');
    // Before scopes arrive, the diff is today's: three lines of context and no symbols. These hunk headers carry no
    // text, so each hunk's provisional location is blank, beside a quiet "Loading structure…".
    assert.deepEqual(await js('window.symbols("src/scope.ts")'), []);
    await wait(`window.provisional('src/scope.ts').length>=4`);
    assert.deepEqual(await js('window.provisional("src/scope.ts")'), Array(4).fill(''));
    assert.ok(
      (await js<string[]>('window.structureNote("src/scope.ts")')).every((note) => note === 'loading: Loading structure…'),
      'Loading structure… while the parse is pending'
    );
    const signature = 'export function resolvePaths(root: string, names: string[]): string[] {';
    assert.ok(
      !(await js<string[]>('window.lineTexts("src/scope.ts")')).includes(signature),
      'resolvePaths starts outside the patch context'
    );

    // ── Scroll: scopes arrive and resolvePaths opens whole while the reader is further down the file ──
    // The tree's jump holds the file in place for 1.5 s; scroll after it lets go.
    await sleep(1700);
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const bar=${scope}.querySelector('.diff-gap[data-gap="1"]');
      s.scrollTop+=bar.getBoundingClientRect().top-s.getBoundingClientRect().top-10})()`);
    await js(frames);
    await sleep(300);
    await js(`(()=>{const top=document.querySelector('.commit-diff-stream').getBoundingClientRect().top;
      window.anchor=window.firstLineInView(top+60);window.anchorTop=window.anchor.getBoundingClientRect().top;
      window.focused=document.activeElement})()`);
    const anchorText = await js<string>('window.anchor.textContent');
    assert.match(anchorText, /total/, `The line in view is in the method below resolvePaths: ${anchorText}`);
    await js('window.__longTasks=[];window.t0=performance.now();window.release()');
    await wait(`window.symbols('src/scope.ts').length>=4`);
    assert.deepEqual(await js('window.provisional("src/scope.ts")'), [], 'Parsed definitions replace the provisional crumbs');
    assert.deepEqual(await js('window.structureNote("src/scope.ts")'), [], 'Nothing is loading');
    await wait(`window.lineTexts('src/scope.ts').includes(${JSON.stringify(signature)})`);
    await js(frames);
    await sleep(600);
    const shift = await js<number>(
      'window.anchor.isConnected?Math.round(window.anchor.getBoundingClientRect().top-window.anchorTop):NaN'
    );
    assert.equal(shift, 0, `The line in view (${anchorText}) stays put when resolvePaths opens above it`);
    assert.ok(await js<boolean>('document.activeElement===window.focused'), 'Focus stays where it was');

    // ── Each hunk's bar is a breadcrumb of the file and the definitions around the hunk ──
    const scopeCrumbs = [
      'function resolvePaths()',
      'class StoreBridge › flush()',
      'function migrate()',
      'describe "resolvePaths" › it "joins names"',
    ];
    assert.deepEqual(await js('window.symbols("src/scope.ts")'), scopeCrumbs);
    assert.deepEqual(
      await js(`[...${scope}.querySelectorAll('.diff-gap-symbol')].map(e=>e.getAttribute('aria-label'))[1]`),
      'In scope.ts, class StoreBridge, function flush',
      'The accessible label reads the whole chain'
    );
    assert.equal(
      await js(`${scope}.querySelectorAll('.diff-gap-symbol')[1].querySelector('[data-innermost]').textContent`),
      'flush()',
      'The innermost crumb is marked for the text colour'
    );
    // Short definitions are whole: resolvePaths and the test.
    const lines = await js<string[]>('window.lineTexts("src/scope.ts")');
    assert.ok(lines.includes(signature) && lines.includes('}'), 'resolvePaths is whole');
    assert.ok(!lines.includes('// Scope fixture for #393.'), 'Lines above resolvePaths stay hidden');
    assert.ok(lines.includes("  it('joins names', () => {"), 'The it test is whole');
    const actions = () =>
      js<string[]>(`[...${scope}.querySelectorAll('[data-show-definition]')].map(b=>b.textContent.trim())`);
    assert.deepEqual(await actions(), ['Show whole function', 'Show function signature']);
    await js(`${scope}.scrollIntoView({block:'start'})`);
    await shot('scope-headers', '.commit-stream-row[data-file="src/scope.ts"]');

    // ── Show whole function ──
    assert.ok(!(await js<string[]>('window.lineTexts("src/scope.ts")')).includes('  flush(): number {'));
    await js(
      `[...${scope}.querySelectorAll('[data-show-definition]')].find(b=>b.textContent.includes('whole function')).click()`
    );
    await wait(`window.lineTexts('src/scope.ts').includes('  flush(): number {')`);
    const flush = await js<string[]>('window.lineTexts("src/scope.ts")');
    for (const text of ['    let total = 0;', '    total += 0;', '    total += 59;', '    return total;'])
      assert.ok(flush.includes(text), `flush shows ${text}`);
    assert.ok(!flush.includes('export const between0 = 0;'), 'Lines past the method stay hidden');
    // ── Past the cap: the signature only ──
    await js(
      `[...${scope}.querySelectorAll('[data-show-definition]')].find(b=>b.textContent.includes('signature')).click()`
    );
    await wait(`window.lineTexts('src/scope.ts').includes('export function migrate(version: number): number {')`);
    const migrate = await js<string[]>('window.lineTexts("src/scope.ts")');
    assert.ok(
      !migrate.includes('  version = version + 0;'),
      'The body between the signature and the hunk stays hidden'
    );
    assert.ok(migrate.includes('  version = version + 117;'), 'The hunk keeps its context');
    assert.deepEqual(await actions(), [], 'Nothing is left to show');
    assert.deepEqual(
      await js('window.symbols("src/scope.ts")'),
      scopeCrumbs,
      'The pinned signature has no header of its own'
    );
    await js(`${scope}.querySelector('[data-scope-kind]')?.scrollIntoView({block:'center'})`);
    await shot('scope-revealed', '.commit-stream-row[data-file="src/scope.ts"]');

    // ── Rust ──
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='store.rs').click()");
    await wait(`window.symbols('src/store.rs').length>=5`);
    assert.deepEqual(await js('window.symbols("src/store.rs")'), [
      'impl StoreBridge',
      'impl StoreBridge › fn save',
      'trait Bridge',
      'fn cleanup',
      'mod tests › fn saves_items',
    ]);
    const store = "window.row('src/store.rs')";
    assert.deepEqual(
      await js(`[...${store}.querySelectorAll('[data-show-definition]')].map(b=>b.textContent.trim())`),
      ['Show whole impl block', 'Show whole function']
    );
    // Clicking a crumb reveals its definition: the impl block around save(), whole, which holds all of save().
    assert.ok(!(await js<string[]>('window.lineTexts("src/store.rs")')).includes('        let step_20 = value + 20;'));
    await js(
      `[...${store}.querySelectorAll('.diff-gap-symbol')[1].querySelectorAll('button[data-crumb]')].find(b=>b.textContent==='impl StoreBridge').click()`
    );
    await wait(
      `window.lineTexts('src/store.rs').includes('    pub fn save(&mut self, key: &str, value: u32) -> bool {')`
    );
    for (const text of ['        let step_0 = value + 0;', '        let step_20 = value + 20;'])
      assert.ok((await js<string[]>('window.lineTexts("src/store.rs")')).includes(text), `The impl shows ${text}`);
    assert.ok(
      !(await js<string[]>(`[...${store}.querySelectorAll('[data-show-definition]')].map(b=>b.textContent.trim())`)).includes('Show whole function'),
      'Nothing of save() is left to show'
    );
    await js(`${store}.scrollIntoView({block:'start'})`);
    await shot('store-headers', '.commit-stream-row[data-file="src/store.rs"]');

    // ── A file without a grammar is unchanged ──
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='notes.rb').click()");
    const notes = "window.row('src/notes.rb')";
    await wait(
      `(${notes}?.querySelectorAll('.diff-gap[data-gap]').length??0)>=2&&window.lineTexts('src/notes.rb').length>0`
    );
    await sleep(500);
    assert.equal(await js<number>(`${notes}.querySelectorAll('.diff-gap-scope,[data-show-definition]').length`), 0);
    assert.deepEqual(
      await js(`[...${notes}.querySelectorAll('.diff-gap[data-gap]')].map(e=>e.getAttribute('aria-label'))`),
      ['19 lines hidden', '18 lines hidden'],
      'The bars are as before'
    );
    assert.ok(
      !(await js<string[]>('window.lineTexts("src/notes.rb")')).includes('NOTE_0 = 0'),
      'Only the patch lines show'
    );

    // ── The 3,000-line file parses in the worker ──
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='large.ts').click()");
    await wait(`window.symbols('src/large.ts').includes('function generated500()')`);
    // Imports at the file's first lines sit outside every definition and have no gap bar above them: the hunk still
    // shows where it is, as the file alone; the hunk inside total() shows its function.
    await wait(`window.symbols('src/imports.ts').length>=2`);
    assert.deepEqual(await js('window.symbols("src/imports.ts")'), ['top level', 'function total()'], 'Top-level changes say so');
    // C# (Unity): the hunk inside Update() names its namespace, class and method.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='Navmesh.cs').click()");
    await wait(`window.symbols('src/Navmesh.cs').length>=1`);
    console.log('C# breadcrumb:', await js('window.symbols("src/Navmesh.cs")'));
    assert.match((await js<string[]>('window.symbols("src/Navmesh.cs")')).at(-1) ?? '', /class Navmesh › Update\(\)$/);
    const timings = await js<
      { key: string; language: string; parse: number; query: number; load?: number; characters: number }[]
    >("(async()=>(await import('/lib/syntax-scope-client.ts')).syntaxTimings.map(t=>({...t})))()");
    console.log(
      'Worker parse timings:',
      JSON.stringify(
        timings.map((t) => ({
          file: (JSON.parse(t.key.replace(/:(after|before)$/, '')) as string[])[1],
          side: /:(after|before)$/.exec(t.key)?.[1],
          language: t.language,
          characters: t.characters,
          parse: Math.round(t.parse * 10) / 10,
          query: Math.round(t.query * 10) / 10,
          load: t.load && Math.round(t.load),
        }))
      )
    );
    // A fresh parse of the large file, timed from the page, with nothing else running.
    await sleep(500);
    const fresh = await js<{ elapsed: number; posting: number; definitions: number; tasks: number[] }>(`(async()=>{
      const client=await import('/lib/syntax-scope-client.ts');
      const text=(await window.electronAPI.getPrChangeFile({url:'x',path:'src/large.ts',baseSha:'a',headSha:'b'},true)).after.content;
      window.__longTasks=[];const t0=performance.now();
      const pending=client.readDefinitions({key:'fresh-large',url:'test:fresh',language:'typescript',text});
      const posting=performance.now()-t0;
      const definitions=await pending;const elapsed=performance.now()-t0;
      await new Promise(r=>setTimeout(r,200));
      client.forgetDefinitions(new Set(['test:fresh']));
      return {elapsed,posting,definitions:definitions.length,tasks:window.__longTasks.filter(t=>t.start>=t0-5).map(t=>Math.round(t.duration))}})()`);
    console.log(
      'Fresh 3,000-line parse from the page:',
      JSON.stringify({ ...fresh, elapsed: Math.round(fresh.elapsed), posting: Math.round(fresh.posting * 10) / 10 })
    );
    assert.equal(fresh.definitions, 1000);
    assert.deepEqual(fresh.tasks, [], 'Parsing leaves no long task on the main thread');

    // ── Pinned hunk headers (#395) ──
    await installSticky();
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='sticky.ts').click()");
    await wait(`window.symbols('src/sticky.ts').length>=2`);
    const stickyCrumbs = ['function first()', 'function second()'];
    assert.deepEqual(await js('window.symbols("src/sticky.ts")'), stickyCrumbs);
    // The tree's jump holds the file in place for 1.5 s.
    await sleep(1700);
    await checkPinned('Changes', 'src/sticky.ts', stickyCrumbs);
    await shot('sticky-mid-hunk', '.commit-diff-stream');
    // The breadcrumb starts at the code's text column, after the line numbers and the +/− signs.
    const columns = await js<{ crumb: number; code: number }>(`(()=>{const section=window.stickyRow('src/sticky.ts').querySelectorAll('.diff-hunk')[1];
      const line=window.deepAll('[data-line]',section).find(e=>e.getBoundingClientRect().width>0);
      return {crumb:section.querySelector('[data-hunk-header] .diff-gap-symbol').getBoundingClientRect().left,code:line.getBoundingClientRect().left+parseFloat(getComputedStyle(line).paddingLeft)}})()`);
    assert.ok(Math.abs(columns.crumb - columns.code) <= 1, `The breadcrumb lines up with the code: ${JSON.stringify(columns)}`);
    // Hand-off: the second header pushes the first one away as it arrives, and is never under it.
    // The second hunk starts 12 px below the file header.
    await js(`(()=>{const s=window.stream();const second=window.stickyRow('src/sticky.ts').querySelectorAll('.diff-hunk')[1];
      const file=window.stickyRow('src/sticky.ts').querySelector('.changes-file-header').getBoundingClientRect();
      s.scrollTop+=second.getBoundingClientRect().top-file.bottom-12})()`);
    await settle();
    {
      const [first, second] = (await headers('src/sticky.ts')) as Header[];
      assert.ok(first.offset + first.height <= second.offset + 1, `The next header pushes the pinned one away: ${JSON.stringify({ first, second })}`);
      assert.ok(first.offset < -1, `The first header is on its way out: ${JSON.stringify(first)}`);
      assert.ok(!second.stuck && Math.abs(second.offset - 12) <= 1, `The second header is not pinned yet: ${JSON.stringify(second)}`);
    }
    // A line scrolled to the top of the view lands below the file header and the pinned header of its hunk.
    const landed = await js<{ line: number; header: number; stuck: boolean }>(`(async()=>{const section=window.stickyRow('src/sticky.ts').querySelectorAll('.diff-hunk')[1];
      const line=window.deepAll('[data-line]',section).find(e=>e.dataset.line==='210'&&e.getBoundingClientRect().height>0)??window.deepAll('[data-line]',section).find(e=>e.dataset.line==='210');
      line.scrollIntoView({block:'start',behavior:'instant'});
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await new Promise(r=>setTimeout(r,150));
      const h=section.querySelector('[data-hunk-header]');
      return {line:line.getBoundingClientRect().top,header:h.getBoundingClientRect().bottom,stuck:h.hasAttribute('data-stuck')}})()`);
    assert.ok(landed.stuck && landed.line >= landed.header - 1, `The line scrolled to shows below the headers: ${JSON.stringify(landed)}`);
    // Focus inside a pinned bar brings its controls back, so a keyboard reader can use them.
    const focused = await js<(string | boolean)[]>(`(()=>{const h=window.stickyRow('src/sticky.ts').querySelectorAll('.diff-hunk')[1].querySelector('[data-hunk-header]');
      h.querySelector('.diff-gap-controls > button').focus({preventScroll:true});
      return [document.activeElement.closest('[data-hunk-header]')===h,...[...h.querySelectorAll(':is(.diff-gap-gutter,.diff-gap-act,.diff-gap-controls) > button')].map(b=>getComputedStyle(b).opacity)]})()`);
    assert.deepEqual(focused.slice(0, 1), [true], 'A pinned bar\'s controls stay in the tab order');
    assert.ok(focused.length > 1 && focused.slice(1).every((v) => v === '1'), `Focus shows a pinned bar's controls: ${focused}`);
    await js('document.activeElement.blur()');
    // Scrolling costs no layout of its own: CSS sticky pins the headers, and pinning flips one attribute per header.
    const scrolling = await js<{ frames: number; p50: number; max: number; flips: number; longTasks: number[] }>(`(async()=>{
      const s=window.stream();const row=window.stickyRow('src/sticky.ts');s.scrollTop+=row.getBoundingClientRect().top-s.getBoundingClientRect().top;
      await new Promise(r=>setTimeout(r,300));
      let flips=0;const watch=new MutationObserver(l=>flips+=l.length);watch.observe(row,{subtree:true,attributeFilter:['data-stuck']});
      window.__longTasks=[];const deltas=[];let last=performance.now();
      for(let i=0;i<150;i++){s.scrollTop+=40;await new Promise(r=>requestAnimationFrame(r));const now=performance.now();deltas.push(now-last);last=now}
      await new Promise(r=>setTimeout(r,100));watch.disconnect();deltas.sort((a,b)=>a-b);
      return {frames:deltas.length,p50:Math.round(deltas[deltas.length>>1]*10)/10,max:Math.round(deltas.at(-1)*10)/10,flips,longTasks:window.__longTasks.map(t=>Math.round(t.duration))}})()`);
    console.log('Scrolling sticky.ts 40 px a frame:', JSON.stringify(scrolling));
    assert.ok(scrolling.flips <= 8, `Pinning flips an attribute only as a header pins or lets go: ${scrolling.flips}`);
    // ── A file with no grammar pins its hunks' line ranges ──
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='sticky.rb').click()");
    await wait(`window.stickyRow('src/sticky.rb')?.querySelectorAll('[data-hunk-header]').length===2&&window.lineTexts('src/sticky.rb').length>0`);
    assert.equal(await js<number>(`window.stickyRow('src/sticky.rb').querySelectorAll('.diff-gap-scope').length`), 0, 'No breadcrumb without a grammar');
    await sleep(1700);
    await checkPinned('Changes, no grammar', 'src/sticky.rb', ['L1–84', 'L99–181']);
    await shot('sticky-no-grammar', '.commit-diff-stream');
    // ── Narrow: the file header wraps taller, and the hunk header follows it ──
    const wide = win.getContentSize();
    win.setContentSize(760, 800);
    await sleep(400);
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='sticky.ts')?.click()");
    await sleep(1700);
    await checkPinned('Changes, narrow', 'src/sticky.ts', stickyCrumbs);
    await shot('sticky-narrow', '.commit-diff-stream');
    win.setContentSize(wide[0], wide[1]);
    await sleep(400);

    // ── No reads for scopes ──
    assert.deepEqual(
      await js(`window.reads.filter(p=>${JSON.stringify(PATHS)}.includes(p))`),
      [],
      'The view read no file for its scopes'
    );
    // Prefetch may read the files of the PR's other members, which preparation did not reach: each once at most.
    const afterKeys = await js<string[]>('window.afterKeys');
    console.log(`After sides read for scopes in the prepared PR: ${afterKeys.length}`);
    assert.deepEqual(
      afterKeys.filter((key, index) => afterKeys.indexOf(key) !== index),
      [],
      'No file revision is read twice'
    );
    assert.deepEqual(errors, [], 'No console errors');

    // ═══ Contents nothing prepared: loading on view, prefetch, and the read bound ═══
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope&syntax-lazy`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.row=p=>document.querySelector('.commit-stream-row[data-file="'+p+'"]');
      window.lineTexts=p=>window.deepAll('[data-line]',window.row(p)).map(e=>e.textContent);
      // Breadcrumbs from parsed definitions; provisional ones, from the patch's hunk headers, are listed apart.
      window.symbols=p=>[...(window.row(p)?.querySelectorAll('.diff-gap-scope:not([data-provisional]) .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      window.provisional=p=>[...(window.row(p)?.querySelectorAll('.diff-gap-scope[data-provisional] .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      window.structureNote=p=>[...(window.row(p)?.querySelectorAll('[data-structure]')??[])].map(e=>e.dataset.structure+': '+e.textContent.trim());
      // Every contents read of the lazy files, and how many run at once. Reads take 120 ms, as a slow network would.
      window.lazyReads=[];window.inflight=0;window.maxInflight=0;window.blocked=0;window.blockPrepare=true;
      const lazy=p=>p.startsWith('src/lazy/');
      // holdReads=path keeps that file's reads waiting until releaseReads(); failNext[path] fails that many reads of a file as a
      // timeout would. A failed read leaves lazyReads for failedReads, so the read counts stay those that succeeded.
      window.holdReads=false;window.heldReads=[];window.failNext={};window.failedReads=[];window.readModes=[];
      window.releaseReads=()=>{window.holdReads=false;for(const go of window.heldReads.splice(0))go()};
      const slow=async(read,entry,mode)=>{window.readModes.push({path:entry.path,mode});
        window.inflight++;window.maxInflight=Math.max(window.maxInflight,window.inflight);
        try{if(window.holdReads===entry.path)await new Promise(r=>window.heldReads.push(r));await new Promise(r=>setTimeout(r,120));
          if((window.failNext[entry.path]??0)>0){window.failNext[entry.path]--;window.lazyReads.splice(window.lazyReads.indexOf(entry),1);
            window.failedReads.push({...entry,at:performance.now()});throw Error('Request timed out')}
          return await read()}finally{window.inflight--}};
      {const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async(r,...rest)=>{
        if(!lazy(r.path))return read(r,...rest);
        // Queue preparation reads nothing of these files: their contents stay unloaded until Changes asks.
        if(rest[0]&&window.blockPrepare){window.blocked++;throw Error('This file is too large to preview. Open it on GitHub.')}
        const entry={path:r.path,url:r.url,key:r.url+' '+r.path,side:'both',at:performance.now()};window.lazyReads.push(entry);return slow(()=>read(r,...rest),entry,rest[0])}}
      {const read=window.electronAPI.getPrChangeFileAfter;window.electronAPI.getPrChangeFileAfter=async(r,...rest)=>{
        if(!lazy(r.path))return read(r,...rest);
        const entry={path:r.path,url:r.url,key:r.url+' '+r.path,side:'after',at:performance.now()};window.lazyReads.push(entry);return slow(()=>read(r,...rest),entry,rest[0])}}
      window.readsOf=p=>window.lazyReads.filter(r=>r.path===p).length;
      // The file tree is virtualized: scroll it until the file shows, then select it.
      window.treeClick=async name=>{const item=()=>window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);
        const first=window.deepAll('[role=treeitem]')[0];let box=first?.parentElement;while(box&&box.scrollHeight<=box.clientHeight)box=box.parentElement;
        if(box)box.scrollTop=0;for(let i=0;i<60&&!item()&&box;i++){box.scrollTop+=200;await new Promise(r=>requestAnimationFrame(r))}
        const target=item();if(!target)throw Error('Missing tree item '+name);target.click()};
      void 0;`);
    const contents = "(await import('/lib/use-syntax-contents.ts')).syntaxContents";
    // Prefetch waits, as it does while the window is hidden, so the first checks see view reads alone.
    await js(`(async()=>{(await import('/lib/inspection-cache.ts')).inspectionFiles.clear();const c=${contents};c.setHidden(true);c.stopPrefetch();window.logStart=c.stats().log.length})()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await sleep(1500);
    await js('window.blockPrepare=false');
    // h003.rs's read waits until released, then times out twice before it succeeds.
    await js("window.holdReads='src/lazy/h003.rs';window.failNext['src/lazy/h003.rs']=2");
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='h003.rs')");
    console.log(
      'Reads at open:',
      JSON.stringify(await js(`(async()=>${contents}.stats().log.slice(window.logStart).map(e=>({file:JSON.parse(e.key)[1],tier:e.tier})))()`))
    );
    await js("window.treeClick('h003.rs')");

    // ── Before its contents load, the hunk shows its header's text from the patch, and the structure is loading ──
    const h03 = "window.row('src/lazy/h003.rs')";
    await wait(`window.provisional('src/lazy/h003.rs').length>=1`);
    assert.deepEqual(
      await js('window.provisional("src/lazy/h003.rs")'),
      ['pub fn handler_3(&self) -> u32'],
      'The provisional crumb is the hunk header text, without its brace'
    );
    assert.deepEqual(await js('window.symbols("src/lazy/h003.rs")'), []);
    await wait(`window.heldReads.length>0`);
    assert.deepEqual(await js('window.structureNote("src/lazy/h003.rs")'), ['loading: Loading structure…']);
    assert.equal(
      await js("window.readModes.find(r=>r.path==='src/lazy/h003.rs').mode"),
      'view',
      'The view read goes at foreground (view) priority, not in the background'
    );
    await js(`document.querySelector('.commit-diff-stream').scrollTop+=${h03}.querySelector('.diff-gap-scope').closest('.diff-gap').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top-40`);
    await shot('provisional-loading', '.commit-stream-row[data-file="src/lazy/h003.rs"] .diff-gap:has(.diff-gap-scope)');
    await js('window.releaseReads()');

    // ── Two timeouts later, the read succeeds and parsed definitions replace the provisional crumb ──
    // Then it loads its after side once and shows its breadcrumb and Show whole function.
    await wait(`window.symbols('src/lazy/h003.rs').length>=1`, 500);
    assert.equal(await js<number>("window.failedReads.filter(r=>r.path==='src/lazy/h003.rs').length"), 2, 'Two reads timed out');
    assert.deepEqual(await js('window.provisional("src/lazy/h003.rs")'), [], 'The provisional crumb is gone');
    assert.deepEqual(await js('window.structureNote("src/lazy/h003.rs")'), [], 'Nothing is loading');
    const record = await js<{ tier: string; attempts: number; outcome: string; queuedMs: number; runMs: number }>(
      `(async()=>${contents}.stats().log.find(e=>JSON.parse(e.key)[1]==='src/lazy/h003.rs'))()`
    );
    console.log('h003.rs read:', JSON.stringify(record));
    assert.deepEqual(
      { tier: record.tier, attempts: record.attempts, outcome: record.outcome },
      { tier: 'view', attempts: 3, outcome: 'done' },
      'Diagnostics record the tries'
    );
    assert.equal(await js<number>("window.readsOf('src/lazy/h003.rs')"), 1, 'One read of h003.rs');
    assert.deepEqual(await js("window.lazyReads.filter(r=>r.path==='src/lazy/h003.rs').map(r=>r.side)"), ['after']);
    assert.deepEqual(
      await js('window.symbols("src/lazy/h003.rs")'),
      ['mod api › impl Client3 › fn handler_3'],
      'The whole chain, which fits'
    );
    // The chain shows whole while it fits; a bar too narrow for it folds crumbs from the outside, keeping the innermost.
    // Widths are set, not taken from the window: a CI desktop can clamp the 1280 px window to its screen (the Windows
    // runner's is 1024 px wide), and there the bar is too narrow for the whole chain beside its controls, so it folds,
    // as it should. The chain and the bar's controls take about 850 px; 1,400 px leaves room for wider fonts.
    const WIDE = '1400px';
    const folds = async (width: string) => {
      await js(`window.row('src/lazy/h003.rs').querySelector('.changes-diff').style.width=${JSON.stringify(width)}`);
      await js(frames);
      await sleep(100);
      return js<{ folded: string[]; more: boolean; innermost: string; fits: boolean; bar: number }>(`(()=>{const s=window.row('src/lazy/h003.rs').querySelector('.diff-gap-symbol');
        return {folded:[...s.querySelectorAll(':scope > [data-collapsed]')].map(g=>g.textContent.replace('›','').trim()),more:getComputedStyle(s.querySelector('.diff-gap-more')).display!=='none',
          innermost:s.querySelector('[data-innermost]').textContent,fits:s.scrollWidth<=s.clientWidth+1,bar:Math.round(s.closest('.diff-gap').getBoundingClientRect().width)}})()`);
    };
    const roomy = await folds(WIDE);
    assert.deepEqual(
      { folded: roomy.folded, more: roomy.more, innermost: roomy.innermost, fits: roomy.fits },
      { folded: [], more: false, innermost: 'fn handler_3', fits: true },
      `Nothing folds while the chain fits: ${JSON.stringify(roomy)}`
    );
    const narrow = await folds('520px');
    console.log('Breadcrumb at 520px:', JSON.stringify(narrow));
    assert.equal(narrow.folded[0], 'mod api', 'The outermost crumb folds first');
    assert.ok(narrow.more && narrow.fits && narrow.innermost === 'fn handler_3', `It folds into "…" and the innermost stays whole: ${JSON.stringify(narrow)}`);
    assert.deepEqual((await folds(WIDE)).folded, [], 'Widened again, the whole chain comes back');
    await folds('');
    const trail = `${h03}.querySelector('.diff-gap-symbol')`;
    assert.equal(
      await js(`${trail}.getAttribute('title')`),
      'In h003.rs, module api, impl Client3, function handler_3',
      'The whole chain is the tooltip'
    );
    assert.equal(await js(`${trail}.getAttribute('aria-label')`), 'In h003.rs, module api, impl Client3, function handler_3');
    assert.deepEqual(
      await js(`[...${h03}.querySelectorAll('[data-show-definition]')].map(b=>b.textContent.trim())`),
      ['Show whole function'],
      'The 60-line handler is too long to open by default'
    );
    await js(`document.querySelector('.commit-diff-stream').scrollTop+=${h03}.querySelector('.diff-gap-scope').closest('.diff-gap').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top-40`);
    await shot('rust-breadcrumb', '.commit-stream-row[data-file="src/lazy/h003.rs"] .diff-gap:has(.diff-gap-scope)');
    // Its crumb reveals the impl block, whole.
    assert.ok(!(await js<string[]>("window.lineTexts('src/lazy/h003.rs')")).includes('    impl Client3 {'));
    await js(`[...${trail}.querySelectorAll('button[data-crumb]')].find(b=>b.textContent==='impl Client3').click()`);
    await wait("window.lineTexts('src/lazy/h003.rs').includes('    impl Client3 {')");
    assert.ok((await js<string[]>("window.lineTexts('src/lazy/h003.rs')")).includes('            total += 0;'));

    // ── A read whose every try times out (after 1 s, 4 s and 15 s) offers Try again, which loads it ──
    await js("window.failNext['src/lazy/h030.rs']=4");
    await js("window.treeClick('h030.rs')");
    await wait(`window.structureNote('src/lazy/h030.rs').some(n=>n.startsWith('failed:'))`, 800);
    assert.deepEqual(await js('window.structureNote("src/lazy/h030.rs")'), ['failed: Couldn’t load structure.Try again']);
    assert.equal(await js<number>("window.failedReads.filter(r=>r.path==='src/lazy/h030.rs').length"), 4);
    assert.deepEqual(await js('window.provisional("src/lazy/h030.rs")'), ['pub fn handler_30(&self) -> u32'], 'The provisional crumb stays');
    await js(`document.querySelector('.commit-diff-stream').scrollTop+=window.row('src/lazy/h030.rs').querySelector('.diff-gap-scope').closest('.diff-gap').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top-200`);
    await shot('structure-failed', '.commit-stream-row[data-file="src/lazy/h030.rs"] .diff-gap:has(.diff-gap-scope)');
    await js(`[...window.row('src/lazy/h030.rs').querySelectorAll('[data-structure=failed] button')].find(b=>b.textContent==='Try again').click()`);
    await wait(`window.symbols('src/lazy/h030.rs').length>=1`, 200);
    assert.deepEqual(await js('window.symbols("src/lazy/h030.rs")'), ['mod api › impl Client30 › fn handler_30']);
    assert.deepEqual(await js('window.structureNote("src/lazy/h030.rs")'), []);
    // A file far from the view is not read while prefetch waits.
    for (const far of ['src/lazy/h020.rs', 'src/lazy/h023.rs', 'src/lazy/panel.ts'])
      assert.equal(await js<number>(`window.readsOf(${JSON.stringify(far)})`), 0, `${far} is not read yet`);

    // ── Fast scrolling through the PR: at most two reads at once, and files that only flash past are not read ──
    const beforeScroll = await js<number>('window.lazyReads.length');
    await js(`(async()=>{const s=document.querySelector('.commit-diff-stream');s.scrollTop=0;
      for(let i=0;i<200&&s.scrollTop+s.clientHeight<s.scrollHeight;i++){s.scrollTop+=500;await new Promise(r=>setTimeout(r,16))}})()`);
    await sleep(1500);
    const scrolled = await js<number>('window.lazyReads.length');
    console.log(`Fast scroll: ${scrolled - beforeScroll} reads, at most ${await js<number>('window.maxInflight')} at once`);
    assert.ok((await js<number>('window.maxInflight')) <= 2, 'At most two reads run at once');
    assert.ok(scrolled - beforeScroll <= 6, `Files that flash past are not read (${scrolled - beforeScroll} reads)`);
    assert.equal(await js<number>("window.readsOf('src/lazy/h012.rs')"), 0, 'A file scrolled past quickly is not read');

    // ── Prefetch: every supported file in diff order, two at a time, pausing while the reader scrolls ──
    await js(`(async()=>{const s=document.querySelector('.commit-diff-stream');s.scrollTop=0})()`);
    await sleep(300);
    await js(`(async()=>{${contents}.setHidden(false)})()`);
    await wait(`window.lazyReads.length>=${scrolled + 2}`);
    // Wheel turns every 100 ms for 1.2 s: prefetch starts nothing new until the reader stops.
    const pause = await js<{ started: number; during: number }>(`(async()=>{const c=${contents};
      const stream=document.querySelector('.commit-diff-stream');const prefetched=()=>c.stats().log.filter(e=>e.tier==='prefetch').length;
      stream.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));await new Promise(r=>setTimeout(r,20));
      const started=prefetched();
      for(let i=0;i<12;i++){stream.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1}));await new Promise(r=>setTimeout(r,100))}
      return {started,during:prefetched()-started}})()`);
    assert.equal(pause.during, 0, 'Prefetch waits while the reader scrolls');
    const LAZY_FILES = 165;
    await wait(`(async()=>{const s=${contents}.stats();return !s.queued&&!s.running})()`, 500);
    await sleep(500);
    await wait(`(async()=>{const s=${contents}.stats();return !s.queued&&!s.running})()`, 500);
    const order = await js<[string, string][]>(
      `(async()=>${contents}.stats().log.slice(window.logStart).filter(e=>e.tier==='prefetch').map(e=>JSON.parse(e.key)).filter(k=>/^src\\/lazy\\/h\\d+\\.rs$/.test(k[1])).map(k=>[k[0],k[1]]))()`
    );
    const members = [...new Set(order.map(([url]) => url))];
    for (const member of members) {
      const files = order.filter(([url]) => url === member).map(([, file]) => file);
      assert.deepEqual(files, [...files].sort(), `Prefetch reads ${member}'s files in diff order`);
    }
    assert.ok(order.length >= 15, `Prefetch read the files the reader did not reach (${order.length})`);
    assert.ok((await js<number>('window.maxInflight')) <= 2, 'Prefetch runs two at a time');
    const counts = await js<Record<string, number>>(
      'Object.fromEntries([...new Set(window.lazyReads.map(r=>r.key))].map(k=>[k,window.lazyReads.filter(r=>r.key===k).length]))'
    );
    // The open PR's files, and the first few of the predicted next PR, warmed after them.
    const byPr = await js<Record<string, number>>('window.lazyReads.reduce((m,r)=>(m[r.url]=(m[r.url]??0)+1,m),{})');
    const open = await js<string>("window.lazyReads.find(r=>r.path==='src/lazy/h003.rs').url");
    console.log(`Reads by PR: ${JSON.stringify(byPr)}; prefetch read ${order.length} handler files in diff order`);
    assert.equal(byPr[open], LAZY_FILES, 'Every supported lazy file of the open PR is read');
    for (const [url, n] of Object.entries(byPr))
      if (url !== open) assert.ok(n <= 4, `The predicted next PR warms its first four files at most (${url}: ${n})`);
    const prs = Object.keys(byPr).length;
    assert.deepEqual(
      Object.entries(counts).filter(([, n]) => n !== 1),
      [],
      'Each file is read once: view reads, prefetch and gap reveals share it'
    );
    assert.deepEqual(
      await js("[...new Set(window.lazyReads.filter(r=>r.path==='src/lazy/cleanup.rs').map(r=>r.side))]"),
      ['both'],
      'A file whose hunk only deletes loads both sides'
    );

    // ── A file the reader never reached has its breadcrumb as soon as it shows, with no read ──
    const reads = await js<number>('window.lazyReads.length');
    await js("window.treeClick('h020.rs')");
    await wait(`window.symbols('src/lazy/h020.rs').length>=1`, 50);
    assert.deepEqual(await js('window.symbols("src/lazy/h020.rs")'), ['mod api › impl Client20 › fn handler_20']);
    await js("window.treeClick('cleanup.rs')");
    await wait(`window.symbols('src/lazy/cleanup.rs').length>=1`, 50);
    assert.deepEqual(await js('window.symbols("src/lazy/cleanup.rs")'), ['fn cleanup']);
    await js("window.treeClick('panel.ts')");
    await wait(`window.symbols('src/lazy/panel.ts').length>=1`, 50);
    assert.deepEqual(await js('window.symbols("src/lazy/panel.ts")'), ['class Panel › open()']);
    await js(`document.querySelector('.commit-diff-stream').scrollTop+=window.row('src/lazy/panel.ts').querySelector('.diff-gap-scope').closest('.diff-gap').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top-40`);
    await shot('ts-breadcrumb', '.commit-stream-row[data-file="src/lazy/panel.ts"] .diff-gap:has(.diff-gap-scope)');
    // Revisits: back to the overview and into Changes again, and through every file. Nothing is read again.
    await click('Summary');
    await sleep(300);
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').length>0");
    for (const name of ['h005.rs', 'h011.rs', 'h017.rs', 'h022.rs']) {
      await js(`window.treeClick(${JSON.stringify(name)})`);
      await wait(`window.symbols('src/lazy/${name}').length>=1`, 50);
    }
    assert.equal(await js<number>('window.lazyReads.length'), reads, 'Revisits read nothing again');
    const total = await js<number>('window.lazyReads.length');
    console.log(
      `Read cost: ${total} contents reads in all: ${byPr[open]} for the open PR's ${LAZY_FILES} supported files, each once, and ${total - byPr[open]} warming the predicted next PR (${prs} PRs)`
    );

    // ── Settings › Appearance › Code intelligence: turning Rust off removes its breadcrumbs, and TypeScript keeps its ──
    await js(`(async()=>{const prefs=await window.electronAPI.loadPreferences();
      const next={...prefs,codeIntelligence:{enabled:true,disabled:['rust']}};
      await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}))})()`);
    await wait(`window.symbols('src/lazy/h022.rs').length===0`, 100);
    assert.equal(await js<number>(`window.row('src/lazy/h022.rs').querySelectorAll('[data-show-definition]').length`), 0);
    await js("window.treeClick('panel.ts')");
    await wait(`window.symbols('src/lazy/panel.ts').length>=1`, 50);
    // Timings keep the last 50 parses: mark the newest, and look for Rust parses after it.
    await js("(async()=>{window.parseMark=(await import('/lib/syntax-scope-client.ts')).syntaxTimings.at(-1)})()");
    await js("window.treeClick('store.rs')");
    await sleep(800);
    assert.deepEqual(await js('window.symbols("src/store.rs")'), [], 'A Rust file shows no structure');
    assert.deepEqual(
      await js<string[]>(
        "(async()=>{const t=(await import('/lib/syntax-scope-client.ts')).syntaxTimings;return t.slice(t.indexOf(window.parseMark)+1).filter(e=>e.language==='rust').map(e=>e.key)})()"
      ),
      [],
      'Nothing in Rust is parsed while Rust is off'
    );
    // ═══ A pinned header follows the reader (#395): the definitions around the top line in view, and that line ═══
    // `src/span.ts` is one long hunk across alpha() and beta(); beta()'s new lines are one past its old ones.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope&syntax-span`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.__longTasks=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask'});void 0`);
    await installSticky();
    await js(`window.symbols=p=>[...(window.stickyRow(p)?.querySelectorAll('.diff-gap-scope:not([data-provisional]) .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));void 0`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='span.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='span.ts').click()");
    await wait(`window.symbols('src/span.ts').length>=1`);
    await sleep(1700);
    assert.deepEqual(await js('window.symbols("src/span.ts")'), ['top level'], 'Unpinned, the header names the hunk: it spans two functions');
    type Live = { stuck: boolean; live?: string; crumb: string; line: string; own: string; height: number; shown: string };
    const readerAt = (line: number) =>
      js<Live>(`(async()=>{const section=window.stickyRow('src/span.ts').querySelector('.diff-hunk');
        const target=window.deepAll('[data-line]',section).find(e=>e.dataset.line==='${line}'&&e.dataset.lineType!=='change-deletion'&&e.getBoundingClientRect().height>0);
        target.scrollIntoView({block:'start',behavior:'instant'});
        for(let i=0;i<3;i++)await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>setTimeout(r,120));
        const h=section.querySelector('[data-hunk-header]');
        return {stuck:h.hasAttribute('data-stuck'),live:h.dataset.live,crumb:h.querySelector('.diff-gap-live').textContent.trim(),line:h.querySelector('.diff-gap-live-line').textContent,
          own:window.headerLabel(h),height:Math.round(h.getBoundingClientRect().height),shown:getComputedStyle(h.querySelector('.diff-gap-live')).visibility}})()`);
    const inAlpha = await readerAt(30);
    console.log('Reader in alpha():', JSON.stringify(inAlpha));
    assert.ok(inAlpha.stuck && inAlpha.live === 'scope' && inAlpha.shown === 'visible', `The pinned header follows the reader: ${JSON.stringify(inAlpha)}`);
    assert.equal(inAlpha.crumb, 'function alpha()', 'Pinned inside alpha(), the header names alpha()');
    assert.match(inAlpha.line, /^(old )?L(29|30|31)$/, 'and the line at the top of the view');
    const inBeta = await readerAt(100);
    console.log('Reader in beta():', JSON.stringify(inBeta));
    assert.equal(inBeta.crumb, 'function beta()', 'Scrolled into beta(), the pinned header names beta()');
    assert.match(inBeta.line, /^L(99|100|101)$|^old L(98|99|100)$/, 'in its own side’s numbers');
    assert.equal(inBeta.height, inAlpha.height, 'The swap never changes the header’s height');
    assert.equal(inBeta.own, 'top level', 'The header still describes its hunk for screen readers');
    assert.equal(
      await js<string | null>("window.stickyRow('src/span.ts').querySelector('[data-hunk-header] .diff-gap-live').closest('[aria-live]')?.getAttribute('aria-live') ?? null"),
      null,
      'Nothing is announced as the reader scrolls'
    );
    // Following costs one hit test a frame at most, only while a header is pinned.
    const following = await js<{ frames: number; p50: number; max: number; longTasks: number[]; places: number }>(`(async()=>{
      const s=window.stream();const section=window.stickyRow('src/span.ts').querySelector('.diff-hunk');
      s.scrollTop+=section.getBoundingClientRect().top-s.getBoundingClientRect().top+200;await new Promise(r=>setTimeout(r,300));
      const h=section.querySelector('[data-hunk-header]');let places=0;const watch=new MutationObserver(l=>places+=l.length);watch.observe(h,{attributeFilter:['data-live-key']});
      window.__longTasks=[];const deltas=[];let last=performance.now();
      for(let i=0;i<120;i++){s.scrollTop+=20;await new Promise(r=>requestAnimationFrame(r));const now=performance.now();deltas.push(now-last);last=now}
      await new Promise(r=>setTimeout(r,100));watch.disconnect();deltas.sort((a,b)=>a-b);
      return {frames:deltas.length,p50:Math.round(deltas[deltas.length>>1]*10)/10,max:Math.round(deltas.at(-1)*10)/10,longTasks:window.__longTasks.map(t=>Math.round(t.duration)),places}})()`);
    console.log('Scrolling span.ts 20 px a frame, following the reader:', JSON.stringify(following));
    assert.deepEqual(following.longTasks, [], 'Following the reader adds no long task');
    assert.ok(following.places > 10, `The header follows line by line: ${following.places}`);
    await shot('follow-alpha', '.commit-diff-stream');

    // ═══ A pinned crumb goes to its definition (#417): it reveals the lines down to the reader, and scrolls there ═══
    // `src/runner.ts`: run() inside class ProductionRunner, whose first line is hidden in the gap above run()'s hunk.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='runner.ts').click()");
    await wait(`window.symbols('src/runner.ts').length>=1`);
    await sleep(1200);
    // The diff's own width, not the window's: Windows CI desktops are 1024 px wide.
    await js(`window.stickyRow('src/runner.ts').querySelector('.changes-diff').style.width='680px';void 0`);
    await js(`window.jumpState=p=>{const row=window.stickyRow(p);const file=row.querySelector('.changes-file-header').getBoundingClientRect();
        const h=row.querySelector('[data-hunk-header][data-stuck]');const r=h?.getBoundingClientRect();const active=document.activeElement;
        return {file:Math.round(file.bottom),stuck:!!h,live:h?.dataset.live??null,top:r?Math.round(r.top):null,bottom:r?Math.round(r.bottom):null,height:r?Math.round(r.height):null,
          lines:window.deepAll('[data-line]',row).length,hidden:[...row.querySelectorAll('.diff-gap[data-gap]')].map(g=>g.getAttribute('aria-label')).join('|'),
          crumbs:h?[...h.querySelectorAll('.diff-gap-live button[data-jump]')].map(b=>({label:b.getAttribute('aria-label'),side:b.dataset.side,shown:getComputedStyle(b).visibility,
            hit:Math.round(parseFloat(getComputedStyle(b,'::after').height)),tab:b.tabIndex})):[],
          hidden_slot:h?.querySelector('.diff-gap-live')?.getAttribute('aria-hidden')??null,slotLabel:h?.querySelector('.diff-gap-live')?.getAttribute('aria-label')??null,
          active:active?.matches?.('.diff-gap-live button[data-jump]')?active.getAttribute('aria-label'):null,
          ring:active?.matches?.(':focus-visible')?getComputedStyle(active).outlineStyle:null}};
      window.lineTop=(p,text,deleted)=>{const l=window.deepAll('[data-line]',window.stickyRow(p)).find(e=>e.textContent.includes(text)&&(e.dataset.lineType==='change-deletion')===!!deleted&&e.getBoundingClientRect().height>0);return l?Math.round(l.getBoundingClientRect().top):null};
      window.sectionTop=(p,i)=>Math.round(window.stickyRow(p).querySelectorAll('.diff-hunk')[i].getBoundingClientRect().top);
      // Scrolls the line with \`text\` to right under the pinned file and hunk headers, where the pinned header names it.
      window.pinAt=async(p,text,deleted)=>{const s=window.stream();let l;
        // Files above mount and settle their heights as they come near: aim again until the line holds still.
        // A wheel event ends any hold on the view, as the reader's own scrolling does.
        for(let i=0,still=0;i<80&&still<5;i++){l=window.deepAll('[data-line]',window.stickyRow(p)).find(e=>e.textContent.includes(text)&&(e.dataset.lineType==='change-deletion')===!!deleted&&e.getBoundingClientRect().height>0);
          if(!l)throw Error('No line '+text+' in '+p);const row=window.stickyRow(p);const under=row.querySelector('.changes-file-header').getBoundingClientRect().bottom-1+row.querySelector('[data-hunk-header]').offsetHeight;const off=l.getBoundingClientRect().top-under;
          if(Math.abs(off)>1){s.dispatchEvent(new WheelEvent('wheel'));s.scrollTop+=off;still=0}else still++;
          for(let f=0;f<2;f++)await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>setTimeout(r,40))}
        await new Promise(r=>setTimeout(r,100));
        return {line:Math.round(l.getBoundingClientRect().top-s.getBoundingClientRect().top),scrollTop:Math.round(s.scrollTop),max:s.scrollHeight-s.clientHeight}};
      // Where a jump landed (#417): the line or gap bar marked "here" (lib/diff-here.ts), its band's animation and colour,
      // whether its gutter cell is marked too, the gutter's bar, and its box.
      window.hereMarks=root=>window.deepAll('[data-here]',root).filter(e=>!e.matches('[data-column-number]')).map(e=>{const bar=e.matches('.diff-gap');const c=getComputedStyle(e,bar?'::before':'::after');const r=e.getBoundingClientRect();
        const i=e.getAttribute('data-line-index');const col=e.closest('[data-deletions],[data-additions]')??e.closest('[data-code]');const g=i!==null&&col?col.querySelector('[data-column-number][data-line-index="'+i+'"]'):null;
        return {kind:e.matches('[data-line]')?'line':bar?'bar':'other',text:e.textContent.trim().slice(0,40),anim:c.animationName.replace(/-[ab]$/,''),band:c.backgroundColor,gutter:g?g.getAttribute('data-here')!==null:null,
          edge:g?getComputedStyle(g,'::after').boxShadow:bar?c.boxShadow:null,top:Math.round(r.top),height:Math.round(r.height)}});
      window.jumped=p=>window.hereMarks(window.stickyRow(p));
      // Distinct shown lines whose text has \`text\`, by their number.
      window.shownCount=(p,text)=>new Set(window.deepAll('[data-line]',window.stickyRow(p)).filter(e=>e.textContent.includes(text)&&e.getBoundingClientRect().height>0).map(e=>e.textContent)).size;
      // The stream's scrollTop each frame, for 90 frames, into window.__samples.
      window.sampleScroll=()=>{const s=window.stream();const v=[];window.__samples=v;let n=0;const t=()=>{v.push(Math.round(s.scrollTop));if(++n<90)requestAnimationFrame(t)};requestAnimationFrame(t);void 0};
      window.crumbCenter=(p,label)=>{const b=[...window.stickyRow(p).querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].find(b=>b.getAttribute('aria-label')===label);
        if(!b)throw Error('No pinned crumb '+label);const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};void 0`);
    type Jump = {
      file: number;
      stuck: boolean;
      live: string | null;
      top: number | null;
      bottom: number | null;
      height: number | null;
      lines: number;
      hidden: string;
      crumbs: { label: string; side: string; shown: string; hit: number; tab: number }[];
      hidden_slot: string | null;
      slotLabel: string | null;
      active: string | null;
      ring: string | null;
    };
    type Flash = { kind: string; text: string; anim: string; band: string; gutter: boolean | null; edge: string | null; top: number; height: number };
    const jumpState = (path: string) => js<Jump>(`window.jumpState(${JSON.stringify(path)})`);
    // A jump ends with its flash.
    const afterJump = async () => {
      await sleep(100);
      await wait(`window.deepAll('[data-here]',window.stream()).length>0`, 60);
      await settle();
    };
    const clickCrumb = async (path: string, label: string) => {
      const point = await js<{ x: number; y: number }>(`window.crumbCenter(${JSON.stringify(path)},${JSON.stringify(label)})`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await afterJump();
    };
    const press = async (keyCode: string, char?: string, modifiers: ('shift')[] = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await sleep(60);
    };
    const CLASS = 'Go to class ProductionRunner';
    const RUN = 'Go to function run';
    console.log('Pinning inside run():', JSON.stringify(await js(`window.pinAt('src/runner.ts','value += 50 * 2;')`)));
    await wait(`window.jumpState('src/runner.ts').crumbs.length===2`);
    const pinned = await jumpState('src/runner.ts');
    console.log('Pinned inside run():', JSON.stringify(pinned));
    assert.ok(pinned.stuck && pinned.live === 'scope', `The header is pinned and follows the reader: ${JSON.stringify(pinned)}`);
    assert.deepEqual(pinned.crumbs.map((c) => c.label), [CLASS, RUN], 'Each pinned crumb is a button named for where it goes');
    assert.ok(pinned.crumbs.every((c) => c.shown === 'visible' && c.tab === 0), 'The pinned crumbs show and are in the tab order');
    assert.ok(pinned.crumbs.every((c) => c.hit >= 24), `Each pinned crumb's target is at least 24 px tall: ${JSON.stringify(pinned.crumbs)}`);
    assert.equal(pinned.hidden_slot, null, 'The pinned crumbs are not hidden from screen readers');
    assert.match(pinned.slotLabel ?? '', /^In runner\.ts, class ProductionRunner, function run$/, 'The pinned location has the hunk breadcrumb’s label');
    await shot('crumb-jump-before', '.commit-diff-stream');
    // The class's first line is hidden in the gap above run()'s hunk: the click shows every line from it down to the
    // hunk, and nothing above it, then scrolls it right under the pinned header, and it flashes.
    assert.equal(pinned.hidden, '20 lines hidden|3 lines hidden', 'The class line starts hidden');
    await clickCrumb('src/runner.ts', CLASS);
    const toClass = await jumpState('src/runner.ts');
    const classTop = await js<number>(`window.lineTop('src/runner.ts','export class ProductionRunner {')`);
    console.log('After the class crumb:', JSON.stringify({ ...toClass, crumbs: undefined }), 'line at', classTop);
    assert.ok(toClass.bottom !== null && Math.abs(classTop - toClass.bottom) <= 2, `The class's first line sits right under the pinned header: ${classTop} vs ${toClass.bottom}`);
    assert.equal(toClass.hidden, '1 line hidden|3 lines hidden', 'Every line from the class line down shows; the line above it stays hidden');
    assert.equal(await js<number>(`window.shownCount('src/runner.ts','readonly slot')`), 18, 'All the lines between the class line and the hunk show');
    assert.equal(await js<number>(`window.shownCount('src/runner.ts','Pinned crumb fixture')`), 0, 'Nothing above the class line shows');
    assert.ok(toClass.lines > pinned.lines, 'The lines were revealed');
    assert.equal(toClass.height, pinned.height, 'Pinning never changes the header’s height');
    const classFlash = await js<Flash[]>(`window.jumped('src/runner.ts')`);
    console.log('Flash after the class crumb:', JSON.stringify(classFlash));
    assert.deepEqual(classFlash.map((f) => [f.kind, f.anim, f.text, f.gutter]), [['line', 'gnosis-here-band', 'export class ProductionRunner {', true]], 'The class line is marked here, with its gutter cell');
    await shot('crumb-jump-after-class', '.commit-diff-stream');
    // From the keyboard: Enter on the innermost crumb goes to run()'s first line, under the pinned headers; focus stays.
    await js(`window.pinAt('src/runner.ts','value += 60 * 2;')`);
    await js('document.activeElement?.blur()');
    await wait(`window.jumpState('src/runner.ts').crumbs.length===2`);
    // Tab reaches the pinned crumbs: into the outer one, then on to the innermost.
    await js(`[...window.stickyRow('src/runner.ts').querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(CLASS)}).focus()`);
    await press('Tab');
    const crumbFocus = await jumpState('src/runner.ts');
    assert.equal(crumbFocus.active, RUN, 'Tab moves to the innermost pinned crumb');
    assert.ok(crumbFocus.stuck && crumbFocus.live === 'scope' && crumbFocus.crumbs.every((c) => c.shown === 'visible'), `Focus keeps the pinned crumbs: ${JSON.stringify(crumbFocus)}`);
    assert.ok(crumbFocus.ring && crumbFocus.ring !== 'none', `The focus ring shows: ${crumbFocus.ring}`);
    await press('Enter', '\r');
    await afterJump();
    const toRun = await jumpState('src/runner.ts');
    const runTop = await js<number>(`window.lineTop('src/runner.ts','run(input: number): number {')`);
    console.log('After Enter on run():', JSON.stringify({ ...toRun, crumbs: undefined }), 'line at', runTop);
    assert.ok(toRun.stuck && toRun.bottom !== null && Math.abs(runTop - toRun.bottom) <= 2, `run()'s first line sits right under the pinned header: ${runTop} vs ${toRun.bottom}`);
    assert.equal(toRun.active, RUN, 'Focus stays on the pinned crumb');
    assert.equal(toRun.lines, toClass.lines, 'Nothing more was revealed: run()’s first line showed');
    assert.equal(toRun.height, pinned.height, 'The header keeps its height');
    // The line it landed on flashes, as a review check's line does, and only that line; nothing moves.
    const runFlash = await js<Flash[]>(`window.jumped('src/runner.ts')`);
    console.log('Flash after Enter on run():', JSON.stringify(runFlash));
    assert.equal(runFlash.length, 1, `Only the line jumped to flashes; the bar's flash ended: ${JSON.stringify(runFlash)}`);
    assert.deepEqual([runFlash[0].kind, runFlash[0].anim, runFlash[0].gutter], ['line', 'gnosis-here-band', true], 'The line is marked here');
    assert.match(runFlash[0].edge ?? '', /inset/, `The gutter carries the bar: ${runFlash[0].edge}`);
    assert.match(runFlash[0].text, /run\(input: number\): number \{/, 'It is the definition’s first line');
    assert.equal(runFlash[0].top, runTop, 'The flash moves nothing');
    await sleep(2100);
    assert.deepEqual(await js(`window.jumped('src/runner.ts')`), [], 'The band goes after 2 s');
    assert.equal(await js<number>(`window.deepAll('[data-here]',window.stickyRow('src/runner.ts')).length`), 0, 'and from the gutter too');
    assert.equal(await js<number>(`window.lineTop('src/runner.ts','run(input: number): number {')`), runTop, 'and nothing moved');
    assert.equal((await jumpState('src/runner.ts')).lines, toClass.lines, 'Nothing was revealed');
    // Reduced motion: the settled band, still, for as long, with no animation.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true, 'Reduced motion is emulated');
    await press('Enter', '\r');
    await afterJump();
    const stillFlash = await js<Flash[]>(`window.jumped('src/runner.ts')`);
    console.log('Flash with reduced motion:', JSON.stringify(stillFlash));
    assert.deepEqual(stillFlash.map((f) => [f.kind, f.anim, f.band]), [['line', 'none', 'rgba(47, 85, 212, 0.22)']], 'Reduced motion: a still band, no animation');
    await sleep(2100);
    assert.deepEqual(await js(`window.jumped('src/runner.ts')`), [], 'The still band goes too');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();
    await shot('crumb-jump-keyboard', '.commit-diff-stream');
    // Mid-flash, light and dark: Enter again on the same crumb flashes the line again.
    if (process.env.GNOSIS_SYNTAX_SCOPE_SHOT)
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await settle();
        await press('Enter', '\r');
        await wait(`window.jumped('src/runner.ts').length>0`, 50);
        await sleep(120);
        const r = await js<{ x: number; y: number; width: number; height: number }>(
          `(()=>{const b=document.querySelector('.commit-diff-stream').getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:220}})()`
        );
        console.log(`SHOT crumb-jump-flash-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
      }
    await js(`document.documentElement.classList.toggle('dark',false)`);
    // Shift+Tab reaches the class crumb; Space goes there.
    await press('Tab', undefined, ['shift']);
    assert.equal((await jumpState('src/runner.ts')).active, CLASS, 'Shift+Tab moves to the outer pinned crumb');
    await press('Space', ' ');
    await afterJump();
    const bySpace = await js<number>(`window.lineTop('src/runner.ts','export class ProductionRunner {')`);
    const spaced = await jumpState('src/runner.ts');
    assert.ok(spaced.bottom !== null && Math.abs(bySpace - spaced.bottom) <= 2, `Space goes to the class line too: ${bySpace} vs ${spaced.bottom}`);
    assert.equal(spaced.lines, toClass.lines, 'Nothing more was revealed');
    await js('document.activeElement?.blur()');
    // A hunk that only deletes (`src/pruner.ts`): a deleted line is named by the old file's definitions, and its
    // crumbs go to their first lines by their old numbers: prune()'s shows, Pruner's is revealed from the gap above.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='pruner.ts').click()");
    await wait(`window.symbols('src/pruner.ts').length>=1`);
    await sleep(1200);
    await js(`window.stickyRow('src/pruner.ts').querySelector('.changes-diff').style.width='680px';void 0`);
    await js(`window.pinAt('src/pruner.ts','n += 50;',true)`);
    await wait(`window.jumpState('src/pruner.ts').crumbs.length===2`);
    const inOld = await jumpState('src/pruner.ts');
    console.log('Pinned on a deleted line in prune():', JSON.stringify(inOld.crumbs));
    assert.deepEqual(
      inOld.crumbs.map((c) => [c.label, c.side]),
      [['Go to class Pruner', 'before'], ['Go to function prune', 'before']],
      'Deleted lines use the old side’s definitions'
    );
    await clickCrumb('src/pruner.ts', 'Go to function prune');
    const toPrune = await jumpState('src/pruner.ts');
    const pruneTop = await js<number>(`window.lineTop('src/pruner.ts','prune(): number {')`);
    assert.ok(toPrune.bottom !== null && Math.abs(pruneTop - toPrune.bottom) <= 2, `prune()'s first line sits right under the pinned header: ${pruneTop} vs ${toPrune.bottom}`);
    assert.equal(toPrune.lines, inOld.lines, 'Nothing was revealed');
    await js(`window.pinAt('src/pruner.ts','n += 70;',true)`);
    await clickCrumb('src/pruner.ts', 'Go to class Pruner');
    const toPruner = await jumpState('src/pruner.ts');
    const prunerTop = await js<number>(`window.lineTop('src/pruner.ts','export class Pruner {')`);
    assert.ok(toPruner.bottom !== null && Math.abs(prunerTop - toPruner.bottom) <= 2, `Pruner's first line sits right under the pinned header: ${prunerTop} vs ${toPruner.bottom}`);
    assert.equal(await js<number>(`window.shownCount('src/pruner.ts','readonly mark')`), 18, 'All the lines between the class line and the hunk show');
    assert.equal(await js<number>(`window.shownCount('src/pruner.ts','Pinned crumb fixture')`), 0, 'Nothing above the class line shows');
    assert.match(toPruner.hidden, /^1 line hidden\|/, `Only the line above the class stays hidden: ${toPruner.hidden}`);
    assert.deepEqual((await js<Flash[]>(`window.jumped('src/pruner.ts')`)).map((f) => f.text), ['export class Pruner {'], 'The class line flashes');
    // A sliced hunk (#353): the target's slice is far above, outside the viewport, and lands as exactly.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='sticky.ts').click()");
    await wait(`window.symbols('src/sticky.ts').length>=2`);
    await sleep(1200);
    await js(`window.pinAt('src/sticky.ts','value -= 190 * 2;')`);
    await wait(`window.jumpState('src/sticky.ts').crumbs.length>0`);
    const inSecond = await jumpState('src/sticky.ts');
    assert.ok(inSecond.crumbs.some((c) => c.label === 'Go to function second'), `Pinned in second(): ${JSON.stringify(inSecond.crumbs)}`);
    await clickCrumb('src/sticky.ts', 'Go to function second');
    const toSecond = await jumpState('src/sticky.ts');
    const secondTop = await js<number>(`window.lineTop('src/sticky.ts','export function second(')`);
    assert.ok(toSecond.bottom !== null && Math.abs(secondTop - toSecond.bottom) <= 2, `second()'s first line sits right under the pinned header: ${secondTop} vs ${toSecond.bottom}`);
    assert.equal(toSecond.hidden, inSecond.hidden, 'Nothing was revealed');
    assert.equal(toSecond.height, inSecond.height, 'The header keeps its height');
    // A large reveal (`src/far.ts`): 230 hidden lines between the class line and work(). The jump reveals them, then
    // eases there over several frames, with no long task, and lands on the class line.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='far.ts').click()");
    await wait(`window.symbols('src/far.ts').length>=1`);
    await sleep(1200);
    await js(`window.stickyRow('src/far.ts').querySelector('.changes-diff').style.width='680px';void 0`);
    await js(`window.pinAt('src/far.ts','total += 40 * 2;')`);
    await wait(`window.jumpState('src/far.ts').crumbs.length===2`);
    const inWork = await jumpState('src/far.ts');
    assert.match(inWork.hidden, /^231 lines hidden/, `The class line starts 231 lines into the hidden gap: ${inWork.hidden}`);
    await js('window.__longTasks=[];window.sampleScroll()');
    const revealStart = Date.now();
    await clickCrumb('src/far.ts', 'Go to class FarRunner');
    const revealMs = Date.now() - revealStart;
    await wait('window.__samples.length>=90');
    const toFar = await jumpState('src/far.ts');
    const farTop = await js<number>(`window.lineTop('src/far.ts','export class FarRunner {')`);
    const samples = await js<number[]>('window.__samples');
    const steps = samples.filter((v, i) => i > 0 && v !== samples[i - 1]).length;
    const longTasks = await js<{ duration: number }[]>('window.__longTasks');
    console.log('Large reveal:', JSON.stringify({ revealMs, steps, longTasks: longTasks.map((t) => Math.round(t.duration)), hidden: toFar.hidden, lines: [inWork.lines, toFar.lines] }));
    assert.ok(toFar.bottom !== null && Math.abs(farTop - toFar.bottom) <= 2, `The class line sits right under the pinned header after the reveal: ${farTop} vs ${toFar.bottom}`);
    assert.equal(await js<number>(`window.shownCount('src/far.ts','readonly far')`), 230, 'All 230 lines between the class line and the hunk show');
    assert.equal(await js<number>(`window.shownCount('src/far.ts','Pinned crumb fixture')`), 0, 'Nothing above the class line shows');
    assert.ok(steps >= 4, `The scroll eases over several frames: ${JSON.stringify(samples)}`);
    assert.deepEqual(longTasks.map((t) => Math.round(t.duration)), [], 'Revealing 230 lines and easing there leaves no long task');
    assert.deepEqual((await js<Flash[]>(`window.jumped('src/far.ts')`)).map((f) => f.text), ['export class FarRunner {'], 'The class line flashes');
    // The reader's wheel stops the scroll part way.
    await js(`window.pinAt('src/far.ts','total += 50 * 2;')`);
    await wait(`window.jumpState('src/far.ts').crumbs.length===2`);
    const beforeCancel = await js<number>('Math.round(window.stream().scrollTop)');
    const cancelAt = await js<{ x: number; y: number }>(`window.crumbCenter('src/far.ts','Go to class FarRunner')`);
    // Three frames into the jump's scroll, a wheel event.
    await js(`(()=>{const s=window.stream();s.addEventListener('scroll',()=>{let n=0;const t=()=>{if(++n===3)s.dispatchEvent(new WheelEvent('wheel'));else requestAnimationFrame(t)};requestAnimationFrame(t)},{once:true})})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cancelAt.x, y: cancelAt.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cancelAt.x, y: cancelAt.y, button: 'left', clickCount: 1 });
    await sleep(900);
    const cancelled = await js<number>('Math.round(window.stream().scrollTop)');
    const stillFar = await js<number>(`window.lineTop('src/far.ts','export class FarRunner {')`);
    console.log('Cancelled jump:', JSON.stringify({ beforeCancel, cancelled, classLine: stillFar }));
    assert.ok(stillFar === null || Math.abs(stillFar - (inWork.bottom ?? 0)) > 50, 'Wheel input stops the scroll before it lands');
    assert.deepEqual(await js(`window.jumped('src/far.ts')`), [], 'A stopped jump does not flash');
    // Reduced motion: the jump lands in one frame.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await js(`window.pinAt('src/far.ts','total += 40 * 2;')`);
    await wait(`window.jumpState('src/far.ts').crumbs.length===2`);
    await js('window.sampleScroll()');
    await clickCrumb('src/far.ts', 'Go to class FarRunner');
    await wait('window.__samples.length>=90');
    const instant = await js<number[]>('window.__samples');
    const moves = instant.filter((v, i) => i > 0 && v !== instant[i - 1]);
    console.log('Reduced-motion jump scrollTops:', JSON.stringify(moves));
    assert.ok(moves.length >= 1 && Math.abs(moves[0] - instant.at(-1)!) <= 2, `Reduced motion: the first move lands: ${JSON.stringify(moves)}`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();

    // ═══ Pinned hunk headers in the stack's Changes (#395) ═══
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.symbols=p=>[...(window.stickyRow(p)?.querySelectorAll('.diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      void 0;`);
    await installSticky();
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('bounded command queue')).click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open stack overview')");
    await click('Open stack overview');
    await wait("!!document.querySelector('.pr-overview-tabs')");
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='sticky.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='sticky.ts').click()");
    await wait(`window.symbols('src/sticky.ts').length>=2`);
    await sleep(1700);
    await checkPinned('Stack changes', 'src/sticky.ts', stickyCrumbs);
    await shot('stack-sticky-mid-hunk', '.commit-diff-stream');
    assert.deepEqual(errors, [], 'No console errors');
    console.log(
      'Syntax scope browser checks passed: breadcrumbs, crumb reveals, Show whole function, default open, fallback, worker parsing, loading on view, prefetch, the read bound, the language setting and pinned hunk headers.'
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
