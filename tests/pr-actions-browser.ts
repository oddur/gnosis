import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
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
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code).catch((error: unknown) => { throw new Error(`${code.slice(0, 300)}\n${String(error)}`); }) as Promise<T>;
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
  /** Cmd+Shift+<key>: the fixture reports macOS (tests/fixtures/workbench.tsx). */
  const chord = async (keyCode: string) => {
    win.focus();
    const modifiers: ('meta' | 'shift')[] = ['meta', 'shift'];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
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
      window.actionState=url=>{const member=q.items.flatMap(i=>i.subject.members).find(m=>m.url===url);if(!member)throw Error('Unknown mock PR');const stack=q.items.find(i=>i.subject.members.some(m=>m.url===url)&&i.subject.kind==='stack');return {...member,account:'oddur',id:'PR_'+member.number,checkedAt:Date.now(),state:member.merged?'MERGED':'OPEN',headSha:window.changedHead?'changed-head':window.pushedHead??member.headSha,headRepo:member.repo,repository:member.repo,archived:false,canWrite:!window.denyWrite,mergeable:window.conflicts?'CONFLICTING':'MERGEABLE',mergeState:window.conflicts?'DIRTY':'CLEAN',methods:['SQUASH','MERGE','REBASE'],defaultMethod:'SQUASH',autoMerge:member.autoMerge?.method??null,canEnableAuto:true,canDisableAuto:true,canUpdateBranch:true,canChangeDraft:!window.denyWrite,mergeQueue:false,inMergeQueue:false,stack:stack&&window.nativeStack?{number:8,baseBranch:'main',complete:true,mergeQueue:false,members:stack.subject.members.map(m=>({...m,state:'OPEN'}))}:null};};
      const originalStatus=window.electronAPI.getPrStatus;
      window.electronAPI.getPrStatus=async(...args)=>{const result=await originalStatus(...args);const state=window.actionState(args[0]);return {...result,isDraft:state.isDraft,signals:{...result.signals,checkedAt:Date.now(),readiness:{...result.signals.readiness,isDraft:state.isDraft,mergeable:state.mergeable,mergeState:state.mergeState}}};};
      window.electronAPI.getPrActionState=async(url)=>window.actionState(url);
      window.headerState=null;window.electronAPI.conflictHeader=async(url)=>{window.headerUrl=url;return window.headerState;};
      window.electronAPI.onConflictHeaderChanged=cb=>{window.headerChanged=cb;return()=>{};};
      window.electronAPI.getStackMergePlan=async urls=>{const members=urls.map(window.actionState);return {target:members.at(-1),members,baseBranch:members[0].baseBranch,methods:['SQUASH','MERGE','REBASE'],mergeQueue:false,createStack:!window.nativeStack};};
      window.electronAPI.performPrAction=async request=>{window.writes.push(request);await window.actionHold;if(window.failAction)throw Error(typeof window.failAction==='string'?window.failAction:'This PR changed since confirmation. Refresh the action and inspect the new revision.');await new Promise(r=>setTimeout(r,120));const m=q.items.flatMap(i=>i.subject.members).find(m=>m.url===request.url);if(request.kind==='enable-auto')m.autoMerge={method:request.method};if(request.kind==='disable-auto')m.autoMerge=null;if(request.kind==='convert-draft')m.isDraft=true;if(request.kind==='mark-ready')m.isDraft=false;
        if(request.kind==='merge'&&request.revisions.length>1){window.actionTasks.push({id:'merge-operation',kind:'pr-action',title:'Merging 3 PRs',detail:'GitHub is processing the merge.',status:'running',updatedAt:new Date().toISOString(),canCancel:false,canRetry:false});return {status:'pending',message:'GitHub is processing the merge. Follow its progress in Activity.'};}
        return {status:'completed',message:request.kind==='merge'?'Merged on GitHub.':'GitHub action completed.'};};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    // Wide enough for every header action (#542); narrower windows are checked below.
    win.setSize(1600, 900);
    await wait('innerWidth===1600');
    const A = '.pr-header-actions';
    const merge = `document.querySelector('${A} [data-merge-action]')`;
    const toggle = (label: string) => `[...document.querySelectorAll('${A} [role=switch]')].find(b=>b.textContent.startsWith(${JSON.stringify(label)}))`;
    /** Clicks a toggle once its last change has finished sending. */
    const flip = async (label: string) => {
      await wait(`!!${toggle(label)} && ${toggle(label)}.getAttribute('aria-busy')!=='true'`);
      await js(`${toggle(label)}.click()`);
    };
    const unavailable = (code: string) => `${code}?.getAttribute('aria-disabled')==='true'`;
    const available = (code: string) => `${code}?.getAttribute('aria-disabled')!=='true'`;
    const refreshActions = () => menuAction(js, 'Actions for PR #150', 'Refresh GitHub status');
    /** Undo in the newest toast titled `title`, or in the newest toast with Undo. */
    const toastUndo = async (title = '') => {
      const find = `[...document.querySelectorAll('[data-slot=toast]')].filter(t=>t.textContent.includes(${JSON.stringify(title)})).flatMap(t=>[...t.querySelectorAll('button')]).filter(b=>b.textContent==='Undo').at(-1)`;
      await wait(`!!${find}`);
      await js(`${find}.click()`);
    };
    await wait(`!!${merge} && ${available(merge)}`);
    // Every action is in the tab row, on the right, without opening a menu.
    assert.deepEqual(
      await js(`[...document.querySelectorAll('${A} [data-slot=button]')].filter(b=>b.getBoundingClientRect().width>0).map(b=>b.textContent.trim()||b.getAttribute('aria-label'))`),
      ['Draft', 'Auto-merge', 'Auto-merge method', 'Update', 'Drafts', 'Review PR #150', 'Merge', 'Merge method']
    );
    assert.ok(await js(`(()=>{const tabs=document.querySelector('.pr-overview-tabs').getBoundingClientRect();const row=document.querySelector('${A}').getBoundingClientRect();return row.left>=tabs.left&&Math.abs((row.top+row.bottom)/2-(tabs.top+tabs.bottom)/2)<8})()`), 'Actions share the tab row');
    assert.equal(await js(`document.querySelectorAll('${A} [data-slot=button][data-variant=default]:not(.pr-action-chevron)').length`), 1, 'One primary action');
    await capture('summary-light-1600');
    // Merge's confirmation opens beside it: the PR, the method, the target branch.
    await click('Merge');
    await wait("!!document.querySelector('.pr-merge-confirm [aria-label=\"Merge method\"]')");
    assert.match(await js<string>("document.querySelector('.pr-merge-confirm').textContent"), /1 PR → main/);
    assert.equal(await js("!!document.querySelector('.step-card, .pr-action-dialog')"), false, 'A single PR merge keeps one short confirmation');
    // Nothing focuses the Merge button by itself: Enter in the confirmation, before a click or Tab to it, merges nothing.
    await wait("[...document.querySelectorAll('.pr-merge-confirm button')].some(b=>b.textContent==='Merge pull request'&&!b.disabled)");
    assert.notEqual(await js("document.activeElement?.textContent"), 'Merge pull request', 'The Merge button never takes focus by itself');
    assert.ok(await js("document.querySelector('.pr-merge-confirm').contains(document.activeElement)"), 'Focus is in the confirmation');
    await press('Enter');
    assert.equal(await js('window.writes.length'), 0, 'Enter on the confirmation itself merges nothing');
    assert.ok(await js("!!document.querySelector('.pr-merge-confirm')"));
    await capture('merge-light-1600');
    await js('window.badgeLinks=[];void(window.electronAPI.openExternal=async url=>{window.badgeLinks.push(url)})');
    for (const kind of ['branch', 'commit']) {
      await js(
        `document.querySelector('.pr-action-members .entity-badge-${kind}').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:300}))`
      );
      await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Open on GitHub')");
      await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Open on GitHub').click()");
      await wait(`window.badgeLinks.length===${kind === 'branch' ? 1 : 2}`);
      assert.equal(await js("!!document.querySelector('.pr-merge-confirm')"), true, 'Badge navigation does not submit or close confirmation');
    }
    assert.match(await js<string>('window.badgeLinks[0]'), /^https:\/\/github.com\/klang\/engine\/tree\//);
    assert.match(await js<string>('window.badgeLinks[1]'), /^https:\/\/github.com\/klang\/engine\/commit\//);
    await click('Cancel');
    await wait("!document.querySelector('.pr-merge-confirm')");
    assert.equal(await js('window.writes.length'), 0);

    // Draft is a toggle: it acts at once, shows at once, and its toast offers Undo.
    await flip('Draft');
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='true'`);
    await wait("window.writes.at(-1)?.kind==='convert-draft'");
    await wait(unavailable(merge));
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Draft PR')");
    assert.match(await js<string>("document.querySelector('.merge-readiness-chip').textContent"), /Draft PR/, 'The chip agrees with Summary');
    await capture('draft-light-1600');
    await toastUndo('Converted to draft');
    await wait("window.writes.at(-1)?.kind==='mark-ready'");
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='false' && ${available(merge)}`);
    // While one setting is being sent, the other waits: both read GitHub's state before they act.
    await js('window.actionHold=new Promise(r=>window.releaseAction=r);0');
    await flip('Draft');
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='true' && ${toggle('Auto-merge')}?.getAttribute('aria-busy')==='true'`);
    assert.equal(await js(`${toggle('Auto-merge')}.getAttribute('aria-busy')`), 'true', 'Auto-merge waits for the Draft change');
    // Undo of an earlier change waits too, and says so.
    await js(`${toggle('Auto-merge')}.click()`);
    assert.equal(await js("window.writes.filter(w=>w.kind==='enable-auto').length"), 0, 'A busy toggle sends nothing');
    await js('window.releaseAction();window.actionHold=undefined');
    await wait("window.writes.at(-1)?.kind==='convert-draft'");
    await wait(`${toggle('Draft')}?.getAttribute('aria-busy')!=='true' && ${toggle('Auto-merge')}?.getAttribute('aria-busy')!=='true'`);
    // GitHub changed it back since: Undo does nothing, and says so.
    const writesBeforeUndo = await js<number>('window.writes.length');
    await js("window.queue.items.flatMap(i=>i.subject.members).find(m=>m.number===150).isDraft=false");
    await toastUndo('Converted to draft');
    await wait("[...document.querySelectorAll('[data-slot=toast]')].some(t=>t.textContent.includes('Changed on GitHub since; nothing undone'))");
    assert.equal(await js('window.writes.length'), writesBeforeUndo, 'An Undo over someone else’s change writes nothing');
    await refreshActions();
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='false'`);
    // An Undo while another change is being sent is skipped, and says why.
    await flip('Draft');
    await wait("window.writes.at(-1)?.kind==='convert-draft'");
    await js('window.actionHold=new Promise(r=>window.releaseAction=r);0');
    await flip('Auto-merge');
    await wait(`${toggle('Draft')}?.getAttribute('aria-busy')==='true'`);
    await toastUndo('Converted to draft');
    await wait("[...document.querySelectorAll('[data-slot=toast]')].some(t=>t.textContent.includes('Nothing undone'))");
    await js('window.releaseAction();window.actionHold=undefined');
    await wait("window.writes.at(-1)?.kind==='enable-auto'");
    assert.equal(await js("window.writes.filter(w=>w.kind==='mark-ready').length"), 1, 'The skipped Undo sent nothing');
    await flip('Auto-merge');
    await wait("window.writes.at(-1)?.kind==='disable-auto'");
    await flip('Draft');
    await wait("window.writes.at(-1)?.kind==='mark-ready'");
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='false' && ${toggle('Draft')}?.getAttribute('aria-busy')!=='true'`);
    // A refused change rolls back and keeps a retry.
    await js('window.failAction=true');
    await flip('Draft');
    await wait("!!document.querySelector('.pr-header-notes .pr-action-error')");
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='false'`);
    await js('window.failAction=false');
    await capture('draft-failed-light-1600');
    await js("[...document.querySelectorAll('.pr-header-notes .pr-action-error button')].find(b=>/Retry|Try again/.test(b.textContent))?.click()");
    await wait("window.writes.at(-1)?.kind==='convert-draft' && !document.querySelector('.pr-header-notes .pr-action-error')");
    await flip('Draft');
    await wait("window.writes.at(-1)?.kind==='mark-ready'");
    await wait(`${toggle('Draft')}?.getAttribute('aria-checked')==='false'`);

    // Conflicts: Resolve conflicts takes Merge's place, and Update says why it is unavailable.
    await js('window.conflicts=true');
    await refreshActions();
    await wait(`[...document.querySelectorAll('${A} button')].some(b=>b.textContent==='Resolve conflicts…')`);
    assert.equal(await js(`!!${merge}`), false, 'Merge gives its place to Resolve conflicts');
    assert.match(await js<string>(`document.querySelector('${A} .pr-update-trigger').title`), /Resolve merge conflicts/);
    assert.equal(await js(unavailable(`document.querySelector('${A} .pr-update-trigger')`)), true);
    await capture('conflicts-light-1600');
    // The conflict line from background preparation (#445): checking, the summary, Review and push…, no permission.
    const header = async (state: unknown) => {
      await wait('!!window.headerChanged&&!!window.headerUrl');
      await js(`window.headerState=${JSON.stringify(state)};window.headerChanged(window.headerUrl)`);
    };
    const line = "document.querySelector('.pr-conflict-line')?.textContent";
    const resolveButton = (label: string) => `[...document.querySelectorAll('${A} button')].find(b=>b.textContent===${JSON.stringify(label)})`;
    await header({ state: 'checking', files: 3 });
    await wait(`${line}==='Checking 3 files…'`);
    const sentence = '3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you: 1 to check, 1 to decide.';
    await header({ state: 'ready', sentence, merged: false });
    await wait(`${line}===${JSON.stringify(sentence)}&&!!${resolveButton('Resolve conflicts…')}`);
    await capture('conflict-header-light-1600');
    await header({ state: 'ready', sentence: '2 files have conflicts. 4 of 4 conflicts are merged and checked. Nothing needs you.', merged: true });
    await wait(`!!${resolveButton('Review and push…')}`);
    await header({ state: 'no-permission' });
    // The line says so, and the button stays usable: a permission granted later works.
    await wait(`${line}?.startsWith('You can’t push to this branch')&&${resolveButton('Resolve conflicts…')}?.disabled===false`);
    await header(null);
    await wait(`!document.querySelector('.pr-conflict-line')&&${resolveButton('Resolve conflicts…')}?.disabled===false`);
    // After a conflict update (#445 item 25): "Merged main into this PR", with the manual steps while the repository
    // doesn't allow the force push, and Undo this update with its confirmation when it does.
    await js(`(()=>{
      const s=window.actionState(window.headerUrl);window.pushedRepo=s.repository;
      window.electronAPI.conflictPushed=async(url,head)=>head==='d'.repeat(40)?{id:'a'.repeat(64),version:1,url,headRepo:s.headRepo,baseRepo:s.repository,headBranch:s.headBranch,baseBranch:s.baseBranch,headSha:'e'.repeat(40),commitSha:'d'.repeat(40)}:null;
      window.pushedHead='d'.repeat(40);
    })()`);
    await refreshActions();
    const pushedLine = "document.querySelector('[data-conflict-pushed]')";
    await wait(`${pushedLine}?.textContent.startsWith('Merged main into this PR')`);
    assert.equal(await js(`!!${pushedLine}.querySelector('[data-conflict-undo]')`), false, 'Off by default');
    assert.match(await js<string>(`${pushedLine}.querySelector('[data-conflict-undo-docs]').href`), /#undo-an-update$/);
    const allowUndo = (allow: boolean) =>
      js(`(async()=>{const p=await window.electronAPI.loadPreferences();const key=window.pushedRepo.toLowerCase();const r={...p.repositorySettings?.[key]};if(${allow})r.allowConflictUndo=true;else delete r.allowConflictUndo;const next={...p,repositorySettings:{...p.repositorySettings,[key]:r}};await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}));})()`);
    await allowUndo(true);
    await wait(`!!${pushedLine}?.querySelector('[data-conflict-undo]')`);
    await js(`${pushedLine}.querySelector('[data-conflict-undo]').click()`);
    await wait("!!document.querySelector('[data-conflict-undo-dialog]')");
    assert.match(await js<string>("document.querySelector('[data-conflict-undo-dialog]').innerText"), /rewrites its history/);
    await capture('conflict-undo-header-light-1600');
    await js("document.querySelector('[data-conflict-undo-dialog] button[data-variant=outline]').click()");
    await wait("!document.querySelector('[data-conflict-undo-dialog]')");
    await allowUndo(false);
    await js('delete window.pushedHead');
    await refreshActions();
    await wait(`!${pushedLine}`);
    await js('window.conflicts=false');
    await refreshActions();
    await wait(`!!${merge} && ${available(`document.querySelector('${A} .pr-update-trigger')`)}`);
    // GitHub's state moved on since the header read it: the confirmation reads it again and refuses.
    await js('window.conflicts=true');
    const updateItem = async (label: string) => {
      await click('Update');
      await wait(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith(${JSON.stringify(label)}))`);
      await js(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.startsWith(${JSON.stringify(label)})).click()`);
    };
    await updateItem('Update with rebase…');
    await wait("document.querySelector('.pr-action-dialog')?.textContent.includes('Resolve merge conflicts')");
    assert.equal(await js("[...document.querySelectorAll('.pr-action-dialog button')].find(b=>b.textContent==='Update branch with rebase').disabled"), true);
    await capture('conflicts-confirmation-light-1600');
    await click('Cancel');
    await js('window.conflicts=false');
    await refreshActions();
    await wait(`!!${merge}`);

    // Auto-merge is a toggle with the repository's default method; its chevron picks another.
    await flip('Auto-merge');
    await wait("window.writes.at(-1)?.kind==='enable-auto'");
    assert.equal(await js('window.writes.at(-1).method'), 'SQUASH');
    await wait(`${toggle('Auto-merge')}?.getAttribute('aria-checked')==='true' && ${toggle('Auto-merge')}.textContent.includes('Squash')`);
    await capture('auto-merge-light-1600');
    await toastUndo('Auto-merge on');
    await wait("window.writes.at(-1)?.kind==='disable-auto'");
    await wait(`${toggle('Auto-merge')}?.getAttribute('aria-checked')==='false'`);
    await wait(`${toggle('Auto-merge')}?.getAttribute('aria-busy')!=='true'`);
    await click('Auto-merge method');
    await wait("[...document.querySelectorAll('[role=menuitemradio]')].some(e=>e.textContent.startsWith('Rebase and merge'))");
    await js("[...document.querySelectorAll('[role=menuitemradio]')].find(e=>e.textContent.startsWith('Rebase and merge')).click()");
    await wait("window.writes.at(-1)?.kind==='enable-auto' && window.writes.at(-1).method==='REBASE'");
    await wait(`${toggle('Auto-merge')}?.textContent.includes('Rebase')`);
    await flip('Auto-merge');
    await wait("window.writes.at(-1)?.kind==='disable-auto'");

    // Update is one menu; each way keeps its confirmation.
    await updateItem('Update with rebase…');
    await wait("!!document.querySelector('.pr-action-members')");
    assert.match(await js<string>("document.querySelector('.pr-action-dialog').textContent"), /main → fix-0/);
    await capture('rebase-light-1600');
    await click('Update branch with rebase');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.at(-1).kind'), 'update-rebase');
    assert.equal(await js('window.writes.at(-1).revisions[0].headSha'), 'head-0');
    await updateItem('Update with merge commit…');
    await wait("!!document.querySelector('.pr-action-members')");
    await click('Update branch with merge commit');
    await wait("!document.querySelector('.pr-action-dialog')");
    assert.equal(await js('window.writes.at(-1).kind'), 'update-merge');
    // GitHub refuses a merge-commit update when the base branch's changes include workflow files and the sign-in lacks
    // workflow. The update stays available (Gnosis can't see those files), and the refusal reads plainly.
    const workflowRefusal =
      "Error invoking remote method 'perform-pr-action': Error: Request failed due to following response errors:\n - refusing to allow an OAuth App to create or update workflow `.github/workflows/build.yml` without `workflow` scope";
    await js(`window.failAction=${JSON.stringify(workflowRefusal)};window.setFixtureGitHubScopes(['repo','read:org'])`);
    await wait(available(`document.querySelector('${A} .pr-update-trigger')`));
    await updateItem('Update with merge commit…');
    await wait("!!document.querySelector('.pr-action-members')");
    await click('Update branch with merge commit');
    await wait("!!document.querySelector('.pr-action-dialog [data-workflow-permission] .github-scope-prompt')");
    const refused = await js<string>("document.querySelector('.pr-action-dialog [data-workflow-permission]').textContent");
    assert.match(
      refused,
      /^Needs the workflow permission\. GitHub only accepts changes to GitHub Actions workflows \(\.github\/workflows\/…\) from sign-ins with the workflow permission\./
    );
    assert.doesNotMatch(await js<string>("document.querySelector('.pr-action-dialog').textContent"), /refusing to allow|response errors/);
    assert.doesNotMatch(refused, /If GitHub may have received the request/, 'A refusal is definite');
    await capture('update-merge-workflow-refused');
    await js(`(()=>{
      window.signInStarts=0;
      const begin=window.electronAPI.beginGitHubSignIn;
      window.electronAPI.beginGitHubSignIn=(...args)=>{window.signInStarts++;return begin(...args)};
    })()`);
    await click('Sign in again');
    await wait("!document.querySelector('.pr-action-dialog') && window.signInStarts===1");
    await wait("!document.querySelector('.github-auth-dialog')");

    // The merge confirmation: the chevron picks the method first; a stale revision refuses and nothing merges.
    await js('window.failAction=false');
    await click('Merge method');
    await wait("[...document.querySelectorAll('[role=menuitemradio]')].some(e=>e.textContent.startsWith('Rebase and merge'))");
    await js("[...document.querySelectorAll('[role=menuitemradio]')].find(e=>e.textContent.startsWith('Rebase and merge')).click()");
    await wait("!!document.querySelector('.pr-merge-confirm [aria-label=\"Merge method\"]')");
    assert.equal(await js("document.querySelector('.pr-merge-confirm [name=merge-method]:checked').value"), 'REBASE', 'The chevron picks the method');
    assert.equal(await js("!!document.querySelector('.pr-action-message')"), false);
    await js("document.querySelector('.pr-merge-confirm [name=merge-method][value=SQUASH]').click()");
    await wait("!!document.querySelector('.pr-action-message') && document.querySelector('.pr-merge-confirm [name=merge-method]:checked').value==='SQUASH'");
    await js('window.failAction=true');
    await click('Merge pull request');
    await wait("document.querySelector('.pr-merge-confirm [role=alert]')?.textContent.includes('changed since confirmation')");
    assert.equal(await js("[...document.querySelectorAll('.pr-merge-confirm button')].find(b=>b.textContent==='Merge pull request').disabled"), true);
    await capture('stale-confirmation-1600');
    await click('Cancel');
    assert.equal(await js("window.writes.filter(w=>w.kind==='merge').length"), 1);
    // Cmd+Shift+M opens the confirmation and nothing more: Enter there merges nothing; the Merge button does.
    await js('window.failAction=false');
    await chord('M');
    await wait("[...document.querySelectorAll('.pr-merge-confirm button')].some(b=>b.textContent==='Merge pull request'&&!b.disabled)");
    assert.notEqual(await js("document.activeElement?.textContent"), 'Merge pull request');
    await press('Enter');
    assert.equal(await js("window.writes.filter(w=>w.kind==='merge').length"), 1, 'The shortcut and Enter only open the confirmation');
    await click('Merge pull request');
    await wait("window.writes.filter(w=>w.kind==='merge').length===2 && !document.querySelector('.pr-merge-confirm')");
    // The shortcuts leave text fields alone.
    await js("(()=>{const i=document.createElement('input');i.id='shortcut-probe';document.body.append(i);i.focus()})()");
    await chord('M');
    await chord('U');
    assert.equal(await js("!!document.querySelector('.pr-merge-confirm') || [...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with'))"), false, 'Cmd+Shift+M and U do nothing in a text field');
    await js("document.getElementById('shortcut-probe').remove()");
    // Cmd+Shift+U opens the Update menu; Cmd+Shift+V the review.
    await chord('U');
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with rebase…'))");
    await press('Escape');
    await wait("![...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with rebase…'))");
    await chord('V');
    await wait("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('Review PR #150'))");
    await click('Close');
    await wait("![...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('Review PR #150'))");
    assert.equal(await js('window.location.href.includes("pr-summary")'), true, 'No reload');

    // Short of room, the toggles go to ⋯ first, then Update and Drafts. Merge and Review PR always stay.
    win.setSize(1100, 900);
    await wait(`innerWidth===1100 && document.querySelector('${A}')?.dataset.collapse!=='0'`);
    win.setSize(760, 900);
    await wait(`innerWidth===760 && document.querySelector('${A}')?.dataset.collapse==='2'`);
    assert.deepEqual(
      await js(`[...document.querySelectorAll('${A} [data-slot=button]')].filter(b=>b.getBoundingClientRect().width>0).map(b=>b.textContent.trim()||b.getAttribute('aria-label'))`),
      ['Review PR #150', 'Merge', 'Merge method']
    );
    await js("(b=>{b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})(document.querySelector('[aria-label=\"Actions for PR #150\"]'))");
    for (const label of ['Drafts', 'Convert to draft', 'Turn on auto-merge', 'Update with merge commit…', 'Update with rebase…'])
      await wait(`[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith(${JSON.stringify(label)}))`);
    await js("document.documentElement.classList.add('dark')");
    await capture('collapsed-dark-760');
    await press('Escape');
    await js("document.documentElement.classList.remove('dark')");
    // Update is in ⋯ here: Cmd+Shift+U opens nothing, and leaves nothing to open later.
    await chord('U');
    assert.equal(await js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with'))"), false);
    win.setSize(1600, 900);
    await wait(`innerWidth===1600 && document.querySelector('${A}')?.dataset.collapse==='0'`);
    assert.equal(await js("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with'))"), false, 'No Update menu opens when Update comes back');

    // A confirmation never outlives its workspace: switching tabs with Cmd+2 closes it, and nothing merges.
    const mergesBefore = await js<number>("window.writes.filter(w=>w.kind==='merge').length");
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`);
    await wait('document.querySelectorAll(".workspace-tab").length===2');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',metaKey:true,bubbles:true}))`);
    await wait(`!!document.querySelector('${A} [data-merge-action]')?.checkVisibility()`);
    await click('Merge');
    await wait("!!document.querySelector('.pr-merge-confirm')?.checkVisibility()");
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}))`);
    await wait("!document.querySelector('.pr-merge-confirm')?.checkVisibility()");
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',metaKey:true,bubbles:true}))`);
    await wait(`!!document.querySelector('${A} [data-merge-action]')?.checkVisibility()`);
    assert.equal(await js("!!document.querySelector('.pr-merge-confirm')?.checkVisibility()"), false, 'The confirmation stays closed on return');
    // The Update menu closes with its window's focus.
    await click('Update');
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with rebase…'))");
    await js("window.dispatchEvent(new Event('blur'))");
    await wait("![...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.startsWith('Update with rebase…'))");
    assert.equal(await js("window.writes.filter(w=>w.kind==='merge').length"), mergesBefore);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}))`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true}))`);
    await wait('document.querySelectorAll(".workspace-tab").length===1');
    await wait(`!!document.querySelector('${A} [data-merge-action]')?.checkVisibility()`);

    await js('window.denyWrite=true');
    await refreshActions();
    await wait(`${unavailable(merge)} && ${merge}.title==='You need write permission to merge this PR.'`);
    await js('window.denyWrite=false');
    win.setSize(1280, 800);
    await wait('innerWidth===1280');
    await click('Review queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open stack overview');
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
