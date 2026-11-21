import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every PR name carries GitHub's state icon: green open, gray draft, purple merged, red closed, and the red conflict
 * icon for an open PR with merge conflicts. Checks queue rows,
 * stack member rows, the PR header, its workspace tab and breadcrumb, the stack list and the menu bar panel with
 * synthetic fixtures, and that a merge read while the PR is open updates the icons in place.
 * Captures go to GNOSIS_CAPTURE_DIR (or the temp directory) as gnosis-pr-state-icons-*.png.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const captureDir = process.env.GNOSIS_CAPTURE_DIR || os.tmpdir();
  fs.mkdirSync(captureDir, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(captureDir, `gnosis-pr-state-icons-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const both = async (name: string) => {
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const click = async (label: string) => {
    await wait(`[...document.querySelectorAll('button')].some(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}))`);
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})).click()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const openRow = async (title: string, action: string) => {
    await wait(`[...document.querySelectorAll('.queue-row-main')].some(b=>b.textContent.includes(${JSON.stringify(title)}))`);
    await js(`[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`);
    await click(action);
  };
  const rowState = (title: string) =>
    js<string | null>(
      `(()=>{const row=[...document.querySelectorAll('.queue-item')].find(r=>r.querySelector('.queue-row-main')?.textContent.includes(${JSON.stringify(title)}));return row?.querySelector('.queue-pr-gutter .pr-state-icon')?.dataset.prState ?? null})()`
    );
  // Main leaves merged and closed PRs out of the queue, so single rows are open or draft; merged and closed
  // members show inside the stack.
  // GitHub reports conflicts for the draft and for "conflicting": the draft keeps its draft icon.
  const states = { open: 'State fixture open', draft: 'State fixture draft', conflicting: 'State fixture conflicts' } as const;
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, `${url}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    // Open and draft single PRs, and a stack with merged, closed and open members. Lifecycle reads come from
    // `window.lifecycle`, as in the merged-state suite; `window.dropMerged` leaves merged PRs out of the queue.
    await js(`(async()=>{
      const queue=await window.electronAPI.workbenchQueue();
      const source=queue.items.find(i=>i.subject.kind==='pr');
      const stack=structuredClone(queue.items.find(i=>i.subject.kind==='stack'));
      const states=${JSON.stringify(states)};
      const singles=Object.entries(states).map(([state,title],i)=>{
        const item=structuredClone(source);
        const url='https://github.com/fixture/pr-states/pull/'+(i+1);
        item.subject.id=url;item.subject.title=title;item.briefing=undefined;item.review=undefined;
        item.subject.members=[{...item.subject.members[0],url,number:i+1,title,headSha:'state-'+i,repo:'fixture/pr-states',headRepo:'fixture/pr-states',baseRepo:'fixture/pr-states',
          state:'open',merged:false,isDraft:state==='draft'}];
        return item;
      });
      stack.subject.title='State fixture stack';
      stack.subject.members[0]={...stack.subject.members[0],state:'closed',merged:true};
      stack.subject.members[1]={...stack.subject.members[1],state:'closed',merged:false};
      window.lifecycle={};window.dropMerged=false;
      const items=[...singles,stack];
      window.electronAPI.workbenchQueue=async()=>({...queue,revision:undefined,
        items:window.dropMerged?items.filter(i=>i.subject.members.some(m=>!window.lifecycle[m.url]||window.lifecycle[m.url].state==='open')):items});
      const signals=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async(...args)=>(await signals(...args)).map(v=>/pr-states\\/pull\\/[23]$/.test(v.url)?{...v,readiness:{...v.readiness,mergeable:'CONFLICTING',mergeState:'DIRTY'}}:v);
      const status=window.electronAPI.getPrStatus;
      window.electronAPI.getPrStatus=async(url,...rest)=>{const result=await status(url,...rest);return result&&window.lifecycle[url]?{...result,lifecycle:window.lifecycle[url]}:result;};
      document.querySelector('.queue-toolbar button[aria-label]').click();
    })()`);

    // Queue rows: one icon per state, with an accessible name that does not read as an action.
    await wait(`[...document.querySelectorAll('.queue-row-main')].some(b=>b.textContent.includes('State fixture draft'))`);
    // Status arrives after the rows: an open PR with conflicts turns into the conflict icon.
    await wait("!!document.querySelector('.queue-pr-gutter .pr-state-icon.is-conflicting')");
    for (const [state, title] of Object.entries(states)) assert.equal(await rowState(title), state, `${title} row`);
    assert.equal(
      await js("document.querySelector('.queue-pr-gutter .pr-state-icon.is-draft')?.getAttribute('aria-label')"),
      'PR state: Draft'
    );
    const conflicting = ".queue-pr-gutter .pr-state-icon.is-conflicting";
    assert.equal(await js(`document.querySelector('${conflicting}')?.getAttribute('aria-label')`), 'PR state: Open, has merge conflicts');
    assert.equal(
      await js(`getComputedStyle(document.querySelector('${conflicting}')).color`),
      await js("(()=>{const e=document.createElement('span');e.style.color='var(--color-danger)';document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c})()"),
      'Conflicts show in the danger color'
    );
    // Every glyph shares one slot size, so rows line up whatever the state.
    const sizes = await js<string[]>("[...document.querySelectorAll('.queue-pr-gutter .pr-state-icon')].map(i=>{const r=i.getBoundingClientRect();return r.width+'x'+r.height})");
    assert.equal(new Set(sizes).size, 1, `Icon slots differ: ${sizes.join(', ')}`);

    // Stack member rows.
    await js(`[...document.querySelectorAll('.queue-item')].find(r=>r.textContent.includes('State fixture stack')).querySelector('.queue-disclosure').click()`);
    await wait("document.querySelectorAll('.queue-member .pr-state-icon').length===3");
    assert.deepEqual(
      await js<string[]>("[...document.querySelectorAll('.queue-member .pr-state-icon')].map(i=>i.dataset.prState).sort()"),
      ['closed', 'merged', 'open']
    );
    assert.equal(await js("document.querySelector('.queue-member .pr-state-icon.is-merged')?.getAttribute('aria-label')"), 'PR state: Merged');
    const memberSizes = await js<string[]>("[...document.querySelectorAll('.queue-member .pr-state-icon')].map(i=>{const r=i.getBoundingClientRect();return r.width+'x'+r.height})");
    assert.equal(new Set([...sizes, ...memberSizes]).size, 1, `Icon slots differ: ${[...sizes, ...memberSizes].join(', ')}`);
    await both('queue');

    // The PR header, its tab and its breadcrumb.
    await openRow(states.open, 'Open PR overview');
    await wait("document.querySelector('.pr-overview-heading h1 .pr-state-icon')?.dataset.prState==='open'");
    await wait("document.querySelector('.workspace-tab[data-active=\"true\"] .pr-state-icon')?.dataset.prState==='open'");
    await wait("!!document.querySelector('.review-breadcrumbs [data-slot=breadcrumb-list] .pr-state-icon.is-open')");
    const heading = await js<{ icon: number; text: number }>(
      "(()=>{const h=document.querySelector('.pr-overview-heading h1');const i=h.querySelector('.pr-state-icon').getBoundingClientRect();return {icon:i.height,text:parseFloat(getComputedStyle(h).fontSize)}})()"
    );
    assert.ok(Math.abs(heading.icon - heading.text) < 1.5, `Heading icon follows the text size: ${JSON.stringify(heading)}`);
    await both('header-open');

    // Merged on GitHub while the PR is open: the next status read updates the header, tab and breadcrumb in place.
    const openUrl = 'https://github.com/fixture/pr-states/pull/1';
    await js(`window.lifecycle[${JSON.stringify(openUrl)}]={state:'closed',merged:true,updatedAt:new Date(Date.now()+60000).toISOString()};window.dropMerged=true`);
    await js("window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed',{detail:[]}))");
    await wait("document.querySelector('.pr-overview-heading h1 .pr-state-icon')?.dataset.prState==='merged'");
    await wait("document.querySelector('.workspace-tab[data-active=\"true\"] .pr-state-icon')?.dataset.prState==='merged'");
    await wait("!!document.querySelector('.review-breadcrumbs [data-slot=breadcrumb-list] .pr-state-icon.is-merged')");
    await both('header-merged');

    // The draft PR's header.
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-overview-heading')");
    await openRow(states.draft, 'Open PR overview');
    await wait("document.querySelector('.pr-overview-heading h1 .pr-state-icon')?.dataset.prState==='draft'");
    await wait("document.querySelector('.workspace-tab[data-active=\"true\"] .pr-state-icon')?.dataset.prState==='draft'");

    // An open PR with conflicts: the header and its tab show the conflict icon too.
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-overview-heading')");
    await openRow(states.conflicting, 'Open PR overview');
    await wait("document.querySelector('.pr-overview-heading h1 .pr-state-icon')?.dataset.prState==='conflicting'");
    await wait("document.querySelector('.workspace-tab[data-active=\"true\"] .pr-state-icon')?.dataset.prState==='conflicting'");
    await both('header-conflicting');

    // The stack list shows each member's state in its chain node.
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-overview-heading')");
    await openRow('State fixture stack', 'Open stack overview');
    await wait("document.querySelectorAll('.stack-chain-node .pr-state-icon').length===3");
    assert.deepEqual(
      await js<string[]>("[...document.querySelectorAll('.stack-chain-node .pr-state-icon')].map(i=>i.dataset.prState).sort()"),
      ['closed', 'merged', 'open']
    );
    await both('stack');

    // The command palette's PR results use the same icon; the state is also written beside them.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: ['meta'] });
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')==='false'");
    await capture('palette-light');
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");

    // The menu bar panel: rows are open PRs, and a draft shows the draft icon.
    await loadWorkbenchPage(win, new URL('/tests/fixtures/menubar.html', url).href);
    win.setContentSize(360, 560);
    await wait('document.querySelectorAll(".menubar-row").length === 15');
    const menubar = await js<string[]>("[...document.querySelectorAll('.menubar-row-title .pr-state-icon')].map(i=>i.dataset.prState)");
    assert.equal(menubar.length, 15, 'Every menu bar row has a state icon');
    assert.ok(menubar.includes('draft') && menubar.includes('open'), `Menu bar states: ${menubar.join(', ')}`);
    await capture('menubar-light');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await wait("document.documentElement.classList.contains('dark')");
    await capture('menubar-dark');
    console.log(`PR state icon browser checks passed. Captures in ${captureDir}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    console.error(await js<string>('document.body.innerText.slice(0, 2000)').catch(() => ''));
    app.exit(1);
  }
});
