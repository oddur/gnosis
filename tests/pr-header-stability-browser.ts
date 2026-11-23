import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The PR header (breadcrumbs, title, metadata, actions, status and the tab bar) is one frame shared
 * by every section. Switching sections, waiting for a section to load, or opening chat must not move
 * or resize any part of it: only the active indicator and the content below the tabs change.
 */
type Rect = [number, number, number, number];
interface Frame {
  toolbar: Rect | null;
  breadcrumbs: Rect | null;
  queueNavigation: Rect | null;
  title: Rect | null;
  titleFont: string;
  menu: Rect | null;
  metadata: Rect | null;
  readiness: Rect | null;
  status: Rect | null;
  reviewActions: Rect[];
  scope: Rect | null;
  navigation: Rect | null;
  tabs: Rect[];
  contentTop: number | null;
  indicator: { tab: string; rect: Rect; width: string; color: string } | null;
  reviewActionsVisible: boolean;
  focusRing: boolean;
}

const sections = ['Summary', 'Changes', 'Commits', 'Checks', 'Explanation', 'Local notes'] as const;
const tolerance = 0.5;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    if (!message.includes('[vite]')) console.log('renderer:', message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (expression: string, attempts = 200) => {
    for (let i = 0; i < attempts; i++) {
      if (await js(expression)) return true;
      await pause(50);
    }
    return false;
  };
  const must = async (expression: string) => {
    if (!(await wait(expression))) throw Error(`Timed out: ${expression}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await pause(60);
  };
  // A real pointer click, so focus-visible follows the same heuristics as in the app.
  const pointerTab = async (label: string) => {
    const point = await js<{ x: number; y: number }>(
      `(()=>{const t=[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].find(t=>t.textContent.replace(/\\d+$/,'').trim()===${JSON.stringify(label)});if(!t)throw Error('Missing tab '+${JSON.stringify(label)});t.scrollIntoView({block:'nearest',inline:'nearest'});const r=t.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await must(
      `[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].find(t=>t.dataset.state==='active')?.textContent.replace(/\\d+$/,'').trim()===${JSON.stringify(label)}`
    );
  };
  const viewport = async (width: number, height: number) => {
    win.setContentSize(width, height);
    await must(`innerWidth===${width} && innerHeight===${height}`);
    await pause(150);
  };
  const shots = process.env.GNOSIS_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'gnosis-header-stability');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    win.show();
    await js('document.fonts.ready');
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await pause(150);
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const frame = () =>
    js<Frame>(`(()=>{
      const round=v=>Math.round(v*100)/100;
      const rect=e=>{if(!e)return null;const b=e.getBoundingClientRect();return [b.x,b.y,b.width,b.height].map(round)};
      const q=s=>document.querySelector(s);
      const page=q('.pr-summary-page');
      const list=page.querySelector('.pr-overview-tabs');
      const tabs=[...list.querySelectorAll('[role=tab]')];
      // A narrow tab strip scrolls; compare the strip's layout, not how far it is scrolled.
      const tabRect=e=>{const b=rect(e);b[0]=round(b[0]+list.scrollLeft);return b};
      const active=tabs.find(t=>t.dataset.state==='active');
      const panel=[...page.children].find(e=>e.getAttribute('role')==='tabpanel'&&e.dataset.state==='active');
      const actions=q('.pr-header-actions');
      let indicator=null;
      if(active){const b=active.getBoundingClientRect(),s=getComputedStyle(active);const w=parseFloat(s.borderBottomWidth);indicator={tab:active.textContent.trim(),rect:[b.x+list.scrollLeft,b.bottom-w,b.width,w].map(round),width:s.borderBottomWidth,color:s.borderBottomColor}}
      return {
        toolbar:rect(q('.pr-summary-toolbar')),
        breadcrumbs:rect(q('.review-breadcrumbs')),
        queueNavigation:rect(q('.pr-queue-navigation')),
        title:rect(q('.pr-overview-heading h1')),
        titleFont:getComputedStyle(q('.pr-overview-heading h1')).fontSize,
        menu:rect(q('.pr-overview-heading .entry-menu-trigger')),
        metadata:q('.pr-heading-meta')?.checkVisibility()?rect(q('.pr-heading-meta')):null,
        readiness:q('.pr-heading-meta .merge-readiness-chip')?.checkVisibility()?rect(q('.pr-heading-meta .merge-readiness-chip')):null,
        status:rect(q('.pr-header-actions')),
        reviewActions:[...document.querySelectorAll('.pr-header-actions [data-slot=button]')].filter(b=>b.getBoundingClientRect().width>0).map(rect),
        scope:rect(q('.stack-scope-bar')),
        navigation:rect(q('.pr-workspace-navigation')),
        tabs:tabs.map(tabRect),
        contentTop:panel?round(panel.getBoundingClientRect().top):null,
        indicator,
        reviewActionsVisible:!!actions&&actions.checkVisibility({visibilityProperty:true}),
        focusRing:!!active&&active.matches(':focus-visible'),
      };
    })()`);

  const failures: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const sameRect = (a: Rect | null, b: Rect | null) =>
    a === b || (!!a && !!b && a.every((value, index) => near(value, b[index])));
  const describe = (rect: Rect | null) => (rect ? `x${rect[0]} y${rect[1]} w${rect[2]} h${rect[3]}` : 'absent');
  const compare = (where: string, reference: Frame, current: Frame) => {
    const keys = [
      'toolbar',
      'breadcrumbs',
      'queueNavigation',
      'title',
      'menu',
      'metadata',
      'readiness',
      'status',
      'scope',
      'navigation',
    ] as const;
    for (const key of keys)
      if (!sameRect(reference[key], current[key]))
        failures.push(`${where}: ${key} ${describe(reference[key])} -> ${describe(current[key])}`);
    if (reference.titleFont !== current.titleFont)
      failures.push(`${where}: title font ${reference.titleFont} -> ${current.titleFont}`);
    if (reference.reviewActions.length !== current.reviewActions.length)
      failures.push(`${where}: ${reference.reviewActions.length} review actions -> ${current.reviewActions.length}`);
    reference.reviewActions.forEach((rect, index) => {
      if (!sameRect(rect, current.reviewActions[index] ?? null))
        failures.push(
          `${where}: review action ${index} ${describe(rect)} -> ${describe(current.reviewActions[index] ?? null)}`
        );
    });
    if (reference.tabs.length !== current.tabs.length)
      failures.push(`${where}: ${reference.tabs.length} tabs -> ${current.tabs.length}`);
    reference.tabs.forEach((rect, index) => {
      if (!sameRect(rect, current.tabs[index] ?? null))
        failures.push(`${where}: tab ${sections[index]} ${describe(rect)} -> ${describe(current.tabs[index] ?? null)}`);
    });
    if (reference.contentTop === null || current.contentTop === null || !near(reference.contentTop, current.contentTop))
      failures.push(`${where}: content top ${reference.contentTop} -> ${current.contentTop}`);
    if (!reference.indicator || !current.indicator) failures.push(`${where}: no active indicator`);
    else {
      const indicator = current.indicator;
      const index = sections.findIndex((s) => indicator.tab.startsWith(s));
      const tab = index < 0 ? undefined : current.tabs.at(index);
      if (
        !near(reference.indicator.rect[1], indicator.rect[1]) ||
        !near(reference.indicator.rect[3], indicator.rect[3])
      )
        failures.push(`${where}: indicator ${describe(reference.indicator.rect)} -> ${describe(indicator.rect)}`);
      if (!tab || !near(tab[0], indicator.rect[0]) || !near(tab[2], indicator.rect[2]))
        failures.push(`${where}: indicator does not span its tab`);
      if (reference.indicator.color !== current.indicator.color) failures.push(`${where}: indicator colour changed`);
    }
    if (current.focusRing) failures.push(`${where}: pointer click left a focus ring on the active tab`);
    // A PR's actions, Drafts and Review PR included, stay in the header's tab row on every section (#542).
    if (reference.reviewActions.length && !current.reviewActionsVisible) failures.push(`${where}: header actions hidden`);
  };
  const report: Record<string, Record<string, Frame>> = {};

  const sectionReady: Record<(typeof sections)[number], string> = {
    Summary: "!!document.querySelector('.pr-summary-content[data-state=active] .pr-summary-body')",
    Changes:
      "!!document.querySelector('.pr-changes-tab[data-state=active] .changes-file-header, .pr-changes-tab[data-state=active] .changes-file-tree')",
    Commits: "!!document.querySelector('.pr-changes-tab[data-state=active] .commit-row')",
    Checks: "!!document.querySelector('.pr-changes-tab[data-state=active] .pr-checks-workspace')",
    Explanation:
      "!!document.querySelector('.pr-changes-tab[data-state=active] .explanation-reader, .pr-changes-tab[data-state=active] .explanation-empty')",
    'Local notes': "!!document.querySelector('.pr-changes-tab[data-state=active] .agent-brief')",
  };

  /** Visits every section from Summary and compares each frame, while loading and once settled. */
  const visitAll = async (subject: string, width: number, height: number, theme: 'light' | 'dark') => {
    const key = `${subject}-${width}x${height}-${theme}`;
    await viewport(width, height);
    await js(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
    await pointerTab('Summary');
    await must(sectionReady.Summary);
    await pause(400);
    const reference = await frame();
    report[key] = { Summary: reference };
    // Summary content ends where the header does, even with its scrollbar gutter.
    const edges = await js<{ header: number; content: number; gutter: number }>(
      `(()=>{const page=document.querySelector('.pr-summary-page'),inset=parseFloat(getComputedStyle(page).getPropertyValue('--pr-frame-inset'));const content=document.querySelector('.pr-summary-content'),body=content.querySelector('.pr-summary-body');return {header:page.getBoundingClientRect().left+page.clientWidth-inset,content:body.getBoundingClientRect().right,gutter:content.offsetWidth-content.clientWidth}})()`
    );
    if (!near(edges.header, edges.content))
      failures.push(
        `${key} Summary: content right edge ${edges.content} vs header ${edges.header} (gutter ${edges.gutter})`
      );
    await capture(`${key}-summary`);
    for (const section of sections.slice(1)) {
      console.log(`header-stability: ${key} ${section}`);
      await pointerTab(section);
      compare(`${key} ${section} (first paint)`, reference, await frame());
      await wait(sectionReady[section], 120);
      await pause(400);
      const settled = await frame();
      report[key][section] = settled;
      compare(`${key} ${section}`, reference, settled);
      await capture(`${key}-${section.toLowerCase().replace(/\s+/g, '-')}`);
    }
    // Returning to Summary lands on the same frame.
    await pointerTab('Summary');
    await pause(200);
    compare(`${key} Summary (return)`, reference, await frame());
  };

  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(`window.electronAPI.startReview=async()=>{throw Error('Unexpected generation')};void 0;`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await must("!!document.querySelector('.pr-overview-tabs')");
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].map(b=>b.textContent.replace(/\\d+$/,'').trim())"
      ),
      [...sections]
    );
    for (const [width, height] of [
      [1280, 800],
      [640, 800],
    ] as const)
      for (const theme of ['light', 'dark'] as const) await visitAll('pr', width, height, theme);

    // Extreme zoom: every section scrolls the page the same way.
    await visitAll('pr', 1280, 460, 'light');

    // Drafts open from the header on a section without its own review controls.
    await viewport(1280, 800);
    await js(`document.documentElement.classList.remove('dark')`);
    await pointerTab('Checks');
    await pause(200);
    const checksFrame = await frame();
    await js(
      "[...document.querySelectorAll('.pr-header-actions button')].find(b=>b.textContent.startsWith('Drafts')).click()"
    );
    if (!(await wait("!!document.querySelector('.pr-header-review-panel .changes-drafts')", 60)))
      failures.push('Drafts from the header did not open on Checks');
    else {
      const open = await frame();
      compare('pr-1280x800-light Checks with drafts', { ...checksFrame, contentTop: open.contentTop }, open);
      await capture('pr-1280x800-light-checks-drafts');
      await click('Close drafts');
      await must("!document.querySelector('.pr-header-review-panel .changes-drafts')");
    }

    // Chat beside Changes keeps the same header.
    await viewport(1280, 800);
    await js(`document.documentElement.classList.remove('dark')`);
    await pointerTab('Summary');
    await pause(300);
    const reference = await frame();
    await pointerTab('Changes');
    if (
      await wait(
        "[...document.querySelectorAll('.changes-file-header button')].some(b=>b.getAttribute('aria-label')==='Ask about this')",
        100
      )
    ) {
      await js(
        "[...document.querySelectorAll('.changes-file-header button')].find(b=>b.getAttribute('aria-label')==='Ask about this').click()"
      );
      await must("!!document.querySelector('.changes-chat')");
      // The composer loads with the chat (components/chat-lazy.tsx).
      await must("!!document.querySelector('.changes-chat textarea')");
      await pause(300);
      compare('pr-1280x800-light Changes with chat', reference, await frame());
      await capture('pr-1280x800-light-changes-chat');
      await js(
        "document.querySelector('.changes-chat textarea')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
      );
    } else failures.push('Changes did not offer Ask about this');

    // A stack, which adds the scope picker and opens a saved explanation in the reader.
    await click('Review queue');
    await must("!!document.querySelector('.queue-row-main')");
    await js(
      "[...document.querySelectorAll('.workbench-sidebar button')].find(b=>b.textContent.startsWith('Stacks')).click()"
    );
    await must("document.querySelectorAll('.queue-item').length===1");
    await js("document.querySelector('.queue-row-main').click()");
    await click('Open stack overview');
    await must("!!document.querySelector('.pr-summary-page.is-stack .pr-overview-tabs')");
    for (const [width, height] of [
      [1280, 800],
      [640, 800],
    ] as const)
      await visitAll('stack', width, height, 'light');
    await visitAll('stack', 1280, 800, 'dark');

    fs.writeFileSync(path.join(shots, 'frames.json'), JSON.stringify(report, null, 1));
    if (failures.length) {
      console.error(`PR header moved in ${failures.length} places:\n  ${failures.join('\n  ')}`);
      app.exit(1);
      return;
    }
    console.log(`PR header stability checks passed; captures in ${shots}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (failures.length) console.error(`Also, the PR header moved:\n  ${failures.join('\n  ')}`);
    fs.writeFileSync(path.join(shots, 'frames.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(shots, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
