import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const bannerText = () => js<string>("document.querySelector('.updateBanner')?.textContent ?? ''");
  const clickBanner = (label: string) =>
    js(`[...document.querySelectorAll('.updateBanner button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  try {
    // No update downloaded: no promise.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}`);
    await waitForWorkbenchQueue(win.webContents);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await js('document.querySelectorAll(".updateBanner").length'), 0);

    // Downloaded: Restart now installs through main.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?update=ready`);
    await waitForWorkbenchQueue(win.webContents);
    await wait("document.querySelector('.updateBanner')?.dataset.updateState === 'ready'");
    assert.match(await bannerText(), /v9\.9\.9 is ready to install/);
    await clickBanner('Restart now');
    await wait("document.querySelector('.updateBanner')?.dataset.updateState === 'installing'");
    assert.deepEqual(await js('window.fixtureUpdateCalls'), ['installUpdate']);
    assert.match(await bannerText(), /is installing/);
    assert.equal(await js("[...document.querySelectorAll('.updateBanner button')].some(b=>b.textContent.trim()==='Restart now')"), false);

    // Failed: says so and links to the release.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?update=failed`);
    await waitForWorkbenchQueue(win.webContents);
    await wait("document.querySelector('.updateBanner')?.dataset.updateState === 'failed'");
    assert.match(await bannerText(), /did not install/);
    await clickBanner('Download from GitHub');
    assert.deepEqual(await js('window.fixtureUpdateCalls'), ['https://github.com/oddur/gnosis/releases/tag/v9.9.9']);
    await js("document.querySelector('.updateBanner button[aria-label=Dismiss]').click()");
    await wait("!document.querySelector('.updateBanner')");
    console.log('Update banner checks passed: no promise before download, Restart now, failure with GitHub link.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
