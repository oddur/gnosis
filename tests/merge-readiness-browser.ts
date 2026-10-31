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
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
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
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('Update required to merge')");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto main, or merge main/
    );
    assert.equal(
      await js("document.querySelector('.pr-merge-detail a').getAttribute('href')"),
      'https://github.com/klang/engine/pull/150'
    );
    assert.equal(await js("document.querySelector('.pr-merge-status .pr-review-status').textContent"), 'Approved');
    await capture('desktop-update-required');
    for (const tab of ['Changes', 'Commits', 'Explanation', 'Summary']) {
      await click(tab);
      assert.equal(await js("document.querySelector('.pr-merge-status .pr-review-status').textContent"), 'Approved');
      assert.match(
        await js<string>("document.querySelector('.pr-merge-status').textContent"),
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
      "document.querySelector('.pr-merge-status')?.textContent.includes('Merge conflicts')"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /resolve the conflicts/);
    assert.equal(await js("document.querySelector('.pr-merge-status .pr-review-status').textContent"), 'Approved');
    await capture('conflicts');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Ready to merge')"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /updating is optional/);
    await capture('optional-update');
    await js('window.failStatus=true;const realNow=Date.now;Date.now=()=>realNow()+6*60*1000;void 0');
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Readiness out of date')"
    );
    assert.equal(await js("!!document.querySelector('.pr-merge-status .is-success')"), false);
    assert.equal(await js("document.querySelector('.pr-merge-status .pr-review-status').textContent"), 'Approved · Out of date');
    assert.match(await js<string>("document.querySelector('.pr-merge-status .pr-review-status').title"), /Last checked/);
    await capture('stale');
    await js("window.failStatus=false;window.mode='behind'");
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Update required to merge')"
    );
    assert.ok((await js<number>('window.forceReads')) >= 4);
    await click('Review queue');
    await wait(
      "[...document.querySelectorAll('.queue-item')].find(e=>e.textContent.includes('Fix reconnect'))?.textContent.includes('Update required to merge')"
    );
    await capture('queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open stack overview');
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('Cannot merge stack')");
    await js("document.querySelector('[aria-label=\"Open PR #121\"]').click()");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto queue-0, or merge queue-0/
    );
    await capture('stack');
    await click('Back to stack');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('All open PRs meet merge requirements')");
    await capture('stack-next');
    await js(`window.reviewDecisions={
      'https://github.com/klang/engine/pull/120':'CHANGES_REQUESTED',
      'https://github.com/klang/engine/pull/121':'REVIEW_REQUIRED',
      'https://github.com/klang/engine/pull/122':null
    }`);
    await click('Refresh status');
    await wait("document.querySelector('.pr-merge-status .pr-review-statuses')?.textContent.includes('1 PR · No review decision')");
    assert.deepEqual(await js("[...document.querySelectorAll('.pr-merge-status .pr-review-status')].map(s=>s.textContent)"),
      ['1 PR · Changes requested', '1 PR · Awaiting review', '1 PR · No review decision']);
    assert.equal(await js("document.querySelector('.stack-overview-member .pr-review-status').textContent"), 'Changes requested');
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
