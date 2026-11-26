import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import { TREE_SYMBOLS_FILE, TREE_SYMBOLS_NEXT_FILE } from './fixtures/tree-symbols';

/**
 * The Changes tree's changed symbols (Settings › Review, Beta; components/ChangesSymbolTree.tsx). `?tree-symbols`
 * (tests/fixtures/tree-symbols.ts) turns the setting on and adds `src/symbols/store.ts`: a new import, `flush` changed
 * inside an unchanged class `Store`, `gone` removed and `added` added.
 *
 * - The file expands to its symbols, nested: Imports first, then Store › flush, gone, added.
 * - Clicking the file's name opens it; only its chevron expands and collapses it.
 * - Clicking a symbol scrolls the diff to it and lights its row.
 * - V marks the symbol Viewed: the file's outline ticks it, and the file itself stays unviewed.
 * - The file row then shows its progress, 1/4 (Imports counts as one), as the outline does, and its folder the sum of
 *   what is known; V on Imports ticks it in the tree and the outline.
 * - The last tick marks the file Viewed (lib/symbol-file-sync.ts): its row reads Viewed and its header's checkbox is
 *   ticked, but it stays open while the reader is on it, and collapses once n takes them on to the next file.
 * - n and Shift+N go to the next and previous unviewed symbol, on into `src/symbols/tasks.ts`, lighting each row; at
 *   the end a notice says there are none after it.
 * - V on a file without symbols (an SVG) marks it Viewed, and again unviewed.
 * - Search matches a symbol's name.
 * - With the setting off, the tree is the plain file tree again.
 *
 * Every step waits for what the page shows; none sleeps for a fixed time.
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
  const wait = async (expression: string, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  };
  const clickButton = (label: string) =>
    js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width&&(e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e)throw Error('Missing '+${JSON.stringify(label)});e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click()})()`
    );
  const fileRow = `.commit-stream-row[data-file=${JSON.stringify(TREE_SYMBOLS_FILE)}]`;
  // Tree rows live in Pierre's shadow DOM; their names carry invisible marks (lib/tree-symbol-paths.ts).
  const install = () =>
    js(
      `window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];` +
        `window.treeName=e=>(e.getAttribute('aria-label')||'').replace(/[\\u2061-\\u2064\\u200b\\u200c]/g,'');` +
        `window.treeRows=()=>window.deepAll('[role=treeitem]').map(e=>({name:window.treeName(e),level:Number(e.getAttribute('aria-level')),expanded:e.getAttribute('aria-expanded'),lit:e.getAttribute('data-item-git-status')==='untracked',decoration:e.querySelector('[data-item-section=decoration]')?.textContent.trim()??''}));` +
        `window.treeRow=n=>window.deepAll('[role=treeitem]').find(e=>window.treeName(e)===n);void 0`
    );
  const rows = () => js<{ name: string; level: number; expanded: string | null; lit: boolean; decoration: string }[]>('window.treeRows()');
  const openChanges = async () => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?tree-symbols`);
    await waitForWorkbenchQueue(win.webContents);
    await install();
    await js("[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()");
    await wait("[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Open PR overview')");
    await clickButton('Open PR overview');
    await wait("[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Changes')");
    await clickButton('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
  };
  const name = TREE_SYMBOLS_FILE.slice(TREE_SYMBOLS_FILE.lastIndexOf('/') + 1);
  const expandedState = () => js<string | null>(`window.treeRow(${JSON.stringify(name)})?.getAttribute('aria-expanded')??null`);
  const clickChevron = () => js(`window.treeRow(${JSON.stringify(name)}).querySelector('[data-item-section=icon]').click()`);

  try {
    await openChanges();
    await wait(`!!window.treeRow(${JSON.stringify(name)})`);
    // A file with symbol support has a chevron; one without (the SVG) does not.
    assert.notEqual(await expandedState(), null, 'store.ts expands');
    assert.equal(await js("window.treeRow('flow.svg')?.getAttribute('aria-expanded')??null"), null, 'An image has no symbols');

    // ── The name opens the file; the chevron alone expands and collapses it ──
    if ((await expandedState()) === 'true') {
      await clickChevron();
      await wait(`window.treeRow(${JSON.stringify(name)})?.getAttribute('aria-expanded')==='false'`);
    }
    await js(`window.treeRow(${JSON.stringify(name)}).querySelector('[data-item-section=content]').click()`);
    await wait(`document.querySelector(${JSON.stringify(fileRow)})?.dataset.active==='true' && !!document.querySelector(${JSON.stringify(fileRow + ' .changes-diff')})`);
    // Selecting the file opens it in the tree by itself: the current file shows what it touches.
    await wait(`window.treeRow(${JSON.stringify(name)})?.getAttribute('aria-expanded')==='true'`);
    await clickChevron();
    await wait(`window.treeRow(${JSON.stringify(name)})?.getAttribute('aria-expanded')==='false'`);
    assert.equal(await js(`document.querySelector(${JSON.stringify(fileRow)})?.dataset.active`), 'true', 'The chevron leaves the open file as it was');
    await clickChevron();
    await wait(`window.treeRow(${JSON.stringify(name)})?.getAttribute('aria-expanded')==='true'`);

    // ── Nested symbols, top-level changes first ──
    await wait("!!window.treeRow('added')");
    const tree = await rows();
    const at = tree.findIndex((r) => r.name === name);
    const level = tree[at].level;
    const under = tree.slice(at + 1).filter((r, i, all) => all.slice(0, i + 1).every((x) => x.level > level));
    console.log('store.ts rows:', JSON.stringify(under.map((r) => [r.name, r.level - level, r.decoration])));
    assert.deepEqual(
      under.map((r) => [r.name, r.level - level]),
      [
        ['Imports', 1],
        ['Store', 1],
        ['flush', 2],
        ['gone', 1],
        ['added', 1],
      ],
      'The file lists Imports, then the class with its changed method, then the removed and added functions'
    );
    assert.equal(under.find((r) => r.name === 'flush')?.decoration, '+1−1', 'A symbol row counts its changes');

    // ── A symbol jumps the diff to it and lights its row ──
    await js("window.treeRow('flush').querySelector('[data-item-section=content]').click()");
    await wait("window.treeRows().find(r=>r.name==='flush')?.lit===true");
    await wait(
      `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const line=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(fileRow)})).find(e=>e.textContent.includes('flush() {'));if(!line)return false;const b=line.getBoundingClientRect();return b.top>=s.top&&b.bottom<=s.top+s.height/2})()`
    );

    // ── V marks the symbol Viewed: shared with the outline, never the file ──
    await js("window.treeRow('flush').focus()");
    await js("window.treeRow('flush').dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))");
    await wait("window.treeRows().find(r=>r.name==='flush')?.decoration==='✓'");
    await wait(
      `[...document.querySelectorAll(${JSON.stringify(fileRow + ' .diff-outline-go')})].some(b=>b.textContent.includes('flush')&&b.closest('[data-viewed]'))`
    );
    assert.notEqual((await rows()).find((r) => r.name === name)?.decoration, 'Viewed', 'The file stays unviewed');
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(fileRow + ' .changes-diff')})`), true, 'The file stays open');

    // ── The file row shows how many of its symbols are viewed; its folder sums what is known ──
    // The file's top-level changes (Imports) count as one more: flush, gone, added and Imports.
    await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(name)})?.decoration==='1/4'`);
    const outlineProgress = () => js<string>(`document.querySelector(${JSON.stringify(fileRow + ' .diff-outline-end')})?.textContent.trim()??''`);
    await wait(`document.querySelector(${JSON.stringify(fileRow + ' .diff-outline-end')})?.textContent.trim()==='1/4 viewed'`);
    // tasks.ts counts towards the folder once its symbols are known (the prefetch may not have read it yet).
    await wait("/^1\\/(4|6)$/.test(window.treeRows().find(r=>r.name==='symbols')?.decoration??'')");

    // ── n and Shift+N: the next and previous unviewed symbol, across files ──
    const press = (key: string) =>
      js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},shiftKey:${key === 'N'},bubbles:true,cancelable:true}))`);
    const lit = (symbol: string) => wait(`window.treeRows().find(r=>r.name===${JSON.stringify(symbol)})?.lit===true`);
    const nextRow = `.commit-stream-row[data-file=${JSON.stringify(TREE_SYMBOLS_NEXT_FILE)}]`;
    const inView = (row: string, text: string) =>
      wait(
        `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const line=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row)})).find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!line)return false;const b=line.getBoundingClientRect();return b.top>=s.top&&b.bottom<=s.top+s.height/2})()`
      );
    // From flush, the one the reader chose (Viewed now): gone, then added.
    await press('n');
    await lit('gone');
    await inView(fileRow, 'function gone()');
    await press('n');
    await lit('added');
    await inView(fileRow, 'function added()');
    // On into the next file, which opens in the tree.
    await press('n');
    await lit('start');
    await inView(nextRow, 'function start()');
    await wait(`window.treeRow('tasks.ts')?.getAttribute('aria-expanded')==='true'`);
    // Back again.
    await press('N');
    await lit('added');
    await press('n');
    await lit('start');
    await press('n');
    await lit('stop');
    // Past the last one: a notice, and the reader stays where they are.
    await press('n');
    await wait("[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('No unviewed symbols after this'))");
    assert.equal((await rows()).find((r) => r.name === 'stop')?.lit, true, 'Nothing wraps around');

    // ── Every symbol viewed, Imports too: the file is Viewed, and stays open while the reader is on it ──
    // Back in store.ts first, so its diff is on screen.
    await js("window.treeRow('added').querySelector('[data-item-section=content]').click()");
    await lit('added');
    await inView(fileRow, 'function added()');
    for (const symbol of ['Imports', 'gone', 'added']) {
      await js(`window.treeRow(${JSON.stringify(symbol)}).focus()`);
      await js(`window.treeRow(${JSON.stringify(symbol)}).dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))`);
      await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(symbol)})?.decoration==='✓'`);
    }
    await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(name)})?.decoration==='Viewed'`);
    await wait(`document.querySelector(${JSON.stringify(fileRow + ' .changes-file-actions input[type=checkbox]')})?.checked===true`);
    console.log('Outline after every tick:', await outlineProgress());
    const bodyHidden = () => js<boolean>(`!!document.querySelector(${JSON.stringify(fileRow + ' .commit-stream-file-body')})?.hidden`);
    assert.equal(await bodyHidden(), false, 'Marked by its ticks, the file stays open while the reader is on it');
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(fileRow + ' .changes-diff')})`), true, 'Its code is still there');
    // Moving on collapses it.
    await press('n');
    await lit('start');
    // Collapsed, or no longer mounted at all (the stream keeps only rows near the view): either way, not held open.
    await wait(`(()=>{const b=document.querySelector(${JSON.stringify(fileRow + ' .commit-stream-file-body')});return !b||b.hidden})()`);

    // ── V on a file without symbols marks the file, as its header's checkbox does ──
    const pressV = (row: string) =>
      js(`(()=>{const r=window.treeRow(${JSON.stringify(row)});r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))})()`);
    await pressV('flow.svg');
    await wait("window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");
    await pressV('flow.svg');
    await wait("!window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");

    // ── Search matches a symbol's name ──
    const search = (value: string) =>
      js(
        `(()=>{const i=document.querySelector('.changes-tree-controls input[placeholder]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`
      );
    await search('flus');
    await wait("window.treeRows().some(r=>r.name==='flush') && !window.treeRows().some(r=>r.name==='worker.ts')");
    assert.ok((await rows()).some((r) => r.name === name), 'The matching symbol keeps its file');
    await search('');
    await wait("window.treeRows().some(r=>r.name==='worker.ts')");

    // ── The setting off: the plain tree ──
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog]')");
    await js(
      "[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(t=>t.textContent==='Review').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
    );
    await wait("!!document.querySelector('[role=switch][aria-label=\"Show changed symbols in the file tree\"]')");
    assert.equal(
      await js("document.querySelector('[role=switch][aria-label=\"Show changed symbols in the file tree\"]').getAttribute('aria-checked')"),
      'true'
    );
    await js("document.querySelector('[role=switch][aria-label=\"Show changed symbols in the file tree\"]').click()");
    await wait("window.electronAPI.loadPreferences().then(p=>p.treeSymbols===false)");
    await openChanges();
    await wait(`!!window.treeRow(${JSON.stringify(name)})`);
    assert.equal(await expandedState(), null, 'With the setting off, files have no chevron');
    assert.equal(await js("!!window.treeRow('flush')"), false, 'and no symbol rows');

    assert.equal(errors.filter((e) => !/favicon/.test(e)).length, 0, errors.join('\n'));
    console.log('Tree symbols checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
