import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * A PR that is queued or saved as open and then read as merged or closed renders that state, in the open
 * PR view and when it opens from a stale queue. Merged and closed PRs leave the queue, so the opened copy
 * cannot learn of the change from the queue itself.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const state = () => js<string>("document.querySelector('.pr-state')?.textContent ?? ''");
  const openRow = async (title: string) => {
    await wait(`[...document.querySelectorAll('.queue-row-main')].some(b=>b.textContent.includes(${JSON.stringify(title)}))`);
    await js(`[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`);
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-state')");
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    // GitHub's lifecycle comes only from mocked status reads; `window.dropMerged` stands in for the main
    // process, whose queue leaves out merged and closed PRs.
    await js(`(async()=>{
      window.lifecycle={};window.dropMerged=false;
      const queue=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async(...args)=>{const q=await queue(...args);if(!window.dropMerged)return q;
        const open=i=>i.subject.members.some(m=>!window.lifecycle[m.url]||window.lifecycle[m.url].state==='open');
        return {...q,items:q.items.filter(open),revision:undefined};};
      const status=window.electronAPI.getPrStatus;
      window.electronAPI.getPrStatus=async(url,...rest)=>{const result=await status(url,...rest);return result&&window.lifecycle[url]?{...result,lifecycle:window.lifecycle[url]}:result;};
      // The header's actions (#542) read GitHub's state for the PR; every write is a mock.
      window.writes=[];window.opened=[];window.electronAPI.openExternal=async url=>{window.opened.push(url)};
      window.electronAPI.getPrActionState=async url=>{const q=await queue();const m=q.items.flatMap(i=>i.subject.members).find(m=>m.url===url);const life=window.lifecycle[url];
        return {...m,account:'oddur',id:'PR_'+m.number,checkedAt:Date.now(),state:life?(life.merged?'MERGED':'CLOSED'):'OPEN',headRepo:m.repo,repository:m.repo,headRepoCanWrite:true,headBranchExists:true,archived:false,canWrite:true,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'APPROVED',checkState:'SUCCESS',methods:['SQUASH'],defaultMethod:'SQUASH',autoMerge:null,canEnableAuto:false,canDisableAuto:false,canUpdateBranch:false,canChangeDraft:true,mergeQueue:false,inMergeQueue:false,stack:null};};
      window.electronAPI.performPrAction=async r=>{window.writes.push(r);return {status:'completed',message:r.kind==='reopen'?'Reopened.':'Deleted fix-0.'}};
    })()`);
    await openRow('Fix reconnect');
    assert.equal(await state(), 'Open');
    const url = await js<string>(
      "(async()=>(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.title.includes('Fix reconnect')).url)()"
    );

    // Merged from Gnosis, or on GitHub, while the view is open: the next status read updates it in place.
    await js(`window.lifecycle[${JSON.stringify(url)}]={state:'closed',merged:true,updatedAt:new Date(Date.now()+60000).toISOString()};window.dropMerged=true`);
    await js("window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed',{detail:[]}))");
    await wait("document.querySelector('.pr-state')?.textContent==='Merged'");
    // A merged PR offers Delete branch and Revert in the header (#542), never Merge.
    await wait("[...document.querySelectorAll('.pr-header-actions button')].some(b=>b.textContent==='Delete branch…'&&b.getAttribute('aria-disabled')!=='true')");
    assert.equal(await js("!!document.querySelector('[data-merge-action]')"), false, 'No merge action for a merged PR');
    assert.equal(await js("[...document.querySelectorAll('.pr-header-actions [role=switch]')].length"), 0, 'No draft or auto-merge toggles');
    await click('Revert…');
    await wait(`window.opened.includes(${JSON.stringify(url)})`);
    // Deleting the branch asks first.
    await click('Delete branch…');
    await wait("[...document.querySelectorAll('.pr-action-dialog button')].some(b=>b.textContent==='Delete branch'&&!b.disabled)");
    assert.equal(await js('window.writes.length'), 0, 'Nothing is deleted before the confirmation');
    await js("[...document.querySelectorAll('.pr-action-dialog button')].find(b=>b.textContent==='Delete branch').click()");
    await wait("window.writes.length===1&&!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes[0].kind'), 'delete-branch');

    // Back in the queue, the merged PR has left it.
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-state')");
    await wait(`![...document.querySelectorAll('.queue-row-main')].some(b=>b.textContent.includes('Fix reconnect'))`);

    // Opened fresh from a stale queue that still lists it as open: the status read wins.
    await js(`window.dropMerged=false;window.lifecycle[${JSON.stringify(url)}]={state:'closed',merged:false,updatedAt:new Date(Date.now()+120000).toISOString()}`);
    await js("window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed',{detail:[]}))");
    await openRow('Fix reconnect');
    await wait("document.querySelector('.pr-state')?.textContent==='Closed'");
    // A closed PR offers Reopen, which acts at once.
    assert.equal(await js("!!document.querySelector('[data-merge-action]')"), false);
    await wait("[...document.querySelectorAll('.pr-header-actions button')].some(b=>b.textContent==='Reopen'&&b.getAttribute('aria-disabled')!=='true')");
    await click('Reopen');
    await wait("window.writes.at(-1)?.kind==='reopen'");
    console.log('Merged PR state browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error('PR state:', await state().catch(() => ''));
    console.error(await js<string>("document.querySelector('.workbench-home')?.innerText.slice(0, 1500) ?? ''").catch(() => ''));
    app.exit(1);
  }
});
