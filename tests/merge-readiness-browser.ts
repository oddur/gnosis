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
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`${code}\n${error}`); }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    if (label === 'Refresh status') {
      const menu = await js<string>("document.querySelector('.pr-overview-heading .entry-menu-trigger').getAttribute('aria-label')");
      return menuAction(js, menu, 'Refresh GitHub status');
    }
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 50));
  };
  const shots = path.resolve('.impeccable/review/merge-readiness');
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
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&workflow-files`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(()=>{
      const signals=window.electronAPI.getQueueSignals, status=window.electronAPI.getPrStatus;
      window.mode='behind';window.forceReads=0;window.failStatus=false;window.reviewDecisions={};window.reviewOverrides={};
      window.electronAPI.getQueueSignals=async(requests,options)=>{
        const result=await signals(requests,options);
        return result.map(s=>({...s,readiness:{...s.readiness,mergeState:window.mode==='conflicts'?'DIRTY':window.mode==='behind'?'BEHIND':'CLEAN',mergeable:window.mode==='conflicts'?'CONFLICTING':'MERGEABLE',behindBy:3,reviewDecision:s.url in window.reviewDecisions?window.reviewDecisions[s.url]:s.readiness.reviewDecision,...window.reviewOverrides[s.url]}}));
      };
      window.electronAPI.getPrStatus=async(url,force)=>{if(force)window.forceReads++;if(window.failStatus)throw Error('Network unavailable');return status(url,force)};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Update required to merge')");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto main, or merge main/
    );
    assert.equal(
      await js("document.querySelector('.pr-merge-detail a').getAttribute('href')"),
      'https://github.com/klang/engine/pull/150'
    );
    assert.equal(await js("document.querySelector('.pr-heading-meta .pr-review-status').textContent"), 'Approved');
    await capture('desktop-update-required');
    for (const tab of ['Changes', 'Commits', 'Explanation', 'Summary']) {
      await click(tab);
      assert.equal(await js("document.querySelector('.pr-heading-meta .pr-review-status').textContent"), 'Approved');
      assert.match(
        await js<string>("(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta')).textContent"),
        /Update required to merge/
      );
    }
    win.setSize(640, 800);
    await capture('narrow-update-required');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.add('dark')");
    await capture('dark-update-required');
    await js("document.documentElement.classList.remove('dark');window.mode='conflicts'");
    await click('Refresh status');
    await wait(
      "(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Merge conflicts')"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /resolve the conflicts/);
    assert.equal(await js("document.querySelector('.pr-heading-meta .pr-review-status').textContent"), 'Approved');
    await capture('conflicts');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait(
      "(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Ready to merge')"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /updating is optional/);
    await capture('optional-update');
    // klanggames/seed#35392: github.com shows it ready to merge, approved by plucked, checks passed, and it changes two
    // files under .github/workflows/. GitHub answers BLOCKED with no review decision, 77 behind develop. First a sign-in
    // with every scope, where BLOCKED has some other cause.
    await js(`(()=>{
      window.mismatch=true;
      const signals=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async(requests,options)=>(await signals(requests,options)).map(s=>window.mismatch&&s.url==='https://github.com/klang/engine/pull/150'?{...s,
        checks:{state:'success',passed:12,total:12},
        opinions:[{url:s.url,author:'plucked',state:'APPROVED',submittedAt:'2026-11-17T10:00:00Z',headSha:s.headSha}],
        readiness:{...s.readiness,mergeState:'BLOCKED',mergeable:'MERGEABLE',reviewDecision:null,behindBy:77,baseBranch:'develop'}}:s);
      window.mergeWrites=[];
      window.electronAPI.getPrActionState=async url=>{const q=await window.electronAPI.workbenchQueue();const m=q.items.flatMap(i=>i.subject.members).find(m=>m.url===url);
        return {...m,account:'oddur',id:'PR_'+m.number,checkedAt:Date.now(),state:'OPEN',headRepo:m.repo,repository:m.repo,archived:false,canWrite:true,mergeable:'MERGEABLE',mergeState:window.mismatch?'BLOCKED':'CLEAN',reviewDecision:window.mismatch?null:'APPROVED',checkState:'SUCCESS',methods:['SQUASH'],defaultMethod:'SQUASH',autoMerge:null,canEnableAuto:false,canDisableAuto:false,canUpdateBranch:true,canChangeDraft:true,mergeQueue:false,inMergeQueue:false,stack:null};};
      window.electronAPI.performPrAction=async request=>{window.mergeWrites.push(request);throw Error('Repository rule violations found. Review from code owner required.');};
    })()`);
    await click('Refresh status');
    const detail = "document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail')";
    await wait(`${detail}?.textContent.includes('GitHub reports this as blocked')`);
    const blockedText = await js<string>(`${detail}.textContent`);
    assert.match(blockedText, /Every requirement Gnosis can see is met\. GitHub works out merge rules for the account and access asking, so check the PR on GitHub\./);
    assert.match(blockedText, /Behind develop by 77 commits\. GitHub hasn’t said whether it must be updated\./);
    assert.doesNotMatch(blockedText, /Merge blocked/);
    assert.equal(await js(`${detail}.querySelector('.merge-readiness-badge').className`), 'merge-readiness-badge is-warning');
    assert.equal(await js(`!!${detail}.querySelector('a.pr-merge-requirements[href="https://github.com/klang/engine/pull/150"]')`), true, 'Keeps the GitHub link');
    assert.equal(await js(`!!${detail}.querySelector('.github-scope-prompt')`), false, 'A sign-in with every scope is not asked again');
    assert.equal(await js("document.querySelector('.pr-heading-meta .pr-review-status').textContent"), 'Approved by plucked');
    assert.equal(await js("document.body.textContent.includes('No review decision')"), false);
    // The Merge button stays available; GitHub's refusal reaches the dialog once and nothing merges.
    // The header's chip says the same as Summary (#542).
    assert.equal(await js("document.querySelector('.pr-heading-meta .merge-readiness-chip').textContent"), 'GitHub reports this as blocked');
    await click('Refresh status');
    const mergeButton = "document.querySelector('.pr-header-actions [data-merge-action]')";
    await wait(`!!${mergeButton} && ${mergeButton}.getAttribute('aria-disabled')!=='true'`);
    await js(`${mergeButton}.click()`);
    await wait("!!document.querySelector('.pr-merge-confirm [data-github-blocked]')");
    await click('Merge pull request');
    await wait("document.querySelector('.pr-merge-confirm .pr-action-error')?.textContent.includes('Repository rule violations found')");
    assert.equal(await js('window.mergeWrites.length'), 1);
    // A refusal stays until the reader dismisses it, even when the window loses focus or the workspace is hidden.
    await js("window.dispatchEvent(new Event('blur'))");
    await js('new Promise(r=>setTimeout(r,0))');
    assert.ok(await js("document.querySelector('.pr-merge-confirm .pr-action-error')?.checkVisibility()"), 'GitHub’s refusal stays after the window loses focus');
    await capture('github-blocked-refused');
    await click('Cancel');
    await wait("!document.querySelector('.pr-merge-confirm')");
    // An older sign-in with repo and read:org, but not workflow: GitHub's BLOCKED is the workflow files.
    await js("window.setFixtureGitHubScopes(['repo','read:org'])");
    await wait(`${detail}.querySelector('.merge-readiness-badge')?.textContent==='Needs the workflow permission'`);
    const workflowText = await js<string>(`${detail}.textContent`);
    assert.match(workflowText, /This PR changes GitHub Actions workflows \(\.github\/workflows\/…\)\. GitHub only lets sign-ins with the workflow permission merge it\./);
    assert.doesNotMatch(workflowText, /Every requirement Gnosis can see is met/);
    assert.equal(
      await js<string>(`${detail}.querySelector('.github-scope-prompt p').textContent`),
      'Gnosis now asks for two more GitHub permissions: reading your organization membership, so team review requests match GitHub, and updating workflow files, so it can merge PRs that change GitHub Actions workflows.'
    );
    // GitHub would refuse the merge, so Merge is disabled with the reason. So is a rebase, which rewrites those files.
    await wait(`${mergeButton}?.getAttribute('aria-disabled')==='true'`);
    assert.equal(await js(`${mergeButton}.title`), 'Needs the workflow permission. Sign in again, or merge on GitHub.');
    await capture('github-blocked-workflow');
    // GitHub's raw answer and Gnosis's access, in About these results.
    await js("[...document.querySelectorAll('.pr-summary-content[data-state=active] .review-evidence button')].find(b=>b.textContent.includes('Show details')).click()");
    await wait("!!document.querySelector('.pr-summary-content[data-state=active] .review-evidence-help')");
    await js("document.querySelector('.pr-summary-content[data-state=active] .review-evidence-help').open=true");
    const about = await js<string>("document.querySelector('.pr-summary-content[data-state=active] .review-evidence-github-answer').textContent");
    assert.match(about, /GitHub merge state: BLOCKED/);
    assert.match(about, /GitHub mergeable: MERGEABLE/);
    assert.match(about, /GitHub review decision: none/);
    assert.match(about, /Changes workflow files: yes/);
    assert.match(about, /Gnosis’s GitHub access: repo, read:org$/);
    await js("document.querySelector('.pr-summary-content[data-state=active] .review-evidence-help').scrollIntoView({block:'center'})");
    await capture('github-answer');
    await js("[...document.querySelectorAll('.pr-summary-content[data-state=active] .review-evidence button')].find(b=>b.textContent.includes('Hide details')).click()");
    // One click on "Sign in again" starts sign-in: the code appears without choosing a method first.
    await js(`(()=>{
      window.signInStarts=0;
      const begin=window.electronAPI.beginGitHubSignIn, complete=window.electronAPI.completeGitHubSignIn;
      window.electronAPI.beginGitHubSignIn=(...args)=>{window.signInStarts++;return begin(...args)};
      const authorized=new Promise(resolve=>window.authorizeSignIn=resolve);
      window.electronAPI.completeGitHubSignIn=async(...args)=>{await authorized;return complete(...args)};
    })()`);
    await js(`${detail}.querySelector('.github-scope-prompt button').click()`);
    await wait("document.querySelector('.github-auth-dialog [aria-label=\"GitHub sign-in code\"]')?.textContent==='TEST-CODE'");
    assert.equal(await js('window.signInStarts'), 1);
    await capture('github-account-sign-in');
    // GitHub authorizes the new scopes, including workflow.
    await js('window.authorizeSignIn()');
    await wait("!document.querySelector('.github-auth-dialog')");
    await wait(`!${detail}.querySelector('.github-scope-prompt')`);
    assert.equal(await js(`${detail}.querySelector('.merge-readiness-badge').textContent`), 'GitHub reports this as blocked');
    await wait(`!!${mergeButton} && ${mergeButton}.getAttribute('aria-disabled')!=='true'`);
    // A fine-grained token reports no scopes: a quiet line names its Workflows permission, with no prompt.
    await js("window.setFixtureGitHubScopes(null,'fine-grained')");
    await wait(`${detail}.textContent.includes('If you signed in with a fine-grained token, it may need the Workflows permission (read and write) for this repository.')`);
    assert.equal(await js(`${detail}.querySelector('.merge-readiness-badge').textContent`), 'GitHub reports this as blocked');
    assert.equal(await js(`!!${detail}.querySelector('.github-scope-prompt')`), false);
    await capture('github-blocked-fine-grained');
    await js("window.setFixtureGitHubScopes(['repo','read:org','workflow'],'oauth')");
    await wait(`!${detail}.textContent.includes('fine-grained token')`);
    // With workflow, GitHub answers CLEAN.
    await js('window.mismatch=false');
    await click('Refresh status');
    await wait(`${detail}?.textContent.includes('Ready to merge')`);
    assert.equal(await js(`!!${detail}.querySelector('.github-scope-prompt')`), false);
    await js('window.failStatus=true;const realNow=Date.now;Date.now=()=>realNow()+6*60*1000;void 0');
    await click('Refresh status');
    await wait(
      "(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Readiness out of date')"
    );
    assert.equal(await js("!!document.querySelector('.pr-heading-meta .is-success')"), false);
    assert.equal(await js("document.querySelector('.pr-heading-meta .pr-review-status').textContent"), 'Approved · Out of date');
    assert.match(await js<string>("document.querySelector('.pr-heading-meta .pr-review-status').title"), /Last checked/);
    await capture('stale');
    await js("window.failStatus=false;window.mode='behind'");
    await click('Refresh status');
    await wait(
      "(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Update required to merge')"
    );
    assert.ok((await js<number>('window.forceReads')) >= 4);
    await click('Review queue');
    await wait(
      "[...document.querySelectorAll('.queue-item')].find(e=>e.textContent.includes('Fix reconnect'))?.textContent.includes('Update required to merge')"
    );
    await capture('queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open stack overview');
    await wait("(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('Not ready to merge')");
    await js("document.querySelector('.stack-overview-member[data-pr-url$=\"/121\"] .stack-member-title > button:not(.entity-badge)').click()");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto queue-0, or merge queue-0/
    );
    await capture('stack');
    await click('Back to stack');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait("(document.querySelector('.pr-summary-content[data-state=active] .pr-merge-detail') ?? document.querySelector('.pr-heading-meta'))?.textContent.includes('All open PRs meet merge requirements')");
    await capture('stack-next');
    await js(`window.reviewDecisions={
      'https://github.com/klang/engine/pull/120':'CHANGES_REQUESTED',
      'https://github.com/klang/engine/pull/121':'REVIEW_REQUIRED',
      'https://github.com/klang/engine/pull/122':null
    }`);
    await click('Refresh status');
    await wait("document.querySelector('.stack-overview-member[data-pr-url$=\"/120\"] .pr-review-status')?.textContent==='Changes requested'");
    assert.deepEqual(await js("[...document.querySelectorAll('.stack-overview-member .pr-review-status')].map(s=>s.textContent)"),
      ['No review required', 'Awaiting review', 'Changes requested']);
    assert.equal(await js("document.querySelector('.stack-overview-member:first-child .merge-readiness-badge')"), null);
    await capture('stack-review-status');
    win.setSize(640, 800);
    await capture('stack-review-status-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("document.querySelectorAll('.stack-overview-member .pr-review-status')[1].textContent"), 'Awaiting review');
    await js("document.documentElement.classList.add('dark')");
    await capture('stack-review-status-narrow-dark');
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await click('Review queue');
    await wait("[...document.querySelectorAll('.queue-status-line')].some(e=>e.textContent.includes('Changes requested'))");
    await capture('queue-review-status');
    await js("document.querySelector('.queue-disclosure').click()");
    await wait("document.querySelector('.queue-member .pr-review-status')?.textContent==='Changes requested'");
    await js("document.querySelector('.queue-item:has(.queue-disclosure)').scrollIntoView({block:'start'})");
    await capture('queue-review-status-expanded');
    await js("document.documentElement.classList.add('dark')");
    await capture('queue-review-status-dark');
    await js("document.querySelector('.queue-list').scrollTop=0");
    await js(`(async()=>{
      const queue = await window.electronAPI.workbenchQueue();
      const updated = structuredClone(queue);
      updated.items.flatMap(i=>i.subject.members).filter(m=>m.number===150).forEach(m=>m.headSha='new-status-revision');
      window.electronAPI.workbenchQueue = async()=>updated;
      const original = window.electronAPI.getQueueSignals;
      const gate = new Promise(resolve=>window.confirmNewRevision=resolve);
      window.electronAPI.getQueueSignals=async(requests, options)=>{
        if(requests.some(r=>r.headSha==='new-status-revision')) {
          if(options?.cachedOnly) return [];
          await gate;
        }
        return original(requests,options);
      };
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);
    await wait("[...document.querySelectorAll('.queue-item')].find(e=>e.textContent.includes('Fix reconnect'))?.querySelector('.pr-review-status')?.textContent==='Checking review status'");
    await capture('new-revision');
    await js('window.confirmNewRevision()');
    await wait("[...document.querySelectorAll('.queue-item')].find(e=>e.textContent.includes('Fix reconnect'))?.querySelector('.pr-review-status')?.textContent==='Approved'");


    console.log(
      'Merge readiness browser checks passed: queue, persistent header, required/optional updates, conflicts, stale status, refresh, stack bases, narrow and dark views.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await capture('failure');
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
