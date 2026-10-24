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
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
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
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
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
      'Explanation',
    ]);
    await capture('empty');
    await js(
      `(async()=>{const q=await window.electronAPI.workbenchQueue();q.items.find(i=>i.subject.title.includes('Fix reconnect')).review={id:'failed-first-review',prUrl:'https://github.com/klang/engine/pull/150',prTitle:'Fix reconnect',author:'lena',status:'failed',savedAt:new Date().toISOString()};})()`
    );
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Try generating it again')");
    assert.equal(
      await js("document.querySelector('.explanation-status').textContent.includes('saved version')"),
      false
    );
    await capture('failed-first-generation');
    // Existing viewer drafts migrate to the shared per-PR store, with revision and source intact.
    await js(`(async()=>{
      window.savedReview=await window.electronAPI.loadReview('workbench-review');
      const r=window.savedReview, m=r.snapshot.subject.members[1], h=r.slides[0].diffHunks[0];
      localStorage.setItem('gnosis-drafts:'+r.snapshot.subject.id+':'+r.snapshot.fingerprint, JSON.stringify([{id:'legacy-comment',filePath:h.filePath,line:2,side:'RIGHT',body:'Keep the queue slot on cancellation.',hunkHeader:h.hunkHeader,codeSnippet:'const slot = await queue.acquire();',slideIndex:1}]));
      const read=window.electronAPI.getPrChanges;
      window.electronAPI.getPrChanges=async url=>{const s=await read(url);return url===m.url?{...s,files:[{path:'src/command-queue.ts',status:'modified',additions:6,deletions:1,changeId:'queue-v1',patch:h.hunkHeader+'\\n'+h.content}]}:s};
      window.fill=(selector,value)=>{const el=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};
      window.reviewWrites=[];window.electronAPI.submitReview=async r=>{window.reviewWrites.push(r);return {reviewUrl:r.prUrl+'#review',droppedCommentCount:0}};
    })()`);
    await click('Work queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open AI explanation')");
    await click('Open AI explanation');
    await wait(
      "document.querySelector('.pr-overview-tabs [data-state=active]')?.textContent==='Explanation' && !!document.querySelector('.workbench-overview')"
    );
    assert.equal(await js("document.querySelectorAll('.pr-overview-switch').length"), 0);
    assert.equal(await js("document.querySelectorAll('h1').length"), 1);
    assert.equal(await js('window.starts'), 0);
    await capture('overview');
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    await wait("document.querySelector('.pending-comment-block')?.textContent.includes('Keep the queue slot')");
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
      `(()=>{const el=document.querySelector('[aria-label="PR for review submission"]');el.value=window.savedReview.snapshot.subject.members[1].url;el.dispatchEvent(new Event('change',{bubbles:true}))})()`
    );
    await click('Review PR #121 (1)');
    await wait("!!document.querySelector('[role=dialog]')");
    assert.match(await js<string>("document.querySelector('[role=dialog]').textContent"), /cancellation throws/);
    await capture('shared-review');
    await js(
      "document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('[role=dialog]')");
    // Viewing files offers navigation without approving a topic or submitting feedback.
    assert.equal(await js("!!document.querySelector('.review-files-complete')"), false);
    await js("document.querySelector('.review-file-viewed input').click()");
    await wait("!!document.querySelector('.review-files-complete')");
    assert.match(await js<string>("document.querySelector('.review-files-complete').textContent"), /Adapt batches/);
    await capture('files-viewed');
    win.setSize(640, 800);
    await wait('!!document.querySelector(\'[aria-label="Review pane"]\')');
    await click('Code');
    await capture('files-viewed-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await wait('!document.querySelector(\'[aria-label="Review pane"]\')');
    await js("document.querySelector('.review-file-viewed input').click()");
    await wait("!document.querySelector('.review-files-complete')");
    await js("document.querySelector('.review-file-viewed input').click()");
    await click('Next topic');
    await wait("document.querySelector('[aria-label=\"Review topic\"]').value==='2'");
    await js(
      `(()=>{const el=document.querySelector('[aria-label="Review topic"]');el.value='3';el.dispatchEvent(new Event('change',{bubbles:true}))})()`
    );
    await wait("document.querySelector('[aria-label=\"Review topic\"]').value==='3'");
    await js("document.querySelectorAll('.review-file-viewed input:not(:checked)').forEach(el=>el.click())");
    await wait("!!document.querySelector('.review-files-complete')");
    await capture('files-viewed-final');
    await click('Back to overview');
    await wait("!!document.querySelector('.workbench-overview')");
    assert.deepEqual(await js('window.reviewWrites'), []);
    assert.equal(await js('window.starts'), 0);
    await click('Continue review');
    await wait("document.querySelector('[aria-label=\"Review topic\"]').value==='1'");
    const loads = await js('window.loads');
    const topic = await js('document.querySelector(\'[aria-label="Review topic"]\').value');
    await click('Summary');
    const header = await js("document.querySelector('.pr-overview-heading h1').textContent");
    // Hidden walkthrough shortcuts must not consume navigation in another tab.
    await click('Explanation');
    assert.equal(await js('document.querySelector(\'[aria-label="Review topic"]\').value'), topic);
    assert.equal(await js('window.loads'), loads);
    await js("document.activeElement.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
    assert.equal(await js("document.querySelector('.pr-overview-heading h1').textContent"), header);
    await capture('desktop');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(1024, 800);
    await capture('laptop');
    win.setSize(640, 800);
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    // New commits never replace the saved walkthrough or silently re-anchor drafts.
    await js(`(async()=>{
      window.queue=structuredClone(await window.electronAPI.workbenchQueue());
      window.reviewHistory=structuredClone(await window.electronAPI.listReviews());
      window.queue.items.find(i=>i.subject.kind==='stack').subject.members[1].headSha='head-1-new';
      window.electronAPI.workbenchQueue=async()=>structuredClone(window.queue);
      window.electronAPI.listReviews=async()=>structuredClone(window.reviewHistory);
      window.electronAPI.startReview=async request=>{
        window.starts++;window.lastStart=request;
        window.reviewHistory.unshift({...window.reviewHistory[0],id:'updated-review',status:'generating',savedAt:new Date().toISOString()});
        return {reviewId:'updated-review'};
      };
    })()`);
    await wait("document.querySelector('.explanation-status')?.textContent.includes('earlier version')");
    await wait("document.querySelector('.changes-notice')?.textContent.includes('earlier version')");
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Review PR #121')).disabled"),
      true
    );
    await click('Update explanation');
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Generating explanation')");
    assert.equal(await js("!!document.querySelector('.review-narrative')"), true);
    await js("window.reviewHistory[0].status='failed'");
    await wait("document.querySelector('.explanation-status')?.textContent.includes('could not be completed')");
    await capture('failed-update');
    await click('Retry generation');
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Generating explanation')");
    await js(
      `window.nextReview=structuredClone(window.savedReview);window.nextReview.reviewId='updated-review';window.nextReview.summary='Updated explanation includes cancellation changes.';window.nextReview.snapshot.subject=window.queue.items.find(i=>i.subject.kind==='stack').subject;window.nextReview.snapshot.fingerprint=JSON.stringify({members:window.nextReview.snapshot.subject.members.map(m=>[m.url,m.baseRepo,m.baseBranch,m.baseSha,m.headRepo,m.headBranch,m.headSha,m.title,m.description,m.state,m.merged]),edges:window.nextReview.snapshot.subject.edges});window.reviewHistory[0]={...window.reviewHistory[0],status:'completed',snapshot:window.nextReview.snapshot};window.electronAPI.loadReview=async id=>{window.loads++;return id==='updated-review'?window.nextReview:window.savedReview};void 0;`
    );
    await wait("document.querySelector('.explanation-status')?.textContent.includes('Updated explanation ready')");
    const priorTopic = await js(`document.querySelector('[aria-label="Review topic"]').value`);
    await capture('update-ready');
    await click('Open updated explanation');
    await wait("!document.querySelector('.explanation-status')");
    assert.equal(await js(`document.querySelector('[aria-label="Review topic"]').value`), priorTopic);
    await click('Work queue');
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
    console.log('Explanation tab browser checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
