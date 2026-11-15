import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Every write is followed by GitHub responses that change only after two more reads. The page must show the change
 * on its own: no manual refresh, no forced status read, and no in-page "action completed" event. All GitHub data is
 * synthetic; nothing reaches GitHub.
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
  const wait = async (code: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  const readiness = () => js<string>("document.querySelector('.pr-readiness')?.textContent ?? ''");
  const state = () => js<string>("document.querySelector('.pr-state')?.textContent ?? ''");
  const openRow = async (title: string) => {
    await wait(`[...document.querySelectorAll('.queue-row-main')].some(b=>b.textContent.includes(${JSON.stringify(title)}))`);
    await js(`[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`);
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-state') && !!document.querySelector('.pr-readiness')");
  };
  /** The write's first read finished, GitHub has not changed yet, and the follow-up is still running. */
  const writing = async (write: string) => {
    await js(`(async()=>{${write}})()`);
    assert.equal((await js<{ action: string }[]>('window.writeFixture.pending()')).length, 1, 'A follow-up runs');
  };
  const settled = (action: string) =>
    wait(`window.writeFixture.record.events.some(e=>e.action===${JSON.stringify(action)}&&e.phase==='settled')`);
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&github-sync&github-writes`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.dispatchedActions=0;window.addEventListener('gnosis-pr-action-completed',()=>window.dispatchedActions++)`);
    const url = await js<string>(
      "(async()=>(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.title.includes('Fix reconnect')).url)()"
    );
    const head = await js<string>(
      `(async()=>(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.url===${JSON.stringify(url)}).headSha)()`
    );
    const u = JSON.stringify(url);

    // Review: approval required, then GitHub reports the approval two reads later.
    await js(`window.writeFixture.github(${u},{},{readiness:{reviewDecision:'REVIEW_REQUIRED',mergeState:'BLOCKED'}})`);
    await openRow('Fix reconnect');
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Approval required')");
    await writing(
      `await window.electronAPI.submitReview({prUrl:${u},event:'APPROVE',body:'',comments:[],headSha:${JSON.stringify(head)}})`
    );
    assert.match(await readiness(), /Approval required/, 'GitHub has not shown the approval yet');
    await settled('submit-review');
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Ready to merge')");

    // Rerun: failing checks, then running checks for the same head.
    await js(`window.writeFixture.github(${u},{},{checks:{state:'failure',passed:1,failed:1,total:2}})`);
    await js("document.dispatchEvent(new Event('visibilitychange'))");
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Some checks are failing')");
    await writing(`await window.electronAPI.rerunChecks({url:${u},headSha:${JSON.stringify(head)},id:'check:1',mode:'failed'})`);
    assert.match(await readiness(), /Some checks are failing/);
    await settled('rerun-checks');
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('still running')");

    // Update branch: GitHub requires an update; the new head arrives, then its mergeability.
    await js(`window.writeFixture.github(${u},{},{checks:{state:'success',passed:2,total:2},readiness:{mergeState:'BEHIND',behindBy:2}})`);
    await js("document.dispatchEvent(new Event('visibilitychange'))");
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Update required to merge')");
    await writing(`await window.electronAPI.performPrAction({kind:'update-merge',url:${u},revisions:[]})`);
    assert.match(await readiness(), /Update required to merge/);
    await settled('update-branch');
    await wait("document.querySelector('.pr-readiness')?.textContent.includes('Ready to merge')");
    assert.equal(
      await js<string>(`window.writeFixture.record.events.filter(e=>e.action==='update-branch').map(e=>e.phase).join()`),
      'immediate,follow-up,settled'
    );

    // Merge: GitHub reports the merge two reads later.
    assert.equal(await state(), 'Open');
    await writing(`await window.electronAPI.performPrAction({kind:'merge',url:${u},revisions:[]})`);
    assert.equal(await state(), 'Open', 'GitHub has not shown the merge yet');
    await settled('merge');
    await wait("document.querySelector('.pr-state')?.textContent==='Merged'");

    // Comment: back in the queue, the row's comment count follows GitHub once the comment shows.
    const other = await js<{ url: string; title: string }>(
      "(async()=>{const i=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='pr'&&i.subject.members.length===1&&!i.subject.title.includes('Fix reconnect')&&i.subject.members[0].state==='open');return {url:i.subject.members[0].url,title:i.subject.title}})()"
    );
    const o = JSON.stringify(other.url);
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-state')");
    await wait(`[...window.syncFixture.subscriptions.values()].some(s=>s.kind==='signals'&&s.targets.some(t=>t.url===${o}))`);
    await js(`window.writeFixture.github(${o},{commentCount:7},{comments:7})`);
    const comments = (count: number) =>
      `[...document.querySelectorAll('.queue-item')].some(row=>row.textContent.includes(${JSON.stringify(other.title)})&&!!row.querySelector('.queue-comments[aria-label="${count} conversation comments"]'))`;
    await writing(`await window.electronAPI.feedbackAction({prUrl:${o},action:'reply',sourceId:'c1',body:'Thanks'})`);
    await wait(comments(7));
    await settled('feedback-reply');
    await wait(comments(8));

    assert.equal(await js('window.writeFixture.record.forcedStatus'), 0, 'No forced status read: no manual refresh');
    assert.equal(await js('window.dispatchedActions'), 0, 'No in-page action event: main told the page');
    assert.deepEqual(await js('window.writeFixture.pending()'), [], 'Every follow-up stopped');
    console.log('GitHub write refresh browser checks passed: review, rerun, update branch, merge and comment.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      console.log('Comment badges:', await js<string>("[...document.querySelectorAll('.queue-item')].map(r=>r.textContent.slice(0,40)+' => '+(r.querySelector('.queue-comments')?.getAttribute('aria-label')??'-')).join('\\n')"));
      console.log('Readiness:', await readiness());
      console.log('Events:', JSON.stringify(await js('window.writeFixture.record.events')));
      console.log(await js<string>('document.body.innerText.slice(0, 2000)'));
    } catch {
      /* The renderer is unavailable. */
    }
    app.exit(1);
  }
});
