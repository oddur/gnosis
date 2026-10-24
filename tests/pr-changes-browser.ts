import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('console-message', (_e, _l, m) => console.log('renderer:', m));
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const shots = path.resolve('.impeccable/review/changes');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.env.GNOSIS_WORKBENCH_URL + '?pr-summary');
    window.webContents.setZoomFactor(1);
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.deepEqual(
      await js(`(async()=>{
      const {prChangePreview,prPreviewSelection}=await import('/lib/pr-change-preview.ts');
      const file={path:'dir with spaces/name.ts',status:'modified',additions:1,deletions:1,changeId:'test',patch:'@@ -10,3 +10,3 @@\\n same\\n-old\\n+new\\n end'};
      const preview=prChangePreview(file);
      const added=prChangePreview({...file,status:'added',additions:2,deletions:0,patch:'@@ -0,0 +1,2 @@\\n+one\\n+two'});
      const deleted=prChangePreview({...file,status:'deleted',additions:0,deletions:2,patch:'@@ -1,2 +0,0 @@\\n-one\\n-two'});
      return {path:preview.name,selected:prPreviewSelection(preview,{side:'additions',start:11,end:11}),added:added.type,deleted:deleted.type,truncated:!prChangePreview({...file,additions:100}),svg:!prChangePreview({...file,path:'diagram.svg'})};
    })()`),
      {
        path: 'dir with spaces/name.ts',
        selected: '11: new',
        added: 'new',
        deleted: 'deleted',
        truncated: true,
        svg: true,
      }
    );
    await js(
      `window.fileReads=[];window.manifestReads=[];window.generationCalls=[];const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=async r=>{window.fileReads.push(r);await new Promise(resolve=>setTimeout(resolve,200));return read(r)};const manifest=window.electronAPI.getPrChanges;window.electronAPI.getPrChanges=async(...args)=>{window.manifestReads.push(args);return manifest(...args)};window.electronAPI.startReview=async r=>window.generationCalls.push(r);void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    assert.equal(await js('window.manifestReads.length'), 0);
    await js(
      `window.electronAPI.getReviewThreads=async()=>({headSha:'head-0',baseSha:'base-0',threads:[{id:'thread1',path:'src/worker.ts',line:36,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{id:'comment1',body:'Does this preserve the retry boundary?',createdAt:new Date().toISOString(),url:'https://github.com/o/r/pull/1#discussion_r1',author:{login:'maya',avatarUrl:''}}]}]});void 0;`
    );
    const frame = () => js(`[...document.querySelectorAll('.pr-summary-toolbar-inner,.pr-overview-heading,.pr-overview-heading h1,.pr-overview-tabs')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`);
    for (const width of [1400,1024,640,1280]) {
      window.setSize(width,800);
      await click('Summary');
      await new Promise(r=>setTimeout(r,100));
      const summaryFrame=await frame();
      await capture(`frame-summary-${width}`);
      await js("document.querySelector('.pr-summary-content').scrollTop=160");
      await click('Changes');
      await wait("!!document.querySelector('.changes-file-tree')");
      assert.deepEqual(await frame(),summaryFrame,'Title, navigation, actions, and tabs stay anchored when switching');
      await capture(`frame-changes-${width}`);
    }
    await wait("!!document.querySelector('.changes-file-tree')");
    await wait("!!document.querySelector('.review-image-diff') || !!document.querySelector('.changes-code img')");
    // Search the actual shadow DOM, not an imitation of the tree.
    await js(
      `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];window.openFile=name=>{const row=window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);if(!row)throw Error('Missing tree row '+name);row.click()};void 0;`
    );
    await js("window.openFile('worker.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    await wait("window.deepAll('[data-line]').length>0");
    assert.equal(await js('window.generationCalls.length'), 0);
    assert.equal(await js('window.fileReads.length'), 1, 'GitHub patches render without full-file downloads');
    assert.equal(
      await js("!!document.querySelector('.changes-loading')"),
      false,
      'An unopened text file renders immediately from its patch'
    );
    await wait("document.querySelector('.changes-code')?.textContent.includes('retry boundary')");
    assert.equal(await js("!!document.querySelector('.changes-code textarea')"), false, 'Threads are read-only');
    const lineCount = await js<number>("window.deepAll('[data-line]').length");
    await js("window.deepAll('[data-expand-button]')[0].click()");
    await wait(`window.deepAll('[data-line]').length>${lineCount}`);
    await capture('desktop');
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').focus()");
    window.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js("document.querySelector('.changes-file-header h2').textContent"),
      'src/worker.ts',
      'Arrows do not activate files'
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/old.ts'");
    await js("window.openFile('worker.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    assert.equal(
      await js("!!document.querySelector('.changes-loading')"),
      false,
      'Returning to an opened file must not show Loading file contents'
    );
    await click('Viewed & next');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('1 / 5')");
    await js("window.openFile('new.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/new.ts'");
    await wait("window.deepAll('[data-line]').length>0");
    await js("window.openFile('worker.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    await js("window.openFile('new.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/new.ts'");
    assert.equal(
      await js("!!document.querySelector('.changes-loading')"),
      false,
      'Files without patches also reopen synchronously from the renderer cache'
    );
    await click('Ask about this');
    await js(
      `(()=>{const input=document.querySelector('#changes-question');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'What changes here?');input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await js("document.querySelector('.changes-chat form').requestSubmit()");
    await wait("document.querySelector('.changes-chat-messages')?.textContent.includes('retry boundary')");
    await capture('chat');
    await click('Close file conversation');
    await click('Summary');
    await click('Changes');
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/new.ts'");
    await click('Ask about this');
    await wait("document.querySelector('.changes-chat-messages')?.textContent.includes('retry boundary')");
    await click('Close file conversation');
    await js("window.openFile('worker.ts')");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    assert.equal(
      await js("document.querySelector('.changes-file-actions input').checked"),
      true,
      'Viewed survives tab switches'
    );
    await js("document.documentElement.classList.add('dark')");
    window.setSize(1024, 768);
    await capture('user-1024');
    window.setSize(640, 740);
    await capture('mobile-tree');
    await js("document.querySelector('.changes-toolbar button').click()");
    await capture('mobile');
    window.setSize(1280, 800);
    await js("window.electronAPI.checkPrChanges=async()=>({baseSha:'base-0',headSha:'new-head'});void 0");
    await click('Summary');
    await click('Changes');
    await wait("document.querySelector('.changes-notice')?.textContent.includes('New commits')");
    assert.equal(
      await js("document.querySelector('.changes-source').textContent.includes('new-head')"),
      false,
      'New commits never replace the displayed revision automatically'
    );
    await click('Update changes');
    await wait('window.manifestReads.some(r=>r[1]===true)');
    await click('Next change');
    await wait(
      "!!document.querySelector('.pr-summary-page.showing-changes') && document.querySelector('.pr-overview-heading h1')?.textContent.includes('Reduce allocations')"
    );
    await click('Work queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Author description');
    await click('Changes');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('/ 15')");
    await js(
      "window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')?.includes('#121/src/worker.ts')).click()"
    );
    await wait("document.querySelector('.changes-source')?.textContent.includes('#121')");
    assert.equal(
      await js("document.querySelector('.changes-file-actions input').checked"),
      false,
      'Same paths in different PRs have separate progress'
    );
    await capture('stack');
    await js(
      `(()=>{const input=document.querySelector('[aria-label="Find changed files"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'worker.ts');input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await wait("window.deepAll('[data-item-type=file]').length===3");
    assert.equal(await js('window.generationCalls.length'), 0);
    console.log('PR Changes browser checks passed. Captures:', shots);
  } catch (error) {
    console.error(error);
    await capture('failure');
    console.log(await js('document.body.innerText.slice(-5000)'));
    console.log(await js("window.deepAll?.('[role=treeitem]').map(e=>e.getAttribute('data-item-path'))"));
    process.exitCode = 1;
  } finally {
    window.webContents.setZoomFactor(1);
    window.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
