import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
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
    await click('Settings');
    await wait("!!document.querySelector('[role=dialog] [role=tab]')");
    await click('Integrations');
    await wait("!!document.querySelector('#github-cache-title')");
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
