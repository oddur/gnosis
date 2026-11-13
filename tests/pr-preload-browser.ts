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
    // The navigation predictor measured each prepared tab as a hit: content with no loading state first.
    const measured = await js<Partial<Record<string, { n: number; hit: number; cold: number }>>>('window.__gnosisPredict.summary().destinations');
    const records = JSON.stringify(await js('window.__gnosisPredict.records()'));
    assert.ok((measured['pr-open']?.n ?? 0) >= 1, `Opening the PR is measured: ${records}`);
    assert.ok((measured['pr-tab:changes']?.hit ?? 0) >= 1 && !measured['pr-tab:changes']?.cold, `Prepared Changes measures as a hit: ${records}`);
    assert.ok((measured['pr-tab:commits']?.hit ?? 0) >= 1 && !measured['pr-tab:commits']?.cold, `Prepared Commits measures as a hit: ${records}`);
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
    // Visited tabs stay mounted, so returning keeps the displayed revision and offers the update.
    await click('Summary');
    await click('Changes');
    await wait("[...document.querySelectorAll('.changes-notice')].some(e=>e.textContent.includes('New commits are available'))");
    assert.equal(
      await js("window.deepAll('*').some(e=>e.children.length===0&&e.textContent.includes('newlyPreparedRevision'))"),
      false,
      'Returning to Changes keeps the displayed revision'
    );
    await js("[...document.querySelectorAll('.changes-notice button')].find(b=>b.textContent.trim()==='Update changes').click()");
    await wait("window.deepAll('*').some(e=>e.children.length===0&&e.textContent.includes('newlyPreparedRevision'))");
    assert.deepEqual(
      await js('window.loadingFlashes'),
      [],
      'Reopening uses the prepared revision without a loading phase'
    );
    // Opening a PR the queue has not prepared warms its likely next tabs. Hold back queue preparation for a new
    // head of another PR: only predictions can prepare it. They read at foreground priority, labelled for main.
    await click('Review queue');
    await js(`(async()=>{
      const member=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.title.includes('Document worker lifecycle'));
      const head='9'.repeat(40);window.predictUrl=member.url;window.predictReads=[];window.committed=[];window.graphs=[];
      const api=window.electronAPI,load=api.workbenchQueue,changes=api.getPrChanges,commits=api.getPrCommits,file=api.getPrChangeFile;
      const moved=s=>({...s,metadata:{...s.metadata,headSha:head},fetchedAt:Date.now()});
      api.workbenchQueue=async(...args)=>{const q=await load(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>m.url===member.url?{...m,headSha:head}:m)}}))}};
      const held=(name,mode)=>{window.predictReads.push({name,mode:mode===true?'background':mode&&typeof mode==='object'?mode.predicted:'user'});return mode===true};
      api.getPrChanges=(url,refresh,options)=>url!==member.url?changes(url,refresh,options):held('changes',options?.predicted?{predicted:options.predicted}:!!options?.background)?new Promise(()=>{}):changes(url,refresh,options).then(moved);
      api.getPrCommits=(url,refresh,options)=>url!==member.url?commits(url,refresh,options):held('commits',options?.predicted?{predicted:options.predicted}:!!options?.background)?new Promise(()=>{}):commits(url,refresh,options).then(moved);
      api.getPrChangeFile=(request,mode)=>request.url!==member.url?file(request,mode):held('file',mode)?new Promise(()=>{}):file(request,mode);
      api.prOpenCommitted=(targets,label)=>{window.committed.push({urls:targets.map(t=>t.url),tiers:targets.map(t=>t.tier),label});return Promise.resolve()};
      api.predictWorkflowGraph=(targets,label)=>{window.graphs.push({urls:targets.map(t=>t.url),label});return Promise.resolve()};
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r=>setTimeout(r,100));
    })()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Document worker lifecycle')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await wait("window.predictReads.some(r=>r.name==='file'&&r.mode==='pr-tab:changes') && window.__gnosisPredict.idle()").catch(async (error: unknown) => {
      throw new Error(`${String(error)} ${JSON.stringify(await js("({reads:window.predictReads,wanted:window.__gnosisPredict.wanted(),records:window.__gnosisPredict.records(),visible:document.visibilityState,online:navigator.onLine,focus:document.hasFocus(),off:window.electronAPI.predictOff===true})"))}`);
    });
    await js('window.loadingFlashes=[];window.readsBeforeChanges=window.predictReads.length');
    await click('Changes');
    await wait("!!document.querySelector('.commit-stream-row[data-active=true] .changes-file-header')");
    assert.deepEqual(await js('window.loadingFlashes'), [], 'Changes of a just-opened PR shows without a loading phase');
    const reads = await js<{ name: string; mode: string }[]>('window.predictReads');
    for (const name of ['changes', 'commits', 'file'])
      assert.ok(reads.some((read) => read.name === name && read.mode === 'pr-tab:changes'), `The ${name} read carried predicted: ${JSON.stringify(reads)}`);
    assert.ok(reads.filter((read) => read.name === 'file' && read.mode === 'pr-tab:changes').length <= 3, 'At most three file bodies');
    const opening = reads.slice(await js<number>('window.readsBeforeChanges'));
    assert.ok(!opening.some((read) => read.mode === 'user'), `Opening Changes needed no read of its own: ${JSON.stringify(reads)}`);
    assert.deepEqual(await js('window.committed.map(c=>[c.urls,c.tiers])'), [[[await js<string>('window.predictUrl')], [0]]],
      'Threads and failing check details were requested once, for the open PR');
    const predicted = await js<Partial<Record<string, { hit: number; cold: number }>>>('window.__gnosisPredict.summary().destinations');
    assert.ok((predicted['pr-tab:changes']?.hit ?? 0) >= 2, `Predicted Changes measures as a hit: ${JSON.stringify(await js('window.__gnosisPredict.records()'))}`);
    await click('Commits');
    await wait("!!document.querySelector('.commit-detail-title')");
    assert.ok(!(await js<{ name: string; mode: string }[]>('window.predictReads')).some((read) => read.name === 'commits' && read.mode === 'user'),
      'The commit list was predicted too');

    // Queue rows send their PRs for preloading. Main validates full SHAs, so give the fixture's members real-looking ones.
    await click('Review queue');
    const pr = 'https://github.com/klang/engine/pull/151';
    const row = "[...document.querySelectorAll('[data-queue-id]')].find(r=>r.textContent.includes('Reduce allocations'))";
    await wait(`!!${row}`);
    await js(`(()=>{
      const hex=s=>{const h=Array.from(s,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');return h.length>=40?h.slice(-40):h.padEnd(40,'0')};
      const load=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async(...args)=>{const q=await load(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>({...m,headSha:hex(m.headSha),baseSha:hex(m.baseSha)}))}}))}};
      window.openPreloads=[];window.openIntents=[];
      window.electronAPI.prOpenPreload=targets=>{window.openPreloads.push(targets)};
      window.electronAPI.prOpenIntent=targets=>{window.openIntents.push(targets)};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await wait(`window.openPreloads.some(targets=>targets.some(t=>t.url===${JSON.stringify(pr)}&&/^[0-9a-f]{40}$/.test(t.headSha)))`);
    // Moving over a row and its children, then resting, sends one intent; leaving the list clears it.
    await js(`(async()=>{
      window.openIntents=[];
      const row=${row};
      for(const target of [row.querySelector('.queue-row-main'),row,row.querySelector('.queue-row-main')]){
        target.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await new Promise(r=>setTimeout(r,40));
      }
      await new Promise(r=>setTimeout(r,300));
    })()`);
    assert.deepEqual(
      await js('window.openIntents.map(targets=>targets&&targets.map(t=>t.url))'),
      [[pr]],
      'Resting on a row sends one intent'
    );
    await js(`${row}.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}))`);
    await wait('window.openIntents.length===2&&window.openIntents[1]===null');

    // A never-opened PR shows its saved status and comments while GitHub has not answered.
    await js(`(async()=>{
      const url=${JSON.stringify(pr)};
      const member=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.url===url);
      const saved={...(await window.electronAPI.getPrStatus(url,false)),labels:['preloaded'],mergeable:null,mergeableState:null,stale:true,headSha:member.headSha,checkedAt:Date.now()-60000};
      window.liveReads=[];
      window.electronAPI.getPrStatus=(u,force,options)=>options?.cachedOnly?Promise.resolve(u===url?saved:null):(window.liveReads.push('status'),new Promise(()=>{}));
      const stamp=new Date(Date.now()-60000).toISOString();
      const comment={id:'preloaded-1',body:'Preloaded discussion is ready.',author:{login:'maya',avatarUrl:''},createdAt:stamp,updatedAt:stamp,url:url+'#issuecomment-1'};
      window.electronAPI.getCachedReviewThreads=async u=>u===url?{headSha:member.headSha,baseSha:member.baseSha,checkedAt:Date.now()-60000,threads:[],feedback:{comments:[comment],reviews:[],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}}:undefined;
      window.electronAPI.getReviewThreads=()=>(window.liveReads.push('threads'),new Promise(()=>{}));
      // Native builds read saved copies first; preview fixtures opt in here.
      Object.assign(window.electronAPI,{githubSyncVersion:1,watchGitHub:()=>{},onGitHubSync:()=>()=>{}});
    })()`);
    await js(`${row}.querySelector('.queue-row-main').click()`);
    await wait(
      "[...document.querySelectorAll('.briefing-panel .stack-member p')].some(p=>p.textContent.includes('CI success · 1 approvals'))"
    );
    assert.equal(await js("!!document.querySelector('.briefing-panel .loading-indicator')"), false, 'Status opens without a loading state');
    assert.ok((await js<string[]>('window.liveReads')).includes('status'), 'GitHub had not answered');
    await click('Open PR overview');
    await click('Feedback');
    // GitHub reads never answer here, so the comment can only come from the saved copy.
    await wait("document.body.innerText.includes('Preloaded discussion is ready.')");

    // Settings › Preloading › Amount, on a PR with failing checks. Light warms one file body, no workflow graph and no
    // check details; Eager warms more files and asks main for the graph with failing job logs and stack members.
    const predictAt = async (amount: 'light' | 'eager') => {
      await js(`(async()=>{const prefs={...await window.electronAPI.loadPreferences(),preloadAmount:${JSON.stringify(amount)}};await window.electronAPI.savePreferences(prefs)})()`);
      // A fresh page: nothing is in memory, and the predictor starts with the saved amount.
      await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
      await waitForWorkbenchQueue(win.webContents);
      await js(`(async()=>{
        const member=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.title.includes('Reduce allocations'));
        const head='7'.repeat(40);window.predictReads=[];window.committed=[];window.graphs=[];
        const api=window.electronAPI,load=api.workbenchQueue,changes=api.getPrChanges,commits=api.getPrCommits,file=api.getPrChangeFile;
        const moved=s=>({...s,metadata:{...s.metadata,headSha:head},fetchedAt:Date.now()});
        api.workbenchQueue=async(...args)=>{const q=await load(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>m.url===member.url?{...m,headSha:head}:m)}}))}};
        const held=(name,mode)=>{window.predictReads.push({name,mode:mode===true?'background':mode&&typeof mode==='object'?mode.predicted:'user'});return mode===true};
        api.getPrChanges=(url,refresh,options)=>url!==member.url?changes(url,refresh,options):held('changes',options?.predicted?{predicted:options.predicted}:!!options?.background)?new Promise(()=>{}):changes(url,refresh,options).then(moved);
        api.getPrCommits=(url,refresh,options)=>url!==member.url?commits(url,refresh,options):held('commits',options?.predicted?{predicted:options.predicted}:!!options?.background)?new Promise(()=>{}):commits(url,refresh,options).then(moved);
        api.getPrChangeFile=(request,mode)=>request.url!==member.url?file(request,mode):held('file',mode)?new Promise(()=>{}):file(request,mode);
        api.prOpenCommitted=(targets,label)=>{window.committed.push({urls:targets.map(t=>t.url),label});return Promise.resolve()};
        api.predictWorkflowGraph=(targets,label)=>{window.graphs.push({urls:targets.map(t=>t.url),label});return Promise.resolve()};
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r=>setTimeout(r,100));
      })()`);
      await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Reduce allocations')).click()");
      await click('Open PR overview');
      await wait("!!document.querySelector('.pr-description')");
      await wait("window.predictReads.some(r=>r.name==='changes'&&r.mode==='pr-tab:changes') && window.committed.length>0 && window.__gnosisPredict.wanted().some(k=>k.startsWith('open:')&&k.includes('#a')&&!k.includes('#a0')) && window.__gnosisPredict.idle()");
      await new Promise((r) => setTimeout(r, 300));
      return {
        files: await js<number>("window.predictReads.filter(r=>r.name==='file'&&r.mode==='pr-tab:changes').length"),
        graphs: await js<number>('window.graphs.length'),
        wanted: await js<string[]>('window.__gnosisPredict.wanted()'),
      };
    };
    const light = await predictAt('light');
    const amounts = JSON.stringify({ light });
    assert.equal(light.files, 1, `Light reads one file body: ${amounts}`);
    assert.equal(light.graphs, 0, `Light warms no workflow graph: ${amounts}`);
    assert.ok(light.wanted.some((key) => key.startsWith('open:') && key.endsWith(':threads')), `Light asks main for threads, not check details: ${amounts}`);
    assert.ok(!light.wanted.some((key) => key.startsWith('graph:')));
    const eager = await predictAt('eager');
    const both = JSON.stringify({ light, eager });
    assert.ok(eager.files > light.files && eager.files <= 6, `Eager reads more file bodies, at most six: ${both}`);
    assert.ok(eager.wanted.some((key) => key.startsWith('changes:') && key.endsWith(':6')), both);
    assert.ok(!eager.wanted.some((key) => key.endsWith(':threads')), `Eager reads failing check details: ${both}`);
    assert.ok(eager.wanted.some((key) => key.startsWith('graph:') && key.endsWith(':eager')), `The graph read includes logs and members: ${both}`);
    assert.equal(eager.graphs, 1, `Eager warms the workflow graph once: ${both}`);
    await js("(async()=>{const prefs={...await window.electronAPI.loadPreferences(),preloadAmount:'normal'};await window.electronAPI.savePreferences(prefs)})()");

    console.log(
      'Revision preload browser checks passed: first tab open, all PR files, default commit, pinned active diff, prepared revision on reopen, row intent, saved status and comments, Light vs Eager amounts.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
