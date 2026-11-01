import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url);
    await wait("!!document.querySelector('.queue-item')");
    await js(`(async()=>{
      const {createPrInspectionCache} = await import('/lib/pr-inspection-cache.ts');
      const {inspectionData} = await import('/lib/inspection-cache.ts');
      let now = Date.now(), allowSecond = false;
      const revisions = [1,2].map(n=>({url:'https://github.com/example/engine/pull/'+n,baseSha:'base',headSha:'head'+n}));
      const snapshot = r=>({version:1,url:r.url,metadata:r,comparisonBase:'base',fetchedAt:now,
        files:[{path:'worker.ts',status:'modified',additions:1,deletions:1,changeId:r.headSha}]});
      window.preloadCache=createPrInspectionCache({
        changes:r=>Promise.resolve(snapshot(r)),
        commits:r=>Promise.resolve({version:1,url:r.url,metadata:r,commits:[],fetchedAt:now}),
        comparison:()=>Promise.resolve(undefined), review:()=>Promise.resolve(), visible:()=>true, now:()=>now,
        file:s=>{
          if(s.url.endsWith('/1'))return new Promise(resolve=>{window.releaseFirst=resolve});
          return allowSecond?Promise.resolve():new Promise((resolve,reject)=>{window.pausePreload=()=>reject(Error('GitHub API allowance'))});
        }
      });
      inspectionData.activity=()=>window.preloadCache.activity();
      window.electronAPI.listActivity=()=>Promise.resolve([]);
      window.resumePreload=async()=>{allowSecond=true;now+=31000;await window.preloadCache.flush()};
      window.preloadCache.setTargets('oddur',revisions,{active:[revisions[0].url]});
      void window.preloadCache.flush();
    })()`);
    await wait('!!window.releaseFirst');
    await js("document.querySelector('.activity-trigger').click()");
    await wait("document.querySelector('.activity-task h3')?.textContent==='Preparing PRs for instant opening'");
    assert.match(await js<string>("document.querySelector('.activity-task').textContent"), /example\/engine #1.*Changed files.*0 prepared.*2 pending/);
    assert.equal(await js("document.querySelector('.activity-task [role=progressbar]').getAttribute('aria-valuenow')"), '0');
    await js('window.releaseFirst()');
    await wait('!!window.pausePreload');
    await wait("document.querySelector('.activity-task').textContent.includes('1 prepared')");
    assert.match(await js<string>("document.querySelector('.activity-task').textContent"), /example\/engine #2.*1 prepared.*1 pending/);
    assert.equal(await js("document.querySelector('.activity-task [role=progressbar]').getAttribute('aria-valuenow')"), '50');
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-preload-activity.png'), (await win.webContents.capturePage()).toPNG());
    await js('window.pausePreload()');
    await wait("document.querySelector('.activity-task')?.dataset.status==='paused'");
    assert.match(await js<string>("document.querySelector('.activity-task').textContent"), /GitHub’s API allowance.*Retrying automatically.*1 prepared.*1 pending/);
    assert.equal(await js("document.querySelector('.activity-task [role=progressbar]').getAttribute('aria-valuenow')"), '50');
    assert.equal(await js("!!document.querySelector('.activity-task .animate-spin')"), false);
    win.setSize(640, 760);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(await js("document.querySelector('.activity-drawer').getBoundingClientRect().right<=innerWidth"));
    await js('window.resumePreload()');
    await wait("!document.querySelector('.activity-task')");
    assert.equal(await js("document.querySelector('.activity-summary').textContent"), 'No active tasks');
    console.log('Preload Activity passed: current PR, prepared/pending counts, progress, rate-limit pause, resume, completion removal, compact layout.');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
