/**
 * Overview (#390), the front page: a briefing sentence and four lane tiles (Answer, Review / Merge, Fix) with each
 * lane's count, summary and three oldest items, then "Waiting on others · Parked". Covers the briefing text, the 2×2
 * grid at 1280×800 and one column at 760, the quick action and details revealed on hover and focus, keyboard movement
 * within and between tiles, a tile opening the queue grouped by Action at its group, Merge and Rerun through their
 * confirmations, the item menu, live updates that keep focus, "new since your last visit", long names, and empty and
 * quiet days. Synthetic data only (tests/fixtures/overview.ts).
 *
 * Screenshots go to .impeccable/review/overview-frontpage/: the heavy load and a light day, light and dark, at
 * 1280×800 and 760 wide.
 */
import { loadWorkbenchPage } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';
const row = (lane: string, repo: string, n: number) => `${P} [data-overview-row="${lane}|https://github.com/${repo}/pull/${n}"]`;
const stackRow = (lane: string, repo: string, n: number) => `${P} [data-overview-row="${lane}|stack:https://github.com/${repo}/pull/${n}"]`;
const BRIEFING = 'lena and owen are waiting on your reply, and 7 reviews are waiting on you. 4 PRs are ready to merge, and 1 has failed checks.';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const dir = path.resolve('.impeccable/review/overview-frontpage');
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
  const resize = async (width: number) => {
    win.setSize(width, 800);
    await new Promise((r) => setTimeout(r, 400));
  };
  const cdp = win.webContents.debugger;
  const key = async (name: string, modifiers = 0) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const vk = name.length === 1 ? name.toUpperCase().charCodeAt(0) : ({ Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27, Tab: 9, Home: 36, End: 35, F10: 121 } as Record<string, number>)[name];
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...(name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 80));
  };
  const click = async (selector: string) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await new Promise((r) => setTimeout(r, 80));
  };
  const sidebar = (label: string) => `${P} [data-sidebar-destination][aria-label="${label}"]`;
  const tile = (lane: string) => `${P} #overview-lane-${lane}`;
  const tileCounts = () => js<string>(`[...document.querySelectorAll('${P} .overview-tile')].map(t=>t.dataset.lane+' '+t.querySelector('.overview-tile-count').textContent).join(' · ')`);
  const tileItems = (lane: string) => js<string[]>(`[...document.querySelectorAll('${tile(lane)} [data-overview-row]')].map(b=>b.dataset.overviewRow)`);
  const focusedRow = () => js<string | null>("document.activeElement?.getAttribute('data-overview-row') ?? null");
  const briefing = () => js<string>(`document.querySelector('${P} [data-overview-briefing]')?.textContent ?? ''`);
  const writes = () => js<{ kind: string; url: string }[]>('window.fixtureOverview.writes');
  const tabCount = () => js<number>('document.querySelectorAll(".workspace-tab").length');
  const activeSection = `document.querySelector('${P} [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent ?? ''`;
  const noSideways = () => js<boolean>(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth <= b.clientWidth + 1})()`);
  // Tile boxes, to check the grid: [lane, left, top].
  const boxes = () => js<[string, number, number][]>(`[...document.querySelectorAll('${P} .overview-tile')].map(t=>{const r=t.getBoundingClientRect();return [t.dataset.lane, Math.round(r.left), Math.round(r.top)]})`);
  const firstTab = async () => {
    await js("document.querySelector('.workspace-tab-select').click()");
    await wait(`!!document.querySelector('${P} .overview') && getComputedStyle(document.querySelector('${P} .overview')).display !== 'none'`);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);

    step = 'default';
    // The Overview opens by default, as the current home destination.
    await wait(`!!document.querySelector('${P} .overview-tile [data-overview-row]')`, 600);
    assert.equal(await js(`document.querySelector('${sidebar('Overview')}')?.getAttribute('aria-current')`), 'page');
    assert.equal(await js(`document.querySelector('${P} .overview h1')?.textContent`), 'Overview');
    assert.equal(await js(`(()=>{const t=document.querySelector('${P} .queue-toolbar:not(.overview-toolbar)');return !t || t.getClientRects().length === 0})()`), true, 'the queue waits behind the Overview');

    step = 'briefing';
    // One plain sentence about people blocked on you, one about your own PRs. Built from the lanes, no model call.
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent === ${JSON.stringify(BRIEFING)}`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-briefing]').getAttribute('role')`), 'status');
    assert.ok(await js(`document.querySelector('${P} .queue-freshness')?.textContent.startsWith('Checked')`), 'cached data says when it was checked');

    step = 'tiles';
    // Four tiles in reading order: who is blocked on you, then your own PRs. Merge counts Ready rows only.
    assert.equal(await tileCounts(), 'answer 2 · review 7 · merge 4 · fix 2');
    const headings = await js<string[]>(`[...document.querySelectorAll('${P} section.overview-tile[aria-labelledby]')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).firstChild.textContent)`);
    assert.deepEqual(headings, ['Answer', 'Review', 'Merge', 'Fix'], 'tiles are labelled regions with headings');
    assert.equal(await js(`document.querySelector('${tile('fix')} h2').textContent`), 'Fix, 2, 2 merge conflicts');
    // The tab title counts the four action lanes only: 2 + 7 + 4 + 2.
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(15)'");
    // Summaries: the lane heading's words from the quieter pass.
    assert.equal(await js(`document.querySelector('${tile('merge')} .overview-tile-summary').textContent`), '2 parked');
    assert.equal(await js(`document.querySelector('${tile('fix')} .overview-tile-summary').textContent`), '2 merge conflicts');
    assert.equal(await js(`document.querySelector('${tile('answer')} .overview-tile-summary')`), null, 'no summary when there is nothing to add');
    // Top three, oldest first, each with its age.
    assert.equal((await tileItems('review')).length, 3);
    assert.deepEqual(await js(`[...document.querySelectorAll('${tile('review')} .overview-tile-title')].map(t=>t.textContent)`), ['Stream build logs to the dashboard', 'Add a dry-run flag to the release script', 'Batch telemetry writes per request']);
    assert.deepEqual(await js(`[...document.querySelectorAll('${tile('review')} .overview-tile-age')].map(t=>t.textContent)`), ['5 d', '4 d', '3 d']);
    assert.equal(await js(`document.querySelector('${tile('review')} .overview-tile-all').textContent`), 'All 7');
    // Waiting on others and Parked are one slim line under the grid.
    assert.equal(await js(`document.querySelector('${P} .overview-others').textContent`), 'Waiting on others 3·Parked 2');
    // The inbox structure is gone: no count strip, no banded lanes, no "Show all" rows, no chips on items.
    assert.equal(await js(`document.querySelectorAll('${P} .overview-counts, ${P} .overview-lane, ${P} .overview-show-all, ${P} .overview-row').length`), 0);
    assert.equal(await js(`document.querySelectorAll('${P} .overview-tile .entity-badge, ${P} .overview-tile .github-author').length`), 0, 'metadata stays off the page');

    step = 'grid-1280';
    // 2×2 at 1280×800: Answer beside Review, Merge beside Fix, and nothing scrolls sideways.
    {
      const b = Object.fromEntries((await boxes()).map(([lane, left, top]) => [lane, { left, top }]));
      assert.equal(b.answer.top, b.review.top);
      assert.equal(b.merge.top, b.fix.top);
      assert.ok(b.review.left > b.answer.left && b.merge.left === b.answer.left && b.fix.left === b.review.left, JSON.stringify(b));
      assert.ok(b.merge.top > b.answer.top);
      assert.ok(await noSideways());
    }
    await both('default-1280');

    step = 'details';
    // Repository, PR and reason are in each item's description, its tooltip, and on hover or focus at the tile's foot.
    const description = (selector: string) => js<string | null>(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});const d=b&&document.getElementById(b.getAttribute('aria-describedby'));return d&&b.closest('li').contains(d)?d.textContent:null})()`);
    assert.equal(await description(row('answer', 'acme/web', 311)), 'Changes requested, web #311, from lena, waiting 4 days, stale');
    assert.equal(await description(row('fix', 'acme/web', 333)), 'Merge conflicts, web #333, waiting 9 hours');
    assert.equal(await js(`document.querySelector('${row('merge', 'klang/engine', 301)}').title`), 'Cache resolved module paths between builds\nengine #301 · Approved by lena · Stale');
    const actionsOpacity = (selector: string) => js<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}).closest('li').querySelector('.overview-tile-actions')).opacity`);
    assert.equal(await actionsOpacity(row('answer', 'acme/web', 311)), '0', 'no per-item buttons at rest');
    assert.equal(await js(`document.querySelector('${tile('answer')} [data-overview-detail]').textContent`), '');
    await js(`document.querySelector('${row('answer', 'acme/web', 311)}').focus()`);
    await wait(`getComputedStyle(document.querySelector('${row('answer', 'acme/web', 311)}').closest('li').querySelector('.overview-tile-actions')).opacity === '1'`);
    assert.equal(await js(`document.querySelector('${tile('answer')} [data-overview-detail]').textContent`), 'web #311 · Changes requested · from lena · Stale');
    assert.equal(await js(`document.querySelector('${row('answer', 'acme/web', 311)}').closest('li').querySelector('[data-quick-action]').textContent`), 'Open thread');
    assert.equal(await actionsOpacity(row('answer', 'klang/engine', 312)), '0', 'only the focused item shows its action');
    assert.equal(await js(`getComputedStyle(document.querySelector('${row('answer', 'acme/web', 311)}').closest('li')).outlineStyle`), 'solid', 'focus is visible');
    await both('focus-quick-action');
    // Hover reveals the same, with the pointer.
    if (!cdp.isAttached()) cdp.attach('1.3');
    const point = await js<{ x: number; y: number }>(`(()=>{const r=document.querySelector('${stackRow('merge', 'acme/web', 306)}').getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2}})()`);
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await wait(`getComputedStyle(document.querySelector('${stackRow('merge', 'acme/web', 306)}').closest('li').querySelector('.overview-tile-actions')).opacity === '1'`);
    assert.equal(await js(`document.querySelector('${stackRow('merge', 'acme/web', 306)}').closest('li').querySelector('[data-quick-action]').textContent`), 'Merge');
    assert.match(await js<string>(`document.querySelector('${tile('merge')} [data-overview-detail]').textContent`), /^web #\d+( \+\d)? · \d+ of \d+ PRs · Approved by ivar/);
    await capture('hover-quick-action-light');
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 790 });

    step = 'harden';
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} [aria-describedby="overview-keyboard-help"]')].map(e=>e.className)`), ['overview']);
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-row][tabindex="0"]').length`), 4, 'one roving tab stop per tile');
    assert.equal(await js(`[...document.querySelectorAll('${P} .overview-tile-actions button')].every(b=>b.tabIndex===-1)`), true, 'actions and menus are out of the tab order');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').textContent`), '');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').getAttribute('aria-live')`), 'polite');

    step = 'renders';
    // A sync tick that changes nothing renders no item.
    await js('window.__countRenders = true; window.__overviewRowRenders = 0; window.dispatchEvent(new Event("fixture-workbench-change"))');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await js('window.__overviewRowRenders'), 0, 'unchanged items do not render again');
    await js('window.__countRenders = false');

    step = 'keyboard';
    // j/k and the arrows move within a tile; Tab moves to the tile's "All N", then to the next tile.
    await js('document.activeElement?.blur()');
    const answer = await tileItems('answer');
    const review = await tileItems('review');
    await key('j');
    assert.equal(await focusedRow(), answer[0]);
    await key('j');
    assert.equal(await focusedRow(), answer[1]);
    await key('j');
    assert.equal(await focusedRow(), answer[1], 'j stays within the tile');
    await key('k');
    assert.equal(await focusedRow(), answer[0]);
    await key('End');
    assert.equal(await focusedRow(), answer[1]);
    await key('Tab');
    assert.equal(await js('document.activeElement?.className'), 'overview-tile-all');
    await key('Tab');
    assert.equal(await focusedRow(), review[0], 'Tab reaches the next tile');
    await key('ArrowDown');
    await key('ArrowDown');
    assert.equal(await focusedRow(), review[2]);
    await key('Tab', 8);
    await key('Tab', 8);
    assert.equal(await focusedRow(), answer[1], 'Shift+Tab returns to the tile’s last focused item');
    await both('keyboard-focus');

    step = 'heavy';
    // The real load from the critique: sixteen mergeable PRs (twelve parked) and eighteen to fix.
    await js('window.fixtureOverview.heavy()');
    await wait(`document.querySelector('${tile('fix')} .overview-tile-count')?.textContent === '18'`);
    assert.equal(await tileCounts(), 'answer 2 · review 7 · merge 4 · fix 18', 'parked merges never reach a count');
    assert.equal(await briefing(), 'lena and owen are waiting on your reply, and 7 reviews are waiting on you. 4 PRs are ready to merge, and 15 have failed checks.');
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(31)'");
    assert.equal(await js(`document.querySelector('${tile('fix')} .overview-tile-summary').textContent`), '15 checks failed · 15 over a week');
    assert.equal(await js(`document.querySelector('${tile('merge')} .overview-tile-summary').textContent`), '12 parked');
    assert.equal(await js(`document.querySelector('${P} .overview-others').textContent`), 'Waiting on others 5·Parked 12');
    assert.equal((await tileItems('fix')).length, 3);
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await both('heavy-1280');
    await resize(760);
    {
      // One column when narrow, in reading order, with nothing scrolling sideways.
      const b = await boxes();
      assert.deepEqual(b.map(([lane]) => lane), ['answer', 'review', 'merge', 'fix']);
      assert.ok(b.every(([, left]) => left === b[0][1]), `one column: ${JSON.stringify(b)}`);
      assert.ok(b.every(([, , top], i) => i === 0 || top > b[i - 1][2]));
      assert.ok(await noSideways(), 'no sideways scrolling at 760');
    }
    await both('heavy-760');
    await js(`(()=>{const b=document.querySelector('${P} .overview-body');b.scrollTop=b.scrollHeight})()`);
    await both('heavy-760-end');
    await js(`document.querySelector('${P} .overview-body').scrollTop = 0`);
    await resize(1280);
    await js('window.fixtureOverview.restore()');
    await wait(`document.querySelector('${tile('fix')} .overview-tile-count')?.textContent === '2'`);
    // The burst settles into one announcement before the next change.
    await wait(`document.querySelector('${P} [data-overview-announcement]').textContent.includes('Fix 2, was 18.')`);

    step = 'live-update';
    // Live updates change items in place: a renamed PR and a new failing PR, while focus stays on the item.
    await js(`document.querySelector('${row('review', 'klang/cli', 322)}').focus()`);
    const focused = await focusedRow();
    const scroll = await js<number>(`document.querySelector('${P} .overview-body').scrollTop`);
    await new Promise((r) => setTimeout(r, 200));
    await js("window.__countRenders = true; window.__overviewRowRenders = 0; window.__overviewRenderedRows = []; window.fixtureOverview.rename(322, 'Add a dry-run flag to every release script'); window.fixtureOverview.addFailing()");
    await wait(`document.querySelector('${row('review', 'klang/cli', 322)}')?.textContent.includes('every release script') && document.querySelector('${tile('fix')} .overview-tile-count').textContent === '3'`);
    assert.equal(await focusedRow(), focused, 'focus stays on the item that changed');
    assert.equal(await js<number>(`document.querySelector('${P} .overview-body').scrollTop`), scroll, 'nothing scrolls');
    // The renamed item, the new one, and Fix items whose words changed with the lane's new majority reason. Nothing in
    // the tiles that did not change.
    const rendered = await js<string[]>('window.__overviewRenderedRows');
    assert.ok(rendered.every((id) => id.startsWith('fix|') || id === `review|${focused?.split('|')[1]}`), `only changed items render: ${rendered.join(', ')}`);
    await js('window.__countRenders = false');
    await wait(`document.querySelector('${P} [data-overview-announcement]').textContent === 'Fix 3, was 2.'`);
    assert.match(await briefing(), /and 2 have failed checks\.$/);

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
    await wait(`document.querySelector('${tile('merge')} .overview-tile-count').textContent === '3'`);

    step = 'rerun';
    // Rerun failed goes through the existing rerun confirmation.
    await js(`document.querySelector('${stackRow('fix', 'klang/engine', 331)}').closest('li').querySelector('[data-quick-action]').click()`);
    await wait("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('Re-run failed and cancelled checks') && d.textContent.includes('test (linux)'))");
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Re-run workflows').click()");
    await wait('window.fixtureOverview.reruns.length === 1');
    assert.equal(await js('window.fixtureOverview.reruns[0].mode'), 'failed');
    await js("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='Done').click()");
    await wait("!document.querySelector('[role=dialog]')");

    step = 'open-row';
    // An item opens where the notification for its reason opens: a new tab, or the tab already showing the PR.
    const tabs = await tabCount();
    await js(`document.querySelector('${stackRow('fix', 'klang/engine', 331)}').click()`);
    await wait(`${activeSection}.startsWith('Checks')`, 400);
    assert.equal(await tabCount(), tabs + 1);
    await firstTab();
    await js(`document.querySelector('${stackRow('fix', 'klang/engine', 331)}').click()`);
    await wait(`${activeSection}.startsWith('Checks')`, 400);
    assert.equal(await tabCount(), tabs + 1, 'the tab that shows the PR is reused');
    await firstTab();
    // Enter opens the focused item: changes requested land in Feedback.
    await js(`document.querySelector('${row('answer', 'acme/web', 311)}').focus()`);
    await key('Enter');
    await wait(`${activeSection}.startsWith('Feedback')`, 400);
    assert.equal(await tabCount(), tabs + 2);
    await firstTab();

    step = 'menu';
    // Mark as read, Snooze and copying live in the item menu; Shift+F10 opens it from the item.
    await menuAction(js, 'Actions for PR #312', 'Mark as read');
    await wait("window.fixtureOverview.writes.some(w=>w.kind==='mark-read' && w.url.endsWith('/312'))");
    await js("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { (window.__copied ??= []).push(text); } })");
    await menuAction(js, 'Actions for PR #312', 'Copy link');
    await wait('window.__copied?.length === 1');
    assert.deepEqual(await js('window.__copied'), ['https://github.com/klang/engine/pull/312']);
    await js(`document.querySelectorAll('.app-toast [aria-label="Dismiss notification"]').forEach(b=>b.click())`);
    await js(`document.querySelector('${row('answer', 'klang/engine', 312)}').focus()`);
    await key('F10', 8);
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent==='Snooze PR…')");
    await key('Escape');
    await wait("!document.querySelector('[role=menuitem]')");
    // Z snoozes the focused item; focus moves to the next one in its tile.
    await js(`document.querySelector('${row('merge', 'acme/web', 303)}').focus()`);
    await key('z');
    await wait("!!document.querySelector('.snooze-picker .snooze-option')");
    await js("document.querySelector('.snooze-picker .snooze-option').click()");
    await wait(`!document.querySelector('${row('merge', 'acme/web', 303)}')`);
    await wait(`document.querySelector('${tile('merge')} .overview-tile-count').textContent === '2'`);

    step = 'open-lane';
    // A tile's "All N" opens the whole queue grouped by Action, scrolled to that group, with its heading focused.
    let started = Date.now();
    await js(`document.querySelector('${tile('review')} .overview-tile-all').click()`);
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display === 'none' && document.activeElement?.closest('[data-queue-group]')?.dataset.queueGroup === 'action:review'`);
    const toQueue = Date.now() - started;
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} .queue-group-label')].map(e=>e.textContent)`), ['Answer', 'Review', 'Merge', 'Fix', 'Waiting on others', 'Parked']);
    assert.equal(await js(`document.querySelector('${P} [data-queue-group="action:review"] .queue-group-count').textContent`), '7');
    assert.equal(await js(`document.querySelector('${P} [data-queue-group-by]').dataset.queueGroupBy`), 'action');
    assert.equal(await js(`document.querySelectorAll('${P} .queue-filter-chip').length`), 0, 'the whole queue, not a lane filter');
    assert.ok(await js(`(()=>{const h=document.querySelector('${P} [data-queue-group="action:review"]').getBoundingClientRect();const l=document.querySelector('${P} .queue-list').getBoundingClientRect();return Math.abs(h.top-l.top)<4})()`), 'the group is at the top');
    await capture('open-lane-review-light');
    started = Date.now();
    await click(sidebar('Overview'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display !== 'none' && !!document.querySelector('${P} [data-overview-row]')`);
    const toOverview = Date.now() - started;
    console.log(`Home tab switch: queue ${toQueue} ms, Overview ${toOverview} ms`);
    assert.ok(toQueue < 2000 && toOverview < 2000, `home tab switches stay quick (${toQueue} ms, ${toOverview} ms)`);
    // Clicking the tile itself, on its count, opens it too; so does "Waiting on others" under the grid.
    await js(`document.querySelector('${tile('fix')} .overview-tile-count').click()`);
    await wait(`document.activeElement?.closest('[data-queue-group]')?.dataset.queueGroup === 'action:fix'`);
    await click(sidebar('Overview'));
    await js(`document.querySelector('${P} .overview-others-link[data-group="waiting"]').click()`);
    await wait(`document.activeElement?.closest('[data-queue-group]')?.dataset.queueGroup === 'action:waiting'`);
    // A lane link still opens the filtered queue.
    await click(sidebar('Overview'));
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify({ source: 'notification', target: { kind: 'queue', filters: { lane: 'answer' } } })}}))`);
    await wait(`[...document.querySelectorAll('${P} .queue-filter-chip')].some(c=>c.textContent==='Overview: Answer') && document.querySelectorAll('${P} .queue-item').length === 2`);
    assert.equal(await js("localStorage.getItem('gnosis-home-tab:v1')"), 'overview', 'following a link is not a choice of home tab');

    step = 'new';
    // Leaving the Overview saves the visit. A PR that appears meanwhile is new when you come back; the rest are not.
    await click(sidebar('Review queue'));
    assert.equal(await js("localStorage.getItem('gnosis-home-tab:v1')"), 'queue', 'the chosen home tab is remembered');
    // A PR failing for two days, so it is among Fix's three oldest.
    await js("window.fixtureOverview.addFailing(335, 'Sign release artifacts', 'klang/cli', 2 * 86400000)");
    await click(sidebar('Overview'));
    await wait(`!!document.querySelector('${row('fix', 'klang/cli', 335)}')?.closest('.overview-tile-item.is-new')`);
    assert.equal(await js(`document.querySelectorAll('${P} .overview-tile-item.is-new').length`), 1, 'only the new PR is new');
    assert.equal(await js(`document.querySelector('${P} .overview-tile-item.is-new .pr-unread-dot')?.getAttribute('aria-label')`), 'New since your last visit');
    await both('new-marker');

    step = 'long-names';
    // A very long title truncates, with the full text on hover, and nothing scrolls sideways.
    const longTitle = 'Rework the release pipeline so every artifact is signed, verified against the manifest, and uploaded once per platform with retries';
    await js(`window.fixtureOverview.rename(321, ${JSON.stringify(longTitle)})`);
    await wait(`document.querySelector('${row('review', 'klang/engine', 321)}')?.textContent === ${JSON.stringify(longTitle)}`);
    assert.ok((await js<string>(`document.querySelector('${row('review', 'klang/engine', 321)}').title`)).startsWith(longTitle));
    assert.equal(await js(`(()=>{const t=document.querySelector('${row('review', 'klang/engine', 321)}');return t.scrollWidth>t.clientWidth})()`), true, 'the title truncates');
    assert.ok(await noSideways(), 'no sideways scrolling with long names');
    await resize(760);
    assert.ok(await noSideways(), 'no sideways scrolling when narrow');
    await resize(1280);

    step = 'light-day';
    // A light day: one reply, two reviews, one merge.
    await js("window.fixtureOverview.rename(321, 'Stream build logs to the dashboard'); window.fixtureOverview.only([311, 321, 323, 302])");
    await wait(`document.querySelectorAll('${P} [data-overview-row]').length === 4`);
    assert.equal(await briefing(), 'lena is waiting on your reply, and 2 reviews are waiting on you. 1 PR is ready to merge.');
    // An empty tile keeps its place: a 0 and one line.
    assert.equal(await tileCounts(), 'answer 1 · review 2 · merge 1 · fix 0');
    assert.equal(await js(`document.querySelector('${tile('fix')} .overview-tile-summary').textContent`), 'Nothing to fix');
    assert.equal(await js(`document.querySelector('${tile('fix')} .overview-tile-all')`), null);
    await js(`document.querySelectorAll('.app-toast [aria-label="Dismiss notification"]').forEach(b=>b.click())`);
    await new Promise((r) => setTimeout(r, 400));
    await both('light-day-1280');
    await resize(760);
    await both('light-day-760');
    await resize(1280);

    step = 'all-clear';
    await js('window.fixtureOverview.only([341])');
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent.startsWith('Nothing needs you')`);
    assert.equal(await briefing(), 'Nothing needs you right now. 1 of your PRs is waiting on others.');
    assert.equal(await tileCounts(), 'answer 0 · review 0 · merge 0 · fix 0', 'the grid stays');
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} .overview-tile-summary')].map(e=>e.textContent)`), ['Nothing to answer', 'Nothing to review', 'Nothing to merge', 'Nothing to fix']);
    // No work, no count: Waiting on others is not counted in the tab title.
    await wait("!document.querySelector('.workspace-tab .workspace-tab-count')");
    assert.equal(await js("document.querySelector('.workspace-tab-select').getAttribute('title').split('\\n')[0]"), 'Overview');
    await both('all-clear-1280');
    await resize(760);
    await both('all-clear-760');
    await resize(1280);

    step = 'status-arrives';
    // GitHub has not answered yet: no saved status, and status reads wait. The Overview asks for every lane candidate
    // itself and says it is checking; lanes that need status fill as the answers arrive, and focus stays put.
    // A fresh session: the snoozes and mutes made above are forgotten.
    await js('sessionStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview&overview-status=held`);
    await wait(`!!document.querySelector('${P} [data-overview-checking]')`, 600);
    const checkingIs = (minus = 0) => `document.querySelector('${P} [data-overview-checking]')?.textContent === 'Checking ' + (window.fixtureOverview.requested().length - ${minus}) + '…'`;
    // Every lane candidate is requested: your own PRs and the review requests.
    const own = [301, 302, 303, 304, 305, 306, 307, 311, 312, 331, 332, 333, 341, 342];
    const expected = [...own, ...Array.from({ length: 7 }, (_, i) => 321 + i)].map((n) => `/pull/${n}`);
    await wait(`(()=>{const r=window.fixtureOverview.requested();return ${JSON.stringify(expected)}.every(n=>r.some(u=>u.endsWith(n)))})()`);
    await wait(checkingIs());
    assert.equal(await js(`document.querySelector('${P} [data-overview-unchecked]')`), null, 'checking, not "not checked"');
    // Review requests and replies need no status; your own PRs wait for it.
    assert.equal(await tileCounts(), 'answer 1 · review 7 · merge 0 · fix 0');
    {
      const requested = new Set(await js<string[]>('window.fixtureOverview.requested()'));
      const lanes = (await js<string[]>(`[...document.querySelectorAll('${P} [data-overview-row]')].map(b=>b.dataset.overviewRow.split('|').pop())`)).filter((url) => !url.startsWith('stack:'));
      for (const url of lanes) assert.ok(requested.has(url), `${url} is requested`);
    }
    // The user's shape: many more of your PRs arrive before GitHub answers.
    await js('window.fixtureOverview.heavy()');
    // 21 + 28 PRs: the reads go out in 25-PR batches, one batch after another, so some are not sent yet.
    const checkingCount = `Number(document.querySelector('${P} [data-overview-checking]')?.textContent.match(/\\d+/)?.[0] ?? 0)`;
    await wait(`${checkingCount} === 49`);
    await js(`document.querySelector('${row('review', 'klang/engine', 321)}').focus()`);
    assert.equal(await focusedRow(), 'review|https://github.com/klang/engine/pull/321');
    await capture('status-checking-light');
    // The first batch answers: the first PRs join their lanes, the rest are still checking.
    await js('window.fixtureOverview.answerStatus(1)');
    await wait(`${checkingCount} > 0 && ${checkingCount} < 49`);
    await wait(`Number(document.querySelector('${tile('merge')} .overview-tile-count')?.textContent) > 0`);
    assert.equal(await focusedRow(), 'review|https://github.com/klang/engine/pull/321', 'focus stays on the focused item');
    // GitHub answers the rest: no checking, nothing unchecked, and Fix holds the failing PRs.
    await js('window.fixtureOverview.answerStatus()');
    await wait(`!document.querySelector('${P} [data-overview-checking]')`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-unchecked]')`), null);
    await wait(`Number(document.querySelector('${tile('fix')} .overview-tile-count')?.textContent) > 10`);
    assert.equal(await focusedRow(), 'review|https://github.com/klang/engine/pull/321', 'focus stays on the focused item');
    await capture('status-filled-light');

    step = 'stale-sync';
    // The last sync is two hours old: the Overview asks main for one, and says so while it runs.
    const before = (await js<boolean[]>('window.fixtureOverview.discoveries')).length;
    await js('window.fixtureOverview.setSync(2 * 3600000)');
    await wait(`window.fixtureOverview.discoveries.length > ${before}`);
    assert.equal(await js(`window.fixtureOverview.discoveries.at(-1)`), false, 'a sync, not a forced refresh');
    await js("window.fixtureOverview.setSync(2 * 3600000, 'checking')");
    await wait(`document.querySelector('${P} [data-overview-syncing]')?.textContent === 'Updating…'`);
    await js('window.fixtureOverview.setSync(60000)');
    await wait(`document.querySelector('${P} .queue-freshness')?.textContent.startsWith('Checked')`);

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
