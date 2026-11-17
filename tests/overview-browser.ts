/**
 * Overview (#390), the morning page: the briefing and "Since yesterday", Move forward now (quick wins by effort, one
 * action each), Waiting on you and Waiting on others (people and blockers, Nudge), and Needs a decision (Close PR,
 * Snooze). Covers the sections and their words, two columns wide and one narrow, keyboard movement (one tab stop per
 * section, j/k, Enter, A, Z, Shift+F10), descriptions and the live region, Nudge and Close through confirmations with
 * their failures, renders on sync ticks, the tab count, status that starts unknown and fills, a stale sync, the
 * user's real shape, and a light day. Synthetic data only (tests/fixtures/overview.ts).
 *
 * Screenshots go to .impeccable/review/overview-morning/: the real shape and a light day, light and dark, at
 * 1280×800, 1440×1000 and 760 wide.
 */
import { loadWorkbenchPage } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const row = (id: string) => `${P} [data-overview-row="${id}"]`;
const BRIEFING = 'lena and owen are waiting on your reply, and 7 reviews are waiting on you. 4 PRs are ready to merge, and 1 has failed checks.';
const SINCE = 'Since yesterday: 3 merged · 2 new review requests · owen and lena replied · checks failed on 1, passed on 2';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const dir = path.resolve('.impeccable/review/overview-morning');
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
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 2500)`)}`);
  };
  const both = async (name: string) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const resize = async (width: number, height = 800) => {
    win.setSize(width, height);
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
  const section = (name: string) => `${P} .morning-section[data-section="${name}"]`;
  const count = (name: string) => js<string>(`document.querySelector('${section(name)} [data-section-count]').textContent`);
  const ids = (name: string) => js<string[]>(`[...document.querySelectorAll('${section(name)} [data-overview-row]')].map(b=>b.dataset.overviewRow)`);
  const texts = (name: string) => js<string[]>(`[...document.querySelectorAll('${section(name)} .morning-row')].map(r=>[r.querySelector('.morning-title-text')?.textContent, r.querySelector('.morning-detail')?.textContent, r.querySelector('.morning-meta')?.textContent].filter(Boolean).join(' | '))`);
  const focusedRow = () => js<string | null>("document.activeElement?.getAttribute('data-overview-row') ?? null");
  const briefing = () => js<string>(`document.querySelector('${P} [data-overview-briefing]')?.textContent ?? ''`);
  const writes = () => js<{ kind: string; url: string; comment?: string }[]>('window.fixtureOverview.writes');
  const tabCount = () => js<number>('document.querySelectorAll(".workspace-tab").length');
  const activeSection = `document.querySelector('${P} [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent ?? ''`;
  const noSideways = () => js<boolean>(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth <= b.clientWidth + 1})()`);
  const boxes = () => js<[string, number, number][]>(`[...document.querySelectorAll('${P} .morning-section')].map(s=>{const r=s.getBoundingClientRect();return [s.dataset.section, Math.round(r.left), Math.round(r.top)]})`);
  const description = (selector: string) => js<string | null>(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});const d=b&&document.getElementById(b.getAttribute('aria-describedby'));return d&&b.closest('li').contains(d)?d.textContent:null})()`);
  const dismissToasts = () => js(`document.querySelectorAll('.app-toast [aria-label="Dismiss notification"]').forEach(b=>b.click())`);
  const typeComment = (text: string) =>
    js(`(()=>{const t=document.querySelector('[data-overview-dialog="close"] textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const firstTab = async () => {
    await js("document.querySelector('.workspace-tab-select').click()");
    await wait(`!!document.querySelector('${P} .overview') && getComputedStyle(document.querySelector('${P} .overview')).display !== 'none'`);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);

    step = 'default';
    // The Overview opens by default, as the home destination.
    await wait(`!!document.querySelector('${P} .morning [data-overview-row]')`, 600);
    assert.equal(await js(`document.querySelector('${sidebar('Overview')}')?.getAttribute('aria-current')`), 'page');
    assert.equal(await js(`document.querySelector('${P} .overview h1')?.textContent`), 'Overview');

    step = 'briefing';
    // The briefing sentence, then what changed since the last visit, from main's log.
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent === ${JSON.stringify(BRIEFING)}`);
    await wait(`document.querySelector('${P} [data-overview-since]')?.textContent === ${JSON.stringify(SINCE)}`);

    step = 'sections';
    // Four labelled sections in reading order: the lead, two columns side by side, then decisions.
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} section.morning-section')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).firstChild.textContent)`),
      ['Move forward now', 'Waiting on you', 'Waiting on others', 'Needs a decision']);
    {
      const b = Object.fromEntries((await boxes()).map(([name, left, top]) => [name, { left, top }]));
      assert.equal(b.you.top, b.others.top, 'Waiting on you beside Waiting on others');
      assert.ok(b.others.left > b.you.left && b.you.top > b.move.top && b.decide.top > b.you.top, JSON.stringify(b));
      assert.ok(await noSideways());
    }
    // Move forward now: merges approved and green first, then the explained small review and the reply, by effort.
    assert.deepEqual(await texts('move'), [
      'Cache resolved module paths between builds | approved by lena · green | 1 min',
      'Drop the unused polyfill bundle | no review required · green | 1 min',
      'Extract the billing form state | approved by ivar · green | 1 min',
      'Retry flaky uploads with jitter | approved by sam and 1 other · green | 1 min',
      'Stream build logs to the dashboard | 25 lines · explanation ready | 3 min',
      'Document the plugin loading order | owen: “Could we keep the old loading order behind a flag until…” | 3 min',
    ]);
    assert.equal(await js(`document.querySelector('${section('move')} .morning-section-summary').textContent`), '~10 min');
    assert.deepEqual(await js(`[...document.querySelectorAll('${section('move')} [data-quick-action]')].map(b=>b.textContent)`), ['Merge', 'Merge', 'Merge', 'Merge', 'Review', 'Reply']);
    // Waiting on you: by person, oldest wait first; lena and owen also wait on your replies.
    assert.deepEqual(await texts('you'), ['maya | 2 PRs · oldest 5 d', 'lena | 2 PRs · oldest 4 d', 'sam | 2 PRs · oldest 3 d', 'owen | 2 PRs · oldest 3 d', 'ivar | 1 PR · oldest 2 d']);
    assert.equal(await count('you'), '9');
    // Waiting on others: reviewers with Nudge, then CI, the open base and you.
    assert.deepEqual(await texts('others'), ['lena | 2 PRs · 4 d', 'CI | 1 running', 'base #331 | 1 PR · 20 h', 'base #306 | 1 PR · 9 h', 'You | 1 failing check, 2 conflicts']);
    assert.deepEqual(await js(`[...document.querySelectorAll('${section('others')} [data-quick-action]')].map(b=>b.textContent)`), ['Nudge', 'All 2']);
    // Needs a decision: idle for over a week.
    assert.deepEqual(await texts('decide'), ['Inline the hot path in the resolver | Idle 8 d', 'Rename the config loader flags | Idle 7 d']);
    // The tab title counts Move forward now and Waiting on you, each PR once: 6 + 9 − 2.
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(13)'");
    await js(`document.activeElement?.blur()`);
    await both('default-1280');

    step = 'harden';
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} [aria-describedby="overview-keyboard-help"]')].map(e=>e.className)`), ['overview']);
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-row][tabindex="0"]').length`), 4, 'one roving tab stop per section');
    assert.equal(await js(`[...document.querySelectorAll('${P} .morning-actions button')].every(b=>b.tabIndex===-1)`), true, 'actions and menus are out of the tab order');
    assert.equal(await description(row(`move|merge|${url('klang/engine', 301)}`)), 'Merge, approved by lena · green, engine #301, about 1 minute');
    assert.equal(await description(row('others|person:lena')), 'lena, 2 PRs · 4 days. Collapsed. A nudges');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').getAttribute('aria-live')`), 'polite');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').textContent`), '');
    assert.equal(await js(`getComputedStyle(document.querySelector('${section('decide')} .morning-actions')).opacity`), '0', 'decisions keep their actions until hover or focus');

    step = 'renders';
    // A sync tick that changes nothing renders no row.
    await js('window.__countRenders = true; window.__overviewRowRenders = 0; window.dispatchEvent(new Event("fixture-workbench-change"))');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await js('window.__overviewRowRenders'), 0, 'unchanged rows do not render again');
    await js('window.__countRenders = false');

    step = 'keyboard';
    // j/k move within a section; Tab moves to the next section; Enter expands a person.
    await js('document.activeElement?.blur()');
    const move = await ids('move');
    await key('j');
    assert.equal(await focusedRow(), move[0]);
    await key('j');
    await key('j');
    assert.equal(await focusedRow(), move[2]);
    await key('End');
    assert.equal(await focusedRow(), move.at(-1));
    await key('j');
    assert.equal(await focusedRow(), move.at(-1), 'j stays within the section');
    await key('Tab');
    assert.equal(await focusedRow(), 'you|person:maya', 'Tab reaches the next section');
    await key('Enter');
    await wait(`document.querySelector('${row('you|person:maya')}')?.getAttribute('aria-expanded') === 'true'`);
    await key('j');
    assert.equal(await focusedRow(), `you|person:maya|review|${url('klang/engine', 321)}`, 'the expanded person’s PRs follow it');
    assert.deepEqual((await texts('you')).slice(0, 3), ['maya | 2 PRs · oldest 5 d', 'Stream build logs to the dashboard | 5 d', 'Tighten the retry budget for webhooks | 2 d']);
    await key('Tab', 8);
    assert.equal(await focusedRow(), move.at(-1), 'Shift+Tab returns to the section’s last focused row');
    await key('Tab');
    await key('Tab');
    assert.equal(await focusedRow(), 'others|person:lena');
    await both('keyboard-focus');

    step = 'nudge-failure';
    // A refused nudge says why and leaves the reviewer to nudge again.
    await js('window.fixtureOverview.failNext()');
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]')`);
    await js(`document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]').click()`);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Could not nudge lena') && t.textContent.includes('GitHub refused the request.'))`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-row-item="others|person:lena"] [data-quick-action]')?.textContent`), 'Nudge');
    await dismissToasts();

    step = 'nudge';
    // A on a reviewer: the confirmation names the PRs; nothing is written until it is confirmed.
    await js(`document.querySelector('${row('others|person:lena')}').focus()`);
    const nudgesBefore = (await writes()).filter((w) => w.kind.startsWith('nudge')).length;
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]')`);
    assert.equal(await js(`document.querySelector('[data-overview-dialog="nudge"] h2')?.textContent`), 'Nudge lena?');
    assert.match(await js<string>(`document.querySelector('[data-overview-dialog="nudge"]').textContent`), /request lena’s review again on PRs #(306, #341|341, #306)/);
    assert.equal((await writes()).filter((w) => w.kind.startsWith('nudge')).length, nudgesBefore, 'opening the confirmation writes nothing');
    await both('nudge-confirmation');
    await js(`document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]').click()`);
    await wait(`!document.querySelector('[data-overview-dialog="nudge"]')`);
    await wait(`document.querySelector('${P} [data-overview-row-item="others|person:lena"] .morning-done')?.textContent === 'Nudged'`);
    assert.deepEqual((await writes()).filter((w) => w.kind === 'nudge:lena').map((w) => w.url).slice(-2).sort(), [url('acme/web', 306), url('klang/cli', 341)]);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Asked lena to review 2 PRs again'))`);
    await dismissToasts();

    step = 'close';
    // Close PR: a confirmation that says it can be reopened, with an optional comment; the row leaves at once.
    const decide305 = `decide|merge|${url('klang/engine', 305)}`;
    await js(`document.querySelector('${row(decide305)}').focus()`);
    await wait(`getComputedStyle(document.querySelector('${section('decide')} [data-overview-row-item="${decide305}"] .morning-actions')).opacity === '1'`);
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="close"] [data-overview-confirm]:not([disabled])')`);
    assert.equal(await js(`document.querySelector('[data-overview-dialog="close"] h2').textContent`), 'Close #305?');
    assert.match(await js<string>(`document.querySelector('[data-overview-dialog="close"]').textContent`), /You can reopen it on GitHub later/);
    await typeComment('Superseded by the new resolver.');
    await both('close-confirmation');
    // GitHub refuses the first try: the row comes back, with the reason.
    await js('window.fixtureOverview.failNext()');
    await js(`document.querySelector('[data-overview-dialog="close"] [data-overview-confirm]').click()`);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Could not close #305') && t.textContent.includes('GitHub refused the request.'))`);
    await wait(`!!document.querySelector('${row(decide305)}')`);
    await dismissToasts();
    await js(`document.querySelector('${section('decide')} [data-overview-row-item="${decide305}"] [data-quick-action]').click()`);
    await wait(`!!document.querySelector('[data-overview-dialog="close"] [data-overview-confirm]:not([disabled])')`);
    await typeComment('Superseded by the new resolver.');
    await js(`document.querySelector('[data-overview-dialog="close"] [data-overview-confirm]').click()`);
    await wait(`!document.querySelector('${row(decide305)}')`, 10);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Closed #305. You can reopen it on GitHub.'))`);
    assert.deepEqual((await writes()).filter((w) => w.kind === 'close'), [
      { kind: 'close', url: url('klang/engine', 305), comment: 'Superseded by the new resolver.' },
      { kind: 'close', url: url('klang/engine', 305), comment: 'Superseded by the new resolver.' },
    ]);
    await dismissToasts();
    await js('window.fixtureOverview.restore()');
    await wait(`document.querySelectorAll('${section('move')} .morning-row').length === 6`);

    step = 'open-row';
    // A row opens where its notification would: the reply in Feedback.
    const tabs = await tabCount();
    await js(`document.querySelector('${row(`move|answer|${url('klang/engine', 312)}`)}').click()`);
    await wait(`${activeSection}.startsWith('Feedback')`, 400);
    assert.equal(await tabCount(), tabs + 1);
    await firstTab();

    step = 'menu';
    // Mark as read, Snooze and copying live in the row menu; Shift+F10 opens it from the row.
    await menuAction(js, 'Actions for PR #312', 'Mark as read');
    await wait("window.fixtureOverview.writes.some(w=>w.kind==='mark-read' && w.url.endsWith('/312'))");
    const m303 = row(`move|merge|${url('acme/web', 303)}`);
    await js(`document.querySelector('${m303}').focus()`);
    await key('F10', 8);
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent==='Snooze PR…')");
    await key('Escape');
    await wait("!document.querySelector('[role=menuitem]')");
    // Z snoozes the focused row.
    await js(`document.querySelector('${m303}').focus()`);
    await key('z');
    await wait("!!document.querySelector('.snooze-picker .snooze-option')");
    await js("document.querySelector('.snooze-picker .snooze-option').click()");
    await wait(`!document.querySelector('${m303}')`);

    step = 'open-lane';
    // "You · All N" opens the queue grouped by Action at Fix; Group by Action stays as built.
    await js(`document.querySelector('${P} [data-overview-row-item="others|you"] [data-quick-action]').click()`);
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display === 'none' && document.activeElement?.closest('[data-queue-group]')?.dataset.queueGroup === 'action:fix'`);
    assert.equal(await js(`document.querySelector('${P} [data-queue-group-by]').dataset.queueGroupBy`), 'action');
    await click(sidebar('Overview'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display !== 'none' && !!document.querySelector('${P} [data-overview-row]')`);

    step = 'live-update';
    // Live updates change rows in place, focus stays put, and the count change is announced once.
    await js(`document.querySelector('${row('you|person:maya')}').focus()`);
    const focused = await focusedRow();
    await js("window.fixtureOverview.rename(322, 'Add a dry-run flag to every release script'); window.fixtureOverview.addFailing()");
    await wait(`(document.querySelector('${section('others')} [data-overview-row-item="others|you"] .morning-detail')?.textContent ?? '').startsWith('2 failing checks')`);
    assert.equal(await focusedRow(), focused, 'focus stays on the row');
    await wait(`document.querySelector('${P} [data-overview-announcement]').textContent.includes('Waiting on others')`);

    step = 'real';
    // The user's real shape: Answer 0, Review 2, Merge 16 (2 ready, 14 parked), Fix 18 and Waiting 5.
    await js('window.fixtureOverview.real()');
    await wait(`document.querySelectorAll('${section('move')} .morning-row').length === 4`);
    assert.equal(await briefing(), '2 reviews are waiting on you. 2 PRs are ready to merge, and 15 have failed checks.');
    await wait(`[...document.querySelectorAll('${section('move')} .morning-detail')].some(d=>d.textContent==='+42 lines since your review')`);
    assert.deepEqual(await texts('move'), [
      'Cache resolved module paths between builds | approved by lena · green | 1 min',
      'Retry flaky uploads with jitter | approved by sam and 1 other · green | 1 min',
      'Stream build logs to the dashboard | 25 lines · explanation ready | 3 min',
      'Replace the legacy config parser | +42 lines since your review | 3 min',
    ]);
    assert.ok((await writes()).some((w) => w.kind === 'compare' && w.url === url('klang/engine', 324)), 'one compare for the re-review');
    assert.deepEqual(await texts('others'), ['plucked | 1 PR · 10 d', 'lena | 2 PRs · 4 d', 'sam | 1 PR · 4 h', 'CI | 2 running', 'base #331 | 1 PR · 20 h', 'You | 15 failing checks, 4 conflicts']);
    assert.ok(Number(await count('decide')) >= 14, 'idle, failing and never-approved PRs need a decision');
    assert.equal(await js(`document.querySelector('${section('decide')} [data-overview-more]')?.textContent`), `Show all ${await count('decide')}`);
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await dismissToasts();
    await both('real-1280');
    await resize(1440, 1000);
    await both('real-1440');
    {
      // The page fills the window: the sections reach into its lower part.
      const fill = await js<number>(`(()=>{const b=document.querySelector('${P} .overview-body');const m=document.querySelector('${P} .morning');return (m.getBoundingClientRect().bottom - b.getBoundingClientRect().top) / b.clientHeight})()`);
      assert.ok(fill > 0.7, `the sections fill the window (${fill.toFixed(2)})`);
    }
    await resize(760);
    {
      // One column when narrow, in reading order, with nothing scrolling sideways.
      const b = await boxes();
      assert.deepEqual(b.map(([name]) => name), ['move', 'you', 'others', 'decide']);
      assert.ok(b.every(([, left]) => left === b[0][1]), `one column: ${JSON.stringify(b)}`);
      assert.ok(b.every(([, , top], i) => i === 0 || top > b[i - 1][2]));
      assert.ok(await noSideways(), 'no sideways scrolling at 760');
    }
    await both('real-760');
    await resize(1280);

    step = 'light-day';
    // A light day: one reply, two reviews, one merge.
    await js('document.activeElement?.blur(); window.fixtureOverview.restore(); window.fixtureOverview.only([311, 321, 323, 302])');
    await wait(`document.querySelectorAll('${section('decide')} .morning-empty').length === 1 && document.querySelectorAll('${section('move')} .morning-row').length === 3`);
    assert.equal(await briefing(), 'lena is waiting on your reply, and 2 reviews are waiting on you. 1 PR is ready to merge.');
    assert.equal(await js(`document.querySelector('${section('decide')} .morning-empty')?.textContent`), 'Nothing to decide. None of your PRs has been stuck for over a week.');
    await dismissToasts();
    await new Promise((r) => setTimeout(r, 400));
    await both('light-day-1280');
    await resize(1440, 1000);
    await both('light-day-1440');
    await resize(760);
    await both('light-day-760');
    await resize(1280);

    step = 'status-arrives';
    // GitHub has not answered yet: no saved status, and status reads wait. The Overview asks for every lane candidate
    // itself and says it is checking; rows that need status arrive with the answers, and focus stays put.
    await js('sessionStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview&overview-status=held`);
    await wait(`!!document.querySelector('${P} [data-overview-checking]')`, 600);
    const own = [301, 302, 303, 304, 305, 306, 307, 311, 312, 331, 332, 333, 341, 342];
    const expected = [...own, ...Array.from({ length: 7 }, (_, i) => 321 + i)].map((n) => `/pull/${n}`);
    await wait(`(()=>{const r=window.fixtureOverview.requested();return ${JSON.stringify(expected)}.every(n=>r.some(u=>u.endsWith(n)))})()`);
    await wait(`document.querySelector('${P} [data-overview-checking]')?.textContent === 'Checking ' + window.fixtureOverview.requested().length + '…'`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-unchecked]')`), null, 'checking, not "not checked"');
    // Review requests need no status; merges wait for it.
    assert.equal(await js(`[...document.querySelectorAll('${section('move')} [data-quick-action]')].filter(b=>b.textContent==='Merge').length`), 0);
    await js('window.fixtureOverview.real()');
    const checkingCount = `Number(document.querySelector('${P} [data-overview-checking]')?.textContent.match(/\\d+/)?.[0] ?? 0)`;
    await wait(`${checkingCount} > 21`);
    await js(`document.querySelector('${row('you|person:maya')}').focus()`);
    await capture('real-checking-1280-light');
    await js('window.fixtureOverview.answerStatus()');
    await wait(`!document.querySelector('${P} [data-overview-checking]')`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-unchecked]')`), null);
    await wait(`document.querySelectorAll('${section('move')} .morning-row').length === 4`);
    assert.equal(await focusedRow(), 'you|person:maya', 'focus stays while rows arrive');
    await js('document.activeElement?.blur()');
    await capture('real-filled-1280-light');

    step = 'stale-sync';
    // The last sync is two hours old: the Overview asks main for one, and says so while it runs.
    const before = (await js<boolean[]>('window.fixtureOverview.discoveries')).length;
    await js('window.fixtureOverview.setSync(2 * 3600000)');
    await wait(`window.fixtureOverview.discoveries.length > ${before}`);
    assert.equal(await js('window.fixtureOverview.discoveries.at(-1)'), false, 'a sync, not a forced refresh');
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
