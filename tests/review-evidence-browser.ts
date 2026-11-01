import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  let failed = false;
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error(`Timeout: ${code}\n${errors.join('\n')}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing ${label}');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 200));
    const dir = path.resolve('.impeccable/review/review-evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(()=>{
      window.evidenceSubscriptions=new Map();window.evidenceListeners=new Set();
      window.electronAPI.githubSyncVersion=1;
      window.electronAPI.onGitHubSync=fn=>{window.evidenceListeners.add(fn);return()=>window.evidenceListeners.delete(fn)};
      window.electronAPI.watchGitHub=(id,value)=>{if(value)window.evidenceSubscriptions.set(id,value);else window.evidenceSubscriptions.delete(id)};
      const original=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async(...args)=>(await original(...args)).map(s=>({...s,checkedAt:Date.now(),checks:{state:'failure',total:6,passed:1,failed:3,running:1,skipped:1},latestReview:{url:s.url+'#pullrequestreview-1',author:'maya',state:'APPROVED',submittedAt:'2026-11-01T10:00:00Z',headSha:'earlier-head'}}));
      window.pushEvidence=(kind,value)=>{for(const [id,interest] of window.evidenceSubscriptions){if(interest.kind===kind&&interest.targets.some(t=>t.url===value.url)){for(const fn of window.evidenceListeners)fn({account:'oddur',subscriptionId:id,updates:[{kind,url:value.url,value}]})}}};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("document.querySelector('.review-evidence-summary')?.textContent.includes('another commit')");
    assert.equal(
      await js("[...window.evidenceSubscriptions.values()].some(v=>v.kind==='discussion')"),
      false,
      'Collapsed evidence must not load discussions'
    );
    await capture('collapsed-light');
    await click('View evidence');
    await wait("[...window.evidenceSubscriptions.values()].some(v=>v.kind==='discussion')");
    await js(
      `(()=>{const target=[...window.evidenceSubscriptions.values()].find(v=>v.kind==='discussion').targets[0];window.evidenceTarget=target;window.pushEvidence('discussion',{...target,baseSha:'base',checkedAt:Date.now(),threads:[{id:'t1',path:'src/worker.ts',isResolved:false,isOutdated:true,comments:[{url:target.url+'#discussion_r1'}]}]})})()`
    );
    await wait("document.querySelector('.review-evidence-details')?.textContent.includes('1 unresolved discussion')");
    assert.match(
      await js<string>("document.querySelector('.review-evidence-details').textContent"),
      /attached to older code/
    );
    assert.equal(await js("document.querySelectorAll('.review-evidence-row').length"), 3);
    await capture('expanded-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('expanded-dark');
    await js("document.documentElement.classList.remove('dark')");
    win.setSize(640, 800);
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    // Existing sync events update the panel immediately, without requesting an explanation.
    await js(
      `(()=>{const target=window.evidenceTarget;window.pushEvidence('checks',{...target,checkedAt:Date.now(),checks:[{id:'check:99',name:'Tests',status:'completed',conclusion:'success',required:true,kind:'check',provider:'GitHub Actions'}]});window.pushEvidence('discussion',{...target,baseSha:'base',checkedAt:Date.now(),threads:[]})})()`
    );
    await wait("document.querySelector('.review-evidence-summary')?.textContent.includes('1 passed')");
    await wait("document.querySelector('.review-evidence-details')?.textContent.includes('No code discussions')");
    await capture('updated');
    assert.equal(await js("document.querySelector('.review-evidence-details').textContent.includes('Saved:')"), false);
    win.setContentSize(1280, 1200);
    win.webContents.setZoomFactor(2);
    await wait('innerWidth===640 && innerHeight===600');
    for (let index = 0; index < 3; index++) {
      await js(
        `(()=>{const scroller=document.querySelector('.pr-summary-content[data-state=active]');const row=document.querySelectorAll('.review-evidence-row')[${index}];scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;})()`
      );
      await capture(['zoom-200', 'zoom-200-review', 'zoom-200-discussions'][index]);
    }
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.webContents.setZoomFactor(1);
    win.setSize(1280, 800);
    await js("document.querySelector('.pr-summary-content[data-state=active]').scrollTop=0");
    await click('Hide evidence');
    await wait("![...window.evidenceSubscriptions.values()].some(v=>v.kind==='discussion')");
    await click('View evidence');
    await wait("[...window.evidenceSubscriptions.values()].some(v=>v.kind==='discussion')");
    await js(
      `(()=>{for(const [id,interest] of window.evidenceSubscriptions){if(interest.kind==='discussion'){for(const fn of window.evidenceListeners)fn({subscriptionId:id,updates:[],failures:[{kind:'discussion',url:window.evidenceTarget.url,message:'GitHub API allowance is paused; updates will resume automatically.',retryAt:Date.now()+60000}]})}}})()`
    );
    await wait("document.querySelector('.review-evidence-details').textContent.includes('Updates delayed')");
    await capture('delayed');
    await js("document.querySelector('.review-evidence-row button').click()");
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent.startsWith('Checks')");
    await wait("![...window.evidenceSubscriptions.values()].some(v=>v.kind==='discussion')");
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await wait("document.querySelectorAll('.stack-overview-member').length===3");
    await capture('stack-collapsed');
    await js(
      `window.electronAPI.getReviewThreads=async url=>{const queue=await window.electronAPI.workbenchQueue();const member=queue.items.flatMap(i=>i.subject.members).find(m=>m.url===url);return{headSha:member.headSha,baseSha:'base',checkedAt:Date.now(),threads:[]}};void 0`
    );
    await click('View evidence');
    await wait("document.querySelectorAll('.review-evidence-details > section').length===3");
    assert.equal(await js("document.querySelectorAll('.review-evidence-row').length"), 9);
    await wait(
      "[...document.querySelectorAll('.review-evidence-row')].filter(row=>row.textContent.includes('No code discussions')&&!row.textContent.includes('Saved:')).length===3"
    );
    assert.match(
      await js<string>("document.querySelector('.review-evidence-summary').textContent"),
      /3 PRs with missing evidence/,
      'Timestamped reviews without commit provenance remain missing evidence'
    );
    await capture('stack-expanded');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'Review evidence browser checks passed: live updates, lazy discussion sync, revision links, errors, light/dark, narrow layout, navigation.'
    );
  } catch (error) {
    failed = true;
    console.error(error, errors.join('\n'));
    await capture('failure').catch(() => {});
  } finally {
    app.exit(failed ? 1 : 0);
  }
});
