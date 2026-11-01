import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubAccessMessage } from '../lib/github-auth';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = (label: string) =>
    js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const fill = (id: string, value: string) =>
    js(
      `(()=>{const i=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-auth-' + name + '.png'),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw new Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?onboarding');
    // Returning users must reconnect; first-run setup owns the initial prompt.
    await js("sessionStorage.setItem('fixture-first-run-seen', 'true')");
    await loadWorkbenchPage(win, url + '?onboarding');
    win.webContents.setZoomFactor(1);
    await wait("!!document.querySelector('.github-auth-dialog')");
    await capture('welcome');
    await js(
      "document.querySelector('.github-auth-dialog').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))"
    );
    assert.equal(await js("!!document.querySelector('.github-auth-dialog')"), true);
    await click('Continue with local reviews');
    await wait("!document.querySelector('.github-auth-dialog')");
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>p.guestMode)'), true);
    await wait("!!document.querySelector('.workbench-connect')");
    await js(`(()=>{
      window.authWeb=true;window.cancelledCodes=0;window.savedPat=null;
      const originalComplete=window.electronAPI.completeGitHubSignIn;
      window.electronAPI.githubAuthOptions=()=>Promise.resolve({web:window.authWeb});
      window.electronAPI.startOAuth=()=>Promise.reject(new Error('Browser sign-in could not be completed. Use a sign-in code instead.'));
      window.electronAPI.beginGitHubSignIn=()=>Promise.resolve({id:'device-1',userCode:'TEST-CODE',verificationUri:'https://github.com/login/device',expiresAt:Date.now()+900000});
      window.electronAPI.completeGitHubSignIn=async()=>{await new Promise(r=>{window.approveDevice=r;});return originalComplete();};
      window.electronAPI.cancelGitHubSignIn=()=>{window.cancelledCodes++;return Promise.resolve();};
      window.electronAPI.openExternal=(url)=>{window.openedAuthUrl=url;return Promise.resolve();};
      window.electronAPI.savePat=(token,pr)=>{window.savedPat={token,pr};return Promise.reject(new Error(${JSON.stringify(githubAccessMessage({ status: 403 }, 'example-organization/repository-with-a-long-name'))}));};
    })()`);
    await click('Sign in to GitHub');
    await wait("!!document.querySelector('.github-auth-dialog')");
    await click('Sign in through browser');
    await wait("document.querySelector('.github-auth-error')?.textContent.includes('sign-in code')");
    await click('Sign in with a code');
    await wait("document.querySelector('.github-device-prompt code')?.textContent==='TEST-CODE'");
    await click('Open GitHub');
    assert.equal(await js('window.openedAuthUrl'), 'https://github.com/login/device');
    await capture('device-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('device-dark');
    await click('Use a personal access token');
    assert.equal(await js('window.cancelledCodes'), 1);
    await fill('github-auth-token', 'fixture-invalid-token');
    await fill('github-auth-pr', 'https://github.com/o/r/pull/7');
    await click('Check and connect');
    await wait("document.querySelector('.github-auth-error')?.textContent.includes('Contents: Read')");
    assert.deepEqual(await js('window.savedPat'), {
      token: 'fixture-invalid-token',
      pr: 'https://github.com/o/r/pull/7',
    });
    assert.equal(await js('window.electronAPI.getAuthState().then(a=>a.authenticated)'), false);
    assert.equal(await js("document.querySelector('#github-auth-token').type"), 'password');
    await capture('token-error');
    win.webContents.setZoomFactor(2);
    await capture('token-zoom');
    assert.equal(
      await js(
        "document.querySelector('.github-auth-dialog').scrollWidth <= document.querySelector('.github-auth-dialog').clientWidth + 1"
      ),
      true
    );
    win.webContents.setZoomFactor(1);
    await click('Close');
    await wait("!document.querySelector('.github-auth-dialog')");
    // A preview build immediately offers the device flow, never the broken web action.
    await js('window.authWeb=false');
    await click('Sign in to GitHub');
    await wait("!!document.querySelector('.github-device-prompt code')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.github-auth-dialog button')].some(b=>b.textContent.includes('Sign in through browser'))"
      ),
      false
    );
    win.setSize(800, 700);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      await js("document.querySelector('.github-auth-dialog').getBoundingClientRect().right<=innerWidth"),
      true
    );
    await capture('device-narrow');
    assert.equal(
      await js('document.querySelector(\'[data-github-account]\').getBoundingClientRect().width > 20'),
      true
    );
    await js('window.approveDevice()');
    await wait(
      "!document.querySelector('.github-auth-dialog') && document.querySelector('[data-github-account]').textContent==='oddur'"
    );
    assert.equal(await js("!!document.querySelector('.workbench-connect')"), false);
    await js('document.querySelector(\'[data-github-account]\').click()');
    await wait("document.querySelector('.github-auth-dialog')?.textContent.includes('Connected as oddur')");
    assert.equal(await js("document.querySelector('#github-auth-token')?.value ?? ''"), '');
    await capture('account');
    await click('Sign out of GitHub');
    await wait('window.electronAPI.getAuthState().then(a=>!a.authenticated)');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await js("document.querySelector('.github-auth-dialog')?.textContent.includes('Connect GitHub')"),
      true,
      'Signing out must leave the connection prompt visible'
    );
    assert.equal(await js('window.electronAPI.getAuthState().then(a=>a.authenticated)'), false);
    await capture('signed-out');
    await click('Continue with local reviews');
    await wait("!document.querySelector('.github-auth-dialog')");
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>p.guestMode)'), true);
    await loadWorkbenchPage(win, url + '?onboarding');
    await wait("!!document.querySelector('.workbench-connect')");
    assert.equal(
      await js("!!document.querySelector('.github-auth-dialog')"),
      false,
      'Explicit local mode must survive reopening'
    );
    await js(`document.querySelector('[data-github-account]').click()`);
    await wait("!!document.querySelector('.github-auth-dialog')");
    await click('Sign in through browser');
    await wait("!document.querySelector('.github-auth-dialog')");
    assert.equal(
      await js('window.electronAPI.loadPreferences().then(p=>p.guestMode)'),
      false,
      'Connecting GitHub must leave local mode'
    );
    console.log(
      'GitHub auth browser checks passed: web failure to device fallback, code approval, cancellation, PAT permission recovery, preview default, account management and laptop themes.'
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
