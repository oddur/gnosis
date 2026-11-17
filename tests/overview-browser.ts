/**
 * Overview (#390): the default home tab, its counts and lanes, top five and "Show all" into the filtered queue,
 * empty and all-clear states, rows that land in the right tab, Merge through its confirmation, Rerun failed, the row
 * menu, keyboard movement with visible focus, live updates that keep focus, "new since your last visit", and light
 * and dark at 1280×800 and a narrow window. Synthetic data only (tests/fixtures/overview.ts).
 * Screenshots go to .impeccable/review/overview/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';
const row = (lane: string, repo: string, n: number) => `${P} [data-overview-row="${lane}|https://github.com/${repo}/pull/${n}"]`;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const dir = path.resolve('.impeccable/review/overview');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const wait = async (code: string, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    await capture(`failure-${step}`).catch(() => undefined);
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 1500)`)}`);
  };
  const both = async (name: string) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const cdp = win.webContents.debugger;
  const key = async (name: string, code = name.length === 1 ? `Key${name.toUpperCase()}` : name) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const vk = name.length === 1 ? name.toUpperCase().charCodeAt(0) : ({ Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27, Tab: 9 } as Record<string, number>)[name];
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, ...(name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 80));
  };
  const click = async (selector: string) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await new Promise((r) => setTimeout(r, 80));
  };
  const sidebar = (label: string) => `${P} [data-sidebar-destination][aria-label="${label}"]`;
  const counts = () => js<string>(`[...document.querySelectorAll('${P} .overview-count')].map(b=>b.textContent).join(' · ')`);
  const laneRows = (lane: string) => js<number>(`document.querySelectorAll('${P} #overview-lane-${lane} .overview-row').length`);
  const focusedRow = () => js<string | null>("document.activeElement?.getAttribute('data-overview-row') ?? null");
  const writes = () => js<{ kind: string; url: string }[]>('window.fixtureOverview.writes');
  const tabCount = () => js<number>('document.querySelectorAll(".workspace-tab").length');
  const activeSection = `document.querySelector('${P} [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent ?? ''`;
  const firstTab = async () => {
    await js("document.querySelector('.workspace-tab-select').click()");
    await wait(`!!document.querySelector('${P} .overview') && getComputedStyle(document.querySelector('${P} .overview')).display !== 'none'`);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);

    step = 'default';
    // The Overview opens by default, as the current home destination.
    await wait(`!!document.querySelector('${P} .overview-row')`, 600);
    assert.equal(await js(`document.querySelector('${sidebar('Overview')}')?.getAttribute('aria-current')`), 'page');
    assert.equal(await js(`document.querySelector('${P} .overview h1')?.textContent`), 'Overview');
    // Before the queue's first commit there is no toolbar yet; after it, the toolbar is hidden.
    assert.equal(await js(`(()=>{const t=document.querySelector('${P} .queue-toolbar:not(.overview-toolbar)');return !t || t.getClientRects().length === 0})()`), true, 'the queue waits behind the Overview');

    step = 'counts';
    await wait(`[...document.querySelectorAll('${P} .overview-count')].map(b=>b.textContent).join(' · ') === 'Merge2 · Answer2 · Review7 · Fix2 · Waiting2'`);
    assert.equal(await counts(), 'Merge2 · Answer2 · Review7 · Fix2 · Waiting2');
    // The tab title counts the four action lanes only: 2 + 2 + 7 + 2, without Waiting.
    const actions = await js<number>(`['merge','answer','review','fix'].reduce((n,l)=>n+Number(document.querySelector('${P} .overview-count[data-lane='+l+'] .overview-count-value').textContent),0)`);
    assert.equal(actions, 13);
    await wait(`document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(${actions})'`);
    assert.ok(await js(`document.querySelector('${P} .overview-freshness, ${P} .queue-freshness time')?.textContent.startsWith('Checked')`), 'cached data says when it was checked');
    // Lane headings are landmarks, in a fixed order, and Waiting starts collapsed.
    const lanes = await js<string[]>(`[...document.querySelectorAll('${P} section.overview-lane[aria-labelledby]')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).textContent)`);
    assert.deepEqual(lanes, ['Merge', 'Answer', 'Review', 'Fix', 'Waiting on others']);
    assert.equal(await js(`document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').getAttribute('aria-expanded')`), 'false');
    assert.equal(await laneRows('waiting'), 0);

    step = 'top-five';
    assert.equal(await laneRows('review'), 5);
    assert.equal(await js(`document.querySelector('${P} #overview-lane-review .overview-show-all')?.textContent`), 'Show all 7');
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-show-all')`), null);
    // Oldest first, with waiting time and the stale label in words.
    const review = await js<string[]>(`[...document.querySelectorAll('${P} #overview-lane-review .overview-title')].map(t=>t.textContent)`);
    assert.equal(review[0], 'Stream build logs to the dashboard');
    assert.match(await js<string>(`document.querySelector('${P} #overview-lane-answer .overview-wait')?.textContent`), /^4 dStale$/);
    assert.ok(await js(`document.querySelector('${P} #overview-lane-review .overview-row')?.textContent.includes('Explanation ready')`), 'review rows mark a ready explanation');
    assert.ok(await js(`document.querySelector('${P} #overview-lane-fix .overview-row')?.textContent.includes('2 of 2 PRs') || document.querySelector('${P} #overview-lane-fix .overview-row')?.textContent.includes('2 PRs')`), 'a stack is one row with its member count');
    assert.equal(await js(`document.querySelectorAll('${P} .overview-row.is-new').length`), 0, 'the first visit marks nothing new');
    await both('default-1280');

    step = 'renders';
    // A sync tick that changes nothing renders no row.
    await js('window.__countRenders = true; window.__overviewRowRenders = 0; window.dispatchEvent(new Event("fixture-workbench-change"))');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await js('window.__overviewRowRenders'), 0, 'unchanged rows do not render again');

    step = 'keyboard';
    await js('document.activeElement?.blur()');
    await key('j');
    assert.equal(await focusedRow(), 'merge|https://github.com/klang/engine/pull/301');
    assert.equal(await js("getComputedStyle(document.activeElement).outlineStyle"), 'solid', 'focus is visible');
    await key('j');
    assert.equal(await focusedRow(), 'merge|https://github.com/klang/cli/pull/302');
    await key('k');
    assert.equal(await focusedRow(), 'merge|https://github.com/klang/engine/pull/301');
    await key('ArrowDown');
    await key('ArrowDown');
    assert.equal(await focusedRow(), 'answer|https://github.com/acme/web/pull/311');
    await both('keyboard-focus');

    step = 'live-update';
    // Live updates change rows in place: a renamed PR and a new failing PR, while focus stays on the row.
    await js(`document.querySelector('${row('review', 'klang/cli', 322)}').focus()`);
    await key('j');
    await key('k');
    const focused = await focusedRow();
    assert.equal(focused, 'review|https://github.com/klang/cli/pull/322');
    const scroll = await js<number>(`document.querySelector('${P} .overview-body').scrollTop`);
    await js("window.__overviewRowRenders = 0; window.fixtureOverview.rename(322, 'Add a dry-run flag to every release script'); window.fixtureOverview.addFailing()");
    await wait(`document.querySelector('${row('review', 'klang/cli', 322)}')?.textContent.includes('every release script') && !!document.querySelector('${row('fix', 'klang/cli', 334)}')`);
    assert.equal(await focusedRow(), focused, 'focus stays on the row that changed');
    assert.equal(await js<number>(`document.querySelector('${P} .overview-body').scrollTop`), scroll, 'nothing scrolls');
    assert.ok((await js<number>('window.__overviewRowRenders')) <= 3, 'only the changed and new rows render');
    assert.match(await counts(), /Fix3/);

    step = 'merge';
    // Merge goes through the existing confirmation: nothing is written until it is confirmed.
    await js(`document.querySelector('${row('merge', 'klang/engine', 301)}').focus()`);
    await key('a');
    await wait("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('Merge pull request') && d.textContent.includes('Merge method'))");
    assert.deepEqual(await writes(), [], 'opening the confirmation writes nothing');
    await both('merge-confirmation');
    await js("(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(d=>d.textContent.includes('Merge pull request'));const b=[...d.querySelectorAll('button')].filter(b=>b.textContent==='Merge pull request').at(-1);b.click()})()");
    await wait("window.fixtureOverview.writes.some(w=>w.kind==='merge')");
    assert.deepEqual((await writes()).filter((w) => w.kind === 'merge'), [{ kind: 'merge', url: 'https://github.com/klang/engine/pull/301' }]);
    await wait(`!document.querySelector('${row('merge', 'klang/engine', 301)}')`);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Merged #301 on GitHub.'))`);
    assert.match(await counts(), /^Merge1/);

    step = 'rerun';
    // Rerun failed goes through the existing rerun confirmation.
    await js(`document.querySelector('${P} #overview-lane-fix .overview-row [data-quick-action]').click()`);
    await wait("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('Re-run failed and cancelled checks') && d.textContent.includes('test (linux)'))");
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Re-run workflows').click()");
    await wait('window.fixtureOverview.reruns.length === 1');
    assert.equal(await js('window.fixtureOverview.reruns[0].mode'), 'failed');
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Done').click()");
    await wait("!document.querySelector('[role=dialog]')");

    step = 'open-row';
    // A row opens where the notification for its reason opens: a new tab, or the tab already showing the PR.
    const tabs = await tabCount();
    await js(`document.querySelector('${P} #overview-lane-fix .overview-row-main').click()`);
    await wait(`${activeSection}.startsWith('Checks')`, 400);
    assert.equal(await tabCount(), tabs + 1);
    await firstTab();
    await js(`document.querySelector('${P} #overview-lane-fix .overview-row-main').click()`);
    await wait(`${activeSection}.startsWith('Checks')`, 400);
    assert.equal(await tabCount(), tabs + 1, 'the tab that shows the PR is reused');
    await firstTab();
    // Enter opens the focused row: changes requested land in Feedback.
    await js(`document.querySelector('${row('answer', 'acme/web', 311)}').focus()`);
    await key('Enter');
    await wait(`${activeSection}.startsWith('Feedback')`, 400);
    assert.equal(await tabCount(), tabs + 2);
    await firstTab();

    step = 'menu';
    // Mark as read and Snooze live in the row menu.
    await menuAction(js, 'Actions for PR #312', 'Mark as read');
    await wait("window.fixtureOverview.writes.some(w=>w.kind==='mark-read' && w.url.endsWith('/312'))");
    await menuAction(js, 'Actions for PR #302', 'Snooze PR…');
    await wait("!!document.querySelector('.snooze-picker .snooze-option')");
    await js("document.querySelector('.snooze-picker .snooze-option').click()");
    await wait(`!document.querySelector('${row('merge', 'klang/cli', 302)}') && !!document.querySelector('${P} #overview-lane-merge .overview-empty')`);
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-empty')?.textContent`), 'Nothing to merge', 'an empty lane collapses to one line');

    step = 'show-all';
    // "Show all" opens the queue filtered to the lane; the switch is quick.
    let started = Date.now();
    await js(`document.querySelector('${P} #overview-lane-review .overview-show-all').click()`);
    await wait(`document.querySelectorAll('${P} .queue-item').length === 7 && getComputedStyle(document.querySelector('${P} .overview')).display === 'none'`);
    const toQueue = Date.now() - started;
    assert.ok(await js(`[...document.querySelectorAll('${P} .queue-filter-chip')].some(c=>c.textContent==='Overview: Review')`), 'the lane is a removable queue filter');
    await capture('show-all-review-light');
    started = Date.now();
    await click(sidebar('Overview'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display !== 'none' && !!document.querySelector('${P} .overview-row')`);
    const toOverview = Date.now() - started;
    console.log(`Home tab switch: queue ${toQueue} ms, Overview ${toOverview} ms`);
    assert.ok(toQueue < 2000 && toOverview < 2000, `home tab switches stay quick (${toQueue} ms, ${toOverview} ms)`);
    // The lane total opens the same filtered queue.
    await js(`document.querySelector('${P} #overview-lane-fix .overview-lane-total').click()`);
    await wait(`document.querySelectorAll('${P} .queue-item').length === 3 && [...document.querySelectorAll('${P} .queue-filter-chip')].some(c=>c.textContent==='Overview: Fix')`);
    // A lane link opens the filtered queue too.
    await click(sidebar('Overview'));
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify({ source: 'notification', target: { kind: 'queue', filters: { lane: 'answer' } } })}}))`);
    await wait(`[...document.querySelectorAll('${P} .queue-filter-chip')].some(c=>c.textContent==='Overview: Answer') && document.querySelectorAll('${P} .queue-item').length === 2`);
    assert.equal(await js("localStorage.getItem('gnosis-home-tab:v1')"), 'overview', 'following a link is not a choice of home tab');

    step = 'new';
    // Leaving the Overview saves the visit. A PR that appears meanwhile is new when you come back; the rest are not.
    await click(sidebar('Review queue'));
    assert.equal(await js("localStorage.getItem('gnosis-home-tab:v1')"), 'queue', 'the chosen home tab is remembered');
    await js("window.fixtureOverview.addFailing(335, 'Sign release artifacts')");
    await click(sidebar('Overview'));
    assert.equal(await js("localStorage.getItem('gnosis-home-tab:v1')"), 'overview');
    await wait(`!!document.querySelector('${row('fix', 'klang/cli', 335)}')?.closest('.overview-row.is-new')`);
    assert.equal(await js(`!!document.querySelector('${row('fix', 'klang/cli', 334)}')?.closest('.overview-row.is-new')`), false);
    assert.equal(await js(`document.querySelectorAll('${P} .overview-row.is-new').length`), 1);
    assert.equal(await js(`document.querySelector('${P} .overview-row.is-new .pr-unread-dot')?.getAttribute('aria-label')`), 'New since your last visit');
    await js(`document.querySelectorAll('.app-toast [aria-label="Dismiss notification"]').forEach(b=>b.click()); (()=>{const b=document.querySelector('${P} .overview-body');const r=document.querySelector('${P} .overview-row.is-new');b.scrollTop+=r.getBoundingClientRect().top-b.getBoundingClientRect().top-200})()`);
    await both('new-marker');

    step = 'jump';
    // A count jumps to its lane; Waiting opens.
    await js(`document.querySelector('${P} .overview-count[data-lane=waiting]').click()`);
    await wait(`document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').getAttribute('aria-expanded') === 'true'`);
    await wait("document.activeElement?.classList.contains('overview-lane-toggle')");
    assert.equal(await laneRows('waiting'), 2);
    assert.equal(await js('document.scrollingElement.scrollTop + document.querySelector(".workbench-body")?.scrollTop'), 0, 'only the Overview list scrolls');
    await both('waiting-open');

    step = 'narrow';
    win.setSize(760, 800);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(await js(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth <= b.clientWidth + 1})()`), 'no sideways scrolling when narrow');
    await both('narrow-760');
    win.setSize(1280, 800);
    await new Promise((r) => setTimeout(r, 300));

    step = 'empty';
    await js('window.fixtureOverview.only([321])');
    await wait(`document.querySelectorAll('${P} .overview-row').length === 1`);
    assert.equal(await js(`[...document.querySelectorAll('${P} .overview-empty')].map(e=>e.textContent).join('|')`), 'Nothing to merge|Nothing to answer|Nothing to fix|Nothing waiting on others');
    await both('empty-lanes');

    step = 'all-clear';
    await js('window.fixtureOverview.only([341])');
    await wait(`!!document.querySelector('${P} .overview-clear')`);
    assert.equal(await js(`document.querySelector('${P} .overview-clear').textContent`), 'All clear. Nothing needs you right now.');
    assert.equal(await js(`document.querySelectorAll('${P} section.overview-lane').length`), 1, 'only Waiting remains');
    // No work, no count: Waiting on others is not counted in the tab title.
    await wait("!document.querySelector('.workspace-tab .workspace-tab-count')");
    assert.equal(await js("document.querySelector('.workspace-tab-select').getAttribute('title').split('\\n')[0]"), 'Overview');
    await both('all-clear');
    win.setSize(760, 800);
    await new Promise((r) => setTimeout(r, 300));
    await both('all-clear-narrow');
    win.setSize(1280, 800);

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
