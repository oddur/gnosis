import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw Error(`${code}: ${String(error)}`);
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.checkVisibility()&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  const row = (name: string) =>
    `[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes(${JSON.stringify(name)}))`;
  const select = async (name: string, modifiers = {}) => {
    await js(`${row(name)}.dispatchEvent(new MouseEvent('click',{bubbles:true,...${JSON.stringify(modifiers)}}))`);
  };
  const context = async (expression: string) => {
    await js(
      `(()=>{const b=${expression};b.focus();const r=b.getBoundingClientRect();b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,composed:true,button:2,clientX:r.x+25,clientY:r.y+10}))})()`
    );
    await wait("!!document.querySelector('[role=menu]')");
  };
  const closeMenu = async () => {
    await js(
      "document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('[role=menu]')");
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready.then(() => undefined)');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const dir = path.resolve('.impeccable/review/multi-selection');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const url = `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&unread&file-filters`;
  try {
    await win.loadURL(url);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(()=>{
      window.selectionCalls={stars:[],reads:[],mutes:[],explanations:[],briefings:[],refresh:[]};
      for (const [method,key] of [['workbenchStarPrs','stars'],['workbenchMarkPrRead','reads'],['workbenchMutePrs','mutes']]) {
        const original=window.electronAPI[method]; window.electronAPI[method]=async request=>{
          window.selectionCalls[key].push(request);
          if(key==='stars'&&window.failStar)throw Error('Saved stars unavailable');
          return original(request);
        };
      }
      window.electronAPI.startReview=async request=>{window.selectionCalls.explanations.push(request);return {reviewId:'selection-'+window.selectionCalls.explanations.length}};
      window.electronAPI.workbenchBriefing=async id=>{window.selectionCalls.briefings.push(id);return window.electronAPI.workbenchQueue()};
      const status=window.electronAPI.getPrStatus;window.electronAPI.getPrStatus=(url,force)=>{if(force)window.selectionCalls.refresh.push(url);return status(url,force)};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedSelection=text}}});
    })()`);
    await select('Fix reconnect');
    await select('Introduce a bounded', { shiftKey: true });
    await wait("document.querySelector('.queue-selection-summary')?.textContent.includes('3 selected')");
    assert.equal(await js("document.querySelectorAll('.queue-row-main[aria-pressed=true]').length"), 3);
    await context(row('Reduce allocations'));
    assert.equal(await js("document.querySelector('.entry-menu-selection-title strong').textContent"), '3 entries selected');
    assert.equal(await js("document.querySelector('.entry-menu-selection-title > span').textContent"), '5 PRs');
    await capture('queue-light');
    await click('Copy PR links');
    assert.equal(await js("window.copiedSelection.split('\\n').length"), 5);
    await click('Selected entry actions');
    await click('Mark 1 PR as read');
    await wait('window.selectionCalls.reads.length===1');
    assert.equal(await js('window.selectionCalls.reads[0].receipts.length'), 1);
    await click('Selected entry actions');
    await click('Star 5 PRs');
    await wait('window.selectionCalls.stars.length===1');
    assert.equal(await js('window.selectionCalls.stars[0].members.length'), 5);
    await wait("document.querySelectorAll('.queue-item.is-selected .entry-star-marker').length===3");
    await js('window.failStar=true');
    await click('Selected entry actions');
    await click('Unstar 5 PRs');
    await wait("document.body.textContent.includes('Saved stars unavailable')");
    assert.equal(await js("document.querySelectorAll('.queue-row-main[aria-pressed=true]').length"), 3);
    await js('window.failStar=false');
    await click('Selected entry actions');
    await click('Generate 3 explanations');
    await wait('window.selectionCalls.explanations.length===3');
    assert.equal(await js('new Set(window.selectionCalls.explanations.map(r=>r.subjectId)).size'), 3);
    await wait("document.querySelector('.app-toast-title')?.textContent.includes('3 of 3')");
    await click('Selected entry actions');
    await click('Generate 3 briefings');
    await wait('window.selectionCalls.briefings.length===3');
    await wait("![...document.querySelectorAll('.entry-menu-item')].some(e=>e.textContent==='Generate 3 briefings')");
    await click('Selected entry actions');
    await click('Refresh GitHub status');
    await wait('window.selectionCalls.refresh.length===5');
    // A different row gets its own menu, never the previous group's actions.
    await context(row('Add trace'));
    assert.ok(await js("!document.querySelector('[role=menu]').textContent.includes('entries selected')"));
    await closeMenu();
    await wait("!document.querySelector('.queue-selection-summary')");
    await select('Fix reconnect');
    await select('Reduce allocations', { metaKey: true });
    await wait("document.querySelector('.queue-selection-summary')?.textContent.includes('2 selected')");
    await select('Reduce allocations', { ctrlKey: true });
    await wait("!document.querySelector('.queue-selection-summary')");
    await js(
      `${row('Fix reconnect')}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}))`
    );
    await wait("document.querySelector('.queue-selection-summary')?.textContent.includes('2 selected')");
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'a',metaKey:true,bubbles:true}))");
    await wait("document.querySelector('.queue-selection-summary')?.textContent.includes('7 selected')");
    await js(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))"
    );
    await wait("document.querySelector('[role=menu]')?.textContent.includes('7 entries selected')");
    await js("document.documentElement.classList.add('dark')");
    win.setSize(900, 700);
    await capture('queue-dark-laptop');
    win.webContents.setZoomFactor(1.5);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.ok(await js("(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"));
    await capture('queue-dark-zoom');
    win.webContents.setZoomFactor(1);
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await closeMenu();
    await click('Clear entry selection');
    await select('Fix reconnect');
    await select('Reduce allocations', { metaKey: true });
    await js(
      `(()=>{const e=document.querySelector('[aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'reconnect');e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await wait("!document.querySelector('.queue-selection-summary')");

    await js(
      `(()=>{const e=document.querySelector('[aria-label="Search PRs and stacks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.ok(await js("!document.querySelector('.queue-selection-summary')"));
    await select('Fix reconnect');
    await select('Reduce allocations', { metaKey: true });
    await click('Selected entry actions');
    await click('Mute 2 PRs');
    await wait('window.selectionCalls.mutes.length===1');
    assert.equal(await js('window.selectionCalls.mutes[0].members.length'), 2);

    await js(
      'window.electronAPI.workbenchMutePrs({...window.selectionCalls.mutes[0],muted:false}).then(()=>undefined)'
    );
    // The tree keeps its native selection, while modifier clicks leave the code's position alone.
    await win.loadURL(url);
    win.setSize(1280, 800);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      "void (window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])])"
    );
    await select('Fix reconnect');
    await click('Open PR overview');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    const treeRow = (key: string) =>
      `window.deepAll('[role=treeitem]').find(e=>e.dataset.itemPath===${JSON.stringify(key)})`;
    const treeClick = (key: string, modifiers = {}) =>
      js(
        `${treeRow(key)}.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,...${JSON.stringify(modifiers)}}))`
      );
    await treeClick('src/other.ts');
    await wait("document.querySelector('[data-file][data-active=true]')?.dataset.file==='src/other.ts'");
    await treeClick('src/worker.ts', { shiftKey: true });
    await wait("document.querySelector('.file-tree-selection-status')?.textContent.includes('2 files selected')");
    assert.equal(await js("document.querySelector('[data-file][data-active=true]').dataset.file"), 'src/other.ts');
    await context(treeRow('src/worker.ts'));
    await wait("window.deepAll('[data-line]').length>0");
    await capture('files-light');
    await click('Mark selected files as viewed');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('2 / 5')");
    // A selected directory plus its child never counts or saves the same file twice.
    await treeClick('tests/');
    await treeClick('src/other.ts', { metaKey: true });
    await context(treeRow('tests/'));
    assert.match(await js<string>("document.querySelector('[role=menu]').textContent"), /3 selected files/);
    await click('Mark selected files as viewed');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('4 / 5')");
    // Outside the selection, a file context menu affects just that file.
    await context(treeRow('package-lock.json'));
    assert.ok(await js("document.querySelector('[role=menu]').textContent.includes('Mark file as viewed')"));
    await closeMenu();
    await treeClick('src/other.ts');
    await treeClick('src/worker.ts', { shiftKey: true });
    await js(
      `${treeRow('src/worker.ts')}.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,composed:true}))`
    );
    await wait("document.querySelector('[role=menu]')?.textContent.includes('Mark selected files as unviewed')");
    await js("document.documentElement.classList.add('dark')");
    win.setSize(900, 700);
    await capture('files-dark-laptop');
    await click('Mark selected files as unviewed');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('2 / 5')");
    await js(
      `${treeRow('src/worker.ts')}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true}))`
    );
    await wait('!document.querySelector(\'[aria-label="Clear file selection"]\')');
    await click('Commits');
    await wait("!!document.querySelector('.commit-row') && !!document.querySelector('.changes-file-tree')");
    await wait("document.querySelector('.changes-progress')?.textContent.includes('0 / 5')");
    await treeClick('src/other.ts');
    await treeClick('src/worker.ts', { shiftKey: true });
    await context(treeRow('src/worker.ts'));
    await click('Mark selected files as viewed');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('2 / 5')");
    await click('Changes');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('2 / 5')");
    console.log(
      'Multi-selection passed: queue ranges/toggles/keyboard, scoped menus, stack-preserving batches, failures, filters, file/folder selection, diff position, and commit progress.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      console.log(await js('document.body.innerText'));
    } catch {
      /* Window unavailable. */
    }
    app.exit(1);
  }
});
