import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { menuAction } from './entry-menu-helpers';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(code)) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width && (e.textContent.trim()===${JSON.stringify(label)} || e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  };
  const dir = path.resolve('.impeccable/review/review-entry-points');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    win.show(); win.focus();
    await new Promise(r => setTimeout(r, 650));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.reviewSubmissions=[];window.electronAPI.submitReview=async request=>{
      window.reviewSubmissions.push(request);
      return {reviewUrl:request.prUrl+'#review-fixture',droppedCommentCount:0};
    };void 0`);
    const selected = await js("document.querySelector('.queue-item.is-selected .queue-title')?.textContent");
    await menuAction(js, 'Actions for PR #152', 'Review PR #152…');
    await wait("document.querySelector('.review-submit-header')?.textContent.includes('#152')");
    assert.equal(await js("document.querySelector('[role=tab][aria-selected=true]').textContent"), 'Summary');
    assert.notEqual(await js("document.querySelector('h1').textContent"), selected);
    assert.equal(await js('window.reviewSubmissions.length'), 0, 'Opening a menu action never submits');
    await click('Close');
    await wait("!document.querySelector('[role=dialog]')");
    await wait("!![...document.querySelectorAll('.pr-summary-review-actions button')].find(b=>b.textContent==='Review PR #152'&&!b.disabled)");
    await capture('summary-light');
    await click('Review PR #152');
    assert.equal(await js("document.querySelector('input[value=COMMENT]').checked"), true);
    assert.equal(await js("[...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review').disabled"), true, 'An empty comment review cannot be submitted');
    await js("document.querySelector('input[value=COMMENT]').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await wait("document.querySelector('input[value=APPROVE]').checked");
    await js("document.querySelector('input[type=radio][value=APPROVE]').click()");
    await wait("!![...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review'&&!b.disabled)");
    await js("document.querySelector('input[value=APPROVE]').focus()");
    await capture('review-dialog');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(640, 740);
    await capture('review-dialog-narrow-dark');
    assert.equal(await js("document.querySelector('.review-submit-footer').getBoundingClientRect().bottom<=innerHeight"), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    // Submission is bound to the revision shown when the action was opened.
    const originalHead = await js('window.electronAPI.workbenchQueue().then(q=>q.items.flatMap(i=>i.subject.members).find(m=>m.number===152).headSha)');
    await js("document.querySelector('input[type=radio][value=APPROVE]').click()");
    await click('Submit review');
    await wait("document.body.textContent.includes('Feedback submitted to GitHub')");
    assert.equal(await js('window.reviewSubmissions.length'), 1);
    assert.equal(await js('window.reviewSubmissions[0].headSha'), originalHead);
    assert.equal(await js('window.reviewSubmissions[0].prUrl'), 'https://github.com/klang/engine/pull/152');
    assert.equal(await js('window.reviewSubmissions[0].event'), 'APPROVE');
    await click('Done');
    win.setSize(640, 800);
    await js("document.documentElement.classList.add('dark')");
    await capture('summary-narrow-dark');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await click('Review queue');
    await wait("!!document.querySelector('.queue-disclosure')");
    await menuAction(js, 'Stack actions', 'Review PR #121…');
    await wait("document.querySelector('.review-submit-header')?.textContent.includes('#121')");
    await click('Close');
    await wait("document.querySelector('[aria-label=\"Review scope\"]')?.value.endsWith('/121')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Review scope\"]').textContent"), /#121/);
    assert.equal(await js("document.querySelector('.pr-summary-review-actions').textContent.includes('Review PR #121')"), true);
    await capture('stack-summary');
    await click('Back to stack');
    await menuAction(js, 'Stack actions', 'Review PR #120…');
    await wait("document.querySelector('.review-submit-header')?.textContent.includes('#120')");
    await click('Close');
    await wait("!document.querySelector('[role=dialog]')");
    // Shared drafts from Changes are shown in Summary and removed only after successful submission.
    await js(`(async()=>{
      const {updateReviewDrafts}=await import('/lib/changes-review-drafts.ts');
      const member=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.number===120);
      const draft={id:'shared-review-draft',filePath:'src/worker.ts',body:'Explain the retry boundary.',line:35,side:'RIGHT',hunkHeader:'',codeSnippet:'await queue.retry(command);',slideIndex:0,headSha:member.headSha,baseSha:member.baseSha,baseBranch:member.baseBranch};
      await updateReviewDrafts('oddur',member.url,()=>[draft,{...draft,id:'second',body:'Can this retry run after cancellation?',line:38},{...draft,id:'third',filePath:'src/command-queue.ts',body:'Please document the ownership of this queue.',line:12,side:'LEFT',codeSnippet:''}]);
    })()`);
    await click('Review PR #120 (3)');
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Explain the retry boundary.')");
    assert.equal(await js("document.querySelector('.review-submit-comments h3').textContent"), '3 comments in 2 files');
    await js("document.querySelector('.review-submit-comments').scrollIntoView({block:'nearest'})");
    await capture('comments-light');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(520, 740);
    await capture('comments-narrow-dark');
    assert.equal(await js("document.querySelector('.review-submit-footer').getBoundingClientRect().bottom<=innerHeight"), true);
    await js("document.querySelector('.review-submit-comment button').click()");
    await wait("!!document.querySelector('.review-submit-comment textarea')");
    await js(`(()=>{const e=document.querySelector('.review-submit-comment textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Explain why retries stop after cancellation.');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await wait("[...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent==='Submit review').disabled");
    // Canceling the modal preserves an unfinished edit and still blocks posting after reopening.
    await js("document.querySelector('.review-submit-footer button').click()");
    await wait("!document.querySelector('[role=dialog]')");
    await click('Review PR #120 (3)');
    await wait("document.querySelector('.review-submit-comment textarea')?.value==='Explain why retries stop after cancellation.'");
    assert.equal(await js("[...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent==='Submit review').disabled"), true);
    await js(`window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('gnosis-changes-drafts:'))throw Error('Disk full');return window.realSetItem.call(this,k,v)};void 0`);
    await click('Save draft');
    await wait("document.querySelector('.review-submit-comment [role=alert]')?.textContent.includes('Could not save')");
    await capture('edit-error-dark');
    await js('Storage.prototype.setItem=window.realSetItem;void 0');
    await click('Save draft');
    await wait("!document.querySelector('.review-submit-comment textarea')");
    await js("[...document.querySelectorAll('.review-submit-comment')][1].querySelectorAll('button')[1].click()");
    await wait("document.querySelector('.review-submit-comments h3')?.textContent==='2 comments in 2 files'");
    assert.equal(await js("document.querySelector('.review-submit-comments').textContent.includes('Explain why retries stop after cancellation.')"), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    await js("document.querySelector('input[type=radio][value=REQUEST_CHANGES]').click()");
    await click('Submit review');
    await wait('window.reviewSubmissions.length===2');
    assert.equal(await js('window.reviewSubmissions[1].event'), 'REQUEST_CHANGES');
    assert.equal(await js('window.reviewSubmissions[1].comments.length'), 2);
    assert.equal(await js('window.reviewSubmissions[1].comments[0].body'), 'Explain why retries stop after cancellation.');
    assert.equal(await js('window.reviewSubmissions[1].comments[0].path'), 'src/worker.ts');
    assert.equal(await js('window.reviewSubmissions[1].prUrl'), 'https://github.com/klang/engine/pull/120');
    await click('Done');
    await wait("document.querySelector('.pr-summary-review-actions')?.textContent==='DraftsReview PR #120'");
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-tree')");
    await js(`window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];void 0`);
    await wait("!!window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')?.includes('src/new.ts'))");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('data-item-path')?.includes('src/new.ts')).click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/new.ts'");
    await click('Summary');
    await js(`(async()=>{
      const {updateReviewDrafts}=await import('/lib/changes-review-drafts.ts');
      const member=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.number===121);
      await updateReviewDrafts('oddur',member.url,()=>[{id:'stale-review-draft',filePath:'src/worker.ts',body:'Keep this earlier note.',line:35,side:'RIGHT',hunkHeader:'',codeSnippet:'',slideIndex:0,headSha:'old-sha',baseSha:member.baseSha,baseBranch:member.baseBranch}]);
    })()`);
    await click('Back to stack');
    await menuAction(js, 'Stack actions', 'Review PR #121…');
    await wait("document.querySelector('.changes-drafts')?.textContent.includes('Keep this earlier note.')");
    assert.equal(await js("!!document.querySelector('[role=dialog]')"), false);
    assert.equal(await js("[...document.querySelectorAll('.pr-summary-review-actions button')].find(b=>b.textContent.includes('Review PR')).disabled"), true);
    assert.equal(await js('window.reviewSubmissions.length'), 2);
    await capture('stale-drafts');
    await click('Open Changes to reposition');
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/worker.ts'");
    await wait("document.querySelector('.changes-toolbar')?.textContent.includes('Review PR #121')");
    assert.equal(await js("[...document.querySelectorAll('.changes-toolbar button')].find(b=>b.textContent.includes('Review PR')).disabled"), true);
    await capture('stale-draft-destination');
    console.log('Review entry points passed: summary, queue/stack/header menus, explicit targets, shared drafts, approvals, change requests, stale-draft recovery and narrow/dark layout.');
  } catch (error) {
    console.error(error); process.exitCode = 1; await capture('failure');
  } finally { win.destroy(); app.exit(process.exitCode ? 1 : 0); }
});
