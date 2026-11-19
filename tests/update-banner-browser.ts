import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
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

    // A downloaded pre-release says so (#404).
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?update=prerelease`);
    await waitForWorkbenchQueue(win.webContents);
    await wait("document.querySelector('.updateBanner')?.dataset.updateState === 'ready'");
    assert.match(await bannerText(), /v9\.9\.9-beta\.2 \(pre-release\) is ready to install/);
    // A stable update does not.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?update=ready`);
    await waitForWorkbenchQueue(win.webContents);
    await wait("document.querySelector('.updateBanner')?.dataset.updateState === 'ready'");
    assert.doesNotMatch(await bannerText(), /pre-release/);

    // ── Settings › Updates: the running build, the channel and Check now. ──
    const updatesTab = "[...document.querySelectorAll('[role=dialog] [role=tab]')].find(t=>t.textContent.trim()==='Updates')";
    const openUpdates = async () => {
      await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
      await wait(`!!${updatesTab}`);
      await js(`(()=>{const t=${updatesTab};t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
      await wait("!!document.querySelector('[data-testid=update-version]')");
    };
    const checkedChannel = () => js<string>("document.querySelector('input[name=update-channel]:checked')?.value ?? ''");
    const text = (selector: string) => js<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);

    // A stable build on Stable: no Pre-release tag, Stable checked, plain copy for both choices.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?app-version=0.41.0`);
    await waitForWorkbenchQueue(win.webContents);
    await openUpdates();
    assert.equal(await text('[data-testid=update-version]'), 'Gnosis v0.41.0');
    assert.equal(await checkedChannel(), 'stable');
    const options = await js<string>("document.querySelector('.update-channel-options').textContent");
    assert.match(options, /Stable.*Tested releases/);
    assert.match(options, /Pre-release.*Early builds from main/);
    assert.equal(await js("!!document.querySelector('[data-testid=update-channel-note]')"), false);
    // Check now reports the result.
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Check now').click()");
    await wait("document.querySelector('[data-testid=update-check-result]')?.dataset.outcome === 'up-to-date'");
    assert.match(await text('[data-testid=update-check-result]'), /Gnosis v0\.41\.0 is the newest stable release\./);
    // Choosing Pre-release goes through main and shows what it found.
    await js("document.querySelector('input[name=update-channel][value=prerelease]').click()");
    await wait("document.querySelector('input[name=update-channel]:checked')?.value === 'prerelease'");
    await wait("document.querySelector('[data-testid=update-check-result]')?.dataset.outcome === 'ready'");
    assert.deepEqual(await js('window.fixtureUpdateChannelCalls'), ['check', 'channel prerelease']);
    assert.match(await text('[data-testid=update-check-result]'), /v0\.42\.0-beta\.3 \(pre-release\) is ready/);

    // A pre-release build moving back to Stable: the Pre-release tag, and the no-downgrade promise.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?app-version=0.42.0-beta.3&update-channel=prerelease`);
    await waitForWorkbenchQueue(win.webContents);
    await openUpdates();
    assert.equal(await text('[data-testid=update-version]'), 'Gnosis v0.42.0-beta.3Pre-release');
    assert.equal(await checkedChannel(), 'prerelease');
    await js("document.querySelector('input[name=update-channel][value=stable]').click()");
    await wait("!!document.querySelector('[data-testid=update-channel-note]')");
    assert.equal(
      await text('[data-testid=update-channel-note]'),
      "You're on v0.42.0-beta.3, a pre-release. Gnosis won't go back to an older version: you'll get the next stable release, 0.42.0 or later."
    );
    assert.deepEqual(await js('window.fixtureUpdateChannelCalls'), ['channel stable']);

    console.log('Update banner checks passed: no promise before download, Restart now, failure with GitHub link, pre-release copy, Settings › Updates channel.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
