import { loadWorkbenchPage, waitForWorkbenchQueue, waitSettled } from './workbench-ready';
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
/** With GNOSIS_SUMMARY_SHOTS set, the suite only captures a richer Summary page (pushes over several days, reviews, a
 * bot, comments) at 1440 and 1024px in both themes, printed as `SUMSHOT <name> <base64 PNG>` lines, and exits. */
const summaryShots = process.env.GNOSIS_SUMMARY_SHOTS;
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
      if(${JSON.stringify(!!summaryShots)}){
        const day=d=>-d*1440;
        data.feedback.events=[
          {kind:'commit',id:'k0',at:at(day(12)),sha:'9f8e7d6c5b4a',message:'Keep queued messages in the outbox',author:'oddur'},
          {kind:'commit',id:'k0b',at:at(day(12)+5),sha:'1a2b3c4d5e6f',message:'Replay the outbox after reconnecting',author:'oddur'},
          {kind:'review-requested',id:'rr1',at:at(day(12)+9),actor:'oddur',reviewer:'maya'},
          {kind:'commit',id:'k1',at:at(-30),sha:'a1b2c3d4e5f6',message:'Guard the reconnect timer',author:'oddur'},
          {kind:'commit',id:'k2',at:at(-25),sha:'b2c3d4e5f6a7',message:'test: cover a slow reconnect',author:'oddur'},
          {kind:'force-push',id:'fp1',at:at(40),actor:'oddur',before:'a1b2c3d4e5f6',after:'c3d4e5f6a7b8'}];
        data.feedback.comments.push(c('pc0','lena',day(11),'Does the outbox survive an app restart, or only a transport swap? A restart would need the queue on disk.'));
        data.feedback.comments.push(c('bot1','ci-reporter[bot]',day(11)+30,'Coverage: 84.2% (+0.4%)',{author:{login:'ci-reporter[bot]',avatarUrl:'',__typename:'Bot'}}));
        data.feedback.reviews.push({...c('r0','lena',day(10),'The approach reads well. Two small notes on naming.'),state:'COMMENTED',submittedAt:at(day(10))});
      }
      window.electronAPI.getCachedReviewThreads=async url=>url===m.url?structuredClone(data):undefined;
      const read=window.electronAPI.getReviewThreads;
      window.electronAPI.getReviewThreads=async (url,...rest)=>url===m.url?structuredClone(data):read(url,...rest);
    })()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.feedback-entry[data-feedback-id=\"t-1\"]') || !!document.querySelector('.feedback-entry[data-entry-type=description]')");
    await wait("[...document.querySelectorAll('.pr-overview-tabs [role=tab] .pr-tab-label')].map(t=>t.dataset.label).join()==='Summary,Changes,Commits,Checks,Explanation,Local notes'");
    if (summaryShots) {
      await wait("!!document.querySelector('.conversation-sidebar') && !!document.querySelector('.feedback-entry[data-entry-type=day]')");
      const settle = async (width: number, height: number) => {
        win.setContentSize(width, height);
        await wait(`innerWidth===${width}`);
        await js('document.fonts.ready');
        await wait("document.querySelector('img[alt=\"Reconnect flow\"]')?.naturalWidth>0");
      };
      const pageScroll = (to: string) => js(`(()=>{const p=document.querySelector('[data-feedback-scroller]');p.scrollTop=0;p.scrollTop=${to}})()`);
      const timelineTop = "document.querySelector('.feedback-toolbar').getBoundingClientRect().top-document.querySelector('[data-feedback-scroller]').getBoundingClientRect().top-8";
      // The type in use per region: size, weight and a sample, so a pass can compare tiers in numbers too.
      const audit = String.raw`(()=>{const regions=[['header','.pr-overview-header, .pr-overview-heading'],['tabs','.pr-overview-tabs'],['band','.conversation-band'],['description','.conversation-description'],['bar','.feedback-toolbar'],['timeline','.feedback-timeline'],['sidebar','.conversation-sidebar']];
        const out={};for(const el of document.querySelectorAll('body *')){if(!el.checkVisibility())continue;const text=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim();if(!text)continue;
          const region=regions.find(([,s])=>el.closest(s));if(!region)continue;const cs=getComputedStyle(el);const key=region[0]+' '+cs.fontSize+' '+cs.fontWeight;(out[key]??=new Set()).add(text.slice(0,28));}
        return Object.entries(out).map(([k,v])=>k+' :: '+[...v].slice(0,6).join(' | ')).sort().join('\n')})()`;
      for (const [width, height] of [[1440, 900], [1024, 768]]) {
        await settle(width, height);
        if (width === 1440) {
          await pageScroll(timelineTop);
          await waitSettled(win.webContents, 'feedback-timeline');
          console.log(`SUMTYPE\n${await js<string>(audit)}`);
        }
        for (const dark of [false, true]) {
          await js(`document.documentElement.classList.toggle('dark',${dark})`);
          await wait(`document.documentElement.classList.contains('dark')===${dark}`);
          for (const [part, to] of [['top', '0'], ['timeline', timelineTop]] as const) {
            await pageScroll(to);
            await waitSettled(win.webContents, 'feedback-timeline');
            console.log(`SUMSHOT ${part}-${width}-${dark ? 'dark' : 'light'} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
          }
        }
      }
      app.exit(errors.filter((e) => !e.includes('favicon')).length ? 1 : 0);
      return;
    }
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
    // The description shows whole (#418): the timeline's bar follows straight after it. With a short description
    // the first feedback still starts above the fold at 1280×800; a long one pushes the timeline down instead.
    const descriptionHeight = await js<number>("document.querySelector('.conversation-description .feedback-entry-body').getBoundingClientRect().height");
    if (descriptionHeight <= 160)
      assert.ok(first.feedbackTop < first.height - 40, `A short description keeps the first feedback above the fold: ${JSON.stringify(first)}`);
    const whole = await js<{ clipped: boolean; toggle: boolean; gap: number }>(`(()=>{const body=document.querySelector('.conversation-description .feedback-entry-body');const sec=document.querySelector('.conversation-description');const bar=document.querySelector('.feedback-toolbar');
      return {clipped:body.scrollHeight>body.clientHeight+1,toggle:!!document.querySelector('.feedback-description-toggle'),gap:Math.round(bar.getBoundingClientRect().top-sec.getBoundingClientRect().bottom)}})()`);
    assert.ok(!whole.clipped && !whole.toggle && whole.gap >= 0 && whole.gap <= 12, `The whole description, then the timeline: ${JSON.stringify(whole)}`);
    assert.match(await js<string>("document.querySelector('.conversation-sidebar').textContent"), /Reviewers.*maya.*Changes requested.*sam.*Review requested/s);
    // The type follows the page's structure (DESIGN.md › Address Feedback › Type): comments read at the description's
    // size; an entry's heading sits above its commit lines; the bar's controls sit below the entries; sidebar titles
    // sit above their values; the merge verdict above its reasons.
    const type = await js<Record<string, number | null>>(`(()=>{const px=s=>{const e=document.querySelector(s);return e?parseFloat(getComputedStyle(e).fontSize):null};
      return {description:px('.conversation-description .pr-markdown p'),comment:px('.feedback-timeline .github-comment-body'),heading:px('.feedback-entry[data-entry-type=commits] .timeline-title'),
        commit:px('.feedback-commits li'),control:px('.feedback-filters [data-slot=button]'),sideTitle:px('.conversation-sidebar h2'),sideValue:px('.conversation-sidebar dd'),
        verdict:px('.band-readiness .merge-readiness-badge'),reasons:px('.band-readiness .pr-merge-detail ul')}})()`);
    assert.ok(Object.values(type).every((v) => typeof v === 'number'), `Every tier renders: ${JSON.stringify(type)}`);
    const t = type as Record<string, number>;
    assert.ok(t.comment === t.description, `Comments read at the description's size: ${JSON.stringify(type)}`);
    assert.ok(t.heading > t.commit && t.control < t.heading && t.sideTitle > t.sideValue && t.verdict > t.reasons, `Headings sit above their bodies, controls below the content: ${JSON.stringify(type)}`);
    await capture('single-pr', all);
    // Scrolled mid-timeline: the bar and the details column stay pinned.
    // Into the timeline, past the whole description, so the bar is pinned.
    await js("(()=>{const p=document.querySelector('[data-feedback-scroller]');p.scrollTop=0;p.scrollTop=document.querySelector('.feedback-timeline').getBoundingClientRect().top-p.getBoundingClientRect().top+300})()");
    await sleep(200);
    const pinned = await js<{ page: number; bar: number; side: number }>("(()=>{const p=document.querySelector('[data-feedback-scroller]').getBoundingClientRect().top;return {page:p,bar:document.querySelector('.feedback-toolbar').getBoundingClientRect().top,side:document.querySelector('.conversation-side').getBoundingClientRect().top}})()");
    // The details column pins only beside the timeline. A window the screen clamps below 1100px (the 1024px Windows
    // runner) shows the details as a strip above it instead, which scrolls with the page (checked at 760px below).
    const beside = await js<boolean>("(()=>{const side=document.querySelector('.conversation-sidebar').getBoundingClientRect(),main=document.querySelector('.conversation-main').getBoundingClientRect();return side.left>=main.right-1})()");
    assert.ok(Math.abs(pinned.bar - pinned.page) <= 12 && (!beside || Math.abs(pinned.side - pinned.page) <= 20), `Pinned while scrolling: ${JSON.stringify({ ...pinned, beside })}`);
    await capture('scrolled-pinned', [[1280, 800], [1600, 900]], () => js("(()=>{const p=document.querySelector('[data-feedback-scroller]');p.scrollTop=0;p.scrollTop=document.querySelector('.feedback-timeline').getBoundingClientRect().top-p.getBoundingClientRect().top+300})()"));
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
    await wait("document.querySelector('.workspace-panel[data-workspace-active=true] .pr-overview-tabs [aria-selected=true]')?.textContent==='Summary' && document.querySelector('.workspace-panel[data-workspace-active=true] .feedback-entry[aria-current=true]')?.dataset.feedbackId==='t-1'");
    // A stack: its merge plan and PRs above the timeline.
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await js("document.querySelector('.queue-item .queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("!!document.querySelector('.workspace-panel[data-workspace-active=true] .conversation-band .stack-overview')");
    await capture('stack', all, () => js("document.querySelector('.workspace-panel[data-workspace-active=true] [data-feedback-scroller]').scrollTop=0"));
    assert.equal(errors.filter((e) => !e.includes('favicon')).length, 0, errors.join('\n'));
    console.log('Summary page passed: tab list, description first above the fold, pinned bar and details, narrow strip, Feedback link redirect, stack band.');
    app.exit(0);
  } catch (error) {
    console.error(error, errors.join('\n'));
    await sleep(1500);
    app.exit(1);
  }
});
