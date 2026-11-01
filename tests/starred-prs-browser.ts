import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    if (/^(Unstar|Star) PR #/.test(label)) {
      return menuAction(js, `Actions for PR #${label.split('#')[1]}`, label);
    }
    if (label.includes('PRs in this stack')) return menuAction(js, 'Stack actions', label);
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.getAttribute('title')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const dir = path.resolve('.impeccable/review/starred-prs');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    const prior = await js("document.querySelector('.briefing-panel h2')?.textContent??null");
    await click('Star PR #152');
    await wait("!!document.querySelector('.queue-item:has([aria-label=\"Actions for PR #152\"]) .entry-star-marker')");
    assert.equal(
      await js("document.querySelector('.briefing-panel h2')?.textContent??null"),
      prior,
      'Starring selects the menu target without navigating the briefing'
    );
    assert.equal(await js("document.querySelector('.queue-section-title').textContent.trim()"), 'Starred 1');
    await capture('queue-pinned');
    await click('Starred');
    await wait("document.querySelectorAll('.queue-item').length===1");
    await capture('starred-list');
    await wait('window.electronAPI.workbenchQueue().then(q=>q.filters.starredOnly)');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait(
      "document.querySelector('[title=Starred]')?.getAttribute('aria-current')==='page' && document.querySelectorAll('.queue-item').length===1"
    );
    assert.ok(await js('!!document.querySelector(\'.queue-item:has([aria-label="Actions for PR #152"]) .entry-star-marker\')'), 'Bookmark survives reload');
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js("document.querySelector('.queue-disclosure').click()");
    await click('Star PR #121');
    await wait(
      "document.querySelector('.queue-item:has(.queue-disclosure) .entry-star-marker')?.getAttribute('title')==='1 of 3 PRs starred'"
    );
    await capture('partial-stack');
    await click('Unstar PRs in this stack');
    await wait('!document.querySelector(\'.queue-member:has([aria-label="Actions for PR #121"]) .entry-star-marker\')');
    await click('Star all PRs in this stack');
    await wait(
      "document.querySelector('.queue-item:has(.queue-disclosure) .entry-star-marker')?.getAttribute('title')==='3 of 3 PRs starred'"
    );
    assert.equal(await js("document.querySelectorAll('.queue-member .entry-star-marker').length"), 3);
    await click('Starred');
    await wait("document.querySelectorAll('.queue-item').length===2");
    await capture('starred-stack');
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Add trace')).click()");
    await click('Open PR overview');
    await wait('!!document.querySelector(\'.pr-overview-heading .entry-star-marker\')');
    await capture('pr-header');
    await click('Changes');
    assert.ok(await js('!!document.querySelector(\'.pr-overview-heading .entry-star-marker\')'));
    await click('Summary');
    await js("window.electronAPI.workbenchStarPrs=async()=>{throw Error('Disk is full')};void 0");
    await click('Unstar PR #152');
    await wait("document.querySelector('.pr-overview-heading [role=alert]')?.textContent.includes('Disk is full')");
    assert.ok(
      await js('!!document.querySelector(\'.pr-overview-heading .entry-star-marker\')'),
      'Failed persistence retains bookmark'
    );
    await capture('save-error');
    await click('Starred');
    await click('Review queue');
    await click('Dismiss error');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(640, 800);
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    console.log(
      'Starred PR browser checks passed: stable pinning, dedicated list, reload, member/stack toggles, header across tabs, persistence failure, dark and narrow layouts.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await capture('failure');
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
