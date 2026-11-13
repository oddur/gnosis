import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
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
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on('console-message', ({ message }) => { if (/error|failed/i.test(message)) console.error('Renderer:', message); });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + expression);
  };
  const key = async (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise((r) => setTimeout(r, 60));
  };
  const fill = async (value: string) => {
    await js(
      `(()=>{const e=document.querySelector('.global-command-dialog input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
    await new Promise((r) => setTimeout(r, 180));
  };
  const open = async () => {
    await key('k', ['meta']);
    await wait("!!document.querySelector('.global-command-dialog')");
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
  };
  const click = (text: string) =>
    js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-command-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?polish');
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{window.remoteSearchCalls=0;const remote=window.electronAPI.commandGitHubSearch;window.electronAPI.commandGitHubSearch=(...args)=>{window.remoteSearchCalls++;return remote(...args)};document.querySelector('.queue-search input').focus();})()`
    );
    // A highlighted result that rests is a likely next destination: PRs are prepared like a resting queue row.
    await js(`(()=>{window.paletteIntents=[];window.electronAPI.prOpenIntent=targets=>{window.paletteIntents.push(targets&&targets.map(t=>t.url))};
      window.reviewLoads=[];const load=window.electronAPI.loadReview;window.electronAPI.loadReview=id=>{window.reviewLoads.push(id);return load(id)};})()`);
    await open();
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'), 'Search Gnosis');
    await fill('#150');
    assert.match(await js<string>("document.querySelector('.global-command-preview h2').textContent"), /Fix reconnect/);
    await wait("window.paletteIntents.some(urls=>urls&&urls.some(u=>u.endsWith('/pull/150')))");
    assert.equal(await js('window.remoteSearchCalls'), 0);
    await capture('search-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('search-dark');
    await key('Enter');
    await wait("!!document.querySelector('.pr-summary-page')&&!document.querySelector('.global-command-dialog')");
    await open();
    await fill('> settings');
    await key('Enter');
    await wait("!!document.querySelector('.settings-tabs')&&!document.querySelector('.global-command-dialog')");
    await key('Escape');
    await wait("!document.querySelector('.settings-tabs')");
    await open();
    await js('window.reviewLoads=[]');
    await fill('command-queue.ts');
    // Resting on a saved review's file loads the review's document before Enter.
    await wait('window.reviewLoads.length>0');
    await capture('file-preview');
    assert.match(await js<string>("document.querySelector('.global-command-preview h2').textContent"), /command-queue/, 'Paths remain searchable');
    assert.equal(await js("!!document.querySelector('.global-command-code')"), false, 'The index stores no diff contents');
    await key('Enter');
    await wait("!!document.querySelector('.workbench-review .search-arrival')");
    await wait("window.__gnosisPredict.records().some(r=>r.kind==='review')");
    assert.equal(await js("window.__gnosisPredict.records().find(r=>r.kind==='review').outcome"), 'hit', 'The rested review opens from memory');
    assert.match(
      await js<string>("document.querySelector('.search-arrival').getAttribute('data-file-path')"),
      /command-queue/
    );
    // The palette switches diff layout wherever a diff is on screen.
    const layout = "document.querySelector('.workbench-review').dataset.diffLayout";
    const startLayout = await js<string>(layout);
    await open();
    await fill('> split and unified');
    assert.match(
      await js<string>("document.querySelector('.global-command-results').textContent"),
      /Switch between split and unified diff\s*d/
    );
    await key('Enter');
    await wait(`${layout}==='${startLayout === 'split' ? 'unified' : 'split'}'`);
    await open();
    await fill('> split and unified');
    await key('Enter');
    await wait(`${layout}==='${startLayout}'`);
    await open();
    await fill('> ask about');
    await key('Enter');
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await js(
      `(()=>{const e=document.querySelector('.chat-sheet textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Keep my unfinished question');e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await open();
    await fill('> go to review queue');
    await key('Enter');
    await wait("!!document.querySelector('.app-titlebar .workspace-menu-trigger')&&!document.querySelector('.workbench-review')");
    await open();
    await fill('#120');
    await click('Resume review');
    await wait("!!document.querySelector('.workbench-review')&&!document.querySelector('.global-command-dialog')");
    await wait("!!document.querySelector('.chat-sheet textarea')");
    assert.equal(await js("document.querySelector('.chat-sheet textarea').value"), 'Keep my unfinished question');
    await open();
    await fill('zzzz-unavailable');
    assert.equal(await js('window.remoteSearchCalls'), 0);
    await click('Search GitHub…');
    await wait('window.remoteSearchCalls===1');
    await wait("document.querySelector('.global-command-results').textContent.includes('Remote queue improvement')");
    await capture('remote-results');
    await fill('something else');
    assert.equal(
      await js("document.querySelector('.global-command-results').textContent.includes('Remote queue improvement')"),
      false,
      'Remote results belong to the query that requested them'
    );
    win.setSize(900, 700);
    win.webContents.setZoomFactor(2);
    await capture('zoom');
    assert.ok(
      await js(
        `(()=>{const d=document.querySelector('.global-command-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1})()`
      )
    );
    await key('Escape');
    await wait("!document.querySelector('.global-command-dialog')");
    win.webContents.setZoomFactor(1);
    win.destroy();
    console.log(
      'Command center passed: global shortcut in inputs, local search, summary/file/settings navigation, draft restoration, explicit remote search, themes and zoom.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.destroy();
    app.exit(1);
  }
});
