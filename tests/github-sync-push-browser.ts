import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&(b.textContent.trim()===${JSON.stringify(label)}||(b.getAttribute('role')==='tab'&&b.textContent.trim().startsWith(${JSON.stringify(label)}))||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!button)throw Error('Missing '+${JSON.stringify(label)});button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));button.click()})()`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters&checks&github-sync`);
    await waitForWorkbenchQueue(win.webContents);
    await wait('window.syncFixture.subscriptions.size>0');
    const before = await js<{ queue: number; activity: number }>('({...window.syncFixture.counts})');
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.deepEqual(
      await js('({queue:window.syncFixture.counts.queue,activity:window.syncFixture.counts.activity})'),
      { queue: before.queue, activity: before.activity },
      'native views do not keep polling queue/activity'
    );
    await js('window.syncFixture.rename()');
    await wait("document.body.textContent.includes('Updated through background sync')");
    assert.equal(await js('window.syncFixture.counts.queue'), before.queue, 'queue push reads local snapshot only');
    await js('window.syncFixture.activity()');
    await wait(`window.syncFixture.counts.activity>${before.activity}`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Updated through background sync')).click()"
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await click('Open PR overview');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await wait("[...window.syncFixture.subscriptions.values()].some(s=>s.kind==='metadata')");
    await js('window.syncFixture.revision()');
    await wait(
      "document.body.textContent.includes('New commits') || document.body.textContent.includes('New changes')"
    );
    assert.ok(
      await js("!!document.querySelector('.changes-file-tree')"),
      'revision notification keeps the current diff open'
    );
    await click('Checks');
    await wait("[...window.syncFixture.subscriptions.values()].some(s=>s.kind==='checks')");
    await js('window.syncFixture.checks()');
    await wait("document.body.textContent.includes('Live check completed')");
    console.log(
      'GitHub sync browser checks passed: no queue/activity polling, cache-only push updates, stable diff revision and live checks.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    // A failed page load can also make DOM diagnostics fail. Preserve the failing exit code.
    try { console.log(await js('document.body.innerText')); } catch { /* The renderer is unavailable. */ }
    app.exit(1);
  }
});
