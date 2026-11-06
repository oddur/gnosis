import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
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
    throw Error(`Timed out: ${code}\n${await js('document.body.innerText.slice(-4000)')}`);
  };
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
      window.emitResponse = (failed = false) => {
        for (const [id,interest] of window.responseWatches) {
          if (interest.kind !== 'discussion') continue;
          for (const cb of window.responseListeners) cb({subscriptionId:id,account:'oddur',updates:failed?[]:[{kind:'discussion',url:window.responseUrl,value:{headSha:window.responseHead,baseSha:'base',threads:[],checkedAt:Date.now()}}],failures:failed?[{kind:'discussion',url:window.responseUrl,message:'GitHub API limit. Retrying automatically.',retryAt:Date.now()+60000}]:[]});
        }
      };
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await wait("[...document.querySelectorAll('.queue-item')].some(e=>e.textContent.includes('peer'))");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await wait("!!document.querySelector('select[id$=involvement]')");
    await js(
      "(()=>{const e=document.querySelector('select[id$=involvement]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'response');e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[aria-label=\"Close filters\"]').click()})()"
    );
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
    await js('window.emitResponse(true)');
    await wait("document.querySelector('.queue-response-status')?.textContent.includes('could not be checked')");
    assert.equal(
      await js("document.querySelectorAll('.queue-item').length"),
      1,
      'Keep cached matches while API is paused'
    );
    await js('window.responseState={changesRequested:false,unresolvedThreads:0,complete:false};window.emitResponse()');
    await wait("document.querySelector('.queue-empty h2')?.textContent==='No matching feedback loaded yet'");
    await js('window.responseState={changesRequested:false,unresolvedThreads:0,complete:true};window.emitResponse()');
    await wait("document.querySelector('.queue-empty h2')?.textContent==='No PRs match these filters'");
    await js('window.responseState={changesRequested:false,unresolvedThreads:1,complete:true};window.emitResponse()');
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
    console.log(
      'Response filter passed: cached stack matching, scoped sync, paused/unknown states, resolution updates and direct Feedback navigation.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
