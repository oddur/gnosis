import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
/**
 * Feedback's behaviour on a stack, as one timeline (#418): aggregation and the PR picker, Hide GitHub Actions,
 * read and unread, pending and hidden comments, resolve and reopen with failures, replies to reviews, review
 * requests, earlier revisions, cached errors, drafts across tabs, Resolve & next across PRs with Undo and
 * completion, entry from the stack overview, and narrow and zoomed windows.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code: string) => {
    for (let n = 0; n < 300; n++) {
      if (await js(code)) return;
      await sleep(40);
    }
    throw Error(`Timeout: ${code}\n${errors.join('\n')}\n${await js<string>('document.body.innerText.slice(-6000)')}`);
  };
  /** A PR tab by its label: the breadcrumb's picker shows the same word. */
  const tab = (label: string) =>
    js(`(()=>{const b=[...document.querySelectorAll('.workspace-panel[data-workspace-active=true] .pr-overview-tabs [role=tab], .pr-overview-tabs [role=tab]')].find(b=>b.getBoundingClientRect().width&&b.querySelector('.pr-tab-label')?.dataset.label===${JSON.stringify(label)});if(!b)throw Error('Missing tab '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  const click = (label: string, scope = 'document') =>
    js(
      `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const entry = (id: string) => `document.querySelector('.feedback-entry[data-feedback-id="${id}"]')`;
  /** Scroll the virtualized timeline until the item is mounted, put it at the top, and make it the cursor. */
  const show = async (id: string) => {
    await js(`(async()=>{const t=document.querySelector('[data-feedback-scroller]');let e=${entry(id)};if(!e){t.scrollTop=0;for(let i=0;i<120&&!(e=${entry(id)});i++){t.scrollTop+=300;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}}
      e?.scrollIntoView({block:'start'});e?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))})()`);
    await wait(`${entry(id)}?.getAttribute('aria-current')==='true'`);
  };
  const filter = (name: string) =>
    js(`[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith(${JSON.stringify(name)})).click()`);
  const type = (selector: string, text: string) =>
    js(`(()=>{const input=${selector};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await sleep(150);
    const dir = path.resolve('.impeccable/review/feedback');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(String.raw`(async()=>{
      window.feedbackWrites=[];window.feedbackReads=0;window.feedbackData=new Map();
      const q=await window.electronAPI.workbenchQueue();const stack=q.items.find(i=>i.subject.kind==='stack');window.feedbackSubject=stack.subject;
      for(const [index,m] of stack.subject.members.entries()){
        const stamp='2026-11-03T10:00:0'+index+'Z';const c={id:'c-'+m.number,body:'Please keep the pending owner check. A retry can arrive after a newer upload has replaced this generation.',author:{login:'maya',avatarUrl:''},createdAt:stamp,updatedAt:stamp,url:m.url+'#issuecomment-1'};
        const t={id:'t-'+m.number,path:index===1?'src/uploads/confirm.ts':index===2?'src/new.ts':'src/worker.ts',line:index===2?2:36,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:index===1,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{...c,id:'tc-'+m.number,diffHunk:'@@ -33,4 +33,4 @@\n const value32 = 32;\n const value33 = 33;\n const value34 = 34;\n-const value35 = 35;\n+const value35 = 36;',pullRequestReview:{id:'r-'+m.number},viewerCanUpdate:false,viewerCanDelete:false}]};
        window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[t],feedback:{comments:[{...c,body:'The migration is safe to run before this deploy. Can you add the rollback command to the PR description?'}],reviews:[{...c,id:'r-'+m.number,state:'CHANGES_REQUESTED',submittedAt:stamp,body:'The new upload path is easier to follow. One correctness issue remains in confirmation.\n\n- Keep the generation check before committing.\n- Return a conflict if the pending owner changed.'}],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}});
      }
      {const first=window.feedbackData.get(stack.subject.members.find(m=>m.number===120).url).threads[0];const base=first.comments[0];first.comments.push({...base,id:'hidden-reply',body:'This note was superseded.',author:{login:'sam',avatarUrl:''},isMinimized:true,minimizedReason:'outdated'},{...base,id:'pending-reply',body:'Added the generation check to the confirm path.',author:{login:'oddur',avatarUrl:''},pullRequestReview:{id:'draft-review',state:'PENDING'}});}
      for(const data of window.feedbackData.values())data.feedback.comments.push({...data.feedback.comments[0],id:'actions-'+data.feedback.comments[0].id,body:'Client/server tests passed',author:{login:'github-actions[bot]',avatarUrl:''}});
      window.electronAPI.getCachedReviewThreads=async url=>structuredClone(window.feedbackData.get(url));
      window.electronAPI.getReviewThreads=async url=>{window.feedbackReads++;if(window.failFeedback)throw Error('GitHub is temporarily unavailable');return structuredClone(window.feedbackData.get(url)??{headSha:'',baseSha:'',threads:[],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:false,state:'OPEN'}})};
      window.electronAPI.reviewThreadAction=async req=>{if(window.failFeedbackWrite)throw Error('Could not save to GitHub');window.feedbackWrites.push(req);const t=window.feedbackData.get(req.prUrl).threads.find(t=>t.id===req.threadId);if(req.action==='reply')t.comments.push({...t.comments[0],id:'reply-'+Date.now(),body:req.body,author:{login:'oddur',avatarUrl:''},createdAt:new Date().toISOString()});else {t.isResolved=req.action==='resolve';t.viewerCanResolve=!t.isResolved;t.viewerCanUnresolve=t.isResolved;}return structuredClone(t)};
      window.electronAPI.feedbackAction=async req=>{if(window.failFeedbackWrite)throw Error('Could not save to GitHub');window.feedbackWrites.push(req);if(req.action==='request-review')window.feedbackData.get(req.prUrl).feedback.requestedReviewers.push(req.reviewer)};
    })()`);
    await js(
      "document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await wait("!!document.querySelector('.stack-overview')");
    await tab('Summary');
    await wait(
      "document.querySelectorAll('.feedback-entry').length>2 && document.querySelector('.feedback-sync')?.textContent==='Updates automatically'"
    );
    // Opening the tab reads nothing by itself: only what stays on screen for a moment becomes read.
    assert.match(await js<string>("document.querySelector('.feedback-filters').textContent"), /Unread 9/, 'Opening the tab must not read all conversations');
    await js(`(async()=>{const t=document.querySelector('[data-feedback-scroller]');for(let i=0;i<60&&!document.querySelector('.feedback-entry[data-feedback-id]');i++){t.scrollTop+=300;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}document.querySelector('.feedback-entry[data-feedback-id]')?.scrollIntoView({block:'start'})})()`);
    await sleep(2000);
    const unreadAfter = Number((await js<string>("document.querySelector('.feedback-filters').textContent")).match(/Unread (\d+)/)?.[1]);
    assert.ok(unreadAfter > 0 && unreadAfter < 9, `Only conversations seen on screen become read: ${unreadAfter}`);
    assert.equal(await js("!!document.querySelector('.feedback-new-since')"), false, 'A first visit has nothing to divide');
    assert.equal(await js("document.querySelector('.feedback-actions-filter input').checked"), true);
    await js("document.querySelector('.feedback-actions-filter input').click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 12'");
    await tab('Commits');
    await tab('Summary');
    await wait("document.querySelector('.feedback-actions-filter input')?.checked===false");
    await show('actions-c-120');
    assert.match(await js<string>(`${entry('actions-c-120')}.textContent`), /Client\/server tests passed/);
    await js("document.querySelector('.feedback-actions-filter input').click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 9'");
    await capture('stack-list-light');

    // A code thread in its code: pending and hidden comments keep their labels.
    await show('t-120');
    await wait(`!!${entry('t-120')}.querySelector('.feedback-code-thread .changes-diff .github-thread')`);
    assert.match(await js<string>(`${entry('t-120')}.textContent`), /pending owner/);
    await capture('thread-light');
    assert.equal(await js(`${entry('t-120')}.querySelector('[data-pending] .github-comment-pending')?.textContent.trim()`), 'Pending · not submitted');
    assert.match(await js<string>(`${entry('t-120')}.querySelector('.github-thread > summary').textContent`), /2 comments · 1 pending/);
    assert.equal(await js(`${entry('t-120')}.querySelector('.github-comment-hidden')?.open`), false);
    assert.match(await js<string>(`${entry('t-120')}.querySelector('.github-comment-hidden summary').textContent`), /Hidden on GitHub as outdated/);
    await js("document.documentElement.classList.add('dark')");
    await capture('pending-reply-dark');
    await js("document.documentElement.classList.remove('dark')");

    // Resolve and reopen in place; a resolved thread stays open where it was resolved.
    await click('Resolve thread', entry('t-120'));
    await wait(`${entry('t-120')}?.querySelector('.github-thread-state')?.textContent.includes('Resolved')`);
    assert.equal(await js('window.feedbackWrites.at(-1).prUrl'), await js('window.feedbackSubject.members[0].url'));
    await capture('resolved-thread-light');
    await click('Reopen thread', entry('t-120'));
    await wait(`${entry('t-120')}?.querySelector('.github-thread-state')?.textContent.includes('Unresolved')`);
    // A failed resolve keeps the reply being written and names the failure.
    await click('Reply', entry('t-120'));
    await wait(`!!${entry('t-120')}.querySelector('textarea')`);
    await type(`${entry('t-120')}.querySelector('textarea')`, 'Keep this draft while resolving.');
    await js('window.failFeedbackWrite=true');
    await click('Resolve thread', entry('t-120'));
    await wait(`${entry('t-120')}?.querySelector('.github-thread-error')?.textContent.includes('Thread wasn’t resolved')`);
    assert.equal(await js(`${entry('t-120')}.querySelector('textarea').value`), 'Keep this draft while resolving.');
    assert.equal(await js(`${entry('t-120')}.querySelector('.github-thread-error').textContent.includes('Reply wasn’t posted')`), false);
    await capture('resolve-error-with-draft');
    await js('window.failFeedbackWrite=false');
    await click('Cancel', entry('t-120'));
    await click('Mark unread', entry('t-120'));
    await wait(`!!${entry('t-120')}?.querySelector('.pr-unread-dot')`);
    await sleep(1600);
    assert.ok(await js(`!!${entry('t-120')}?.querySelector('.pr-unread-dot')`), 'Marked unread stays unread while on screen');

    // A review: its verdict, related threads, and a reply that fails and then posts.
    await show('r-120');
    assert.match(await js<string>(`${entry('r-120')}.textContent`), /Changes requested/);
    assert.ok(await js(`!!${entry('r-120')}.querySelector('.feedback-review-index')`));
    await capture('review-light');
    await click('Reply', entry('r-120'));
    await wait(`!!${entry('r-120')}.querySelector('textarea')`);
    await type(`${entry('r-120')}.querySelector('textarea')`, 'The guard is restored in the latest commit.');
    await js('window.failFeedbackWrite=true');
    await click('Reply on GitHub', entry('r-120'));
    await wait(`${entry('r-120')}?.querySelector('.feedback-message [role=alert]')?.textContent.includes('Reply wasn’t posted')`);
    assert.equal(await js(`${entry('r-120')}.querySelector('textarea').value`), 'The guard is restored in the latest commit.');
    const visible = `(()=>{const a=${entry('r-120')}.querySelector('[role=alert]').getBoundingClientRect(),b=document.querySelector('[data-feedback-scroller]').getBoundingClientRect();return a.top>=b.top-1 && a.bottom<=b.bottom+1})()`;
    await js(`${entry('r-120')}.querySelector('[role=alert]').scrollIntoView({block:'nearest'})`);
    await wait(visible);
    await capture('reply-error');
    await js('window.failFeedbackWrite=false');
    await click('Reply on GitHub', entry('r-120'));
    await wait(`[...${entry('r-120')}.querySelectorAll('[role=status]')].some(el=>el.textContent.includes('Reply posted'))`);
    assert.equal(await js('window.feedbackWrites.at(-1).sourceId'), 'r-120');

    // Review requests stay in their popover and never resolve threads.
    await js('document.querySelector(\'[aria-label="Review requests"]\').click()');
    await wait("!!document.querySelector('[data-request-review]')");
    await capture('review-requests-light');
    await js("document.querySelector('[data-request-review]').click()");
    await wait("document.querySelector('[data-request-review]')?.textContent.includes('Review requested')");
    assert.equal(await js('window.feedbackWrites.at(-1).reviewer'), 'maya');
    assert.ok(await js("document.querySelector('.feedback-reviewer').textContent.includes('1 unresolved thread')"), 'Re-request must not resolve or hide threads');
    await js("document.querySelector('[aria-label=\"Close review requests\"]').click();document.documentElement.classList.add('dark')");
    await capture('review-dark');

    // An earlier revision says so, and keeps an optional route to current Changes.
    await show('t-121');
    await wait(`${entry('t-121')}?.querySelector('.changes-file-header')?.textContent.includes('Earlier revision')`);
    assert.ok(await js(`[...${entry('t-121')}.querySelectorAll('button')].some(b=>b.textContent==='Open in Changes')`));
    await capture('outdated-dark');
    await js('window.failFeedback=true');
    await js('document.querySelector(\'[aria-label="Refresh feedback"]\').click()');
    await wait("document.querySelector('.feedback-notice')?.textContent.includes('Could not refresh')");
    assert.ok(await js(`!!${entry('t-121')}?.querySelector('.changes-diff')`), 'Refresh failure keeps cached conversations');
    await capture('cached-error-dark');
    win.setContentSize(640, 800);
    await sleep(250);
    assert.ok(await js("document.querySelector('.feedback-timeline').getBoundingClientRect().height >= 150"), 'Narrow windows retain a usable reading area');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("document.querySelector('.feedback-timeline').scrollWidth<=document.querySelector('.feedback-timeline').clientWidth+1"), true, 'No sideways scroll in a narrow timeline');
    await capture('narrow-conversation-dark');
    win.setContentSize(1280, 800);
    await js("document.documentElement.classList.remove('dark');window.failFeedback=false");
    // An item is read after it stays mostly on screen for a moment (READ_DWELL_MS); make sure the review is read before
    // leaving, rather than relying on how long earlier steps kept it on screen (a slow runner scrolls on sooner).
    await show('r-120');
    await wait(`!!${entry('r-120')}&&!${entry('r-120')}.querySelector('.pr-unread-dot')`);
    await tab('Commits');
    await tab('Summary');
    await wait("document.querySelectorAll('.feedback-entry').length>0");
    await show('r-120');
    assert.equal(await js(`!!${entry('r-120')}.querySelector('.pr-unread-dot')`), false, 'Read status survives tab navigation');
    await js(
      `(async()=>{const m=window.feedbackSubject.members[0],data=window.feedbackData.get(m.url);data.threads[0].comments.push({...data.threads[0].comments[0],id:'new-incoming',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),body:'Thanks. One more question about retries.'});const {receiveDiscussion}=await import('/lib/review-discussion-cache.ts');receiveDiscussion(m.url,structuredClone(data));})()`
    );
    await show('t-120');
    assert.match(await js<string>(`${entry('t-120')}.textContent`), /One more question/, 'A new reply shows in its thread');

    // Keys move the cursor between items.
    await js(`${entry('t-120')}.focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'j' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'j' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'j' });
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId!=='t-120'");

    // The PR picker scopes the timeline, counts and review requests together.
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('#121')).click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 3'");
    assert.ok(await js("[...document.querySelectorAll('.feedback-entry[data-feedback-id]')].every(e=>e.dataset.feedbackId.endsWith('121'))"));
    await js('document.querySelector(\'[aria-label="Review requests"]\').click()');
    await wait("document.querySelectorAll('[data-request-review]').length===1");
    assert.equal(await js("document.querySelector('[data-request-review]').getAttribute('data-request-review')"), '121');
    await capture('filtered-requests-light');
    await js('document.querySelector(\'[aria-label="Close review requests\"]\').click()');
    await show('r-121');
    await filter('Unresolved');
    await wait("[...document.querySelectorAll('.feedback-entry[data-feedback-id]')].map(e=>e.dataset.feedbackId).sort().join()==='r-121,t-121'");
    win.setContentSize(900, 600);
    await sleep(150);
    await capture('short-laptop-light');
    assert.ok(await js("document.querySelector('.feedback-timeline').getBoundingClientRect().height>=150"), 'Short laptop retains readable content');
    win.setContentSize(1280, 800);
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent==='All PRs').click()");
    await filter('All ');

    // Full file below the thread, without repeating the conversation.
    await show('t-120');
    await click('Show full file', entry('t-120'));
    await wait("!!document.querySelector('.feedback-full-file .commit-stream-file')");
    assert.equal(await js("document.querySelectorAll('.feedback-timeline .github-thread[data-thread-id=\"t-120\"]').length"), 1, 'Full context must not duplicate conversations');
    await capture('feedback-full-file-light');
    await click('Hide full file', entry('t-120'));
    // A reply draft survives scrolling away and back, and a trip to Changes.
    await click('Reply', entry('t-120'));
    await wait(`!!${entry('t-120')}.querySelector('textarea')`);
    await type(`${entry('t-120')}.querySelector('textarea')`, 'Keep this reply while browsing.');
    await show('t-122');
    await show('t-120');
    await wait(`${entry('t-120')}?.querySelector('textarea')?.value==='Keep this reply while browsing.'`);
    await js('window.failFeedbackWrite=true');
    await click('Resolve & next', entry('t-120'));
    await wait(`${entry('t-120')}?.querySelector('.github-thread-error')?.textContent.includes('Thread wasn’t resolved')`);
    assert.equal(await js(`${entry('t-120')}.getAttribute('aria-current')`), 'true', 'Failure must not advance');
    await js('window.failFeedbackWrite=false');
    await click('Open in Changes', entry('t-120'));
    await wait("!!document.querySelector('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"]')");
    assert.equal(await js("!!document.querySelector('.changes-view-switch')"), false, 'Changes has no feedback viewing mode');
    await wait("document.querySelector('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"] textarea')?.value==='Keep this reply while browsing.'");
    await js("[...document.querySelectorAll('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"] button')].find(b=>b.textContent==='Address feedback').click()");
    await wait(`${entry('t-120')}?.getAttribute('aria-current')==='true'`);
    assert.equal(await js("document.querySelector('.pr-overview-tabs [data-state=active]').textContent"), 'Summary');
    await wait(`${entry('t-120')}?.querySelector('textarea')?.value==='Keep this reply while browsing.'`);
    await click('Cancel', entry('t-120'));
    // A thread link scopes to its PR. Return to all PRs before going through the stack.
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent==='All PRs').click()");

    // Resolve & next goes across PRs; Undo reopens; the last one completes without implying approval.
    await show('t-120');
    await click('Resolve & next', entry('t-120'));
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-121'");
    assert.equal(await js('window.feedbackWrites.at(-1).prUrl'), await js('window.feedbackSubject.members[0].url'));
    assert.match(await js<string>("document.querySelector('.feedback-resolution').textContent"), /Thread resolved.*#120.*src\/worker.ts/);
    await click('Undo');
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-120'");
    assert.equal(await js('window.feedbackData.get(window.feedbackSubject.members[0].url).threads[0].isResolved'), false);
    await click('Resolve & next', entry('t-120'));
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-121'");
    await click('Resolve & next', entry('t-121'));
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-122'");
    await js("document.documentElement.classList.add('dark')");
    await capture('feedback-next-pr-dark');
    await click('Resolve & next', entry('t-122'));
    await wait("!!document.querySelector('.feedback-complete')");
    assert.match(await js<string>("document.querySelector('.feedback-complete').textContent"), /does not approve a PR/);
    await capture('feedback-complete-dark');
    await click('Re-request review', "document.querySelector('.feedback-complete')");
    await wait("!!document.querySelector('.feedback-reviewers')");
    assert.match(await js<string>("document.querySelector('.feedback-reviewers').textContent"), /No unresolved threads/);
    await js("document.querySelector('[aria-label=\"Close review requests\"]').click()");

    // A stack review blocker opens the PR's review summary in Feedback.
    await tab('Summary');
    await js(`(async()=>{
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>({...value,readiness:{...value.readiness,reviewDecision:'CHANGES_REQUESTED',mergeState:'BLOCKED'}}));
      publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(window.feedbackSubject.members.map(({url,headSha})=>({url,headSha}))));
    })()`);
    await wait("!!document.querySelector('.stack-overview [data-blocker-key=review] button')");
    assert.equal(await js("!!document.querySelector('.stack-overview [data-blocker-key=review] a')"), false, 'Review blockers lead into Gnosis');
    await js("document.querySelector('.stack-overview [data-pr-url$=\"/120\"] [data-blocker-key=review] button').click()");
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='r-120'");
    await capture('address-from-stack-dark');

    // Long paths and extreme zoom stay contained.
    await js(`(async()=>{
      const m=window.feedbackSubject.members[0],data=window.feedbackData.get(m.url);
      const thread=data.threads[0];thread.path='project/workers/unity-client/Assets/Klang/Seed/Scripts/Client/UI/EvolveUI/ClientLocalizationCompilation.asset';
      const {receiveDiscussion}=await import('/lib/review-discussion-cache.ts');receiveDiscussion(m.url,structuredClone(data));
    })()`);
    win.setContentSize(1920, 1100);
    await sleep(200);
    await show('t-120');
    assert.ok(await js(`${entry('t-120')}.getBoundingClientRect().width>=1600`), 'Wide windows use the width');
    await capture('refined-long-path-wide-dark');
    win.setContentSize(1280, 800);
    win.webContents.setZoomFactor(2);
    await sleep(200);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true, 'Feedback remains contained at 200% zoom');
    await capture('refined-zoom-dark');
    win.webContents.setZoomFactor(1);
    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log(
      'Feedback passed: stack timeline, read/unread, pending and hidden comments, resolve/reopen and failures, review replies, review requests, earlier revisions, cached errors, drafts across tabs, Resolve & next with Undo and completion, keyboard, narrow, wide and zoomed layouts.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'), await js('document.body.innerText.slice(-6000)'));
    await capture('failure');
    app.exit(1);
  }
});
