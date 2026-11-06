import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    useContentSize: true,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let n = 0; n < 240; n++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText.slice(-4000)')}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = path.resolve('.impeccable/review/response');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const sidebar = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('.workbench-sidebar button')].find(b=>b.textContent.includes(${JSON.stringify(label)}));if(!b)throw Error('Missing sidebar destination');b.click()})()`
    );
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&response-filter`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async () => {
      const original = window.electronAPI.workbenchQueue;
      const q = await original();
      const stack = q.items.find(item => item.subject.kind === 'stack');
      window.responseUrl = stack.subject.members[0].url;
      window.responseHead = stack.subject.members[0].headSha;
      window.responseState = {changesRequested:true,unresolvedThreads:2,complete:true};
      const m = stack.subject.members[0];
      const c = {id:'c-response',body:'Keep the cancellation guard before publishing the result.',author:{login:'maya',avatarUrl:''},createdAt:'2026-11-03T10:00:00Z',url:m.url+'#discussion-1'};
      const t = {id:'t-response',path:'src/worker.ts',line:36,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{...c,diffHunk:'@@ -1 +1 @@\\n-old\\n+new',pullRequestReview:{id:'r-response'}}]};
      window.responseData = {headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[t,{...t,id:'t-second',path:'src/queue.ts'}, {...t,id:'t-own',comments:[{...c,author:{login:'oddur',avatarUrl:''}}]}, {...t,id:'t-resolved',isResolved:true}],feedback:{comments:[],reviews:[{...c,id:'r-response',state:'CHANGES_REQUESTED',submittedAt:c.createdAt,body:'Please retain the cancellation guard.'}],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}};
      window.responseReads = 0;
      window.electronAPI.getCachedReviewThreads = async url => url === m.url ? structuredClone(window.responseData) : undefined;
      window.electronAPI.getReviewThreads = async url => {window.responseReads++;return url === m.url ? structuredClone(window.responseData) : {headSha:'',baseSha:'',threads:[],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:false,state:'OPEN'}}};
      window.electronAPI.reviewThreadAction = async req => {const t=window.responseData.threads.find(t=>t.id===req.threadId);t.isResolved=req.action==='resolve';t.viewerCanResolve=!t.isResolved;t.viewerCanUnresolve=t.isResolved;window.responseState.unresolvedThreads=window.responseData.threads.filter(t=>!t.isResolved&&t.id!=='t-own').length;return structuredClone(t)};
      window.responseWatches = new Map(); window.responseListeners = new Set();
      window.electronAPI.githubSyncVersion = 1;
      window.electronAPI.watchGitHub = (id, interest) => { if (interest) window.responseWatches.set(id,interest); else window.responseWatches.delete(id); };
      window.electronAPI.onGitHubSync = cb => { window.responseListeners.add(cb); return () => window.responseListeners.delete(cb); };
      window.electronAPI.workbenchQueue = async (...args) => {
        const value = structuredClone(await original(...args));
        for (const item of value.items) {
          item.responses = {};
          for (const member of item.subject.members) {
            member.author = member.url === window.responseUrl ? 'oddur' : 'peer';
            if (member.url === window.responseUrl) item.responses[member.url] = {...window.responseState};
          }
        }
        return value;
      };
      window.electronAPI.workbenchSnapshot = () => window.electronAPI.workbenchQueue();
      window.emitResponse = (failed = false, delay = 60000) => {
        for (const [id,interest] of window.responseWatches) {
          if (interest.kind !== 'discussion') continue;
          for (const cb of window.responseListeners) cb({subscriptionId:id,account:'oddur',updates:failed?[]:[{kind:'discussion',url:window.responseUrl,value:structuredClone(window.responseData)}],failures:failed?[{kind:'discussion',url:window.responseUrl,message:'GitHub API limit. Retrying automatically.',retryAt:Date.now()+delay}]:[]});
        }
      };
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await wait("[...document.querySelectorAll('.queue-item')].some(e=>e.textContent.includes('peer'))");
    await sidebar('Needs my response');
    await wait("document.querySelector('h1')?.textContent==='Needs my response'");
    await wait(
      "document.querySelectorAll('.queue-item').length===1 && document.querySelector('.queue-response-reasons')?.textContent.includes('2 unresolved threads')"
    );
    assert.ok(await js("document.querySelector('.queue-stack-matches')?.textContent.includes('1 of')"));
    assert.ok(
      await js(
        "[...window.responseWatches.values()].filter(w=>w.kind==='discussion').every(w=>w.targets.every(t=>t.url===window.responseUrl))"
      ),
      'Only eligible authored PRs register discussion sync'
    );
    await capture('queue-light');
    await js('window.emitResponse(true)');
    await wait("document.querySelector('.queue-response-status')?.textContent.includes('Feedback checks paused')");
    assert.equal(
      await js("document.querySelectorAll('.queue-item').length"),
      1,
      'Keep cached matches while API is paused'
    );
    assert.equal(
      await js("document.querySelector('.queue-response-status button').disabled"),
      true,
      'Retry respects server backoff'
    );
    await capture('paused-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('paused-dark');
    win.setContentSize(760, 800);
    await capture('paused-narrow');
    win.setContentSize(1280, 800);
    await js("document.documentElement.classList.remove('dark');window.emitResponse(true,-1)");
    await wait("document.querySelector('.queue-response-status button')?.disabled===false");
    await js("document.querySelector('.queue-response-status button').click()");
    await wait("document.querySelector('.queue-response-status')?.textContent.includes('Feedback checked at')");
    assert.ok(await js('window.responseReads > 0'), 'Retry refreshes failed feedback');
    await js('window.responseState={changesRequested:false,unresolvedThreads:0,complete:false};window.emitResponse()');
    await wait("document.querySelector('.queue-empty h2')?.textContent==='Feedback is not fully checked'");
    await js('window.responseState={changesRequested:false,unresolvedThreads:0,complete:true};window.emitResponse()');
    await wait("document.querySelector('.queue-empty h2')?.textContent==='No PRs need your response in this view'");
    await capture('complete-light');
    await sidebar('Review queue');
    await wait("document.querySelectorAll('.queue-item').length>1");
    await sidebar('Needs my response');
    await js('window.responseState={changesRequested:true,unresolvedThreads:2,complete:true};window.emitResponse()');
    await wait("!!document.querySelector('.queue-response-reasons button')");
    await js(
      "window.responseQueueWatchIds=[...window.responseWatches.keys()];document.querySelector('.queue-response-reasons button').click()"
    );
    await wait("!!document.querySelector('.feedback-workspace')");
    assert.ok(
      await js("document.querySelector('.pr-overview-tabs [data-state=active]')?.textContent.includes('Feedback')")
    );
    assert.equal(
      await js('window.responseQueueWatchIds.filter(id=>window.responseWatches.has(id)).length'),
      0,
      'Queue response subscription stops outside queue'
    );
    await wait("document.querySelector('[data-feedback-id=\"r-response\"]')?.getAttribute('aria-current')==='true'");
    assert.match(
      await js<string>("document.querySelector('.feedback-conversation').textContent"),
      /retain the cancellation guard/
    );
    await capture('review-light');
    await js(
      "[...document.querySelectorAll('.review-breadcrumbs button')].find(b=>b.textContent.trim()==='Needs my response').click()"
    );
    await wait("!!document.querySelector('.queue-response-reasons button[aria-label^=Address]')");
    await js("document.querySelector('.queue-response-reasons button[aria-label^=Address]').click()");
    await wait("document.querySelector('[data-feedback-id=\"t-response\"]')?.getAttribute('aria-current')==='true'");
    assert.equal(
      await js("document.querySelectorAll('.feedback-row').length"),
      2,
      'Only unresolved external threads appear'
    );
    await capture('thread-light');
    for (let n = 0; n < 2; n++) {
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Resolve & next').click()");
      await wait(
        n === 0
          ? "document.querySelector('[data-feedback-id=\"t-second\"]')?.getAttribute('aria-current')==='true'"
          : "!!document.querySelector('.feedback-complete')"
      );
    }
    assert.match(
      await js<string>("document.querySelector('.feedback-complete').textContent"),
      /Review approval is still pending/
    );
    await capture('resolved-light');
    await js("[...document.querySelectorAll('.feedback-complete button')].find(b=>b.textContent.trim()==='Re-request review').click()");
    await wait("!!document.querySelector('[data-request-review]')");
    assert.match(await js<string>("document.querySelector('[data-request-review]').textContent"), /Re-request review/);
    console.log(
      'Response filter passed: sidebar, targeted review/thread navigation, completion, backoff/retry and cached states.'
    );
    app.exit(0);
  } catch (error) {
    await capture('failure');
    console.error(error);
    app.exit(1);
  }
});
