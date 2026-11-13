import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog] [role=tab]:not(.workspace-tab-select)')");
    await click('Integrations');
    await wait("!!document.querySelector('#github-cache-title')");
    // Preloading likely next pages is on by default and saved like other settings.
    const toggle = "document.querySelector('[role=switch][aria-label=\"Preload likely next pages\"]')";
    assert.equal(await js(`${toggle}?.getAttribute('aria-checked')`), 'true');
    assert.match(await js<string>(`${toggle}.closest('.settings-row').textContent`), /Uses some of your GitHub API limit to make navigation instant/);
    await js(`${toggle}.click()`);
    await wait(`${toggle}.getAttribute('aria-checked')==='false'`);
    await wait('window.electronAPI.loadPreferences().then(p => p.predictNavigation === false)');
    assert.match(await js<string>("document.querySelector('#github-cache-size').textContent"), /512 MB/);
    await js("window.selectOption('#github-cache-size','1024')");
    await wait("document.querySelector('#github-cache-size').textContent.includes('1 GB')");
    await wait("window.electronAPI.loadPreferences().then(p => p.githubCacheSizeMB === 1024)");
    assert.match(
      await js<string>("document.querySelector('#github-cache-title').parentElement.textContent"),
      /Saved reviews, briefings, bookmarks, settings, and sign-in stay/
    );
    await js(
      "window.clearCalls=0;window.electronAPI.clearGitHubCache=async()=>{window.clearCalls++;throw Error('Wait for active AI tasks to finish, then clear the cache again.')};void 0;"
    );
    await click('Clear cache & restart');
    await wait("document.querySelector('[role=alert]')?.textContent.includes('Wait for active AI tasks')");
    assert.equal(await js('window.clearCalls'), 1);
    const dir = path.resolve('.impeccable/review/cache-reset');
    fs.mkdirSync(dir, { recursive: true });
    for (const [width, theme] of [
      [1280, 'light'],
      [640, 'dark'],
    ] as const) {
      win.setSize(width, 800);
      await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
      await js('document.fonts.ready');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.equal(
        await js(
          "(()=>{const r=document.querySelector('#github-cache-title').parentElement.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"
        ),
        true
      );
      fs.writeFileSync(path.join(dir, `${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await js('window.electronAPI.clearGitHubCache=async()=>{window.clearCalls++};void 0;');
    await click('Clear cache & restart');
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Restarting…'&&b.disabled)");
    assert.equal(await js('window.clearCalls'), 2);
    assert.equal(await js("!!document.querySelector('[role=alert]')"), false);

    // With "Preload likely next pages" off, opening a PR predicts nothing; resting on a queue row still prepares it.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await js(`(()=>{
      const hex=s=>{const h=Array.from(s,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');return h.length>=40?h.slice(-40):h.padEnd(40,'0')};
      const load=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async(...args)=>{const q=await load(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>({...m,headSha:hex(m.headSha),baseSha:hex(m.baseSha)}))}}))}};
      window.predicted=[];window.rowIntents=[];
      for(const name of ['getPrChanges','getPrCommits']){const read=window.electronAPI[name];window.electronAPI[name]=(url,refresh,options)=>{if(options?.predicted)window.predicted.push(name);return read(url,refresh,options)}}
      const file=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=(request,mode)=>{if(mode&&typeof mode==='object')window.predicted.push('file');return file(request,mode)};
      window.electronAPI.prOpenCommitted=()=>{window.predicted.push('open');return Promise.resolve()};
      window.electronAPI.prOpenIntent=targets=>{window.rowIntents.push(targets&&targets.map(t=>t.url))};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(await js('window.predicted'), [], 'No prediction runs while the setting is off');
    assert.equal(await js('window.__gnosisPredict.summary().predictions'), 0);
    assert.ok((await js<number>('window.__gnosisPredict.records().length')) > 0, 'Navigation is still measured');
    await click('Review queue');
    const row = "[...document.querySelectorAll('[data-queue-id]')].find(r=>r.textContent.includes('Reduce allocations'))";
    await wait(`!!${row}`);
    await js(`(async()=>{const row=${row};row.querySelector('.queue-row-main').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await new Promise(r=>setTimeout(r,300));})()`);
    await wait('window.rowIntents.some(urls=>urls&&urls.length>0)');
    assert.deepEqual(await js('window.predicted'), [], 'Queue-row hover is unchanged and is not a prediction');
    console.log(
      'Cache reset Settings checks passed: clear scope, restart label, error recovery, disabled pending action, laptop/compact layouts.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
