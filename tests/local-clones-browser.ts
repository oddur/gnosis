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
  // Assigning a mock evaluates to a function, which cannot cross the IPC boundary.
  const mock = (code: string) => js(`${code};null`);
  const wait = async (code: string) => {
    for (let i = 0; i < 500; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const section = "document.querySelector('#local-clones-title').parentElement";
  const repoPath = '/Users/dev/Development/a-rather-long-checkout-folder-name/engine';
  const entry = { repo: 'klang/engine', path: repoPath, remote: 'origin', reads: 0, fallbacks: 0 };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await click('Settings');
    await wait("!!document.querySelector('[role=dialog] [role=tab]')");
    await click('Integrations');
    await wait("!!document.querySelector('#local-clones-title')");
    assert.match(await js<string>(`${section}.textContent`), /still come from GitHub/);

    await mock(`window.addCalls=[];window.electronAPI.pickRepoDir=async()=>null;
      window.electronAPI.addLocalClone=async d=>{window.addCalls.push(d);return []}`);
    await click('Add clone…');
    await wait(`!${section}.querySelector('button:disabled')`);
    assert.equal(await js('window.addCalls.length'), 0, 'Cancelling the picker adds nothing.');

    await mock(`window.electronAPI.pickRepoDir=async()=>'/tmp/shallow';
      window.electronAPI.addLocalClone=async()=>{throw Error("Error invoking remote method 'add-local-clone': Error: This clone is shallow. Run \`git fetch --unshallow\` in it, then add it again.")}`);
    await click('Add clone…');
    await wait(`${section}.querySelector('[role=alert]')?.textContent.startsWith('This clone is shallow')`);

    await mock(`window.electronAPI.pickRepoDir=async()=>${JSON.stringify(repoPath)};
      window.electronAPI.addLocalClone=async d=>{window.addCalls.push(d);return [${JSON.stringify(entry)}]}`);
    await click('Add clone…');
    await wait(`${section}.textContent.includes('klang/engine')`);
    assert.deepEqual(await js('window.addCalls'), [repoPath]);
    assert.equal(await js(`${section}.querySelector('[role=alert]')`), null);
    assert.match(await js<string>(`${section}.textContent`), /Uses the origin remote/);

    // Reopening reads current counters from the main process.
    await mock(`window.electronAPI.getLocalClones=async()=>[${JSON.stringify({ ...entry, reads: 1204, fallbacks: 2, lastError: 'Cannot open the folder.' })}]`);
    await click('Review');
    await click('Integrations');
    await wait(`${section}.textContent.includes('1,204 reads from Git this session, 2 from GitHub after a clone problem')`);
    assert.match(await js<string>(`${section}.textContent`), /Last problem: Cannot open the folder\./);

    const dir = path.resolve('.impeccable/review/local-clones');
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
      assert.equal(await js(`(()=>{const r=${section}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`), true);
      fs.writeFileSync(path.join(dir, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }

    await mock(`window.removed=[];window.electronAPI.removeLocalClone=async d=>{window.removed.push(d);return []}`);
    await click(`Remove clone at ${repoPath}`);
    await wait(`!${section}.textContent.includes('klang/engine')`);
    assert.deepEqual(await js('window.removed'), [repoPath]);
    console.log('LOCAL CLONES BROWSER PASS');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
