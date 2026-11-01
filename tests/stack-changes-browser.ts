import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
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
  const click = (text: string) =>
    js(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`
    );
  const shots = path.resolve('.impeccable/review/stack-changes');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(window.webContents);
    await js(`(async()=>{
      const {inspectionData}=await import('/lib/inspection-cache.ts');inspectionData.stop();
      window.combinedReads=0;window.sourceOpens=[];window.stackRequests=[];window.cancelledRequests=[];window.failRootComments=true;window.preloadGate=new Promise(resolve=>window.releasePreload=resolve);window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])];
      const prefs=await window.electronAPI.loadPreferences();await window.electronAPI.savePreferences({...prefs,stackChangesMode:'by-pr'});
      const source=window.electronAPI.getPrChanges;
      window.electronAPI.getStackChanges=async(subject,refresh,options)=>{
        window.stackRequests.push(options);await window.preloadGate;
        window.combinedReads++;if(window.combinedFailure)throw Error(window.combinedFailure);
        const snapshots=await Promise.all(subject.members.map(m=>source(m.url)));
        const root=snapshots[0],tip=snapshots.at(-1);
        const files=[window.renameCombined?{...root.files[0],path:'src/final.ts',previousPath:'src/old.ts',status:'renamed'}:root.files[0],{...root.files[0],path:'src/zz-review.ts',changeId:'second'}];
        return {version:1,url:tip.url,metadata:{...tip.metadata,baseSha:root.metadata.baseSha,baseBranch:root.metadata.baseBranch},comparisonBase:root.metadata.baseSha,fetchedAt:Date.now(),files,filesTruncated:!!window.partialCombined,
          stackComparison:{key:'a'.repeat(64),subjectId:subject.id,members:snapshots.map(s=>({metadata:s.metadata,comparisonBase:s.comparisonBase})),fileSources:Object.fromEntries(files.map(f=>[f.path,subject.members.map(m=>m.url)])),fileSourcePaths:window.renameCombined?{'src/final.ts':Object.fromEntries(subject.members.map((m,i)=>[m.url,i===0?'src/middle.ts':'src/final.ts']))}:undefined}};
      };
      window.electronAPI.getReviewThreads=async url=>{if(window.failRootComments&&url.endsWith('/120'))throw Error('Root discussions unavailable');return ({headSha:'head-'+(Number(url.split('/').pop())-120),baseSha:'base-'+(Number(url.split('/').pop())-120),threads:[{id:'thread-'+url,path:window.renameCombined?(url.endsWith('/120')?'src/middle.ts':'src/final.ts'):'src/worker.ts',line:36,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{id:'comment-'+url,body:'Check the boundary in this source PR.',createdAt:new Date().toISOString(),url:url+'#discussion',author:{login:'maya',avatarUrl:''}}]}]});};
      window.electronAPI.cancelInspection=async id=>{window.cancelledRequests.push(id)};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('bounded command queue')).click()"
    );
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open stack overview')");
    await click('Open stack overview');
    await wait("!!document.querySelector('.pr-overview-tabs')");
    await click('Changes');
    await wait('window.stackRequests.some(r=>r.background)');
    await wait("!!document.querySelector('.commit-stream-row[data-active=true]')");
    const byPrFile = await js<string>("document.querySelector('.commit-stream-row[data-active=true]').dataset.file");
    await click('Combined');
    await wait('window.stackRequests.some(r=>!r.background)');
    assert.equal(
      await js('window.cancelledRequests.length'),
      0,
      'Promotion keeps the existing reader alive so the backend can join its work'
    );
    await js('window.releasePreload();void 0');
    await wait("!!document.querySelector('.stack-comparison-context')");
    await wait('!!document.querySelector(\'[aria-label="Retry comments for PR #120"]\')');
    await js('window.failRootComments=false');
    await js('document.querySelector(\'[aria-label="Retry comments for PR #120"]\').click()');
    await wait('!document.querySelector(\'[aria-label="Retry comments for PR #120"]\')');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('0 / 2')");
    assert.equal(
      await js("document.querySelector('.stack-changes-switch button[aria-pressed=true]').textContent"),
      'Combined'
    );
    assert.match(await js<string>("document.querySelector('.stack-comparison-range').textContent"), /main.*122/);
    // Membership changes keep saved code visible and offer an explicit update.
    const initialReads = await js<number>('window.combinedReads');
    await js(
      `(async()=>{const q=await window.electronAPI.workbenchQueue();window.stackSubject=q.items.find(i=>i.subject.kind==='stack').subject;window.originalMembers=window.stackSubject.members;window.originalEdges=window.stackSubject.edges;window.stackSubject.members=window.originalMembers.slice(0,2);window.stackSubject.edges=window.originalEdges.filter(e=>!e.child.endsWith('/122'));window.dispatchEvent(new Event('fixture-pr-read-change'));})()`
    );
    await wait("document.querySelector('.stack-changes-view')?.textContent.includes('Stack membership has changed')");
    assert.match(await js<string>("document.querySelector('.stack-comparison-range').textContent"), /122/);
    assert.equal(
      await js('window.combinedReads'),
      initialReads,
      'Discovery does not silently replace the displayed comparison'
    );
    await click('Update changes');
    await wait("document.querySelector('.stack-comparison-range')?.textContent.includes('through PR #121')");
    await wait("!document.querySelector('.stack-changes-view')?.textContent.includes('Stack membership has changed')");
    await js(
      "window.stackSubject.members=window.originalMembers;window.stackSubject.edges=window.originalEdges;window.dispatchEvent(new Event('fixture-pr-read-change'));void 0"
    );
    await wait("document.querySelector('.stack-changes-view')?.textContent.includes('Stack membership has changed')");
    await click('Update changes');
    await wait("document.querySelector('.stack-comparison-range')?.textContent.includes('through PR #122')");
    // Mapped tip thread is inline; older source threads stay in file discussion with source links.
    await wait("document.querySelectorAll('.combined-thread').length>=2");
    await js(
      "window.selectOption('[aria-label=\"Source PR discussions and review\"]','https://github.com/klang/engine/pull/121')"
    );
    await wait(
      "[...document.querySelectorAll('.stack-changes-view button')].some(b=>b.textContent.trim()==='Review PR #121'&&!b.disabled)"
    );
    await click('Review PR #121');
    await wait("!!document.querySelector('[role=dialog]')");
    assert.match(await js<string>("document.querySelector('[role=dialog]').textContent"), /121/);
    await js("document.querySelector('[role=dialog] textarea').focus()");
    await capture('review-target');
    await click('Cancel');
    await wait("![...document.querySelectorAll('[role=dialog]')].some(e=>e.checkVisibility())");
    await capture('desktop-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('desktop-dark');
    await js("document.documentElement.classList.remove('dark')");
    await js("document.querySelector('.commit-stream-file .changes-file-actions input[type=checkbox]').click()");
    await wait("document.querySelector('.changes-progress')?.textContent.includes('1 / 2')");
    const reads = await js<number>('window.combinedReads');
    await click('By PR');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('/ 15')");
    assert.match(await js<string>("document.querySelector('.changes-progress').textContent"), /0 \/ 15/);
    await wait(
      `document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file===${JSON.stringify(byPrFile)}`
    );
    await capture('by-pr');
    await click('Combined');
    await wait("document.querySelector('.changes-progress')?.textContent.includes('1 / 2')");
    assert.equal(await js('window.combinedReads'), reads, 'Switching mode reuses the pinned comparison');
    // Move to the second file; a refresh must not reset that selection.
    await js("document.querySelector('.commit-stream-file .changes-file-actions input[type=checkbox]').click()");
    await js(
      "window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')==='src/zz-review.ts').click()"
    );
    await wait("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/zz-review.ts'");
    await js('window.partialCombined=true;document.querySelector(\'[aria-label="Update combined changes"]\').click()');
    await wait("document.querySelector('.stack-changes-view')?.textContent.includes('Partial combined diff.')");
    await wait("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/zz-review.ts'");
    await capture('partial');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await js(
      "window.combinedFailure='PR #122 does not include the current commits from PR #121. Update its branch or review by PR.';document.querySelector('[aria-label=\"Update combined changes\"]').click()"
    );
    await wait(
      "document.querySelector('.stack-changes-view')?.textContent.includes('does not include the current commits')"
    );
    assert.ok(await js("!!document.querySelector('.commit-diff-stream')"), 'Failed refresh retains saved code');
    await capture('stale-parent');
    await click('Review by PR');
    await wait("document.querySelector('.stack-changes-switch button[aria-pressed=true]')?.textContent==='By PR'");
    await click('Combined');
    await wait("!!document.querySelector('.stack-comparison-context')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')==='src/worker.ts').click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/worker.ts'");
    await js(
      "[...document.querySelector('.commit-stream-row[data-active=true]').querySelectorAll('.changes-source button')].find(b=>b.textContent==='#120').click()"
    );
    await wait(
      "!document.querySelector('.stack-changes-switch') && document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file==='src/worker.ts'"
    );
    assert.match(
      await js<string>("document.querySelector('.pr-overview-heading').textContent"),
      /bounded command queue/
    );
    // Intermediate rename paths count the same threads that the file discussion shows.
    await js('window.selectOption(\'[aria-label="Review scope"]\',window.stackSubject.id)');
    await wait("!!document.querySelector('.stack-changes-switch')");
    await click('Combined');
    await js(
      `(async()=>{window.renameCombined=true;window.combinedFailure='';const {refreshDiscussion}=await import('/lib/review-discussion-cache.ts');await Promise.all(window.originalMembers.map(m=>refreshDiscussion(m.url)));document.querySelector('[aria-label="Update combined changes"]').click();})()`
    );
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('data-item-path')==='src/final.ts')");
    await wait(
      "window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')==='src/final.ts')?.querySelector('[title*=\"GitHub\"]')?.title.includes('3 GitHub comments')"
    );
    console.log('Combined stack browser checks passed');
    window.destroy();
    app.exit(0);
  } catch (e) {
    console.error(e);
    await capture('failure').catch(() => {});
    window.destroy();
    app.exit(1);
  }
});
