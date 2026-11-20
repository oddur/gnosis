import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Quiet changes (#396): formatting-only and comment-only changes, from both sides' syntax trees, collapse to a bar
 * that shows them. `?noise-filter` (tests/fixtures/noise-filter.ts) has a file of formatting only, one of comments
 * only, one that mixes them with code, a Python file whose re-indented line leaves a loop, and a YAML file whose key
 * leaves its mapping.
 *
 * - The toggles live in Diff appearance: formatting hidden and comments shown by default; both are saved and survive
 *   a reload.
 * - A hunk whose every change is hidden is one bar under its header ("Formatting only · Show N lines"); its header
 *   keeps its counts. Show puts the hunk back.
 * - A file whose every change is hidden is one bar under its header, which says "Formatting only"; the file tree marks
 *   it in words, and the progress counts it among the files left, quietly.
 * - A hunk that changes code and reformats a line beside it stays, its quiet line dimmed.
 * - Python and YAML indentation that changes structure is never hidden.
 * - An Explanation topic of the same file shows the same bars.
 * - `?syntax-large`: comparisons run below breadcrumbs, and the numbers are printed.
 *
 * With GNOSIS_NOISE_SHOTS=1 it prints `NOISESHOT <name> <base64 PNG>` lines, light and dark.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
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
  const wait = async (expression: string, tries = 300) => {
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
  const shots = !!process.env.GNOSIS_NOISE_SHOTS;
  const capture = async (name: string, rect: string) => {
    if (!shots) return;
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark',${dark})`);
      await settle();
      const r = await js<{ x: number; y: number; width: number; height: number }>(rect);
      const png = (await win.webContents.capturePage(r)).toPNG().toString('base64');
      console.log(`NOISESHOT ${name}-${dark ? 'dark' : 'light'} ${png}`);
    }
    await js(`document.documentElement.classList.toggle('dark',false)`);
    await settle();
  };
  /** An element's box, padded and kept inside the window. */
  const box = (selector: string, pad = 8, extra = 0) =>
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const b=e.getBoundingClientRect();
      const x=Math.max(0,Math.round(b.left-${pad})),y=Math.max(0,Math.round(b.top-${pad}));return {x,y,width:Math.min(innerWidth-x,Math.round(b.width+2*${pad})),height:Math.min(innerHeight-y,Math.round(b.height+2*${pad}+${extra}))}})()`;
  const row = (path: string) => `.commit-stream-row[data-file=${JSON.stringify(path)}]`;
  /** Scrolls the Changes stream so `selector` sits `offset` px below its top. */
  const scrollTo = async (selector: string, offset = 80) => {
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-${offset}})()`);
    await settle();
  };
  const openChanges = async (query: string) => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?${query}`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');
  };
  /** Opens a file of the stream from the tree and waits until it has rendered its diff. */
  const openFile = async (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    await wait(`window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')===${JSON.stringify(name)})`);
    await js(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`);
    await wait(`!!document.querySelector(${JSON.stringify(row(path) + ' .changes-diff')})`, 500);
  };
  const toggles = () =>
    js<{ hideWhitespace: boolean; hideFormatting: boolean; hideComments: boolean }>(`(()=>{const q=k=>document.querySelector('[data-noise-toggle='+k+']');return {hideWhitespace:q('hideWhitespace').checked,hideFormatting:q('hideFormatting').checked,hideComments:q('hideComments').checked}})()`);
  const openMenu = async () => {
    if (!(await js<boolean>(`!!document.querySelector('[data-noise-toggle]')`))) await click('Diff appearance');
    await wait(`!!document.querySelector('[data-noise-toggle]')`);
  };
  const closeMenu = async () => {
    await js(`document.querySelector('[role=dialog]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(`!document.querySelector('[data-noise-toggle]')`);
  };
  const setToggle = async (key: 'hideWhitespace' | 'hideFormatting' | 'hideComments', on: boolean) => {
    await openMenu();
    if ((await toggles())[key] !== on) await js(`document.querySelector('[data-noise-toggle=${key}]').click()`);
    await wait(`window.electronAPI.loadPreferences().then(p=>(p.diffAppearance?.${key}??${key !== 'hideComments'})===${on})`);
    await openMenu();
    assert.equal((await toggles())[key], on, `${key} is ${on ? 'on' : 'off'}`);
  };
  /** Each hunk of a file: its header's counts, and whether it is a quiet bar and of what. */
  const hunks = (path: string) =>
    js<{ counts?: string; bar?: string; show?: string; lines: number }[]>(`[...document.querySelectorAll(${JSON.stringify(row(path) + ' .changes-diff > .diff-hunk')})].map(h=>({
      counts:h.querySelector('.diff-gap-counts > [aria-hidden]')?.textContent,bar:h.querySelector('[data-noise-bar]')?.getAttribute('data-noise-bar')??undefined,
      show:h.querySelector('[data-noise-show]')?.textContent.trim(),lines:window.deepAll('[data-line]',h).filter(e=>e.getBoundingClientRect().height>0).length}))`);
  const shownText = (path: string, text: string) =>
    js<boolean>(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row(path))})).some(e=>e.textContent.includes(${JSON.stringify(text)})&&e.getBoundingClientRect().height>0)`);
  const fileBar = (path: string) => js<string | null>(`document.querySelector(${JSON.stringify(row(path) + ' [data-noise-file]')})?.getAttribute('data-noise-file')??null`);
  const headerStat = (path: string) => js<string | null>(`document.querySelector(${JSON.stringify(row(path) + ' [data-noise-stat]')})?.textContent.trim()??null`);

  try {
    // A review thread on the formatter run's first line: its hunk must never collapse.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?noise-filter`);
    await waitForWorkbenchQueue(win.webContents);
    const threadScript = `(async()=>{const q=await window.electronAPI.workbenchQueue();const m=q.items.flatMap(i=>i.subject.members).find(m=>/reconnect/i.test(m.title));
      const stamp='2026-11-03T10:00:00Z';const c={id:'quiet-c',body:'Why double quotes here?',author:{login:'maya',avatarUrl:''},createdAt:stamp,updatedAt:stamp,url:m.url+'#discussion_r9',diffHunk:'',pullRequestReview:{id:'r9'},viewerCanUpdate:false,viewerCanDelete:false};
      const data={headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[{id:'quiet-thread',path:'src/noise/prettier.ts',line:1,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[c]}],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:false,state:'OPEN'}};
      window.electronAPI.getCachedReviewThreads=async url=>url===m.url?structuredClone(data):undefined;
      window.electronAPI.getReviewThreads=async url=>url===m.url?structuredClone(data):{headSha:'',baseSha:'',threads:[],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:false,state:'OPEN'}};})()`;
    await js(threadScript);
    await js(`window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await click('Changes');

    // ── Defaults: whitespace and formatting hidden, comments shown ──
    await openMenu();
    assert.deepEqual(await toggles(), { hideWhitespace: true, hideFormatting: true, hideComments: false }, 'Whitespace and formatting are hidden, comments shown');
    assert.equal(await js(`document.querySelector('[data-noise-toggle=hideWhitespace]').disabled`), true, 'Formatting includes whitespace: its toggle says so');
    await capture('toggles', box('[role=dialog][aria-label="Diff appearance"]', 6));
    await closeMenu();

    // ── A file of whitespace only: one bar under its header, a header label, a tree marker, the progress ──
    await openFile('src/noise/format.ts');
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/format.ts') + ' [data-noise-file]')})`, 500);
    assert.equal(await fileBar('src/noise/format.ts'), 'Whitespace only', 'The file is one bar');
    assert.equal(await headerStat('src/noise/format.ts'), 'Whitespace only', 'Its header says so');
    assert.equal(await js(`window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row('src/noise/format.ts'))})).length`), 0, 'No code lines render');
    assert.match(
      await js<string>(`document.querySelector(${JSON.stringify(row('src/noise/format.ts') + ' [data-noise-file]')}).textContent`),
      /Whitespace only\s*·\s*2 changes, \d+ lines\s*·\s*Show changes/,
      'The bar says how much it holds'
    );
    assert.match(await js<string>(`document.querySelector(${JSON.stringify(row('src/noise/format.ts') + ' .changes-file-counts')}).textContent`), /\+\d+.*−\d+/, 'The file keeps its +/− counts');
    await wait(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='format.ts')?.textContent.includes('Spaces')`);
    await wait(`!!document.querySelector('.changes-progress-quiet')`);
    assert.match(await js<string>(`document.querySelector('.changes-progress').textContent`), /0 \/ \d+ viewed · \d+ (quiet|whitespace-only) files?/, 'The progress counts it, quietly');
    await scrollTo(row('src/noise/format.ts'), 0);
    await capture('whole-file', box(row('src/noise/format.ts') + ' .changes-file-header', 0, 60));
    // ── The formatter run: "Reformatted", and the hunk with a review thread stays open ──
    await openFile('src/noise/prettier.ts');
    await wait(`document.querySelectorAll(${JSON.stringify(row('src/noise/prettier.ts') + ' [data-noise-bar]')}).length===3`, 500);
    assert.equal(await headerStat('src/noise/prettier.ts'), 'Reformatted', 'A formatter run says Reformatted');
    assert.equal(await fileBar('src/noise/prettier.ts'), null, 'A file with a thread is not one bar');
    assert.equal(await shownText('src/noise/prettier.ts', 'import { join } from "node:path";'), true, 'The thread’s hunk shows');
    await wait(`[...document.querySelectorAll(${JSON.stringify(row('src/noise/prettier.ts'))}+' *')].some(e=>e.textContent==='Why double quotes here?')||window.deepAll('*',document.querySelector(${JSON.stringify(row('src/noise/prettier.ts'))})).some(e=>e.textContent==='Why double quotes here?')`);
    await wait(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='prettier.ts')?.textContent.includes('Format')`);
    await capture('file-tree', box('.changes-tree-pane', 0));
    // Showing the whitespace file puts every change back.
    await openFile('src/noise/format.ts');
    await js(`document.querySelector(${JSON.stringify(row('src/noise/format.ts') + ' [data-noise-file] [data-noise-show]')}).click()`);
    await wait(`!document.querySelector(${JSON.stringify(row('src/noise/format.ts') + ' [data-noise-file]')})`);
    await settle();
    assert.equal(await shownText('src/noise/format.ts', 'return total(values) / values.length;'), true, 'Show changes shows the reformatted code');
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(row('src/noise/format.ts') + ' [data-noise-bar]')}).length`), 0, 'and no hunk stays hidden');

    // ── Mixed: a formatting hunk is a bar, code shows, a quiet line beside code is dimmed ──
    await openFile('src/noise/mixed.ts');
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')})`, 500);
    await settle();
    const mixed = await hunks('src/noise/mixed.ts');
    console.log('Mixed hunks:', JSON.stringify(mixed));
    assert.equal(mixed.length, 6, 'Six hunks');
    assert.equal(mixed[0].bar, 'Formatting only', 'The quote-style hunk is a formatting bar');
    assert.match(mixed[0].show ?? '', /^Show \d+ lines$/, 'which offers to show its lines');
    assert.equal(mixed[0].counts, '+1−1', 'Its header keeps its counts');
    assert.equal(mixed[0].lines, 0, 'No line of it renders');
    assert.equal(mixed[1].bar, undefined, 'The code hunk shows');
    assert.equal(await shownText('src/noise/mixed.ts', 'return value * 3;'), true, 'with its code');
    assert.equal(mixed[2].bar, undefined, 'The mixed hunk shows');
    assert.equal(mixed[3].bar, undefined, 'Comments show by default');
    assert.equal(mixed[4].bar, 'Whitespace only', 'The respaced signature is a whitespace bar');
    assert.equal(mixed[5].bar, undefined, 'The changed return shows');
    const dimmed = await js<string[]>(`window.deepAll('[data-line][data-noise-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).map(e=>e.textContent.trim())`);
    assert.ok(dimmed.length >= 2 && dimmed.every((text) => text.includes('Math.max(value')), `The respaced line beside the code change is dimmed: ${JSON.stringify(dimmed)}`);
    assert.equal(await js(`window.deepAll('[data-line][data-noise-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).some(e=>e.textContent.includes('99'))`), false, 'The code change is not');
    assert.match((await headerStat('src/noise/mixed.ts')) ?? '', /\+\d+\s*−\d+ code · \d+ (formatting|whitespace)/, 'The header says the code’s own counts, then the quiet lines');
    await scrollTo(row('src/noise/mixed.ts') + ' [data-noise-bar]', 120);
    await capture('formatting-bar', box(row('src/noise/mixed.ts') + ' .diff-hunk:has([data-noise-bar])', 0, 40));
    await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const e=window.deepAll('[data-noise-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))}))[0].getRootNode().host.closest('.diff-hunk');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-160})()`);
    await settle();
    await capture('mixed-hunk', `(()=>{const h=window.deepAll('[data-noise-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))}))[0].getRootNode().host.closest('.diff-hunk');const b=h.getBoundingClientRect();return {x:Math.round(b.left),y:Math.max(0,Math.round(b.top)),width:Math.round(b.width),height:Math.min(360,Math.round(b.height))}})()`);
    // Showing the bar from the keyboard puts the hunk back.
    await js(`document.querySelector(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar] [data-noise-show]')}).focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(`![...document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')})].some(e=>e.getAttribute('data-noise-bar')==='Formatting only')`);
    await settle();
    assert.equal(await shownText('src/noise/mixed.ts', "export const base = join('a', 'b');"), true, 'The shown hunk renders its lines');
    await scrollTo(row('src/noise/mixed.ts') + ' .diff-hunk', 60);
    await capture('expanded-bar', box(row('src/noise/mixed.ts') + ' .diff-hunk', 0, 40));

    // ── The summary chip: totals by kind, and the toggles in one click ──
    await js(`document.querySelector('[data-quiet-chip]').click()`);
    await wait(`!!document.querySelector('[data-quiet-summary]')`);
    const chip = await js<{ count: string; kinds: string[]; summary: string }>(`({count:document.querySelector('[data-quiet-chip] .quiet-chip-count').textContent,kinds:[...document.querySelectorAll('[data-quiet-kind]')].map(e=>e.dataset.quietKind),summary:document.querySelector('[data-quiet-summary]').textContent})`);
    console.log('Quiet chip:', JSON.stringify(chip));
    assert.match(chip.count, /^\d+ lines?$/, 'The chip counts the hidden lines');
    assert.ok(chip.kinds.includes('whitespace') && chip.kinds.includes('formatting'), 'The breakdown names whitespace and formatting');
    await capture('quiet-summary', box('.quiet-popover', 6));
    // Comments, from the chip.
    await js(`document.querySelector('.quiet-popover [data-noise-toggle=hideComments]').click()`);
    await wait(`window.electronAPI.loadPreferences().then(p=>p.diffAppearance?.hideComments===true)`);
    await js(`document.querySelector('.quiet-popover')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(`[...document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')})].some(e=>e.getAttribute('data-noise-bar')==='Comments only')`);
    // The hunk the reader opened stays open.
    assert.equal(await shownText('src/noise/mixed.ts', "export const base = join('a', 'b');"), true, 'A shown hunk stays shown');
    await scrollTo(row('src/noise/mixed.ts') + ' [data-noise-bar="Comments only"]', 120);
    await capture('comments-bar', box(row('src/noise/mixed.ts') + ' .diff-hunk:has([data-noise-bar="Comments only"])', 0, 40));
    await openFile('src/noise/comments.ts');
    await wait(`document.querySelector(${JSON.stringify(row('src/noise/comments.ts') + ' [data-noise-file]')})?.getAttribute('data-noise-file')==='Comments only'`, 500);
    assert.equal(await headerStat('src/noise/comments.ts'), 'Comments only', 'A file of comments only says so');
    await wait(`window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='comments.ts')?.textContent.includes('Comments')`);

    // ── Python and YAML: indentation that changes structure is code ──
    await openFile('src/noise/indent.py');
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/indent.py') + ' [data-noise-bar]')})`, 500);
    const python = await hunks('src/noise/indent.py');
    console.log('Python hunks:', JSON.stringify(python));
    assert.equal(python[0].bar, undefined, 'The line that moves into the loop shows');
    assert.equal(await shownText('src/noise/indent.py', '        log(total)'), true, 'with its new indentation');
    assert.equal(python[1].bar, 'Whitespace only', 'The respaced signature is a bar');
    assert.equal(await fileBar('src/noise/indent.py'), null, 'The file is not quiet');
    await openFile('config/noise.yaml');
    await wait(`!!document.querySelector(${JSON.stringify(row('config/noise.yaml') + ' [data-noise-bar]')})`, 500);
    const yaml = await hunks('config/noise.yaml');
    console.log('YAML hunks:', JSON.stringify(yaml));
    assert.equal(yaml[0].bar, undefined, 'The key that leaves its mapping shows');
    assert.equal(await shownText('config/noise.yaml', 'host: example'), true, 'with its line');
    assert.equal(yaml[1].bar, 'Whitespace only', 'The respaced value is a bar');

    // ── Formatting off: formatting shows, whitespace stays hidden; then whitespace off too ──
    await openFile('src/noise/prettier.ts');
    await setToggle('hideFormatting', false);
    await closeMenu();
    await wait(`!document.querySelector(${JSON.stringify(row('src/noise/prettier.ts') + ' [data-noise-bar]')})`);
    assert.equal(await shownText('src/noise/prettier.ts', 'export const sum = a => a + 1;'), true, 'Formatting changes show');
    await openFile('config/noise.yaml');
    assert.equal((await hunks('config/noise.yaml'))[1].bar, 'Whitespace only', 'Whitespace stays hidden');
    await setToggle('hideWhitespace', false);
    await closeMenu();
    await wait(`![...document.querySelectorAll(${JSON.stringify(row('config/noise.yaml') + ' [data-noise-bar]')})].length`);
    assert.equal(await shownText('config/noise.yaml', 'retries: 3'), true, 'The respaced value shows');

    // ── `w` shows or hides every quiet change, and brings back the reader's own choice ──
    await setToggle('hideWhitespace', true);
    await setToggle('hideFormatting', true);
    await closeMenu();
    await openFile('src/noise/indent.py');
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/indent.py') + ' [data-noise-bar]')})`);
    // The stream may still be settling on the file it opened: place the line, then measure.
    for (let i = 0; i < 3; i++) {
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row('src/noise/indent.py'))})).find(e=>e.textContent.includes('return total'));s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-240})()`);
      await settle();
    }
    const top = await js<number>(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row('src/noise/indent.py'))})).find(e=>e.textContent.includes('return total'));return Math.round(l.getBoundingClientRect().top-s.getBoundingClientRect().top)})()`);
    await js('document.activeElement?.blur()');
    const press = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: 'w' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      await sleep(100);
    };
    await press();
    await wait(`window.electronAPI.loadPreferences().then(p=>!p.diffAppearance?.hideWhitespace&&!p.diffAppearance?.hideFormatting&&!p.diffAppearance?.hideComments)`);
    await wait(`!document.querySelector(${JSON.stringify(row('src/noise/indent.py') + ' [data-noise-bar]')})`);
    await press();
    await wait(`window.electronAPI.loadPreferences().then(p=>p.diffAppearance?.hideWhitespace&&p.diffAppearance?.hideFormatting&&p.diffAppearance?.hideComments)`);
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/indent.py') + ' [data-noise-bar]')})`);
    await settle();
    const after = await js<number>(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row('src/noise/indent.py'))})).find(e=>e.textContent.includes('return total'));return Math.round(l.getBoundingClientRect().top-s.getBoundingClientRect().top)})()`);
    console.log('Anchored line:', top, after);
    assert.ok(Math.abs(after - top) <= 40, `The reader's line stays put across the toggle: ${top} → ${after}`);

    // ── Split layout: the same bars ──
    await openFile('src/noise/mixed.ts');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 's' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S' });
    await wait(`window.deepAll('[data-deletions]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).length>0`);
    const split = await hunks('src/noise/mixed.ts');
    assert.deepEqual(split.map((h) => h.bar), (await hunks('src/noise/mixed.ts')).map((h) => h.bar));
    assert.equal(split.filter((h) => h.bar).length, 2, 'Split: the comment-only and whitespace hunks are bars; the opened one stays open');
    assert.ok((await js<number>(`window.deepAll('[data-noise-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).length`)) >= 2, 'Split: the quiet line is dimmed on both sides');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'U' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'u' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'U' });
    await sleep(200);

    // ── The setting is saved and survives a reload ──
    assert.deepEqual(
      await js(`window.electronAPI.loadPreferences().then(p=>({w:p.diffAppearance?.hideWhitespace,f:p.diffAppearance?.hideFormatting,c:p.diffAppearance?.hideComments}))`),
      { w: true, f: true, c: true },
      'The toggles are saved with Diff appearance'
    );
    await openChanges('noise-filter');
    await openMenu();
    assert.deepEqual(await toggles(), { hideWhitespace: true, hideFormatting: true, hideComments: true }, 'The toggles are as the reader left them');
    await closeMenu();
    await openFile('src/noise/comments.ts');
    await wait(`document.querySelector(${JSON.stringify(row('src/noise/comments.ts') + ' [data-noise-file]')})?.getAttribute('data-noise-file')==='Comments only'`, 500);
    // ── A pinned crumb's jump into a quiet hunk opens it and lands on the line ──
    await openFile('src/noise/mixed.ts');
    await wait(`document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')}).length===3`, 500);
    const pin = async () => {
      await js(`(()=>{const s=document.querySelector('.commit-diff-stream');const l=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).find(e=>e.textContent.includes('return a - b;')&&e.dataset.lineType!=='change-deletion');s.scrollTop+=l.getBoundingClientRect().top-s.getBoundingClientRect().top-100})()`);
      await settle();
    };
    // The stream may still settle on the file it just opened: aim again until the header pins.
    for (let i = 0; i < 8; i++) {
      await pin();
      if (await js<boolean>(`!!document.querySelector(${JSON.stringify(row('src/noise/mixed.ts') + ' .diff-gap[data-hunk-header][data-stuck][data-live=scope]')})`)) break;
      await sleep(300);
    }
    await wait(`!!document.querySelector(${JSON.stringify(row('src/noise/mixed.ts') + ' .diff-gap[data-hunk-header][data-stuck][data-live=scope]')})`, 300).catch(async (error: unknown) => {
      console.log('PIN DEBUG', JSON.stringify(await js(`(()=>{const r=document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))});const s=document.querySelector('.commit-diff-stream');
        const l=window.deepAll('[data-line]',r).find(e=>e.textContent.includes('return a - b;'));
        return {stream:Math.round(s.getBoundingClientRect().top),file:Math.round(r.querySelector('.changes-file-header').getBoundingClientRect().bottom),line:l?Math.round(l.getBoundingClientRect().top):null,
          headers:[...r.querySelectorAll('.diff-gap[data-hunk-header]')].map(h=>[Math.round(h.getBoundingClientRect().top),h.hasAttribute('data-stuck'),h.getAttribute('data-live'),h.textContent.slice(0,40)])}})()`)));
      throw error;
    });
    const crumb = await js<{ x: number; y: number }>(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-stuck] .diff-gap-live button[data-jump]')})].find(b=>/compute/.test(b.getAttribute('aria-label')));const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: crumb.x, y: crumb.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: crumb.x, y: crumb.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: crumb.x, y: crumb.y, button: 'left', clickCount: 1 });
    await wait(`![...document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')})].some(e=>e.getAttribute('data-noise-bar')==='Whitespace only')`, 200);
    await wait(`window.deepAll('[data-here]',document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))})).length>0`, 200);
    const landed = await js<{ line: number; header: number }>(`(()=>{const g=document.querySelector(${JSON.stringify(row('src/noise/mixed.ts'))});const l=window.deepAll('[data-line]',g).filter(e=>e.textContent.includes('export function compute(')&&e.getBoundingClientRect().height>0).sort((x,y)=>x.getBoundingClientRect().top-y.getBoundingClientRect().top)[0];const h=g.querySelector('.diff-gap[data-hunk-header][data-stuck]');return {line:Math.round(l.getBoundingClientRect().top),header:h?Math.round(h.getBoundingClientRect().bottom):-1}})()`);
    console.log('Jump into a quiet hunk:', JSON.stringify(landed));
    assert.ok(landed.header < 0 || Math.abs(landed.line - landed.header) <= 4, `The jump lands on the signature's first row (its old line, then its new one), under the pinned header: ${JSON.stringify(landed)}`);

    // ── Parity: an Explanation topic of src/noise/mixed.ts shows the same bars ──
    // The jump opened the signature's hunk in Changes; the topic keeps its own openings, so reload for a fair compare.
    await openChanges('noise-filter');
    await openFile('src/noise/mixed.ts');
    await wait(`document.querySelectorAll(${JSON.stringify(row('src/noise/mixed.ts') + ' [data-noise-bar]')}).length===3`, 500);
    const changesBars = await hunks('src/noise/mixed.ts');
    await click('Review queue');
    await wait("!!document.querySelector('.queue-row-main')");
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()");
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.explanation-reader')");
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
    const topic = '[data-explanation-section="1"] .review-file-group';
    await wait(`document.querySelectorAll(${JSON.stringify(topic + ' [data-noise-bar]')}).length===3`, 500);
    const topicBars = await js<{ counts?: string; bar?: string }[]>(`[...document.querySelectorAll(${JSON.stringify(topic + ' .changes-diff > .diff-hunk')})].map(h=>({counts:h.querySelector('.diff-gap-counts > [aria-hidden]')?.textContent,bar:h.querySelector('[data-noise-bar]')?.getAttribute('data-noise-bar')??undefined}))`);
    console.log('Topic hunks:', JSON.stringify(topicBars));
    assert.deepEqual(
      topicBars.map((h) => [h.counts, h.bar]),
      changesBars.map((h) => [h.counts, h.bar]),
      'The topic shows the same hunks, counts and bars as Changes'
    );
    await js(`(()=>{const s=document.querySelector('.explanation-document');const h=document.querySelector(${JSON.stringify(topic + ' [data-noise-bar]')});s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-120})()`);
    await settle();
    await capture('explanation-bar', `(()=>{const b=document.querySelector(${JSON.stringify(topic)}).getBoundingClientRect();const s=document.querySelector('.explanation-document').getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(s.top),width:Math.round(b.width),height:Math.round(Math.min(420,s.height))}})()`);

    // ── Performance on the large PR: comparisons wait below breadcrumbs ──
    await js(`sessionStorage.setItem('fixture-diff-appearance', JSON.stringify({contextLines:3,indicators:'classic',inline:'word-alt',backgrounds:true,wrap:false,lineNumbers:true,hideWhitespace:true,hideFormatting:true,hideComments:true}))`);
    await openChanges('syntax-large');
    await js(`window.longTasks=[];new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(e=>Math.round(e.duration)))).observe({type:'longtask'});void 0`);
    await wait(`window.deepAll('.diff-gap-scope:not([data-provisional])').length>0`, 750);
    // Let prefetch and comparisons run for a while, then read the numbers.
    for (let i = 0; i < 60; i++) {
      const done = await js<boolean>(`import('/lib/syntax-scope-client.ts').then(m=>m.noiseClassifyTimings.length>=40)`);
      if (done) break;
      await sleep(500);
    }
    const perf = await js<{
      noise: { classify: number; wait?: number; characters: number; priority?: string }[];
      parses: { parse: number; wait?: number; priority?: string }[];
      longTasks: number[];
    }>(`import('/lib/syntax-scope-client.ts').then(m=>({noise:m.noiseClassifyTimings.filter(t=>!t.cached).map(t=>({classify:Math.round(t.classify),wait:t.wait&&Math.round(t.wait),characters:t.characters,priority:t.priority})),
      parses:m.syntaxTimings.filter(t=>!t.cached).map(t=>({parse:Math.round(t.parse),wait:t.wait&&Math.round(t.wait),priority:t.priority})),longTasks:window.longTasks}))`);
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const pct = (values: number[], p: number) => sorted(values)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] ?? 0;
    const classify = perf.noise.map((t) => t.classify);
    console.log(
      'NOISE PERF',
      JSON.stringify({
        compared: perf.noise.length,
        classifyMs: { p50: pct(classify, 0.5), p90: pct(classify, 0.9), max: Math.max(0, ...classify) },
        largestFile: Math.max(0, ...perf.noise.map((t) => t.characters)),
        parseMs: { p50: pct(perf.parses.map((t) => t.parse), 0.5), max: Math.max(0, ...perf.parses.map((t) => t.parse)) },
        longTasks: perf.longTasks,
      })
    );
    assert.ok(perf.noise.length > 0, 'The large PR’s files were compared');
    assert.equal(errors.filter((e) => !/favicon/.test(e)).length, 0, errors.join('\n'));
    console.log('Noise filter checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
