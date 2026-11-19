import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();

/**
 * Feedback reads code feedback inside the shared diff (#feedback-inline): each code thread sits under the line it is
 * anchored to, in the same ChangesDiff Changes uses, and its comments read oldest first. PR comments, review summaries,
 * bot HTML and outdated threads each have a place. With GNOSIS_FEEDBACK_INLINE_SHOTS set, screenshots print as
 * `FISHOT <name> <base64 PNG>` lines, since Docker keeps no files; `before` skips the checks of the new layout.
 */
const shots = process.env.GNOSIS_FEEDBACK_INLINE_SHOTS;
const before = shots === 'before';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: true, webPreferences: { backgroundThrottling: false } });
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
    throw Error(`Timeout: ${code}\n${errors.join('\n')}\n${await js<string>('document.body.innerText.slice(-4000)')}`);
  };
  const click = (label: string, scope = 'document') =>
    js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  const open = (id: string) => js(`document.querySelector('[data-feedback-id="${id}"]').click()`);
  const capture = async (name: string) => {
    if (!shots) return;
    for (const width of [1280, 760]) {
      win.setContentSize(width, 800);
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js('document.fonts.ready');
        await sleep(350);
        console.log(`FISHOT ${shots}-${name}-${width}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      }
    }
    await js("document.documentElement.classList.remove('dark')");
    win.setContentSize(1280, 800);
    await sleep(150);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(String.raw`(async()=>{
      window.feedbackWrites=[];window.feedbackData=new Map();
      const q=await window.electronAPI.workbenchQueue();const stack=q.items.find(i=>i.subject.kind==='stack');window.feedbackSubject=stack.subject;
      const author=login=>({login,avatarUrl:'',__typename:login.endsWith('[bot]')?'Bot':'User'});
      const at=minutes=>new Date(Date.parse('2026-11-12T09:00:00Z')+minutes*60000).toISOString();
      const c=(id,login,minutes,body,extra={})=>({id,body,author:author(login),createdAt:at(minutes),updatedAt:at(minutes),url:'https://github.com/klang/engine/pull/120#discussion_'+id,viewerCanUpdate:login==='oddur',viewerCanDelete:login==='oddur',...extra});
      // GitHub's diff hunk runs from its hunk header to the commented line: line 36 of src/worker.ts is the change.
      const toLine36='@@ -33,7 +33,7 @@\n const value32 = 32;\n const value33 = 33;\n const value34 = 34;\n-const value35 = 35;\n+const value35 = 36;';
      const toLine39=toLine36+'\n const value36 = 36;\n const value37 = 37;\n const value38 = 38;';
      const thread=(id,line,comments,extra={})=>({id,path:'src/worker.ts',line,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments,...extra});
      const review={id:'r-maya',state:'CHANGES_REQUESTED'};
      for(const [index,m] of stack.subject.members.entries()){
        if(index>0){window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}});continue;}
        const threads=[
          // Replies arrive out of order from the cache; Feedback reads them oldest first.
          thread('t-main',36,[
            c('m1','maya',0,'This compares the new value with the old constant. **Should retries keep the previous generation?**',{diffHunk:toLine36,pullRequestReview:{id:'r-maya'}}),
            c('m3','maya',50,'Then please add a test for the retry path before merging.',{diffHunk:toLine36}),
            c('m2','oddur',20,'Retries read the generation again, so the old value never wins. I can add a comment.',{diffHunk:toLine36}),
            c('m4','sam',75,'Agreed with Maya. A test would also cover the timeout case.',{diffHunk:toLine36}),
          ]),
          thread('t-second',39,[c('s1','maya',5,'Is \`value38\` still used after this change?',{diffHunk:toLine39,pullRequestReview:{id:'r-maya'}})]),
          thread('t-resolved',34,[c('x1','sam',-120,'Nit: keep the constants sorted.',{diffHunk:'@@ -33,2 +33,2 @@\n const value32 = 32;\n const value33 = 33;'}),c('x2','oddur',-100,'Sorted in the latest commit.',{diffHunk:'@@ -33,2 +33,2 @@\n const value32 = 32;\n const value33 = 33;'})],{isResolved:true,viewerCanResolve:false,viewerCanUnresolve:true}),
          thread('t-outdated',null,[c('o1','maya',-300,'This retry flag should not be global.',{diffHunk:'@@ -9,4 +9,5 @@\n const value8 = 8;\n const value9 = 9;\n+let retry = true;'})],{isOutdated:true}),
        ];
        window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads,feedback:{
          comments:[
            c('pc-human','sam',30,'@oddur the migration is safe to run before this deploy. Can you add the rollback command to the PR description?\n\n\`\`\`sh\nnpm run migrate:down\n\`\`\`'),
            c('pc-bot','linear[bot]',-400,'<!-- linear-linkback -->\n<details>\n<summary><a href="https://linear.app/klang/issue/SEED-412">SEED-412 Confirm uploads once</a></summary>\n<p>This PR is linked to <strong>SEED-412</strong>. Status: In review.</p>\n</details>'),
          ],
          reviews:[
            {...c('r-maya','maya',6,'The new upload path is easier to follow. One correctness issue remains.\n\n- Keep the generation check before committing.\n- Add a retry test.'),...review,submittedAt:at(6)},
            {...c('r-sam','sam',-90,''),state:'APPROVED',submittedAt:at(-90)},
          ],
          requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}});
      }
      window.electronAPI.getCachedReviewThreads=async url=>structuredClone(window.feedbackData.get(url));
      window.electronAPI.getReviewThreads=async url=>structuredClone(window.feedbackData.get(url));
      window.electronAPI.reviewThreadAction=async req=>{window.feedbackWrites.push(req);const t=window.feedbackData.get(req.prUrl).threads.find(t=>t.id===req.threadId);if(req.action==='reply')t.comments.push({...t.comments[0],id:'reply-'+Date.now(),body:req.body,author:{login:'oddur',avatarUrl:''},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),viewerCanUpdate:true,viewerCanDelete:true});else {t.isResolved=req.action==='resolve';t.viewerCanResolve=!t.isResolved;t.viewerCanUnresolve=t.isResolved;}return structuredClone(t)};
      window.electronAPI.feedbackAction=async req=>{window.feedbackWrites.push(req)};
    })()`);
    await js("document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.stack-overview')");
    await click('Feedback');
    await wait("document.querySelectorAll('.feedback-row').length>=7");
    // Bot HTML reads as rendered text in the list, never as raw tags.
    const botRow = await js<string>('document.querySelector(\'[data-feedback-id="pc-bot"]\')?.textContent ?? ""');
    if (!before) {
      assert.ok(!/<!--|<details|<summary/.test(botRow), `Bot rows show rendered text: ${botRow}`);
      assert.match(botRow, /SEED-412 Confirm uploads once/);
    }
    await js("[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('Unread')).click()");
    await sleep(200);
    await capture('filters-unread');
    await js("[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('All')).click()");

    // A code thread: the conversation sits in the shared diff, under the line it is anchored to.
    await open('t-main');
    await wait("!!document.querySelector('.feedback-conversation .github-thread[data-thread-id=\"t-main\"]')");
    if (!before) {
      await wait("!!document.querySelector('.feedback-conversation .changes-diff .github-thread[data-thread-id=\"t-main\"]')");
      assert.ok(
        await js("!!document.querySelector('.feedback-conversation [data-code-theme] > .changes-file-header')"),
        'The code-tier file header leads the code'
      );
      assert.ok(await js("!!document.querySelector('.feedback-conversation .changes-diff .diff-gap')"), 'Hunk headers and gap bars come from ChangesDiff');
      // Pierre slots each annotation under its line by name: annotation-<side>-<line> (getLineAnnotationName).
      const anchor = await js<string | null>(
        "document.querySelector('.feedback-conversation .changes-diff [data-thread-id=\"t-main\"]')?.closest('[slot^=\"annotation-\"]')?.getAttribute('slot') ?? null"
      );
      assert.equal(anchor, 'annotation-additions-36', 'The thread sits under line 36, its anchored line');
      // On screen, the thread starts below line 36 and ends above line 37, once Pierre has drawn the lines.
      await wait(
        "!!document.querySelector('.feedback-conversation .changes-diff [data-thread-id=\"t-main\"]')?.closest('diffs-container')?.shadowRoot?.querySelector('[data-line=\"36\"]')"
      );
      const placement = await js<{ line36?: number; line37?: number | null; top?: number; bottom?: number } | null>(`(()=>{
        const el=document.querySelector('.feedback-conversation .changes-diff [data-thread-id="t-main"]');const root=el.closest('diffs-container')?.shadowRoot;
        if(!root)return {host:el.closest('diffs-container')?.tagName??'none'};
        const at=n=>[...root.querySelectorAll('[data-line="'+n+'"]')].map(e=>e.getBoundingClientRect()).find(r=>r.height>0);
        const t=el.getBoundingClientRect();if(!at(36))return {lines:[...root.querySelectorAll('[data-line]')].map(e=>e.getAttribute('data-line')).join(',')};
        const a=at(36),b=at(37);return a?{line36:a.bottom,line37:b?b.top:null,top:t.top,bottom:t.bottom}:null})()`);
      assert.ok(
        placement?.line36 !== undefined && (placement.top ?? 0) >= placement.line36 - 1 && (placement.line37 == null || placement.line37 >= (placement.bottom ?? 0) - 1),
        `Rendered between line 36 and line 37: ${JSON.stringify(placement)}`
      );
      const order = await js<string[]>("[...document.querySelectorAll('.feedback-conversation .github-thread[data-thread-id=\"t-main\"] .github-thread-comments > article time')].map(t=>t.getAttribute('datetime'))");
      assert.equal(order.length, 4);
      assert.deepEqual([...order].sort(), order, 'Replies read oldest first');
      assert.equal(await js("!!document.querySelector('.feedback-conversation textarea')"), false, 'The composer stays closed until Reply');
      assert.ok(await js("!!document.querySelector('.feedback-sibling-threads [data-sibling-thread=\"t-second\"]')"), 'Other threads on the file are one step away');
    }
    await capture('code-thread');

    await click('Reply', "document.querySelector('.feedback-response-dock')");
    await wait("!!document.querySelector('.feedback-conversation textarea')");
    if (!before)
      assert.ok(await js("!!document.querySelector('.feedback-conversation .changes-diff .github-thread textarea')"), 'The composer opens inside the inline thread');
    await capture('reply-open');
    await click('Cancel', "document.querySelector('.feedback-response-dock')");

    // An outdated thread keeps its original code, labelled as an earlier revision.
    await open('t-outdated');
    await wait("!!document.querySelector('.feedback-conversation .github-thread[data-thread-id=\"t-outdated\"]')");
    if (!before) {
      await wait("!!document.querySelector('.feedback-conversation .changes-diff .github-thread[data-thread-id=\"t-outdated\"]')");
      assert.match(await js<string>("document.querySelector('.feedback-conversation .changes-file-header').textContent"), /Earlier revision/);
    }
    await capture('outdated');

    // The PR-level timeline: a review summary with its verdict, PR comments and bot HTML, rendered.
    await open('r-maya');
    await wait("document.querySelector('.feedback-conversation')?.textContent.includes('The new upload path')");
    if (!before) assert.match(await js<string>("document.querySelector('.feedback-message').textContent"), /Changes requested/);
    await capture('review-summary');
    await open('pc-bot');
    await wait("!!document.querySelector('.feedback-message')");
    if (!before) {
      assert.ok(await js("!!document.querySelector('.feedback-message .github-comment-body details > summary a')"), 'Bot HTML renders as a disclosure');
      assert.ok(!(await js<string>("document.querySelector('.feedback-message').textContent")).includes('<!--'));
    }
    await capture('bot-comment');
    await open('pc-human');
    await wait("document.querySelector('.feedback-message')?.textContent.includes('rollback')");
    await capture('pr-comment');

    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log('Feedback inline passed: code threads in the shared diff under their line, chronological replies, outdated code, PR comments, review verdicts and bot HTML.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'));
    app.exit(1);
  }
});
