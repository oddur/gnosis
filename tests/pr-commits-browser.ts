import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(`${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    window.webContents.setZoomFactor(1);
    await wait("document.querySelectorAll('.queue-item').length===7");
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
    assert.equal(await js("window.compareReads.filter(s=>s.lastSha==='e'.repeat(39)+'0').length"), 0, 'The newest commit comparison was prepared before opening Commits');
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
      "document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts' && window.deepAll('[data-line]').length>0"
    );
    assert.equal(await js("!!document.querySelector('.changes-loading')"), false);
    assert.equal(await js("!!document.querySelector('.changes-comment-composer')"), false);
    await click('Ask about this');
    await input('.changes-chat textarea', 'What is preserved here?');
    await js("document.querySelector('.changes-chat form').requestSubmit()");
    await wait("document.querySelector('.changes-chat-messages')?.textContent.includes('exact comparison')");
    assert.equal(await js('window.chatReads[0].baseSha'), 'f'.repeat(40));
    assert.equal(await js('window.chatReads[0].comparison.parentSha'), 'f'.repeat(40));
    assert.equal(await js('window.chatReads[0].path'), 'src/worker.ts');
    await capture('chat');
    await click('Close file conversation');
    await js("document.querySelector('.changes-file-actions input[type=checkbox]').click()");
    assert.match(await js<string>("document.querySelector('.changes-progress').textContent"), /1 \/ 5/);
    // Persistent selection, file, and Viewed state when returning from Summary.
    await click('Summary');
    await click('Commits');
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    assert.equal(await js("document.querySelector('.changes-file-actions input[type=checkbox]').checked"), true);
    await click('Comment in Changes');
    await wait(
      "document.querySelector('[role=tab][data-state=active]')?.textContent==='Changes' && document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'"
    );
    assert.equal(
      await js("document.querySelector('.changes-file-actions input[type=checkbox]').checked"),
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
    await js("document.querySelector('.changes-file-actions input[type=checkbox]').click()");
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
    await click('Work queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Author description');
    await click('Commits');
    await wait(
      "document.querySelectorAll('.commit-list section').length===3 && !!document.querySelector('.changes-file-header')"
    );
    assert.equal(await js('document.querySelectorAll(".commit-row").length'), 7);
    await capture('stack');
    // Recover a failed comparison without downloading unrelated commits.
    const previousTitle = await js("document.querySelector('.commit-detail-title').textContent");
    await js("window.failComparison=true;document.querySelectorAll('.commit-row')[4].click()");
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
    await wait("!document.querySelector('[role=alert]') && !!document.querySelector('.changes-file-header')");
    await js("document.querySelector('.commit-detail summary').click()");
    await wait(
      "document.querySelector('.commit-detail details').open && document.querySelector('.commit-messages').textContent.includes('Committed by')"
    );
    await capture('details');
    console.log('Commits browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync('/tmp/commits-failure.png', (await window.webContents.capturePage()).toPNG());
    console.error(await js('document.body.innerText'));
    app.exit(1);
  }
});
