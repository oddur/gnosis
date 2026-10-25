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
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  try {
    if (process.platform === 'darwin') app.show();
    window.show();
    window.focus();
    await window.loadURL(`${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
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
    await js("import('/lib/inspection-cache.ts').then(module => { window.inspection = module; })");
    await wait(
      "window.compareReads.some(([s]) => s.lastSha === 'd'.repeat(40) && window.inspection.comparisonIsReady(s, ''))"
    );
    const switched = await js<{ loading: boolean; title: string; elapsed: number }>(
      `(async()=>{const t=performance.now();document.querySelectorAll('.commit-row')[1].click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {loading:!!document.querySelector('.changes-loading')||document.querySelector('.changes-empty')?.textContent.includes('Loading')||false,title:document.querySelector('.commit-detail-title')?.textContent??'',elapsed:performance.now()-t}})()`
    );
    console.log('Adjacent commit:', JSON.stringify(switched));
    assert.equal(
      switched.loading,
      false,
      'Selecting a prepared adjacent commit must not replace the diff with a loading phase'
    );
    assert.match(switched.title, /retry boundaries/);
    await wait("!!document.querySelector('.review-image-diff')");
    await wait(`(() => {
      const selection = window.compareReads.find(([s]) => s.lastSha === 'd'.repeat(40))?.[0];
      const snapshot = selection && window.inspection.peekComparison(selection);
      const file = snapshot?.files.find(f => f.path === 'src/new.ts');
      return !!file && window.inspection.fileIsReady(snapshot, file);
    })()`);
    const nextFile = await js<{ loading: boolean; path: string }>(
      `(async()=>{window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='new.ts').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {loading:!!document.querySelector('.changes-loading'),path:document.querySelector('.changes-file-header h2')?.textContent??''}})()`
    );
    console.log('Unopened file:', JSON.stringify(nextFile));
    assert.equal(
      nextFile.loading,
      false,
      'The next file must be ready before selection, including files without a usable patch'
    );
    assert.equal(nextFile.path, 'src/new.ts');
    // A cold file keeps the existing diff. A later click must win over its slower response.
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='old.ts').click()");
    const cold = await js<{ loading: boolean; path: string }>(
      `({loading:!!document.querySelector('.changes-loading'),path:document.querySelector('.changes-file-header h2')?.textContent})`
    );
    assert.equal(cold.loading, false);
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').click()");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      await js("document.querySelector('.changes-file-header h2')?.textContent"),
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
    assert.equal(await js("!!document.querySelector('.changes-loading')"), false);
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
      await wait(`document.querySelector('.changes-file-header h2')?.textContent==='unsupported/${name}'`);
      await wait(
        "document.querySelector('.changes-code-scroll [role=alert]')?.textContent.includes('Open it on GitHub')"
      );
      assert.equal(await js("!!document.querySelector('.changes-loading')"), false);
      await js("document.querySelector('.changes-file-actions input').click()");
      assert.equal(
        await js("document.querySelector('.changes-file-actions input').checked"),
        true,
        'Unsupported files can be marked Viewed'
      );
      await click('Open on GitHub');
      assert.match(await js<string>('window.openedURLs.at(-1)'), /\/pull\/150\/files$/);
    }
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').click()");
    await wait("document.querySelector('.changes-file-header h2')?.textContent==='src/worker.ts'");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='temporary.txt').click()");
    await wait("document.querySelector('.pr-changes')?.textContent.includes('Network unavailable')");
    assert.equal(
      await js("document.querySelector('.changes-file-header h2')?.textContent"),
      'src/worker.ts',
      'Transient failure keeps the current diff visible'
    );
    console.log('Diff navigation performance checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
