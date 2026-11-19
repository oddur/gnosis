// Shared chrome stays put while the reviewer moves between sibling views and while content loads.
// The check walks the queue destinations, a briefing, multi-selection, every PR section, Settings and
// a delayed load, records getBoundingClientRect for the shared chrome, and compares the positions that
// must not move. GNOSIS_LAYOUT_AUDIT=1 records every measurement without failing, for audits.
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Rect = { x: number; y: number; w: number; h: number; right: number; bottom: number } | null;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const audit = process.env.GNOSIS_LAYOUT_AUDIT === '1';
  const shots = path.resolve(process.env.GNOSIS_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'gnosis-layout-consistency'));
  fs.mkdirSync(shots, { recursive: true });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (expression: string, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await sleep(50);
    }
    throw Error(`Timed out: ${expression}`);
  };
  const measurements: Record<string, unknown> = {};
  const failures: string[] = [];
  let width = 1280;
  let theme = 'light';
  const view = (name: string) => `${width}-${theme}-${name}`;
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await sleep(200);
    fs.writeFileSync(path.join(shots, `${view(name)}.png`), (await win.webContents.capturePage()).toPNG());
  };
  // Real pointer input, so focus behaves as it does for a mouse user.
  const mouse = async (target: string, modifiers: ('shift' | 'meta' | 'control')[] = []) => {
    const point = await js<{ x: number; y: number } | null>(
      `(()=>{const e=${target};if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+Math.min(r.width/2,40)),y:Math.round(r.y+r.height/2)}})()`
    );
    if (!point) throw Error(`Missing ${target}`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers });
    await sleep(120);
    // Park the pointer in the title bar's drag area so hover styles do not change what is measured.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(width * 0.6), y: 19 });
  };
  const visible = (selector: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility())`;
  const named = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility()&&(e.textContent.trim().startsWith(${JSON.stringify(text)})||e.getAttribute('aria-label')===${JSON.stringify(text)}))`;
  const rects = async (selectors: Record<string, string>) =>
    js<Record<string, Rect>>(
      `(()=>{const o={};for(const [k,s] of Object.entries(${JSON.stringify(selectors)})){const e=[...document.querySelectorAll(s)].find(e=>e.checkVisibility());if(!e){o[k]=null;continue}const r=e.getBoundingClientRect();const n=v=>Math.round(v*10)/10;o[k]={x:n(r.x),y:n(r.y),w:n(r.width),h:n(r.height),right:n(r.right),bottom:n(r.bottom)}}return o})()`
    );
  // A focus ring after a mouse click is a stray ring: keyboard users get :focus-visible, pointer users none.
  const strayFocus = () =>
    js<string | null>(
      `(()=>{const e=document.querySelector(':focus');if(!e||e===document.body)return null;const s=getComputedStyle(e);const ring=(s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&e.matches(':focus-visible')&&!e.matches('input,textarea,select,[contenteditable]'))||/rgb\\([^)]*\\) 0px 0px 0px [1-9]/.test(s.boxShadow)&&!e.matches('input,textarea,[contenteditable]');return ring?(e.getAttribute('aria-label')||e.textContent.trim()).slice(0,50)+' <'+e.tagName.toLowerCase()+'>':null})()`
    );
  const started = Date.now();
  const step = (name: string) => console.log(`layout: ${name} at ${Math.round((Date.now() - started) / 1000)}s`);
  const record = (name: string, value: unknown) => {
    measurements[view(name)] = value;
  };
  const expect = (name: string, pass: boolean, detail: unknown) => {
    if (pass) return;
    const message = `${view(name)}: ${JSON.stringify(detail)}`;
    failures.push(message);
    console.log(`LAYOUT ${audit ? 'finding' : 'failure'} ${message}`);
  };
  const same = (name: string, values: Record<string, number | undefined>, tolerance = 0.5) => {
    const list = Object.values(values).filter((value): value is number => typeof value === 'number');
    expect(name, list.length < 2 || Math.max(...list) - Math.min(...list) <= tolerance, values);
  };
  // Toolbar children whose vertical centre sits below the first row's: the toolbar wrapped and moved them to a new line.
  const wrappedChildren = (bar: string) =>
    `(()=>{const bar=${bar};if(!bar)return [];const kids=[...bar.children].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);const mid=e=>{const r=e.getBoundingClientRect();return r.top+r.height/2};const first=Math.min(...kids.map(mid));return kids.filter(e=>mid(e)>first+12).map(e=>(e.getAttribute('aria-label')||e.textContent.trim()||e.className).slice(0,30))})()`;
  const titlebar = {
    toggleSlot: '.app-titlebar-leading',
    history: '.recent-history-trigger',
    tabs: '.workspace-tabs',
    menu: '.workspace-menu-trigger',
  };
  const queueChrome = {
    ...titlebar,
    title: '.workbench-main h1',
    search: '.workbench-main :is(.queue-search, input[type=search], input[placeholder])',
    filters: '.workbench-main .queue-filters',
    chips: '.workbench-main .briefing-chips',
    section: '.workbench-main .queue-section-title',
    firstRow: '.workbench-main .queue-item',
    rowMenu: '.workbench-main .queue-item .entry-menu-trigger',
    rowTitle: '.workbench-main .queue-item .queue-title',
  };
  const destinations = ['Review queue', 'Starred', 'Review requests', 'Needs my response', 'Updated PRs', 'Stacks', 'Saved reviews', 'Muted PRs'];
  const destination = async (name: string) => {
    await mouse(named('.workbench-sidebar :is(button,a)', name));
    await sleep(350);
  };

  const queuePass = async () => {
    const byView: Record<string, Record<string, Rect>> = {};
    for (const name of destinations) {
      await destination(name);
      byView[name] = await rects(queueChrome);
      // The workspace tab names the list on screen.
      const tabTitle = await js<string>(`document.querySelector('.workspace-tab-select[aria-selected=true]')?.textContent.trim() ?? ''`);
      expect(`workspace tab names ${name}`, tabTitle.startsWith(name), tabTitle);
      expect(`stray focus after opening ${name}`, !(await strayFocus()), await strayFocus());
      await capture(`queue-${name.replace(/\W+/g, '-').toLowerCase()}`);
    }
    record('queue destinations', byView);
    // Sibling destinations share one title, toolbar and filter row position.
    same('queue title x', Object.fromEntries(destinations.map((name) => [name, byView[name].title?.x])));
    same('queue title y', Object.fromEntries(destinations.map((name) => [name, byView[name].title?.y])));
    same('queue title height', Object.fromEntries(destinations.map((name) => [name, byView[name].title?.h])));
    same(
      'queue search row y',
      Object.fromEntries(destinations.filter((name) => byView[name].search).map((name) => [name, byView[name].search?.y]))
    );
    // The page title, its toolbar and the list share one left gutter.
    for (const name of destinations) {
      const r = byView[name];
      same(`left gutter on ${name}`, { title: r.title?.x, search: r.search?.x, section: r.section ? r.section.x + 24 : undefined });
    }
    // Row actions stay in one column whether or not the list scrolls.
    same(
      'row menu right edge',
      Object.fromEntries(destinations.filter((name) => byView[name].rowMenu).map((name) => [name, byView[name].rowMenu?.right]))
    );
    await destination('Review queue');
  };

  const titlebarPass = async (label: string, store: Record<string, Rect>) => {
    const r = await rects(titlebar);
    store[label] = r.history;
  };

  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url);
    win.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(win.webContents);
    const history: Record<string, Rect> = {};
    await titlebarPass('queue', history);
    await queuePass();

    step('overlays');
    // Menus, popovers and panels opened with the mouse show no focus ring on whatever takes focus.
    const overlays: Record<string, unknown> = {};
    for (const [name, trigger] of [
      ['activity', visible('.activity-capsule')],
      ['search', visible('.workspace-menu-search')],
      ['recently viewed', visible('.recent-history-trigger')],
      ['app menu', visible('.workspace-menu-trigger')],
      ['filters', named('.queue-filters button', 'Filters')],
      ['sort', named('.queue-filters button', 'Priority')],
      ['briefing settings', named('button', 'Briefing settings')],
    ] as const) {
      step(`overlay ${name}`);
      await mouse(trigger);
      await sleep(350);
      overlays[name] = {
        focus: await strayFocus(),
        surface: (await rects({ surface: '[role=dialog],[role=menu],[data-radix-popper-content-wrapper] > *,.activity-drawer' })).surface,
      };
      expect(`stray focus when ${name} opens`, !(await strayFocus()), await strayFocus());
      await capture(`overlay-${name.replace(/\W+/g, '-')}`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(250);
      if (await js(`!!document.querySelector('[role=dialog],[role=menu],.activity-drawer')`)) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await sleep(250);
      }
    }
    record('overlays', overlays);

    step('briefing');
    // Briefing and multi-selection keep the queue's chrome and row titles in place.
    const before = await rects(queueChrome);
    await mouse(named('.queue-row-main', 'Fix reconnect'));
    await wait("!!document.querySelector('.briefing-panel')");
    const briefing = await rects({ ...queueChrome, pane: '.briefing-panel' });
    expect('stray focus after selecting a row', !(await strayFocus()), await strayFocus());
    await capture('briefing');
    await titlebarPass('briefing', history);
    for (const key of ['title', 'search', 'chips', 'section'] as const) same(`briefing keeps ${key}`, { before: before[key]?.y, after: briefing[key]?.y });
    same('briefing keeps row title x', { before: before.rowTitle?.x, after: briefing.rowTitle?.x });
    const titles = () =>
      js<number[]>(`[...document.querySelectorAll('.workbench-main .queue-item .queue-title')].filter(e=>e.checkVisibility()).map(e=>Math.round(e.getBoundingClientRect().x*10)/10)`);
    const single = await titles();
    await mouse(named('.queue-row-main', 'Reduce allocations'), ['shift']);
    await wait("document.querySelectorAll('.queue-item.is-selected').length>1");
    const multiple = await titles();
    await capture('multi-selection');
    record('row titles', { single, multiple });
    expect('multi-selection keeps row titles in place', JSON.stringify(single) === JSON.stringify(multiple), { single, multiple });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(200);

    step('pr sections');
    // PR sections: the content below the shared header starts at one position, and section toolbars share one height and inset.
    await mouse(named('.queue-row-main', 'Fix reconnect'));
    await wait("!!document.querySelector('.briefing-panel')");
    await mouse(named('button', 'Open PR overview'));
    await wait("!!document.querySelector('.pr-overview-tabs')");
    await titlebarPass('pr', history);
    const tabNames = await js<string[]>(`[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].map(e=>e.textContent.trim())`);
    const sections: Record<string, unknown> = {};
    // Conversation's timeline bar sits in the page below its band (#418), not at the top of the section like these.
    const toolbar = `.pr-summary-page :is(.changes-toolbar,.checks-toolbar)`;
    for (const [index, name] of tabNames.entries()) {
      await mouse(`document.querySelectorAll('.pr-overview-tabs [role=tab]')[${index}]`);
      await sleep(900);
      const found = {
        ...(await rects({ panel: '.pr-summary-page [role=tabpanel][data-state=active]', toolbar })),
        // The first content box in reading order: the top of the topmost visible element with its own text.
        text: await js<Rect & { name?: string }>(
          `(()=>{const panel=document.querySelector('.pr-summary-page [role=tabpanel][data-state=active]');if(!panel)return null;let best=null;for(const e of panel.querySelectorAll('*')){if(!e.checkVisibility()||![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;const r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;if(!best||r.y<best.y-0.5||(Math.abs(r.y-best.y)<=0.5&&r.x<best.x))best={x:Math.round(r.x*10)/10,y:Math.round(r.y*10)/10,w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom),name:e.tagName.toLowerCase()+'.'+String(e.className).split(' ')[0]}}return best})()`
        ),
      };
      const controls = await js<{ x: number; h: number; label: string }[]>(
        `(()=>{const bar=${visible(toolbar)};if(!bar)return [];return [...bar.children].flatMap(c=>c.matches('button,label,[role=group],[role=combobox]')?[c]:[...c.querySelectorAll(':scope>button,:scope>[role=group]')]).filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),h:Math.round(r.height),label:(e.getAttribute('aria-label')||e.textContent.trim()).slice(0,30)}})})()`
      );
      const wrapped = await js<string[]>(wrappedChildren(visible(toolbar)));
      sections[name] = { ...found, controls, wrapped };
      expect(`${name} toolbar stays on one line`, !wrapped.length, wrapped);
      expect(`stray focus after the ${name} tab`, !(await strayFocus()), await strayFocus());
      await capture(`pr-${name.replace(/\W+/g, '-').toLowerCase()}`);
      await titlebarPass(`pr ${name}`, history);
    }
    record('pr sections', sections);
    // Wider text: Windows renders the toolbar wider and its window is often narrower than asked, which
    // wrapped the Changes toolbar to 89px. Letter-spacing adds about 10% to every label, and the toolbar
    // must still hold one row from 1280px down to the narrow layout.
    await mouse(named('.pr-overview-tabs [role=tab]', 'Changes'));
    await sleep(900);
    await js(`(()=>{const s=document.createElement('style');s.id='wide-text';s.textContent='.changes-toolbar{letter-spacing:.06em}';document.head.append(s)})()`);
    const changesBar = `document.querySelector('.pr-summary-page [role=tabpanel][data-state=active] .changes-toolbar')`;
    const wideText: Record<number, unknown> = {};
    for (const contentWidth of [1280, 1200, 1180, 1100, 1024, 960, 900, 860, 800, 760, 720]) {
      width = contentWidth;
      win.setContentSize(contentWidth, 800);
      await sleep(250);
      const wrapped = await js<string[]>(wrappedChildren(changesBar));
      const height = await js<number>(`Math.round(${changesBar}.getBoundingClientRect().height)`);
      wideText[contentWidth] = { height, wrapped };
      await capture('changes-wider-text');
      expect('Changes toolbar with wider text', !wrapped.length && height === 49, { height, wrapped });
    }
    width = 1280;
    record('changes toolbar with wider text', wideText);
    await js(`document.getElementById('wide-text').remove()`);
    win.setContentSize(1280, 800);
    await sleep(300);
    const bars = Object.entries(sections).filter(([, value]) => (value as { toolbar: Rect }).toolbar) as [string, { toolbar: NonNullable<Rect>; controls: { x: number; h: number; label: string }[] }][];
    same('section toolbar height', Object.fromEntries(bars.map(([name, value]) => [name, value.toolbar.h])));
    same('section toolbar first control x', Object.fromEntries(bars.map(([name, value]) => [name, value.controls[0]?.x])));
    for (const [name, value] of bars) {
      const heights = value.controls.filter((control) => control.h > 20).map((control) => control.h);
      expect(`${name} toolbar controls share one height`, new Set(heights).size <= 1, value.controls);
    }
    // Summary opens with its bordered readiness row; the text sections open with a heading 16px below the tabs.
    const content = Object.entries(sections).filter(([name]) => ['Explanation', 'Local notes'].includes(name)) as [string, { panel: NonNullable<Rect>; text: Rect }][];
    same('content sections first row offset', Object.fromEntries(content.map(([name, value]) => [name, value.text ? value.text.y - value.panel.y : undefined])), 1);
    same('content sections left edge', Object.fromEntries(content.map(([name, value]) => [name, value.text?.x])));

    step('settings');
    // Settings: the dialog does not resize between sections and opens without a ring on its close button.
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('.settings-tabs')");
    await sleep(250);
    expect('stray focus when Settings opens', !(await strayFocus()), await strayFocus());
    await capture('settings-open');
    const settingsTabs = await js<number>(`document.querySelectorAll('.settings-sections [role=tab]').length`);
    const settings: Record<string, Record<string, Rect>> = {};
    for (let index = 0; index < settingsTabs; index++) {
      await mouse(`document.querySelectorAll('.settings-sections [role=tab]')[${index}]`);
      await sleep(300);
      settings[index] = await rects({ dialog: '[role=dialog]', list: '.settings-sections', panel: '.settings-tabs [role=tabpanel][data-state=active]' });
      expect(`stray focus on settings section ${index}`, !(await strayFocus()), await strayFocus());
    }
    record('settings', settings);
    same('settings dialog height', Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value.dialog?.h])));
    same('settings panel top', Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value.panel?.y])));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('[role=dialog]')");

    // Title bar: history and tabs keep their place whether or not the page has a sidebar.
    record('title bar history', history);
    same('title bar history x', Object.fromEntries(Object.entries(history).map(([key, value]) => [key, value?.x])));

    step('loading');
    // Loading to loaded: while a PR's data is delayed, each section already shows its toolbar and panes
    // where the loaded section has them.
    await mouse(named('.pr-summary-toolbar button', 'Review queue'));
    await wait("!!document.querySelector('.queue-item')");
    await js(`(()=>{const api=window.electronAPI;const gate=window.__layoutGate={open:false,pending:[]};for(const name of ['getPrChanges','getPrCommits','getReviewThreads','getPrChecks']){const read=api[name].bind(api);api[name]=(...args)=>gate.open?read(...args):new Promise((resolve,reject)=>gate.pending.push(()=>read(...args).then(resolve,reject)))}})()`);
    await mouse(named('.queue-row-main', 'Reduce allocations'));
    await wait("!!document.querySelector('.briefing-panel')");
    await mouse(named('button', 'Open PR overview'));
    await wait("!!document.querySelector('.pr-overview-tabs')");
    const layoutOf = () =>
      js<{ toolbar: Rect; panes: Rect[]; tree: (number | null)[] }>(
        `(()=>{const n=v=>Math.round(v*10)/10;const box=e=>{const r=e.getBoundingClientRect();return {x:n(r.x),y:n(r.y),w:n(r.width),h:n(r.height),right:n(r.right),bottom:n(r.bottom)}};const panel=document.querySelector('.pr-summary-page [role=tabpanel][data-state=active]');const bar=panel&&panel.querySelector('.changes-toolbar,.checks-toolbar,.feedback-toolbar');const root=bar?bar.parentElement:panel;const deep=(sel,r=document)=>[...r.querySelectorAll(sel),...[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?deep(sel,e.shadowRoot):[])];const tree=panel?deep('[data-item-path]',panel).filter(e=>e.getBoundingClientRect().height>0).map(row=>{const d=row.querySelector('[data-item-section=decoration]');const r=d?d.getBoundingClientRect():null;return r?n(r.x):null}):[];return {toolbar:bar?box(bar):null,panes:root?[...root.children].filter(e=>e!==bar&&e.checkVisibility()&&!e.matches('[role=status],.changes-notice')).map(box).slice(0,3):[],tree}})()`
      );
    const loading: Record<string, unknown> = {};
    for (const name of ['Changes', 'Commits']) {
      await js(`window.__layoutGate.open=false`);
      await mouse(named('.pr-overview-tabs [role=tab]', name));
      await sleep(400);
      const pending = await layoutOf();
      await capture(`loading-${name.toLowerCase()}`);
      await js(`(()=>{const g=window.__layoutGate;g.open=true;for(const f of g.pending.splice(0))f()})()`);
      await sleep(1200);
      const loaded = await layoutOf();
      await capture(`loaded-${name.toLowerCase()}`);
      loading[name] = { pending, loaded };
      same(`${name} toolbar top while loading`, { pending: pending.toolbar?.y, loaded: loaded.toolbar?.y });
      same(`${name} toolbar height while loading`, { pending: pending.toolbar?.h, loaded: loaded.toolbar?.h });
      same(`${name} first pane left while loading`, { pending: pending.panes[0]?.x, loaded: loaded.panes[0]?.x });
      same(`${name} first pane width while loading`, { pending: pending.panes[0]?.w, loaded: loaded.panes[0]?.w });
      // File tree stats do not move when comment counts arrive.
      expect(`${name} file tree stats stay put while comments load`, JSON.stringify(pending.tree) === JSON.stringify(loaded.tree), { pending: pending.tree, loaded: loaded.tree });
    }
    record('loading', loading);

    step('narrow');
    // Narrow and dark: the same queue checks at the briefing breakpoint.
    width = 760;
    theme = 'dark';
    win.setContentSize(760, 800);
    await js("document.documentElement.classList.add('dark')");
    await sleep(300);
    await mouse(named('.pr-summary-toolbar button', 'Review queue')).catch(() => undefined);
    await sleep(400);
    await queuePass();

    fs.writeFileSync(path.join(shots, 'measurements.json'), JSON.stringify(measurements, null, 1));
    if (failures.length && !audit) throw Error(`Layout moved:\n${failures.join('\n')}`);
    console.log(`Layout consistency checks ${audit ? `recorded ${failures.length} findings` : 'passed'}: title bar, queue destinations, briefing, multi-selection, PR sections, Settings, narrow dark queue.`);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(shots, 'measurements.json'), JSON.stringify(measurements, null, 1));
    await capture('failure').catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
