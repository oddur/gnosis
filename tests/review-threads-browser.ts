import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => (win.webContents.executeJavaScript(code) as Promise<T>).catch(error => { console.error('Failed browser expression:', code); throw error; });
  const wait = async (expression: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = async (label: string) =>
    js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const screenshots = path.join(os.tmpdir(), 'gnosis-thread-screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await wait("document.visibilityState === 'visible'");
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw new Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?threads');
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("document.querySelectorAll('.github-thread').length===5");
    const toggleViewed = () => js("document.querySelector('.review-file-viewed input').click()");
    const toggleFile = () => js("document.querySelector('.review-file-expand').click()");
    await toggleViewed();
    assert.equal(await js("document.querySelector('.review-file-content').hidden"), true);
    assert.equal(await js("!!document.querySelector('.review-file-summary')"), false);
    assert.equal(await js("document.querySelector('.review-file-expand').getAttribute('aria-expanded')"), 'false');
    await capture('viewed-file-light');
    await toggleFile();
    assert.equal(await js("document.querySelector('.review-file-content').hidden"), false);
    assert.equal(
      await js("document.querySelector('.review-file-viewed input').checked"),
      true,
      'Expanding a viewed file does not clear its progress'
    );
    // Reopening the review restores its viewed files collapsed, including after a renderer reload.
    await loadWorkbenchPage(win, url + '?threads&keep-progress');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await wait("document.querySelectorAll('.github-thread').length===5");
    assert.equal(await js("document.querySelector('.review-file-viewed input').checked"), true);
    assert.equal(await js("document.querySelector('.review-file-content').hidden"), true);
    await toggleViewed();
    assert.equal(
      await js("document.querySelector('.review-file-content').hidden"),
      false,
      'Unmarking a viewed file reveals its code'
    );
    const toggleExplanations = () => js("document.querySelector('.inline-explanations-toggle input').click()");
    assert.equal(await js("document.querySelectorAll('.inline-code-explanation').length"), 1);
    await toggleExplanations();
    await wait("document.querySelectorAll('.inline-code-explanation').length===0");
    assert.equal(await js('window.electronAPI.loadPreferences().then(p => p.showInlineExplanations)'), false);
    assert.equal(
      await js("document.querySelectorAll('.github-thread').length"),
      5,
      'Hiding generated explanations preserves GitHub discussions'
    );
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.inline-explanations-toggle input')");
    assert.equal(
      await js("document.querySelector('.inline-explanations-toggle input').checked"),
      false,
      'Reopened reviews respect the saved explanation preference'
    );
    await toggleExplanations();
    await wait("document.querySelectorAll('.inline-code-explanation').length===1");
    assert.ok(
      await js("JSON.parse(document.body.dataset.discussionPrs ?? '[]').includes('https://github.com/klang/engine/pull/121')"),
      'The displayed file source is fetched even when other stack discussions refresh too'
    );
    assert.equal(await js("document.querySelectorAll('.review-diff .github-thread').length"), 3);
    assert.equal(await js("document.querySelectorAll('.github-unplaced-threads .github-thread').length"), 2);
    assert.equal(await js("document.querySelectorAll('.review-diff .github-thread[open]').length"), 2);
    assert.equal(
      await js("document.querySelectorAll('.github-unplaced-threads .github-thread[open]').length"),
      2,
      'Unresolved discussions stay expanded even when GitHub cannot anchor them to saved code'
    );
    await click('View 2 threads below diff');
    assert.equal(
      await js("document.activeElement.classList.contains('github-unplaced-threads')"),
      true,
      'The file toolbar takes keyboard focus to comments without matching lines'
    );
    await js("document.querySelector('.github-discussion-toolbar').scrollIntoView({block:'center'})");
    await capture('threads-light');
    await click('Diff appearance');
    await wait(`!!document.querySelector('[aria-label="Diff layout"]')`);
    await js(`(()=>{const select=document.querySelector('[aria-label="Diff layout"]');select.value='split';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await js("document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("document.querySelectorAll('.review-diff .github-thread').length===3");
    const slotSides = await js<string[]>(
      `[...document.querySelectorAll('.review-diff .github-thread')].slice(0,2).map(t=>{const slot=t.closest('[slot]');return slot?.assignedSlot?.parentElement?.getAttribute('data-side')??slot?.getAttribute('slot');})`
    );
    assert.ok(slotSides.every(Boolean), 'Threads are rendered through Pierre annotations');
    assert.equal(
      await js(`(() => {
      const slot = document.querySelector('.inline-code-explanation').closest('[slot]');
      return !!slot.assignedSlot.closest('[data-additions]');
    })()`),
      true,
      'Explanations use the correct side in split view'
    );
    await js("document.documentElement.classList.add('dark')");
    await capture('threads-dark-split');
    await js(
      `(()=>{const t=document.querySelector('.review-diff .github-thread');[...t.querySelectorAll('button')].find(b=>b.textContent==='Reply').click()})()`
    );
    await wait("!!document.querySelector('.github-thread textarea')");
    await js(
      `(()=>{const input=document.querySelector('.github-thread textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'I checked cancellation and the slot is released.');input.dispatchEvent(new Event('input',{bubbles:true}));document.body.dataset.replyFail='true';})()`
    );
    await toggleExplanations();
    assert.equal(
      await js("document.querySelector('.inline-explanations-toggle input').checked"),
      true,
      'Do not change folded context while a reply is being composed'
    );
    assert.equal(
      await js("document.querySelector('.github-thread textarea').value"),
      'I checked cancellation and the slot is released.'
    );
    await toggleViewed();
    await capture('viewed-file-dark');
    await toggleFile();
    assert.equal(
      await js("document.querySelector('.github-thread textarea').value"),
      'I checked cancellation and the slot is released.',
      'Collapsing a file preserves an unsent reply'
    );
    await toggleViewed();
    await click('Refresh comments');
    assert.equal(
      await js("!!document.querySelector('.github-thread textarea')"),
      true,
      'Refreshing must not discard a reply draft'
    );
    await click('Reply on GitHub');
    await wait("document.querySelector('.github-thread-error')?.textContent.includes('permission')");
    assert.equal(
      await js("document.querySelector('.github-thread textarea').value"),
      'I checked cancellation and the slot is released.'
    );
    await js("document.body.dataset.replyFail='false'");
    await click('Reply on GitHub');
    await wait("!document.querySelector('.github-thread textarea')");
    const action = JSON.parse(await js<string>('document.body.dataset.discussionAction')) as {
      prUrl: string;
      action: string;
    };
    assert.equal(action.prUrl, 'https://github.com/klang/engine/pull/121');
    assert.equal(action.action, 'reply');
    await click('Resolve thread');
    await wait("document.querySelectorAll('.review-diff .github-thread[open]').length===1");
    await js("document.querySelector('.review-diff .github-thread summary').click()");
    await click('Reopen thread');
    await wait("document.querySelectorAll('.review-diff .github-thread[open]').length===2");
    win.setSize(800, 700);
    await wait('innerWidth<=800');
    await click('Code');
    await capture('threads-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await js("document.body.dataset.discussionFail='true'");
    await click('Refresh comments');
    await wait("document.querySelector('.github-thread-error')?.textContent.includes('rate limit')");
    assert.equal(
      await js("document.querySelectorAll('.github-thread').length"),
      5,
      'Refresh failure preserves discussions'
    );
    await js("document.body.dataset.discussionFail='false';document.body.dataset.discussionStale='true'");
    await click('Refresh comments');
    await wait("document.querySelectorAll('.github-unplaced-threads .github-thread').length===5");
    assert.equal(
      await js("document.querySelectorAll('.review-diff .github-thread').length"),
      0,
      'Changed revision must not attach comments to stale lines'
    );
    await capture('threads-stale');
    // Discussion anchors reveal otherwise folded context, without expanding the whole file.
    await js(`(async () => {
      const review = await window.electronAPI.loadReview('workbench-review');
      const hunk = review.slides[0].diffHunks[0];
      hunk.hunkHeader = '@@ -1,41 +1,41 @@';
      hunk.content = Array.from({length:41},(_,i)=>i===20 ? '-old\\n+new' : ' const context'+i+' = true;').join('\\n');
      review.slides[0].inlineExplanations = [{filePath:hunk.filePath, line:5, side:'RIGHT', code:'const context4 = true;', text:'This context establishes the precondition used by the later change.'}];
      review.slides[0].diffHunks.push(structuredClone(hunk));
      document.body.dataset.discussionStale='false';
    })()`);
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.github-discussion-refresh')");
    await click('Refresh comments');
    await wait("document.querySelectorAll('.review-diff .github-thread').length===3");
    assert.equal(await js("!!document.querySelector('.diff-context-gap')"), true);
    assert.equal(
      await js("document.querySelectorAll('.review-diff .github-thread').length"),
      3,
      'Threads on folded lines stay visible'
    );
    assert.equal(
      await js("document.querySelectorAll('.inline-code-explanation').length"),
      1,
      'Notes in folded context stay visible and overlapping hunks do not duplicate them'
    );
    // File progress follows source-qualified paths across topics, but not new revisions.
    await toggleViewed();
    await js(`(async () => {
      const review = await window.electronAPI.loadReview('workbench-review');
      review.slides[1].diffHunks = structuredClone(review.slides[0].diffHunks);
      review.slides[2].diffHunks = structuredClone(review.slides[0].diffHunks).map(h => ({
        ...h, filePath: h.filePath.replace('-121/', '-122/')
      }));
    })()`);
    const selectTopic = (number: number) =>
      js(`window.selectOption('[aria-label="Review topic"]', '${number}')`);
    await selectTopic(2);
    assert.equal(
      await js("document.querySelector('.review-file-viewed input').checked"),
      true,
      'The same source file stays viewed in another topic'
    );
    await selectTopic(3);
    assert.equal(
      await js("document.querySelector('.review-file-viewed input').checked"),
      false,
      'A matching filename from another PR in the stack remains unviewed'
    );
    await selectTopic(1);
    await js(`(async () => {
      const review = await window.electronAPI.loadReview('workbench-review');
      review.snapshot = {...review.snapshot, fingerprint: 'new-revision', subject: {...review.snapshot.subject, members: review.snapshot.subject.members.map(member => ({...member, headSha: member.headSha + '-updated'}))}};
    })()`);
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.review-file-viewed input')");
    assert.equal(
      await js("document.querySelector('.review-file-viewed input').checked"),
      false,
      'Viewed marks are not reused for a new code revision'
    );
    assert.equal(await js("document.querySelector('.review-file-content').hidden"), false);
    console.log('GitHub thread browser checks passed. Screenshots: ' + screenshots);
  } catch (e) {
    console.error(e);
    console.log(await js('document.body.innerText'));
    await capture('failure');
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
