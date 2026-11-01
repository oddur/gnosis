import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('.commit-stream-row[data-active=true] button'),...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  try {
    if (process.platform === 'darwin') app.show();
    window.show();
    window.focus();
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', {rate:6});
    await waitForWorkbenchQueue(window.webContents);
    // Exercise the cache-hit path: background preparation may finish before spies attach.
    await js(`(async()=>{
      window.inspection=await import('/lib/inspection-cache.ts');
      await window.inspection.inspectionData.flush();
      const list=await window.electronAPI.getPrCommits('https://github.com/klang/engine/pull/150');
      window.adjacentSelection={url:list.url,prBaseSha:list.metadata.baseSha,prHeadSha:list.metadata.headSha,firstSha:'d'.repeat(40),lastSha:'d'.repeat(40)};
    })()`);
    await js(
      `window.compareReads=[];window.fileReads=[];const compare=window.electronAPI.getCommitComparison,file=window.electronAPI.getPrChangeFile;window.electronAPI.getCommitComparison=async(...args)=>{window.compareReads.push(args);await new Promise(r=>setTimeout(r,250));return compare(...args)};window.electronAPI.getPrChangeFile=async(...args)=>{window.fileReads.push(args);await new Promise(r=>setTimeout(r,250));return file(...args)};window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await click('Commits');
    await wait("!!document.querySelector('.review-image-diff')");
    // Wait for automatic preparation, not a machine-dependent idle delay. The
    // measured click below must still render within two frames without IPC.
    await wait(
      "window.inspection.comparisonIsReady(window.adjacentSelection, '')"
    );
    const switched = await js<{ loading: boolean; title: string; elapsed: number; reads: number }>(
      `(async()=>{const t=performance.now(),reads=window.compareReads.length;document.querySelectorAll('.commit-row')[1].click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {loading:!!document.querySelector('.commit-stream-row[data-active=true] .changes-loading')||document.querySelector('.changes-empty')?.textContent.includes('Loading')||false,title:document.querySelector('.commit-detail-title')?.textContent??'',elapsed:performance.now()-t,reads:window.compareReads.length-reads}})()`
    );
    console.log('Adjacent commit:', JSON.stringify(switched));
    assert.equal(
      switched.loading,
      false,
      'Selecting a prepared adjacent commit must not replace the diff with a loading phase'
    );
    assert.match(switched.title, /retry boundaries/);
    assert.equal(switched.reads, 0, 'Opening a prepared commit must not request its comparison again');
    await wait("!!document.querySelector('.review-image-diff')");
    await wait(`(() => {
      const selection = window.adjacentSelection;
      const snapshot = selection && window.inspection.peekComparison(selection);
      const file = snapshot?.files.find(f => f.path === 'src/new.ts');
      return !!file && window.inspection.fileIsReady(snapshot, file);
    })()`);
    const nextFile = await js<{ loading: boolean; path: string }>(
      `(async()=>{window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='new.ts').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {loading:!!document.querySelector('.commit-stream-row[data-active=true] .changes-loading'),path:document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent??''}})()`
    );
    console.log('Unopened file:', JSON.stringify(nextFile));
    assert.equal(
      nextFile.loading,
      false,
      'The next file must be ready before selection, including files without a usable patch'
    );
    assert.equal(nextFile.path, 'src/new.ts');
    // A later file click must win over a slower response.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='old.ts').click()");
    // Cold-file reachability is eventual; unlike the prepared-file assertion
    // above, it must allow deferred scroll restoration and file preparation.
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent === 'src/old.ts'");
    await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/worker.ts'");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent"),
      'src/worker.ts',
      'A stale file response must not override the latest selection'
    );
    // Alternate merge parent is deliberately not speculatively loaded.
    await js("document.querySelectorAll('.commit-row')[0].click()");
    await wait('!!document.querySelector(\'[aria-label="Compare with parent"]\')');
    await js(
      `(()=>{const select=document.querySelector('[aria-label="Compare with parent"]');select.value='f'.repeat(40);select.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await js("!!document.querySelector('.commit-stream-row[data-active=true] .changes-loading')"), false);
    await js("document.querySelectorAll('.commit-row')[2].click()");
    await new Promise((r) => setTimeout(r, 700));
    assert.match(
      await js<string>("document.querySelector('.commit-detail-title').textContent"),
      /Introduce the queue/,
      'The latest commit selection wins'
    );
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await js(`(()=>{const manifest=window.electronAPI.getPrChanges,read=window.electronAPI.getPrChangeFile;
      window.unsupportedReads=[];window.openedURLs=[];
      window.electronAPI.openExternal=async url=>window.openedURLs.push(url);
      window.electronAPI.getPrChanges=async(...args)=>{const s=await manifest(...args);return {...s,files:[...s.files,...['binary.dat','oversized.txt','invalid.txt','temporary.txt'].map(path=>({path:'unsupported/'+path,status:'added',additions:1,deletions:0,changeId:path}))]}};
      window.electronAPI.getPrChangeFile=async r=>{
        if(r.path.startsWith('unsupported/')){window.unsupportedReads.push(r.path);throw Error(r.path.endsWith('binary.dat')?'This binary file has no text preview. Open it on GitHub.':r.path.endsWith('oversized.txt')?'This file is too large to preview. Open it on GitHub.':r.path.endsWith('invalid.txt')?'This file is not UTF-8 text. Open it on GitHub.':'Network unavailable. Try again.')}
        return read(r);
      };
    })()`);
    await click('Update changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='binary.dat')");
    for (const name of ['binary.dat', 'oversized.txt', 'invalid.txt']) {
      await js(
        `window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`
      );
      await wait(
        `document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='unsupported/${name}'`
      );
      await wait(
        "document.querySelector('.commit-stream-row[data-active=true] .changes-code-scroll [role=alert]')?.textContent.includes('Open it on GitHub')"
      );
      assert.equal(
        await js("!!document.querySelector('.commit-stream-row[data-active=true] .changes-loading')"),
        false
      );
      await click('Open on GitHub');
      assert.match(await js<string>('window.openedURLs.at(-1)'), /\/pull\/150\/files$/);
      await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input').click()");
      assert.equal(
        await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-actions input').checked"),
        true,
        'Unsupported files can be marked Viewed'
      );
    }
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').click()");
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/worker.ts'"
    );
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='temporary.txt').click()");
    await wait("document.querySelector('.pr-changes')?.textContent.includes('Network unavailable')");
    assert.equal(
      await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent"),
      'unsupported/temporary.txt',
      'A failed file stays reachable in the stream with its recovery actions'
    );
    console.log('Diff navigation performance checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
