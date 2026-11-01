import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
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
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 40));
  };
  const input = async (selector: string, value: string) =>
    js(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`
    );
  const shots = path.resolve('.impeccable/review/commits');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    window.show();
    window.focus();
    await wait("document.visibilityState==='visible'");
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-commits-' + name + '.json'),
      await js<string>(
        `JSON.stringify({scroll:[...document.querySelectorAll('.changes-code-scroll')].map(e=>({top:e.scrollTop,height:e.clientHeight,scrollHeight:e.scrollHeight,rect:e.getBoundingClientRect().toJSON(),overflow:getComputedStyle(e).overflow})),rows:[...document.querySelectorAll('.commit-stream-row')].map(e=>({file:e.dataset.file,rect:e.getBoundingClientRect().toJSON(),header:e.querySelector('header')?.getBoundingClientRect().toJSON(),content:e.querySelector('.changes-code')?.getBoundingClientRect().toJSON()}))},null,2)`
      )
    );
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    await js("document.title='Gnosis — automated commit-view checks'");
    window.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(window.webContents);
    await js("(async()=>{await (await import('/lib/inspection-cache.ts')).inspectionData.flush()})()");
    await js(
      `window.commitReads=[];window.compareReads=[];window.fileReads=[];window.chatReads=[];window.threadReads=0;const list=window.electronAPI.getPrCommits,compare=window.electronAPI.getCommitComparison,file=window.electronAPI.getPrChangeFile,thread=window.electronAPI.getReviewThreads;window.electronAPI.getPrCommits=async(...args)=>{window.commitReads.push(args);return list(...args)};window.electronAPI.getCommitComparison=async s=>{window.compareReads.push(s);if(window.failComparison)throw Error('Comparison unavailable. Retry.');await new Promise(r=>setTimeout(r,40));return compare(s)};window.electronAPI.getPrChangeFile=async r=>{window.fileReads.push(r);return file(r)};window.electronAPI.askPrFile=async r=>{window.chatReads.push(r);return 'This exact comparison preserves the retry boundary.'};window.electronAPI.getReviewThreads=async(...args)=>{window.threadReads++;return thread(...args)};window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];window.openFile=name=>window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name).click();void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    assert.equal(await js('window.commitReads.length'), 0);
    const initialThreads = await js<number>('window.threadReads');
    await click('Commits');
    await wait(
      "document.querySelectorAll('.commit-row').length===3 && !!document.querySelector('.changes-file-header')"
    );
    assert.equal(
      await js('window.threadReads'),
      initialThreads,
      'Historical comparisons must not load current review threads'
    );
    await wait("!!document.querySelector('.review-image-diff')");
    assert.equal(
      await js("window.compareReads.filter(s=>s.lastSha==='e'.repeat(39)+'0').length"),
      0,
      'The newest commit comparison was prepared before opening Commits'
    );
    assert.equal(await js("!!document.querySelector('.changes-toolbar select')"), false);
    await click('Diff appearance');
    await wait('!!document.querySelector(\'[role=dialog] [aria-label="Diff layout"]\')');
    await input('[aria-label="Diff layout"]', 'split');
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffLayout==='split')");
    await capture('appearance');
    await input('[aria-label="Diff layout"]', 'unified');
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffLayout==='unified')");
    await js(
      "document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('[role=dialog]')");

    assert.equal(
      await js(
        `document.querySelector('[aria-label="Search commits"], [aria-label="Commit author"], [aria-label="Commit order"], [aria-label="Find changed files"]')`
      ),
      null
    );
    assert.match(await js<string>("document.querySelector('.commit-row').textContent"), /Merge worker/);
    // Opening a commit does not mark it viewed; all its files must be viewed.
    assert.equal(await js("document.querySelectorAll('.commit-row.is-unviewed .pr-unread-dot').length"), 3);
    await js("document.querySelector('.changes-tree-controls input').click()");
    for (let i = 0; i < 5; i++) {
      await js("[...document.querySelectorAll('.commit-stream-row button')].find(b=>b.textContent.trim()==='Viewed & next').click()");
      await new Promise(r => setTimeout(r, 120));
    }
    await wait("!document.querySelector('.commit-row[aria-pressed=true] .pr-unread-dot')");
    await click('Show all files');
    assert.equal(await js("document.querySelectorAll('.commit-row.is-unviewed').length"), 2);
    assert.equal(await js("getComputedStyle(document.querySelector('.commit-row[aria-pressed=true] .commit-row-title')).fontWeight"), '500');
    assert.equal(await js("getComputedStyle(document.querySelector('.commit-row.is-unviewed .commit-row-title')).fontWeight"), '650');
    await capture('viewed-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('viewed-dark');
    window.setSize(900, 740);
    await capture('viewed-narrow');
    window.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await click('Summary');
    await click('Commits');
    await wait("!!document.querySelector('.commit-row[aria-pressed=true]') && !document.querySelector('.commit-row[aria-pressed=true] .pr-unread-dot')");
    // The completion marker uses the existing durable Viewed store.
    assert.equal(await js("Object.keys(JSON.parse(localStorage.getItem('gnosis-file-progress:v1')).marks).some(k=>k.startsWith('commit-viewed:'))"), true);
    await js("document.querySelector('.changes-file-actions input[type=checkbox]').click()");
    await wait("!!document.querySelector('.commit-row[aria-pressed=true] .pr-unread-dot')");
    await js("document.querySelectorAll('.changes-file-actions input[type=checkbox]').forEach(e=>{if(e.checked)e.click()})");
    // A scrolling commit history must keep its position when the comparison changes.
    await js("(()=>{const style=document.createElement('style');style.id='commit-scroll-test';style.textContent='.commit-list{max-height:100px;flex:none}';document.head.appendChild(style);const list=document.querySelector('.commit-list');list.scrollTop=60;list.dispatchEvent(new Event('scroll',{bubbles:true}));window.commitListBefore=list;window.commitScrollBefore=list.scrollTop;const next=document.querySelectorAll('.commit-row')[1];next.focus({preventScroll:true});next.click()})()");
    await wait("document.querySelector('.commit-detail-title')?.textContent.includes('Keep retry boundaries')");
    assert.ok(await js<number>('window.commitScrollBefore') > 0, 'The regression starts with a scrolled history');
    assert.equal(await js("document.querySelector('.commit-list').scrollTop"), await js('window.commitScrollBefore'), 'Selecting a commit must not jump the history back to the top');
    assert.equal(await js("document.activeElement===document.querySelector('.commit-row[aria-pressed=true]')"), true, 'Keyboard focus stays on the chosen commit');
    await js("document.querySelectorAll('.commit-row')[0].click()");
    await wait("document.querySelector('.commit-detail-title')?.textContent.includes('Merge worker')");
    await js("document.querySelector('#commit-scroll-test').remove();document.querySelector('.commit-list').scrollTop=0");
    // Ranges retain chronological order while the list always shows newest first.
    await js(
      "document.querySelector('.commit-range-controls input[type=checkbox]').click();document.querySelectorAll('.commit-row')[2].click()"
    );
    await wait(
      "!document.querySelector('[aria-label=\"Compare with parent\"]') && !!document.querySelector('.changes-file-header')"
    );
    await js("document.querySelectorAll('.commit-row')[0].click()");
    await wait(
      "document.querySelector('.commit-detail-title')?.textContent.includes('3 commits') && !!document.querySelector('.changes-file-header')"
    );
    assert.equal(await js('window.compareReads.at(-1).firstSha'), 'a'.repeat(40));
    await js(
      "document.querySelector('.commit-range-controls input[type=checkbox]').click();document.querySelectorAll('.commit-row')[0].click()"
    );
    await wait(
      "!!document.querySelector('[aria-label=\"Compare with parent\"]') && !!document.querySelector('.changes-file-header')"
    );
    await input('[aria-label="Compare with parent"]', 'f'.repeat(40));
    await wait(
      "document.querySelector('[aria-label=\"Compare with parent\"]')?.value==='f'.repeat(40) && !!document.querySelector('.changes-file-header')"
    );
    await js("window.openFile('worker.ts')");
    await wait(
      "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2') ?? document.querySelector('.changes-file-header h2'))?.textContent==='src/worker.ts' && window.deepAll('[data-line]').length>0"
    );
    assert.equal(await js("!!document.querySelector('.changes-loading')"), false);
    assert.equal(await js("!!document.querySelector('.changes-comment-composer')"), false);
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header').getBoundingClientRect().top < document.querySelector('.commit-diff-stream').getBoundingClientRect().bottom"
    );
    assert.ok(
      (await js<number>("document.querySelectorAll('.commit-stream-row').length")) > 1,
      'One scroll surface contains multiple file diffs'
    );
    await js(
      "[...document.querySelectorAll('.commit-stream-row[data-active=true] button')].find(b=>b.textContent.trim()==='Ask about this').click()"
    );
    await input('.changes-chat textarea', 'What is preserved here?');
    await js("document.querySelector('.changes-chat form').requestSubmit()");
    await wait("document.querySelector('.changes-chat .chat-conversation')?.textContent.includes('exact comparison')");
    assert.equal(await js('window.chatReads[0].baseSha'), 'f'.repeat(40));
    assert.equal(await js('window.chatReads[0].comparison.parentSha'), 'f'.repeat(40));
    assert.equal(await js('window.chatReads[0].path'), 'src/worker.ts');
    await capture('chat');
    await click('Close chat');
    await js(
      "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input[type=checkbox]') ?? document.querySelector('.changes-file-actions input[type=checkbox]')).click()"
    );
    assert.match(await js<string>("document.querySelector('.changes-progress').textContent"), /1 \/ 5/);
    // Persistent selection, file, and Viewed state when returning from Summary.
    await click('Summary');
    await click('Commits');
    await wait(
      "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2') ?? document.querySelector('.changes-file-header h2'))?.textContent==='src/worker.ts'"
    );
    assert.equal(
      await js(
        "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input[type=checkbox]') ?? document.querySelector('.changes-file-actions input[type=checkbox]')).checked"
      ),
      true
    );
    await js(
      "[...document.querySelectorAll('.commit-stream-row[data-active=true] button')].find(b=>b.textContent.trim()==='Comment in Changes').click()"
    );
    await wait(
      "document.querySelector('[role=tab][data-state=active]')?.textContent==='Changes' && (document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2') ?? document.querySelector('.changes-file-header h2'))?.textContent==='src/worker.ts'"
    );
    assert.equal(
      await js(
        "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input[type=checkbox]') ?? document.querySelector('.changes-file-actions input[type=checkbox]')).checked"
      ),
      false,
      'Historical Viewed must not mark full-PR files'
    );
    assert.equal(await js('!!document.querySelector(\'[aria-label="Find changed files"]\')'), true);
    await click('Commits');
    await wait("!!document.querySelector('.commit-detail') && !!document.querySelector('.changes-file-header')");
    // New pushes are announced without replacing an open historical diff.
    await js("window.electronAPI.checkPrChanges=async()=>({headSha:'moved',baseSha:'base-0'});void 0;");
    await click('Summary');
    await click('Commits');
    await wait("document.querySelector('.pr-commits .changes-notice')?.textContent.includes('New commits')");
    assert.equal(await js('document.querySelector(\'[aria-label="Compare with parent"]\').value'), 'f'.repeat(40));
    await click('Update commits');
    await wait(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Update commits')&&!b.disabled)"
    );
    assert.equal(await js('window.commitReads.at(-1)[1]'), true);
    await js(
      "(document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input[type=checkbox]') ?? document.querySelector('.changes-file-actions input[type=checkbox]')).click()"
    );
    for (const width of [1280, 1024, 640, 1616]) {
      const height = width === 1616 ? 1200 : 800;
      window.setContentSize(width, height);
      await wait(`innerWidth === ${width} && innerHeight === ${height}`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (width === 640) await js("document.querySelector('.changes-toolbar button').click()");
      if (width === 1024)
        assert.ok(
          (await js<number>("document.querySelector('.changes-code-scroll').getBoundingClientRect().height")) >= 230,
          'Laptop diff keeps a useful code viewport'
        );
      assert.equal(await js('document.documentElement.scrollWidth>window.innerWidth'), false, 'No viewport overflow');
      await capture(width === 1280 ? 'desktop' : width === 640 ? 'mobile' : `user-${width}`);
      if (width === 640) await js("document.querySelector('.changes-toolbar button').click()");
    }
    window.setContentSize(1280, 800);
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    await js("document.documentElement.classList.remove('dark')");
    // Stack grouping omits inherited identical SHAs but keeps sibling/unique work.
    await click('Review queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open stack overview');
    await click('Commits');
    await wait(
      "document.querySelectorAll('.commit-list section').length===3 && !!document.querySelector('.changes-file-header')"
    );
    assert.equal(await js('document.querySelectorAll(".commit-row").length'), 7);
    await capture('stack');
    // Exercise a cold comparison: normal queue preloading now prepares every commit.
    // Keep the displayed snapshot, but clear the fixture's renderer cache before injecting failure.
    const previousTitle = await js("document.querySelector('.commit-detail-title').textContent");
    await js(`(async()=>{
      const {inspectionData}=await import('/lib/inspection-cache.ts');
      const queue=await window.electronAPI.workbenchQueue();
      inspectionData.setTargets(null,[]);
      inspectionData.stop();
      // Keep tab inventories warm so the rest of this test still exercises saved navigation.
      await Promise.all(queue.items.flatMap(item=>item.subject.members).map(member=>inspectionData.readCommits(member)));
      window.failComparison=true;
      document.querySelectorAll('.commit-row')[4].click();
    })()`);
    await wait("document.querySelector('[role=alert]')?.textContent.includes('Comparison unavailable')");
    assert.equal(
      await js("document.querySelector('.changes-tree-pane').textContent.includes('No changed files')"),
      false
    );
    assert.equal(
      await js("document.querySelector('.commit-detail-title').textContent"),
      previousTitle,
      'A failed navigation retains the labelled previous comparison'
    );
    assert.equal(await js("!!document.querySelector('.changes-loading')"), false);
    await capture('error');
    await js('window.failComparison=false');
    await click('Retry');
    await wait(
      "!document.querySelector('[role=alert]') && document.querySelector('.commit-detail-title')?.textContent.includes('Keep retry boundaries intact') && document.querySelector('.commit-detail')?.textContent.includes('klang/engine #121') && !!document.querySelector('.changes-file-header')"
    );
    await js("document.querySelector('.commit-detail summary').click()");
    await wait(
      "document.querySelector('.commit-detail details').open && document.querySelector('.commit-messages').textContent.includes('Committed by')"
    );
    await capture('details');
    // Scrolling changes the current file, and headers remain sticky within their own diff.
    await js("window.openFile('new.ts')");
    await wait("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/new.ts'");
    await js(
      "const el=document.querySelector('.commit-diff-stream');el.dispatchEvent(new WheelEvent('wheel',{deltaY:150,bubbles:true}));el.scrollTop+=150"
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      await js<boolean>(
        "Math.abs(document.querySelector('.commit-stream-row[data-active=true] .changes-file-header').getBoundingClientRect().top-document.querySelector('.commit-diff-stream').getBoundingClientRect().top)<3"
      ),
      'File header sticks while scrolling its code'
    );
    await capture('stream-scrolled');
    const savedScroll = await js<number>("document.querySelector('.commit-diff-stream').scrollTop");
    await click('Summary');
    await click('Commits');
    await wait("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/new.ts'");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(
      Math.abs((await js<number>("document.querySelector('.commit-diff-stream').scrollTop")) - savedScroll) < 5,
      'Restore reading offset in the comparison'
    );
    // Viewed collapses the body; filtering removes it from both navigation and the stream.
    await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input').click()");
    await wait(
      '(document.querySelector(\'.commit-stream-row[data-file="src/new.ts"] .changes-code\')?.getClientRects().length ?? 0)===0'
    );
    await js("document.querySelector('.changes-tree-controls input').click()");
    await wait('!document.querySelector(\'.commit-stream-row[data-file="src/new.ts"]\')');
    await capture('unviewed');
    for (let i = 0; i < 5; i++) {
      const next = await js<boolean>(
        "(()=>{const b=[...document.querySelectorAll('.commit-stream-row button')].find(b=>b.textContent.trim()==='Viewed & next');if(!b)return false;b.click();return true})()"
      );
      if (!next) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    await wait("document.querySelector('.commit-viewed-complete')?.textContent.includes('All files viewed')");
    await capture('all-viewed');
    await click('Show all files');
    await wait("document.querySelectorAll('.commit-stream-row').length===5");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.commit-stream-row .changes-code')].filter(e=>e.getClientRects().length>0).length"
      ),
      0
    );
    // PR groups can collapse; inherited source links reveal the owning PR.
    await js("document.querySelector('.commit-pr-heading').click()");
    await wait("document.querySelector('.commit-pr-heading').getAttribute('aria-expanded')==='false'");
    await capture('stack-collapsed');
    await js("document.querySelector('.commit-source-links button').click()");
    await wait("document.querySelector('.commit-pr-heading').getAttribute('aria-expanded')==='true'");
    // A large comparison restores a distant file while mounting only a small visible window.
    await js(String.raw`(async()=>{
      const {mountLargeComparison}=await import('/tests/fixtures/commit-stream.tsx');
      const queue=await window.electronAPI.workbenchQueue();const subject={...queue.items[0].subject,id:'large-commit-stream-test',kind:'pr',members:[queue.items[0].subject.members[0]],edges:[]};
      const selection=window.compareReads[0];const original=await window.electronAPI.getCommitComparison(selection);
      const snapshot={...original,metadata:{...original.metadata,headSha:'large-stream-head'},comparison:{...selection,lastSha:'large-stream-head'},files:Array.from({length:120},(_,i)=>({path:'src/file'+String(i).padStart(3,'0')+'.ts',status:'modified',additions:1,deletions:1,changeId:'file-'+i,patch:'@@ -1 +1 @@\n-old\n+new'}))};
      const preferences={...await window.electronAPI.loadPreferences(),diffLayout:'unified',diffAppearance:{contextLines:3}};
      window.largeFilesBefore=window.fileReads.length;
      mountLargeComparison(subject,snapshot,preferences);
    })()`);
    await wait(
      "document.querySelector('#large-stream-test .commit-stream-row[data-active=true]')?.dataset.file==='src/file119.ts'"
    );
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(
      (await js<number>("document.querySelectorAll('#large-stream-test .commit-stream-row').length")) < 15,
      'A large commit does not mount every diff'
    );
    assert.equal(
      await js('window.fileReads.length'),
      await js('window.largeFilesBefore'),
      'Complete patches do not trigger a full-content download for every file'
    );
    await capture('large-commit');
    await js(
      "(()=>{const el=document.querySelector('#large-stream-test .commit-diff-stream');el.dispatchEvent(new WheelEvent('wheel',{deltaY:-1000,bubbles:true}));el.scrollTop=0})()"
    );
    await wait(
      "document.querySelector('#large-stream-test .commit-stream-row[data-active=true]')?.dataset.file==='src/file000.ts'"
    );
    console.log('Commits browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      window.show();
      window.focus();
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(os.tmpdir(), 'commits-failure.png'), (await window.webContents.capturePage()).toPNG());
      console.error(await js('document.body.innerText'));
    } finally {
      app.exit(1);
    }
  }
});
