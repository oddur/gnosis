/**
 * Overview (#390): the default home tab, its counts and lanes, top five and "Show all" into the filtered queue,
 * empty and all-clear states, rows that land in the right tab, Merge through its confirmation, Rerun failed, the row
 * menu, keyboard movement with visible focus, live updates that keep focus, "new since your last visit", and light
 * and dark at 1280×800 and a narrow window. Synthetic data only (tests/fixtures/overview.ts).
 * Screenshots go to .impeccable/review/overview/.
 *
 * Clarify pass: each Merge row says why it can merge (approved, no review required, open stack base, behind), the
 * viewer is never a row's person, Parked merges are a collapsed group that the strip and tab title leave out, and a
 * stale Waiting row asks "Nudge?". A heavy load (16 merges, 12 parked) is captured to .impeccable/review/overview-clarify/.
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
  const clarifyDir = path.resolve('.impeccable/review/overview-clarify');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(clarifyDir, { recursive: true });
  const capture = async (name: string, into = dir) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(into, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const wait = async (code: string, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    await capture(`failure-${step}`).catch(() => undefined);
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 1500)`)}`);
  };
  const both = async (name: string, into = dir) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`, into);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`, into);
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
    // Merge counts its four Ready rows; the two Parked ones are not work.
    await wait(`[...document.querySelectorAll('${P} .overview-count')].map(b=>b.textContent).join(' · ') === 'Merge4 · Answer2 · Review7 · Fix2 · Waiting3'`);
    assert.equal(await counts(), 'Merge4 · Answer2 · Review7 · Fix2 · Waiting3');
    // The tab title counts the four action lanes only: 4 + 2 + 7 + 2, without Waiting or Parked.
    const actions = await js<number>(`['merge','answer','review','fix'].reduce((n,l)=>n+Number(document.querySelector('${P} .overview-count[data-lane='+l+'] .overview-count-value').textContent),0)`);
    assert.equal(actions, 15);
    await wait(`document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(${actions})'`);
    assert.ok(await js(`document.querySelector('${P} .overview-freshness, ${P} .queue-freshness time')?.textContent.startsWith('Checked')`), 'cached data says when it was checked');
    // Lane headings are landmarks, in a fixed order, and Waiting starts collapsed.
    const lanes = await js<string[]>(`[...document.querySelectorAll('${P} section.overview-lane[aria-labelledby]')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).textContent)`);
    assert.deepEqual(lanes, ['Merge', 'Answer', 'Review', 'Fix', 'Waiting on others']);
    assert.equal(await js(`document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').getAttribute('aria-expanded')`), 'false');
    assert.equal(await laneRows('waiting'), 0);

    step = 'merge-reasons';
    // The lane heading keeps the whole lane honest: Ready, then Parked.
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-lane-total').textContent`), '4 · 2 parked');
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-lane-total').getAttribute('aria-label')`), 'Merge: 4 ready, 2 parked. Open all 6 in the review queue');
    // Each Ready row says why it can merge, in the reason slot.
    const notes = (selector: string) => js<string[]>(`[...(document.querySelector(${JSON.stringify(selector)})?.closest('.overview-row')?.querySelectorAll('[data-merge-note]') ?? [])].map(n=>n.textContent)`);
    assert.deepEqual(await notes(row('merge', 'klang/engine', 301)), ['Approved by lena']);
    assert.deepEqual(await notes(row('merge', 'klang/cli', 302)), ['Approved by sam and 1 other']);
    assert.deepEqual(await notes(row('merge', 'acme/web', 303)), ['No review required', 'Behind main by 2 commits']);
    const stackRow = await js<string>(`[...document.querySelectorAll('${P} #overview-lane-merge .overview-row')].find(r=>r.textContent.includes('#307'))?.querySelector('[data-overview-row]')?.getAttribute('data-overview-row') ?? ''`);
    assert.ok(stackRow, 'the stack has a Merge row');
    assert.deepEqual(await notes(`${P} [data-overview-row="${stackRow}"]`), ['Approved by ivar', 'Base #306 not merged']);
    // You are never the person on a row: no author chip reads "oddur", in any lane.
    await js(`document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').click()`);
    await wait(`document.querySelectorAll('${P} #overview-lane-waiting .overview-row').length === 3`);
    assert.equal(await js(`[...document.querySelectorAll('${P} .overview-row .github-author')].filter(a=>a.textContent.trim().toLowerCase()==='oddur').length`), 0);
    assert.equal(await js(`document.querySelectorAll('${P} #overview-lane-merge .overview-row .github-author').length`), 0, 'merge notes name the approver instead');
    assert.ok(await js(`document.querySelector('${row('review', 'klang/engine', 321)}')?.closest('.overview-row')?.querySelector('.github-author')?.textContent.includes('maya')`), 'other people stay');
    // A stale Waiting row asks whether to nudge, in words.
    assert.equal(await js(`document.querySelector('${row('waiting', 'klang/cli', 341)}')?.closest('.overview-row')?.querySelector('.overview-stale')?.textContent`), 'Nudge?');
    assert.ok(await js(`document.querySelector('${row('waiting', 'klang/cli', 341)}')?.closest('.overview-row')?.querySelector('.github-author')?.textContent.includes('lena')`), 'Waiting names the reviewer');
    await js(`document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').click()`);
    await wait(`document.querySelectorAll('${P} #overview-lane-waiting .overview-row').length === 0`);
    // Parked is collapsed by default, labelled with its reason.
    const parkedToggle = `${P} #overview-lane-merge .overview-parked .overview-lane-toggle`;
    assert.equal(await js(`document.querySelector('${parkedToggle}').getAttribute('aria-expanded')`), 'false');
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-parked-heading').textContent`), 'Parked · 2(mergeable, not approved or idle over 3 days)');
    assert.equal(await js(`document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-row').length`), 0);
    assert.equal(await laneRows('merge'), 4);
    await js(`document.querySelector('${parkedToggle}').click()`);
    await wait(`document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-row').length === 2`);
    assert.deepEqual(await notes(row('merge', 'klang/cli', 304)), ['No review required']);
    assert.deepEqual(await notes(row('merge', 'klang/engine', 305)), ['Approved by maya']);
    // Opening Parked changes no count.
    assert.equal(await counts(), 'Merge4 · Answer2 · Review7 · Fix2 · Waiting3');
    await js(`document.querySelector('${parkedToggle}').click()`);
    await wait(`document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-row').length === 0`);

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
    await js('window.__countRenders = false');

    step = 'heavy';
    // The real load from the critique: sixteen mergeable PRs, twelve of them unapproved and idle.
    await js('window.fixtureOverview.heavy()');
    await wait(`document.querySelector('${P} #overview-lane-merge .overview-lane-total')?.textContent.startsWith('4 · 12 parked')`);
    assert.equal(await counts(), 'Merge4 · Answer2 · Review7 · Fix18 · Waiting5', 'parked merges never reach the strip');
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(31)'");
    // A census of what the rows show, with every group open: stale flags and metadata chips.
    {
      await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-lane-toggle').click(); document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').click()`);
      await wait(`document.querySelectorAll('${P} #overview-lane-waiting .overview-row').length === 5 && document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-row').length === 5`);
      const census = await js<Record<string, number>>(`(()=>{const rows=[...document.querySelectorAll('${P} .overview-row')];const n=(s)=>rows.reduce((t,r)=>t+r.querySelectorAll(s).length,0);return {rows:rows.length,stale:n('.overview-stale'),amberWaits:rows.filter(r=>r.querySelector('.overview-wait')&&getComputedStyle(r.querySelector('.overview-wait')).color!==getComputedStyle(r.querySelector('.overview-size, .overview-row-meta')).color).length,borderedChips:n('.entity-badge'),authors:n('.github-author'),reasons:n('.overview-reason, .overview-merge-note'),sizes:n('.overview-size'),metaItems:rows.reduce((t,r)=>t+r.querySelector('.overview-row-meta').children.length,0)}})()`);
      console.log(`Overview census (heavy, every group open): ${JSON.stringify(census)}`);
      // Quieter: ages are muted text; a flag is always a word, never colour alone, and only outliers carry one.
      assert.equal(census.amberWaits, 0, 'no age is coloured');
      // Before this pass, 17 of these 26 rows were flagged. Review counts working days, so the number moves by a row
      // or two with the weekday; the five oldest Fix rows are genuinely past their limit.
      assert.ok(census.stale <= 12, `fewer rows are flagged (${census.stale})`);
      assert.ok(await js(`[...document.querySelectorAll('${P} .overview-stale')].every(e=>['Stale','Nudge?'].includes(e.textContent) && !!e.title)`), 'every flag is a labelled word');
      assert.equal(await js(`document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-stale').length`), 0, 'parked rows are never flagged');
      assert.equal(await js(`document.querySelector('${P} #overview-lane-fix .overview-lane-total').textContent`), '18 · 15 over a week');
      await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-lane-toggle').click(); document.querySelector('${P} #overview-lane-waiting .overview-lane-toggle').click()`);
      await wait(`document.querySelectorAll('${P} #overview-lane-waiting .overview-row').length === 0`);
    }
    assert.equal(await laneRows('merge'), 4, 'Parked starts collapsed');
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-lane-toggle').textContent`), 'Parked · 12');
    await js(`document.querySelector('${P} .overview-body').scrollTop = 0`);
    await both('heavy-parked-collapsed-1280', clarifyDir);
    await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-lane-toggle').click()`);
    await wait(`document.querySelectorAll('${P} #overview-lane-merge .overview-parked .overview-row').length === 5`);
    assert.equal(await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-show-all')?.textContent`), 'Show all 16 in Merge');
    await js(`(()=>{const b=document.querySelector('${P} .overview-body');const h=document.querySelector('${P} #overview-lane-merge .overview-parked');b.scrollTop+=h.getBoundingClientRect().top-b.getBoundingClientRect().top-120})()`);
    await both('heavy-parked-open-1280', clarifyDir);
    await js(`document.querySelector('${P} #overview-lane-merge .overview-parked .overview-lane-toggle').click()`);
    await js(`document.querySelector('${P} .overview-body').scrollTop = 0`);
    await js('window.fixtureOverview.restore()');
    await wait(`document.querySelector('${P} #overview-lane-merge .overview-lane-total')?.textContent === '4 · 2 parked'`);

    step = 'keyboard';
    // Ready merges, oldest first: #301 (approved 2 d ago), then #303 (updated 20 h ago).
    await js('document.activeElement?.blur()');
    await key('j');
    assert.equal(await focusedRow(), 'merge|https://github.com/klang/engine/pull/301');
    assert.equal(await js("getComputedStyle(document.activeElement).outlineStyle"), 'solid', 'focus is visible');
    await key('j');
    assert.equal(await focusedRow(), 'merge|https://github.com/acme/web/pull/303');
    await key('k');
    assert.equal(await focusedRow(), 'merge|https://github.com/klang/engine/pull/301');
    // Collapsed Parked rows are skipped: four Ready rows, then Answer.
    for (let i = 0; i < 4; i++) await key('ArrowDown');
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
    assert.match(await counts(), /^Merge3 /);

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
    await wait(`!document.querySelector('${row('merge', 'klang/cli', 302)}')`);
    await wait(`document.querySelector('${P} #overview-lane-merge .overview-lane-total')?.textContent === '2 · 2 parked'`);
    assert.match(await counts(), /^Merge2 /);

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
    assert.equal(await laneRows('waiting'), 3);
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
