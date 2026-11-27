import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import { TREE_SYMBOLS_FILE, TREE_SYMBOLS_LONG_FILE, TREE_SYMBOLS_MOVE_SOURCE, TREE_SYMBOLS_MOVE_TARGET, TREE_SYMBOLS_NEXT_FILE } from './fixtures/tree-symbols';

/**
 * The Changes tree's changed symbols (Settings › Review, Beta; components/ChangesSymbolTree.tsx). `?tree-symbols`
 * (tests/fixtures/tree-symbols.ts) turns the setting on and adds `src/symbols/store.ts`: a new import, `flush` changed
 * inside an unchanged class `Store`, `gone` removed and `added` added.
 *
 * - The file expands to its symbols, nested: Imports first, then Store › flush, gone, added.
 * - Clicking the file's name opens it; only its chevron expands and collapses it.
 * - Clicking a symbol scrolls the diff to it and lights its row.
 * - V marks the symbol Viewed, and goes on to the next one: the file's outline ticks it, and the file itself stays
 *   unviewed.
 * - The file row then shows its progress, 1/4 (Imports counts as one), as the outline does, and its folder the sum of
 *   what is known; V on Imports ticks it in the tree and the outline.
 * - The last tick marks the file Viewed (lib/symbol-file-sync.ts): its row reads Viewed and its header's checkbox is
 *   ticked, but it stays open while the reader is on it, and collapses once n takes them on to the next file.
 * - n and Shift+N go to the next and previous unviewed symbol, on into `src/symbols/tasks.ts`, lighting each row; at
 *   the end a notice says there are none after it.
 * - A function moved across files is one item, its new copy: the old copy reads "Moved", goes to the new copy, and
 *   reads "✓ moved" once V ticks the new one.
 * - V on a file without symbols (an SVG) marks it Viewed, and again unviewed.
 * - Reset viewed clears every file and tick of these changes, and its toast's Undo puts them back.
 * - Enter on the item under review opens the comment composer on its lines; ⌘↩ adds the draft and puts the keyboard back
 *   on its row; ⌘⇧↩ adds it and goes on as V does.
 * - Space peeks at a symbol: its own diff and the changed symbols calling it (start calls flush); Enter on a caller
 *   peeks at it, Backspace goes back, Esc closes with the keyboard back on the row, V marks it without moving on.
 * - With Symbols on, a second row shows Auto-mark and Peek on hover; with Peek on hover off the setting is saved, the
 *   tree reads it as off, and Space still peeks.
 * - Review with V: with Unviewed only, V from a file's top goes to its first item, then ticks each item and goes on,
 *   lighting and focusing the next row, out of store.ts and through every file, files without symbols one stop each,
 *   to "Everything viewed" with its Review PR action; Shift+V takes the last one back.
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
        `window.treeRow=n=>window.deepAll('[role=treeitem]').find(e=>window.treeName(e)===n);` +
        // The tree row with the keyboard, by activeElement through shadow roots: :focus matches only while the window
        // itself has the system focus, which a CI window under a virtual display often does not.
        `window.focusedTreeRow=()=>{let e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;const r=e&&e.closest&&e.closest('[role=treeitem]');return r?window.treeName(r):''};void 0`
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

    // ── The one-time tip names V, until the first V ──
    const hint = "!!document.querySelector('.changes-tree-hint')";
    await wait(hint);
    assert.match(await js<string>("document.querySelector('.changes-tree-hint').textContent"), /Press V to mark what you’re reading/);
    // ── V marks the symbol Viewed, shared with the outline, and goes on; the file stays unviewed ──
    // The reader picks the row, as a click does: it becomes the item under review, which V acts on.
    await js("(()=>{const r=window.treeRow('flush');r.querySelector('[data-item-section=content]').click();r.focus()})()");
    await js("window.treeRow('flush').dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))");
    await wait("window.treeRows().find(r=>r.name==='flush')?.decoration==='✓'");
    await wait(`!${hint}`);
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
    // A record of what happens between presses, for a timeout's report: every notice shown (they leave after a few
    // seconds), the events that count as the reader moving, and each change of focus.
    await js(`(()=>{window.__log=[];const t0=performance.now();const log=(m)=>window.__log.push(Math.round(performance.now()-t0)+' '+m);
      new MutationObserver(()=>{for(const t of document.querySelectorAll('.app-toast'))if(!t.dataset.logged){t.dataset.logged='1';log('toast '+t.textContent)}}).observe(document.body,{childList:true,subtree:true});
      for(const type of ['wheel','pointerdown','touchstart'])document.addEventListener(type,(e)=>log(type+' '+(e.target&&e.target.className||e.target&&e.target.tagName)),true);
      document.addEventListener('keydown',(e)=>log('key '+e.key),true);
      document.addEventListener('focusin',(e)=>{let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;log('focus '+(a&&(a.getAttribute('aria-label')||a.className||a.tagName)||'').toString().replace(/[\u2061-\u2064\u200b\u200c]/g,'').slice(0,40))},true);
      return true})()`);
    // On a timeout, say where things stood: what is lit, any notice, the active file and the rows, so a CI failure
    // names the cause.
    const lit = (symbol: string) =>
      wait(`window.treeRows().find(r=>r.name===${JSON.stringify(symbol)})?.lit===true`).catch(async (error: unknown) => {
        const state = await js(
          `({log:(window.__log||[]).slice(-40),lit:window.treeRows().filter(r=>r.lit).map(r=>r.name),toasts:[...document.querySelectorAll('.app-toast')].map(t=>t.textContent),active:document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file,rows:window.treeRows().map(r=>r.name+' '+r.decoration)})`
        ).catch(() => 'unreadable');
        throw new Error(`${(error as Error).message}\nState: ${JSON.stringify(state)}`);
      });
    /**
     * Waits for the keyboard to stay in the tree, with the same report as `lit` on a timeout. Which row holds it can trail
     * the light by a frame, or sit on a folder once Unviewed only drops a finished file's rows; V acts on the item under
     * review either way (ChangesSymbolTree), so the check is that the keyboard is still in the tree, ready for the next V.
     */
    const inTreeFocus = () =>
      wait(`window.focusedTreeRow()!==''`).catch(async (error: unknown) => {
        const state = await js(
          `({log:(window.__log||[]).slice(-40),focused:window.focusedTreeRow(),active:document.activeElement&&(document.activeElement.className||document.activeElement.tagName),lit:window.treeRows().filter(r=>r.lit).map(r=>r.name),rows:window.treeRows().map(r=>r.name+' '+r.decoration)})`
        ).catch(() => 'unreadable');
        throw new Error(`${(error as Error).message}\nState: ${JSON.stringify(state)}`);
      });
    const nextRow = `.commit-stream-row[data-file=${JSON.stringify(TREE_SYMBOLS_NEXT_FILE)}]`;
    const inView = (row: string, text: string) =>
      wait(
        `(()=>{const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const line=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row)})).find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!line)return false;const b=line.getBoundingClientRect();return b.top>=s.top&&b.bottom<=s.top+s.height/2})()`
      );
    // V on flush went on to the next unviewed item, gone, as V does (it stays the target, so n starts there); n then
    // goes to added.
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
    // On through the rest, until a notice says nothing is left. Which items new.ts, old.ts and worker.ts have depends on their parse, so the walk
    // is followed rather than listed. Each press must move the light, or end in the notice.
    const atEnd = "[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('No unviewed items after this'))";
    const litName = () => js<string | undefined>(`window.treeRows().find(r=>r.lit)?.name`);
    const walked: string[] = [];
    for (let step = 0; step < 40 && !(await js<boolean>(atEnd)); step++) {
      const before = await litName();
      await press('n');
      await wait(`${atEnd}||window.treeRows().find(r=>r.lit)?.name!==${JSON.stringify(before ?? '')}`);
      const now = await litName();
      if (now && now !== before) walked.push(now);
    }
    await wait(atEnd);
    console.log(`n walked after stop: ${walked.join(', ') || '(nothing)'}`);
    // Files without symbols are stops of their own, lit like any item.
    assert.ok(walked.includes('pnpm-lock.yaml'), `A file without symbols is a lit stop: ${walked.join(', ')}`);
    // Past the last one the reader stays where they are: nothing wraps around to the first file.
    const last = walked.at(-1) ?? 'stop';
    assert.equal((await rows()).find((r) => r.name === last)?.lit, true, 'Nothing wraps around');

    // ── Every symbol viewed, Imports too: the file is Viewed, and stays open while the reader is on it ──
    // Back in store.ts first, so its diff is on screen.
    await js("window.treeRow('added').querySelector('[data-item-section=content]').click()");
    await lit('added');
    await inView(fileRow, 'function added()');
    // V ticks and goes on to the next item, which stays in store.ts until its last one.
    // As a reader does: choose the row, see its lines, then V. V never marks lines that have not been on screen (a long
    // item pages first), and the click's jump is still on its way the moment after the click.
    const lineOf: Record<string, string> = { Imports: "import { b } from 'b';", gone: 'export function gone()' };
    for (const symbol of ['Imports', 'gone']) {
      await js(`(()=>{const r=window.treeRow(${JSON.stringify(symbol)});r.querySelector('[data-item-section=content]').click();r.focus()})()`);
      await inView(fileRow, lineOf[symbol]);
      const pressRowV = () =>
        js(`window.treeRow(${JSON.stringify(symbol)}).dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))`);
      await pressRowV();
      // V marks only lines that have been on screen: if the jump had not brought them there yet, this V showed them
      // ("Read"), and the next one marks the item.
      await wait(`['✓','Read'].includes(window.treeRows().find(r=>r.name===${JSON.stringify(symbol)})?.decoration)`);
      if ((await rows()).find((r) => r.name === symbol)?.decoration === 'Read') await pressRowV();
      await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(symbol)})?.decoration==='✓'`);
    }
    await lit('added');
    // The last one ticked in the outline, which (unlike V) does not move the reader on.
    await js(`(()=>{const o=document.querySelector(${JSON.stringify(fileRow + ' .diff-outline')});if(!o.hasAttribute('data-expanded'))o.querySelector('.diff-outline-toggle').click()})()`);
    await wait(`!!document.querySelector(${JSON.stringify(fileRow + ' input.diff-outline-tick[aria-label="Viewed function added"]')})`);
    await js(`document.querySelector(${JSON.stringify(fileRow + ' input.diff-outline-tick[aria-label="Viewed function added"]')}).click()`);
    await wait("window.treeRows().find(r=>r.name==='added')?.decoration==='✓'");
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

    // ── A moved function is one item, its new copy; the old copy reads Moved, goes there, and is viewed with it ──
    const sourceName = TREE_SYMBOLS_MOVE_SOURCE.slice(TREE_SYMBOLS_MOVE_SOURCE.lastIndexOf('/') + 1);
    const moveRows = () => js<{ decoration: string; level: number }[]>("window.treeRows().filter(r=>r.name==='parseHeader')");
    await js(`window.treeRow(${JSON.stringify(sourceName)}).querySelector('[data-item-section=content]').click()`);
    await wait(`window.treeRow(${JSON.stringify(sourceName)})?.getAttribute('aria-expanded')==='true'`);
    // The match lands once both files are read and fingerprinted.
    await wait("window.treeRows().some(r=>r.name==='parseHeader'&&r.decoration==='Moved')");
    console.log('Moved rows:', JSON.stringify(await moveRows()));
    // Choosing the old copy goes to the new copy.
    await js("window.deepAll('[role=treeitem]').find(e=>window.treeName(e)==='parseHeader'&&e.querySelector('[data-item-section=decoration]')?.textContent.trim()==='Moved').querySelector('[data-item-section=content]').click()");
    await wait(`document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file===${JSON.stringify(TREE_SYMBOLS_MOVE_TARGET)}`);
    // V on the new copy ticks it, and the old copy with it. Found and pressed in one step: a rebuild can redraw the row
    // between a check and a later press.
    const pressNewCopy =
      "(()=>{const e=window.deepAll('[role=treeitem]').find(e=>window.treeName(e)==='parseHeader'&&!/[Mm]oved/.test(e.querySelector('[data-item-section=decoration]')?.textContent??''));if(!e)return false;e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}));return true})()";
    await wait(pressNewCopy);
    if ((await js<string | null>(`window.treeRow(${JSON.stringify(sourceName)})?.getAttribute('aria-expanded')??null`)) === 'false')
      await js(`window.treeRow(${JSON.stringify(sourceName)}).querySelector('[data-item-section=icon]').click()`);
    // V marks only lines that have been on screen: if the jump had not shown the new copy yet, that V showed it ("Read",
    // and the reader stays on it), and the next one marks it. Pressed once more at most: V on a marked row takes it back.
    const oldViewed = "window.treeRows().some(r=>r.name==='parseHeader'&&r.decoration==='✓ moved')";
    const newRead = "window.treeRows().some(r=>r.name==='parseHeader'&&r.decoration==='Read')";
    await wait(`${oldViewed}||${newRead}`);
    if (await js<boolean>(newRead)) await wait(pressNewCopy);
    await wait(oldViewed);

    // ── V on a file without symbols marks the file, as its header's checkbox does ──
    const pressV = (row: string) =>
      js(`(()=>{const r=window.treeRow(${JSON.stringify(row)});r.querySelector('[data-item-section=content]').click();r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,composed:true,cancelable:true}))})()`);
    await pressV('flow.svg');
    await wait("window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");
    await pressV('flow.svg');
    await wait("!window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");

    // ── Reset viewed clears every file and tick of these changes; Undo puts them back ──
    await pressV('flow.svg');
    await wait("window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");
    await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(name)})?.decoration.startsWith('Viewed')`);
    await clickButton('Reset viewed');
    await wait("!window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");
    await wait(`!window.treeRows().find(r=>r.name===${JSON.stringify(name)})?.decoration.startsWith('Viewed')`);
    // store.ts expands again, its ticks gone: flush shows its counts.
    await wait("window.treeRows().find(r=>r.name==='flush')?.decoration==='+1−1'");
    await wait(`document.querySelector(${JSON.stringify(fileRow + ' .changes-file-actions input[type=checkbox]')})?.checked===false`);
    assert.equal(await js(`document.querySelector('button[aria-label="Reset viewed"]')?.disabled`), true, 'Nothing left to reset');
    await clickButton('Undo');
    await wait("window.treeRows().find(r=>r.name==='flow.svg')?.decoration.startsWith('Viewed')");
    await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(name)})?.decoration.startsWith('Viewed')`);
    await wait("window.treeRows().find(r=>r.name==='flush')?.decoration==='✓'");

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

    // ── Review with V: Unviewed only and Symbols on, V ticks each item and goes on, to the end ──
    await js(`document.querySelector('button[aria-label="Reset viewed"]:not(:disabled)')?.click()`);
    await wait(`document.querySelector('button[aria-label="Reset viewed"]')?.disabled===true`);

    // ── Space peeks at a symbol: its own diff and its changed callers, without moving the review ──
    if (!(await js<boolean>("!!window.treeRow('flush')"))) await js(`window.treeRow(${JSON.stringify(name)}).querySelector('[data-item-section=icon]').click()`);
    await wait("!!window.treeRow('flush')");
    const keyIn = (key: string, extra = '') =>
      js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,composed:true,cancelable:true${extra}}))`);
    const peekOf = (symbol: string) => `!!document.querySelector('[role=dialog][aria-label="Peek: ${symbol}"]')`;
    const spaceOn = (row: string) =>
      js(`(()=>{const r=window.treeRow(${JSON.stringify(row)});r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,composed:true,cancelable:true}))})()`);
    const activeBefore = await js<string>(`document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file??''`);
    await spaceOn('flush');
    await wait(peekOf('flush'));
    // Its own hunk, drawn as Changes draws it, and start, which calls it from tasks.ts.
    await wait("window.deepAll('[data-line]',document.querySelector('.symbol-peek')).some(e=>e.textContent.includes('return 2;'))");
    await wait("[...document.querySelectorAll('.symbol-peek [role=option]')].some(o=>o.textContent.includes('start'))");
    assert.equal(await js<string>(`document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file??''`), activeBefore, 'A peek moves nothing');
    // Down and Enter peek at the caller; Backspace goes back.
    await wait("!!document.activeElement?.closest('.symbol-peek')");
    await keyIn('ArrowDown');
    await keyIn('Enter');
    await wait(peekOf('start'));
    await keyIn('Backspace');
    await wait(peekOf('flush'));
    // Esc closes, and the keyboard is back on the row.
    await keyIn('Escape');
    await wait("!document.querySelector('.symbol-peek')");
    await wait("window.focusedTreeRow()==='flush'");
    // V in a peek marks it, and the review does not move on.
    await spaceOn('flush');
    await wait(peekOf('flush'));
    await wait("!!document.activeElement?.closest('.symbol-peek')");
    await keyIn('v');
    await wait("!document.querySelector('.symbol-peek')");
    await wait("window.treeRows().find(r=>r.name==='flush')?.decoration==='✓'");
    assert.equal(await js<string>(`document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file??''`), activeBefore, 'and moves nothing');
    // With Symbols on, a second row holds Auto-mark and Peek on hover. Off, a resting pointer opens no peek, and Space
    // still does. The hover peek opens on a 400 ms timer, so "no peek opened" alone would need a fixed sleep; the
    // step checks instead that the setting is saved and that the tree's hover handler reads it as off.
    const subOption = (label: string) =>
      `[...document.querySelectorAll('.changes-tree-suboptions label')].find(l=>l.textContent.trim()===${JSON.stringify(label)})?.querySelector('input')`;
    await wait(`!!${subOption('Auto-mark')}&&${subOption('Peek on hover')}?.checked===true`);
    await js(`${subOption('Peek on hover')}.click()`);
    await wait('window.electronAPI.loadPreferences().then(p=>p.peekOnHover===false)');
    await wait(`${subOption('Peek on hover')}?.checked===false&&document.querySelector('.changes-file-tree')?.dataset.peekOnHover==='false'`);
    await spaceOn('flush');
    await wait(peekOf('flush'));
    await wait("!!document.activeElement?.closest('.symbol-peek')");
    await keyIn('Escape');
    await wait("!document.querySelector('.symbol-peek')");
    await js(`${subOption('Peek on hover')}.click()`);
    await wait('window.electronAPI.loadPreferences().then(p=>p.peekOnHover!==false)');
    await wait(`document.querySelector('.changes-file-tree')?.dataset.peekOnHover==='true'`);
    // Back to nothing viewed for the walk below.
    await js(`document.querySelector('button[aria-label="Reset viewed"]:not(:disabled)')?.click()`);
    await wait(`document.querySelector('button[aria-label="Reset viewed"]')?.disabled===true`);
    await js("[...document.querySelectorAll('.changes-tree-controls label')].find(l=>l.textContent.includes('Unviewed only')).querySelector('input').click()");
    const leftNow = () => js<number>(`(()=>{const e=document.querySelector('.changes-progress-left');return e?Number(e.textContent.replace(/\\D/g,'')):0})()`);
    const activeFile = () => js<string>(`document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file??''`);
    const focusedRow = () => js<string>(`window.focusedTreeRow()`);
    const toastWith = (text: string) => `[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes(${JSON.stringify(text)}))`;
    // From store.ts's first item, chosen in the tree.
    await wait("!!window.treeRow('Imports')");
    await js("window.treeRow('Imports').querySelector('[data-item-section=content]').click()");
    await lit('Imports');
    // Its line on screen, as a reader sees it before pressing V (V never marks lines that have not been on screen).
    await inView(fileRow, "import { b } from 'b';");
    // A reader's click also puts the keyboard on the row. A script's click() does not, and the search above left the
    // find field focused: the tree rightly leaves a text field alone, so focus the row as the click would.
    await js("window.treeRow('Imports').focus()");
    // ── Enter on the item under review comments on it; ⌘↩ adds the draft and hands the keyboard back ──
    const composer = `${fileRow} .changes-comment-composer`;
    const enterOn = (row: string) =>
      js(`(()=>{const r=window.treeRow(${JSON.stringify(row)});r.focus();r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,composed:true,cancelable:true}))})()`);
    const typeComment = (text: string) =>
      js(
        `(()=>{const t=document.querySelector(${JSON.stringify(composer + ' textarea')});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`
      );
    const submitComment = (shift: boolean) =>
      js(
        `document.querySelector(${JSON.stringify(composer + ' textarea')}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,metaKey:true,shiftKey:${shift},bubbles:true,cancelable:true}))`
      );
    const drafts = () => js<number>(`document.querySelectorAll(${JSON.stringify(fileRow + ' .changes-pending-comment')}).length`);
    const draftsBefore = await drafts();
    await enterOn('Imports');
    await wait(`!!document.querySelector(${JSON.stringify(composer)})`);
    // On the import the item changed, the new file's line 2, with the keyboard in the composer.
    assert.match(await js<string>(`document.querySelector(${JSON.stringify(composer + ' label')}).textContent`), /new line 2\b/);
    await wait("document.activeElement?.tagName==='TEXTAREA'&&!!document.activeElement.closest('.changes-comment-composer')");
    await typeComment('Is this import needed?');
    await submitComment(false);
    await wait(`!document.querySelector(${JSON.stringify(composer)})`);
    await wait(`document.querySelectorAll(${JSON.stringify(fileRow + ' .changes-pending-comment')}).length===${draftsBefore + 1}`);
    await wait("(()=>{const e=window.deepAll('[role=treeitem]').find(e=>e.matches(':focus'));return !!e&&window.treeName(e)==='Imports'})()");
    assert.notEqual((await rows()).find((r) => r.name === 'Imports')?.decoration, '✓', 'A comment does not tick the item');
    // Esc cancels, and hands the keyboard back to the item's row: the next V ticks that item, not a row focused before.
    await enterOn('Imports');
    await wait(`!!document.querySelector(${JSON.stringify(composer)})`);
    await wait("document.activeElement?.tagName==='TEXTAREA'&&!!document.activeElement.closest('.changes-comment-composer')");
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await wait(`!document.querySelector(${JSON.stringify(composer)})`);
    await wait("(()=>{const e=window.deepAll('[role=treeitem]').find(e=>e.matches(':focus'));return !!e&&window.treeName(e)==='Imports'})()");
    // The reader closes the class and the folder above it: going on must open both again.
    const expandedOf = (row: string) => js<string | null>(`window.treeRow(${JSON.stringify(row)})?.getAttribute('aria-expanded')??null`);
    const symbolRows = ['Imports', 'Store', 'flush', 'gone', 'added'];
    const decorations = () => js<Record<string, string>>(`Object.fromEntries(window.treeRows().filter(r=>${JSON.stringify(symbolRows)}.includes(r.name)).map(r=>[r.name,r.decoration]))`);
    // Before the class and folder close: closed, their rows are not listed, and V opens them again.
    const openBefore = await decorations();
    await js("window.treeRow('Store').querySelector('[data-item-section=icon]').click()");
    await wait("window.treeRow('Store')?.getAttribute('aria-expanded')==='false'");
    await js("window.treeRow('symbols').querySelector('[data-item-section=icon]').click()");
    await wait("window.treeRow('symbols')?.getAttribute('aria-expanded')==='false'");
    // Each V ticks the item it is on, and only that (its class rolls up with it), lights the next, and puts the
    // keyboard focus on its row. Imports is the case that went wrong: landing on a top-level line, the pinned crumb
    // names a neighbour, which must not become what the next V ticks.
    const expectChanged: Record<string, string[]> = { Imports: ['Imports'], flush: ['flush', 'Store'], gone: ['gone'] };
    for (const [ticked, next] of [['Imports', 'flush'], ['flush', 'gone'], ['gone', 'added']] as const) {
      const before = ticked === 'Imports' ? openBefore : await decorations();
      await press('v');
      await lit(next);
      await wait(`window.treeRows().find(r=>r.name===${JSON.stringify(ticked)})?.decoration==='✓'`);
      if (ticked === 'Imports') {
        // flush is under the closed folder and class: both open, and flush is lit and focused.
        await wait("window.treeRow('symbols')?.getAttribute('aria-expanded')==='true'&&window.treeRow('Store')?.getAttribute('aria-expanded')==='true'");
        assert.equal(await expandedOf('Store'), 'true');
        await inTreeFocus();
      }
      const after = await decorations();
      const changed = symbolRows.filter((row) => before[row] !== after[row]).sort();
      assert.deepEqual(changed, [...expectChanged[ticked]].sort(), `V on ${ticked} ticked ${ticked} only: ${JSON.stringify({ before, after })}`);
      await inTreeFocus();
    }
    // The last of store.ts, with a comment: ⌘⇧↩ adds it and goes on as V does, into tasks.ts; store.ts, Viewed, leaves
    // the Unviewed only tree.
    await enterOn('added');
    await wait(`!!document.querySelector(${JSON.stringify(composer)})`);
    assert.match(await js<string>(`document.querySelector(${JSON.stringify(composer + ' label')}).textContent`), /new lines \d+–\d+/, 'Over the function');
    await typeComment('Name this for what it adds.');
    await submitComment(true);
    await lit('start');
    await wait(`!window.treeRow(${JSON.stringify(name)})`);
    assert.notEqual(await focusedRow(), '', 'The keyboard stays in the tree for the next V');
    // On to the end: each V ticks one item. Files without symbols are stops of their own.
    const visited: string[] = [];
    // A function taller than the screen (report.ts's) pages first: V scrolls on, and its row reads "Reading N%", until
    // every line has been on screen; then V ticks it.
    const readingRow = () => js<string>(`window.treeRows().find(r=>r.decoration.startsWith('Read'))?.decoration??''`);
    const readings: string[] = [];
    for (let presses = 0; presses < 80 && !(await js<boolean>(toastWith('Everything viewed'))); presses++) {
      const before = await leftNow();
      const reading = await readingRow();
      await press('v');
      await wait(
        `${toastWith('Everything viewed')}||(()=>{const e=document.querySelector('.changes-progress-left');return (e?Number(e.textContent.replace(/\\D/g,'')):0)<${before}})()||((window.treeRows().find(r=>r.decoration.startsWith('Read'))?.decoration??'')!==${JSON.stringify(reading)}&&!!window.treeRows().find(r=>r.decoration.startsWith('Read')))`
      ).catch(
        async (error: unknown) => {
          const state = await js(
            `({log:(window.__log||[]).slice(-30),left:document.querySelector('.changes-progress-left')?.textContent,lit:window.treeRows().filter(r=>r.lit).map(r=>r.name),focused:window.focusedTreeRow(),active:document.querySelector('.commit-stream-row[data-active="true"]')?.dataset.file,visited:${JSON.stringify(visited)},rows:window.treeRows().map(r=>r.name+' '+r.decoration)})`
          ).catch(() => 'unreadable');
          throw new Error(`${(error as Error).message}\nState: ${JSON.stringify(state)}`);
        }
      );
      const now = await readingRow();
      if (now) readings.push(now);

      visited.push(await activeFile());
    }
    console.log('V paged through:', JSON.stringify(readings));
    assert.ok(readings.length >= 1, 'The long function paged before it ticked');
    assert.ok(visited.some((file) => file === TREE_SYMBOLS_LONG_FILE), 'and V went through its file');
    console.log('V walked through:', JSON.stringify(visited));
    assert.ok(await js<boolean>(toastWith('Everything viewed')), 'V reaches the end');
    assert.ok(visited.some((file) => file.endsWith('flow.svg')), 'An image is a stop of its own');
    assert.ok(await js<boolean>(`[...document.querySelectorAll('.app-toast button')].some(b=>/^Review PR #\\d+$/.test(b.textContent.trim()))`), 'The end offers the review');
    // Shift+V takes the last V back: one item left again, and the reader is back on it.
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'V',shiftKey:true,bubbles:true,cancelable:true}))");
    await wait(`(()=>{const e=document.querySelector('.changes-progress-left');return !!e&&Number(e.textContent.replace(/\\D/g,''))===1})()`);
    await press('v');
    await wait('!document.querySelector(".changes-progress-left")');
    await js("[...document.querySelectorAll('.changes-tree-controls label')].find(l=>l.textContent.includes('Unviewed only')).querySelector('input').click()");

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
