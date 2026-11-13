import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('renderer:', m));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 40));
  };
  const shots = path.resolve('.impeccable/review/explanation');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `window.starts=0;window.loads=0;const start=window.electronAPI.startReview,load=window.electronAPI.loadReview;window.electronAPI.startReview=(...a)=>{window.starts++;return start(...a)};window.electronAPI.loadReview=(...a)=>{window.loads++;return load(...a)};window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Explanation');
    await wait("!!document.querySelector('.explanation-empty')");
    assert.equal(await js('window.starts'), 0);
    assert.deepEqual(await js("[...document.querySelectorAll('.pr-overview-tabs button')].map(b=>b.textContent)"), [
      'Summary',
      'Changes',
      'Commits',
      'Checks',
      'Feedback',
      'Explanation',
      'Local notes',
    ]);
    await capture('empty');
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();
      window.largeExplanationMember=q.items.find(i=>i.subject.title.includes('Fix reconnect')).subject.members[0];
      window.originalFileCount=window.largeExplanationMember.changedFileCount;
      window.largeExplanationMember.changedFileCount=3237;
    })()`);
    await wait("document.querySelector('.explanation-status')?.textContent.includes('3,000-file limit')");
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate explanation').disabled"),
      true
    );
    assert.equal(await js('window.starts'), 0, 'Explain the limit before starting a job');
    await capture('large-pr-limit');
    await js('window.largeExplanationMember.changedFileCount=window.originalFileCount');
    await wait("!document.querySelector('.explanation-status')");
    await js(
      `(async()=>{const q=await window.electronAPI.workbenchQueue();q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'failed-first-review',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'failed',savedAt:new Date().toISOString()};})()`
    );
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Try generating it again')");
    assert.equal(
      await js("document.querySelector('.explanation-status').textContent.includes('saved version')"),
      false
    );
    await capture('failed-first-generation');
    // Generation shows its stages as Task Rows, built from the same events the main process reduces.
    await js(`(async()=>{
      window.originalListActivity=window.electronAPI.listActivity;
      window.originalActivityListener=window.electronAPI.onActivityChanged;
      window.originalLoadReview=window.electronAPI.loadReview;
      window.generationListeners=new Set();
      window.electronAPI.onActivityChanged=callback=>{window.generationListeners.add(callback);return ()=>window.generationListeners.delete(callback)};
      window.progressModel=await import('/lib/explanation-progress.ts');
      window.buildState=window.progressModel.initialExplanationProgress();
      window.generationTask={id:'review:first-generation',kind:'review',title:'#150 Fix reconnect handling after transport shutdown',reviewId:'first-generation',status:'running',detail:'Writing topics',progress:{completed:1,total:3},startedAt:new Date(Date.now()-102000).toISOString(),updatedAt:new Date().toISOString(),canCancel:true,canRetry:false};
      window.emit=(...events)=>{for(const e of events){window.buildState=window.progressModel.reduceExplanationProgress(window.buildState,e);if(e.type==='phase')window.generationTask.detail=e.phase}window.generationTask.steps=window.progressModel.explanationSteps(window.buildState);window.generationTask.updatedAt=new Date().toISOString();window.generationListeners.forEach(f=>f())};
      window.electronAPI.listActivity=async()=>[{...window.generationTask,reviewId:'different-review',detail:'Wrong review',steps:undefined},structuredClone(window.generationTask)];
      const q=await window.electronAPI.workbenchQueue();
      q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'first-generation',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'generating',savedAt:new Date().toISOString()};
    })()`);
    // A task without structured steps still renders rows from its single progress line.
    await wait(
      "[...document.querySelectorAll('.explanation-generating .task-row[data-status=running]')].some(r=>r.textContent.includes('Write topics')&&r.textContent.includes('1 of 3'))"
    );
    assert.equal(
      await js("document.querySelector('.explanation-generating').textContent.includes('Wrong review')"),
      false
    );
    assert.equal(await js("!!document.querySelector('.explanation-empty')"), false);
    assert.match(await js<string>("document.querySelector('.explanation-build-elapsed').textContent"), /^1m 4\ds$/);
    await js(`window.activityReads=0;window.activityWaiters=[];
      window.electronAPI.listActivity=()=>{window.activityReads++;return new Promise(resolve=>window.activityWaiters.push(()=>resolve([structuredClone(window.generationTask)])))};
      for(let i=0;i<100;i++)window.generationListeners.forEach(f=>f());void 0;`);
    const burstReads = await js<number>('window.activityReads');
    console.log('Generation activity requests for 100 synchronous updates:', burstReads);
    await js(
      // IPC returns a copy, so in-place edits below arrive as new tasks.
      `window.electronAPI.listActivity=async()=>{window.activityReads++;return [structuredClone(window.generationTask)]};window.activityWaiters.forEach(resolve=>resolve());void 0;`
    );
    const settledReads = await js<number>('window.activityReads');
    console.log('Generation activity requests including catch-up:', settledReads);
    if (process.env.GNOSIS_GENERATION_BENCH_ONLY) {
      app.exit(0);
      return;
    }

    assert.equal(burstReads, 1, 'Coalesce bursts while an activity request is in flight');
    assert.equal(settledReads, 2, 'One catch-up fetch receives the latest activity after a burst');
    // Structured events: context, the planned topics in order, then each topic's own status.
    await js(`window.emit(
      {type:'phase',phase:'Fetching PR data'},{type:'context',files:48,imports:12},{type:'phase',phase:'Building context'},
      {type:'phase',phase:'Planning review structure'},
      {type:'plan',topics:[{id:'slide-1',title:'Retry scheduling moves to the consumer'},{id:'slide-2',title:'Delivery counts no longer burn on transient errors'},{id:'slide-3',title:'Backoff configuration'},{id:'slide-4',title:'Metrics and alerts'},{id:'slide-5',title:'Tests'}]},
      {type:'phase',phase:'Writing topics',completed:0,total:5},
      {type:'topic',id:'slide-1',status:'writing'},{type:'topic',id:'slide-2',status:'writing'},{type:'topic',id:'slide-3',status:'writing'},
      {type:'topic',id:'slide-1',status:'done'},{type:'topic',id:'slide-2',status:'done'})`);
    await wait("document.querySelectorAll('.explanation-generating .task-subrows > .task-row').length===5");
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.explanation-generating .explanation-build-rows > .task-row')].map(r=>r.dataset.status+':'+r.querySelector('.task-row-title').textContent+':'+(r.querySelector(':scope > .task-row-line > .task-row-meta')?.textContent??''))"
      ),
      [
        'done:Read PR and context:48 files · 12 imports',
        'done:Planned 5 topics:',
        'running:Write topics:2 of 5',
        'queued:Check explanation text:',
        'queued:Write overview:',
        'queued:Render code:',
      ]
    );
    assert.equal(
      await js("[...document.querySelectorAll('.explanation-generating button')].filter(b=>b.textContent==='Read').length"),
      2,
      'Each finished topic can be read at once'
    );
    assert.equal(
      await js("document.querySelector('.explanation-build [role=status]').textContent"),
      'Writing topics',
      'Announce the phase, not each tick'
    );
    await capture('generating-topics');
    await js("document.documentElement.classList.add('dark')");
    await capture('generating-topics-dark');
    await js("document.documentElement.classList.remove('dark')");
    // A topic's own failure is inline on its row, with the real error, while the rest keep writing.
    await js(
      "window.emit({type:'topic',id:'slide-4',status:'failed',error:'Anthropic API: overloaded (529). The topic was not written.'})"
    );
    await wait(
      "document.querySelector('.explanation-generating .task-subrows .task-row[data-status=failed] .task-row-error')?.textContent.includes('overloaded (529)')"
    );
    assert.equal(
      await js("document.querySelector('.explanation-generating').textContent.includes('could not be completed')"),
      false
    );
    await capture('topic-failed');
    // The same rows are the explanation's expanded view in Activity, opened from the title bar capsule.
    await wait("document.querySelector('.activity-capsule')?.getAttribute('aria-label')?.includes('1 running')");
    await js("document.querySelector('.activity-capsule').click()");
    await wait("!!document.querySelector('.activity-drawer .activity-task .task-subrows .task-subrows .task-row[data-status=failed]')");
    assert.match(
      await js<string>("document.querySelector('.activity-drawer .activity-task').textContent"),
      /Explanation.*#150 Fix reconnect.*Write topics.*2 of 5 · 1 failed/
    );
    // One line with the PR number; the full title is the tooltip.
    assert.equal(
      await js("(()=>{const h=document.querySelector('.activity-drawer .activity-task h3');return h.title===h.textContent&&h.getClientRects().length===1&&getComputedStyle(h).whiteSpace==='nowrap'})()"),
      true
    );
    await capture('activity-open');
    await js("document.documentElement.classList.add('dark')");
    await capture('activity-open-dark');
    await js("document.documentElement.classList.remove('dark')");
    await js("document.querySelector('.activity-drawer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('.activity-drawer') && document.activeElement===document.querySelector('.activity-capsule')");
    // Lost progress keeps the last rows and offers a retry.
    await js(
      "window.electronAPI.listActivity=async()=>{throw Error('Activity unavailable')};window.generationListeners.forEach(f=>f())"
    );
    await wait("document.querySelector('.explanation-generating')?.textContent.includes('Progress unavailable')");
    await capture('generation-progress-unavailable');
    await js('window.electronAPI.listActivity=async()=>[structuredClone(window.generationTask)];void 0;');
    await click('Retry progress');
    await wait("!document.querySelector('.explanation-build-notice') && !!document.querySelector('.explanation-generating .task-row')");
    // A failed build keeps its rows: the failed stage and topic show their errors and Retry reuses written topics.
    await js(`(async()=>{
      window.firstState=window.buildState;window.firstTask=structuredClone(window.generationTask);
      window.buildState=window.progressModel.initialExplanationProgress();
      window.generationTask={...window.generationTask,id:'review:failed-build',reviewId:'failed-build',status:'running',canCancel:true,canRetry:false,startedAt:new Date(Date.now()-251000).toISOString()};
      window.emit({type:'phase',phase:'Building context'},{type:'plan',topics:[{id:'slide-1',title:'Retry scheduling moves to the consumer'},{id:'slide-2',title:'Metrics and alerts'}]},{type:'phase',phase:'Writing topics',completed:0,total:2},{type:'topic',id:'slide-1',status:'done'},{type:'topic',id:'slide-2',status:'failed',error:'Anthropic API: overloaded (529).'},{type:'finish',status:'failed',error:'1 of 2 topics saved. Retry this explanation to reuse completed topics. Anthropic API: overloaded (529).'});
      Object.assign(window.generationTask,{status:'failed',canCancel:false,canRetry:true,detail:'1 of 2 topics saved.',updatedAt:new Date().toISOString()});
      window.retries=[];window.originalActivityAction=window.electronAPI.activityAction;window.electronAPI.activityAction=async(id,action)=>{window.retries.push(id+':'+action)};
      const q=await window.electronAPI.workbenchQueue();
      q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'failed-build',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'failed',error:'1 of 2 topics saved.',savedAt:new Date().toISOString()};
    })()`);
    await wait("!!document.querySelector('.explanation-build[data-status=failed]')");
    assert.match(
      await js<string>("document.querySelector('.explanation-build-rows > .task-row[data-status=failed] > .task-row-error').textContent"),
      /1 of 2 topics saved/
    );
    assert.match(
      await js<string>("document.querySelector('.task-subrows .task-row[data-status=failed]').textContent"),
      /Metrics and alerts.*Retry.*overloaded \(529\)/
    );
    assert.equal(await js("document.querySelector('.explanation-build [role=status]')?.textContent"), 'Explanation failed at Write topics');
    await capture('failed-build');
    await js("document.documentElement.classList.add('dark')");
    await capture('failed-build-dark');
    await js("document.documentElement.classList.remove('dark')");
    await click('Retry Metrics and alerts. Topics already written are reused.');
    await wait("window.retries[0]==='review:failed-build:retry'");
    // Back to the running build.
    await js(`(async()=>{
      window.electronAPI.activityAction=window.originalActivityAction;
      window.buildState=window.firstState;window.generationTask=window.firstTask;
      const q=await window.electronAPI.workbenchQueue();
      q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'first-generation',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'generating',savedAt:new Date().toISOString()};
      window.emit();
    })()`);
    await wait("document.querySelectorAll('.explanation-generating .task-subrows .task-row[data-status=failed]').length===1 && !document.querySelector('.explanation-build[data-status=failed]')");
    // Read early: a finished topic opens in the reader; unwritten topics are placeholders.
    await js(`(async()=>{
      const base=await window.originalLoadReview('workbench-review');
      window.draftReads=0;
      window.draftReview=()=>({...structuredClone(base),reviewId:'first-generation',draft:{completed:2,total:3},slides:[
        {...structuredClone(base.slides[0]),id:'slide-1',slideNumber:1,title:'Retry scheduling moves to the consumer'},
        {id:'slide-2',slideNumber:2,title:'Delivery counts no longer burn on transient errors',slideType:'feature',narrative:'',reviewFocus:null,diffHunks:[],contextSnippets:[],affectedFiles:[],dependsOn:[],draftStatus:'writing'},
        {id:'slide-3',slideNumber:3,title:'Metrics and alerts',slideType:'feature',narrative:'',reviewFocus:null,diffHunks:[],contextSnippets:[],affectedFiles:[],dependsOn:[],draftStatus:'failed',draftError:'Anthropic API: overloaded (529).'}]});
      window.electronAPI.loadDraftReview=async id=>{window.draftReads++;return id==='first-generation'?window.draftReview():null};
      window.electronAPI.loadReview=async id=>id==='first-generation'?{...structuredClone(base),reviewId:'first-generation'}:window.originalLoadReview(id);
    })()`);
    await click('Read Retry scheduling moves to the consumer');
    await wait("!!document.querySelector('.explanation-reader') && document.querySelectorAll('.draft-topic').length===2");
    assert.match(await js<string>("document.querySelector('.explanation-status').textContent"), /Reading early/);
    // The error shows once, on its progress row; the reader keeps a quiet placeholder.
    assert.match(
      await js<string>("document.querySelector('.draft-topic[data-draft-status=failed]').textContent"),
      /This topic wasn’t written\.See progress/
    );
    assert.equal(await js("document.querySelector('.explanation-reader').textContent.includes('overloaded')"), false);
    await capture('read-early');
    await click('See progress');
    await wait("!!document.querySelector('.explanation-build-inline .task-row')");
    await capture('read-early-progress');
    await click('Hide progress');
    // The next finished topic refreshes the draft in place.
    const reads = await js<number>('window.draftReads');
    await js("window.emit({type:'topic',id:'slide-3',status:'done'})");
    await wait(`window.draftReads>${reads}`);
    // Completion swaps the saved explanation in, keeping the reader mounted.
    await js(`(async()=>{
      document.querySelector('.explanation-reader').dataset.kept='yes';
      window.emit({type:'finish',status:'completed'});
      window.generationTask.status='completed';
      const q=await window.electronAPI.workbenchQueue();
      q.items.find(i=>i.subject.title.includes('Fix reconnect')).review.status='completed';
    })()`);
    await wait("!document.querySelector('.draft-topic') && !document.querySelector('.explanation-status .loading-indicator')");
    assert.equal(await js("document.querySelector('.explanation-reader')?.dataset.kept"), 'yes', 'Updated in place');
    await capture('completed-in-place');
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();
      q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'failed-first-review',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'failed',savedAt:new Date().toISOString()};
    })()`);
    await wait("!document.querySelector('.explanation-generating')");
    await js(
      'window.electronAPI.listActivity=window.originalListActivity;window.electronAPI.onActivityChanged=window.originalActivityListener;window.electronAPI.loadReview=window.originalLoadReview;void 0;'
    );
    // Existing viewer drafts migrate to the shared per-PR store, with revision and source intact.
    await js(`(async()=>{
      window.savedReview=await window.electronAPI.loadReview('workbench-review');
      const r=window.savedReview, m=r.snapshot.subject.members[1], h=r.slides[0].diffHunks[0];
      localStorage.setItem('gnosis-drafts:'+r.snapshot.subject.id+':'+r.snapshot.fingerprint, JSON.stringify([{id:'legacy-comment',filePath:h.filePath,line:2,side:'RIGHT',body:'Keep the queue slot on cancellation.',hunkHeader:h.hunkHeader,codeSnippet:'const slot = await queue.acquire();',slideIndex:1}]));
      const read=window.electronAPI.getPrChanges;
      window.electronAPI.getPrChanges=async url=>{const s=await read(url);return url===m.url?{...s,files:[{path:'src/command-queue.ts',status:'modified',additions:6,deletions:1,changeId:'queue-v1',patch:h.hunkHeader+'\\n'+h.content}]}:s};
      await (await import('/lib/inspection-cache.ts')).inspectionData.readChanges(m,true);
      window.fill=(selector,value)=>{const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};
      window.reviewWrites=[];window.electronAPI.submitReview=async r=>{window.reviewWrites.push(r);return {reviewUrl:r.prUrl+'#review',droppedCommentCount:0}};
      window.chatRequests=[];window.electronAPI.onChatProgress=callback=>{window.chatProgress=callback};window.electronAPI.offChatProgress=()=>{window.chatProgress=undefined};
      window.electronAPI.sendSlideChat=request=>{window.chatRequests.push(request);return new Promise((resolve,reject)=>{window.chatFinish=resolve;window.chatFail=reject})};
      window.failDiffSave=false;const savePreferences=window.electronAPI.savePreferences;
      window.electronAPI.savePreferences=async prefs=>{await new Promise(r=>setTimeout(r,30));if(window.failDiffSave)throw Error('Disk full');return savePreferences(prefs)};

    })()`);
    await click('Review queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open AI explanation')");
    await click('Open AI explanation');
    await wait(
      "document.querySelector('.pr-overview-tabs [data-state=active]')?.textContent==='Explanation' && !!document.querySelector('.explanation-reader')"
    );
    assert.equal(await js("document.querySelectorAll('.pr-overview-switch').length"), 0);
    assert.equal(await js("[...document.querySelectorAll('h1')].filter(h=>h.checkVisibility()).length"), 1);
    assert.equal(await js('window.starts'), 0);
    await capture('overview');
    assert.equal(await js("document.querySelector('.explanation-reading-help').open"), false);
    await js("document.querySelector('.explanation-reading-help summary').click()");
    assert.match(
      await js<string>("document.querySelector('.explanation-reading-help').textContent"),
      /shared with Changes/
    );
    await capture('reading-help');
    await js("document.querySelector('.explanation-reading-help summary').click()");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.explanation-reader button')].filter(b=>b.textContent.trim()==='Ask a question').length"
      ),
      1
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('.explanation-section button')].some(b=>b.textContent.trim()==='Ask a question')"
      ),
      false
    );
    assert.equal(await js('document.querySelector(\'[aria-label="Previous section"]\').disabled'), true);
    await click('Next section');
    await wait("document.querySelector('[aria-label=\"Explanation section\"]').value==='1'");
    await click('Next section');
    await wait("document.querySelector('[aria-label=\"Explanation section\"]').value==='2'");
    await click('Previous section');
    await wait("document.querySelector('[aria-label=\"Explanation section\"]').value==='1'");
    await wait("!!document.querySelector('.review-narrative')");
    await wait("document.querySelector('.pending-comment-block')?.textContent.includes('Keep the queue slot')");
    // Interrupted output remains visibly incomplete and can retry without duplicating the question.
    await click('Ask a question');
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await js("window.fill('.chat-sheet textarea','What happens if cancellation interrupts the worker?')");
    await click('Send question');
    await wait('window.chatRequests.length===1');
    await js("window.chatProgress('A partial answer');window.chatFail(Error('Connection interrupted'))");
    await wait("document.querySelector('.chat-sheet [role=alert]')?.textContent.includes('Connection interrupted')");
    assert.equal(await js("document.querySelector('.chat-sheet')?.textContent.includes('A partial answer')"), true);
    await capture('chat-interrupted');
    await click('Retry answer');
    await wait('window.chatRequests.length===2');
    assert.deepEqual(await js('window.chatRequests[1].history'), []);
    await js("window.chatFinish('The queue slot is released in finally.')");
    await wait("document.querySelector('.chat-sheet')?.textContent.includes('The queue slot is released')");
    assert.equal(await js("!!document.querySelector('.chat-sheet [role=alert]')"), false);
    await click('Close chat');
    // Closing the interactive pane must retain an unfinished refinement.
    await click('Open interactive explanation');
    await wait('!!document.querySelector(\'[aria-label="Interactive explanation"]\')');
    await click('Details & refine');
    await js("window.fill('#explainer-refinement','Show cancellation during a batch — 日本語 🧪')");
    await click('Back to explanation');
    await click('Open interactive explanation');
    await click('Details & refine');
    assert.equal(
      await js("document.querySelector('#explainer-refinement').value"),
      'Show cancellation during a batch — 日本語 🧪'
    );
    await click('Back to explanation');
    // Rapid diff settings preserve each other; failures retain the choice and offer retry.
    await click('Diff appearance');
    await wait('!!document.querySelector(\'[aria-label="Diff layout"]\')');
    await js(
      `window.selectSetting=(label,value)=>{const el=document.querySelector('[aria-label="'+label+'"]');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))};window.selectSetting('Diff layout','split');window.selectSetting('Show surrounding lines','5');`
    );
    await wait(
      "window.electronAPI.loadPreferences().then(p=>p.diffLayout==='split'&&p.diffAppearance.contextLines===5)"
    );
    await js("window.failDiffSave=true;window.selectSetting('Show surrounding lines','10')");
    await wait(
      "document.querySelector('.workbench-review [role=alert]')?.textContent.includes('Could not save your diff settings')"
    );
    await js(
      "document.querySelector('[aria-label=\"Diff appearance\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await capture('diff-settings-save-error');
    await js('window.failDiffSave=false');
    await click('Retry saving diff settings');
    await wait(
      "window.electronAPI.loadPreferences().then(p=>p.diffLayout==='split'&&p.diffAppearance.contextLines===10)"
    );
    await wait("!document.querySelector('.workbench-review [role=alert]')");
    await click('Diff appearance');
    await js("window.selectSetting('Diff layout','unified');window.selectSetting('Show surrounding lines','3')");
    await wait(
      "window.electronAPI.loadPreferences().then(p=>p.diffLayout==='unified'&&p.diffAppearance.contextLines===3)"
    );
    assert.match(
      await js<string>("document.querySelector('.diff-layout-hint').textContent"),
      /Press d to switch, or u and s to choose/,
      'The layout option names its shortcuts'
    );
    await js(
      "document.querySelector('[aria-label=\"Diff appearance\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    // d switches the explanation's diffs and saves the choice as the menu does. The reader keeps their section.
    const pressKey = (key: string) =>
      js<boolean>(
        `(()=>{const e=new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()`
      );
    const reviewLayout = "document.querySelector('.workbench-review').dataset.diffLayout";
    await wait("!document.querySelector('[aria-label=\"Diff layout\"]')");
    await js('document.activeElement?.blur()');
    const readingSection = `(()=>{const c=document.querySelector('.explanation-document');const top=c.getBoundingClientRect().top+1;return [...c.querySelectorAll(':scope > [data-explanation-section]')].filter(s=>s.getBoundingClientRect().top<=top).at(-1)?.dataset.explanationSection})()`;
    await js("document.querySelector('.explanation-document').scrollTop=600");
    await new Promise((r) => setTimeout(r, 150));
    const sectionBefore = await js<string | undefined>(readingSection);
    assert.equal(await js(reviewLayout), 'unified');
    assert.equal(await pressKey('d'), true);
    await wait(`${reviewLayout}==='split'`);
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffLayout==='split')");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await js(readingSection), sectionBefore, 'Switching layout keeps the reading position');
    await pressKey('s');
    assert.equal(await js(reviewLayout), 'split', 's chooses split; it does not toggle');
    // The cheatsheet lists the toggle. Layout keys wait while it, or any other modal, is open.
    await pressKey('?');
    await wait(
      "document.querySelector('.shortcut-dialog')?.textContent.includes('Switch between split and unified diff')"
    );
    assert.equal(await pressKey('d'), false);
    assert.equal(await js(reviewLayout), 'split', 'Layout keys do nothing while a modal is open');
    await js(
      "document.querySelector('.shortcut-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.shortcut-dialog')");
    // Every open view follows the saved layout: Changes opens split, and u switches both back.
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await wait("document.querySelector('.pr-changes')?.dataset.diffLayout==='split'");
    await js('document.activeElement?.blur()');
    await pressKey('u');
    await wait("document.querySelector('.pr-changes').dataset.diffLayout==='unified'");
    await wait("window.electronAPI.loadPreferences().then(p=>p.diffLayout==='unified')");
    await click('Explanation');
    await wait(`${reviewLayout}==='unified'`);
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await js("document.querySelectorAll('.changes-member')[1]?.click()");
    // The tree groups paths by PR. Open the source PR's unique file.
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='command-queue.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='command-queue.ts').click()");
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('Keep the queue slot')");
    await click('Edit draft');
    await js("window.fill('.changes-draft-comment textarea','Release the queue slot even when cancellation throws.')");
    await click('Save draft');
    await click('Explanation');
    await wait("document.querySelector('.pending-comment-block')?.textContent.includes('cancellation throws')");
    // Feedback in either view targets the same PR, not the stack's first member.
    await js(
      `(async()=>{await window.selectOption('[aria-label="PR for review submission"]',window.savedReview.snapshot.subject.members[1].url);})()`
    );
    await click('Review PR #121 (1)');
    // Not [role=dialog]: Base UI toasts are non-modal dialogs, and the finished build's "Review ready"
    // toast can still be showing.
    await wait("!!document.querySelector('.review-submit-dialog')");
    assert.match(await js<string>("document.querySelector('.review-submit-dialog').textContent"), /cancellation throws/);
    await capture('shared-review');
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await js(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
      );
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await js(
      "document.querySelector('.review-submit-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.review-submit-dialog')");
    // Each section pairs its explanation and evidence in one scrolling document.
    assert.equal(await js("document.querySelectorAll('.explanation-section').length"), 3);
    assert.equal(
      await js(
        '!!document.querySelector(\'.review-bottom-nav,.explanation-inspect,.explanation-code-scroll,[aria-label="Review pane"]\')'
      ),
      false
    );
    assert.equal(await js("document.body.textContent.includes('Mark topic reviewed')"), false);
    await js(`window.selectOption('[aria-label="Explanation section"]','2')`);
    await wait('!!document.querySelector(\'[data-explanation-section="2"] .review-code\')');
    assert.equal(
      await js(
        `(()=>{const row=document.querySelector('[data-explanation-section="2"]');const text=row.querySelector('.explanation-section-text').getBoundingClientRect();const code=row.querySelector('.explanation-section-code').getBoundingClientRect();return code.left>=text.right&&Math.abs(code.top-text.top)<2})()`
      ),
      true
    );
    await js('document.querySelector(\'[data-explanation-section="2"] .review-file-viewed input\').click()');
    await wait("document.querySelector('.explanation-file-progress')?.textContent.startsWith('1/')");
    assert.equal(await js("document.querySelectorAll('.explanation-section').length"), 3);
    await capture('files-viewed');
    win.setContentSize(640, 800);
    await js(`window.selectOption('[aria-label="Explanation section"]','2')`);
    await wait(
      `(()=>{const row=document.querySelector('[data-explanation-section="2"]');return row.querySelector('.explanation-section-code').getBoundingClientRect().top>=row.querySelector('.explanation-section-text').getBoundingClientRect().bottom})()`
    );
    await capture('files-viewed-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setContentSize(1280, 800);
    await js(`window.selectOption('[aria-label="Explanation section"]','3')`);
    await wait('!!document.querySelector(\'[data-explanation-section="3"] .review-code\')');
    await wait("document.querySelector('.explanation-next-section').disabled");
    await js("document.querySelector('.explanation-document').scrollTop=99999");
    await capture('files-viewed-final');
    assert.match(await js<string>("document.querySelector('.explanation-ending').textContent"), /files still unviewed/);
    assert.deepEqual(await js('window.reviewWrites'), []);
    assert.equal(await js('window.starts'), 0);
    await js(`window.selectOption('[aria-label="Explanation section"]','1')`);
    // A focused picker owns typing and navigation; underlying review shortcuts stay idle.
    for (const key of ['j', 'k', 'ArrowLeft', 'ArrowRight']) {
      const original = await js(`document.querySelector('[aria-label="Explanation section"]').value`);
      await js(
        `(()=>{const trigger=document.querySelector('[aria-label="Explanation section"]');trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))})()`
      );
      if (key.length === 1) {
        await wait("document.activeElement?.getAttribute('data-slot')==='combobox-input'");
        assert.equal(await js("document.querySelector('[data-slot=combobox-input]').value"), key);
        await js(
          "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
        );
        await wait("!document.querySelector('[data-slot=combobox-content]')");
      }
      assert.equal(await js(`document.querySelector('[aria-label="Explanation section"]').value`), original, key);
    }
    const loads = await js('window.loads');
    const topic = await js('document.querySelector(\'[aria-label="Explanation section"]\').value');
    // Let the explicit smooth jump settle before testing an unchanged reading position.
    await js(`(async()=>{const element=document.querySelector('.explanation-document');let previous=-1,stable=0;
      for(let n=0;n<40&&stable<3;n++){await new Promise(r=>setTimeout(r,50));const top=element.scrollTop;stable=Math.abs(top-previous)<1?stable+1:0;previous=top;}})()`);
    const readingPosition = await js<number>("document.querySelector('.explanation-document').scrollTop");
    await click('Summary');
    const header = await js("document.querySelector('.pr-overview-heading h1').textContent");
    // Hidden walkthrough shortcuts must not consume navigation in another tab.
    await click('Explanation');
    assert.equal(await js('document.querySelector(\'[aria-label="Explanation section"]\').value'), topic);
    assert.equal(await js('window.loads'), loads);
    await wait(`Math.abs(document.querySelector('.explanation-document').scrollTop-${readingPosition})<2`);
    await js("document.activeElement.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
    assert.equal(await js("document.querySelector('.pr-overview-heading h1').textContent"), header);
    await js(`window.selectOption('[aria-label="Explanation section"]','1')`);
    await capture('desktop');
    win.setContentSize(1920, 900);
    await wait('innerWidth===1920');
    await capture('wide-toolbar');
    assert.equal(
      await js(`(()=>{
      const toolbar=document.querySelector('.explanation-reading-toolbar');
      const nav=toolbar.querySelector('.explanation-section-navigation').getBoundingClientRect();
      const controls=toolbar.querySelector('.explanation-diff-controls').getBoundingClientRect();
      return Math.abs((nav.top+nav.bottom)/2-(controls.top+controls.bottom)/2)<2;
    })()`),
      true,
      'Navigation and diff controls share a row at desktop width'
    );
    assert.equal(
      await js("document.querySelectorAll('.explanation-reading-toolbar .inline-explanations-toggle').length"),
      1
    );
    assert.equal(await js("document.querySelectorAll('.explanation-section .inline-explanations-toggle').length"), 0);
    win.setContentSize(1280, 800);
    await wait('innerWidth===1280');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setContentSize(1024, 800);
    await wait('innerWidth===1024');
    await js(`window.selectOption('[aria-label="Explanation section"]','1')`);
    await capture('laptop');
    win.setContentSize(640, 800);
    await wait('innerWidth===640');
    await js(`window.selectOption('[aria-label="Explanation section"]','1')`);
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setContentSize(1280, 800);
    win.webContents.setZoomFactor(2);
    await wait('innerWidth===640');
    await capture('zoomed');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.webContents.setZoomFactor(1);
    await wait('innerWidth===1280');
    // New commits never replace the saved walkthrough or silently re-anchor drafts.
    await js(`(async()=>{
      window.queue=structuredClone(await window.electronAPI.workbenchQueue());
      window.reviewHistory=structuredClone(await window.electronAPI.listReviews());
      window.queue.items.find(i=>i.subject.kind==='stack').subject.members[1].headSha='head-1-new';
      Object.assign(window.queue.items.find(i=>i.subject.kind==='stack').subject.members[0], {headSha:'new-head',baseSha:'new-base',baseBranch:'release'});
      window.electronAPI.workbenchQueue=async()=>structuredClone(window.queue);
      window.electronAPI.listReviews=async()=>structuredClone(window.reviewHistory);
      window.electronAPI.startReview=async request=>{
        window.starts++;window.lastStart=request;
        window.reviewHistory.unshift({...window.reviewHistory[0],id:'updated-review',status:'generating',savedAt:new Date().toISOString()});
        return {reviewId:'updated-review'};
      };
    })()`);
    await wait("document.querySelector('.explanation-status')?.textContent.includes('earlier version')");
    // Even without drafts, approval must target the displayed explanation, never newly discovered code.
    await js(
      `(async()=>{await window.selectOption('[aria-label="PR for review submission"]',window.savedReview.snapshot.subject.members[0].url);window.electronAPI.submitReview=async r=>{window.reviewWrites.push(r);throw Error('This PR changed. Open the latest changes before submitting.')}})()`
    );
    await click('Review PR #120');
    await wait("!!document.querySelector('.review-submit-dialog')");
    await js("document.querySelector('input[type=radio][value=APPROVE]').click()");
    await click('Submit review');
    await wait('window.reviewWrites.length===1');
    assert.deepEqual(
      await js(
        `(()=>{const r=window.reviewWrites[0], m=window.savedReview.snapshot.subject.members[0];return {actual:[r.prUrl,r.headSha,r.baseSha,r.baseBranch],expected:[m.url,m.headSha,m.baseSha,m.baseBranch],event:r.event,comments:r.comments}})()`
      ),
      await js(
        `(()=>{const m=window.savedReview.snapshot.subject.members[0], revision=[m.url,m.headSha,m.baseSha,m.baseBranch];return {actual:revision,expected:revision,event:'APPROVE',comments:[]}})()`
      )
    );
    await wait("document.querySelector('.review-submit-dialog')?.textContent.includes('This PR changed')");
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await js(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
      );
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await js(
      "document.querySelector('.review-submit-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.review-submit-dialog')");
    await js(
      `(async()=>{await window.selectOption('[aria-label="PR for review submission"]',window.savedReview.snapshot.subject.members[1].url);})()`
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.textContent.includes('Review PR #121')).disabled"
      ),
      false,
      'Drafts still belong to the displayed revision'
    );
    await click('Update explanation');
    await wait("!!document.querySelector('.explanation-setup-footer')");
    await js("[...document.querySelectorAll('.explanation-setup-dialog button')].find(b=>b.textContent.trim()==='Generate explanation').click()");
    await wait("!document.querySelector('.explanation-setup-dialog')");
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Generating explanation')");
    assert.equal(await js("!!document.querySelector('.review-narrative')"), true);
    await js("window.reviewHistory[0].status='failed'");
    await wait("document.querySelector('.explanation-status')?.textContent.includes('stopped before it finished. Your saved version is still available')");
    await capture('failed-update');
    await click('Retry generation');
    await wait("!!document.querySelector('.explanation-setup-footer')");
    await js("[...document.querySelectorAll('.explanation-setup-dialog button')].find(b=>b.textContent.trim()==='Generate explanation').click()");
    await wait("!document.querySelector('.explanation-setup-dialog')");
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Generating explanation')");
    await js(
      `window.nextReview=structuredClone(window.savedReview);window.nextReview.reviewId='updated-review';window.nextReview.summary='Updated explanation includes cancellation changes.';window.nextReview.snapshot.subject=window.queue.items.find(i=>i.subject.kind==='stack').subject;window.nextReview.snapshot.fingerprint=JSON.stringify({members:window.nextReview.snapshot.subject.members.map(m=>[m.url,m.baseRepo,m.baseBranch,m.baseSha,m.headRepo,m.headBranch,m.headSha,m.title,m.description,m.state,m.merged]),edges:window.nextReview.snapshot.subject.edges});window.reviewHistory[0]={...window.reviewHistory[0],status:'completed',snapshot:window.nextReview.snapshot};window.electronAPI.loadReview=async id=>{window.loads++;return id==='updated-review'?window.nextReview:window.savedReview};void 0;`
    );
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Updated explanation ready')");
    const priorTopic = await js('document.querySelector(\'[aria-label="Explanation section"]\').value');
    await capture('update-ready');
    await click('Open updated explanation');
    await wait("!document.querySelector('.explanation-status')");
    await js(
      `(async()=>{await window.selectOption('[aria-label="PR for review submission"]',window.savedReview.snapshot.subject.members[1].url);})()`
    );
    await wait("document.querySelector('.changes-notice')?.textContent.includes('earlier version')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.textContent.includes('Review PR #121')).disabled"
      ),
      true,
      'Old drafts block submission after explicitly opening the new revision'
    );
    assert.equal(await js(`document.querySelector('[aria-label="Explanation section"]').value`), priorTopic);
    await click('Review queue');
    // Notification destinations also work for historical PRs outside the queue.
    await js(
      `window.archived=structuredClone(window.savedReview);window.archived.reviewId='archived-review';window.archived.prUrl='https://github.com/klang/engine/pull/999';window.archived.prTitle='Archived standalone explanation';window.archived.snapshot.subject={...window.archived.snapshot.subject,id:window.archived.prUrl,kind:'pr',title:window.archived.prTitle,members:[{...window.archived.snapshot.subject.members[0],url:window.archived.prUrl,number:999,merged:true,state:'closed'}],edges:[]};window.electronAPI.loadReview=async id=>id==='archived-review'?window.archived:window.nextReview;window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'archived-review'}));`
    );
    await wait("document.querySelector('.pr-overview-heading h1')?.textContent==='Archived standalone explanation'");
    assert.equal(
      await js("document.querySelector('.pr-overview-tabs [data-state=active]').textContent"),
      'Explanation'
    );
    assert.match(await js<string>("document.querySelector('.pr-summary-context').textContent"), /Merged/);
    await capture('historical');
    await js(
      "document.activeElement.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!!document.querySelector('.queue-list')");
    // Empty generated explanations retain their overview and offer direct recovery.
    await js(`window.emptyReview=structuredClone(window.archived);window.emptyReview.reviewId='empty-review';window.emptyReview.slides=[];
      window.electronAPI.loadReview=async()=>window.emptyReview;
      window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'empty-review'}));void 0;`);
    await wait("!!document.querySelector('.explanation-no-topics')");
    assert.equal(await js("[...document.querySelectorAll('h1')].filter(h=>h.checkVisibility()).length"), 1);
    assert.match(await js<string>("document.querySelector('.explanation-no-topics').textContent"), /Generate again/);
    assert.equal(await js("document.querySelectorAll('.explanation-no-topics .reading-prose').length"), 1);
    win.setContentSize(640, 800);
    await wait('innerWidth===640');
    await capture('no-topics-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await click('Open Changes');
    await wait("document.querySelector('.pr-overview-tabs [data-state=active]')?.textContent==='Changes'");
    console.log('Explanation tab browser checks passed');
  } catch (e) {
    console.error(e);
    console.log(
      await js(
        "JSON.stringify({focus:document.activeElement?.outerHTML.slice(0,800),scroll:document.querySelector('.explanation-document')?.scrollTop,popup:document.querySelector('[data-slot=combobox-content]')?.outerHTML})"
      )
    );
    await capture('failure');
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
