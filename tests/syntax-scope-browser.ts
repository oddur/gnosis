import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Enclosing definitions in Changes (#393), on the synthetic files in tests/fixtures/syntax-scope.ts.
 *
 * - Each hunk's bar is a breadcrumb of the file and the definitions around the hunk, in TypeScript and Rust; deleted
 *   lines use the old file's tree. A long chain keeps the file and the innermost two crumbs; the whole chain is the
 *   tooltip and the accessible label. A crumb reveals its definition.
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
            onTop:!!hit&&h.contains(hit),controls:[...h.querySelectorAll(':is(.diff-gap-gutter,.diff-gap-controls) > button')].map(b=>getComputedStyle(b).opacity)}})};
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
   * Hunk header review: with GNOSIS_HUNK_HEADER_SHOTS=1, renders the hunk header's cases in
   * light and dark, prints them as `HHSHOT <name> <base64 PNG>` lines and the header's colours and alignment as
   * `HHMETRIC <json>`, and skips the checks.
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
    // From the stream's top: the file header, the pinned hunk header and the code under it.
    const streamTop = (height: number) =>
      `(()=>{const b=document.querySelector('.commit-diff-stream').getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:${height}}})()`;
    // Around one bar: the code above and below it.
    const around = (selector: string, margin = 64) =>
      `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const y=Math.max(Math.round(s.top),Math.round(b.top-${margin}));return {x:Math.round(s.left),y,width:Math.round(s.width),height:Math.round(Math.min(b.bottom+${margin},s.bottom)-y)}})()`;
    // Colours of a header's parts as sRGB, through a canvas, and where its breadcrumb and the code's text start.
    const metrics = (header: string) =>
      js<Record<string, unknown>>(`(()=>{const h=${header};const c=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const rgb=v=>{if(!v)return null;c.clearRect(0,0,1,1);c.fillStyle='#000';c.fillStyle=v;c.fillRect(0,0,1,1);const d=c.getImageData(0,0,1,1).data;return '#'+[d[0],d[1],d[2]].map(n=>n.toString(16).padStart(2,'0')).join('')};
        const color=sel=>{const e=h.querySelector(sel);return e?rgb(getComputedStyle(e).color):null};
        const cs=getComputedStyle(h);
        const section=h.closest('.diff-hunk');
        const line=section&&window.deepAll('[data-line]',section).find(e=>e.getBoundingClientRect().width>0);
        const code=line?line.getBoundingClientRect().left+parseFloat(getComputedStyle(line).paddingLeft):null;
        const crumb=h.querySelector('.diff-gap-symbol,.diff-gap-scope');
        return {background:rgb(cs.backgroundColor),name:color('.diff-gap-crumb[data-innermost]'),outer:color('.diff-gap-crumb[data-crumb-file]'),kind:color('.diff-gap-kind'),
          separator:color('.diff-gap-crumb-separator'),range:color('.diff-gap-range'),count:color('.diff-gap-count'),button:color('.diff-gap-text'),
          rule:rgb(cs.getPropertyValue('--diff-change').trim()),change:h.dataset.change,height:Math.round(h.getBoundingClientRect().height),
          crumbLeft:crumb?Math.round(crumb.getBoundingClientRect().left*10)/10:null,codeLeft:code===null?null:Math.round(code*10)/10,
          headerLeft:Math.round(h.getBoundingClientRect().left*10)/10}})()`);
    const metric = async (variant: string, name: string, header: string) => {
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js(frames);
        console.log(`HHMETRIC ${JSON.stringify({ variant, case: name, theme: dark ? 'dark' : 'light', ...(await metrics(header)) })}`);
      }
    };
    const select = (name: string) => js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
    for (const variant of ['final']) {
      win.setContentSize(1280, 800);
      await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope`);
      await waitForWorkbenchQueue(win.webContents);
      await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
        window.symbols=p=>[...(window.stickyRow(p)?.querySelectorAll('.diff-gap-scope:not([data-provisional]) .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));void 0`);
      await installSticky();
      await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
      await click('Open PR overview');
      await click('Changes');
      await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='sticky.ts')");
      // (1) Pinned, mid-hunk.
      await select('sticky.ts');
      await wait(`window.symbols('src/sticky.ts').length>=2`);
      await sleep(1700);
      await js(`window.toMiddle('src/sticky.ts',1)`);
      await settle();
      const pinned = `window.stickyRow('src/sticky.ts').querySelectorAll('.diff-hunk')[1].querySelector('[data-hunk-header]')`;
      await capture(`${variant}-pinned`, streamTop(300));
      await metric(variant, 'pinned', pinned);
      // (2) A bar with its controls, on store.rs: the chevrons, Show all and Show whole function.
      await select('store.rs');
      await wait(`window.symbols('src/store.rs').length>=5`);
      await sleep(1700);
      const bar = `.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-gap]:has(.diff-gap-gutter button):has([data-show-definition])`;
      console.log('HHINFO store.rs bars:', JSON.stringify(await js(`[...document.querySelectorAll('.commit-stream-row[data-file="src/store.rs"] .diff-gap')].map(b=>b.textContent.replace(/\\s+/g,' ').trim())`)));
      await js(`(()=>{const s=window.stream();const b=document.querySelector(${JSON.stringify(bar)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await settle();
      await capture(`${variant}-controls`, around(bar));
      await metric(variant, 'controls', `document.querySelector(${JSON.stringify(bar)})`);
      // Keyboard focus on the bar's first chevron.
      await js(`document.querySelector(${JSON.stringify(bar)}).querySelector('.diff-gap-gutter button').focus({preventScroll:true})`);
      await capture(`${variant}-focus`, around(bar, 24));
      await js('document.activeElement.blur()');
      // The rule's colours: cleanup() only deletes (red). No fixture hunk only adds, so green is shown by marking the
      // same bar as added.
      const cleanup = `.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-change=deleted]`;
      await js(`(()=>{const s=window.stream();const b=document.querySelector(${JSON.stringify(cleanup)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await settle();
      await capture(`${variant}-rule-deleted`, around(cleanup, 24));
      await metric(variant, 'rule-deleted', `document.querySelector(${JSON.stringify(cleanup)})`);
      await js(`document.querySelector(${JSON.stringify(cleanup)}).dataset.change='added'`);
      const added = `.commit-stream-row[data-file="src/store.rs"] .diff-gap[data-change=added]`;
      await capture(`${variant}-rule-added-forced`, around(added, 24));
      await metric(variant, 'rule-added-forced', `document.querySelector(${JSON.stringify(added)})`);
      await js(`document.querySelector(${JSON.stringify(added)}).dataset.change='deleted'`);
      // (3) A file with no grammar: the range alone, pinned.
      await select('sticky.rb');
      await wait(`window.stickyRow('src/sticky.rb')?.querySelectorAll('[data-hunk-header]').length===2`);
      await sleep(1700);
      await js(`window.toMiddle('src/sticky.rb',1)`);
      await settle();
      await capture(`${variant}-no-grammar`, streamTop(220));
      await metric(variant, 'no-grammar', `window.stickyRow('src/sticky.rb').querySelectorAll('.diff-hunk')[1].querySelector('[data-hunk-header]')`);
      // C#: a namespace, class and method chain, unpinned.
      await select('Navmesh.cs');
      await wait(`window.symbols('src/Navmesh.cs').length>=1`);
      await sleep(1700);
      const navmesh = `.commit-stream-row[data-file="src/Navmesh.cs"] [data-hunk-header]`;
      await js(`(()=>{const s=window.stream();const b=document.querySelector(${JSON.stringify(navmesh)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await settle();
      await capture(`${variant}-csharp`, around(navmesh));
      await metric(variant, 'csharp', `document.querySelector(${JSON.stringify(navmesh)})`);
      // Split: the breadcrumb still starts at the old side's code column.
      const layout = async (value: string) => {
        await click('Diff appearance');
        await wait(`!!document.querySelector('select[aria-label="Diff layout"]')`);
        await js(`(()=>{const s=document.querySelector('select[aria-label="Diff layout"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        await sleep(300);
      };
      await layout('split');
      await select('store.rs');
      await sleep(1700);
      await js(`(()=>{const s=window.stream();const b=document.querySelector(${JSON.stringify(bar)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await settle();
      await capture(`${variant}-split`, around(bar));
      await metric(variant, 'controls-split', `document.querySelector(${JSON.stringify(bar)})`);
      await layout('unified');
      // Narrow, pinned.
      win.setContentSize(760, 800);
      await sleep(400);
      await select('sticky.ts');
      await sleep(1700);
      await js(`window.toMiddle('src/sticky.ts',1)`);
      await settle();
      await capture(`${variant}-narrow-pinned`, streamTop(300));
      win.setContentSize(1280, 800);
      // (4) Provisional: before its contents load, a hunk shows its patch header's text and Loading structure….
      await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope&syntax-lazy`);
      await waitForWorkbenchQueue(win.webContents);
      await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
        // Queue preparation reads none of the lazy files, and h003.rs's read never finishes.
        for(const name of ['getPrChangeFile','getPrChangeFileAfter']){const read=window.electronAPI[name];window.electronAPI[name]=async(r,...rest)=>{
          if(!r.path.startsWith('src/lazy/'))return read(r,...rest);
          if(name==='getPrChangeFile'&&rest[0])throw Error('This file is too large to preview. Open it on GitHub.');
          if(r.path==='src/lazy/h003.rs')return new Promise(()=>{});return read(r,...rest)}}
        window.treeClick=async name=>{const item=()=>window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);
          const first=window.deepAll('[role=treeitem]')[0];let box=first?.parentElement;while(box&&box.scrollHeight<=box.clientHeight)box=box.parentElement;
          if(box)box.scrollTop=0;for(let i=0;i<60&&!item()&&box;i++){box.scrollTop+=200;await new Promise(r=>requestAnimationFrame(r))}
          const target=item();if(!target)throw Error('Missing tree item '+name);target.click()};void 0`);
      await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
      await click('Open PR overview');
      await click('Changes');
      await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='h003.rs')");
      await js("window.treeClick('h003.rs')");
      const provisional = `.commit-stream-row[data-file="src/lazy/h003.rs"] .diff-gap:has(.diff-gap-scope[data-provisional])`;
      await wait(`!!document.querySelector(${JSON.stringify(provisional)})&&!!document.querySelector('.commit-stream-row[data-file="src/lazy/h003.rs"] [data-structure=loading]')`);
      await sleep(1700);
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const b=document.querySelector(${JSON.stringify(provisional)});s.scrollTop+=b.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await settle();
      await capture(`${variant}-provisional`, around(provisional));
      await metric(variant, 'provisional', `document.querySelector(${JSON.stringify(provisional)})`);
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
    const select = async (name: string) => {
      await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
      await sleep(1700);
    };
    // The file's section at the top of the stream: its chips, then its header.
    const toRow = (path: string) =>
      js(`(()=>{const s=document.querySelector('.commit-diff-stream');const r=window.stickyRow(${JSON.stringify(path)});s.scrollTop+=r.getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    const metrics = (path: string) =>
      js<Record<string, unknown>>(`(()=>{const row=window.stickyRow(${JSON.stringify(path)});const h=row.querySelector('.changes-file-header');const c=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const rgb=v=>{if(!v)return null;c.clearRect(0,0,1,1);c.fillStyle='#000';c.fillStyle=v;c.fillRect(0,0,1,1);const d=c.getImageData(0,0,1,1).data;return '#'+[d[0],d[1],d[2]].map(n=>n.toString(16).padStart(2,'0')).join('')};
        const color=sel=>{const e=h.querySelector(sel);return e?rgb(getComputedStyle(e).color):null};
        const hunk=row.querySelector('.diff-gap[data-hunk-header]');
        return {file:rgb(getComputedStyle(h).backgroundColor),hunk:hunk?rgb(getComputedStyle(hunk).backgroundColor):null,line:rgb(getComputedStyle(h).borderBottomColor),
          name:color('.changes-file-name'),dir:color('.changes-file-dir'),stats:color('.changes-file-stats'),added:color('.diff-stats > :first-child'),deleted:color('.diff-stats > :last-child'),
          button:color('[data-viewed-next]'),label:color('.changes-file-actions label'),rule:rgb(getComputedStyle(h).getPropertyValue('--file-status').trim()),status:h.dataset.status,height:Math.round(h.getBoundingClientRect().height)}})()`);
    const metric = async (name: string, path: string) => {
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js(frames);
        console.log(`FHMETRIC ${JSON.stringify({ case: name, theme: dark ? 'dark' : 'light', ...(await metrics(path)) })}`);
      }
    };
    win.setContentSize(1280, 800);
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope&renamed-file`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`);
    await installSticky();
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='sticky.ts')");
    // Pinned, mid-file, with the hunk's header pinned under it.
    await select('sticky.ts');
    await js(`window.toMiddle('src/sticky.ts',1)`);
    await settle();
    await capture('pinned', streamTop(260));
    await metric('pinned', 'src/sticky.ts');
    // In the flow: the chips above the header.
    await select('store.rs');
    await toRow('src/store.rs');
    await settle();
    await capture('flow', streamTop(200));
    await metric('flow', 'src/store.rs');
    // Renamed, with a long path.
    await select('ECONemoConnector.cs');
    await toRow('src/transport/ECORuntime/Core/ECONemoConnector.cs');
    await settle();
    await capture('renamed', streamTop(160));
    await metric('renamed', 'src/transport/ECORuntime/Core/ECONemoConnector.cs');
    // Added and deleted.
    for (const [name, path] of [['added', 'src/new.ts'], ['deleted', 'src/old.ts']]) {
      await select(path.slice(4));
      await toRow(path);
      await settle();
      await capture(name, streamTop(160));
      await metric(name, path);
    }
    // Keyboard focus: a key press makes focus visible, as Tab would.
    const keyboardFocus = async (selector: string) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
      await sleep(50);
      await js(`window.stickyRow('src/old.ts').querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
    };
    await keyboardFocus('.changes-file-actions input[type=checkbox]');
    await capture('focus-viewed', streamTop(160));
    await keyboardFocus('[data-viewed-next]');
    await capture('focus-viewed-next', streamTop(160));
    await js('document.activeElement.blur()');
    // Narrow, pinned.
    win.setContentSize(760, 800);
    await sleep(400);
    await select('sticky.ts');
    await js(`window.toMiddle('src/sticky.ts',1)`);
    await settle();
    await capture('narrow-pinned', streamTop(260));
    await select('ECONemoConnector.cs');
    await toRow('src/transport/ECORuntime/Core/ECONemoConnector.cs');
    await settle();
    await capture('narrow-renamed', streamTop(160));
    win.setContentSize(1280, 800);
    await sleep(400);
    // The Commits tab.
    await click('Commits');
    await wait("!!document.querySelector('.pr-commits .changes-file-header')", 500);
    await sleep(1700);
    await capture('commits', `(()=>{const h=document.querySelector('.pr-commits .changes-file-header');const s=h.closest('.commit-diff-stream')??h.parentElement;const b=s.getBoundingClientRect();const t=h.getBoundingClientRect();
      const y=Math.max(0,Math.round(t.top-60));return {x:Math.round(b.left),y,width:Math.round(b.width),height:220}})()`);
    await js(`document.documentElement.classList.toggle('dark',false)`);
  };
  try {
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
    // text, so each hunk's provisional location is the file, beside a quiet "Loading structure…".
    assert.deepEqual(await js('window.symbols("src/scope.ts")'), []);
    await wait(`window.provisional('src/scope.ts').length>=4`);
    assert.deepEqual(await js('window.provisional("src/scope.ts")'), Array(4).fill('scope.ts'));
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
      'scope.ts › function resolvePaths()',
      'scope.ts › class StoreBridge › flush()',
      'scope.ts › function migrate()',
      'scope.ts › describe "resolvePaths" › it "joins names"',
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
      'store.rs › impl StoreBridge',
      'store.rs › impl StoreBridge › fn save',
      'store.rs › trait Bridge',
      'store.rs › fn cleanup',
      'store.rs › mod tests › fn saves_items',
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
    await wait(`window.symbols('src/large.ts').includes('large.ts › function generated500()')`);
    // Imports at the file's first lines sit outside every definition and have no gap bar above them: the hunk still
    // shows where it is, as the file alone; the hunk inside total() shows its function.
    await wait(`window.symbols('src/imports.ts').length>=2`);
    assert.deepEqual(await js('window.symbols("src/imports.ts")'), ['imports.ts', 'imports.ts › function total()'], 'Top-level changes show the file as their location');
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
    const stickyCrumbs = ['sticky.ts › function first()', 'sticky.ts › function second()'];
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
      return [document.activeElement.closest('[data-hunk-header]')===h,...[...h.querySelectorAll(':is(.diff-gap-gutter,.diff-gap-controls) > button')].map(b=>getComputedStyle(b).opacity)]})()`);
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
      ['h003.rs › pub fn handler_3(&self) -> u32'],
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
      ['h003.rs › … › impl Client3 › fn handler_3'],
      'A long chain keeps the file and the innermost two crumbs'
    );
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
    assert.deepEqual(await js('window.provisional("src/lazy/h030.rs")'), ['h030.rs › pub fn handler_30(&self) -> u32'], 'The provisional crumb stays');
    await js(`document.querySelector('.commit-diff-stream').scrollTop+=window.row('src/lazy/h030.rs').querySelector('.diff-gap-scope').closest('.diff-gap').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top-200`);
    await shot('structure-failed', '.commit-stream-row[data-file="src/lazy/h030.rs"] .diff-gap:has(.diff-gap-scope)');
    await js(`[...window.row('src/lazy/h030.rs').querySelectorAll('[data-structure=failed] button')].find(b=>b.textContent==='Try again').click()`);
    await wait(`window.symbols('src/lazy/h030.rs').length>=1`, 200);
    assert.deepEqual(await js('window.symbols("src/lazy/h030.rs")'), ['h030.rs › … › impl Client30 › fn handler_30']);
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
    assert.deepEqual(await js('window.symbols("src/lazy/h020.rs")'), ['h020.rs › … › impl Client20 › fn handler_20']);
    await js("window.treeClick('cleanup.rs')");
    await wait(`window.symbols('src/lazy/cleanup.rs').length>=1`, 50);
    assert.deepEqual(await js('window.symbols("src/lazy/cleanup.rs")'), ['cleanup.rs › fn cleanup']);
    await js("window.treeClick('panel.ts')");
    await wait(`window.symbols('src/lazy/panel.ts').length>=1`, 50);
    assert.deepEqual(await js('window.symbols("src/lazy/panel.ts")'), ['panel.ts › class Panel › open()']);
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
