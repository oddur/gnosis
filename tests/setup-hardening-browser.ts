import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

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
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width && (e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  };
  const fill = async (selector: string, value: string) => {
    await js(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  };
  const escape = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  const shots = path.resolve('.impeccable/review/setup-hardening');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      window.savedPrefs=structuredClone(await window.electronAPI.loadPreferences());
      window.saveFails=false;window.saves=0;
      window.electronAPI.loadPreferences=async()=>structuredClone(window.savedPrefs);
      window.electronAPI.savePreferences=async p=>{window.saves++;if(window.saveFails)throw Error('Disk full');window.savedPrefs=structuredClone(p)};
      window.electronAPI.searchRepos=async()=>[{fullName:'team/'+ 'long-repository-'.repeat(12),description:'日本語の説明 · وصف المستودع 🧪'}];
      window.electronAPI.openLogsDirectory=async()=>{throw Error('Finder unavailable')};
      window.electronAPI.openExternal=async()=>{throw Error('Browser unavailable')};
      window.refs=[];window.validations=[];window.validationMode='ok';window.reviewStarts=[];
      window.validationResult={ok:true,changedFileCount:3,mergeBase:'abc1234'};
      window.electronAPI.listRepoRefs=path=>new Promise(resolve=>window.refs.push({path,resolve}));
      window.electronAPI.validateLocalRepo=(...args)=>{window.validations.push(args);if(window.validationMode==='reject')return Promise.reject(Error('Git process unavailable'));if(window.validationMode==='pending')return new Promise(resolve=>window.finishValidation=resolve);return Promise.resolve(window.validationResult)};
      window.electronAPI.pickRepoDir=async()=>{throw Error('Folder picker unavailable')};
      window.electronAPI.startReview=async r=>{window.reviewStarts.push(r);return {reviewId:'local-test'}};
    })()`);

    await click('Settings');
    await wait("!!document.querySelector('.settings-tabs')");
    await click('Review');
    await fill('.settings-panel[data-state=active] textarea', 'Keep cancellation safe 日本語 🧪');
    escape();
    await wait("!document.querySelector('.settings-dialog')");
    assert.equal(
      await js('window.savedPrefs.instructions'),
      'Keep cancellation safe 日本語 🧪',
      'Escape saves focused text before closing'
    );

    await click('Settings');
    await wait("!!document.querySelector('.settings-tabs')");
    await click('Review');
    await js('window.saveFails=true');
    await fill('.settings-panel[data-state=active] textarea', 'Keep this unsaved instruction');
    escape();
    await wait("!!document.querySelector('.settings-save-error')");
    assert.equal(
      await js("document.querySelector('.settings-panel[data-state=active] textarea').value"),
      'Keep this unsaved instruction'
    );
    await capture('settings-save-error');
    await js('window.saveFails=false');
    await click('Retry saving');
    await wait("!document.querySelector('.settings-save-error')");
    await click('Queue & briefings');
    await click('Repositories');
    await click('Add repository');
    await fill('#watched-repos', 'long');
    await wait("!!document.querySelector('#watched-repos').closest('.relative').querySelector('li button')");
    win.focus();
    win.webContents.focus();
    await js("document.querySelector('#watched-repos').closest('.relative').querySelector('li button').focus()");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      await js(
        "document.activeElement === document.querySelector('#watched-repos').closest('.relative').querySelector('li button')"
      ),
      true,
      'Suggestion remains focused after leaving the search input'
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait("!!document.querySelector('.repository-editor')");
    await js("[...document.querySelectorAll('.repository-editor button')].find(b=>b.textContent==='Watch repository').click()");
    await wait("window.savedPrefs.watchedRepos.some(r=>r.includes('long-repository-'))");
    assert.equal(
      await js('document.activeElement.id'),
      'watched-repos',
      'Adding a suggestion returns focus to the repository input'
    );
    await js(
      "void (window.electronAPI.searchRepos=async()=>[{fullName:'team/another',description:'Another repository'}])"
    );
    await fill('#watched-repos', 'another');
    await wait("!!document.querySelector('#watched-repos').closest('.relative').querySelector('li button')");
    await js("document.querySelector('#watched-repos').closest('.relative').querySelector('li button').focus()");
    escape();
    await wait("!document.querySelector('#watched-repos').closest('.relative').querySelector('li button')");
    assert.equal(await js('document.activeElement.id'), 'watched-repos');
    assert.equal(
      await js("!!document.querySelector('.settings-dialog')"),
      true,
      'Escape from a suggestion dismisses search before Settings'
    );
    win.setSize(640, 740);
    await js("document.querySelector('[aria-label^=\"Stop watching team/long\"]').scrollIntoView({block:'center'})");
    await capture('settings-long-repository');
    assert.equal(
      await js(
        "document.querySelector('.settings-dialog').scrollWidth <= document.querySelector('.settings-dialog').clientWidth + 1"
      ),
      true
    );
    await click('Integrations');
    await click('Open logs directory →');
    await wait("document.querySelector('.settings-dialog').textContent.includes('Could not open the logs folder')");
    await click('Claude Code setup ↗');
    await wait(
      "document.querySelector('.settings-dialog').textContent.includes('Open https://code.claude.com/docs/en/setup in your browser')"
    );
    await js("document.documentElement.classList.add('dark')");
    await js("document.querySelector('.ai-setup-guide [role=alert]').scrollIntoView({block:'center'})");
    await capture('settings-integration-error-dark');
    escape();
    await wait("!document.querySelector('.settings-dialog')");
    win.setSize(1100, 800);

    await click('Local changes');
    await wait("!!document.querySelector('#local-repo-path')");
    await fill('#local-repo-path', '/projects/日本語 repo');
    await wait('window.refs.length===1');
    await fill('#local-base-ref', 'my-base');
    await fill('#local-head-ref', 'my-head');
    await js("window.refs[0].resolve({branches:['main'],tags:['main'],defaultBase:'main',defaultHead:'feature'})");
    await wait("!document.querySelector('#local-repo-status').textContent.includes('Reading branches')");
    assert.equal(await js("document.querySelector('#local-base-ref').value"), 'my-base');
    assert.equal(
      await js("document.querySelector('#local-head-ref').value"),
      'my-head',
      'Late ref discovery must preserve edits'
    );
    await wait("document.querySelector('#local-repo-status').textContent.includes('3 files')");
    await js("window.validationMode='reject'");
    await click('Begin review');
    await wait("document.querySelector('#local-repo-status').textContent.includes('Could not validate')");
    assert.equal(await js("document.querySelector('#local-repo-path').value"), '/projects/日本語 repo');
    await capture('local-validation-error-dark');
    await click('Browse');
    await wait("document.querySelector('#local-repo-status').textContent.includes('Could not open the folder picker')");
    win.setSize(640, 740);
    win.webContents.setZoomFactor(2);
    await js("document.querySelector('#local-repo-status').scrollIntoView({block:'center'})");
    await capture('local-picker-error-zoom');
    assert.equal(
      await js(
        "document.querySelector('[role=dialog]').scrollWidth<=document.querySelector('[role=dialog]').clientWidth+1"
      ),
      true
    );
    win.webContents.setZoomFactor(1);
    win.setSize(1100, 800);

    await js(
      "window.validationMode='pending';window.beforeValidationCount=window.validations.length;const f=document.querySelector('#local-repo-path').closest('form');for(let i=0;i<10;i++)f.requestSubmit()"
    );
    await wait('!!window.finishValidation');
    assert.equal(
      await js('window.validations.length-window.beforeValidationCount'),
      1,
      'Repeated submits validate once'
    );
    await click('Cancel');
    await wait("!document.querySelector('#local-repo-path')");
    await js('window.finishValidation(window.validationResult)');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await js('window.reviewStarts'), [], 'A dismissed validation must not start a hidden review');
    const reads = await js('window.refs.length+window.validations.length');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await js('window.refs.length+window.validations.length'),
      reads,
      'Closed dialogs stop requesting previews'
    );
    console.log('Setup hardening browser checks passed. Captures:', shots);
  } catch (error) {
    console.error(error);
    console.log(await js('document.body.innerText.slice(-3500)'));
    await capture('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
