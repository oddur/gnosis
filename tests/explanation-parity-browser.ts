import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { scopeAfter, scopeBefore } from './fixtures/syntax-scope';

/**
 * A conflict session for the Conflicts view's part of this suite: src/scope.ts as the PR changed it (Changes' version),
 * and main changing the same line of flush() another way, so the one conflict sits inside the method.
 */
function parityConflict() {
  const text = (lines: string[]) => `${lines.join('\n')}\n`;
  const theirs = scopeBefore.map((line) => (line === '    total += 30;' ? '    total += 30 + 1;' : line));
  const original = scopeAfter.flatMap((line) =>
    line === '    total += 30 * 2;'
      ? ['<<<<<<< feature/scope', line, '||||||| ancestor', '    total += 30;', '=======', '    total += 30 + 1;', '>>>>>>> main']
      : [line]
  );
  return {
    id: 'e'.repeat(64),
    account: 'oddur',
    url: 'https://github.com/klang/engine/pull/120',
    title: 'Bound retry delays',
    headRepo: 'klang/engine',
    baseRepo: 'klang/engine',
    headBranch: 'feature/scope',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    version: 1,
    status: 'editing',
    files: [
      {
        path: 'src/scope.ts',
        mode: '100644',
        base: text(scopeBefore),
        ours: text(scopeAfter),
        theirs: text(theirs),
        original: text(original),
        result: text(original),
        resolved: false,
        source: 'manual',
      },
    ],
  };
}

/**
 * Explanation topics show diffs as Changes does (#157 parity). AGENTS.md: Changes (PrFileInspection/ChangesDiff) and
 * Explanation topics (SlideView/ReviewDiff) render diffs through the same components. This suite fails when a topic's
 * diff stops doing so: the same file, src/scope.ts from tests/fixtures/syntax-scope.ts, opens in Changes and in a topic
 * that shows two of its four hunks (`?explanation-parity`).
 *
 * - Both render ChangesDiff: `.changes-diff`, `.diff-hunk` sections and `[data-hunk-header]` bars built of the same parts,
 *   with the same tree-sitter breadcrumbs, line ranges and counts for the hunks the topic shows.
 * - The topic's file header is Changes' code-tier header with the same palette; its hunk headers use the same colours.
 * - Show whole function reveals the method in the topic; a header pins under the file header while the topic's code
 *   scrolls in the explanation document; the inline explanation and a draft comment sit on their line.
 * - In both, a pinned crumb scrolls to its definition by mouse and by keyboard, revealing nothing (#417).
 *
 * With GNOSIS_PARITY_SHOTS=1 it prints `PARITYSHOT <name> <base64 PNG>` lines of both surfaces, light and dark.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
    await sleep(200);
    await js(frames);
  };
  const shots = !!process.env.GNOSIS_PARITY_SHOTS;
  const images = new Map<string, string>();
  /** Each Changes shot beside the topic's, labelled, drawn on a canvas in the page. */
  const sideBySide = async () => {
    for (const kind of ['unpinned', 'pinned', 'comment'])
      for (const theme of ['light', 'dark']) {
        const left = images.get(`changes-${kind}-${theme}`),
          right = images.get(`explanation-${kind}-${theme}`);
        if (!left || !right) continue;
        const png = await js<string>(`(async()=>{const load=s=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+s});
          const [a,b]=await Promise.all([load(${JSON.stringify(left)}),load(${JSON.stringify(right)})]);const gap=24,top=32;
          const c=document.createElement('canvas');c.width=a.width+b.width+gap;c.height=Math.max(a.height,b.height)+top;const x=c.getContext('2d');
          x.fillStyle=${JSON.stringify(theme === 'dark' ? '#0d1117' : '#ffffff')};x.fillRect(0,0,c.width,c.height);
          x.fillStyle=${JSON.stringify(theme === 'dark' ? '#c9d1d9' : '#24292f')};x.font='600 14px system-ui, sans-serif';
          x.fillText('Changes',10,21);x.fillText('Explanation topic',a.width+gap+10,21);x.drawImage(a,0,top);x.drawImage(b,a.width+gap,top);
          return c.toDataURL('image/png').split(',')[1]})()`);
        console.log(`PARITYSHOT side-by-side-${kind}-${theme} ${png}`);
      }
  };
  /** Prints the region of `rect` (an expression) in light and dark. */
  const capture = async (name: string, rect: string) => {
    if (!shots) return;
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark',${dark})`);
      await settle();
      const r = await js<{ x: number; y: number; width: number; height: number }>(rect);
      const png = (await win.webContents.capturePage(r)).toPNG().toString('base64');
      images.set(`${name}-${dark ? 'dark' : 'light'}`, png);
      console.log(`PARITYSHOT ${name}-${dark ? 'dark' : 'light'} ${png}`);
    }
    await js(`document.documentElement.classList.toggle('dark',false)`);
    await settle();
  };
  /** A region of a scroller: its full width, from `top` px below its top edge, `height` tall. */
  const region = (scroller: string, top: number, height: number) =>
    `(()=>{const b=document.querySelector(${JSON.stringify(scroller)}).getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top+${top}),width:Math.round(b.width),height:Math.round(Math.min(${height},b.height-${top}))}})()`;
  /** Clicks a code line's number in `root`'s diffs, as a reader does, to start a comment there. */
  const clickLineNumber = async (root: string, line: number) => {
    const point = await js<{ x: number; y: number }>(`(()=>{const root=document.querySelector(${JSON.stringify(root)});
      const cells=window.deepAll('[data-column-number="${line}"]',root);
      const cell=cells.find(e=>e.dataset.lineType==='change-addition')??cells.find(e=>e.dataset.lineType!=='change-deletion');
      if(!cell)throw Error('No line ${line}');cell.scrollIntoView({block:'center'});const r=cell.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  type Jump = { file: number; bottom: number | null; height: number | null; section: number | null; lines: number; hidden: string; line: number | null; active: string | null; crumbs: string[] };
  /** The pinned header in `root` and the first shown line with `text`, for a pinned crumb's jump (#417). */
  const jumpState = (root: string, text: string) =>
    js<Jump>(`(()=>{const g=document.querySelector(${JSON.stringify(root)});const file=g.querySelector('.changes-file-header').getBoundingClientRect();
      const h=g.querySelector('.diff-gap[data-hunk-header][data-stuck]');const r=h?.getBoundingClientRect();
      const l=window.deepAll('[data-line]',g).find(e=>e.textContent.includes(${JSON.stringify(text)})&&e.dataset.lineType!=='change-deletion'&&e.getBoundingClientRect().height>0);
      const a=document.activeElement;
      return {file:Math.round(file.bottom),bottom:r?Math.round(r.bottom):null,height:r?Math.round(r.height):null,section:h?Math.round(h.parentElement.getBoundingClientRect().top):null,
        lines:window.deepAll('[data-line]',g).length,hidden:[...g.querySelectorAll('.diff-gap[data-gap]')].map(e=>e.getAttribute('aria-label')).join('|'),
        line:l?Math.round(l.getBoundingClientRect().top):null,active:a?.matches?.('.diff-gap-live button[data-jump]')?a.getAttribute('aria-label'):null,
        crumbs:h?[...h.querySelectorAll('.diff-gap-live button[data-jump]')].map(b=>b.getAttribute('aria-label')):[]}})()`);
  /**
   * Clicks (or, from the keyboard, focuses and presses Enter on) the pinned crumb `label` in `root`, and checks that
   * the definition's first line (`text`) lands right under the pinned header, or, hidden in a gap, its gap's bar
   * pinned in place; that nothing was revealed; and that the header kept its height.
   */
  const shown = (root: string, text: string) =>
    js<boolean>(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(root)})).some(e=>e.textContent.includes(${JSON.stringify(text)})&&e.getBoundingClientRect().height>0)`);
  /** `reveal`: the definition's first line starts hidden; `between` must show after the jump and `above` must not. */
  const checkJump = async (
    surface: string,
    root: string,
    label: string,
    text: string,
    keyboard: boolean,
    reveal?: { between: string; above: string }
  ) => {
    const before = await jumpState(root, text);
    assert.ok(before.crumbs.includes(label), `${surface}: the pinned header has the crumb ${label}: ${JSON.stringify(before.crumbs)}`);
    if (keyboard) {
      await js(`[...document.querySelectorAll(${JSON.stringify(root + ' [data-stuck] .diff-gap-live button[data-jump]')})].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}).focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    } else {
      const point = await js<{ x: number; y: number }>(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(root + ' [data-stuck] .diff-gap-live button[data-jump]')})].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)});
        const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    await sleep(100);
    await wait(`window.deepAll('[data-here]',document.querySelector(${JSON.stringify(root)})).length>0`, 60);
    await settle();
    const after = await jumpState(root, text);
    console.log(`${surface}: ${label}`, JSON.stringify({ before: { ...before, crumbs: undefined }, after: { ...after, crumbs: undefined } }));
    assert.ok(after.line !== null && after.bottom !== null && Math.abs(after.line - after.bottom) <= 2, `${surface}: the definition's first line sits right under the pinned header`);
    if (reveal) {
      // Every line from the definition's first line down to the reader shows; nothing above it does.
      assert.equal(before.line, null, `${surface}: the definition's first line started hidden`);
      assert.ok(after.lines > before.lines, `${surface}: the lines down to the reader were revealed`);
      assert.equal(await shown(root, reveal.between), true, `${surface}: the lines between the definition and the hunk show`);
      assert.equal(await shown(root, reveal.above), false, `${surface}: nothing above the definition shows`);
    } else {
      assert.equal(after.lines, before.lines, `${surface}: nothing was revealed`);
      assert.equal(after.hidden, before.hidden, `${surface}: every gap still hides what it hid`);
    }
    assert.equal(after.height, before.height, `${surface}: the header keeps its height`);
    if (keyboard) assert.equal(after.active, label, `${surface}: focus stays on the pinned crumb`);
    // Where it landed flashes, as a review check's line does: the line, or the gap bar standing in for it.
    const still = await js<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    const flashed = await js<{ kind: string; anim: string; band: string; gutter: boolean | null }[]>(`(()=>{const marks=root=>window.deepAll('[data-here]',root).filter(e=>!e.matches('[data-column-number],[data-gutter-buffer]')&&e.getAttribute('data-here-part')!=='body').map(e=>{const bar=e.matches('.diff-gap');const c=getComputedStyle(e,bar?'::before':'::after');const r=e.getBoundingClientRect();
        const i=e.getAttribute('data-line-index');const col=e.closest('[data-deletions],[data-additions]')??e.closest('[data-code]');const g=i!==null&&col?col.querySelector('[data-column-number][data-line-index="'+i+'"]'):null;
        return {kind:e.matches('[data-line]')?'line':bar?'bar':'other',text:e.textContent.trim().slice(0,40),anim:c.animationName.replace(/-[ab]$/,''),band:c.backgroundColor,gutter:g?g.getAttribute('data-here')!==null:null,
          edge:g?getComputedStyle(g,'::after').boxShadow:bar?c.boxShadow:null,top:Math.round(r.top),height:Math.round(r.height)}});return marks(document.querySelector(${JSON.stringify(root)}))})()`);
    console.log(`${surface}: here`, JSON.stringify(flashed));
    // The whole definition is marked, its signature most and the rest of it more softly (lib/diff-here.ts).
    const body = await js<number>(`window.deepAll('[data-line][data-here][data-here-part=body]',document.querySelector(${JSON.stringify(root)})).length`);
    assert.ok(body > 0, `${surface}: the rest of the definition is marked too: ${body} rows`);
    assert.deepEqual(
      flashed.map((f) => [f.kind, f.anim, f.gutter, ...(still ? [f.band] : [])]),
      [['line', still ? 'none' : 'gnosis-here-band', true, ...(still ? ['rgba(47, 85, 212, 0.22)'] : [])]],
      `${surface}: where the jump landed is marked here${still ? ', still under reduced motion' : ''}`
    );
    await sleep(2100);
    const done = await jumpState(root, text);
    assert.equal(await js<number>(`window.deepAll('[data-here]',document.querySelector(${JSON.stringify(root)})).length`), 0, `${surface}: the band ends`);
    assert.equal(done.line, after.line, `${surface}: the flash moved nothing`);
    assert.equal(done.lines, after.lines, `${surface}: nothing was revealed`);
    return after;
  };
  type Header = { parts: string[]; crumbs: string; range?: string; counts?: string; show?: string };
  type Palette = { file: string; fileText: string; hunk: string; hunkText: string; added: string; keyword: string };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&syntax-scope&explanation-parity`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];
      // Each hunk header of a diff: its parts in order, its breadcrumb, lines, counts and Show whole action.
      window.headers=root=>[...root.querySelectorAll('.changes-diff > .diff-hunk > .diff-gap[data-hunk-header]')].map(h=>({
        parts:[...h.children].map(c=>c.className),
        crumbs:[...h.querySelectorAll('.diff-gap-where > .diff-gap-scope:not([data-provisional]) .diff-gap-crumb')].map(c=>c.textContent.trim()).join(' › '),
        range:h.querySelector('.diff-gap-range > [aria-hidden]')?.textContent,counts:h.querySelector('.diff-gap-counts > [aria-hidden]')?.textContent,
        show:h.querySelector('[data-show-definition]')?.textContent.trim()}));
      // The code tier's colours, as the reader sees them.
      window.palette=root=>{const c=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const rgb=v=>{c.clearRect(0,0,1,1);c.fillStyle='#000';c.fillStyle=v;c.fillRect(0,0,1,1);const d=c.getImageData(0,0,1,1).data;return '#'+[d[0],d[1],d[2]].map(n=>n.toString(16).padStart(2,'0')).join('')};
        const q=s=>root.querySelector(s);const style=s=>getComputedStyle(q(s));
        return {file:rgb(style('.changes-file-header').backgroundColor),fileText:rgb(style('.changes-file-header h2').color),hunk:rgb(style('.diff-gap[data-hunk-header]').backgroundColor),
          hunkText:rgb(style('.diff-gap[data-hunk-header] .diff-gap-crumb[data-innermost]').color),added:rgb(style('.diff-gap-added').color),keyword:q('.diff-gap-kind')?rgb(style('.diff-gap-kind').color):''}};
      void 0`);

    // ── Changes: src/scope.ts whole ──
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='scope.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='scope.ts').click()");
    const changesRow = '.commit-stream-row[data-file="src/scope.ts"]';
    await wait(`(window.headers(document.querySelector(${JSON.stringify(changesRow)})??document.body).filter(h=>h.crumbs).length>=3)`, 500);
    await settle();
    const changes = await js<Header[]>(`window.headers(document.querySelector(${JSON.stringify(changesRow)}))`);
    const changesPalette = await js<Palette>(`window.palette(document.querySelector(${JSON.stringify(changesRow)}))`);
    console.log('Changes headers:', JSON.stringify(changes));
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const h=document.querySelector(${JSON.stringify(changesRow)}+' [data-show-definition]').closest('.diff-gap');s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
    await capture('changes-unpinned', region('.commit-diff-stream', 0, 420));
    if (shots) {
      // The same place in split view: D switches the layout, and again switches it back.
      const layoutKey = `document.querySelector('.commit-diff-stream').dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,cancelable:true,composed:true}))`;
      const deletionColumns = `window.deepAll('[data-deletions]',document.querySelector(${JSON.stringify(changesRow)})).length`;
      await js(layoutKey);
      await wait(`document.querySelector('.pr-changes')?.dataset.diffLayout==='split'&&${deletionColumns}>0`);
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const h=document.querySelector(${JSON.stringify(changesRow)}+' [data-show-definition]').closest('.diff-gap');s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
      await capture('changes-split', region('.commit-diff-stream', 0, 420));
      await js(layoutKey);
      await wait(`document.querySelector('.pr-changes')?.dataset.diffLayout==='unified'&&${deletionColumns}===0`);
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const h=document.querySelector(${JSON.stringify(changesRow)}+' [data-show-definition]').closest('.diff-gap');s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-140})()`);
    }
    // A draft comment on the line the topic explains, for the same view in both.
    const flush = await js<number>(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(changesRow)})).find(e=>e.textContent.includes('total += 30 * 2'))?.dataset.line|0`);
    assert.ok(flush > 0, 'Changes shows the flush change');
    await clickLineNumber(changesRow, flush);
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    await js(`(()=>{const t=document.querySelector('.changes-comment-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Why only the 30th step?');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const t=document.querySelector('.changes-comment-composer');s.scrollTop+=t.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
    await capture('changes-comment', region('.commit-diff-stream', 0, 460));
    await js(`[...document.querySelectorAll('.changes-comment-composer button')].find(b=>b.textContent.trim()==='Cancel')?.click()`);
    // Pinned: the method shown whole is taller than the view, and its header pins under the file header.
    await js(`document.querySelector(${JSON.stringify(changesRow)}+' [data-show-definition]').click()`);
    await wait(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(changesRow)})).some(e=>e.textContent.includes('flush(): number {'))`);
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(changesRow)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
    await settle();
    await wait(`!!document.querySelector(${JSON.stringify(changesRow)}+' .diff-gap[data-hunk-header][data-stuck]')`);
    await capture('changes-pinned', region('.commit-diff-stream', 0, 260));
    // A pinned crumb scrolls to its definition and reveals nothing (#417), by mouse and by keyboard.
    const pinChanges = async () => {
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(changesRow)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
      await settle();
      await wait(`!!document.querySelector(${JSON.stringify(changesRow)}+' .diff-gap[data-hunk-header][data-stuck][data-live=scope]')`);
    };
    await pinChanges();
    await checkJump('Changes', changesRow, 'Go to class StoreBridge', 'export class StoreBridge {', false, { between: 'private items = new Map', above: 'export const before29' });
    await pinChanges();
    await checkJump('Changes', changesRow, 'Go to function flush', 'flush(): number {', true);
    await js('document.activeElement?.blur()');

    // ── A stale topic diff refreshes by itself, through the same model as Changes ──
    // The topic's first read of src/scope.ts (both sides) disagrees with its saved hunks on the line it explains. The PR's changes
    // refresh once at the view tier, the file reads again, and the topic then shows as in Changes. Queue preparation
    // does not read the file, so the first read is the topic's.
    await js(`(async()=>{window.changeReads=[];window.scopeReads=0;window.corruptScope=1;
      const corrupt=(path,side)=>{if(path!=='src/scope.ts'||side?.kind!=='text')return side;window.scopeReads++;if(window.corruptScope<1)return side;window.corruptScope--;return {...side,content:side.content.replace('total += 30 * 2','total += 30 * 3')}};
      {const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async(r,...rest)=>{if(rest[0]===true&&r.path==='src/scope.ts')throw Error('Not prepared in this check');const v=await read(r,...rest);return {...v,after:corrupt(r.path,v.after)}};}
      {const read=window.electronAPI.getPrChanges;window.electronAPI.getPrChanges=(url,refresh,options)=>{if(refresh)window.changeReads.push({view:!!options?.view,recheck:options?.recheck?.paths??null});return read(url,refresh,options)};}
      (await import('/lib/inspection-cache.ts')).inspectionFiles.clear()})()`);

    // ── The topic: the same file, two of its hunks ──
    await click('Review queue');
    await wait("!!document.querySelector('.queue-row-main')");
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()");
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.explanation-reader')");
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
    const topic = '[data-explanation-section="1"] .review-file-group';
    await wait(`!!document.querySelector(${JSON.stringify(topic)}+' .changes-diff')`, 500);
    // The parity this suite guards: the topic renders Changes' diff, not a diff of its own.
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(topic)}+' .changes-file-header')`), true, 'The topic uses the code-tier file header');
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(topic)}+' :is(.review-context-hunk,.diff-context-gap,.review-file-context)').length`), 0, 'No topic-only diff chrome');
    // The topic read the file out of step, refreshed once, and is done refreshing.
    await wait(`window.corruptScope===0&&window.changeReads.length===1&&!document.querySelector(${JSON.stringify(topic)}).textContent.includes('Updating to the latest version')`, 500);
    await wait(`window.headers(document.querySelector(${JSON.stringify(topic)})).filter(h=>h.crumbs).length>=2`, 500);
    await settle();
    const slide = await js<Header[]>(`window.headers(document.querySelector(${JSON.stringify(topic)}))`);
    console.log('Topic headers:', JSON.stringify(slide));
    assert.equal(slide.length, 2, 'The topic shows its two hunks');
    for (const header of slide) {
      const twin = changes.find((other) => other.crumbs === header.crumbs);
      assert.ok(twin, `Changes shows the same breadcrumb: ${header.crumbs}`);
      assert.deepEqual(header.parts, twin.parts, `The header is built of the same parts: ${header.crumbs}`);
      assert.equal(header.counts, twin.counts, `The same counts: ${header.crumbs}`);
      assert.equal(header.range, twin.range, `The same lines: ${header.crumbs}`);
      assert.equal(header.show, twin.show, `The same definition action: ${header.crumbs}`);
    }
    assert.match(slide.map((h) => h.crumbs).join('\n'), /StoreBridge › .*flush/, 'Breadcrumbs reach the method');
    assert.equal(await js('window.corruptScope'), 0, 'The topic read the file out of step with its hunks');
    assert.deepEqual(await js('window.changeReads'), [{ view: true, recheck: ['src/scope.ts'] }], 'One automatic refresh at the view tier');
    assert.ok(await js<boolean>(`!document.querySelector(${JSON.stringify(topic)}).textContent.match(/Couldn’t match|Updating to the latest|changed on GitHub/)`), 'The topic recovered');
    // Between the topic's hunks: a gap bar, as in Changes.
    assert.ok(await js(`!!document.querySelector(${JSON.stringify(topic)}+' .diff-gap[data-gap]')`), 'Gap bars between hunks');
    const slidePalette = await js<Palette>(`window.palette(document.querySelector(${JSON.stringify(topic)}))`);
    assert.deepEqual(slidePalette, changesPalette, 'The topic takes Changes’ code-tier palette');
    // The inline explanation sits on its line.
    await wait(`[...document.querySelectorAll(${JSON.stringify(topic)}+' .inline-code-explanation')].some(e=>e.textContent.includes('Doubling only the 30th step'))`);
    await js(`(()=>{const s=document.querySelector('.explanation-document');const h=document.querySelector(${JSON.stringify(topic)});s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-20})()`);
    await capture('explanation-unpinned', region('.explanation-document', 0, 460));
    // A draft comment beside the inline explanation.
    await clickLineNumber(topic, flush);
    await wait(`!!document.querySelector(${JSON.stringify(topic)}+' textarea')`);
    await js(`(()=>{const t=document.querySelector(${JSON.stringify(topic)}+' textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Why only the 30th step?');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await js(`(()=>{const s=document.querySelector('.explanation-document');const t=document.querySelector(${JSON.stringify(topic)}+' textarea');s.scrollTop+=t.getBoundingClientRect().top-s.getBoundingClientRect().top-260})()`);
    await capture('explanation-comment', region('.explanation-document', 0, 460));
    await js(`[...document.querySelectorAll(${JSON.stringify(topic)}+' button')].find(b=>b.textContent.trim()==='Cancel')?.click()`);
    // Show whole function, in the topic.
    await js(`document.querySelector(${JSON.stringify(topic)}+' [data-show-definition]').click()`);
    await wait(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(topic)})).some(e=>e.textContent.includes('flush(): number {'))`, 500);
    assert.equal(
      await js(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(topic)})).filter(e=>/total \\+= \\d+;/.test(e.textContent)).length>=59`),
      true,
      'The whole method shows'
    );
    // Pinned inside the explanation document, under the file header.
    await js(`(()=>{const s=document.querySelector('.explanation-document');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(topic)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
    await settle();
    await wait(`!!document.querySelector(${JSON.stringify(topic)}+' .diff-gap[data-hunk-header][data-stuck]')`);
    const pinned = await js<{ file: number; hunk: number; scroller: number }>(`(()=>{const g=document.querySelector(${JSON.stringify(topic)});
      return {scroller:Math.round(document.querySelector('.explanation-document').getBoundingClientRect().top),file:Math.round(g.querySelector('.changes-file-header').getBoundingClientRect().bottom),hunk:Math.round((b=>b.getBoundingClientRect().top+parseFloat(getComputedStyle(b).borderTopWidth))(g.querySelector('.diff-gap[data-stuck]')))}})()`);
    // The bar's own top, under its air (the top border that slides under the file header when it pins).
    assert.ok(Math.abs(pinned.hunk - pinned.file + 1) <= 1, `The hunk header pins right under the file header: ${JSON.stringify(pinned)}`);
    await capture('explanation-pinned', region('.explanation-document', 0, 260));
    // The same pinned crumbs in the topic, inside the explanation document's scroller (#417).
    const pinTopic = async () => {
      await js(`(()=>{const s=document.querySelector('.explanation-document');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(topic)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
      await settle();
      await wait(`!!document.querySelector(${JSON.stringify(topic)}+' .diff-gap[data-hunk-header][data-stuck][data-live=scope]')`);
    };
    await pinTopic();
    await checkJump('Topic', topic, 'Go to class StoreBridge', 'export class StoreBridge {', false, { between: 'private items = new Map', above: 'export const before29' });
    await capture('explanation-crumb-jump', region('.explanation-document', 0, 260));
    // With reduced motion, the band is still.
    await pinTopic();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await checkJump('Topic', topic, 'Go to function flush', 'flush(): number {', true);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();
    await js('document.activeElement?.blur()');

    // ── Reading order: a topic that goes scope.ts, imports.ts, then back to scope.ts ──
    // The planner's hunk order is kept; each return to a file gets its own block with the same header.
    await js(`window.selectOption('[aria-label="Explanation section"]', '2')`);
    const ordered = '[data-explanation-section="2"] .review-file-group';
    const block = (n: number) => `document.querySelectorAll(${JSON.stringify(ordered)})[${n}]`;
    await wait(`(()=>{const g=[...document.querySelectorAll(${JSON.stringify(ordered)})];return g.length===3&&g.every(e=>e.querySelector('.changes-diff'))})()`, 500);
    await settle();
    type Block = { path: string; run: string; header: boolean; content: string; controls: string | null; hidden: boolean; viewed: boolean | null; lines: number; gaps: string };
    const blocks = () =>
      js<Block[]>(`[...document.querySelectorAll(${JSON.stringify(ordered)})].map(g=>{const content=g.querySelector(':scope > .review-file-content');const box=g.querySelector('.review-file-viewed input');
        return {path:g.dataset.filePath.replace(/^.*?src\\//,'src/'),run:g.dataset.fileRun,header:!!g.querySelector(':scope > .changes-file-header'),content:content.id,
          controls:g.querySelector('.review-file-expand')?.getAttribute('aria-controls')??null,hidden:content.hidden,viewed:box?box.checked:null,
          lines:window.deepAll('[data-line]',content).length,gaps:[...content.querySelectorAll('.diff-gap[data-gap]')].map(e=>e.dataset.gap+': '+e.getAttribute('aria-label')).join('|')}})`);
    const initial = await blocks();
    console.log('Reading-order blocks:', JSON.stringify(initial));
    assert.deepEqual(
      initial.map((b) => [b.path, b.run]),
      [
        ['src/scope.ts', '0'],
        ['src/imports.ts', '0'],
        ['src/scope.ts', '1'],
      ],
      'The blocks follow the reading order A, B, A'
    );
    assert.ok(initial.every((b) => b.header), 'Each block has the code-tier file header');
    assert.equal(new Set(initial.map((b) => b.content)).size, 3, 'Each block has its own content id');
    assert.deepEqual(
      initial.map((b) => b.controls),
      initial.map((b) => b.content),
      'Each header controls its own block'
    );
    assert.ok(initial.every((b) => !b.hidden && b.lines > 0), 'Every block starts open');
    // Collapsing one block of scope.ts leaves the other open.
    await js(`${block(0)}.querySelector('.review-file-expand').click()`);
    await wait(`${block(0)}.querySelector(':scope > .review-file-content').hidden`);
    assert.deepEqual((await blocks()).map((b) => b.hidden), [true, false, false], 'Collapse is per block');
    await js(`${block(0)}.querySelector('.review-file-expand').click()`);
    await wait(`!${block(0)}.querySelector(':scope > .review-file-content').hidden`);
    await settle();
    // Gaps reveal per block: opening a gap in the second scope.ts block does not touch the first.
    const beforeReveal = await blocks();
    assert.match(beforeReveal[2].gaps, /0: \d+ lines hidden/, `The second scope.ts block hides lines above its hunks: ${beforeReveal[2].gaps}`);
    await js(`(()=>{const b=[...${block(2)}.querySelectorAll('.diff-gap[data-gap="0"] button')].find(b=>/^Show/.test(b.getAttribute('aria-label')??b.textContent.trim()));if(!b)throw Error('No reveal in the second block');b.click()})()`);
    await wait(`window.deepAll('[data-line]',${block(2)}).length>${beforeReveal[2].lines}`, 500);
    await settle();
    const afterReveal = await blocks();
    assert.equal(afterReveal[0].lines, beforeReveal[0].lines, 'The first scope.ts block shows the same lines');
    assert.equal(afterReveal[0].gaps, beforeReveal[0].gaps, 'The first scope.ts block hides what it hid');
    assert.ok(afterReveal[2].lines > beforeReveal[2].lines, 'The second block revealed lines');
    assert.notEqual(afterReveal[2].gaps, beforeReveal[2].gaps, 'The second block’s gap changed');
    // Viewed is per file: marking scope.ts viewed in its second block closes both of its blocks, not imports.ts.
    if (initial[2].viewed !== null) {
      await js(`${block(2)}.querySelector('.review-file-viewed input').click()`);
      await wait(`${block(0)}.querySelector(':scope > .review-file-content').hidden&&${block(2)}.querySelector(':scope > .review-file-content').hidden`);
      const viewed = await blocks();
      assert.deepEqual(viewed.map((b) => [b.viewed, b.hidden]), [[true, true], [false, false], [true, true]], 'Viewed applies to both blocks of the file');
      await js(`${block(0)}.querySelector('.review-file-viewed input').click()`);
      await wait(`!${block(0)}.querySelector(':scope > .review-file-content').hidden&&!${block(2)}.querySelector(':scope > .review-file-content').hidden`);
      assert.deepEqual((await blocks()).map((b) => [b.viewed, b.hidden]), [[false, false], [false, false], [false, false]], 'Unmarking opens both again');
    } else assert.fail('The explanation offers the Viewed checkbox');
    await settle();
    // A gap over a change another block shows reveals nothing: it names the block and offers a jump there.
    const elsewhere = await js<{ block: number; target: string; label: string; reveals: string[] }[]>(`[0,2].flatMap(n=>[...document.querySelectorAll(${JSON.stringify(ordered)})[n].querySelectorAll('.diff-gap[data-elsewhere]')].map(g=>({block:n,target:g.dataset.elsewhere,label:g.getAttribute('aria-label'),
      reveals:[...g.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')??b.textContent.trim())})))`);
    console.log('Gaps over another block:', JSON.stringify(elsewhere));
    assert.ok(elsewhere.some((g) => g.block === 0 && g.target === '1'), 'The first scope.ts block’s gap over the second block’s change names it');
    assert.ok(elsewhere.some((g) => g.block === 2 && g.target === '0'), 'The second block’s gap over the first block’s change names it');
    for (const g of elsewhere) {
      assert.equal(g.label, 'Shown in another part of this topic');
      assert.ok(g.reveals.includes('Go to it'), 'The bar offers the jump');
    }
    // Revealing everything such a bar offers stops before the other block's change: the bar stays, and no changed line
    // of the second block shows in the first.
    const changesOf = (n: number) =>
      `window.deepAll('[data-line]',${block(n)}).filter(e=>/change-(addition|deletion)/.test(e.dataset.lineType??'')).map(e=>e.textContent)`;
    for (let i = 0; i < 20; i++) {
      const clicked = await js<boolean>(`(()=>{const b=[...${block(0)}.querySelectorAll('.diff-gap[data-elsewhere] button')].find(b=>/^Show (all|\\d+ lines?)|^Show$/.test(b.getAttribute('aria-label')??b.textContent.trim()));if(b)b.click();return !!b})()`);
      if (!clicked) break;
      await settle();
    }
    assert.ok(await js<boolean>(`!!${block(0)}.querySelector('.diff-gap[data-elsewhere]')`), 'The bar over the other block’s change stays');
    const own = await js<string[]>(changesOf(0)),
      other = await js<string[]>(changesOf(2));
    assert.deepEqual(own.filter((text) => other.includes(text)), [], 'No change of the second block shows in the first');
    await js(`[...${block(0)}.querySelectorAll('.diff-gap[data-elsewhere="1"] button')].find(b=>b.textContent.trim()==='Go to it').click()`);
    // It lands on the change: the line is marked in the second block, in view.
    await wait(`(()=>{const s=document.querySelector('.explanation-document').getBoundingClientRect();const l=window.deepAll('[data-here]',${block(2)}).find(e=>e.matches('[data-line]'));if(!l)return false;const r=l.getBoundingClientRect();return r.top>=s.top&&r.bottom<=s.bottom})()`, 500);
    // A jump to a line in the second scope.ts block, collapsed first, opens that block and lands on the line.
    await js(`${block(2)}.querySelector('.review-file-expand').click()`);
    await wait(`${block(2)}.querySelector(':scope > .review-file-content').hidden`);
    await js(`document.querySelector('.explanation-document').scrollTop=0`);
    const jumpLine = await js<number>('window.parityJumpLine');
    await js(`[...document.querySelectorAll('[data-explanation-section="2"] .cursor-pointer')].find(e=>e.textContent.includes('Does the last change keep the total?')).click()`);
    await wait(`window.deepAll('[data-here]',${block(2)}).some(e=>e.dataset.lineNumber==='${jumpLine}')`, 500);
    assert.equal(await js(`${block(2)}.querySelector(':scope > .review-file-content').hidden`), false, 'The jump opened the block');
    assert.equal(await js<number>(`window.deepAll('[data-here]',${block(0)}).length`), 0, 'Nothing in the first block is marked');

    // ── Overlapping hunks listed apart share one block, and each line shows once ──
    await js(`window.selectOption('[aria-label="Explanation section"]', '3')`);
    const overlap = '[data-explanation-section="3"] .review-file-group';
    await wait(`(()=>{const g=[...document.querySelectorAll(${JSON.stringify(overlap)})];return g.length===2&&g.every(e=>window.deepAll('[data-line]',e).length>0)})()`, 500);
    await settle();
    const merged = await js<{ paths: string[]; changes: string[] }>(`(()=>{const g=[...document.querySelectorAll(${JSON.stringify(overlap)})];
      return {paths:g.map(e=>e.dataset.filePath.replace(/^.*?src\\//,'src/')),changes:window.deepAll('[data-line]',g[0]).filter(e=>/change-(addition|deletion)/.test(e.dataset.lineType??'')).map(e=>e.dataset.lineType+':'+e.textContent)}})()`);
    console.log('Overlapping hunks:', JSON.stringify(merged));
    assert.deepEqual(merged.paths, ['src/scope.ts', 'src/imports.ts'], 'One block of scope.ts, then imports.ts');
    assert.ok(merged.changes.length > 0);
    assert.equal(new Set(merged.changes).size, merged.changes.length, 'Every changed line shows once');

    // ── Other parts of a file (#560): the header counts the section's own lines, and links jump to the other parts ──
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
    const firstScope = `document.querySelector('[data-explanation-section="1"] .review-file-group[data-file-run="0"]:is([data-file-path="src/scope.ts"],[data-file-path$="/src/scope.ts"])')`;
    await wait(`!!${firstScope}?.querySelector('.review-file-parts .review-file-part-link')`, 500);
    const parts = await js<{ sections: string; text: string; counts: string; label: string }>(`(()=>{const g=${firstScope};const p=g.querySelector('.review-file-parts');const c=g.querySelector('.changes-file-header .changes-file-counts');
      return {sections:p.dataset.otherParts,text:p.textContent,counts:c.textContent,label:c.getAttribute('aria-label')}})()`);
    console.log('Other parts:', JSON.stringify(parts));
    assert.match(parts.sections, /^2,3\b/, 'Sections 2 and 3 show other parts of scope.ts');
    assert.match(parts.text, /^Other parts of this file: sections 2, 3/);
    assert.match(parts.counts, /^\+\d+−\d+ here · file \+\d+−\d+$/, `The header counts the section's lines beside the file's: ${parts.counts}`);
    assert.match(parts.label, /in this section; \d+ added lines?, \d+ removed lines? in the whole file$/);
    // The link goes through the Explanation's section navigation and lands on section 3's block of the file.
    await js(`${firstScope}.querySelector('.review-file-part-link[data-section="3"]').click()`);
    await wait(`(()=>{const a=document.activeElement;const g=a?.closest('.review-file-group');const s=document.querySelector('.explanation-document').getBoundingClientRect();const r=g?.getBoundingClientRect();
      return a?.closest('[data-explanation-section]')?.dataset.explanationSection==='3'&&(g?.dataset.filePath??'').endsWith('src/scope.ts')&&!!r&&r.top<s.bottom&&r.bottom>s.top})()`, 500);
    await capture('explanation-reading-order', `(()=>{const r=document.querySelector('[data-explanation-section="2"] .explanation-section-code').getBoundingClientRect();return {x:Math.round(r.left),y:Math.max(0,Math.round(r.top)),width:Math.round(r.width),height:Math.round(Math.min(800,r.height))}})()`);

    // ── Reduce noise: the overview lists the hunk left out as noise, and its entry opens Changes at its lines ──
    await js(`window.selectOption('[aria-label="Explanation section"]', '0')`);
    await wait("!!document.querySelector('.explanation-introduction .explanation-left-out summary')");
    assert.equal(await js("document.querySelector('.explanation-left-out summary').textContent.trim()"), '1 change left out as noise');
    await js("document.querySelector('.explanation-left-out summary').click()");
    await wait("!!document.querySelector('.explanation-left-out li button')");
    const leftOut = await js<{ location: string; reason: string }>(
      "(()=>{const b=document.querySelector('.explanation-left-out li button');return {location:b.querySelector('.explanation-left-out-location').textContent,reason:b.querySelector('.explanation-left-out-reason').textContent}})()"
    );
    const range = /src\/scope\.ts:(\d+)(?:-(\d+))?$/.exec(leftOut.location);
    assert.ok(range, `The entry names the file and its lines: ${leftOut.location}`);
    assert.equal(leftOut.reason, 'import only');
    const first = Number(range[1]);
    const last = range[2] ? Number(range[2]) : first;
    await js("document.querySelector('.explanation-left-out li button').click()");
    // Changes opens the PR's file (a stack member's, here) and scrolls its left-out lines into view.
    const leftOutRow = '.commit-stream-row:is([data-file="src/scope.ts"],[data-file$="/src/scope.ts"])';
    await wait(
      `(()=>{const s=document.querySelector('.commit-diff-stream')?.getBoundingClientRect();const row=document.querySelector(${JSON.stringify(leftOutRow)});
        return !!s&&!!row&&window.deepAll('[data-line]',row).some(e=>{const n=Number(e.dataset.line);const r=e.getBoundingClientRect();
          return n>=${first}&&n<=${last}&&e.dataset.lineType!=='change-deletion'&&r.height>0&&r.top>=s.top&&r.bottom<=s.bottom})})()`,
      500
    );
    assert.equal(await js("document.querySelector('.pr-overview-tabs [data-state=active]')?.textContent"), 'Changes');

    // ── The Conflicts view (#445 items 8 and 11): the same file with a conflict in flush(), in Changes' diff ──
    // Its diff is ChangesDiff under DiffFileHeader through useDiffFileModel, with no diff chrome of its own: the hunk
    // header is built of the same parts, reaches the method, takes the same palette, shows the method whole and pins
    // under the file header, as in Changes and the topic.
    await js(`(()=>{
      const s=${JSON.stringify(parityConflict())};
      window.paritySession=s;
      window.electronAPI.conflictResolution=async req=>{
        if(req.kind==='open')return {session:structuredClone(s)};
        if(req.kind==='save'){const f=s.files.find(f=>f.path===req.path);f.result=req.contents;f.resolved=req.resolved;}
        s.version++;return {session:structuredClone(s)};
      };
      window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:s.url}));
    })()`);
    const conflictDiff = '.conflict-workspace .conflict-compare-diff[data-compare=pr]';
    await wait(`!!document.querySelector(${JSON.stringify(conflictDiff)})&&window.headers(document.querySelector(${JSON.stringify(conflictDiff)})).filter(h=>h.crumbs).length>=1`, 500);
    await settle();
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(conflictDiff)}+' .changes-file-header')`), true, 'The Conflicts view uses the code-tier file header');
    assert.equal(
      await js("document.querySelectorAll('.conflict-workspace :is(.conflict-result-diff,.conflict-diff-columns,.conflict-modes,.review-context-hunk,.diff-context-gap)').length"),
      0,
      'No Conflicts-only diff chrome, and no Review result or Edit result mode'
    );
    const conflictHeaders = await js<Header[]>(`window.headers(document.querySelector(${JSON.stringify(conflictDiff)}))`);
    console.log('Conflicts headers:', JSON.stringify(conflictHeaders));
    const flushHeader = conflictHeaders.find((h) => /StoreBridge › .*flush/.test(h.crumbs));
    assert.ok(flushHeader, `The conflict's hunk header reaches the method: ${JSON.stringify(conflictHeaders)}`);
    const changesTwin = changes.find((h) => h.crumbs === flushHeader.crumbs);
    assert.ok(changesTwin, `Changes shows the same breadcrumb: ${flushHeader.crumbs}`);
    assert.deepEqual(flushHeader.parts, changesTwin.parts, 'The hunk header is built of the same parts as in Changes');
    assert.equal(flushHeader.show, changesTwin.show, 'The same definition action');
    assert.deepEqual(await js<Palette>(`window.palette(document.querySelector(${JSON.stringify(conflictDiff)}))`), changesPalette, 'The Conflicts view takes Changes’ code-tier palette');
    // The conflict's card sits under its lines, inside the diff, with Edit (#445 item 11).
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(conflictDiff)}+' .conflict-diff-cards .conflict-block[data-state=open] [data-conflict-edit]')`), true);
    await capture('conflicts-unpinned', region('.conflict-scroll', 0, 420));
    // Show whole function, then the hunk header pins under the file header while the view scrolls.
    await js(`document.querySelector(${JSON.stringify(conflictDiff)}+' [data-show-definition]').click()`);
    await wait(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(conflictDiff)})).some(e=>e.textContent.includes('flush(): number {'))`, 500);
    assert.ok(
      await js<boolean>(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(conflictDiff)})).filter(e=>/total \\+= \\d+;/.test(e.textContent)).length>=59`),
      'The whole method shows'
    );
    await js(`(()=>{const s=document.querySelector('.conflict-scroll');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(conflictDiff)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
    await settle();
    try {
      await wait(`!!document.querySelector(${JSON.stringify(conflictDiff)}+' .diff-gap[data-hunk-header][data-stuck]')`);
    } catch (error) {
      const state = await js<string>(`(()=>{const s=document.querySelector('.conflict-scroll');const g=document.querySelector(${JSON.stringify(conflictDiff)});const f=g.querySelector('.changes-file-header').getBoundingClientRect();const h=g.querySelector('.diff-gap[data-hunk-header]')?.getBoundingClientRect();
        return JSON.stringify({top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,scroller:s.getBoundingClientRect().top,file:[f.top,f.bottom],hunk:h&&[h.top,h.bottom],headers:g.querySelectorAll('.diff-gap[data-hunk-header]').length,pos:getComputedStyle(g.querySelector('.changes-file-header')).position})})()`);
      throw new Error(`Not pinned: ${state}`, { cause: error });
    }
    const conflictPinned = await js<{ file: number; hunk: number }>(`(()=>{const g=document.querySelector(${JSON.stringify(conflictDiff)});
      return {file:Math.round(g.querySelector('.changes-file-header').getBoundingClientRect().bottom),hunk:Math.round((b=>b.getBoundingClientRect().top+parseFloat(getComputedStyle(b).borderTopWidth))(g.querySelector('.diff-gap[data-stuck]')))}})()`);
    assert.ok(Math.abs(conflictPinned.hunk - conflictPinned.file + 1) <= 1, `The hunk header pins right under the file header: ${JSON.stringify(conflictPinned)}`);
    await capture('conflicts-pinned', region('.conflict-scroll', 0, 260));
    await js("[...document.querySelectorAll('.conflict-heading button')].find(b=>b.textContent.trim()==='Close').click()");
    await wait("!document.querySelector('.conflict-workspace')");
    assert.deepEqual(errors, []);
    if (shots) await sideBySide();
    console.log('Explanation parity checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
