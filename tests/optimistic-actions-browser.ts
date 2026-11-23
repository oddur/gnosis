import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { menuAction } from './entry-menu-helpers';

/**
 * Optimistic writes. Every write here waits until the test answers it, as a slow GitHub would. The page must show
 * the change before the answer, roll it back with the reader's text kept and a Retry when GitHub refuses, and show
 * GitHub's real object exactly once after the write and the follow-up read. All GitHub data is synthetic; nothing
 * reaches GitHub.
 */
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Timed out: ${code}`);
  };
  /** The change shows before GitHub answers: well within a frame or two of the click, never after the write. */
  const instantly = (code: string) => wait(code, 1_000);
  const click = (label: string, scope = 'document') =>
    js(
      `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const type = (selector: string, text: string) =>
    js(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  const T1 = 'document.querySelector(\'.feedback-entry[data-feedback-id="t1"]\')';
  const held = () => js<string[]>('window.optimisticFixture.held()');
  const settle = (outcome = 'ok') => js(`window.optimisticFixture.settle(${JSON.stringify(outcome)})`);
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dir = path.resolve('.impeccable/review/optimistic-actions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  /** Comments in the open thread with this exact text. */
  const copies = (text: string) =>
    js<number>(
      `[...document.querySelectorAll('.feedback-timeline .github-thread-comments article')].filter(a=>a.querySelector('.github-comment-body, .markdown, p')&&a.textContent.includes(${JSON.stringify(text)})).length`
    );
  const pendingComments = () =>
    js<number>(
      "document.querySelectorAll('.feedback-timeline .github-thread-comments article[data-sending]').length"
    );
  // A write the test forgot to answer stalls a step: report where, before the runner's own timeout.
  setTimeout(() => {
    console.error('Optimistic action checks stalled.', errors.join('\n'));
    void held()
      .then((writes) => console.error('Held:', JSON.stringify(writes)))
      .finally(() => app.exit(1));
  }, 150_000).unref();
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&github-sync&optimistic-actions`);
    await waitForWorkbenchQueue(win.webContents);
    const url = await js<string>('window.optimisticFixture.url');
    const u = JSON.stringify(url);
    const row = `[...document.querySelectorAll('.queue-item')].find(r=>r.textContent.includes('Fix reconnect'))`;

    // ── Queue: counts and draft state follow the write at once, and roll back ──
    await wait(`!!${row}?.querySelector('.queue-comments[aria-label="4 comments, including inline review comments"]')`);
    await js(
      `window.reply=window.electronAPI.feedbackAction({prUrl:${u},action:'reply',sourceId:'c1',body:'Added the shutdown order.'});0`
    );
    await instantly(`!!${row}?.querySelector('.queue-comments[aria-label="5 comments, including inline review comments"]')`);
    assert.deepEqual(await held(), ['feedback-reply'], 'The count moved before GitHub answered');
    await settle('ok');
    await js('window.reply');
    await js('window.optimisticFixture.refresh()');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      await js(`!!${row}?.querySelector('.queue-comments[aria-label="5 comments, including inline review comments"]')`),
      'GitHub’s count replaces the optimistic one without counting twice'
    );

    await js(
      `window.draft=window.electronAPI.performPrAction({account:'oddur',kind:'convert-draft',url:${u},revisions:[]}).catch(e=>e.message);0`
    );
    await instantly(`!!${row}?.querySelector('.queue-pr-icon.is-draft')`);
    await settle('Resource not accessible by integration');
    assert.equal(await js('window.draft'), 'Resource not accessible by integration');
    await instantly(`!!${row}?.querySelector('.queue-pr-icon.is-open')`);
    assert.deepEqual(await js('window.optimisticFixture.patches()'), [], 'The failed write left nothing behind');

    // ── A reply: sending at once, then the real comment exactly once ──
    await js(`${row}.querySelector('.queue-row-main').click()`);
    await click('Open PR overview');
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Summary')");
    await click('Summary');
    await wait('!!document.querySelector(\'[data-feedback-id="t1"]\')');
    await js('document.querySelector(\'[data-feedback-id="t1"]\').click()');
    await wait("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"]')?.textContent.includes('reconnect timer')");
    await wait(`[...${T1}.querySelectorAll('button')].some(b=>b.textContent.trim()==='Reply'&&b.getBoundingClientRect().width>0)`);
    await click('Reply', T1);
    await type('.feedback-entry[data-feedback-id=\"t1\"] textarea', 'The timer now checks the closed flag.');
    await click('Reply on GitHub', T1);
    await instantly("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-sending')?.textContent==='Sending…'");
    assert.equal(await pendingComments(), 1);
    assert.equal(
      await js("!!document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] textarea')"),
      false,
      'The composer closed: the text shows as the comment'
    );
    assert.deepEqual(await held(), ['thread-reply']);
    await capture('reply-pending');
    await settle('ok');
    await wait("!document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] article[data-sending]')");
    assert.equal(await copies('The timer now checks the closed flag.'), 1, 'The real comment replaced the sending one');
    await js('window.optimisticFixture.refresh()');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await copies('The timer now checks the closed flag.'), 1, 'GitHub’s read shows it once, not twice');

    // ── A reply GitHub refuses: rolled back, the text kept, Retry sends it ──
    await click('Reply', T1);
    await type('.feedback-entry[data-feedback-id=\"t1\"] textarea', 'Also covered the shutdown test.');
    await click('Reply on GitHub', T1);
    await instantly(`document.querySelectorAll('.feedback-entry[data-feedback-id=\"t1\"] article[data-sending]').length===1`);
    await settle('GitHub is unavailable (502). Try again in a moment.');
    await wait("!!document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] [role=alert]')");
    assert.equal(await pendingComments(), 0, 'The sending comment is gone');
    assert.equal(await copies('Also covered the shutdown test.'), 0);
    assert.equal(
      await js("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] textarea')?.value"),
      'Also covered the shutdown test.',
      'The text is back in the composer'
    );
    const alert = await js<string>("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] [role=alert]').textContent");
    assert.match(alert, /Reply wasn’t posted/);
    assert.match(alert, /GitHub is unavailable \(502\)/);
    await capture('reply-error');
    await click('Retry', T1);
    await instantly(
      "document.querySelectorAll('.feedback-entry[data-feedback-id=\"t1\"] article[data-sending]').length===1 && !document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] [role=alert]')"
    );
    await settle('ok');
    await wait("!document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] article[data-sending]')");
    assert.equal(await copies('Also covered the shutdown test.'), 1);
    assert.equal(
      await js("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] textarea')?.value ?? ''"),
      '',
      'The sent text left the composer'
    );
    await js('window.optimisticFixture.refresh()');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await copies('Also covered the shutdown test.'), 1);

    // ── Resolve: at once, rolled back on failure, then resolved ──
    await click('Resolve thread', T1);
    await instantly(
      "document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Resolving…')"
    );
    await capture('resolve-pending');
    await settle('You do not have permission to resolve this thread.');
    await wait(
      "document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Unresolved')"
    );
    assert.match(
      await js<string>("document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] [role=alert]').textContent"),
      /Thread wasn’t resolved\..*permission/
    );
    await capture('resolve-error');
    await click('Retry', T1);
    await instantly(
      "document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Resolving…')"
    );
    await settle('ok');
    await wait(
      "document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Resolved') && !document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Unresolved')"
    );
    await js('window.optimisticFixture.refresh()');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      await js(
        "document.querySelector('.feedback-entry[data-feedback-id=\"t1\"] .github-thread-state')?.textContent.includes('Resolved')"
      )
    );

    // ── The header's Draft toggle (#542): it shows at once, rolls back on failure, and Undo writes the reverse ──
    win.setSize(1600, 900);
    await wait('innerWidth===1600');
    await js(`window.electronAPI.getPrActionState=async url=>{const m=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.url===url);
      return {...m,account:'oddur',id:'PR_1',checkedAt:Date.now(),state:'OPEN',headRepo:m.repo,repository:m.repo,archived:false,canWrite:true,mergeable:'MERGEABLE',mergeState:'CLEAN',methods:['SQUASH'],defaultMethod:'SQUASH',autoMerge:null,canEnableAuto:true,canDisableAuto:false,canUpdateBranch:false,canChangeDraft:true,mergeQueue:false,inMergeQueue:false,stack:null};};0`);
    // ⋯ › Refresh reads the PR's actions again, now with the state above.
    await menuAction(js, await js<string>("document.querySelector('.pr-overview-heading .entry-menu-trigger').getAttribute('aria-label')"), 'Refresh GitHub status');
    const draft = "[...document.querySelectorAll('.pr-header-actions [role=switch]')].find(b=>b.textContent==='Draft')";
    await wait(`${draft}?.getAttribute('aria-checked')==='false' && ${draft}.getAttribute('aria-disabled')!=='true'`);
    await js(`${draft}.click()`);
    await wait("window.optimisticFixture.held().includes('convert-draft')");
    await instantly(`${draft}.getAttribute('aria-checked')==='true'`);
    await instantly(`!!${row}?.querySelector('.queue-pr-icon.is-draft')`);
    await settle('Resource not accessible by integration');
    await instantly(`${draft}.getAttribute('aria-checked')==='false'`);
    await wait("document.querySelector('.pr-header-notes .pr-action-error')?.textContent.includes('Resource not accessible')");
    await js(`${draft}.click()`);
    await wait("window.optimisticFixture.held().includes('convert-draft')");
    await settle('ok');
    await wait(`${draft}.getAttribute('aria-checked')==='true'`);
    await js('window.optimisticFixture.refresh()');
    await wait("[...document.querySelectorAll('[data-slot=toast] button')].some(b=>b.textContent==='Undo')");
    await js("[...document.querySelectorAll('[data-slot=toast] button')].find(b=>b.textContent==='Undo').click()");
    await wait("window.optimisticFixture.held().includes('mark-ready')");
    await instantly(`${draft}.getAttribute('aria-checked')==='false'`);
    await settle('ok');
    await js('window.optimisticFixture.refresh()');
    await wait(`${draft}.getAttribute('aria-checked')==='false' && !${row}?.querySelector('.queue-pr-icon.is-draft')`);

    assert.deepEqual(await held(), [], 'Every write was answered');
    assert.deepEqual(
      await js('window.optimisticFixture.patches()'),
      [],
      'Every patch was confirmed by GitHub’s reads and cleared'
    );
    assert.deepEqual(errors, []);
    console.log(
      'Optimistic action browser checks passed: queue counts and draft, reply, failed reply with retry, resolve, header Draft toggle.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      console.log('Held:', JSON.stringify(await held()));
      console.log('Patches:', JSON.stringify(await js('window.optimisticFixture.patches()')));
      console.log(errors.join('\n'));
      console.log(await js<string>('document.body.innerText.slice(0, 3000)'));
    } catch {
      /* The renderer is unavailable. */
    }
    app.exit(1);
  }
});
