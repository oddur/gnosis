import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * The stack's next fix on the stack overview (#445, items 20 and 23). A three-PR stack where two PRs conflict shows
 * one plan, bottom up, and moves to the next PR once the lowest is resolved. A merged parent shows "#120 merged.
 * #121 needs to move onto main." With GNOSIS_STACK_PLAN_SHOTS=1 it prints `STACKPLANSHOT <name> <base64 PNG>` lines,
 * light and dark, since Docker keeps no files.
 */
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 40)); }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const shots = async (name: string) => {
    if (!process.env.GNOSIS_STACK_PLAN_SHOTS) return;
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark', ${dark});document.activeElement?.blur()`);
      await js('document.fonts.ready.then(() => undefined)');
      // The theme change has finished when no transition is still running.
      await wait('document.getAnimations().length===0');
      console.log(`STACKPLANSHOT ${name}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
    }
    await js("document.documentElement.classList.remove('dark')");
  };
  const plan = "document.querySelector('.stack-conflict-plan')";
  /** Opens the fixture's stack as #120 ← #121 ← #122, with `merged` PRs merged, authored by you unless `own` is false. */
  const open = async (merged: number[], own = true) => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      const item=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack');
      const members=[120,121,122].map(n=>item.subject.members.find(m=>m.number===n));
      window.stackMembers=members;
      members.forEach((m,i)=>{Object.assign(m,{author:${own}?'oddur':'lena',headBranch:'stack-'+m.number,baseBranch:i?'stack-'+members[i-1].number:'main',merged:${JSON.stringify(merged)}.includes(m.number),state:${JSON.stringify(merged)}.includes(m.number)?'closed':'open'});});
      item.subject.edges=members.slice(1).map((m,i)=>({parent:members[i].url,child:m.url,evidence:'branch'}));
      window.conflicting=[];
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>{
        const n=Number(value.url.split('/').pop());const m=members.find(m=>m.number===n);const c=window.conflicting.includes(n);
        return {...value,readiness:{...value.readiness,state:m?.merged?'MERGED':'OPEN',baseBranch:m?.baseBranch??'main',mergeable:c?'CONFLICTING':'MERGEABLE',mergeState:c?'DIRTY':'CLEAN'}};
      });
      window.electronAPI.conflictResolution=async request=>{window.resolutionTarget=request.url;const m=members.find(m=>m.url===request.url);return {session:{...m,id:'a'.repeat(64),account:'oddur',version:1,status:'editing',tree:'b'.repeat(40),files:[],preparation:'up-to-date'}}};
      window.publishStatus=async()=>{const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(members.map(({url,headSha})=>({url,headSha}))));window.dispatchEvent(new Event('fixture-pr-read-change'));};
    })()`);
    await js("document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("document.querySelectorAll('.stack-overview-member').length===3");
  };
  try {
    // Two of three PRs conflict: one plan, and its action opens the lowest.
    await open([]);
    await js('window.conflicting=[121,122];window.publishStatus()');
    await wait(`${plan}?.textContent.includes('2 PRs in this stack conflict. Resolve from the bottom up.')`);
    assert.equal(await js(`${plan}.querySelectorAll('button,a').length`), 1, 'One action');
    assert.equal(await js<string>(`${plan}.querySelector('button').textContent`), 'Resolve conflicts in #121');
    await shots('two-conflicts');
    await js(`${plan}.querySelector('button').click()`);
    await wait('window.resolutionTarget && document.querySelector(".conflict-heading")');
    assert.equal(await js('window.resolutionTarget'), 'https://github.com/klang/engine/pull/121');
    await js("[...document.querySelectorAll('.conflict-heading button')].find(b=>b.textContent==='Close').click()");
    await wait("!document.querySelector('.conflict-workspace')");
    // #121 is resolved and pushed: the plan moves to #122.
    await js('window.conflicting=[122];window.publishStatus()');
    await wait(`${plan}?.textContent.includes('#122 has merge conflicts.')`);
    assert.equal(await js<string>(`${plan}.querySelector('button').textContent`), 'Resolve conflicts in #122');
    await js('window.conflicting=[];window.publishStatus()');
    await wait(`!${plan}`);

    // #120 merged and #121 still targets its branch: the row says so, and its action changes the base on GitHub.
    await open([120]);
    await js('window.publishStatus()');
    await wait(`${plan}?.textContent.includes('#120 merged. #121 needs to move onto main.')`);
    assert.equal(await js(`${plan}.querySelectorAll('button,a').length`), 1, 'One action');
    assert.match(await js<string>(`${plan}.querySelector('a').textContent`), /Change base of #121 on GitHub/);
    assert.equal(await js(`${plan}.querySelector('a').href`), 'https://github.com/klang/engine/pull/121');
    await shots('parent-merged');
    // It also conflicts: move first, then resolve on the new base.
    await js('window.conflicting=[121];window.publishStatus()');
    await wait(`${plan}?.dataset.step==='move' && document.querySelector('.stack-overview-member[data-pr-url$="/121"]')?.textContent.includes('Conflicts')`);
    assert.match(await js<string>(`${plan}.querySelector('a').textContent`), /Change base of #121 on GitHub/);
    assert.equal(await js(`${plan}.querySelectorAll('button').length`), 0, 'No Resolve before the move');
    // The base changed to main: the move is done, and the plan resolves the conflict there.
    await js("window.stackMembers[1].baseBranch='main';window.publishStatus()");
    await wait(`${plan}?.querySelector('button')?.textContent==='Resolve conflicts in #121'`);
    assert.equal(await js<string>(`${plan}.querySelector('p').textContent`), '#121 has merge conflicts.');
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 640, height: 700, deviceScaleFactor: 1, mobile: false });
    await wait('innerWidth===640');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'), 'No horizontal scroll at 640 px');
    await shots('moved-conflicts-narrow');
    // Someone else's stack: the plan says what it needs, with no action.
    await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    await open([120], false);
    await js('window.publishStatus()');
    await wait(`${plan}?.textContent.includes('#120 merged. #121 needs to move onto main.')`);
    assert.equal(await js(`${plan}.querySelectorAll('button,a').length`), 0, 'No action on PRs you do not own');
    console.log('Stack conflict plan passed: bottom-up plan, next PR after a push, parent-merged row, move before resolve, no action on PRs you do not own.');
    app.exit(0);
  } catch (error) { console.error(error); console.log(await js('document.body.innerText').catch(() => '')); app.exit(1); }
});
