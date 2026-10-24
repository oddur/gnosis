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
    // Give the active view idle time to prepare the next commit, with deliberately slow IPC.
    await new Promise((r) => setTimeout(r, 1200));
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
    await new Promise((r) => setTimeout(r, 1200));
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
    console.log('Diff navigation performance checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
