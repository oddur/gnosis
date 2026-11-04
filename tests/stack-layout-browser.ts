import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({width:1024,height:700,useContentSize:true,show:true,webPreferences:{backgroundThrottling:false}});
  const js = <T=unknown>(code:string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code:string, attempts=200) => { for(let i=0;i<attempts;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`); };
  // CI desktops can clamp native windows below the requested dimensions.
  // Set Chromium's viewport explicitly so density assertions measure their named size.
  const viewport=async(width:number,height:number)=>{
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await wait(`innerWidth===${width} && innerHeight===${height}`);
  };
  const shots=path.resolve('.impeccable/review/stack-layout');fs.mkdirSync(shots,{recursive:true});
  const capture=async(name:string)=>{await js('document.fonts.ready');await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(shots,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const click = async (label:string) => { await wait(`[...document.querySelectorAll('button')].some(b=>b.checkVisibility()&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}))`); await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`); };
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited:', details.reason));
  try {
    // Cold Vite startup on CI is separate from the layout assertions below.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await viewport(1280,800);
    await wait("document.querySelectorAll('.queue-item').length===7", 1000);
    await js("document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("document.querySelectorAll('.stack-overview-member').length===3 && document.querySelector('.pr-merge-status').textContent.includes('checked just now')");
    await new Promise(r=>setTimeout(r,2000));
    await js(`(async()=>{window.realNow=Date.now;Date.now=()=>window.realNow()+6*60*1000;const {markFileViewed}=await import('/lib/file-view-progress.ts');await markFileViewed('fixture-status-clock',true);})()`);
    await new Promise(r=>setTimeout(r,100));
    const status=await js<{header:boolean;members:boolean}>("({header:document.querySelector('.pr-merge-status').textContent.includes('Status needs refresh'),members:[...document.querySelectorAll('.stack-member-status')].some(e=>e.textContent.includes('Status needs refresh'))})");
    console.log('Freshness:',status);
    assert.equal(status.header,status.members,'Header and member freshness must use the same clock between polling updates');
    await js("window.dispatchEvent(new Event('fixture-pr-read-change'))");
    await wait("document.querySelector('.pr-merge-status').textContent.includes('Status needs refresh') && [...document.querySelectorAll('.stack-member-status')].every(e=>e.textContent.includes('Status needs refresh'))");
    await capture('expired-status');
    await js('Date.now=window.realNow;window.dispatchEvent(new Event("fixture-pr-read-change"));void 0');
    await capture('consistent-status');
    // Match the small-stack case: a draft blocks merging, an optional failure does not.
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();const item=q.items.find(i=>i.subject.kind==='stack');
      window.originalMembers=item.subject.members;window.originalEdges=item.subject.edges;
      window.originalSignals=window.electronAPI.getQueueSignals;window.originalChecks=window.electronAPI.getPrChecks;
      item.subject.members=item.subject.members.slice(0,2).map((m,i)=>({...m,isDraft:i===1,headSha:String(i+7).repeat(40)}));
      item.subject.edges=item.subject.edges.filter(e=>item.subject.members.some(m=>m.url===e.parent)&&item.subject.members.some(m=>m.url===e.child));
      window.electronAPI.getQueueSignals=async requests=>(await window.originalSignals(requests)).map(s=>({...s,checkedAt:Date.now(),checks:{state:s.url.endsWith('/121')?'failure':'success',total:1,passed:s.url.endsWith('/121')?0:1},readiness:{...s.readiness,isDraft:s.url.endsWith('/121'),mergeState:s.url.endsWith('/121')?'BLOCKED':'CLEAN',reviewDecision:null,behindBy:4}}));
      window.electronAPI.getPrChecks=async(r,o)=>{const snapshot=await window.originalChecks(r,o);const failing=r.url.endsWith('/121');return {...snapshot,headSha:r.headSha,checkedAt:Date.now(),checks:[{...snapshot.checks[0],status:'completed',conclusion:failing?'failure':'success',required:false}]};};
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(item.subject.members.map(({url,headSha})=>({url,headSha}))));
      window.dispatchEvent(new Event('fixture-pr-read-change'));
    })()`);
    await wait("document.querySelectorAll('.stack-overview-member').length===2 && document.querySelector('.stack-overview').textContent.includes('Optional · Not a merge blocker')");
    assert.ok(await js("!!document.querySelector('.stack-merge-plan [data-step=draft]')"));
    assert.equal(await js("!!document.querySelector('.stack-merge-plan [data-step=checks]')"),false,'Optional check failures must not join the merge checklist');
    await js("document.documentElement.classList.add('dark')");await capture('two-pr-draft-optional-dark');
    await viewport(980,800);await capture('two-pr-laptop-dark');
    await js(`(async()=>{const q=await window.electronAPI.workbenchQueue();const item=q.items.find(i=>i.subject.kind==='stack');item.subject.members=window.originalMembers;item.subject.edges=window.originalEdges;window.electronAPI.getQueueSignals=window.originalSignals;window.electronAPI.getPrChecks=window.originalChecks;document.documentElement.classList.remove('dark');window.dispatchEvent(new Event('fixture-pr-read-change'));})()`);
    await viewport(1280,800);

    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();window.stackItem=q.items.find(i=>i.subject.kind==='stack');
      const item=window.stackItem;item.briefing=undefined;const base=item.subject.members[0];
      for(let i=3;i<10;i++){const member={...base,number:120+i,url:'https://github.com/klang/engine/pull/'+(120+i),title:'Clarify worker recovery and preserve command ordering',headBranch:'queue-'+i,baseBranch:'queue-'+(i-1)};item.subject.edges.push({parent:item.subject.members.at(-1).url,child:member.url,evidence:'branch'});item.subject.members.push(member);}
      window.briefingCalls=0;window.electronAPI.workbenchBriefing=async()=>{window.briefingCalls++;if(window.failBriefing)throw Error('offline');item.briefing={key:'test',status:'generating',updatedAt:new Date().toISOString()};};
      const readChecks=window.electronAPI.getPrChecks;window.electronAPI.getPrChecks=async(r,o)=>{const result=await readChecks(r,o);return {...result,checks:[{...result.checks[0],status:'completed',conclusion:'success'},{...result.checks[0],id:'skipped',status:'completed',conclusion:'skipped'}]};};
      // Measure the ordinary dependency list with no outstanding merge requirements.
      const readSignals=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await readSignals(requests)).map(s=>({...s,checks:{state:'success',total:1,passed:1},readiness:{...s.readiness,mergeState:'CLEAN'}}));
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
      publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(item.subject.members.map(({url,headSha})=>({url,headSha}))));
      window.dispatchEvent(new Event('fixture-pr-read-change'));
    })()`);
    await wait("document.querySelectorAll('.stack-overview-member').length===10 && document.querySelector('.stack-briefing-state')?.textContent.includes('No stack briefing yet')");
    assert.equal(await js("document.querySelector('.stack-merge-plan')===null"),true,'Ready stacks need no duplicate action checklist');
    assert.equal(await js('window.briefingCalls'),0,'Opening the overview must not start briefing generation');
    assert.equal(await js("[...document.querySelectorAll('.stack-overview-member')].some(e=>e.textContent.includes('klang/engine'))"),false,'Common repository belongs in stack header');
    const completeRows=()=>js<number>("(()=>{const bottom=document.querySelector('.pr-summary-content').getBoundingClientRect().bottom;return [...document.querySelectorAll('.stack-overview-member')].filter(e=>e.getBoundingClientRect().bottom<=bottom).length})()");
    console.log('Layout viewport:',await js('({width:innerWidth,height:innerHeight})'));await capture('ten-pr-desktop-light');assert.ok(await completeRows()>=5,'Five complete PR groups with inline status labels at1280×800');
    assert.ok(await js("[...document.querySelectorAll('.stack-overview-member')].every(row=>{const main=row.querySelector('.stack-member-main').getBoundingClientRect();const status=row.querySelector('.stack-member-signals').getBoundingClientRect();return status.top>=main.bottom && Math.abs(status.left-main.left)<2})"), 'Each PR keeps its status directly below its own identity');
    assert.ok(await js("[...document.querySelectorAll('.stack-cell-label')].every(label=>label.checkVisibility({visibilityProperty:true}))"), 'Status labels remain visible on desktop');
    assert.ok(await js("document.querySelector('.review-evidence').getBoundingClientRect().top >= document.querySelector('.stack-overview').getBoundingClientRect().bottom"), 'Detailed evidence follows the dependency list instead of displacing its rows');
    await viewport(900,600);await js("document.documentElement.classList.add('dark')");
    await capture('ten-pr-laptop-dark');assert.ok(await completeRows()>=2,'Two complete labeled PR groups at900×600');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    await click('Generate stack briefing');await wait("document.querySelector('.stack-briefing-state')?.textContent.includes('Generating stack briefing')");assert.equal(await js('window.briefingCalls'),1);await capture('generating');
    await js("window.stackItem.briefing={key:'test',status:'failed',error:'Provider unavailable',updatedAt:new Date().toISOString()};window.failBriefing=true;window.dispatchEvent(new Event('fixture-pr-read-change'))");
    await wait("document.querySelector('.stack-briefing-state')?.textContent.includes('Stack briefing failed')");await click('Retry briefing');await wait("document.querySelector('.stack-briefing-state [role=alert]')?.textContent.includes('Could not start')");await capture('failed');
    await js("window.stackItem.briefing={key:'test',status:'paused',pauseReason:'filter',updatedAt:new Date().toISOString()};window.failBriefing=false;window.dispatchEvent(new Event('fixture-pr-read-change'))");
    await wait("document.querySelector('.stack-briefing-state')?.textContent.includes('paused by your filters')");assert.equal(await js("document.querySelector('.stack-briefing-state [role=alert]')===null"),true,'A new briefing state clears the previous start error');await capture('paused');
    await click('Generate stack briefing');await wait("document.querySelector('.stack-briefing-state')?.textContent.includes('Generating stack briefing')");
    await js("window.stackItem.briefing=undefined;window.stackItem.subject.members[1].repo='klang/worker';window.dispatchEvent(new Event('fixture-pr-read-change'))");
    await wait("document.querySelector('.stack-overview-member[data-pr-url$=\"/121\"]').textContent.includes('klang/worker')");
    await viewport(640,600);await capture('mixed-repos-narrow');assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    console.log('Stack layout passed: coherent freshness, compact ten-PR overview, briefing generation/retry/pause, common and mixed repositories.');app.exit(0);
  }catch(error){console.error(error);await capture('failure');app.exit(1);}
});
