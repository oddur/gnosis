import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();

/**
 * Feedback as one timeline (#418): the description, comments, reviews, code threads, pushes and events of a PR
 * oldest first, full width. Code threads draw their excerpt with Changes' diff (ChangesDiff), the conversation sits
 * under its anchored line, and long lines wrap. Bots collapse, a divider marks what is new, the bar moves to the next
 * unresolved thread, and keys move between items. A PR with hundreds of items stays fast because rows are virtualized.
 * With GNOSIS_FEEDBACK_INLINE_SHOTS set, screenshots print as `FISHOT <name> <base64 PNG>` lines.
 */
const shots = process.env.GNOSIS_FEEDBACK_INLINE_SHOTS;
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: true, webPreferences: { backgroundThrottling: false } });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code: string, tries = 300) => {
    for (let n = 0; n < tries; n++) {
      if (await js(code)) return;
      await sleep(40);
    }
    throw Error(`Timeout: ${code}\n${errors.join('\n')}\n${await js<string>('document.body.innerText.slice(-3000)')}`);
  };
  const click = (label: string, scope = 'document') =>
    js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  const key = async (k: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    win.webContents.sendInputEvent({ type: 'char', keyCode: k });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
    await sleep(120);
  };
  const active = () => js<string | null>("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId ?? document.querySelector('.feedback-entry[aria-current=true]')?.dataset.entryType ?? null");
  const entry = (id: string) => `document.querySelector('.feedback-entry[data-feedback-id="${id}"]')`;
  const inView = (id: string) =>
    js<boolean>(`(()=>{const e=${entry(id)},t=document.querySelector('.feedback-timeline');if(!e)return false;const a=e.getBoundingClientRect(),b=t.getBoundingClientRect();return a.top>=b.top-2&&a.top<b.bottom-40})()`);
  const capture = async (name: string, prepare?: () => Promise<unknown>) => {
    if (!shots) return;
    for (const width of [1280, 1600, 760]) {
      win.setContentSize(width, 800);
      await sleep(250);
      await prepare?.();
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js('document.fonts.ready');
        await sleep(350);
        console.log(`FISHOT ${name}-${width}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      }
    }
    await js("document.documentElement.classList.remove('dark')");
    win.setContentSize(1280, 800);
    await sleep(200);
    await prepare?.();
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    await js(String.raw`(async()=>{
      window.feedbackWrites=[];window.feedbackData=new Map();
      const q=await window.electronAPI.workbenchQueue();const stack=q.items.find(i=>i.subject.kind==='stack');window.feedbackSubject=stack.subject;
      const author=login=>({login,avatarUrl:'',__typename:login.endsWith('[bot]')?'Bot':'User'});
      const at=minutes=>new Date(Date.parse('2026-11-12T09:00:00Z')+minutes*60000).toISOString();
      window.feedbackAt=at;
      const c=(id,login,minutes,body,extra={})=>({id,body,author:author(login),createdAt:at(minutes),updatedAt:at(minutes),url:'https://github.com/klang/engine/pull/120#discussion_'+id,viewerCanUpdate:login==='oddur',viewerCanDelete:login==='oddur',...extra});
      // GitHub's diff hunk runs from its hunk header to the commented line: line 36 of src/worker.ts is the change.
      const toLine36='@@ -33,7 +33,7 @@\n const value32 = 32;\n const value33 = 33;\n const value34 = 34;\n-const value35 = 35;\n+const value35 = 36;';
      const long='@@ -38,2 +38,2 @@\n const value37 = 37;\n const value38 = 38; // '+'a retry generation note that runs far past the edge of any laptop window, '.repeat(6);
      const thread=(id,line,comments,extra={})=>({id,path:'src/worker.ts',line,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments,...extra});
      for(const [index,m] of stack.subject.members.entries()){
        if(index===1){window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[],feedback:{comments:[],reviews:[{...c('r-lee','lee',200,'Read through the queue changes; no blockers from me.'),state:'COMMENTED',submittedAt:at(200)}],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN',earlierEvents:true,
          events:[{kind:'closed',id:'e-close',at:at(210),actor:'lee'},{kind:'reopened',id:'e-reopen',at:at(211),actor:'oddur'},{kind:'merged',id:'e-merge',at:at(4500),actor:'maya'}]}});continue;}
        if(index>0){window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[],feedback:{comments:[],reviews:[],requestedReviewers:[],viewerCanUpdate:true,state:'OPEN',events:[]}});continue;}
        window.feedbackMember=m;
        const threads=[
          // Replies arrive out of order from the cache; the thread reads them oldest first.
          thread('t-main',36,[
            c('m1','maya',0,'This compares the new value with the old constant. **Should retries keep the previous generation?**',{diffHunk:toLine36,pullRequestReview:{id:'r-maya'}}),
            c('m3','maya',50,'Then please add a test for the retry path before merging.',{diffHunk:toLine36}),
            c('m2','oddur',20,'Retries read the generation again, so the old value never wins. I can add a comment.',{diffHunk:toLine36}),
            c('m4','sam',75,'Agreed with Maya. A test would also cover the timeout case.',{diffHunk:toLine36}),
          ]),
          thread('t-second',39,[c('s1','maya',5,'Is value38 still used after this change? The comment on this line is long.',{diffHunk:long,pullRequestReview:{id:'r-maya'}})]),
          thread('t-resolved',34,[c('x1','sam',-120,'Nit: keep the constants sorted.',{diffHunk:'@@ -33,2 +33,2 @@\n const value32 = 32;\n const value33 = 33;'}),c('x2','oddur',-100,'Sorted in the latest commit.',{diffHunk:'@@ -33,2 +33,2 @@\n const value32 = 32;\n const value33 = 33;'})],{isResolved:true,viewerCanResolve:false,viewerCanUnresolve:true,resolvedBy:{login:'oddur'}}),
          thread('t-outdated',null,[c('o1','maya',-300,'This retry flag should not be global.',{diffHunk:'@@ -9,4 +9,5 @@\n const value8 = 8;\n const value9 = 9;\n+let retry = true;'})],{isOutdated:true}),
        ];
        const ci=(id,minutes,body)=>c(id,'github-actions[bot]',minutes,body);
        window.feedbackData.set(m.url,{headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads,feedback:{
          comments:[
            c('pc-human','sam',30,'@oddur the migration is safe to run before this deploy. Can you add the rollback command to the PR description?'),
            c('pc-bot','linear[bot]',-400,'<!-- linear-linkback -->\n<details>\n<summary><a href="https://linear.app/klang/issue/SEED-412">SEED-412 Confirm uploads once</a></summary>\n<p>This PR is linked to <strong>SEED-412</strong>.</p>\n</details>'),
            ci('ci-1',-60,'✅ Static Data Validation Passed'),ci('ci-2',-59,'✅ Update Migration Test Passed'),ci('ci-3',-58,'This PR needs to merge develop before the release branch is cut.'),
          ],
          reviews:[
            {...c('r-maya','maya',6,'The new upload path is easier to follow. One correctness issue remains.\n\n- Keep the generation check before committing.\n- Add a retry test.'),state:'CHANGES_REQUESTED',submittedAt:at(6)},
            {...c('r-sam','sam',-90,''),state:'APPROVED',submittedAt:at(-90)},
          ],
          events:[
            {kind:'commit',id:'k1',at:at(-380),sha:'a1b2c3d4e5f6',message:'Introduce the upload queue',author:'oddur'},
            {kind:'commit',id:'k2',at:at(-379),sha:'b2c3d4e5f6a1',message:'Keep retries ordered',author:'oddur'},
            {kind:'commit',id:'k3',at:at(-378),sha:'c3d4e5f6a1b2',message:'Confirm uploads once',author:'oddur'},
            {kind:'force-push',id:'f1',at:at(-50),actor:'oddur',before:'c3d4e5f6a1b2',after:'d4e5f6a1b2c3'},
            {kind:'review-requested',id:'q1',at:at(-40),actor:'oddur',reviewer:'maya'},
            {kind:'commit',id:'k4',at:at(40),sha:'e5f6a1b2c3d4',message:'Add a retry test',author:'oddur'},
          ],
          requestedReviewers:[],viewerCanUpdate:true,state:'OPEN'}});
      }
      // What the reader saw before: everything older than the first new thread is read.
      const {feedbackItems,feedbackReadKey,feedbackFingerprint}=await import('/lib/feedback.ts');
      const {writeReviewState}=await import('/lib/renderer-review-state.ts');
      for(const item of feedbackItems(window.feedbackMember,window.feedbackData.get(window.feedbackMember.url)))
        if(item.comments[0].createdAt<at(-1))await writeReviewState(feedbackReadKey('oddur',item),feedbackFingerprint(item,'oddur'));
      window.electronAPI.getCachedReviewThreads=async url=>structuredClone(window.feedbackData.get(url));
      window.electronAPI.getReviewThreads=async url=>structuredClone(window.feedbackData.get(url));
      window.electronAPI.reviewThreadAction=async req=>{window.feedbackWrites.push(req);const t=window.feedbackData.get(req.prUrl).threads.find(t=>t.id===req.threadId);if(req.action==='reply')t.comments.push({...t.comments[0],id:'reply-'+Date.now(),body:req.body,author:{login:'oddur',avatarUrl:''},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),viewerCanUpdate:true,viewerCanDelete:true});else {t.isResolved=req.action==='resolve';t.viewerCanResolve=!t.isResolved;t.viewerCanUnresolve=t.isResolved;}return structuredClone(t)};
      window.electronAPI.feedbackAction=async req=>{window.feedbackWrites.push(req)};
    })()`);
    await js("document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.stack-overview')");
    await click('Feedback');
    await wait("!!document.querySelector('.feedback-timeline .feedback-entry')");
    // Hide GitHub Actions stays a toggle; turned off, the three CI comments in a row collapse into one quiet row.
    assert.equal(await js("document.querySelector('.feedback-actions-filter input').checked"), true);
    await js("document.querySelector('.feedback-actions-filter input').click()");
    await wait("document.querySelector('.feedback-filters button').textContent.trim()==='All 12'");

    // The divider marks the first new conversation, and the timeline opens there.
    await wait("!!document.querySelector('.feedback-entry[data-entry-type=divider]')");
    assert.equal(
      await js("[...document.querySelectorAll('.feedback-entry')].find(e=>Number(e.dataset.index)===Number(document.querySelector('.feedback-entry[data-entry-type=divider]').dataset.index)+1)?.dataset.feedbackId"),
      't-main',
      'New since you last looked sits right before the first new conversation'
    );
    await capture('new-since');

    // Collect the whole timeline by scrolling: one order across every kind of item.
    const collected = await js<{ index: number; type: string; id?: string; at: string; text: string; node?: string; label?: string; role?: string }[]>(`(async()=>{
      const t=document.querySelector('.feedback-timeline');const seen=new Map();t.scrollTop=0;window.__railGaps=[];window.__nodeClones={};
      for(let i=0;i<80;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const mounted=[...document.querySelectorAll('.feedback-entry')].sort((a,b)=>a.dataset.index-b.dataset.index);
        for(const e of mounted){const n=e.querySelector(':scope > .timeline-indicator');
          if(n&&!window.__nodeClones[n.dataset.nodeKind])window.__nodeClones[n.dataset.nodeKind]=n.cloneNode(true);
          seen.set(Number(e.dataset.index),{index:Number(e.dataset.index),type:e.dataset.entryType,id:e.dataset.feedbackId,at:e.dataset.at,text:e.textContent.slice(0,300),node:n?.dataset.nodeKind,label:n?.getAttribute('aria-label'),role:n?.getAttribute('role')});}
        // Each row's line segment ends where the next row's begins.
        for(let k=0;k+1<mounted.length;k++){const a=mounted[k],b=mounted[k+1];if(Number(b.dataset.index)!==Number(a.dataset.index)+1)continue;
          const sa=a.querySelector(':scope > .timeline-separator').getBoundingClientRect(),sb=b.querySelector(':scope > .timeline-separator').getBoundingClientRect();
          window.__railGaps.push(Math.abs(sb.top-sa.bottom)+Math.abs(sb.left-sa.left));}
        if(t.scrollTop+t.clientHeight>=t.scrollHeight-2)break;t.scrollTop+=t.clientHeight*0.8;}
      return [...seen.values()].sort((a,b)=>a.index-b.index)})()`);
    // Every row has a rail node that names its kind in words, not colour alone.
    for (const row of collected) assert.ok(row.node && row.label && row.role === 'img', `Row ${row.index} (${row.type}) has a labelled node: ${JSON.stringify(row)}`);
    const nodeOf = (id: string) => collected.find((row) => row.id === id)?.node;
    assert.deepEqual(
      ['t-main', 't-second', 't-resolved', 't-outdated', 'r-maya', 'r-sam', 'r-lee', 'pc-human', 'pc-bot'].map(nodeOf),
      ['thread-unresolved', 'thread-unresolved', 'thread-resolved', 'thread-outdated', 'changes-requested', 'approved', 'reviewed', 'comment', 'bot'],
      'Each kind of item has its own node'
    );
    for (const kind of ['description', 'commits', 'force-push', 'review-requested', 'closed', 'reopened', 'merged', 'bot', 'new', 'day', 'earlier'])
      assert.ok(collected.some((row) => row.node === kind), `A ${kind} node is on the rail: ${collected.map((r) => r.node).join(',')}`);
    const railGaps = await js<number[]>('window.__railGaps');
    assert.ok(railGaps.length > 10 && Math.max(...railGaps) <= 1, `The rail is continuous across virtualized rows: ${JSON.stringify(railGaps)}`);
    assert.ok(collected.some((row) => row.type === 'day' && /\d+ days later/.test(row.text)), 'A long pause says how long');
    const kinds = collected.map((row) => row.type);
    for (const kind of ['description', 'item', 'commits', 'event', 'bots', 'divider', 'day'])
      assert.ok(kinds.includes(kind), `The timeline shows ${kind}: ${kinds.join(',')}`);
    const times = collected.filter((row) => row.type !== 'divider').map((row) => row.at);
    assert.deepEqual([...times].sort(), times, 'Every kind of item reads oldest first');
    assert.equal(collected.length, Math.max(...collected.map((r) => r.index)) + 1, 'Every row was seen');
    const order = collected.map((row) => row.id ?? row.type);
    assert.ok(order.indexOf('commits') < order.indexOf('t-outdated') && order.lastIndexOf('commits') > order.indexOf('t-main'), `Pushes interleave with the conversation: ${order.join(',')}`);
    const pushed = collected.find((row) => row.type === 'commits');
    assert.match(pushed?.text ?? '', /pushed 3 commits/, 'Consecutive commits read as one push');
    const bots = collected.filter((row) => row.type === 'bots');
    assert.equal(bots.length, 1, 'Consecutive CI comments are one row');
    assert.match(bots[0].text, /github-actions.*3 comments.*Static Data Validation Passed, .*Update Migration Test Passed/);
    assert.ok(collected.some((row) => row.type === 'event' && /force-pushed/.test(row.text)));
    assert.ok(collected.some((row) => row.type === 'event' && /requested a review from maya/.test(row.text)));
    assert.ok(collected.some((row) => row.id === 'pc-bot' && /SEED-412 Confirm uploads once/.test(row.text) && !row.text.includes('<!--')));

    // The node set, close up: every kind cloned from the rail into one legend.
    if (shots) {
      await js(`(()=>{const p=document.createElement('div');p.id='node-legend';p.className='timeline';
        p.style.cssText='position:fixed;top:90px;left:90px;z-index:9999;display:grid;grid-template-columns:repeat(4,auto auto);gap:14px 10px;align-items:center;padding:20px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:10px;font:13px var(--font-sans)';
        for(const [kind,node] of Object.entries(window.__nodeClones)){const n=node.cloneNode(true);n.style.cssText='position:relative;left:0;top:0';const l=document.createElement('span');l.textContent=n.getAttribute('aria-label')+' ('+kind+')';p.append(n,l)}
        document.body.append(p)})()`);
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await sleep(300);
        const r = await js<{ x: number; y: number; width: number; height: number }>("(()=>{const b=document.getElementById('node-legend').getBoundingClientRect();return {x:Math.floor(b.left)-8,y:Math.floor(b.top)-8,width:Math.ceil(b.width)+16,height:Math.ceil(b.height)+16}})()");
        console.log(`FISHOT nodes-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
      }
      await js("document.documentElement.classList.remove('dark');document.getElementById('node-legend').remove()");
    }
    await capture('long-gap', () => js(`(async()=>{const t=document.querySelector('.feedback-timeline');t.scrollTop=0;for(let i=0;i<80;i++){const d=[...document.querySelectorAll('.feedback-entry[data-entry-type=day]')].find(e=>/days later/.test(e.textContent));if(d){d.scrollIntoView({block:'center'});return}t.scrollTop+=400;await new Promise(r=>requestAnimationFrame(r))}})()`));
    await capture('pushes', () => js(`(async()=>{const t=document.querySelector('.feedback-timeline');t.scrollTop=0;for(let i=0;i<80;i++){const d=document.querySelector('.feedback-entry[data-entry-type=commits]');if(d){d.scrollIntoView({block:'center'});return}t.scrollTop+=400;await new Promise(r=>requestAnimationFrame(r))}})()`));

    // Bots: collapsed, then expanded in place.
    const botsKey = await js<string>(`(async()=>{const t=document.querySelector('.feedback-timeline');t.scrollTop=0;for(let i=0;i<80;i++){const b=document.querySelector('.feedback-entry[data-entry-type=bots]');if(b){b.scrollIntoView({block:'start'});return b.dataset.entryKey}t.scrollTop+=400;await new Promise(r=>requestAnimationFrame(r))}})()`);
    await sleep(200);
    await capture('bots-collapsed', () => js(`document.querySelector('[data-entry-key="${botsKey}"]')?.scrollIntoView({block:'start'})`));
    await js(`document.querySelector('[data-entry-key="${botsKey}"] .feedback-bots-summary').click()`);
    await wait(`document.querySelectorAll('[data-entry-key="${botsKey}"] .feedback-message').length===3`);
    await capture('bots-expanded', () => js(`document.querySelector('[data-entry-key="${botsKey}"]')?.scrollIntoView({block:'start'})`));

    // A resolved thread is one line, and opens in place.
    await js(`(async()=>{const t=document.querySelector('.feedback-timeline');t.scrollTop=0;for(let i=0;i<80;i++){const e=${entry('t-resolved')};if(e){e.scrollIntoView({block:'start'});return}t.scrollTop+=400;await new Promise(r=>requestAnimationFrame(r))}})()`);
    await wait(`!!${entry('t-resolved')}?.querySelector('.feedback-resolved-summary')`);
    assert.match(await js<string>(`${entry('t-resolved')}.textContent`), /sam commented on worker\.ts:34.*Resolved.*2 comments/);
    await capture('resolved-collapsed', () => js(`${entry('t-resolved')}?.scrollIntoView({block:'start'})`));
    await js(`${entry('t-resolved')}.querySelector('.feedback-resolved-summary').click()`);
    await wait(`!!${entry('t-resolved')}?.querySelector('.changes-diff .github-thread[data-resolved=true]')`);

    // Next unresolved goes to the first unresolved thread after the cursor, and n to the one after it.
    await js(`${entry('t-resolved')}?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await click('Next unresolved');
    await wait(`document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-main'`);
    await wait(`(()=>{const e=${entry('t-main')};return !!e&&Math.abs(e.getBoundingClientRect().top-document.querySelector('.feedback-timeline').getBoundingClientRect().top)<40})()`);
    await key('n');
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-second'");
    assert.ok(await inView('t-second'), 'n scrolls the next unresolved thread into view');
    await key('k');
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-main'");
    assert.ok(await inView('t-main'), 'k moves back to the previous item');

    // The code thread: in the shared diff, under its line, oldest first, full width and never scrolling sideways.
    await wait(`!!${entry('t-main')}?.querySelector('.changes-diff [data-thread-id="t-main"]')`);
    assert.ok(await js(`!!${entry('t-main')}.querySelector('[data-code-theme] > .changes-file-header')`), 'The code-tier header leads the code');
    assert.equal(await js(`${entry('t-main')}.querySelectorAll('.changes-file-header').length`), 1, 'One header for the file, with its actions');
    assert.ok(await js(`[...${entry('t-main')}.querySelectorAll('.changes-file-header button')].some(b=>b.textContent==='Show full file')`));
    assert.equal(
      await js(`${entry('t-main')}.querySelector('.changes-diff [data-thread-id="t-main"]').closest('[slot^="annotation-"]').getAttribute('slot')`),
      'annotation-additions-36',
      'The thread sits under line 36, its anchored line'
    );
    assert.ok(!(await js<string>(`${entry('t-main')}.textContent`)).includes('not in this topic'), 'Feedback names gaps by their hidden lines');
    const replies = await js<string[]>(`[...${entry('t-main')}.querySelectorAll('.github-thread-comments > article time')].map(t=>t.getAttribute('datetime'))`);
    assert.equal(replies.length, 4);
    assert.deepEqual([...replies].sort(), replies, 'Replies read oldest first');
    assert.equal(await js(`!!${entry('t-main')}.querySelector('textarea')`), false, 'The composer stays closed until Reply');
    await capture('code-thread', () => js(`${entry('t-main')}?.scrollIntoView({block:'start'})`));
    for (const width of [1280, 1600, 1920]) {
      win.setContentSize(width, 900);
      await sleep(300);
      const size = await js<{ timeline: number; card: number; workspace: number }>(
        `(()=>{const w=document.querySelector('.feedback-workspace').getBoundingClientRect().width,t=document.querySelector('.feedback-timeline').clientWidth,c=${entry('t-main')}.querySelector('.review-file-group').getBoundingClientRect().width;return {timeline:t,card:c,workspace:w}})()`
      );
      assert.ok(size.timeline >= size.workspace - 20 && size.card >= size.timeline - 100, `Full width at ${width}px: ${JSON.stringify(size)}`);
    }
    win.setContentSize(1280, 800);
    await sleep(300);
    await js(`${entry('t-second')}?.scrollIntoView({block:'start'})`);
    await wait(`!!${entry('t-second')}?.closest('.feedback-timeline') && !!${entry('t-second')}.querySelector('.changes-diff diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
    const overflow = await js<{ host: number; thread: number; timeline: boolean }>(`(()=>{const e=${entry('t-second')};const h=e.querySelector('.changes-diff diffs-container');const pre=h.shadowRoot.querySelector('pre');const th=e.querySelector('.github-thread');
      const t=document.querySelector('.feedback-timeline');return {host:(pre?.scrollWidth??0)-(pre?.clientWidth??0),thread:th.scrollWidth-th.clientWidth,timeline:t.scrollWidth>t.clientWidth+1}})()`);
    assert.ok(overflow.host <= 1 && overflow.thread <= 1 && !overflow.timeline, `No sideways scroll inside a thread at 1280px: ${JSON.stringify(overflow)}`);

    // Keyboard: j/k move between items, r replies to the active thread, e resolves it.
    await js(`${entry('t-main')}.focus()`);
    await js(`${entry('t-main')}.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    const before = await js<number>("Number(document.querySelector('.feedback-entry[aria-current=true]').dataset.index)");
    await key('j');
    await wait(`Number(document.querySelector('.feedback-entry[aria-current=true]')?.dataset.index)>${before}`);
    await key('k');
    await wait("document.querySelector('.feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-main'");
    assert.match(await js<string>("document.querySelector('.feedback-position').textContent"), /^\d+ of \d+$/);
    await key('r');
    await wait(`!!${entry('t-main')}.querySelector('.changes-diff .github-thread textarea')`);
    await capture('focused', () => js(`${entry('t-main')}?.scrollIntoView({block:'start'})`));
    await capture('reply-open', () => js(`${entry('t-main')}.querySelector('textarea')?.scrollIntoView({block:'center'})`));
    await click('Cancel', entry('t-main'));
    await js(`${entry('t-main')}.focus()`);
    await key('e');
    await wait("window.feedbackWrites.some(w=>w.action==='resolve'&&w.threadId==='t-main')");
    await wait("!!document.querySelector('.feedback-resolution')");
    await click('Undo');
    await wait("window.feedbackWrites.some(w=>w.action==='unresolve'&&w.threadId==='t-main')");

    // The review keeps its verdict, and the bar stays put while the timeline scrolls.
    await js("document.querySelector('.feedback-timeline').scrollTop=0");
    await capture('timeline', () => js("document.querySelector('.feedback-timeline').scrollTop=0"));
    await js("document.querySelector('.feedback-timeline').scrollTop=600");
    await sleep(150);
    assert.ok(await js("document.querySelector('.feedback-toolbar').getBoundingClientRect().top>=0"));
    await capture('sticky-bar', () => js("document.querySelector('.feedback-timeline').scrollTop=600"));
    await js(`(async()=>{const t=document.querySelector('.feedback-timeline');t.scrollTop=0;for(let i=0;i<80;i++){const e=${entry('r-maya')};if(e){e.scrollIntoView({block:'start'});return}t.scrollTop+=400;await new Promise(r=>requestAnimationFrame(r))}})()`);
    await wait(`/Changes requested/.test(${entry('r-maya')}?.textContent ?? '')`);
    await capture('review', () => js(`${entry('r-maya')}?.scrollIntoView({block:'start'})`));
    // Filters hide the rest: Mentions shows the PR comment that names the reader.
    await js("[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('Mentions')).click()");
    await wait("!!document.querySelector('.feedback-entry[data-feedback-id=\"pc-human\"]') && [...document.querySelectorAll('.feedback-entry')].every(e=>e.dataset.feedbackId==='pc-human'||e.dataset.entryType==='divider'||e.dataset.entryType==='day'||e.getAttribute('aria-current')==='true')").catch(async (e) => { throw Error(String(e).slice(0,200) + JSON.stringify(await js("[document.querySelector('.feedback-filters').textContent,...[...document.querySelectorAll('.feedback-entry')].map(e=>[e.dataset.entryType,e.dataset.feedbackId,e.getAttribute('aria-current')])]"))); });
    await js("[...document.querySelectorAll('.feedback-filters button')].find(b=>b.textContent.startsWith('All')).click()");

    // A PR with hundreds of items: only what is near the view mounts, and moving stays quick.
    const large = await js<{ items: number; mounted: number; render: number; jump: number }>(String.raw`(async()=>{
      const m=window.feedbackMember,data=structuredClone(window.feedbackData.get(m.url)),at=window.feedbackAt;
      for(let i=0;i<150;i++)data.threads.push({...data.threads[0],id:'big-t'+i,line:36,comments:data.threads[0].comments.map((x,j)=>({...x,id:'big-t'+i+'-'+j,createdAt:at(100+i*3+j),updatedAt:at(100+i*3+j)}))});
      for(let i=0;i<200;i++)data.feedback.comments.push({...data.feedback.comments[0],id:'big-c'+i,body:'Comment '+i+' about the queue.',createdAt:at(100+i*2),updatedAt:at(100+i*2)});
      for(let i=0;i<150;i++)data.feedback.events.push({kind:'commit',id:'big-k'+i,at:at(101+i*3),sha:'f'.repeat(39)+(i%10),message:'Commit '+i,author:i%2?'oddur':'maya'});
      const {receiveDiscussion}=await import('/lib/review-discussion-cache.ts');
      const start=performance.now();receiveDiscussion(m.url,data);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const render=performance.now()-start;
      const t=document.querySelector('.feedback-timeline');const j0=performance.now();t.scrollTop=t.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const jump=performance.now()-j0;
      return {items:data.threads.length+data.feedback.comments.length+data.feedback.events.length,mounted:document.querySelectorAll('.feedback-entry').length,render,jump}})()`);
    console.log(`Large PR: ${JSON.stringify(large)}`);
    assert.ok(large.items > 500 && large.mounted < 40, `Only rows near the view mount: ${JSON.stringify(large)}`);
    assert.ok(large.render < 1500 && large.jump < 1000, `A large timeline stays fast: ${JSON.stringify(large)}`);

    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log('Feedback timeline passed: chronological order across item kinds, grouped pushes and bots, new-since divider, next unresolved, keyboard, full width, wrapped code, and a large PR.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'));
    app.exit(1);
  }
});
