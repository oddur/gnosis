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
      `(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const press = async (keyCode: string) => {
    win.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await new Promise((r) => setTimeout(r, 120));
  };
  const currentStep = () => js<string>("document.querySelector('.step-list [aria-current=step]')?.dataset.step ?? ''");
  const shots = path.resolve('.impeccable/review/pr-actions');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    // All writes are mocks; this suite cannot change a real GitHub PR.
    await js(`(async()=>{
      window.writes=[];window.actionTasks=[];window.nativeStack=false;window.failAction=false;window.denyWrite=false;window.changedHead=false;window.conflicts=false;
      const q=await window.electronAPI.workbenchQueue();window.queue=q;
      const originalActivity=window.electronAPI.listActivity;window.electronAPI.listActivity=async()=>[...await originalActivity(),...window.actionTasks];
      window.actionState=url=>{const member=q.items.flatMap(i=>i.subject.members).find(m=>m.url===url);if(!member)throw Error('Unknown mock PR');const stack=q.items.find(i=>i.subject.members.some(m=>m.url===url)&&i.subject.kind==='stack');return {...member,account:'oddur',id:'PR_'+member.number,checkedAt:Date.now(),state:member.merged?'MERGED':'OPEN',headSha:window.changedHead?'changed-head':member.headSha,headRepo:member.repo,repository:member.repo,archived:false,canWrite:!window.denyWrite,mergeable:window.conflicts?'CONFLICTING':'MERGEABLE',mergeState:window.conflicts?'DIRTY':'CLEAN',methods:['SQUASH','MERGE','REBASE'],defaultMethod:'SQUASH',autoMerge:member.autoMerge?.method??null,canEnableAuto:true,canDisableAuto:true,canUpdateBranch:true,canChangeDraft:!window.denyWrite,mergeQueue:false,inMergeQueue:false,stack:stack&&window.nativeStack?{number:8,baseBranch:'main',complete:true,mergeQueue:false,members:stack.subject.members.map(m=>({...m,state:'OPEN'}))}:null};};
      const originalStatus=window.electronAPI.getPrStatus;
      window.electronAPI.getPrStatus=async(...args)=>{const result=await originalStatus(...args);const state=window.actionState(args[0]);return {...result,isDraft:state.isDraft,signals:{...result.signals,checkedAt:Date.now(),readiness:{...result.signals.readiness,isDraft:state.isDraft,mergeable:state.mergeable,mergeState:state.mergeState}}};};
      window.electronAPI.getPrActionState=async(url)=>window.actionState(url);
      window.electronAPI.getStackMergePlan=async urls=>{const members=urls.map(window.actionState);return {target:members.at(-1),members,baseBranch:members[0].baseBranch,methods:['SQUASH','MERGE','REBASE'],mergeQueue:false,createStack:!window.nativeStack};};
      window.electronAPI.performPrAction=async request=>{window.writes.push(request);if(window.failAction)throw Error('This PR changed since confirmation. Refresh the action and inspect the new revision.');await new Promise(r=>setTimeout(r,120));const m=q.items.flatMap(i=>i.subject.members).find(m=>m.url===request.url);if(request.kind==='enable-auto')m.autoMerge={method:request.method};if(request.kind==='disable-auto')m.autoMerge=null;if(request.kind==='convert-draft')m.isDraft=true;if(request.kind==='mark-ready')m.isDraft=false;
        if(request.kind==='merge'&&request.revisions.length>1){window.actionTasks.push({id:'merge-operation',kind:'pr-action',title:'Merging 3 PRs',detail:'GitHub is processing the merge.',status:'running',updatedAt:new Date().toISOString(),canCancel:false,canRetry:false});return {status:'pending',message:'GitHub is processing the merge. Follow its progress in Activity.'};}
        return {status:'completed',message:request.kind==='merge'?'Merged on GitHub.':'GitHub action completed.'};};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("document.querySelector('.pr-action-controls button')?.disabled===false");
    assert.ok(
      await js(
        `[...document.querySelectorAll('.pr-action-controls button')].filter(b=>b.getBoundingClientRect().width>0).length>=6`
      ),
      'PR actions are directly visible without opening a menu'
    );
    await capture('summary-light-1280');
    await click('Merge PR…');
    await wait('!!document.querySelector(\'[aria-label="Merge method"]\')');
    assert.match(await js<string>("document.querySelector('.pr-action-dialog').textContent"), /1 PR → main/);
    assert.equal(await js("!!document.querySelector('.step-card')"), false, 'A single PR merge keeps one confirmation');
    await capture('merge-light-1280');
    await js('window.badgeLinks=[];void(window.electronAPI.openExternal=async url=>{window.badgeLinks.push(url)})');
    for (const kind of ['branch', 'commit']) {
      await js(
        `document.querySelector('.pr-action-members .entity-badge-${kind}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:300}))`
      );
      await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Open on GitHub')");
      await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Open on GitHub').click()");
      await wait(`window.badgeLinks.length===${kind === 'branch' ? 1 : 2}`);
      assert.equal(
        await js("!!document.querySelector('.pr-action-dialog')"),
        true,
        'Badge navigation does not submit or close confirmation'
      );
    }
    assert.match(await js<string>('window.badgeLinks[0]'), /^https:\/\/github.com\/klang\/engine\/tree\//);
    assert.match(await js<string>('window.badgeLinks[1]'), /^https:\/\/github.com\/klang\/engine\/commit\//);

    await click('Cancel');
    assert.equal(await js('window.writes.length'), 0);
    await click('Convert to draft…');
    await wait("document.querySelector('.pr-action-members')?.children.length===1");
    assert.equal(await js('!!document.querySelector(\'[aria-label="Merge method"]\')'), false);
    await capture('convert-draft-light-1280');
    await click('Convert to draft');
    await wait("!document.querySelector('.pr-action-dialog')");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Mark ready for review…')");
    assert.equal(await js('window.writes.at(-1).kind'), 'convert-draft');
    assert.equal(await js("document.querySelector('.pr-action-controls button').disabled"), true);
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Draft PR')");
    await capture('draft-summary-light-1280');
    await click('Mark ready for review…');
    await wait("document.querySelector('.pr-action-members')?.children.length===1");
    await capture('mark-ready-light-1280');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(640, 800);
    await capture('mark-ready-dark-640');
    await click('Mark ready for review');
    await wait("!document.querySelector('.pr-action-dialog')");
    await wait("document.querySelector('.pr-action-controls button')?.disabled===false");
    assert.equal(await js('window.writes.at(-1).kind'), 'mark-ready');
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await js('window.conflicts=true');
    await click('Refresh PR actions');
    await wait("[...document.querySelectorAll('button')].find(b=>b.textContent==='Update with rebase…').disabled");
    assert.match(await js<string>("document.querySelector('.pr-actions').textContent"), /Resolve conflicts/);
    await capture('conflicts-light-1280');
    await js('window.conflicts=false');
    await click('Refresh PR actions');
    await wait("![...document.querySelectorAll('button')].find(b=>b.textContent==='Update with rebase…').disabled");
    await js('window.conflicts=true');
    await js(
      "[...document.querySelectorAll('.pr-action-controls button')].find(e=>e.textContent==='Update with rebase…').click()"
    );
    await wait("document.querySelector('.pr-action-dialog')?.textContent.includes('Resolve merge conflicts')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.pr-action-dialog button')].find(b=>b.textContent==='Update branch with rebase').disabled"
      ),
      true
    );
    await capture('conflicts-confirmation-light-1280');
    await click('Cancel');
    await js('window.conflicts=false');
    await click('Refresh PR actions');
    await click('Enable auto-merge…');
    await wait('!!document.querySelector(\'[aria-label="Merge method"]\')');
    await click('Enable auto-merge');
    await wait("!document.querySelector('.pr-action-dialog')");
    await wait("document.querySelector('.pr-action-note')?.textContent.includes('Auto-merge is on')");
    assert.equal(await js('window.writes.at(-1).kind'), 'enable-auto');
    await click('Disable auto-merge…');
    await wait("document.querySelector('.pr-action-members')?.textContent.includes('#150')");
    await click('Disable auto-merge');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.at(-1).kind'), 'disable-auto');
    await capture('update-menu-light-1280');
    await js(
      "[...document.querySelectorAll('.pr-action-controls button')].find(e=>e.textContent==='Update with rebase…').click()"
    );
    await wait("!!document.querySelector('.pr-action-members')");
    assert.match(await js<string>("document.querySelector('.pr-action-dialog').textContent"), /main → fix-0/);
    await capture('rebase-light-1280');
    await click('Update branch with rebase');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.at(-1).kind'), 'update-rebase');
    assert.equal(await js('window.writes.at(-1).revisions[0].headSha'), 'head-0');
    await js(
      "[...document.querySelectorAll('.pr-action-controls button')].find(e=>e.textContent==='Update with merge commit…').click()"
    );
    await wait("!!document.querySelector('.pr-action-members')");
    await click('Update branch with merge commit');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.at(-1).kind'), 'update-merge');
    await click('Merge PR…');
    await wait('!!document.querySelector(\'[aria-label="Merge method"]\')');
    await js("window.selectOption('[aria-label=\"Merge method\"]','REBASE')");
    assert.equal(await js("!!document.querySelector('.pr-action-message')"), false);
    await js("window.selectOption('[aria-label=\"Merge method\"]','SQUASH');window.failAction=true");
    await click('Merge pull request');
    await wait("document.querySelector('[role=alert]')?.textContent.includes('changed since confirmation')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.pr-action-dialog button')].find(b=>b.textContent==='Merge pull request').disabled"
      ),
      true
    );
    await capture('stale-confirmation-1280');
    await click('Cancel');
    await js('window.failAction=false;window.denyWrite=true');
    await click('Refresh PR actions');
    await wait("document.querySelector('.pr-action-controls button').disabled");
    assert.equal(await js("window.writes.filter(w=>w.kind==='merge').length"), 1);
    await click('Review queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open stack overview');
    await js('window.denyWrite=false');
    await click('Merge whole stack…');
    await wait("document.querySelector('.pr-action-members')?.children.length===3");
    // The plan is visible before anything runs: three steps, the first current, nothing written.
    assert.match(
      await js<string>("document.querySelector('.pr-action-dialog').textContent"),
      /Create GitHub stack and merge/
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.pr-action-steps .step-list li')].map(li=>li.dataset.step)"),
      ['review', 'method', 'merge']
    );
    assert.equal(await currentStep(), 'review');
    assert.equal(await js("document.querySelector('.pr-action-steps .step-card-count').textContent.trim()"), '1 / 3');
    assert.match(
      await js<string>("document.querySelector('.step-list [data-step=merge]').textContent"),
      /Create a GitHub stack and merge into main/
    );
    assert.equal(
      await js("[...document.querySelectorAll('.pr-action-steps button')].some(b=>b.textContent==='Skip')"),
      false,
      'No merge step is optional'
    );
    const stackWrites = await js<number>('window.writes.length');
    await wait("document.activeElement?.classList.contains('step-card-body')");
    await capture('create-stack-light-1280');
    // Enter continues ordinary steps.
    await press('Enter');
    await wait("document.querySelector('.step-list [aria-current=step]')?.dataset.step==='method'");
    assert.ok(await js('!!document.querySelector(\'[aria-label="Merge method"]\')'));
    assert.match(
      await js<string>("document.querySelector('.pr-action-steps [role=status][aria-live]').textContent"),
      /Step 2 of 3/
    );
    await wait("document.activeElement?.classList.contains('step-card-body')");
    await press('Enter');
    await wait("document.querySelector('.step-list [aria-current=step]')?.dataset.step==='merge'");
    await wait("document.activeElement?.classList.contains('step-card-body')");
    assert.match(await js<string>("document.querySelector('.pr-action-confirm').textContent"), /two GitHub requests/);
    await capture('create-stack-confirm-light-1280');
    // The point of no return needs its own button; Enter on the card does not merge.
    await press('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await js('window.writes.length'), stackWrites, 'Enter alone never merges');
    assert.equal(await currentStep(), 'merge');
    // A failure stays inside its step and is not retried automatically.
    await js('window.failAction=true');
    await click('Create GitHub stack and merge');
    await wait("document.querySelector('.step-list [data-step=merge][data-status=failed] [role=alert]')");
    assert.match(
      await js<string>("document.querySelector('.step-list [data-step=merge] [role=alert]').textContent"),
      /changed since confirmation/
    );
    assert.equal(await js("document.querySelector('.step-list [data-step=review]').dataset.status"), 'done');
    assert.equal(await js("!!document.querySelector('.pr-action-dialog > .pr-action-error')"), false);
    assert.ok(await js("document.activeElement?.closest('.step-list-error')"), 'Focus moves to the failure');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await js('window.writes.length'), stackWrites + 1, 'A failed merge is never replayed');
    assert.equal(
      await js(
        "[...document.querySelectorAll('.pr-action-steps button')].find(b=>b.textContent==='Create GitHub stack and merge').disabled"
      ),
      true
    );
    await capture('create-stack-failed-light-1280');
    await js('window.failAction=false');
    await click('Refresh confirmation');
    await wait(
      "document.querySelector('.step-list [aria-current=step]')?.dataset.step==='review' && document.querySelector('.pr-action-members')"
    );
    assert.equal(await js('window.writes.length'), stackWrites + 1, 'Refreshing the confirmation only reads');
    await click('Continue');
    // The title bar also has a Back button; use the one in the step card.
    await js(
      "[...document.querySelectorAll('.pr-action-steps .step-card-footer button')].find(b=>b.textContent==='Back').click()"
    );
    await wait("document.querySelector('.step-list [aria-current=step]')?.dataset.step==='review'");
    await click('Continue');
    await click('Continue');
    await wait("document.querySelector('.step-list [aria-current=step]')?.dataset.step==='merge'");
    await js("document.documentElement.classList.add('dark')");
    await capture('create-stack-dark-1280');
    win.setSize(640, 800);
    await new Promise((r) => setTimeout(r, 150));
    await capture('create-stack-dark-640');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await click('Create GitHub stack and merge');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.deepEqual(await js('window.writes.at(-1).revisions.map(r=>r.url)'), [
      'https://github.com/klang/engine/pull/120',
      'https://github.com/klang/engine/pull/121',
      'https://github.com/klang/engine/pull/122',
    ]);
    assert.equal(await js('window.writes.at(-1).createStack'), true);
    await wait(
      "document.querySelector('.activity-trigger')?.textContent.includes('running') || document.querySelector('[aria-label=\"Activity\"]')"
    );
    await js(
      "window.actionTasks[0].status='completed';window.actionTasks[0].detail='Added to GitHub’s merge queue. The PRs have not merged yet.';window.actionTasks[0].updatedAt=new Date().toISOString()"
    );
    await wait("[...document.querySelectorAll('[data-slot=toast]')].some(e=>e.textContent.includes('merge queue'))");
    win.setSize(1280, 800);
    await js('window.nativeStack=true');
    await click('Merge whole stack…');
    await wait("document.querySelector('.pr-action-members')?.children.length===3");
    assert.match(await js<string>("document.querySelector('.pr-action-dialog').textContent"), /Merge stack/);
    await capture('native-stack-dark-1280');
    const beforeEscape = await js<number>('window.writes.length');
    await press('Escape');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.length'), beforeEscape, 'Escape cancels without writing');
    console.log('PR action browser checks passed');
    app.exit(0);
  } catch (e) {
    console.error(e);
    console.error(await js('document.body.innerText'));
    fs.writeFileSync(path.join(shots, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
