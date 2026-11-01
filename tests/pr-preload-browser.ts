import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  try {
    if (process.platform === 'darwin') app.show();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    // Let discovery prepare the queue before opening either inspection tab.
    await js(`(async()=>{window.inspection=(await import('/lib/inspection-cache.ts')).inspectionData;await window.inspection.flush();window.inspectionReads=[];
      for(const name of ['getPrChanges','getPrCommits','getPrChangeFile','getCommitComparison']) {
        const original=window.electronAPI[name];window.electronAPI[name]=async(...args)=>{window.inspectionReads.push({name,args});await new Promise(r=>setTimeout(r,250));return original(...args)};
      }
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];
      window.loadingFlashes=[];new MutationObserver(()=>{if([...document.querySelectorAll('.changes-loading,.commits-loading')].some(e=>{const r=e.getBoundingClientRect(),p=e.closest('.commit-diff-stream')?.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>Math.max(0,p?.top??0)&&r.top<Math.min(innerHeight,p?.bottom??innerHeight)}))window.loadingFlashes.push(document.body.innerText)}).observe(document.body,{subtree:true,childList:true});
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await click('Changes');
    await wait("!!document.querySelector('.review-image-diff')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='new.ts').click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/new.ts'");
    assert.deepEqual(await js('window.loadingFlashes'), [], 'Prepared Changes opens without a loading phase');
    assert.deepEqual(await js('window.inspectionReads'), [], 'Prepared file selection needs no IPC content fetch');
    await click('Commits');
    await wait("!!document.querySelector('.commit-detail-title')");
    assert.equal(
      await js("document.querySelector('.commit-detail-title')?.textContent"),
      'Merge worker scheduling updates'
    );
    assert.deepEqual(await js('window.loadingFlashes'), [], 'Prepared Commits opens without a loading phase');
    assert.deepEqual(
      await js("window.inspectionReads.filter(r=>r.name==='getPrCommits')"),
      [],
      'Commit catalog was prepared by discovery'
    );
    await js("[...document.querySelectorAll('.commit-row')].find(row => row.textContent.includes('Keep retry boundaries intact')).click()");
    await wait("document.querySelector('.commit-detail-title')?.textContent.includes('Keep retry boundaries intact')");
    assert.deepEqual(await js('window.loadingFlashes'), [], 'Older commits also open from prepared content');
    assert.deepEqual(await js('window.inspectionReads'), [], 'All individual commit diffs were preloaded');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-header')");
    // Supply a new revision and visibly different file contents, without remounting Changes.
    await js(`(async()=>{
      const queue=await window.electronAPI.workbenchQueue();const member=queue.items.flatMap(i=>i.subject.members).find(m=>m.title.includes('Fix reconnect'));
      window.nextRevision={...member,headSha:'new-prepared-head'};
      const changes=window.electronAPI.getPrChanges,commits=window.electronAPI.getPrCommits,file=window.electronAPI.getPrChangeFile;
      window.electronAPI.getPrChanges=async(...args)=>{const s=await changes(...args);return s.url===member.url?{...s,metadata:{...s.metadata,headSha:window.nextRevision.headSha},fetchedAt:Date.now()}:s};
      window.electronAPI.getPrCommits=async(...args)=>{const s=await commits(...args);return s.url===member.url?{...s,metadata:{...s.metadata,headSha:window.nextRevision.headSha},fetchedAt:Date.now()}:s};
      window.electronAPI.getPrChangeFile=async(...args)=>{const s=await file(...args);return args[0].headSha===window.nextRevision.headSha?{...s,after:{kind:'text',content:'const newlyPreparedRevision = true;'}}:s};
      const loadQueue=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async(...args)=>{const q=await loadQueue(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>m.url===member.url?window.nextRevision:m)}}))}};
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r=>setTimeout(r,100));
      await window.inspection.flush();
    })()`);
    assert.equal(
      await js("window.deepAll('*').some(e=>e.children.length===0&&e.textContent.includes('newlyPreparedRevision'))"),
      false,
      'Preparing a new revision cannot replace the open diff'
    );
    assert.equal(await js('window.inspection.peekChanges(window.nextRevision).metadata.headSha'), 'new-prepared-head');
    await click('Summary');
    await click('Changes');
    await wait("window.deepAll('*').some(e=>e.children.length===0&&e.textContent.includes('newlyPreparedRevision'))");
    assert.deepEqual(
      await js('window.loadingFlashes'),
      [],
      'Reopening uses the prepared revision without a loading phase'
    );
    console.log(
      'Revision preload browser checks passed: first tab open, all PR files, default commit, pinned active diff, prepared revision on reopen.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
