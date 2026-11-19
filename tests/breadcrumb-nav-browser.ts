import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Breadcrumb navigation, the whole matrix (#417, #394, show scope), on the synthetic files in
 * tests/fixtures/breadcrumb-nav.ts (`?breadcrumb-nav`).
 *
 * - Languages: TypeScript four levels deep, Rust `mod › impl › fn`, C# `namespace › class › property` and `› method`,
 *   Python, Go and Java; a hunk at the top level.
 * - A pinned crumb jumps: it reveals every line from its definition down to the reader and nothing above it, lands the
 *   definition's first line right under the pinned headers and marks it "here"; the hunk's own (unpinned) crumbs
 *   reveal instead.
 * - Gaps: the definition hidden in a gap, in another hunk above, and 240 lines above, revealed into a sliced hunk whose
 *   slices mount late. Sides: a hunk that only deletes, by the old file's numbers; split and unified layouts.
 * - Input and motion: mouse, Tab, Enter and Space, focus kept on the pinned crumb, rapid repeated jumps, a jump stopped
 *   by the wheel or a key, reduced motion.
 * - Reading position: the pinned breadcrumb follows the reader after a jump, folds with "…" when narrow, and the header
 *   never changes height.
 * - Show scope: short definitions show whole with their rail, join, collapse per hunk and by the setting; crumbs jump
 *   inside them.
 * - The outline (#394): what each file changes, jumping from it by mouse and keyboard, and per-symbol Viewed with the
 *   offer to mark the file.
 * - An Explanation topic with the same files: the same core checks in a slide, and the same ticks.
 * - Performance: no long tasks; scroll frames while the pinned header follows the reader.
 *
 * Every check sets the diff's own width, so none depends on the window's: Windows CI desktops are 1024 px wide.
 * With GNOSIS_NAV_SHOTS=1 it prints `NAVSHOT <name> <base64 PNG>` review screenshots instead, light and dark, at 1280 and
 * 760 px.
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
    await sleep(60);
  };
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  const settle = async () => {
    await js(frames);
    await sleep(150);
    await js(frames);
  };
  const press = async (keyCode: string, char?: string, modifiers: 'shift'[] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  };
  const clickPoint = (point: { x: number; y: number }) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const reducedMotion = async (on: boolean) => {
    if (on) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: on ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [],
    });
    if (!on) win.webContents.debugger.detach();
  };

  /** Helpers in the page, for a diff's root (a Changes row or a topic's file group) and the scroller it is in. */
  const install = () =>
    js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      window.__longTasks=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask'});
      window.q=s=>document.querySelector(s);
      window.symbols=root=>[...(window.q(root)?.querySelectorAll('.diff-gap-where > .diff-gap-scope:not([data-provisional]) .diff-gap-symbol')??[])].map(e=>[...e.querySelectorAll('.diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '));
      window.lineRow=(root,text,deleted)=>window.deepAll('[data-line]',window.q(root)).find(e=>e.textContent.includes(text)&&(e.dataset.lineType==='change-deletion')===!!deleted&&e.getBoundingClientRect().height>0);
      window.lineTop=(root,text,deleted)=>{const l=window.lineRow(root,text,deleted);return l?Math.round(l.getBoundingClientRect().top):null};
      window.shownCount=(root,text)=>new Set(window.deepAll('[data-line]',window.q(root)).filter(e=>e.textContent.includes(text)&&e.getBoundingClientRect().height>0).map(e=>e.textContent)).size;
      window.under=root=>{const r=window.q(root);return r.querySelector('.changes-file-header').getBoundingClientRect().bottom-1+r.querySelector('[data-hunk-header]').offsetHeight};
      // Scrolls the line with \`text\` to right under the pinned headers, until it holds still.
      window.pinAt=async(root,scroller,text,deleted)=>{const s=window.q(scroller);
        // First near the scroller's top, so the file's header pins there, then right under the pinned headers.
        {const l=window.lineRow(root,text,deleted);if(l){s.dispatchEvent(new WheelEvent('wheel'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-150;
          for(let f=0;f<3;f++)await new Promise(r=>requestAnimationFrame(r))}}
        for(let i=0,still=0;i<80&&still<5;i++){const l=window.lineRow(root,text,deleted);if(!l)throw Error('No line '+text+' in '+root);
          const off=l.getBoundingClientRect().top-window.under(root);
          if(Math.abs(off)>1){s.dispatchEvent(new WheelEvent('wheel'));s.scrollTop+=off;still=0}else still++;
          for(let f=0;f<2;f++)await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>setTimeout(r,40))}
        await new Promise(r=>setTimeout(r,100));return Math.round(s.scrollTop)};
      window.jumpState=root=>{const r=window.q(root);const h=r.querySelector('[data-hunk-header][data-stuck]');const b=h?.getBoundingClientRect();const a=document.activeElement;
        const slot=h?.querySelector('.diff-gap-live');
        return {stuck:!!h,live:h?.dataset.live??null,bottom:b?Math.round(b.bottom):null,height:b?Math.round(b.height):null,
          lines:window.deepAll('[data-line]',r).length,hidden:[...r.querySelectorAll('.diff-gap[data-gap]')].map(g=>g.getAttribute('aria-label')).join('|'),
          crumbs:slot?[...slot.querySelectorAll('button[data-jump]')].map(b=>b.getAttribute('aria-label')):[],
          shown:slot?[...slot.querySelectorAll(':scope > .diff-gap-crumb-group:not([data-collapsed]) button[data-jump]')].map(b=>b.getAttribute('aria-label')):[],
          more:slot?.querySelector('.diff-gap-more')?getComputedStyle(slot.querySelector('.diff-gap-more')).display:null,
          slotLabel:slot?.getAttribute('aria-label')??null,
          active:a?.matches?.('.diff-gap-live button[data-jump]')?a.getAttribute('aria-label'):null}};
      // A pinned crumb's centre, or, folded into "…", the centre of "…" and \`folded\`.
      window.crumbCenter=(root,label)=>{const h=window.q(root).querySelector('[data-stuck]');const b=[...(h?.querySelectorAll('.diff-gap-live button[data-jump]')??[])].find(b=>b.getAttribute('aria-label')===label);
        if(!b)throw Error('No pinned crumb '+label+' in '+root);let r=b.getBoundingClientRect();const folded=!r.width;
        if(folded)r=h.querySelector('.diff-gap-live button[data-more]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),folded}};
      window.foldedCenter=(root,label)=>{const b=[...window.q(root).querySelectorAll('.diff-gap-folded button[data-jump]')].find(b=>b.getAttribute('aria-label')===label);
        if(!b)throw Error('No folded crumb '+label);const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
      // The centre of a control in a file's outline, with the file's top at the top of its scroller, so no pinned header
      // covers it.
      window.center=async(root,selector,scroller)=>{const s=window.q(scroller);
        // Files above may still settle their heights as they render: aim again until the file holds still.
        for(let i=0,still=0;i<40&&still<3;i++){const off=window.q(root).getBoundingClientRect().top-s.getBoundingClientRect().top;
          if(Math.abs(off)>1){s.scrollTop+=off;still=0}else still++;for(let f=0;f<2;f++)await new Promise(r=>requestAnimationFrame(r))}
        const b=window.q(root).querySelector(selector);if(!b)throw Error('Missing '+selector);const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
      // Where the reader was taken (lib/diff-here.ts): marked lines and bars, with their band and gutter.
      window.hereMarks=root=>window.deepAll('[data-here]',window.q(root)).filter(e=>!e.matches('[data-column-number]')).map(e=>{const bar=e.matches('.diff-gap');const c=getComputedStyle(e,bar?'::before':'::after');
        const i=e.getAttribute('data-line-index');const col=e.closest('[data-deletions],[data-additions]')??e.closest('[data-code]');const g=i!==null&&col?col.querySelector('[data-column-number][data-line-index="'+i+'"]'):null;
        return {kind:e.matches('[data-line]')?'line':bar?'bar':'other',text:e.textContent.trim().slice(0,48),anim:c.animationName.replace(/-[ab]$/,''),band:c.backgroundColor,gutter:g?g.hasAttribute('data-here'):null,top:Math.round(e.getBoundingClientRect().top)}});
      window.sampleScroll=scroller=>{const s=window.q(scroller);const v=[];window.__samples=v;let n=0;const t=()=>{v.push(Math.round(s.scrollTop));if(++n<90)requestAnimationFrame(t)};requestAnimationFrame(t);void 0};
      // Show scope's rails: the gutter cells marked, by their line number.
      window.rails=root=>window.deepAll('[data-column-number][data-scope-rail]',window.q(root)).filter(c=>!c.closest('[data-deletions]')).map(c=>c.getAttribute('data-column-number')+':'+c.getAttribute('data-scope-rail'));
      window.headerActions=root=>[...window.q(root).querySelectorAll('.diff-gap-act > button')].map(b=>b.textContent.trim());
      window.outline=root=>{const o=window.q(root)?.querySelector('.diff-outline');if(!o)return null;
        return {summary:o.querySelector('.diff-outline-summary')?.textContent.trim(),pending:o.hasAttribute('data-pending'),expanded:o.hasAttribute('data-expanded'),
          chips:[...o.querySelectorAll('.diff-outline-chip[data-change]')].map(c=>c.dataset.change+':'+c.querySelector('.diff-outline-go').textContent.trim()+(c.dataset.viewed?':viewed':'')),
          rows:[...o.querySelectorAll('.diff-outline-row')].map(r=>r.dataset.change+':'+r.querySelector('.diff-outline-go').textContent.trim()+':'+(r.querySelector('input').checked?'ticked':'open')),
          progress:o.querySelector('.diff-outline-end')?.textContent.trim()??null,height:Math.round(o.querySelector('.diff-outline-bar').getBoundingClientRect().height)}};
      void 0`);
  const select = async (name: string) => {
    await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
    await sleep(1600);
  };
  const STREAM = '.commit-diff-stream';
  const rowOf = (path: string) => `.commit-stream-row[data-file="${path}"]`;
  /**
   * The diff's own width, so no check depends on the window's (Windows CI desktops are 1024 px wide). Never wider than
   * its scroller: a pinned header wider than the view never reads as wholly in view, so it would never read as pinned.
   */
  const setWidth = (root: string, width: string) =>
    js(`(()=>{const d=window.q(${JSON.stringify(root)}).querySelector('.changes-diff');d.style.width=${JSON.stringify(width)};d.style.maxWidth='100%'})()`);

  type Jump = {
    stuck: boolean;
    live: string | null;
    bottom: number | null;
    height: number | null;
    lines: number;
    hidden: string;
    crumbs: string[];
    shown: string[];
    more: string | null;
    slotLabel: string | null;
    active: string | null;
  };
  type Here = { kind: string; text: string; anim: string; band: string; gutter: boolean | null; top: number };
  const state = (root: string) => js<Jump>(`window.jumpState(${JSON.stringify(root)})`);
  const here = (root: string) => js<Here[]>(`window.hereMarks(${JSON.stringify(root)})`);
  const landed = async (root: string) => {
    await sleep(80);
    await wait(`window.hereMarks(${JSON.stringify(root)}).length>0`, 80);
    await settle();
  };
  /** Clicks a pinned crumb; one folded into "…" is chosen from the list "…" opens. */
  const clickCrumb = async (root: string, label: string) => {
    const point = await js<{ x: number; y: number; folded: boolean }>(`window.crumbCenter(${JSON.stringify(root)},${JSON.stringify(label)})`);
    clickPoint(point);
    if (!point.folded) return;
    await wait(`!!window.q(${JSON.stringify(root)}).querySelector('.diff-gap-folded')`, 50);
    clickPoint(await js<{ x: number; y: number }>(`window.foldedCenter(${JSON.stringify(root)},${JSON.stringify(label)})`));
  };
  const pin = async (root: string, scroller: string, text: string, deleted = false) => {
    await js(`window.pinAt(${JSON.stringify(root)},${JSON.stringify(scroller)},${JSON.stringify(text)},${deleted})`);
    try {
      await wait(`window.jumpState(${JSON.stringify(root)}).crumbs.length>0||window.jumpState(${JSON.stringify(root)}).live==='line'`, 100);
    } catch (error) {
      console.log(
        'Pin diagnostics:',
        JSON.stringify(
          await js(`(()=>{const r=window.q(${JSON.stringify(root)});const l=window.lineRow(${JSON.stringify(root)},${JSON.stringify(text)},${deleted});
            return {state:window.jumpState(${JSON.stringify(root)}),under:window.under(${JSON.stringify(root)}),line:l?Math.round(l.getBoundingClientRect().top):null,
              headers:[...r.querySelectorAll('[data-hunk-header]')].map(h=>({stuck:h.hasAttribute('data-stuck'),key:h.getAttribute('data-live-key'),live:h.dataset.live,top:Math.round(h.getBoundingClientRect().top),slot:h.querySelector('.diff-gap-live')?.textContent})),
              width:Math.round(r.querySelector('.changes-diff').getBoundingClientRect().width),scroller:Math.round(window.q(${JSON.stringify(scroller)}).getBoundingClientRect().width),
              scrollerTop:Math.round(window.q(${JSON.stringify(scroller)}).getBoundingClientRect().top),file:JSON.stringify(r.querySelector('.changes-file-header').getBoundingClientRect()),group:Math.round(r.getBoundingClientRect().top),
              diffScroller:r.querySelector('.changes-diff').closest('.commit-diff-stream, [data-diff-scroller]')?.className,stickyTop:getComputedStyle(r.querySelectorAll('[data-hunk-header]')[1]??r).top,
              headerVar:getComputedStyle(r.querySelector('.changes-diff')).getPropertyValue('--diff-file-header-height')}})()`)
        )
      );
      // Whether the topic's other files pin, and whether a fresh observer sees this header pinned.
      console.log(
        'Pin diagnostics, more:',
        JSON.stringify(
          await js(`(async()=>{const r=window.q(${JSON.stringify(root)});const h=r.querySelectorAll('[data-hunk-header]')[1];const s=window.q(${JSON.stringify(scroller)});
            const fileH=r.querySelector('.changes-file-header').getBoundingClientRect().height;
            const seen=await new Promise(res=>{const io=new IntersectionObserver(es=>{io.disconnect();res(es.map(e=>({i:e.isIntersecting,ratio:e.intersectionRatio,top:e.boundingClientRect.top,root:e.rootBounds?.top})))},{root:s,rootMargin:'-'+fileH+'px 0px 0px 0px',threshold:[0,1]});io.observe(h)});
            return {seen,anyStuck:document.querySelectorAll('[data-stuck]').length,headerConnected:r.querySelector('.changes-file-header').isConnected}})()`)
        ),
        errors
      );
      throw error;
    }
    return state(root);
  };
  /**
   * A pinned crumb's jump, checked: the definition's first line (`text`) lands right under the pinned header, marked
   * "here" with its gutter; `above` stays hidden; the header keeps its height. Returns the state after.
   */
  const jump = async (
    surface: string,
    root: string,
    label: string,
    text: string,
    { above, deleted = false, keyboard = false, revealed }: { above?: string; deleted?: boolean; keyboard?: boolean; revealed?: boolean } = {}
  ) => {
    const before = await state(root);
    if (keyboard) {
      await js(`[...window.q(${JSON.stringify(root)}).querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}).focus()`);
      await press('Enter', '\r');
    } else await clickCrumb(root, label);
    await landed(root);
    const after = await state(root);
    const top = await js<number | null>(`window.lineTop(${JSON.stringify(root)},${JSON.stringify(text)},${deleted})`);
    const marks = await here(root);
    console.log(`${surface}: ${label}`, JSON.stringify({ top, bottom: after.bottom, lines: [before.lines, after.lines], hidden: [before.hidden, after.hidden], marks: marks.map((m) => m.text) }));
    assert.ok(top !== null && after.bottom !== null && Math.abs(top - after.bottom) <= 2, `${surface}: ${label} lands its first line under the pinned header (${top} vs ${after.bottom})`);
    assert.equal(after.height, before.height, `${surface}: the header keeps its height`);
    assert.ok(marks.length >= 1 && marks[0].kind === 'line' && marks[0].text.startsWith(text.trim().slice(0, 20)) && marks[0].gutter === true, `${surface}: the line is marked here, with its gutter: ${JSON.stringify(marks)}`);
    if (above) assert.equal(await js<number>(`window.shownCount(${JSON.stringify(root)},${JSON.stringify(above)})`), 0, `${surface}: nothing above the definition shows (${above})`);
    if (revealed === true) assert.ok(after.lines > before.lines, `${surface}: the lines down to the reader were revealed`);
    if (revealed === false) assert.equal(after.hidden, before.hidden, `${surface}: nothing was revealed`);
    if (keyboard) assert.equal(after.active, after.crumbs.find((c) => c === label) ?? after.active, `${surface}: focus stays on a pinned crumb`);
    return after;
  };

  const shots = !!process.env.GNOSIS_NAV_SHOTS;
  const open = async () => {
    win.setContentSize(1280, 800);
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&breadcrumb-nav`);
    await waitForWorkbenchQueue(win.webContents);
    await install();
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='deep.ts')");
  };
  const openTopic = async () => {
    // The explanation document pairs prose with code; this width leaves the code column room for a whole breadcrumb.
    win.setContentSize(1440, 900);
    await sleep(300);
    await click('Review queue');
    await wait("!!document.querySelector('.queue-row-main')");
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()");
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.explanation-reader')");
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
  };
  const topicFile = (path: string) => `[data-explanation-section="1"] .review-file-group[data-file-path$="${path}"]`;
  const DOC = '.explanation-document';

  /** Review screenshots: `NAVSHOT <name>-<theme> <base64>` at 1280 and 760 px. */
  const reviewShots = async () => {
    const capture = async (name: string, rect: string, between?: () => Promise<void>) => {
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await settle();
        if (between) await between();
        const r = await js<{ x: number; y: number; width: number; height: number }>(rect);
        console.log(`NAVSHOT ${name}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
      }
      await js(`document.documentElement.classList.toggle('dark',false)`);
    };
    const area = (scroller: string, top: number, height: number) =>
      `(()=>{const b=window.q(${JSON.stringify(scroller)}).getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top+${top}),width:Math.round(b.width),height:Math.round(Math.min(${height},b.height-${top}))}})()`;
    const toTop = (root: string, selector: string, scroller: string, offset: number) =>
      js(`(()=>{const s=window.q(${JSON.stringify(scroller)});const e=window.q(${JSON.stringify(root)}).querySelector(${JSON.stringify(selector)});s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-${offset}})()`);
    for (const width of [1280, 760]) {
      await open();
      win.setContentSize(width, 800);
      await sleep(400);
      const deep = rowOf('src/nav/deep.ts');
      await select('deep.ts');
      await wait(`window.symbols(${JSON.stringify(deep)}).length>=2`);
      // The jump highlight, mid-bloom and settled.
      for (const [name, delay] of [['here-bloom', 120], ['here-settled', 900]] as const)
        await capture(`${name}-${width}`, area(STREAM, 0, 260), async () => {
          await js(`window.pinAt(${JSON.stringify(deep)},${JSON.stringify(STREAM)},'next += 30 * 2;',false)`);
          await wait(`window.jumpState(${JSON.stringify(deep)}).crumbs.length===4`);
          clickPoint(await js<{ x: number; y: number }>(`window.crumbCenter(${JSON.stringify(deep)},'Go to class Scheduler')`));
          await wait(`window.hereMarks(${JSON.stringify(deep)}).length>0`, 80);
          await sleep(delay);
        });
      // Show scope: a short class shown whole with its rail, and a function too long to.
      const scoped = rowOf('src/nav/scoped.ts');
      await select('scoped.ts');
      await wait(`window.rails(${JSON.stringify(scoped)}).length>0`);
      await toTop(scoped, '.diff-hunk', STREAM, 120);
      await capture(`scope-rail-${width}`, area(STREAM, 0, 480));
      await toTop(scoped, '.diff-hunk:nth-of-type(3)', STREAM, 60);
      await capture(`scope-joined-not-qualified-${width}`, area(STREAM, 0, 520));
      // The outline, collapsed and expanded with its marks and ticks, and a jump from it.
      const outline = rowOf('src/nav/outline.ts');
      await select('outline.ts');
      await wait(`window.outline(${JSON.stringify(outline)})?.chips.length===4`);
      await toTop(outline, '.changes-file-header', STREAM, 0);
      await capture(`outline-collapsed-${width}`, area(STREAM, 0, 200));
      await js(`window.q(${JSON.stringify(outline)}).querySelector('.diff-outline-toggle').click()`);
      await js(`[...window.q(${JSON.stringify(outline)}).querySelectorAll('.diff-outline-tick')].slice(0,2).forEach(t=>t.click())`);
      await settle();
      await capture(`outline-expanded-${width}`, area(STREAM, 0, 300));
      await capture(`outline-jump-${width}`, area(STREAM, 0, 300), async () => {
        await toTop(outline, '.changes-file-header', STREAM, 0);
        await settle();
        clickPoint(await js<{ x: number; y: number }>(`window.center(${JSON.stringify(outline)},'.diff-outline-row[data-change=removed] .diff-outline-go','${STREAM}')`));
        await wait(`window.hereMarks(${JSON.stringify(outline)}).length>0`, 80);
        await sleep(500);
      });
      await js(`window.q(${JSON.stringify(outline)}).querySelector('.diff-outline-toggle').click()`);
      // The same in a slide.
      await openTopic();
      win.setContentSize(width, 800);
      await sleep(400);
      const slideScoped = topicFile('src/nav/scoped.ts');
      await wait(`!!window.q(${JSON.stringify(slideScoped)})&&window.rails(${JSON.stringify(slideScoped)}).length>0`, 500);
      await toTop(slideScoped, '.changes-file-header', DOC, 10);
      await capture(`slide-scope-outline-${width}`, area(DOC, 0, 520));
      const slideDeep = topicFile('src/nav/deep.ts');
      await js(`window.pinAt(${JSON.stringify(slideDeep)},${JSON.stringify(DOC)},'next += 30 * 2;',false)`);
      await capture(`slide-jump-${width}`, area(DOC, 0, 280), async () => {
        await js(`window.pinAt(${JSON.stringify(slideDeep)},${JSON.stringify(DOC)},'next += 30 * 2;',false)`);
        await wait(`window.jumpState(${JSON.stringify(slideDeep)}).crumbs.length===4`);
        clickPoint(await js<{ x: number; y: number }>(`window.crumbCenter(${JSON.stringify(slideDeep)},'Go to class Scheduler')`));
        await wait(`window.hereMarks(${JSON.stringify(slideDeep)}).length>0`, 80);
        await sleep(400);
      });
    }
  };

  try {
    if (shots) {
      await reviewShots();
      return;
    }
    await open();

    // ═══ Languages: each chain, pinned, and its outermost crumb's jump ═══
    const cases = [
      {
        file: 'deep.ts',
        path: 'src/nav/deep.ts',
        pin: 'next += 30 * 2;',
        chain: ['Go to module Engine', 'Go to class Scheduler', 'Go to function run', 'Go to function step'],
        // The class line is hidden in the gap above: the jump reveals every line from it down to the reader.
        outer: { label: 'Go to class Scheduler', text: 'export class Scheduler {', above: 'export namespace Engine', revealed: true },
      },
      {
        file: 'Navmesh.cs',
        path: 'src/nav/Navmesh.cs',
        pin: 's += 15f * 2f;',
        chain: ['Go to module Seed.World', 'Go to class Navmesh', 'Go to property Speed'],
        outer: { label: 'Go to class Navmesh', text: 'public class Navmesh : MonoBehaviour', above: 'namespace Seed.World', revealed: true },
      },
      {
        file: 'Navmesh.cs',
        path: 'src/nav/Navmesh.cs',
        pin: 'd += 20f * 2f;',
        chain: ['Go to module Seed.World', 'Go to class Navmesh', 'Go to function Update'],
        outer: { label: 'Go to function Update', text: 'private void Update()', revealed: false },
      },
      {
        file: 'queue.py',
        path: 'src/nav/queue.py',
        pin: 'total += 25 * 2',
        chain: ['Go to class Queue', 'Go to function drain', 'Go to function visit'],
        outer: { label: 'Go to class Queue', text: 'class Queue:', above: 'LEAD_19 = 19', revealed: true },
      },
      {
        file: 'server.go',
        path: 'src/nav/server.go',
        pin: 'total += 25 * 2',
        chain: ['Go to function Handle'],
        outer: { label: 'Go to function Handle', text: 'func (s *Server) Handle(input int) int {', above: 'var pad18 = 18', revealed: false },
      },
      {
        file: 'Store.java',
        path: 'src/nav/Store.java',
        pin: 'total += 25 * 2;',
        chain: ['Go to class Store', 'Go to class Cache', 'Go to function load'],
        outer: { label: 'Go to class Store', text: 'public class Store {', above: 'package nav;', revealed: true },
      },
    ];
    const heights = new Set<number>();
    for (const c of cases) {
      const root = rowOf(c.path);
      await select(c.file);
      await wait(`window.symbols(${JSON.stringify(root)}).length>=1`);
      await setWidth(root, '680px');
      const pinned = await pin(root, STREAM, c.pin);
      console.log(`${c.file}: pinned`, JSON.stringify({ crumbs: pinned.crumbs, label: pinned.slotLabel, height: pinned.height }));
      assert.ok(pinned.stuck && pinned.live === 'scope', `${c.file}: the header is pinned and follows the reader`);
      assert.deepEqual(pinned.crumbs, c.chain, `${c.file}: the pinned breadcrumb names every level, outermost first`);
      if (pinned.height) heights.add(pinned.height);
      await jump(c.file, root, c.outer.label, c.outer.text, { above: c.outer.above, revealed: c.outer.revealed });
    }
    // Top-level hunks say so.
    for (const [file, path] of [['server.go', 'src/nav/server.go'], ['deep.ts', 'src/nav/deep.ts']]) {
      await select(file);
      await wait(`window.symbols(${JSON.stringify(rowOf(path))}).length>=2`);
      assert.equal((await js<string[]>(`window.symbols(${JSON.stringify(rowOf(path))})`))[0], 'top level', `${file}: the import hunk is at the top level`);
    }

    // ═══ TypeScript, four levels: every level, mouse and keyboard, and the reader followed after each jump ═══
    const deep = rowOf('src/nav/deep.ts');
    await select('deep.ts');
    await setWidth(deep, '680px');
    await pin(deep, STREAM, 'next += 40 * 2;');
    // The namespace's first line is hidden too; going there shows only from it down.
    let after = await jump('deep.ts', deep, 'Go to module Engine', 'export namespace Engine {', { above: 'export const lead19 = 19;' });
    assert.deepEqual(after.crumbs, ['Go to module Engine'], 'Landed on the namespace line, the pinned breadcrumb names where the reader is');
    await pin(deep, STREAM, 'next += 40 * 2;');
    // run() shows whole by show scope; its first line is on screen: nothing is revealed.
    after = await jump('deep.ts', deep, 'Go to function run', 'run(input: number): number {', { revealed: false });
    assert.deepEqual(after.crumbs, ['Go to module Engine', 'Go to class Scheduler', 'Go to function run'], 'The breadcrumb follows the reader to run()');
    // Keyboard: Tab between the pinned crumbs that show ("…" first when some fold), Enter and Space go, and focus stays
    // on the breadcrumb. Which crumbs show depends on the bar's width, so the walk follows what shows.
    const walk = await pin(deep, STREAM, 'next += 50 * 2;');
    console.log('Pinned crumbs that show:', JSON.stringify(walk.shown));
    const order = [...walk.shown];
    assert.equal(order.at(-1), 'Go to function step', 'The innermost crumb shows');
    await js(`[...window.q(${JSON.stringify(deep)}).querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(order[0])}).focus()`);
    assert.equal((await state(deep)).active, order[0], 'A pinned crumb takes focus');
    for (const next of order.slice(1)) {
      await press('Tab');
      assert.equal((await state(deep)).active, next, `Tab moves on to ${next}`);
    }
    await press('Enter', '\r');
    await landed(deep);
    let keyed = await state(deep);
    assert.equal(keyed.active, 'Go to function step', 'Enter: focus stays on the pinned crumb');
    assert.ok(Math.abs(((await js<number | null>(`window.lineTop(${JSON.stringify(deep)},'function step(value: number): number {',false)`)) ?? 0) - (keyed.bottom ?? 0)) <= 2, 'Enter goes to step()');
    // Landed on step()'s first line, the breadcrumb names step() and what is around it: Shift+Tab reaches run().
    const back = (await state(deep)).shown;
    const previous = back.at(-2);
    assert.ok(previous, `A crumb shows before the innermost: ${JSON.stringify(back)}`);
    await press('Tab', undefined, ['shift']);
    assert.equal((await state(deep)).active, previous, 'Shift+Tab moves back');
    await press('Space', ' ');
    await landed(deep);
    keyed = await state(deep);
    const target = previous === 'Go to function run' ? 'run(input: number): number {' : previous === 'Go to class Scheduler' ? 'export class Scheduler {' : 'export namespace Engine {';
    assert.ok(Math.abs(((await js<number | null>(`window.lineTop(${JSON.stringify(deep)},${JSON.stringify(target)},false)`)) ?? 0) - (keyed.bottom ?? 0)) <= 2, `Space goes to ${previous}`);
    assert.equal(keyed.active, previous, 'Space: focus stays');
    if (keyed.height) heights.add(keyed.height);
    // Rapid repeated jumps: Enter five times, 40 ms apart. The last one lands; one place is marked; nothing breaks.
    await pin(deep, STREAM, 'next += 50 * 2;');
    await js(`[...window.q(${JSON.stringify(deep)}).querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].find(b=>b.getAttribute('aria-label')==='Go to function step').focus()`);
    await js('window.__longTasks=[]');
    for (let i = 0; i < 5; i++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(40);
    }
    await landed(deep);
    await sleep(400);
    const rapid = await here(deep);
    const rapidState = await state(deep);
    console.log('Rapid jumps:', JSON.stringify({ marks: rapid.map((m) => m.text), longTasks: await js('window.__longTasks.map(t=>Math.round(t.duration))') }));
    assert.equal(rapid.filter((m) => m.kind === 'line').length, 1, 'Rapid jumps leave one place marked');
    assert.ok(Math.abs(((await js<number | null>(`window.lineTop(${JSON.stringify(deep)},'function step(value: number): number {',false)`)) ?? 0) - (rapidState.bottom ?? 0)) <= 2, 'and land where the last one goes');
    assert.equal(rapidState.active, 'Go to function step', 'Focus stays through rapid jumps');
    assert.deepEqual(await js('window.__longTasks.map(t=>Math.round(t.duration))'), [], 'Rapid jumps leave no long task');
    await js('document.activeElement?.blur()');
    // Narrow: the pinned breadcrumb folds from the outside into "…", keeps the innermost, and keeps its height.
    await setWidth(deep, '430px');
    await sleep(200);
    const narrow = await pin(deep, STREAM, 'next += 40 * 2;');
    console.log('Narrow pinned breadcrumb:', JSON.stringify({ shown: narrow.shown, more: narrow.more, height: narrow.height }));
    assert.ok(narrow.more !== null && narrow.more !== 'none', `Narrow, "…" stands for the folded crumbs: ${narrow.more}`);
    assert.equal(narrow.shown.at(-1), 'Go to function step', 'The innermost crumb never folds');
    assert.ok(narrow.shown.length < 4, 'Outer crumbs fold');
    if (narrow.height) heights.add(narrow.height);
    // "…" opens the folded levels; one of them goes where its crumb would. Escape closes the list, back on "…".
    const folded = await js<string[]>(`(()=>{const h=window.q(${JSON.stringify(deep)}).querySelector('[data-stuck]');h.querySelector('.diff-gap-live button[data-more]').click();
      return [...h.querySelectorAll('.diff-gap-folded button[data-jump]')].map(b=>b.getAttribute('aria-label'))})()`);
    console.log('Folded levels:', JSON.stringify(folded));
    assert.ok(folded.length >= 1 && folded[0] === 'Go to module Engine', `"…" lists the folded levels, outermost first: ${JSON.stringify(folded)}`);
    assert.equal(await js(`window.q(${JSON.stringify(deep)}).querySelector('[data-stuck] .diff-gap-live button[data-more]').getAttribute('aria-expanded')`), 'true');
    await press('Escape');
    assert.equal(await js(`!!window.q(${JSON.stringify(deep)}).querySelector('.diff-gap-folded')`), false, 'Escape closes the list');
    assert.equal(await js(`document.activeElement?.matches('.diff-gap-live button[data-more]')`), true, 'and focus goes back to "…"');
    await js('document.activeElement?.blur()');
    await jump('deep.ts (narrow)', deep, folded[0], 'export namespace Engine {', { revealed: false });
    // The innermost never folds: it goes to step().
    await pin(deep, STREAM, 'next += 40 * 2;');
    await jump('deep.ts (narrow)', deep, 'Go to function step', 'function step(value: number): number {', { revealed: false });
    await setWidth(deep, '680px');
    assert.equal(heights.size, 1, `The pinned header has one height throughout: ${[...heights].join(', ')}`);

    // ═══ Gaps: a definition in another hunk above, and one 240 lines above whose slices mount late ═══
    const twice = rowOf('src/nav/twice.ts');
    await select('twice.ts');
    await setWidth(twice, '680px');
    await pin(twice, STREAM, 'total += 30 * 2;');
    // The class line is in the hunk above: the jump lands on it, and shows the lines between the two hunks, as every
    // line from a definition down to the reader shows.
    const beforeTwice = await state(twice);
    assert.equal(beforeTwice.hidden, '26 lines hidden', 'The class line is in another hunk, 26 lines above');
    await jump('twice.ts', twice, 'Go to class Twice', 'export class Twice {', { revealed: true });
    assert.equal((await state(twice)).hidden, '', 'The gap between the hunks is shown');
    assert.equal(await js<number>(`window.shownCount(${JSON.stringify(twice)},'readonly pad10 = 10;')`), 1, 'with its lines');
    // ═══ Unpinned crumbs reveal, as Show whole function does; they neither scroll there nor mark a place ═══
    const nav = rowOf('src/nav/Navmesh.cs');
    await select('Navmesh.cs');
    await js(`(()=>{const s=window.q('${STREAM}');const h=[...window.q(${JSON.stringify(nav)}).querySelectorAll('.diff-gap-where > .diff-gap-scope')].at(-1);s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-260})()`);
    await settle();
    await sleep(2100);
    assert.equal(await js<number>(`window.shownCount(${JSON.stringify(nav)},'private int other10 = 10;')`), 0, 'The lines between the property and Update() start hidden');
    await js(`[...[...window.q(${JSON.stringify(nav)}).querySelectorAll('.diff-gap-where > .diff-gap-scope')].at(-1).querySelectorAll('button[data-crumb]')].find(b=>b.textContent.trim()==='namespace Seed.World').click()`);
    await wait(`window.shownCount(${JSON.stringify(nav)},'private int other10 = 10;')===1`);
    await settle();
    assert.deepEqual(await here(nav), [], 'An unpinned crumb reveals its definition; it does not jump, so it marks nothing');
    const far = rowOf('src/nav/far_mod.rs');
    await select('far_mod.rs');
    await setWidth(far, '680px');
    await pin(far, STREAM, 'total += 40 * 2;');
    await js(`window.__longTasks=[];window.sampleScroll('${STREAM}')`);
    const farJump = await jump('far_mod.rs', far, 'Go to module api', 'pub mod api {', { above: 'Breadcrumb navigation fixture: Rust', revealed: true });
    await wait('window.__samples.length>=90');
    const samples = await js<number[]>('window.__samples');
    const steps = samples.filter((v, i) => i > 0 && v !== samples[i - 1]).length;
    const slices = await js<number>(`window.q(${JSON.stringify(far)}).querySelectorAll('[data-slice]').length`);
    const farTasks = await js<number[]>('window.__longTasks.map(t=>Math.round(t.duration))');
    console.log('Far jump:', JSON.stringify({ steps, slices, longTasks: farTasks, hidden: farJump.hidden }));
    assert.ok(slices > 1, `The revealed hunk is sliced, and its slices mount as they are reached: ${slices}`);
    assert.equal(await js<number>(`window.shownCount(${JSON.stringify(far)},'pub const FAR_')`), 240, 'All 240 lines from the module down to the reader show');
    assert.ok(steps >= 4, `The scroll eases over several frames: ${steps}`);
    assert.deepEqual(farTasks, [], 'Revealing 240 lines into slices and easing there leaves no long task');
    // A jump stopped by the wheel, and by a key, mid-way: it does not land, and nothing is marked.
    for (const stop of ['wheel', 'key'] as const) {
      await pin(far, STREAM, 'total += 50 * 2;');
      await js(`(()=>{const s=window.q('${STREAM}');s.addEventListener('scroll',()=>{let n=0;const t=()=>{if(++n===3)s.dispatchEvent(${stop === 'wheel' ? "new WheelEvent('wheel')" : "new KeyboardEvent('keydown',{key:'ArrowDown'})"});else requestAnimationFrame(t)};requestAnimationFrame(t)},{once:true})})()`);
      clickPoint(await js<{ x: number; y: number }>(`window.crumbCenter(${JSON.stringify(far)},'Go to impl Client')`));
      await sleep(900);
      const stopped = await js<number | null>(`window.lineTop(${JSON.stringify(far)},'impl Client {',false)`);
      const bottom = (await state(far)).bottom ?? 0;
      console.log(`Stopped by ${stop}:`, JSON.stringify({ line: stopped, bottom }));
      assert.ok(stopped === null || Math.abs(stopped - bottom) > 40, `${stop}: the jump stops before it lands`);
      assert.deepEqual(await here(far), [], `${stop}: a stopped jump marks nothing`);
    }
    // Reduced motion: the jump lands in one frame, and the band is still.
    await reducedMotion(true);
    await pin(far, STREAM, 'total += 50 * 2;');
    await js(`window.sampleScroll('${STREAM}')`);
    clickPoint(await js<{ x: number; y: number }>(`window.crumbCenter(${JSON.stringify(far)},'Go to impl Client')`));
    await landed(far);
    await wait('window.__samples.length>=90');
    const instant = await js<number[]>('window.__samples');
    const moves = instant.filter((v, i) => i > 0 && v !== instant[i - 1]);
    const still = await here(far);
    console.log('Reduced motion:', JSON.stringify({ moves, still }));
    assert.ok(moves.length >= 1 && Math.abs(moves[0] - (instant.at(-1) ?? 0)) <= 2, `Reduced motion: the first move lands: ${JSON.stringify(moves)}`);
    assert.deepEqual(still.map((m) => [m.anim, m.band]), [['none', 'rgba(47, 85, 212, 0.22)']], 'Reduced motion: the band is still');
    await reducedMotion(false);
    // The reader is followed after a jump: Landed on impl Client, the pinned breadcrumb names it.
    assert.deepEqual((await state(far)).crumbs, ['Go to module api', 'Go to impl Client'], 'After a jump, the breadcrumb names the definitions around the line landed on');

    // ═══ Sides: a hunk that only deletes, named and jumped by the old file's numbers; and split layout ═══
    const ledger = rowOf('src/nav/ledger.ts');
    // The first run reveals the class's lines; the second, in the other layout, finds them shown.
    const deleted = async (layout: string, reveals: boolean) => {
      await select('ledger.ts');
      await setWidth(ledger, '680px');
      const inOld = await pin(ledger, STREAM, 'n += 50;', true);
      assert.deepEqual(inOld.crumbs, ['Go to class Ledger', 'Go to function settle'], `${layout}: deleted lines are named by the old file`);
      assert.deepEqual(
        await js(`[...window.q(${JSON.stringify(ledger)}).querySelectorAll('[data-stuck] .diff-gap-live button[data-jump]')].map(b=>b.dataset.side)`),
        ['before', 'before'],
        `${layout}: in old numbers`
      );
      await jump(`ledger.ts ${layout}`, ledger, 'Go to function settle', 'settle(): number {', { revealed: false });
      await pin(ledger, STREAM, 'n += 70;', true);
      await jump(`ledger.ts ${layout}`, ledger, 'Go to class Ledger', 'export class Ledger {', { above: 'Breadcrumb navigation fixture: a method', revealed: reveals });
    };
    await deleted('unified', true);
    // Split: d switches every diff, and the same jumps land.
    await js(`window.q('${STREAM}').dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,cancelable:true,composed:true}))`);
    await wait("document.querySelector('.pr-changes')?.dataset.diffLayout==='split'");
    await sleep(600);
    await deleted('split', false);
    const store = rowOf('src/nav/Store.java');
    await select('Store.java');
    await setWidth(store, '680px');
    await pin(store, STREAM, 'total += 30 * 2;');
    await jump('Store.java split', store, 'Go to function load', 'int load(int input) {', { revealed: false });
    await js(`window.q('${STREAM}').dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,cancelable:true,composed:true}))`);
    await wait("document.querySelector('.pr-changes')?.dataset.diffLayout==='unified'");
    await sleep(600);

    // ═══ Show scope ═══
    const scoped = rowOf('src/nav/scoped.ts');
    await select('scoped.ts');
    await wait(`window.rails(${JSON.stringify(scoped)}).length>0`);
    const lines = (text: string) => js<number>(`window.shownCount(${JSON.stringify(scoped)},${JSON.stringify(text)})`);
    // The short class shows whole around its method: nothing above it, all of it, with its rail and Collapse.
    assert.equal(await lines('export class Small {'), 1, 'The class around the change shows whole');
    assert.equal(await lines('readonly c = 3;'), 1, 'down to its last member');
    assert.equal(await lines('// Show scope fixture.'), 0, 'and nothing above it');
    const rails = await js<string[]>(`window.rails(${JSON.stringify(scoped)})`);
    console.log('Rails:', JSON.stringify(rails));
    assert.ok(rails.includes('2:start') && rails.includes('16:end') && rails.includes('9:mid'), 'The rail runs from the class line to its end');
    assert.ok(rails.includes('37:start') && rails.includes('66:end'), 'and along joined()');
    assert.ok(!rails.some((r) => r.startsWith('68:') || r.startsWith('90:')), 'long() has none');
    const actions = await js<string[]>(`window.headerActions(${JSON.stringify(scoped)})`);
    console.log('Header actions:', JSON.stringify(actions));
    assert.deepEqual(actions, ['Collapse class', 'Collapse function', 'Show whole function', 'Collapse function', 'Collapse function'], 'Each hunk offers what fits it');
    // Two hunks of joined() are one view of it; apart() keeps its long middle hidden but shows its ends.
    assert.equal(await lines('v += 10;'), 1, 'joined(): the lines between its two hunks show');
    assert.equal(await lines('export function apart'), 1, 'apart(): its first line shows');
    assert.equal(await lines('x += 15;'), 0, 'apart(): its long middle stays hidden');
    assert.equal(await lines('w += 5;'), 0, 'long(): plain context');
    // Collapse, per hunk: the class goes back to plain context.
    await js(`[...window.q(${JSON.stringify(scoped)}).querySelectorAll('[data-collapse-scope]')][0].click()`);
    await wait(`window.shownCount(${JSON.stringify(scoped)},'export class Small {')===0`);
    assert.ok(!(await js<string[]>(`window.rails(${JSON.stringify(scoped)})`)).includes('2:start'), 'Collapsed, the rail goes');
    assert.equal(await lines('v += 10;'), 1, 'Other hunks keep theirs');
    // The setting turns it off, and back on.
    const setScope = (on: boolean) =>
      js(`(async()=>{const prefs=await window.electronAPI.loadPreferences();const next={...prefs,codeIntelligence:{...(prefs.codeIntelligence??{}),showScope:${on}}};
        await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}))})()`);
    await setScope(false);
    await wait(`window.shownCount(${JSON.stringify(scoped)},'v += 10;')===0`);
    assert.deepEqual(await js(`window.rails(${JSON.stringify(scoped)})`), [], 'Off, no rails');
    await setScope(true);
    await wait(`window.shownCount(${JSON.stringify(scoped)},'v += 10;')===1`);
    // A crumb jumps inside a definition shown whole: deep.ts's run() is, and going to it revealed nothing (above).

    // ═══ The outline (#394) ═══
    const outline = rowOf('src/nav/outline.ts');
    await select('outline.ts');
    await wait(`window.outline(${JSON.stringify(outline)})?.chips.length===4`);
    const collapsed = await js<{ summary: string; chips: string[]; progress: string; height: number }>(`window.outline(${JSON.stringify(outline)})`);
    console.log('Outline:', JSON.stringify(collapsed));
    assert.equal(collapsed.summary, 'Changes 4 functions');
    assert.deepEqual(collapsed.chips, ['modified:function merge()', 'removed:function rebase()', 'modified:updateBranch()', 'added:function squash()']);
    // Jumping from it: a removed function goes to its deleted first line, by the old file's numbers.
    await setWidth(outline, '680px');
    clickPoint(await js<{ x: number; y: number }>(`window.center(${JSON.stringify(outline)},'.diff-outline-chip[data-change=removed] .diff-outline-go','${STREAM}')`));
    await landed(outline);
    let marks = await here(outline);
    let landing = await state(outline);
    let top = await js<number | null>(`window.lineTop(${JSON.stringify(outline)},'export function rebase(list',true)`);
    console.log('Outline jump to rebase:', JSON.stringify({ top, bottom: landing.bottom, marks }));
    assert.ok(top !== null && landing.bottom !== null && Math.abs(top - landing.bottom) <= 2, 'The removed function’s first line lands under the pinned header');
    assert.equal(marks[0]?.text.startsWith('export function rebase'), true, 'and is marked here');
    // From the keyboard: Enter on a symbol goes there; focus stays on it.
    await js(`(()=>{const s=window.q('${STREAM}');s.scrollTop+=window.q(${JSON.stringify(outline)}).getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    await settle();
    await js(`window.q(${JSON.stringify(outline)}).querySelector('.diff-outline-chip[data-change=added] .diff-outline-go').focus()`);
    await press('Enter', '\r');
    await landed(outline);
    marks = await here(outline);
    landing = await state(outline);
    top = await js<number | null>(`window.lineTop(${JSON.stringify(outline)},'export function squash(',false)`);
    assert.ok(top !== null && landing.bottom !== null && Math.abs(top - landing.bottom) <= 2, 'Enter on squash() lands on it');
    assert.equal(marks[0]?.text.startsWith('export function squash'), true, 'squash() is marked here');
    assert.ok(await js<boolean>(`document.activeElement?.matches('.diff-outline-go')`), 'Focus stays on the outline');
    // Per-symbol Viewed: expand, tick each, and the outline offers to mark the file.
    await js(`(()=>{const s=window.q('${STREAM}');s.scrollTop+=window.q(${JSON.stringify(outline)}).getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    await js(`window.q(${JSON.stringify(outline)}).querySelector('.diff-outline-toggle').click()`);
    await wait(`window.outline(${JSON.stringify(outline)}).rows.length===4`);
    for (let i = 0; i < 3; i++) await js(`window.q(${JSON.stringify(outline)}).querySelectorAll('.diff-outline-tick')[${i}].click()`);
    await settle();
    let expanded = await js<{ rows: string[]; progress: string }>(`window.outline(${JSON.stringify(outline)})`);
    assert.equal(expanded.progress, '3/4 viewed');
    await js(`window.q(${JSON.stringify(outline)}).querySelectorAll('.diff-outline-tick')[3].click()`);
    await settle();
    expanded = await js(`window.outline(${JSON.stringify(outline)})`);
    console.log('Outline ticked:', JSON.stringify(expanded));
    assert.ok(expanded.rows.every((r) => r.endsWith(':ticked')), 'Every symbol is ticked');
    assert.match(expanded.progress, /^All viewed\s*Mark file viewed$/, 'All ticked, it offers to mark the file');
    assert.equal(await js(`window.q(${JSON.stringify(outline)}).querySelector('.changes-file-actions input[type=checkbox]').checked`), false, 'It does not mark the file by itself');
    // The ticks survive leaving Changes and coming back.
    await click('Summary');
    await sleep(300);
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').length>0");
    await select('outline.ts');
    await wait(`window.outline(${JSON.stringify(outline)})?.rows.length===4`);
    assert.ok((await js<{ rows: string[] }>(`window.outline(${JSON.stringify(outline)})`)).rows.every((r) => r.endsWith(':ticked')), 'Ticks are kept');
    await js(`[...window.q(${JSON.stringify(outline)}).querySelectorAll('.diff-outline-mark')].find(b=>b.textContent.trim()==='Mark file viewed').click()`);
    await wait(`window.q(${JSON.stringify(outline)}).querySelector('.changes-file-actions input[type=checkbox]').checked`);
    // Collapse the outlines again for the checks that follow.
    await js(`window.q(${JSON.stringify(outline)}).querySelector('.changes-file-actions input[type=checkbox]').click()`);
    await sleep(400);
    await js(`window.q(${JSON.stringify(outline)})?.querySelector('.diff-outline-toggle[aria-expanded=true]')?.click()`);

    // ═══ Performance: scrolling while the pinned header follows the reader, with rails and the outline on the page ═══
    await select('far_mod.rs');
    const scrolling = await js<{ frames: number; p50: number; max: number; longTasks: number[]; places: number }>(`(async()=>{
      const s=window.q('${STREAM}');const row=window.q(${JSON.stringify(far)});const section=row.querySelector('.diff-hunk');
      s.scrollTop+=section.getBoundingClientRect().top-s.getBoundingClientRect().top+200;await new Promise(r=>setTimeout(r,300));
      const h=section.querySelector('[data-hunk-header]');let places=0;const watch=new MutationObserver(l=>places+=l.length);watch.observe(h,{attributeFilter:['data-live-key']});
      window.__longTasks=[];const deltas=[];let last=performance.now();
      for(let i=0;i<120;i++){s.scrollTop+=20;await new Promise(r=>requestAnimationFrame(r));const now=performance.now();deltas.push(now-last);last=now}
      await new Promise(r=>setTimeout(r,100));watch.disconnect();deltas.sort((a,b)=>a-b);
      return {frames:deltas.length,p50:Math.round(deltas[deltas.length>>1]*10)/10,max:Math.round(deltas.at(-1)*10)/10,longTasks:window.__longTasks.map(t=>Math.round(t.duration)),places}})()`);
    console.log('Scrolling far_mod.rs 20 px a frame, following the reader:', JSON.stringify(scrolling));
    assert.deepEqual(scrolling.longTasks, [], 'Following the reader adds no long task');
    assert.ok(scrolling.places > 10, `The header follows line by line: ${scrolling.places}`);

    // ═══ An Explanation topic: the same core checks in a slide ═══
    await openTopic();
    const slideDeep = topicFile('src/nav/deep.ts');
    await wait(`!!window.q(${JSON.stringify(slideDeep)})&&window.symbols(${JSON.stringify(slideDeep)}).length>=2`, 500);
    // The topic's code column sets its own width: the window is fixed at 1440 px for it (openTopic). The file comes into
    // view first, as a reader scrolls to it.
    await js(`(()=>{const s=window.q('${DOC}');s.scrollTop+=window.q(${JSON.stringify(slideDeep)}).getBoundingClientRect().top-s.getBoundingClientRect().top-20})()`);
    await settle();
    await sleep(600);
    const slidePinned = await pin(slideDeep, DOC, 'next += 30 * 2;');
    assert.deepEqual(slidePinned.crumbs, ['Go to module Engine', 'Go to class Scheduler', 'Go to function run', 'Go to function step'], 'Topic: the same pinned breadcrumb');
    await jump('Topic', slideDeep, 'Go to class Scheduler', 'export class Scheduler {', { above: 'export namespace Engine', revealed: true });
    await pin(slideDeep, DOC, 'next += 40 * 2;');
    await jump('Topic', slideDeep, 'Go to function step', 'function step(value: number): number {', { keyboard: true, revealed: false });
    await js('document.activeElement?.blur()');
    const slideScoped = topicFile('src/nav/scoped.ts');
    await wait(`window.rails(${JSON.stringify(slideScoped)}).length>0`, 500);
    assert.equal(await js<number>(`window.shownCount(${JSON.stringify(slideScoped)},'export class Small {')`), 1, 'Topic: show scope shows the short class whole');
    assert.ok((await js<string[]>(`window.rails(${JSON.stringify(slideScoped)})`)).includes('2:start'), 'Topic: with its rail');
    assert.ok((await js<string[]>(`window.headerActions(${JSON.stringify(slideScoped)})`)).includes('Collapse class'), 'Topic: and Collapse');
    const slideOutline = topicFile('src/nav/outline.ts');
    await wait(`window.outline(${JSON.stringify(slideOutline)})?.chips.length===4||window.outline(${JSON.stringify(slideOutline)})?.rows.length===4`, 500);
    const topicOutline = await js<{ summary: string; chips: string[] }>(`window.outline(${JSON.stringify(slideOutline)})`);
    assert.equal(topicOutline.summary, 'Changes 4 functions', 'Topic: the same outline');
    clickPoint(await js<{ x: number; y: number }>(`window.center(${JSON.stringify(slideOutline)},'.diff-outline-chip[data-change=modified] .diff-outline-go','${DOC}')`));
    await landed(slideOutline);
    const topicLanding = await state(slideOutline);
    const topicTop = await js<number | null>(`window.lineTop(${JSON.stringify(slideOutline)},'export function merge(',false)`);
    assert.ok(topicTop !== null && topicLanding.bottom !== null && Math.abs(topicTop - topicLanding.bottom) <= 2, 'Topic: the outline goes to merge()');
    // Per-symbol ticks are the file revision's, in a topic as in Changes.
    await js(`(()=>{const s=window.q('${DOC}');s.scrollTop+=window.q(${JSON.stringify(slideOutline)}).getBoundingClientRect().top-s.getBoundingClientRect().top})()`);
    await js(`window.q(${JSON.stringify(slideOutline)}).querySelector('.diff-outline-toggle').click()`);
    await wait(`window.outline(${JSON.stringify(slideOutline)}).rows.length===4`);
    await js(`window.q(${JSON.stringify(slideOutline)}).querySelectorAll('.diff-outline-tick')[1].click()`);
    await settle();
    const key = await js<string>(`(async()=>{const {fileRevisionKey}=await import('/lib/pr-changes.ts');return fileRevisionKey('https://github.com/klang/engine/pull/121','src/nav/outline.ts','base-1','head-1')})()`);
    assert.equal(
      await js(`(async()=>(await import('/lib/file-view-progress.ts')).isSymbolViewed(${JSON.stringify(key)},'function:rebase'))()`),
      true,
      'Topic: a tick is kept under the file revision Changes uses'
    );
    assert.deepEqual(errors, [], 'No console errors');
    console.log('Breadcrumb navigation checks passed: languages, pinned and unpinned crumbs, gaps, sides, input, motion, reading position, show scope, the outline, a topic and performance.');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
