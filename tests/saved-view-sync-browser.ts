import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Switching to a saved view asks main once to read its first screenful of rows, and main's scheduler (the real one,
 * in the page) reads only the rows not read within 30 s. Resting on a saved view in the sidebar prepares its top rows
 * once; a quick pass over the sidebar prepares nothing.
 */
type Read = { urls: string[]; refresh: boolean };
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await sleep(50);
    }
    throw Error('Timed out: ' + code);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
    await sleep(60);
  };
  const center = (selector: string) =>
    js<[number, number]>(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`
    );
  const move = (x: number, y: number) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  };
  const urlsOf = (titles: string[]) =>
    js<string[]>(
      `(async()=>{const q=await window.electronAPI.workbenchQueue();const m=q.items.flatMap(i=>i.subject.members);return ${JSON.stringify(titles)}.map(t=>m.find(x=>x.title===t).url)})()`
    );
  // Settle: the switch is debounced and the scheduler ticks every 100 ms.
  const settle = () => sleep(800);
  const sorted = (list: string[]) => [...list].sort();
  try {
    if (process.platform === 'darwin') app.show();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?github-sync&saved-view-sync`);
    await waitForWorkbenchQueue(win.webContents);
    const [reconnect, allocations] = await urlsOf([
      'Fix reconnect handling after transport shutdown',
      'Reduce allocations in snapshot serialization',
    ]);
    // Visible rows are read when they appear. The first view after loading asks for nothing more.
    await wait('window.viewSync.reads.some(r=>r.urls.length)');
    await settle();
    assert.deepEqual(await js('window.viewSync.requests'), [], 'The view shown at startup is left to startup and focus wake');

    // ── A section switch asks once for its top rows. They were just read, so nothing is read again. ──
    const startup = new Set((await js<Read[]>('window.viewSync.reads')).flatMap((read) => read.urls));
    await click('Updated PRs');
    await wait('window.viewSync.requests.length===1');
    assert.deepEqual(await js<string[]>('window.viewSync.requests[0]').then(sorted), sorted([reconnect, allocations]));
    await settle();
    const early = (await js<Read[]>('window.viewSync.reads')).filter((read) => read.refresh).flatMap((read) => read.urls);
    assert.ok(!early.some((url) => startup.has(url)), `Rows read within 30 s are skipped: ${JSON.stringify(early)}`);

    // Save this section as a view, then go back to the whole queue.
    await click('Save view…');
    await js(`(()=>{const input=document.querySelector('.save-view-popover input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'Updated work');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await click('Save view');
    await wait("!!document.querySelector('.saved-view-link[aria-label=\"Updated work\"]')");
    await click('Review queue');
    await wait("document.querySelector('h1')?.textContent.includes('Review queue')");
    await settle();

    // ── Activating the view after 30 s: one request, and one read of only the row that is stale. ──
    await js('window.viewSync.advance(31_000)');
    await js(`window.viewSync.fresh(${JSON.stringify(reconnect)})`);
    await wait(`window.viewSync.reads.some(r=>!r.refresh&&r.urls.includes(${JSON.stringify(reconnect)}))`);
    const before = await js<{ requests: number; reads: number }>(
      '({requests:window.viewSync.requests.length,reads:window.viewSync.reads.length})'
    );
    await js(`document.querySelector('.saved-view-link[aria-label="Updated work"]').click()`);
    await wait(`window.viewSync.requests.length===${before.requests + 1}`);
    assert.deepEqual(await js<string[]>('window.viewSync.requests.at(-1)').then(sorted), sorted([reconnect, allocations]));
    await settle();
    const after = (await js<Read[]>('window.viewSync.reads')).slice(before.reads).filter((read) => read.refresh);
    assert.deepEqual(after, [{ urls: [allocations], refresh: true }], 'One read, for only the stale top row');
    assert.equal(await js('window.viewSync.requests.length'), before.requests + 1, 'One request per switch');

    // ── Hover: resting on the view while another is shown prepares its top rows once; leaving cancels. ──
    await click('Review queue');
    await wait("document.querySelector('h1')?.textContent.includes('Review queue')");
    await settle();
    const [x, y] = await center('.saved-view-link[aria-label="Updated work"]');
    const [qx, qy] = await center('.queue-toolbar h1');
    move(qx, qy);
    await sleep(100);
    await js('window.viewSync.hovers.length=0');
    move(x, y);
    await sleep(600);
    move(x + 1, y);
    await sleep(200);
    const hovers = await js<string[][]>('window.viewSync.hovers');
    assert.equal(hovers.length, 1, `Resting prepares the top rows once: ${JSON.stringify(hovers)}`);
    assert.deepEqual(sorted(hovers[0]), sorted([reconnect, allocations]));
    move(qx, qy);
    await wait('window.viewSync.hovers.length===2');
    assert.deepEqual(await js('window.viewSync.hovers[1]'), [], 'Leaving cancels what has not started');

    // ── A quick sweep over the sidebar prepares nothing. ──
    await js('window.viewSync.hovers.length=0');
    const stops = await js<[number, number][]>(
      `[...document.querySelectorAll('.workbench-sidebar [data-sidebar-destination], .saved-view-link')].map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})`
    );
    for (const [sx, sy] of stops) {
      move(sx, sy);
      await sleep(30);
    }
    move(qx, qy);
    await sleep(400);
    assert.deepEqual(await js('window.viewSync.hovers'), [], 'A fast sweep prepares nothing');
    console.log('[saved-view-sync] passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
