import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Change signals (#337, #338, #339) with synthetic GitHub responses: a notification or a changed-PR search result
 * reads only the PR it names, the queue and the open PR update, and a 304 reads nothing.
 */
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
  type Record = { notifications: number; notModified: number; searches: number; refreshed: string[]; heads: { url: string; to: string; source: string }[] };
  const record = () => js<Record>('JSON.parse(JSON.stringify(window.changeFixture.record))');
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters&checks&github-sync&change-signals`);
    await waitForWorkbenchQueue(win.webContents);
    // The PR under test is the second queue item, as in the sync fixture.
    const prUrl = await js<string>('window.changeFixture.target');
    const other = await js<string>('window.changeFixture.other');

    // First sweep: the feed's first page only sets its cursor, and the search finds nothing new.
    await js('window.changeFixture.tick()');
    let seen = await record();
    assert.equal(seen.notifications, 1);
    assert.equal(seen.searches, 1);
    assert.deepEqual(seen.refreshed, [], 'nothing changed yet');

    // A comment on GitHub, with a notification. The next poll reads only that PR, and the queue shows it.
    await js(`window.changeFixture.comment(${JSON.stringify(prUrl)}, 'Renamed on GitHub after review')`);
    await js('window.changeFixture.tick(60000)');
    await wait("document.body.textContent.includes('Renamed on GitHub after review')");
    seen = await record();
    assert.deepEqual(seen.refreshed, [prUrl], 'only the notified PR is read');
    assert.ok(!seen.refreshed.includes(other));

    // Nothing new: the feed answers 304 and nothing is read.
    await js('window.changeFixture.tick(60000)');
    seen = await record();
    assert.equal(seen.notModified, 1, 'the feed answered 304');
    assert.deepEqual(seen.refreshed, [prUrl], 'a 304 reads no PR');

    // Open the PR's Changes, then push to it with notifications muted: only the search sees the new head.
    await js(
      `[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Renamed on GitHub after review')).click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await click('Open PR overview');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await wait("[...window.syncFixture.subscriptions.values()].some(s=>s.kind==='metadata')");
    await js(`window.changeFixture.push(${JSON.stringify(prUrl)})`);
    // The search runs every two minutes; the feed answers 304 in between.
    await js('window.changeFixture.tick(120000)');
    seen = await record();
    assert.deepEqual(seen.heads.map((change) => [change.url, change.source]), [[prUrl, 'search']], 'the search revealed the new head once');
    assert.equal(seen.heads[0].to, 'f'.repeat(40));
    assert.deepEqual(seen.refreshed, [prUrl, prUrl], 'the search read only the pushed PR');
    await wait("document.body.textContent.includes('New commits') || document.body.textContent.includes('New changes')");
    assert.ok(await js("!!document.querySelector('.changes-file-tree')"), 'the open diff stays until the reader moves to the new head');
    console.log('Change signals browser checks passed: a notification and a search result each read only their PR, a 304 reads nothing, and a new head reaches the open view.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { console.log(await js('JSON.stringify(window.changeFixture?.record)')); } catch { /* The renderer is unavailable. */ }
    try { console.log(await js('document.body.innerText')); } catch { /* The renderer is unavailable. */ }
    app.exit(1);
  }
});
