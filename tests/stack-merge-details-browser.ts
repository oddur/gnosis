import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 40)); }
    throw Error(`Timed out: ${code}`);
  };
  const viewport = async (width: number, height: number) => {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await wait(`innerWidth===${width} && innerHeight===${height}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready.then(() => undefined)');
    await new Promise(r => setTimeout(r, 250));
    const dir = path.resolve('.impeccable/review/stack-merge-details'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const row = (number: number) => `document.querySelector('.stack-overview [data-pr-url$="/${number}"]')`;
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewport(1280, 850);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      window.testStack=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>{
        const n=Number(value.url.split('/').pop());
        return {...value,checks:{state:'failure',total:1,passed:0},readiness:n===121?undefined:{...value.readiness,isDraft:n===122&&!window.optionalMode,mergeable:n===120?'CONFLICTING':'MERGEABLE',mergeState:n===120?'DIRTY':'CLEAN',reviewDecision:'APPROVED',behindBy:n===122?5:0}};
      });
      const readChecks=window.electronAPI.getPrChecks;
      window.electronAPI.getPrChecks=async(...args)=>{const r=await readChecks(...args);return {...r,checks:r.checks.slice(0,1).map(c=>({...c,name:'Build and test',required:!r.url.endsWith('/122'),status:'completed',conclusion:r.url.endsWith('/122')?'cancelled':'failure'}))};};
      window.actionReads=0;window.electronAPI.getPrActionState=async url=>{window.actionReads++;const m=window.testStack.subject.members.find(m=>m.url===url);return {...m,account:'oddur',state:'OPEN',isDraft:true,canChangeDraft:true,canWrite:true,archived:false,methods:['SQUASH'],defaultMethod:'SQUASH',mergeable:'MERGEABLE',mergeState:'CLEAN',stack:null};};
      window.electronAPI.performPrAction=async r=>{window.actionRequest=r;return {message:'Ready for review',status:'completed'};};
      window.electronAPI.rerunChecks=async r=>{window.rerunRequest=r;};
      window.publishStatus=async()=>{const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(window.testStack.subject.members.map(({url,headSha})=>({url,headSha}))));};
      await window.publishStatus();
    })()`);
    await js("document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("document.querySelectorAll('.stack-member-disclosure').length===3");
    await wait(`${row(122)}.textContent.includes('1 cancelled')`);
    assert.equal(await js('window.actionReads'), 0, 'Rendering rows must not load permissions');
    assert.equal(await js("document.querySelectorAll('.stack-merge-details').length"), 0, 'No duplicate status rail');
    assert.deepEqual(await js("[...document.querySelectorAll('.stack-overview-member')].map(row=>Number(row.dataset.prUrl.split('/').pop()))"), [122,121,120]);
    assert.match(await js<string>("document.querySelector('.pr-merge-status').textContent"), /Not ready to merge/);
    assert.equal(await js("document.querySelectorAll('.stack-member-disclosure[open]').length"), 0);
    assert.ok(await js("document.querySelector('[aria-label=\"Merge steps\"]').textContent.includes('Mark drafts ready for review')"));
    assert.ok(await js("document.querySelector('[aria-label=\"Merge steps\"]').textContent.includes('Resolve merge conflicts')"));
    assert.ok(await js("document.querySelector('.stack-checks-freshness').textContent.includes('Check results checked')"));
    assert.ok(await js(`${row(122)}.querySelector('[data-blocker-key="draft"] button').checkVisibility()`), 'Draft action is visible without expanding details');
    assert.ok(await js(`${row(120)}.querySelector('[data-blocker-key="conflicts"] button').checkVisibility()`), 'Conflict action is visible without expanding details');
    assert.ok(await js(`${row(120)}.querySelector('.stack-required-check-names').checkVisibility()`), 'Required failing checks are named in the row');
    assert.ok(await js(`!document.querySelector('.stack-merge-plan').textContent.includes('cancelled')`), 'Optional cancellation is not an action required to merge');
    await js("document.querySelector('[aria-label=\"Open PR #122: Mark drafts ready for review\"]').click()");
    await wait("!!document.querySelector('.stack-context') && !document.querySelector('.stack-overview')");
    assert.ok(await js("document.querySelector('.pr-overview-heading').textContent.includes('Enable adaptive')"));
    await js("document.querySelector('.stack-context').open=true;document.querySelector('.stack-context-heading button').click()");
    await wait("!!document.querySelector('.stack-overview')");
    await js('window.actionReads=0');
    await js("document.querySelectorAll('*').forEach(element=>{if(element.scrollTop)element.scrollTop=0});document.activeElement?.blur()");
    await wait("document.querySelector('.stack-merge-plan h2').getBoundingClientRect().top >= document.querySelector('.pr-overview-tabs').getBoundingClientRect().bottom");
    await capture('collapsed-light');
    await js(`${row(122)}.querySelector('summary').click();${row(120)}.querySelector('summary').click()`);
    assert.match(await js<string>(`${row(122)}.querySelector('[aria-label="Merge blockers for PR #122"]').textContent`), /draft/);
    assert.doesNotMatch(await js<string>(`${row(122)}.querySelector('[aria-label="Merge blockers for PR #122"]').textContent`), /cancelled|behind/);
    assert.match(await js<string>(`${row(122)}.textContent`), /Optional · Does not block merging/);
    // Direct draft action reuses the existing confirmation and revision checks.
    await js(`[...${row(122)}.querySelectorAll('button')].find(b=>b.textContent==='Mark ready for review…').click()`);
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Mark ready for review') && window.actionReads===1");
    assert.equal(await js('window.actionRequest'), undefined, 'Opening a confirmation never changes the PR');
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Cancel').click()");
    // Cancelled workflows use the explicit all-jobs action, failed jobs use failed-only.
    await js(`[...${row(122)}.querySelectorAll('button')].find(b=>b.textContent==='Re-run cancelled workflow…').click()`);
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Workflow run 9')");
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Re-run workflow').click()");
    await wait('window.rerunRequest');
    assert.equal(await js('window.rerunRequest.mode'), 'all');
    assert.equal(await js('window.rerunRequest.url'), 'https://github.com/klang/engine/pull/122');
    await js(`[...${row(120)}.querySelectorAll('button')].find(b=>b.textContent==='Re-run failed jobs…').click()`);
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Workflow run 9')");
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Re-run failed jobs').click()");
    await wait("window.rerunRequest.mode==='failed'");
    assert.equal(await js('window.rerunRequest.url'), 'https://github.com/klang/engine/pull/120');
    await js(`window.electronAPI.conflictResolution=async request=>{window.resolutionTarget=request.url;const m=window.testStack.subject.members.find(m=>m.url===request.url);return {session:{...m,id:'a'.repeat(64),account:'oddur',version:1,status:'editing',tree:'b'.repeat(40),files:[],preparation:'up-to-date'}}};[...${row(120)}.querySelectorAll('button')].find(b=>b.textContent==='Resolve conflicts…').click()`);
    await wait('window.resolutionTarget && document.querySelector(".conflict-heading")');
    assert.equal(await js('window.resolutionTarget'), 'https://github.com/klang/engine/pull/120');
    await js("[...document.querySelectorAll('.conflict-heading button')].find(b=>b.textContent==='Close').click()");
    await wait("!document.querySelector('.conflict-workspace')");
    await capture('expanded-light');
    await js("document.documentElement.classList.add('dark')"); await capture('expanded-dark');
    await js("document.querySelectorAll('.stack-member-disclosure[open]').forEach(d=>d.open=false)");
    await js("document.querySelectorAll('*').forEach(element=>{if(element.scrollTop)element.scrollTop=0})");
    await capture('collapsed-dark');
    for (const [w,h] of [[900,700],[640,700]]) { await viewport(w,h); await capture(`narrow-${w}`); assert.ok(await js('document.documentElement.scrollWidth<=innerWidth')); }
    await js("document.documentElement.style.zoom='2'"); await viewport(1100,1000); await capture('zoom-200'); assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await js("document.documentElement.style.zoom='';window.optionalMode=true;window.publishStatus()");
    await wait(`${row(122)}.textContent.includes('View check details')`);
    assert.equal(await js(`${row(122)}.querySelector('[aria-label="Merge blockers for PR #122"]')===null`), true);
    await js("window.realNow=Date.now;Date.now=()=>window.realNow()+6*60*1000;window.dispatchEvent(new Event('fixture-pr-read-change'));void 0");
    await wait(`${row(120)}.textContent.includes('Status needs refresh')`);
    assert.ok(await js(`!${row(120)}.textContent.includes('Build and test')`));
    await js("Date.now=window.realNow;window.dispatchEvent(new Event('fixture-pr-read-change'));void 0");
    await viewport(1280,850);
    await js(`${row(122)}.querySelector('.stack-check-result').click()`);
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Checks') || document.querySelector('[role=tab][data-active]')?.textContent.includes('Checks')");
    assert.ok(await js("document.querySelector('.pr-overview-heading').textContent.includes('Enable adaptive')"));
    await js("(()=>{const b=[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Summary');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()");
    await wait("!!document.querySelector('.stack-context')");
    await js("document.querySelector('.stack-context').open=true;document.querySelector('.stack-context-heading button').click()");
    await wait("!!document.querySelector('.stack-overview')");
    await js(`(()=>{
      window.optionalMode=false;
      window.bulkReady=[];window.failReady=true;
      window.electronAPI.performPrAction=async request=>{window.bulkReady.push(request);if(window.failReady)throw Error('Temporarily unavailable');return {status:'completed',message:'Ready for review'};};
      window.publishStatus();
    })()`);
    await wait("!!document.querySelector('.stack-mark-ready button')");
    await capture('mark-all-ready');
    await js("document.querySelector('.stack-mark-ready button').click();document.querySelector('.stack-mark-ready button').click()");
    await wait("document.querySelector('.stack-mark-ready [role=alert]')?.textContent.includes('Temporarily unavailable')");
    assert.equal(await js('window.bulkReady.length'), 1, 'Double clicks never duplicate writes');
    assert.equal(await js("document.querySelector('[role=dialog]')===null"), true, 'Bulk marking ready uses one click');
    await js("window.failReady=false;document.querySelector('.stack-mark-ready button').click()");
    await wait("document.querySelector('.stack-mark-ready [role=status]')?.textContent.includes('1 PR ready')");
    assert.equal(await js('window.bulkReady.length'), 2);
    assert.equal(await js('window.bulkReady[1].kind'), 'mark-ready');
    assert.equal(await js('window.bulkReady[1].url'), 'https://github.com/klang/engine/pull/122');
    console.log('Stack status passed: single hierarchy, separate blockers and optional checks, lazy actions, scoped reruns, stale state, responsive light/dark layouts.');
    app.exit(0);
  } catch (error) { console.error(error); await capture('failure'); console.log(await js('document.body.innerText')); app.exit(1); }
});
