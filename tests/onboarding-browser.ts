import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let n = 0; n < 160; n++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = (label: string) =>
    js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-onboarding-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw new Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?onboarding');
    await wait("!!document.querySelector('.workbench-connect')");
    await wait("!!document.querySelector('.setup-dialog')");
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    if (await js("!!document.querySelector('.github-auth-dialog')")) {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await click('Continue with local reviews');
      await wait("!document.querySelector('.github-auth-dialog')");
    }
    win.webContents.setZoomFactor(1);
    await wait("document.querySelector('.getting-started')?.textContent.includes('needs setup')");
    assert.equal(await js("document.querySelectorAll('.queue-empty').length"), 0);
    assert.equal(await js("document.querySelector('.getting-started-setup').open"), false);
    assert.equal(await js("document.querySelector('.workbench-connect').closest('.getting-started') !== null"), true);
    await capture('light');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(900, 700);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    assert.equal(
      await js("document.querySelector('.getting-started-actions').getBoundingClientRect().bottom < innerHeight-90"),
      true
    );
    await capture('narrow');
    // Opening a PR reaches useful content even when no AI tool is installed.
    await js(
      "window.generationCalls=0;void (window.electronAPI.startReview=()=>{window.generationCalls++;return Promise.reject(new Error('Generation must not run'));})"
    );
    await click('Open a pull request');
    await wait('!!document.querySelector(\'[aria-label="Pull request URL"]\')');
    await js(
      `(()=>{const i=document.querySelector('[aria-label="Pull request URL"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'https://github.com/klang/engine/pull/120');i.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    assert.equal(await js('window.generationCalls'), 0);
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>p.firstRunSeen)'), false);
    await click('AI setup');
    await wait("!!document.querySelector('#ai-setup-title')");
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await click('Run setup again');
    await wait("!!document.querySelector('.setup-dialog') && !!document.querySelector('.pr-summary-page')");
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    await click('Review queue');
    await wait("!!document.querySelector('.getting-started')");
    // Expand only the setup needed, and keep each recovery route usable.
    await js("document.querySelector('.getting-started-setup summary').click()");
    await click('AI setup');
    await wait("!!document.querySelector('#ai-setup-title')");
    await js(
      "window.electronAPI.checkCliInstalled=()=>Promise.reject(new Error('check failed'));document.querySelector('[data-slot=dialog-close]').click()"
    );
    await wait("document.querySelector('.getting-started-setup').textContent.includes('Could not check')");
    await js(
      "void (window.electronAPI.checkCliInstalled=()=>Promise.resolve({installed:true,resolvedPath:'/fixture/codex'}))"
    );
    await click('Check again');
    await wait("document.querySelector('.getting-started-setup').textContent.includes('found. Make sure')");
    await js(
      `window.selectOption('[aria-label="Review model"]', 'gpt-6.1-sol')`
    );
    await wait("document.querySelector('.getting-started-setup').textContent.includes('Codex found')");
    await click('AI setup');
    await wait("!!document.querySelector('#ai-setup-title')");
    await click('Run setup again →');
    await wait("!document.querySelector('#ai-setup-title') && !!document.querySelector('.setup-dialog')");
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    await js("document.querySelector('.getting-started-connection summary').click()");
    await click('Sign in to GitHub');
    await wait("!!document.querySelector('.github-auth-dialog')");
    await click('Sign in through browser');
    await wait("!!document.querySelector('.getting-started-connected')");
    await wait("!document.querySelector('.github-auth-dialog')");
    assert.equal(await js("document.querySelectorAll('.queue-empty').length"), 0);
    await capture('connected');
    await click('I’ll explore on my own');
    await wait("!document.querySelector('.getting-started')");
    await loadWorkbenchPage(win, url + '?onboarding');
    await wait("!!document.querySelector('.workbench-connect')");
    if (await js("!!document.querySelector('.github-auth-dialog')")) {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await click('Continue with local reviews');
      await wait("!document.querySelector('.github-auth-dialog')");
    }
    win.webContents.setZoomFactor(1);
    await wait("!!document.querySelector('.workbench-connect')");
    assert.equal(await js("!!document.querySelector('.getting-started')"), false);
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await wait("!!document.querySelector('.workbench-help')");
    assert.equal(
      await js(
        "['Saved view','Viewed file','Inline explanation'].every(t=>[...document.querySelectorAll('.workbench-help summary')].some(s=>s.textContent===t))"
      ),
      true
    );
    await js(
      "[...document.querySelectorAll('.workbench-help summary')].find(s=>s.textContent==='Get more from a review').click()"
    );
    win.webContents.setZoomFactor(2);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      await js(
        "document.querySelector('.workbench-help').getBoundingClientRect().right<=innerWidth && document.querySelector('.workbench-help').getBoundingClientRect().bottom<=innerHeight"
      ),
      true
    );
    await capture('help-zoom');
    console.log(
      'Onboarding checks passed: first value without AI, progressive setup, recovery, provider switch, replay/focus, dismissal, terminology and laptop/zoom layouts.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await capture('failure').catch(() => {});
  } finally {
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
