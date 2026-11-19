import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

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
  const checkJump = async (surface: string, root: string, label: string, text: string, keyboard: boolean) => {
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
    await sleep(350);
    await settle();
    const after = await jumpState(root, text);
    console.log(`${surface}: ${label}`, JSON.stringify({ before: { ...before, crumbs: undefined }, after: { ...after, crumbs: undefined } }));
    if (after.line !== null)
      assert.ok(after.bottom !== null && Math.abs(after.line - after.bottom) <= 2, `${surface}: the definition's first line sits right under the pinned header`);
    else assert.ok(after.section !== null && Math.abs(after.section - (after.file - 1)) <= 1, `${surface}: the gap bar that hides it sits right under the file header`);
    assert.equal(after.lines, before.lines, `${surface}: nothing was revealed`);
    assert.equal(after.hidden, before.hidden, `${surface}: every gap still hides what it hid`);
    assert.equal(after.height, before.height, `${surface}: the header keeps its height`);
    if (keyboard) assert.equal(after.active, label, `${surface}: focus stays on the pinned crumb`);
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
          hunkText:rgb(style('.diff-gap[data-hunk-header] .diff-gap-crumb').color),added:rgb(style('.diff-gap-added').color),keyword:q('.diff-gap-kind')?rgb(style('.diff-gap-kind').color):''}};
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
    await checkJump('Changes', changesRow, 'Go to class StoreBridge', 'export class StoreBridge {', false);
    await pinChanges();
    await checkJump('Changes', changesRow, 'Go to function flush', 'flush(): number {', true);
    await js('document.activeElement?.blur()');

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
      return {scroller:Math.round(document.querySelector('.explanation-document').getBoundingClientRect().top),file:Math.round(g.querySelector('.changes-file-header').getBoundingClientRect().bottom),hunk:Math.round(g.querySelector('.diff-gap[data-stuck]').getBoundingClientRect().top)}})()`);
    assert.ok(Math.abs(pinned.hunk - pinned.file + 1) <= 1, `The hunk header pins right under the file header: ${JSON.stringify(pinned)}`);
    await capture('explanation-pinned', region('.explanation-document', 0, 260));
    // The same pinned crumbs in the topic, inside the explanation document's scroller (#417).
    const pinTopic = async () => {
      await js(`(()=>{const s=document.querySelector('.explanation-document');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(topic)})).find(e=>e.textContent.includes('total += 40;'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-200})()`);
      await settle();
      await wait(`!!document.querySelector(${JSON.stringify(topic)}+' .diff-gap[data-hunk-header][data-stuck][data-live=scope]')`);
    };
    await pinTopic();
    await checkJump('Topic', topic, 'Go to class StoreBridge', 'export class StoreBridge {', false);
    await capture('explanation-crumb-jump', region('.explanation-document', 0, 260));
    await pinTopic();
    await checkJump('Topic', topic, 'Go to function flush', 'flush(): number {', true);
    await js('document.activeElement?.blur()');
    assert.deepEqual(errors, []);
    if (shots) await sideBySide();
    console.log('Explanation parity checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
