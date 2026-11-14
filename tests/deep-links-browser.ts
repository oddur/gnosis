import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

// gnosis:// links in the app (#309 Phase 1): a link opens the right PR tab, refusals and blocked PRs show a toast
// with one action, nothing is generated, and Copy Gnosis link copies the canonical link.
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const shots = path.resolve('.impeccable/review/deep-links');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const pr = (number: number) => ({ host: 'github.com', owner: 'klang', repo: 'engine', number });
  /** One delivery from main, as the preload hands it over. */
  const deliver = (detail: Record<string, unknown>) =>
    js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify(detail)}}))`);
  const prTab = "document.querySelector('[role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent";
  const workspaceTabs = () => js<number>('document.querySelectorAll(".workspace-tab").length');
  const toast = (title: string) => `[...document.querySelectorAll('.app-toast')].find(t=>t.querySelector('.app-toast-title')?.textContent===${JSON.stringify(title)})`;
  const toastText = (title: string) => js<string>(`${toast(title)}?.textContent ?? ''`);
  const clickToastAction = (title: string) => js(`${toast(title)}.querySelector('.app-toast-action').click()`);
  const closeToasts = async () => {
    await js("document.querySelectorAll('.app-toast [aria-label=\"Dismiss notification\"]').forEach(b=>b.click())");
    await wait("!document.querySelector('.app-toast')");
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?deep-links`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(()=>{window.linkCalls={external:[],generated:[],copied:[]};
      window.electronAPI.openExternal=url=>{window.linkCalls.external.push(url);return Promise.resolve()};
      for(const name of ['startReview','workbenchBriefing','generateExplainer','sendSlideChat'])window.electronAPI[name]=(...args)=>{window.linkCalls.generated.push(name);return Promise.resolve({})};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.linkCalls.copied.push(text)}}});})()`);
    win.focus();

    // An outside link opens the PR on its tab, in a new workspace tab.
    const tabs = await workspaceTabs();
    await deliver({ source: 'os', target: { kind: 'pr', pr: pr(150), tab: 'checks' } });
    await wait(`${prTab}?.startsWith('Checks')`);
    assert.equal(await workspaceTabs(), tabs + 1, 'A new workspace tab; the queue tab is left alone');
    await capture('checks-tab');
    // A second link to the same PR reuses its tab and lands on the new tab.
    await deliver({ source: 'content', target: { kind: 'pr', pr: pr(150), tab: 'feedback' } });
    await wait(`${prTab}?.startsWith('Feedback')`);
    assert.equal(await workspaceTabs(), tabs + 1);

    // A locator this version cannot follow: the tab opens, with a note.
    await deliver({ source: 'os', target: { kind: 'pr', pr: pr(150), tab: 'changes', file: { path: 'src/command-queue.ts', line: 4 } } });
    await wait(`${prTab}?.startsWith('Changes')`);
    await wait(`!!${toast('Opened klang/engine#150')}`);
    assert.match(await toastText('Opened klang/engine#150'), /Links to a file or line are not supported yet/);
    await closeToasts();

    // A PR that is gone or private: a toast with Open on GitHub, and no new tab.
    await deliver({ source: 'os', target: { kind: 'pr', pr: pr(404), tab: 'checks' } });
    await wait(`!!${toast('Could not open klang/engine#404')}`);
    assert.match(await toastText('Could not open klang/engine#404'), /could not find the PR/);
    assert.equal(await workspaceTabs(), tabs + 1, 'No empty tab for a PR that did not open');
    await capture('not-found');
    await clickToastAction('Could not open klang/engine#404');
    assert.deepEqual(await js('window.linkCalls.external'), ['https://github.com/klang/engine/pull/404/checks'], 'The GitHub URL is rebuilt from parsed fields');
    await closeToasts();

    // A muted PR: Show muted PRs. The link never unmutes it.
    await deliver({ source: 'os', target: { kind: 'pr', pr: pr(777) } });
    await wait(`!!${toast('klang/engine#777 is muted')}`);
    assert.match(await toastText('klang/engine#777 is muted'), /Show muted PRs/);
    assert.equal(await workspaceTabs(), tabs + 1);
    await closeToasts();

    // A link main refused: the reason and the route word, never the link.
    await deliver({ source: 'os', error: { code: 'bad-parameter', route: 'pr' } });
    await wait(`!!${toast('Could not open link')}`);
    assert.match(await toastText('Could not open link'), /The link has a value Gnosis cannot use\. \(pr link\)/);
    await capture('refused');
    await closeToasts();
    await deliver({ source: 'os', error: { code: 'rate-limited', count: 195 } });
    await wait(`!!${toast('Ignored 195 links')}`);
    await closeToasts();

    // Other routes from outside are not supported yet.
    await deliver({ source: 'os', target: { kind: 'settings', section: 'repositories' } });
    await wait(`!!${toast('This link is not supported yet')}`);
    assert.equal(await js("!!document.querySelector('.settings-tabs')"), false, 'Settings did not open');
    await closeToasts();
    await deliver({ source: 'os', target: { kind: 'conflicts', pr: pr(150) } });
    await wait(`!!${toast('This link is not supported yet')}`);
    assert.match(await toastText('This link is not supported yet'), /Open PR/);
    assert.equal(await js("document.body.textContent.includes('Review and resolve merge conflicts')"), false, 'A link never starts conflict resolution');
    await closeToasts();

    // Nothing a link did started any generation.
    assert.deepEqual(await js('window.linkCalls.generated'), []);

    // Copy Gnosis link, from a PR's actions and from the command palette.
    await js("document.querySelectorAll('.workspace-tab-select')[0].click()");
    await wait("!!document.querySelector('[aria-label=\"Actions for PR #151\"]')");
    await menuAction(js, 'Actions for PR #151', 'Copy Gnosis link');
    await wait('window.linkCalls.copied.length===1');
    assert.deepEqual(await js('window.linkCalls.copied'), ['gnosis://pr/klang/engine/151']);
    await js("[...document.querySelectorAll('.workspace-tab-select')].at(-1).click()");
    await wait(`${prTab}?.startsWith('Changes')`);
    await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))");
    await wait("!!document.querySelector('[aria-label=\"Search Gnosis\"]')");
    await js(`(()=>{const e=document.querySelector('[aria-label="Search Gnosis"]');e.focus();e.select()})()`);
    await win.webContents.insertText('> Copy Gnosis link');
    await wait("[...document.querySelectorAll('[cmdk-item]')].some(e=>e.textContent.includes('Copy Gnosis link to this view'))");
    await js("[...document.querySelectorAll('[cmdk-item]')].find(e=>e.textContent.includes('Copy Gnosis link to this view')).click()");
    await wait('window.linkCalls.copied.length===2');
    assert.equal(await js('window.linkCalls.copied[1]'), 'gnosis://pr/klang/engine/150/changes');
    console.log('Deep link checks passed: PR tab from a link, tab reuse, locator note, not found, muted, refusals, not supported yet, no generation, Copy Gnosis link. Screenshots: ' + shots);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    app.exit(1);
  }
});
