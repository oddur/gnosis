import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();

/**
 * The Conversation page (#418): Summary and Feedback as one page. A band with merge readiness above the timeline and a
 * pinned details column; the description leads the timeline; at 1280×800 the first feedback starts above the fold;
 * below 1100px the details become a strip. With GNOSIS_FEEDBACK_INLINE_SHOTS set, screenshots print as
 * `FISHOT <name> <base64 PNG>` lines.
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
  const wait = async (code: string) => {
    for (let n = 0; n < 300; n++) {
      if (await js(code)) return;
      await sleep(40);
    }
    throw Error(`Timeout: ${code}\n${errors.join('\n')}\n${await js<string>('document.body.innerText.slice(-3000)')}`);
  };
  const click = (label: string) =>
    js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`);
  const capture = async (name: string, sizes: [number, number][], prepare?: () => Promise<unknown>) => {
    if (!shots) return;
    for (const [width, height] of sizes) {
      win.setContentSize(width, height);
      await sleep(300);
      await prepare?.();
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        await js('document.fonts.ready');
        await sleep(350);
        console.log(`FISHOT ${name}-${width}x${height}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      }
    }
    await js("document.documentElement.classList.remove('dark')");
    win.setContentSize(1280, 800);
    await sleep(250);
  };
  const all: [number, number][] = [[1280, 800], [1600, 900], [760, 800]];
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    await waitForWorkbenchQueue(win.webContents);
    // A single PR with a short conversation: a review, a code thread and a PR comment.
    await js(String.raw`(async()=>{
      const q=await window.electronAPI.workbenchQueue();
      const single=q.items.find(i=>i.subject.kind==='pr'&&i.subject.title.includes('Fix reconnect'));const m=single.subject.members[0];window.singleUrl=m.url;
      const at=minutes=>new Date(Date.parse('2026-11-12T09:00:00Z')+minutes*60000).toISOString();
      const c=(id,login,minutes,body,extra={})=>({id,body,author:{login,avatarUrl:''},createdAt:at(minutes),updatedAt:at(minutes),url:m.url+'#'+id,...extra});
      const data={headSha:m.headSha,baseSha:m.baseSha,checkedAt:Date.now(),threads:[{id:'t-1',path:'src/transport.ts',line:12,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,
        comments:[c('tc1','maya',10,'Shutdown can race the reconnect timer. Can the timer check the closed flag first?',{diffHunk:'@@ -10,2 +10,3 @@\n const timer = setTimeout(reconnect, delay);\n const closed = false;\n+if (closed) return;'})]}],
        feedback:{comments:[c('pc1','sam',30,'Can you add the shutdown order to the description?')],reviews:[{...c('r1','maya',12,'One race remains in shutdown.'),state:'CHANGES_REQUESTED',submittedAt:at(12)}],requestedReviewers:['sam'],viewerCanUpdate:true,state:'OPEN',
        events:[{kind:'commit',id:'k1',at:at(-30),sha:'a1b2c3d4e5f6',message:'Guard the reconnect timer',author:'oddur'}]}};
      window.electronAPI.getCachedReviewThreads=async url=>url===m.url?structuredClone(data):undefined;
      const read=window.electronAPI.getReviewThreads;
      window.electronAPI.getReviewThreads=async (url,...rest)=>url===m.url?structuredClone(data):read(url,...rest);
    })()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.feedback-entry[data-feedback-id=\"t-1\"]') || !!document.querySelector('.feedback-entry[data-entry-type=description]')");
    await wait("[...document.querySelectorAll('.pr-overview-tabs [role=tab] .pr-tab-label')].map(t=>t.dataset.label).join()==='Conversation,Changes,Commits,Checks,Explanation,Local notes'");
    await wait("!!document.querySelector('.conversation-sidebar') && !!document.querySelector('.feedback-entry[data-feedback-id]')");
    // The description leads, and the first feedback starts above the fold of a 1280×800 laptop.
    const first = await js<{ type: string; feedbackTop: number; height: number; parts: unknown }>(`(()=>{const rows=[...document.querySelectorAll('.feedback-entry')].sort((a,b)=>a.dataset.index-b.dataset.index).filter(e=>e.dataset.entryType!=='day');
      const f=rows.find(e=>e.dataset.feedbackId);const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.top),Math.round(b.height)]};
      return {type:rows[0].dataset.entryType,feedbackTop:f.getBoundingClientRect().top,height:innerHeight,parts:{content:r('.pr-summary-content'),band:r('.conversation-band'),bar:r('.feedback-toolbar'),rows:rows.slice(0,4).map(e=>[e.dataset.entryType,Math.round(e.getBoundingClientRect().top),Math.round(e.getBoundingClientRect().height)])}}})()`);
    if (shots) {
      console.log(`FISHOT fold-check ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      await sleep(1000);
    }
    assert.equal(first.type, 'description', 'The timeline opens with the PR-opened event');
    // The description is its own section above the timeline's bar; the opened event is one line with no body (#418).
    const description = await js<{ section: boolean; above: boolean; inTimeline: boolean; body: boolean; text: string }>(`(()=>{const d=document.querySelector('.conversation-description .pr-description'),bar=document.querySelector('.feedback-toolbar');
      const opened=[...document.querySelectorAll('.feedback-entry[data-entry-type=description]')][0];
      return {section:!!d,above:!!d&&document.querySelector('.conversation-description').getBoundingClientRect().bottom<=bar.getBoundingClientRect().top+1,inTimeline:!!document.querySelector('.feedback-timeline .pr-description'),body:!!opened?.querySelector('.timeline-content'),text:opened?.querySelector('.timeline-title')?.textContent??''}})()`);
    assert.ok(description.section && description.above && !description.inTimeline, `The description is a section above the bar: ${JSON.stringify(description)}`);
    assert.ok(!description.body && /opened this PR/.test(description.text), `The opened event is one line: ${JSON.stringify(description)}`);
    assert.ok(first.feedbackTop < first.height - 40, `The first feedback starts above the fold at 1280×800: ${JSON.stringify(first)}`);
    assert.match(await js<string>("document.querySelector('.conversation-sidebar').textContent"), /Reviewers.*maya.*Changes requested.*sam.*Review requested/s);
    await capture('single-pr', all);
    // Scrolled mid-timeline: the bar and the details column stay pinned.
    await js("document.querySelector('[data-feedback-scroller]').scrollTop=500");
    await sleep(200);
    const pinned = await js<{ page: number; bar: number; side: number }>("(()=>{const p=document.querySelector('[data-feedback-scroller]').getBoundingClientRect().top;return {page:p,bar:document.querySelector('.feedback-toolbar').getBoundingClientRect().top,side:document.querySelector('.conversation-side').getBoundingClientRect().top}})()");
    assert.ok(Math.abs(pinned.bar - pinned.page) <= 12 && Math.abs(pinned.side - pinned.page) <= 20, `Pinned while scrolling: ${JSON.stringify(pinned)}`);
    await capture('scrolled-pinned', [[1280, 800], [1600, 900]], () => js("document.querySelector('[data-feedback-scroller]').scrollTop=500"));
    // Narrow: the details become a strip above the timeline.
    win.setContentSize(760, 800);
    await sleep(300);
    const strip = await js<{ position: string; above: boolean; overflow: boolean }>("(()=>{const s=document.querySelector('.conversation-side'),m=document.querySelector('.conversation-main');return {position:getComputedStyle(s).position,above:s.getBoundingClientRect().bottom<=m.getBoundingClientRect().top+1,overflow:document.documentElement.scrollWidth>innerWidth||(()=>{const p=document.querySelector('[data-feedback-scroller]');return getComputedStyle(p).overflowX!=='hidden'&&p.scrollWidth>p.clientWidth+1})()}})()");
    const wide = await js<string>("(()=>{const p=document.querySelector('[data-feedback-scroller]');const r=p.getBoundingClientRect().right;return JSON.stringify([...p.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>r+1&&e.checkVisibility()).slice(0,6).map(e=>e.tagName+'.'+String(e.className).slice(0,50)+':'+Math.round(e.getBoundingClientRect().right)))})()");
    assert.ok(strip.position === 'static' && strip.above && !strip.overflow, `The details collapse to a strip at 760px: ${JSON.stringify(strip)} ${wide}`);
    await capture('narrow', [[760, 800]], () => js("document.querySelector('[data-feedback-scroller]').scrollTop=0"));
    win.setContentSize(1280, 800);
    // An old Feedback link opens Conversation at its thread.
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:Number(window.singleUrl.split('/').pop())},tab:'feedback',threadId:'t-1'}}))`);
    await wait("document.querySelector('.workspace-panel[data-workspace-active=true] .pr-overview-tabs [aria-selected=true]')?.textContent==='Conversation' && document.querySelector('.workspace-panel[data-workspace-active=true] .feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-1'");
    // A stack: its merge plan and PRs above the timeline.
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await js("document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.workspace-panel[data-workspace-active=true] .conversation-band .stack-overview')");
    await capture('stack', all, () => js("document.querySelector('.workspace-panel[data-workspace-active=true] [data-feedback-scroller]').scrollTop=0"));
    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log('Conversation passed: tab list, description first above the fold, pinned bar and details, narrow strip, Feedback link redirect, stack band.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'));
    await sleep(1500);
    app.exit(1);
  }
});
