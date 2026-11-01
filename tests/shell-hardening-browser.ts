import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
  const fill = (text: string) =>
    js(
      `(()=>{const e=document.querySelector('.global-command input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  const shots = path.resolve('.impeccable/review/harden-shell');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
        return;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    // Startup failure and optional storage denial cannot strand the queue.
    await loadWorkbenchPage(win, url + '?shell-startup-failure');
    await wait("document.querySelector('.workbench-notice')?.textContent.includes('Retry loading Gnosis')");
    await capture('startup-recovery');
    await js("sessionStorage.setItem('fixture-startup-recovered','true')");
    await click('Retry loading Gnosis');
    await waitForWorkbenchQueue(win.webContents);
    await js("document.querySelector('.queue-row-main').click()");
    assert.equal(await js("!!document.querySelector('.workbench-header')"), true);
    // A newer notification wins even if its older load finishes last.
    await js(
      `(async()=>{window.baseReview=await window.electronAPI.loadReview('fixture');window.loads={};window.electronAPI.loadReview=id=>new Promise((resolve,reject)=>{window.loads[id]={resolve,reject}});window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'slow-old'}));window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'fast-new'}));})()`
    );
    await wait('!!window.loads["fast-new"]');
    await js(
      `(()=>{const next=structuredClone(window.baseReview);next.reviewId='fast-new';next.snapshot.subject.id='new-subject';next.snapshot.subject.title='Latest explanation';window.loads['fast-new'].resolve(next)})()`
    );
    await wait("document.querySelector('.pr-overview-heading h1')?.textContent==='Latest explanation'");
    await js("window.loads['slow-old'].resolve(window.baseReview)");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await js("document.querySelector('.pr-overview-heading h1')?.textContent"), 'Latest explanation');
    await js("window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'failed-review'}))");
    await wait('!!window.loads["failed-review"]');
    await js("window.loads['failed-review'].reject(Error('Saved review could not be read.'))");
    await wait("document.querySelector('.app-toasts')?.textContent.includes('Could not open saved review')");
    await capture('notification-error');
    // Isolated shell: overlapping activity actions and an older polling response.
    await loadWorkbenchPage(win, new URL('shell-hardening.html', url).href);
    await wait("document.querySelectorAll('.activity-task').length===2");
    await js(
      `(async()=>{window.oldTasks=await window.electronAPI.listActivity();window.currentTasks=structuredClone(window.oldTasks);window.reads=0;window.actions=[];window.pendingActions={};window.electronAPI.listActivity=()=>{window.reads++;return window.reads===1?new Promise(resolve=>window.finishOldPoll=resolve):Promise.resolve(structuredClone(window.currentTasks))};window.electronAPI.activityAction=(id,action)=>{window.actions.push({id,action});return new Promise(resolve=>window.pendingActions[id]=resolve)};})()`
    );
    await wait('window.reads===1');
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(await js('window.reads'), 1, 'Slow activity polls are coalesced');
    await js(
      "(()=>{const buttons=[...document.querySelectorAll('.activity-actions button')].filter(b=>b.textContent==='Retry');buttons[0].click();buttons[0].click();buttons[1].click()})()"
    );
    await wait('window.actions.length===2');
    await js(
      "window.currentTasks[1].status='completed';window.currentTasks[1].canRetry=false;window.pendingActions.second()"
    );
    await wait("document.querySelectorAll('.activity-task[data-status=completed]').length===1");
    assert.equal(
      await js("document.querySelector('.activity-task[data-status=failed] .activity-actions button').disabled"),
      true,
      'Finishing another task does not unlock a pending action'
    );
    await js(
      "window.currentTasks[0].status='completed';window.currentTasks[0].canRetry=false;window.pendingActions.first()"
    );
    await wait("document.querySelectorAll('.activity-task[data-status=completed]').length===2");
    await js('window.finishOldPoll(window.oldTasks)');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await js("document.querySelectorAll('.activity-task[data-status=completed]').length"),
      2,
      'Old polling data cannot roll back completed work'
    );
    await capture('activity-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('activity-dark');
    win.setSize(900, 700);
    win.webContents.setZoomFactor(2);
    await capture('activity-zoom');
    assert.equal(
      await js(
        "(()=>{const d=document.querySelector('.activity-drawer'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1})()"
      ),
      true
    );
    assert.equal(
      await js(
        "(()=>{const e=document.querySelector('.app-toasts'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1})()"
      ),
      true,
      'Notifications remain reachable at 200% zoom'
    );
    win.webContents.setZoomFactor(1);
    win.setSize(1100, 800);
    await click('Close activity');
    await js(
      "window.normalSearch=window.electronAPI.commandSearch;window.electronAPI.commandSearch=()=>Promise.reject(Error('Local search temporarily unavailable.'));void 0"
    );
    await click('Open commands');
    await wait("document.querySelector('.global-command-error')?.textContent.includes('Retry local search')");
    await js('void (window.electronAPI.commandSearch=window.normalSearch)');
    await click('Retry local search');
    await wait("!document.querySelector('.global-command-error')");
    await fill('missing remote PR');
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
    await js(
      'window.remoteCalls=0;window.electronAPI.commandGitHubSearch=()=>{window.remoteCalls++;return new Promise(resolve=>window.finishRemote=resolve)};void 0'
    );
    await click('Search GitHub…');
    await wait('window.remoteCalls===1');
    await js(
      "document.querySelector('.global-command-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.global-command-dialog')");
    await js(
      "window.finishRemote([{url:'https://github.com/o/r/pull/1',number:1,title:'Obsolete remote result',author:'dev',repoOwner:'o',repoName:'r'}]);void 0"
    );
    await click('Open commands');
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
    assert.equal(
      await js("document.querySelector('.global-command-dialog').textContent.includes('Obsolete remote result')"),
      false
    );
    await js(
      "window.electronAPI.commandGitHubSearch=()=>Promise.resolve([{url:'https://github.com/o/r/pull/2',number:2,title:'Dependency security update',author:'dependabot[bot]',repoOwner:'o',repoName:'r'}]);void 0"
    );
    await fill('dependency');
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
    await click('Search GitHub…');
    await wait(
      "document.querySelector('.global-command-results').textContent.includes('Matching Dependabot PRs are hidden')"
    );
    await js("document.querySelector('.global-command-scope input[type=checkbox]').click()");
    await wait("document.querySelector('.global-command-results').textContent.includes('Dependency security update')");
    await capture('search-dark');
    await fill('> run slow');
    await wait("document.querySelector('.global-command-preview h2')?.textContent==='Run slow action'");
    await js(
      "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run action'));b.click();b.click()})()"
    );
    assert.equal(
      await js("window.actions.filter(a=>a.id==='command').length"),
      1,
      'Repeated activation starts one command'
    );
    await js('window.pendingActions.command()');
    await wait("!document.querySelector('.global-command-dialog')");
    console.log(
      'Shell hardening checks passed: startup recovery, storage denial, stale navigation, action guards, activity freshness, and zoom.'
    );
  } catch (error) {
    console.error(error);
    await capture('failure');
    console.log(await js('document.body.innerText.slice(-4000)'));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
