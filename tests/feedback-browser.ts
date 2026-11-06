import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
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
  const wait = async (code: string) => {
    for (let n = 0; n < 300; n++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error(`Timeout: ${code}\n${errors.join('\n')}\n${await js<string>('document.body.innerText.slice(-6000)')}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 150));
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
        const stamp='2026-11-03T10:00:00Z';const c={id:'c-'+m.number,body:'Please keep the pending owner check. A retry can arrive after a newer upload has replaced this generation.',author:{login:'maya',avatarUrl:''},createdAt:stamp,updatedAt:stamp,url:m.url+'#issuecomment-1'};
        const t={id:'t-'+m.number,path:index===1?'src/uploads/confirm.ts':index===2?'src/new.ts':'src/worker.ts',line:index===2?2:36,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:index===1,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{...c,id:'tc-'+m.number,diffHunk:'@@ -38,5 +38,6 @@\n const pending = await uploads.find(id);\n-if (pending.owner === owner) {\n+if (pending.owner === owner &&\n+    pending.generation === generation) {\n   await uploads.confirm(id);\n }',pullRequestReview:{id:'r-'+m.number},viewerCanUpdate:false,viewerCanDelete:false}]};
        window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[t],feedback:{comments:[{...c,body:'The migration is safe to run before this deploy. Can you add the rollback command to the PR description?'}],reviews:[{...c,id:'r-'+m.number,state:'CHANGES_REQUESTED',submittedAt:stamp,body:'The new upload path is easier to follow. One correctness issue remains in confirmation.\n\n- Keep the generation check before committing.\n- Return a conflict if the pending owner changed.'}],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}});
      }
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
    await click('Feedback');
    await wait(
      "document.querySelectorAll('.feedback-row').length>2 && document.querySelector('.feedback-sync')?.textContent==='Updates automatically'"
    );
    assert.equal(
      await js("document.querySelectorAll('.feedback-row.is-unread').length"),
      9,
      'Opening the tab must not read all conversations'
    );
    assert.equal(await js("document.querySelector('.feedback-actions-filter input').checked"), true);
    await js("document.querySelector('.feedback-actions-filter input').click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 12'");
    await click('Summary');
    await click('Feedback');
    await wait("document.querySelector('.feedback-actions-filter input')?.checked===false");
    await js('document.querySelector(\'[data-feedback-id="actions-c-120"]\').click()');
    await wait("document.querySelector('.feedback-conversation')?.textContent.includes('Client/server tests passed')");
    await js("document.querySelector('.feedback-actions-filter input').click()");
    await wait(
      "document.querySelector('.feedback-filters button').textContent.trim()==='All 9' && document.querySelector('.feedback-workspace').dataset.conversationOpen==='false'"
    );
    await capture('stack-list-light');
    await js('document.querySelector(\'[data-feedback-id="t-120"]\').click()');
    await wait(
      "!!document.querySelector('.feedback-code') && !document.querySelector('[data-feedback-id=\"t-120\"]').classList.contains('is-unread')"
    );
    assert.match(await js<string>("document.querySelector('.feedback-conversation').textContent"), /pending owner/);
    await capture('thread-light');
    await click('Resolve thread');
    await wait("document.querySelector('.github-thread-state').textContent.includes('Resolved')");
    assert.equal(await js('window.feedbackWrites.at(-1).prUrl'), await js('window.feedbackSubject.members[0].url'));
    await capture('resolved-thread-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('resolved-thread-dark');
    await js("document.documentElement.classList.remove('dark')");
    await click('Reopen thread');
    await wait("document.querySelector('.github-thread-state').textContent.includes('Unresolved')");
    await click('Reply');
    await js(
      "(()=>{const input=document.querySelector('.github-thread textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this draft while resolving.');input.dispatchEvent(new Event('input',{bubbles:true}));window.failFeedbackWrite=true})()"
    );
    await click('Resolve thread');
    await wait("document.querySelector('.github-thread-error')?.textContent.includes('Thread wasn’t resolved')");
    assert.equal(
      await js("document.querySelector('.github-thread textarea').value"),
      'Keep this draft while resolving.'
    );
    assert.equal(
      await js("document.querySelector('.github-thread-error').textContent.includes('Reply wasn’t posted')"),
      false
    );
    await capture('resolve-error-with-draft');
    await js('window.failFeedbackWrite=false');
    await click('Cancel');
    await click('Mark unread');
    await wait("document.querySelector('[data-feedback-id=\"t-120\"]').classList.contains('is-unread')");
    await js('document.querySelector(\'[data-feedback-id="r-120"]\').click()');
    await wait("!!document.querySelector('.feedback-related')");
    await capture('review-light');
    await click('Reply');
    await js(
      "(()=>{const input=document.querySelector('.feedback-message textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'The guard is restored in the latest commit.');input.dispatchEvent(new Event('input',{bubbles:true}));window.failFeedbackWrite=true;})()"
    );
    await click('Reply on GitHub');
    await wait("document.querySelector('.feedback-message [role=alert]')?.textContent.includes('Reply wasn’t posted')");
    assert.equal(
      await js("document.querySelector('.feedback-message textarea').value"),
      'The guard is restored in the latest commit.'
    );
    assert.ok(
      await js(
        "(()=>{const a=document.querySelector('.feedback-message [role=alert]').getBoundingClientRect(),b=document.querySelector('.feedback-conversation-body').getBoundingClientRect();return a.top>=b.top && a.bottom<=b.bottom})()"
      ),
      'The reply failure must be visible beside retry controls'
    );
    await capture('reply-error');
    await js('window.failFeedbackWrite=false');
    await click('Reply on GitHub');
    await wait(
      "[...document.querySelectorAll('.feedback-message [role=status]')].some(el=>el.textContent.includes('Reply posted'))"
    );
    assert.equal(await js('window.feedbackWrites.at(-1).sourceId'), 'r-120');
    await js('document.querySelector(\'[aria-label="Review requests"]\').click()');
    await wait("!!document.querySelector('[data-request-review]')");
    await capture('review-requests-light');
    await js("document.querySelector('[data-request-review]').click()");
    await wait("document.querySelector('[data-request-review]')?.textContent.includes('Review requested')");
    assert.equal(await js('window.feedbackWrites.at(-1).reviewer'), 'maya');
    assert.ok(
      await js("document.querySelector('.feedback-reviewer').textContent.includes('1 unresolved thread')"),
      'Re-request must not resolve or hide threads'
    );
    await js(
      "document.querySelector('[aria-label=\"Close review requests\"]').click();document.documentElement.classList.add('dark')"
    );
    await capture('review-dark');
    await js('document.querySelector(\'[data-feedback-id="t-121"]\').click()');
    await wait("document.querySelector('.feedback-code-heading').textContent.includes('earlier revision')");
    assert.equal(
      await js(
        "[...document.querySelectorAll('.feedback-conversation button')].some(b=>b.textContent==='Open in Changes')"
      ),
      true,
      'Earlier revision threads keep an optional route to current Changes'
    );
    await capture('outdated-dark');
    await js('window.failFeedback=true');
    await js('document.querySelector(\'[aria-label="Refresh feedback"]\').click()');
    await wait("document.querySelector('.feedback-notice')?.textContent.includes('Could not refresh')");
    assert.ok(await js("!!document.querySelector('.feedback-code')"), 'Refresh failure keeps selected cached context');
    await capture('cached-error-dark');
    win.setContentSize(640, 800);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      await js("document.querySelector('.feedback-conversation-body').getBoundingClientRect().height >= 150"),
      'Narrow windows retain a usable reading area after a refresh error'
    );
    assert.ok(
      await js(
        "(()=>{const c=document.querySelector('.github-thread-comments').getBoundingClientRect(),b=document.querySelector('.feedback-conversation-body').getBoundingClientRect();return c.top < b.bottom && c.bottom > b.top})()"
      ),
      'The actual conversation intersects the visible reading area'
    );
    await capture('narrow-conversation-dark');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(
      await js("document.querySelector('.feedback-list').checkVisibility({visibilityProperty:true})"),
      false
    );
    await click('Mark unread');
    await wait(
      "document.querySelector('.feedback-list').checkVisibility({visibilityProperty:true}) && document.activeElement?.getAttribute('data-feedback-id')==='t-121'"
    );
    await js('document.querySelector(\'[data-feedback-id="t-121"]\').click()');
    await click('Conversations');
    await wait(
      "document.querySelector('.feedback-list').checkVisibility({visibilityProperty:true}) && document.activeElement?.getAttribute('data-feedback-id')==='t-121'"
    );
    assert.ok(
      await js("document.querySelector('.feedback-list').getBoundingClientRect().height >= 200"),
      'The list keeps several rows visible'
    );
    await capture('narrow-list-dark');
    win.setContentSize(1280, 800);
    await js("document.documentElement.classList.remove('dark');window.failFeedback=false");
    await click('Summary');
    await click('Feedback');
    await wait("document.querySelectorAll('.feedback-row').length>0");
    assert.equal(
      await js("document.querySelector('[data-feedback-id=\"r-120\"]').classList.contains('is-unread')"),
      false,
      'Read status survives tab navigation'
    );
    await js(
      `(async()=>{const m=window.feedbackSubject.members[0],data=window.feedbackData.get(m.url);data.threads[0].comments.push({...data.threads[0].comments[0],id:'new-incoming',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),body:'Thanks. One more question about retries.'});const {receiveDiscussion}=await import('/lib/review-discussion-cache.ts');receiveDiscussion(m.url,structuredClone(data));})()`
    );
    await wait("document.querySelector('[data-feedback-id=\"t-120\"]').classList.contains('is-unread')");
    assert.equal(
      await js("document.querySelector('.feedback-row').getAttribute('data-feedback-id')"),
      't-120',
      'Latest stack-wide activity rises to the top'
    );
    assert.ok(
      await js("document.querySelector('.feedback-row-update').textContent.includes('One more question')"),
      'Latest reply is visible without reopening the thread'
    );
    await js('document.querySelector(\'[data-feedback-id="t-120"]\').focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await wait("document.activeElement?.getAttribute('data-feedback-id')!=='t-120'");
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('#121')).click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 3'");
    assert.equal(await js("document.querySelectorAll('.feedback-row').length"), 3);
    await js('document.querySelector(\'[aria-label="Review requests"]\').click()');
    await wait("document.querySelectorAll('[data-request-review]').length===1");
    assert.equal(
      await js("document.querySelector('[data-request-review]').getAttribute('data-request-review')"),
      '121'
    );
    await capture('filtered-requests-light');
    await js('document.querySelector(\'[aria-label="Close review requests"]\').click()');
    await js('document.querySelector(\'[data-feedback-id="r-121"]\').click()');
    await js(
      "[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('Unresolved')).click()"
    );
    await wait("document.querySelectorAll('.feedback-row').length===1");
    assert.equal(await js("document.querySelector('.feedback-row').getAttribute('data-feedback-id')"), 't-121');
    win.setContentSize(900, 600);
    await new Promise((r) => setTimeout(r, 100));
    await js('document.querySelector(\'[data-feedback-id="t-121"]\').click()');
    await capture('short-laptop-light');
    assert.ok(
      await js("document.querySelector('.feedback-conversation-body').getBoundingClientRect().height>=150"),
      'Short laptop retains readable content'
    );

    // Feedback is the only response workspace, including code context and cross-PR progression.
    win.setContentSize(1280, 800);
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent==='All PRs').click()");
    await js("[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('All ')).click()");
    await js("document.querySelector('[data-feedback-id=\"t-120\"]').click()");
    await wait("!!document.querySelector('.feedback-response-dock button')");
    await capture('feedback-code-light');
    win.setContentSize(900,600);
    await new Promise(r=>setTimeout(r,150));
    assert.ok(await js("document.querySelector('.feedback-conversation-body').getBoundingClientRect().height>=180"), 'Short laptop retains reading space');
    assert.ok(await js("(()=>{const r=document.querySelector('.feedback-response-dock').getBoundingClientRect();return r.top>0&&r.bottom<=innerHeight&&r.height>=40})()"), 'Response controls stay visible');
    assert.ok(await js("(()=>{const t=document.querySelector('.github-thread-comments').getBoundingClientRect(),p=document.querySelector('.feedback-conversation-body').getBoundingClientRect();return t.top<p.bottom&&t.bottom>p.top})()"), 'The conversation leads on a short laptop');
    await capture('feedback-code-short-laptop-light');
    win.setContentSize(1280,800);
    await click('Show full file');
    await wait("!!document.querySelector('.feedback-full-file .commit-stream-file')");
    assert.equal(await js("document.querySelectorAll('.feedback-conversation .github-thread').length"),1,'Full context must not duplicate conversations');
    await capture('feedback-full-file-light');
    await click('Hide full file');
    await click('Reply');
    await js("(()=>{const input=document.querySelector('.feedback-conversation textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this reply while browsing.');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await js("document.querySelector('[data-feedback-id=\"t-121\"]').click()");
    await wait("document.querySelector('.feedback-code-heading')?.textContent.includes('earlier revision')");
    await js("document.querySelector('[data-feedback-id=\"t-120\"]').click()");
    await wait("document.querySelector('.feedback-conversation textarea')?.value==='Keep this reply while browsing.'");
    await js('window.failFeedbackWrite=true');
    await click('Resolve & next');
    await wait("document.querySelector('.github-thread-error')?.textContent.includes('Thread wasn’t resolved')");
    assert.equal(await js("document.querySelector('[data-feedback-id=\"t-120\"]').getAttribute('aria-current')"), 'true', 'Failure must not advance');
    await js('window.failFeedbackWrite=false');
    await click('Open in Changes');
    await wait("!!document.querySelector('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"]')");
    assert.equal(await js("!!document.querySelector('.changes-view-switch')"),false,'Changes has no feedback viewing mode');
    await wait("document.querySelector('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"] textarea')?.value==='Keep this reply while browsing.'");
    await js("[...document.querySelectorAll('.changes-diff-pane .github-thread[data-thread-id=\"t-120\"] button')].find(b=>b.textContent==='Address feedback').click()");
    await wait("document.querySelector('.feedback-conversation .github-thread')?.getAttribute('data-thread-id')==='t-120'");
    assert.equal(await js("document.querySelector('.pr-overview-tabs [data-state=active]').textContent"),'Feedback');
    await wait("document.querySelector('.feedback-conversation textarea')?.value==='Keep this reply while browsing.'");
    await click('Cancel');
    // A thread deep link scopes to its PR. Return to all PRs before processing the stack.
    await js('document.querySelector(\'[aria-label="Filter by PR"]\').click()');
    await wait("!!document.querySelector('[role=option]')");
    await js("[...document.querySelectorAll('[role=option]')].find(o=>o.textContent==='All PRs').click()");
    await js("document.querySelector('[data-feedback-id=\"t-120\"]').click()");
    await click('Resolve & next');
    await wait("document.querySelector('.feedback-conversation .github-thread')?.getAttribute('data-thread-id')==='t-121'");
    assert.equal(await js('window.feedbackWrites.at(-1).prUrl'), await js('window.feedbackSubject.members[0].url'));
    assert.match(await js<string>("document.querySelector('.feedback-resolution').textContent"),/Previous thread resolved.*#120.*src\/worker.ts/);
    await click('Undo');
    await wait("document.querySelector('.feedback-conversation .github-thread')?.getAttribute('data-thread-id')==='t-120'");
    assert.equal(await js('window.feedbackData.get(window.feedbackSubject.members[0].url).threads[0].isResolved'),false);
    await click('Resolve & next');
    await wait("document.querySelector('.feedback-conversation .github-thread')?.getAttribute('data-thread-id')==='t-121'");
    await click('Resolve & next');
    await wait("document.querySelector('.feedback-conversation .github-thread')?.getAttribute('data-thread-id')==='t-122'");
    await js("document.documentElement.classList.add('dark')");
    await capture('feedback-next-pr-dark');
    win.setContentSize(640,800);
    await new Promise(r=>setTimeout(r,150));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    await capture('feedback-code-narrow-dark');
    await click('Conversations');
    await wait("document.querySelector('.feedback-list').checkVisibility({visibilityProperty:true}) && document.activeElement?.getAttribute('data-feedback-id')==='t-122'");
    await js("document.querySelector('[data-feedback-id=\"t-122\"]').click()");
    await click('Resolve & next');
    await wait("!!document.querySelector('.feedback-complete')");
    assert.match(await js<string>("document.querySelector('.feedback-complete').textContent"),/does not approve a PR/);
    assert.ok(await js("document.querySelector('.feedback-complete').checkVisibility()"));
    await capture('feedback-complete-dark');
    await click('Re-request review');
    await wait("!!document.querySelector('.feedback-reviewers')");
    assert.match(await js<string>("document.querySelector('.feedback-reviewers').textContent"), /No unresolved threads/);
    await js("document.querySelector('[aria-label=\"Close review requests\"]').click()");
    win.setContentSize(1280,800);

    await click('Summary');
    await js(`(async()=>{
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>({...value,readiness:{...value.readiness,reviewDecision:'CHANGES_REQUESTED',mergeState:'BLOCKED'}}));
      publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(window.feedbackSubject.members.map(({url,headSha})=>({url,headSha}))));
    })()`);
    await wait("!!document.querySelector('.stack-overview [data-blocker-key=review] button')");
    assert.equal(await js("!!document.querySelector('.stack-overview [data-blocker-key=review] a')"), false, 'Review blockers lead into Gnosis');
    await js("document.querySelector('.stack-overview [data-pr-url$=\"/120\"] [data-blocker-key=review] button').click()");
    await wait("document.querySelector('.feedback-conversation')?.textContent.includes('The new upload path')");
    assert.match(await js<string>("document.querySelector('.feedback-conversation').textContent"), /#120/);
    await capture('address-from-stack-dark');
    // Real-world density: resolved old feedback, deep paths, and a short discussion on a large window.
    await js(`(async()=>{
      const m=window.feedbackSubject.members[0],data=window.feedbackData.get(m.url);
      const thread=data.threads[0];thread.path='project/workers/unity-client/Assets/Klang/Seed/Scripts/Client/UI/EvolveUI/ClientLocalizationCompilation.asset';
      thread.isResolved=true;thread.isOutdated=true;thread.comments[0].body='Unrelated change?';
      thread.comments[1].body='Yes. The latest commit removes the unrelated asset change.';
      const {receiveDiscussion}=await import('/lib/review-discussion-cache.ts');receiveDiscussion(m.url,structuredClone(data));
    })()`);
    await js("document.querySelector('[data-feedback-id=\"t-120\"]').click()");
    win.setContentSize(1920,1100);
    await new Promise(r=>setTimeout(r,150));
    assert.ok(await js("document.querySelector('.feedback-list').getBoundingClientRect().width<=360"),'Wide windows keep the list bounded');
    assert.equal(await js("document.querySelector('.feedback-code-context').open"),false,'Earlier resolved code starts collapsed');
    assert.ok(await js("document.querySelector('.feedback-response-dock').getBoundingClientRect().bottom<innerHeight-200"),'Short conversations keep response controls nearby');
    assert.ok(await js("[...document.querySelectorAll('.feedback-row-state')].every(el=>el.getBoundingClientRect().height<24)"),'Resolution labels stay on one line');
    assert.equal(await js("document.querySelector('[data-feedback-id=\"t-120\"] .feedback-row-file').textContent"),'ClientLocalizationCompilation.asset');
    await capture('refined-long-path-wide-dark');
    win.setContentSize(1280,800);
    await js("document.documentElement.classList.remove('dark')");
    await capture('refined-resolved-light');
    win.setContentSize(900,600);
    await js("document.documentElement.classList.add('dark')");
    await capture('refined-long-path-short-dark');
    assert.ok(await js("document.querySelector('.feedback-response-dock').getBoundingClientRect().bottom<=innerHeight"));
    win.setContentSize(1280,800);
    win.webContents.setZoomFactor(2);
    await new Promise(r=>setTimeout(r,150));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'Feedback remains contained at 200% zoom');
    assert.ok(await js("document.querySelector('.pr-summary-page').scrollHeight>document.querySelector('.pr-summary-page').clientHeight"),'Extreme zoom makes the page scroll instead of clipping its contents');
    await js("document.querySelector('.feedback-response-dock').scrollIntoView({block:'end'})");
    await new Promise(r=>setTimeout(r,100));
    assert.ok(await js("(()=>{const r=document.querySelector('.feedback-response-dock').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"),'Response controls remain reachable at 200% zoom');
    await capture('refined-zoom-dark');
    win.webContents.setZoomFactor(1);
    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log(
      'Feedback passed: stack aggregation, read/unread persistence, code context, resolution/reopen, reply recovery, reviewer requests, cached errors, keyboard and laptop/narrow light/dark layouts.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'), await js('document.body.innerText.slice(-6000)'));
    await capture('failure');
    app.exit(1);
  }
});
