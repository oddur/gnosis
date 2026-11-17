/**
 * Overview (#390), the morning page: the briefing and "Since yesterday", Next up (cheapest first, one action each),
 * Waiting on you and Waiting on others (people, blockers, stacks as chains, Nudge), and Needs a decision (Close PR,
 * Snooze). Covers the sections and their words, each PR listed once and every heading equal to its rows, check
 * states and the PR preview on every PR line, the layout full width at 1440 and 1920 and one column at 760, keyboard
 * movement (one tab stop per section, j/k, Enter, A, Z, Shift+F10), descriptions and the live region, Nudge and Close
 * through confirmations with their failures, renders on sync ticks, the tab count, status that starts unknown and
 * fills, a stale sync, the user's real shapes (screenshots 32 and 34), and a light day. Synthetic data only
 * (tests/fixtures/overview.ts).
 *
 * Screenshots go to .impeccable/review/overview-morning-4/, light and dark: the default day, the screenshot-32 shape
 * at 1440×1000, 1920×1080 and 760 wide, the screenshot-34 chains at 1440 and 760, a light day, and the PR preview.
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
const BRIEFING = 'lena and owen are waiting on your reply, and 7 reviews are waiting on you. 3 PRs are approved and ready to merge, 1 more can merge without review, and 1 has failed checks.';
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
  const dir = path.resolve('.impeccable/review/overview-morning-4');
  fs.mkdirSync(dir, { recursive: true });
  // Mismatches in words and layout are collected per step, so one run reports all of them.
  const misses: string[] = [];
  const soft = (actual: unknown, expected: unknown, message = '') => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      misses.push(`[${step}] ${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
    }
  };
  const softOk = (value: unknown, message: string) => { if (!value) misses.push(`[${step}] ${message}`); };
  const settle = () => {
    if (misses.length) throw Error(`Mismatches:\n${misses.join('\n')}`);
  };
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
    throw Error(`Timed out in "${step}": ${code}\n${misses.join('\n')}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 3000)`)}`);
  };
  const both = async (name: string) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const resize = async (width: number, height = 800) => {
    win.setContentSize(width, height);
    await new Promise((r) => setTimeout(r, 400));
  };
  const cdp = win.webContents.debugger;
  const attach = () => { if (!cdp.isAttached()) cdp.attach('1.3'); };
  const key = async (name: string, modifiers = 0) => {
    attach();
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const vk = name.length === 1 ? name.toUpperCase().charCodeAt(0) : ({ Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27, Tab: 9, Home: 36, End: 35, F10: 121 } as Record<string, number>)[name];
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...(name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 80));
  };
  const hover = async (selector: string) => {
    attach();
    const box = await js<{ x: number; y: number }>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-b.clientHeight/2;const r=e.getBoundingClientRect();return {x:r.left+Math.min(40,r.width/2),y:r.top+r.height/2}})()`);
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  };
  const unhover = async () => {
    attach();
    // Two moves: Radix closes a hoverable tooltip once the pointer moves outside the path to its content.
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
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
  // Number, title, repository, detail, check, status and meta, as each row shows them.
  const parts = `r=>[r.querySelector('.morning-number')?.textContent, r.querySelector('.morning-title-text')?.textContent, r.querySelector('.morning-repo')?.textContent, r.querySelector('.morning-detail')?.textContent, r.querySelector('.morning-checks')?.textContent, r.querySelector('.morning-status')?.textContent, r.querySelector('.morning-meta')?.textContent].filter(Boolean).join(' | ')`;
  const texts = (name: string) => js<string[]>(`[...document.querySelectorAll('${section(name)} .morning-row')].map(${parts})`);
  const rowText = (id: string) => js<string>(`(()=>{const r=document.querySelector('${P} [data-overview-row-item="${id}"]');return r?(${parts})(r):''})()`);
  // A section heading equals the sum of what its top rows say they hold: "2 PRs · …", "1 running", "4 PRs in 2 stacks", "1 failing check, 1 conflict".
  const rowSum = (name: string) => js<number>(`[...document.querySelectorAll('${section(name)} .morning-row:not(.is-nested) .morning-detail')].reduce((t,d)=>{const x=d.textContent;const why=[...x.matchAll(/([0-9]+) (failing check|conflict|restack)/g)];return t+(why.length?why.reduce((n,m)=>n+Number(m[1]),0):Number(x.match(/^[0-9]+/)?.[0] ?? 1))},0)`);
  // Every PR the page lists, from each row's data-overview-prs: no PR twice.
  const listed = () => js<string[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].flatMap(r=>r.dataset.overviewPrs.split(' ').filter(Boolean))`);
  const noneTwice = async () => {
    const all = await listed();
    softOk(all.length > 0, 'PR lines carry data-overview-prs');
    soft(all.filter((value, i) => all.indexOf(value) !== i), [], 'no PR appears twice on the page');
  };
  // Every PR line shows a check state, and says it in its description.
  const checksEverywhere = async () => {
    const rows = await js<{ id: string; check: string | null; description: string }[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].map(r=>({id:r.dataset.overviewRowItem,check:r.querySelector('[data-overview-check]')?.textContent ?? null,description:r.querySelector('[data-overview-description]')?.textContent ?? ''}))`);
    for (const entry of rows) {
      softOk(entry.check, `${entry.id} shows a check state`);
      softOk(/checks? (passing|running|failed|failing|not read yet)|no checks/.test(entry.description), `${entry.id} says its check state: ${entry.description}`);
    }
  };
  // Every top-level row names its repository in plain text.
  const everyGroupHasRepo = () => js<boolean>(`[...document.querySelectorAll('${P} .morning-row:not(.is-nested), ${P} .morning-stack-head')].every(r=>{const e=r.querySelector('.morning-repo');return !!e && e.textContent.trim().length>0 && e.getBoundingClientRect().width>0})`);
  const focusedRow = () => js<string | null>("document.activeElement?.getAttribute('data-overview-row') ?? null");
  const briefing = () => js<string>(`document.querySelector('${P} [data-overview-briefing]')?.textContent ?? ''`);
  const writes = () => js<{ kind: string; url: string; comment?: string }[]>('window.fixtureOverview.writes');
  const tabCount = () => js<number>('document.querySelectorAll(".workspace-tab").length');
  const activeSection = `document.querySelector('${P} [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent ?? ''`;
  const noSideways = () => js<boolean>(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth <= b.clientWidth + 1})()`);
  const boxes = () => js<[string, number, number, number][]>(`[...document.querySelectorAll('${P} .morning-section')].map(s=>{const r=s.getBoundingClientRect();return [s.dataset.section, Math.round(r.left), Math.round(r.top), Math.round(r.width)]})`);
  // Full width, one above the other: Next up, Waiting on you, Waiting on others, Needs a decision, on one left edge.
  const stacked = async (label: string) => {
    const b = await boxes();
    soft(b.map(([name]) => name), ['next', 'you', 'others', 'decide'], `${label}: reading order`);
    softOk(b.every(([, left, , width]) => left === b[0][1] && Math.abs(width - b[0][3]) <= 1), `${label}: one column, full width: ${JSON.stringify(b)}`);
    softOk(b.every(([, , top], i) => i === 0 || top > b[i - 1][2]), `${label}: top to bottom: ${JSON.stringify(b)}`);
    softOk(await js(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth <= b.clientWidth})()`), `${label}: nothing scrolls sideways`);
  };
  // Nothing that must stay readable is cut: numbers, check states, status words and a stack's next step.
  const uncut = async (label: string) => {
    const cut = await js<string[]>(`[...document.querySelectorAll('${P} .morning-number, ${P} .morning-checks, ${P} .morning-status, ${P} .morning-stack-head .morning-detail')].filter(e=>e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e=>e.textContent)`);
    soft(cut, [], `${label}: numbers, checks, statuses and steps are never truncated`);
  };
  const description = (selector: string) => js<string | null>(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});const d=b&&document.getElementById(b.getAttribute('aria-describedby'));return d&&b.closest('[data-overview-row-item]').contains(d)?d.textContent:null})()`);
  const dismissToasts = () => js(`document.querySelectorAll('.app-toast [aria-label="Dismiss notification"]').forEach(b=>b.click())`);
  const typeComment = (text: string) =>
    js(`(()=>{const t=document.querySelector('[data-overview-dialog="close"] textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const tooltip = `document.querySelector('[data-slot=tooltip-content].entity-badge-tooltip.pr-badge-tooltip')`;
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
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent === ${JSON.stringify(BRIEFING)}`);
    await wait(`document.querySelector('${P} [data-overview-since]')?.textContent === ${JSON.stringify(SINCE)}`);

    step = 'sections';
    await wait(`document.querySelectorAll('${section('next')} .morning-row').length === 5 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    soft(await js(`[...document.querySelectorAll('${P} section.morning-section')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).firstChild.textContent)`),
      ['Next up', 'Waiting on you', 'Waiting on others', 'Needs a decision']);
    await stacked('1280');
    // Next up: approved merges, the merge nobody reviewed, then the explained review and the reply, cheapest first.
    soft(await texts('next'), [
      '#301 | Cache resolved module paths between builds | engine | approved by lena · green | passing | ~1 min',
      '#302 | Retry flaky uploads with jitter | cli | approved by sam and 1 other · green | passing | ~1 min',
      '#303 | Drop the unused polyfill bundle | web | not reviewed · green | passing | ~1 min',
      '#321 | Stream build logs to the dashboard | engine | 25 lines · explanation ready | passing | ~3 min',
      '#312 | Document the plugin loading order | engine | owen: “Could we keep the old loading order behind a flag until…” | passing | ~3 min',
    ], 'Next up');
    soft(await js(`document.querySelector('${section('next')} .morning-section-summary')?.textContent`), '~9 min', 'the total effort');
    soft(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].map(b=>b.textContent)`), ['Merge', 'Merge', 'Merge', 'Review', 'Reply']);
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')`), null, 'the only unreviewed merge is listed');
    // Waiting on you: by person, oldest wait first; a few PRs are listed inline, number first. A PR in Next up is not here.
    soft(await texts('you'), [
      'lena | 2 repos | 2 PRs · oldest 4 d | passing',
      '#322 | Add a dry-run flag to the release script | cli | passing | 4 d',
      '#311 | Move session refresh into the auth worker | web | passing | 4 d',
      'sam | 2 repos | 2 PRs · oldest 3 d | passing',
      '#323 | Batch telemetry writes per request | web | passing | 3 d',
      '#327 | Index workspace symbols lazily | engine | passing | 1 d',
      'owen | engine | 1 PR · oldest 3 d | passing',
      '#324 | Replace the legacy config parser | passing | 3 d',
      'ivar | cli | 1 PR · oldest 2 d | passing',
      '#325 | Show lockfile drift in CI output | passing | 2 d',
      'maya | web | 1 PR · oldest 2 d | passing',
      '#326 | Tighten the retry budget for webhooks | passing | 2 d',
    ], 'Waiting on you');
    soft(await count('you'), '7');
    soft(await rowSum('you'), 7, 'Waiting on you: heading = rows');
    // Waiting on others: lena with Nudge, CI, the stacks as chains (base first), and you.
    soft(await texts('others'), [
      'lena | cli | 1 PR · 4 d | passing',
      '#341 | Print a summary after install | passing | 4 d',
      'CI | engine | 1 running',
      '#342 | Profile cold starts in CI | running | 6 h',
      'Waiting for earlier PRs in a stack to merge | 2 repos | 4 PRs in 2 stacks',
      'Split the scheduler into phases | engine | #331 has failing checks | 2 PRs',
      '#331 | Split the scheduler into phases | 2 failed | Next',
      '#332 | Run phases on a worker pool | passing | Conflicts',
      'Extract the billing form state | web | #306 waits on review from lena | 2 PRs',
      '#306 | Extract the billing form state | passing | Next',
      '#307 | Validate billing addresses on blur | passing | Ready',
      'You | web | 1 conflict',
      '#333 | Upgrade the router to v7 | Conflicts | passing | 9 h',
    ], 'Waiting on others');
    soft(await count('others'), '7');
    soft(await rowSum('others'), 7, 'Waiting on others: heading = rows');
    soft(await js(`[...document.querySelectorAll('${section('others')} [data-quick-action]')].map(b=>b.textContent)`), ['Nudge', 'Open #331', 'Nudge', 'All 1', 'Open']);
    soft(await texts('decide'), ['#305 | Inline the hot path in the resolver | engine | Idle 8 d | passing', '#304 | Rename the config loader flags | cli | Idle 7 d | passing']);
    softOk(await everyGroupHasRepo(), 'every group names its repository');
    await noneTwice();
    await checksEverywhere();
    // The tab title counts Next up and Waiting on you, each PR once: 5 + 7.
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(12)'");
    await js(`document.activeElement?.blur()`);
    await both('default-1280');
    settle();

    step = 'harden';
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} [aria-describedby="overview-keyboard-help"]')].map(e=>e.className)`), ['overview']);
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-row][tabindex="0"]').length`), 4, 'one roving tab stop per section');
    assert.equal(await js(`[...document.querySelectorAll('${P} .morning-actions button')].every(b=>b.tabIndex===-1)`), true, 'actions and menus are out of the tab order');
    soft(await description(row(`next|merge|${url('klang/engine', 301)}`)), 'Merge, approved by lena · green, engine #301, checks passing, about 1 minute');
    soft(await description(row('others|person:lena')), 'lena, cli, 1 PR · 4 days, checks passing. A nudges');
    soft(await description(row(`others|stacks|stack:acme/web#306|${url('acme/web', 307)}`)), '#307, waits for #306 to merge, checks passing');
    soft(await description(row(`others|you|${url('acme/web', 333)}`)), '#333, conflicts, checks passing, waiting 9 hours');
    soft(await description(row('decide|merge|' + url('klang/engine', 305))), 'Idle 8 d, engine #305, checks passing. A closes, Z snoozes');
    soft(await js(`document.querySelector('${P} [data-overview-stack="stack:acme/web#306"] .morning-chain').getAttribute('aria-label')`), 'Stack Extract the billing form state, 2 PRs, next: #306 waits on review from lena');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').getAttribute('aria-live')`), 'polite');
    assert.equal(await js(`document.querySelector('${P} [data-overview-announcement]').textContent`), '');
    soft(await js(`getComputedStyle(document.querySelector('${section('decide')} .morning-actions')).opacity`), '0', 'decisions keep their actions until hover or focus');
    soft(await js(`getComputedStyle(document.querySelector('${section('others')} [data-overview-row-item="others|you|${url('acme/web', 333)}"] [data-reveal]')).opacity`), '0', 'a You row shows its action on hover or focus');
    settle();

    step = 'renders';
    // A sync tick that changes nothing renders no row.
    await js('window.__countRenders = true; window.__overviewRowRenders = 0; window.__overviewRenderedRows = []; window.dispatchEvent(new Event("fixture-workbench-change"))');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await js('window.__overviewRowRenders'), 0, `unchanged rows do not render again: ${await js<string>('JSON.stringify(window.__overviewRenderedRows)')}`);
    await js('window.__countRenders = false');

    step = 'preview';
    // A PR title previews the PR with the PR badge's tooltip: on keyboard focus after the badge's delay, and on hover.
    const first = row(`next|merge|${url('klang/engine', 301)}`);
    await js(`document.querySelector('${first}').focus()`);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(await js(`!!${tooltip}`), false, 'focus waits before the preview opens');
    await wait(`${tooltip}?.textContent.includes('klang/engine #301') && !!${tooltip}.querySelector('.pr-badge-preview')`);
    assert.equal(await js(`document.querySelector('[role=tooltip]')?.textContent.includes('klang/engine #301')`), true, 'the same tooltip role as elsewhere');
    await capture('preview-focus-light');
    await key('Escape');
    await wait(`!${tooltip}`);
    await js('document.activeElement?.blur()');
    await hover(`${row(`others|person:lena|${url('klang/cli', 341)}`)} .morning-title-text`);
    await wait(`${tooltip}?.textContent.includes('klang/cli #341')`);
    // The row's quick action still shows on hover beside it.
    assert.equal(await js(`getComputedStyle(document.querySelector('${P} [data-overview-row-item="others|person:lena|${url('klang/cli', 341)}"]')).backgroundColor !== 'rgba(0, 0, 0, 0)'`), true);
    await both('preview-hover');
    // Scrolling dismisses it.
    await js(`document.querySelector('${P} .overview-body').scrollTop += 40`);
    await wait(`!${tooltip}`);
    await unhover();

    step = 'keyboard';
    // j/k move within a section; Tab moves to the next section.
    await js('document.activeElement?.blur()');
    const next = await ids('next');
    await key('j');
    assert.equal(await focusedRow(), next[0]);
    await key('j');
    await key('j');
    assert.equal(await focusedRow(), next[2]);
    await key('End');
    assert.equal(await focusedRow(), next.at(-1));
    await key('j');
    assert.equal(await focusedRow(), next.at(-1), 'j stays within the section');
    await key('Tab');
    assert.equal(await focusedRow(), 'you|person:lena', 'Tab reaches the next section');
    await key('j');
    assert.equal(await focusedRow(), `you|person:lena|${url('klang/cli', 322)}`, 'a person’s PRs follow it, inline');
    await key('Tab', 8);
    assert.equal(await focusedRow(), next.at(-1), 'Shift+Tab returns to the section’s last focused row');
    await key('Tab');
    await key('Tab');
    assert.equal(await focusedRow(), 'others|person:lena');
    await wait(`!${tooltip}`, 40).catch(() => undefined);
    await both('keyboard-focus');

    step = 'nudge-failure';
    await js('window.fixtureOverview.failNext()');
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]')`);
    await js(`document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]').click()`);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Could not nudge lena') && t.textContent.includes('GitHub refused the request.'))`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-row-item="others|person:lena"] [data-quick-action]')?.textContent`), 'Nudge');
    await dismissToasts();

    step = 'nudge';
    await js(`document.querySelector('${row('others|person:lena')}').focus()`);
    const nudgesBefore = (await writes()).filter((w) => w.kind.startsWith('nudge')).length;
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]')`);
    assert.equal(await js(`document.querySelector('[data-overview-dialog="nudge"] h2')?.textContent`), 'Nudge lena?');
    assert.match(await js<string>(`document.querySelector('[data-overview-dialog="nudge"]').textContent`), /request lena’s review again on PR #341/);
    assert.equal((await writes()).filter((w) => w.kind.startsWith('nudge')).length, nudgesBefore, 'opening the confirmation writes nothing');
    await js(`document.querySelector('[data-overview-dialog="nudge"] [data-overview-confirm]').click()`);
    await wait(`!document.querySelector('[data-overview-dialog="nudge"]')`);
    await wait(`document.querySelector('${P} [data-overview-row-item="others|person:lena"] .morning-done')?.textContent === 'Nudged'`);
    assert.deepEqual((await writes()).filter((w) => w.kind === 'nudge:lena').map((w) => w.url).slice(-1), [url('klang/cli', 341)]);
    await wait(`[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Asked lena to review 1 PR again'))`);
    await dismissToasts();
    // A stack whose base waits on a reviewer nudges from its header.
    await js(`document.querySelector('${P} [data-overview-row-item="others|stacks|stack:acme/web#306"] [data-quick-action]').click()`);
    await wait(`document.querySelector('[data-overview-dialog="nudge"] h2')?.textContent === 'Nudge lena?' && document.querySelector('[data-overview-dialog="nudge"]').textContent.includes('PR #306')`);
    await key('Escape');
    await wait(`!document.querySelector('[data-overview-dialog="nudge"]')`);

    step = 'close';
    const decide305 = `decide|merge|${url('klang/engine', 305)}`;
    await js(`document.querySelector('${row(decide305)}').focus()`);
    await wait(`getComputedStyle(document.querySelector('${section('decide')} [data-overview-row-item="${decide305}"] .morning-actions')).opacity === '1'`);
    await key('a');
    await wait(`!!document.querySelector('[data-overview-dialog="close"] [data-overview-confirm]:not([disabled])')`);
    assert.equal(await js(`document.querySelector('[data-overview-dialog="close"] h2').textContent`), 'Close #305?');
    assert.match(await js<string>(`document.querySelector('[data-overview-dialog="close"]').textContent`), /You can reopen it on GitHub later/);
    await typeComment('Superseded by the new resolver.');
    await both('close-confirmation');
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
    await wait(`document.querySelectorAll('${section('next')} .morning-row').length === 5`);

    step = 'open-row';
    const tabs = await tabCount();
    await js(`document.querySelector('${row(`next|answer|${url('klang/engine', 312)}`)}').click()`);
    await wait(`${activeSection}.startsWith('Feedback')`, 400);
    assert.equal(await tabCount(), tabs + 1);
    await firstTab();

    step = 'menu';
    await menuAction(js, 'Actions for PR #312', 'Mark as read');
    await wait("window.fixtureOverview.writes.some(w=>w.kind==='mark-read' && w.url.endsWith('/312'))");
    const line322 = row(`you|person:lena|${url('klang/cli', 322)}`);
    await js(`document.querySelector('${line322}').focus()`);
    await key('F10', 8);
    await wait("[...document.querySelectorAll('[role=menuitem]')].some(b=>b.textContent==='Snooze PR…')");
    await key('Escape');
    await wait("!document.querySelector('[role=menuitem]')");
    await js(`document.querySelector('${line322}').focus()`);
    await key('z');
    await wait("!!document.querySelector('.snooze-picker .snooze-option')");
    await js("document.querySelector('.snooze-picker .snooze-option').click()");
    await wait(`!document.querySelector('${line322}')`);

    step = 'open-lane';
    await js(`document.querySelector('${P} [data-overview-row-item="others|you"] [data-quick-action]').click()`);
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display === 'none' && document.activeElement?.closest('[data-queue-group]')?.dataset.queueGroup === 'action:fix'`);
    assert.equal(await js(`document.querySelector('${P} [data-queue-group-by]').dataset.queueGroupBy`), 'action');
    await click(sidebar('Overview'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display !== 'none' && !!document.querySelector('${P} [data-overview-row]')`);

    step = 'live-update';
    await js(`document.querySelector('${row('you|person:sam')}').focus()`);
    const focused = await focusedRow();
    await js("window.fixtureOverview.rename(323, 'Batch every telemetry write per request'); window.fixtureOverview.addFailing()");
    await wait(`(document.querySelector('${section('others')} [data-overview-row-item="others|you"] .morning-detail')?.textContent ?? '') === '1 failing check, 1 conflict'`);
    await wait(`(document.querySelector('${P} [data-overview-row-item="you|person:sam|${url('acme/web', 323)}"] .morning-title-text')?.textContent ?? '') === 'Batch every telemetry write per request'`);
    assert.equal(await focusedRow(), focused, 'focus stays on the row');
    await wait(`document.querySelector('${P} [data-overview-announcement]').textContent.includes('Waiting on others')`);

    step = 'light-day';
    await js('document.activeElement?.blur(); window.fixtureOverview.restore(); window.fixtureOverview.only([311, 321, 323, 302])');
    await wait(`document.querySelectorAll('${section('decide')} .morning-empty').length === 1 && document.querySelectorAll('${section('next')} .morning-row').length === 4`);
    assert.equal(await briefing(), 'lena is waiting on your reply, and 2 reviews are waiting on you. 1 PR is approved and ready to merge.');
    soft(await texts('next'), [
      '#302 | Retry flaky uploads with jitter | cli | approved by sam and 1 other · green | passing | ~1 min',
      '#321 | Stream build logs to the dashboard | engine | 25 lines · explanation ready | passing | ~3 min',
      '#323 | Batch every telemetry write per request | web | 117 lines | passing | ~6 min',
      '#311 | Move session refresh into the auth worker | web | lena requested changes | passing | ~15 min',
    ], 'light day');
    soft(await js(`document.querySelector('${section('you')} .morning-empty')?.textContent`), 'Nobody is waiting on you.');
    soft(await js(`document.querySelector('${section('decide')} .morning-empty')?.textContent`), 'Nothing to decide. None of your PRs has been stuck for over a week.');
    await dismissToasts();
    await new Promise((r) => setTimeout(r, 400));
    await both('light-day-1280');
    await resize(760);
    await both('light-day-760');
    await resize(1280);
    settle();

    step = 'real-4';
    // Screenshot 32: 7 review requests, 6 unreviewed merges all large or stacked, stacks whose base can merge, and
    // four decisions that also fail or conflict. Next up is full, never empty.
    await resize(1440, 1000);
    await js('document.activeElement?.blur(); window.fixtureOverview.real4()');
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent.startsWith('7 reviews are waiting on you.') && document.querySelectorAll('${section('next')} .morning-row').length === 5 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    soft(await texts('next'), [
      '#376 | STACK: EPIC | seed-launcher | not reviewed · green · unblocks 3 PRs | passing | ~1 min',
      '#383 | fix: keep Steam and Epic store orders in step | service-payment-bridge | not reviewed · green · unblocks 3 PRs | passing | ~1 min',
      '#724 | feat: wallet balance in the HUD | seed | needs a restack | passing | ~5 min',
      '#36990 | feat: throttle the chat presence updates | seed | 117 lines | passing | ~6 min',
      '#720 | The whole MCP | seed | failing checks | 2 failed | ~10 min',
    ], 'Next up, screenshot 32');
    soft(await js(`document.querySelector('${section('next')} .morning-section-summary')?.textContent`), '~23 min');
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')?.textContent`), '4 more ready, not reviewed');
    // ivaremilsson's six: one row, behind a chevron; five at a time.
    soft(await texts('you'), ['ivaremilsson | seed | 6 PRs · oldest 4 d | passing'], 'Waiting on you, collapsed');
    soft(await js(`document.querySelector('${row('you|person:ivaremilsson')}').getAttribute('aria-expanded')`), 'false');
    await click(row('you|person:ivaremilsson'));
    await wait(`document.querySelectorAll('${section('you')} .morning-row.is-nested').length === 6`);
    soft(await js(`document.querySelector('${section('you')} [data-overview-more-row]')?.textContent`), '1 more');
    soft((await texts('decide')).map((text) => text.split(' | ')[0]).sort(), ['#36948', '#380', '#700', '#701']);
    soft(await count('decide'), '4');
    // Waiting on others: plucked, CI, the stacks, and you; the decisions are not listed again.
    soft((await texts('others')).filter((text) => !text.startsWith('#')), [
      'plucked | seed | 1 PR · 10 d | passing',
      'CI | seed | 1 running',
      'Waiting for earlier PRs in a stack to merge | 3 repos | 13 PRs in 4 stacks',
      'feat: add the market and create its first listings | seed | Merge #35392 to unblock 2 PRs | 3 PRs',
      'fix: keep Steam and Epic store orders in step | service-payment-bridge | Merge #383 to unblock 3 PRs | 4 PRs',
      'STACK: EPIC | seed-launcher | Merge #376 to unblock 3 PRs | 4 PRs',
      'Launcher i18n | seed-launcher | #380 has conflicts | 5 PRs',
      'You | 2 repos | 1 failing check, 1 conflict',
    ], 'Waiting on others, screenshot 32');
    soft(await rowSum('others'), Number(await count('others')), 'Waiting on others: heading = rows');
    soft(await rowSum('you'), Number(await count('you')), 'Waiting on you: heading = rows');
    // The base in Next up or Needs a decision is a reference in its chain, not a second line.
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-chain-ref]')].map(r=>r.textContent)`), ['#383in Next upNext', '#376in Next upNext', '#380in Needs a decisionNext']);
    await noneTwice();
    await checksEverywhere();
    await stacked('1440');
    await uncut('1440');
    await click(row('you|person:ivaremilsson'));
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await dismissToasts();
    await both('real4-1440x1000');
    await resize(1920, 1080);
    {
      // Wide: the page keeps its reading width and centres; the toolbar shares its edges.
      const wide = await js<{ left: number; right: number; width: number; title: number; first: number }>(`(()=>{const b=document.querySelector('${P} .overview-body').getBoundingClientRect();const m=document.querySelector('${P} .morning-section').getBoundingClientRect();const t=document.querySelector('${P} .overview h1').getBoundingClientRect();return {left:Math.round(m.left-b.left),right:Math.round(b.right-m.right),width:Math.round(m.width),title:Math.round(t.left),first:Math.round(m.left)}})()`);
      softOk(wide.width <= 1140 && Math.abs(wide.left - wide.right) <= 24, `centred at 1920: ${JSON.stringify(wide)}`);
      softOk(Math.abs(wide.title - wide.first) <= 4, `the title lines up with the sections: ${JSON.stringify(wide)}`);
    }
    await stacked('1920');
    await uncut('1920');
    await both('real4-1920x1080');
    await resize(760, 1000);
    await stacked('760');
    await uncut('760');
    softOk(await everyGroupHasRepo(), 'the repository stays at 760');
    await both('real4-760');
    // The PR preview over the screenshot-32 page.
    await resize(1440, 1000);
    await hover(`${row(`others|stacks|stack:klang/seed#35392|${url('klang/seed', 35392)}`)} .morning-title-text`);
    await wait(`${tooltip}?.textContent.includes('klang/seed #35392')`);
    await both('real4-preview-1440');
    await js(`document.querySelector('${P} .overview-body').scrollTop += 40`);
    await wait(`!${tooltip}`);
    await unhover();
    settle();

    step = 'stacks-5';
    // Screenshot 34: five stacks. The four most actionable first, then "1 more stack"; a chain over five PRs shows its
    // first three, "+2 more", and its last.
    await js('document.activeElement?.blur(); window.fixtureOverview.stacks5()');
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/seed-launcher#379"]') && document.querySelectorAll('${P} [data-overview-stack]').length === 4 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    soft(await js(`[...document.querySelectorAll('${P} .morning-stack-head')].map(${parts})`), [
      'feat: add the market and create its first listings | seed | Merge #35392 to unblock 2 PRs | 3 PRs',
      'fix: keep Steam and Epic store orders in step | service-payment-bridge | Merge #383 to unblock 3 PRs | 4 PRs',
      'STACK: EPIC | seed-launcher | #376 has conflicts | 2 PRs',
      'Launcher i18n | seed-launcher | #379 waits on review from lena | 6 PRs',
    ], 'stack headers, most actionable first');
    soft(await js(`document.querySelector('${P} [data-overview-row="others|stacks|more"]')?.textContent`), '1 more stack');
    const i18n = 'others|stacks|stack:klang/seed-launcher#379';
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-stack="stack:klang/seed-launcher#379"] .morning-chain > li')].map(${parts})`), [
      '#379 | feat: move the launcher’s text into translation keys (i18n 1/3) | passing | Next',
      '#380 | feat: translate the settings page (i18n 2/3) | passing | Ready',
      '#381 | feat: translate the store page (i18n 3/3) | passing | Ready',
      '',
      '#384 | feat: pick the language from the system | passing | Ready',
    ], 'a long chain: three, +2 more, the last');
    soft(await js(`document.querySelector('${P} [data-overview-row="${i18n}|more"]')?.textContent`), '+2 more');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-row-item="${i18n}"] [data-quick-action]')].map(b=>b.textContent)`), ['Nudge']);
    soft(await description(row(`${i18n}|${url('klang/seed-launcher', 380)}`)), '#380, waits for #379 to merge, checks passing');
    softOk(!(await js<boolean>(`!!document.querySelector('${section('others')} .morning-row.depth-2 .morning-chevron')`)), 'no chevrons inside a stack');
    await noneTwice();
    await checksEverywhere();
    await stacked('stacks 1440');
    await uncut('stacks 1440');
    await js(`document.activeElement?.blur(); (()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('stacks5-1440');
    // The fifth stack, waiting on checks, and the whole long chain.
    await click(row('others|stacks|more'));
    await click(row(`${i18n}|more`));
    await wait(`document.querySelectorAll('${P} [data-overview-stack]').length === 5`);
    soft(await rowText(`others|stacks|stack:klang/seed#36948|${url('klang/seed', 36948)}`), '#36948 | fix: keep a construction’s blocking object when an edit fails | running | Next');
    soft(await js(`document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/seed#36948"] .morning-detail')?.textContent`), '#36948 is waiting on checks');
    soft(await js(`document.querySelectorAll('${P} [data-overview-stack="stack:klang/seed-launcher#379"] .morning-chain > li').length`), 6);
    await js(`document.activeElement?.blur(); (()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('stacks5-all-1440');
    await resize(760, 1000);
    await uncut('stacks 760');
    softOk(await noSideways(), 'no sideways scrolling at 760');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('stacks5-760');
    // Collapsed as a whole: one row.
    await click(row('others|stacks'));
    await wait(`document.querySelectorAll('${P} [data-overview-stack]').length === 0`);
    await click(row('others|stacks'));
    await resize(1280);
    settle();

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
    // Review requests need no status; merges wait for it. Unknown checks read "checking…".
    assert.equal(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].filter(b=>b.textContent==='Merge').length`), 0);
    assert.ok(await js(`[...document.querySelectorAll('${P} [data-overview-check="unknown"]')].some(e=>e.textContent==='checking…')`), 'unknown checks say checking…');
    await js('window.fixtureOverview.real()');
    const checkingCount = `Number(document.querySelector('${P} [data-overview-checking]')?.textContent.match(/\\d+/)?.[0] ?? 0)`;
    await wait(`${checkingCount} > 21`);
    const review321 = `next|review|${url('klang/engine', 321)}`;
    await wait(`!!document.querySelector('${row(review321)}')`);
    await js(`document.querySelector('${row(review321)}').focus()`);
    await capture('real-checking-1280-light');
    await js('window.fixtureOverview.answerStatus()');
    await wait(`!document.querySelector('${P} [data-overview-checking]')`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-unchecked]')`), null);
    await wait(`document.querySelectorAll('${section('next')} .morning-row').length === 5 && [...document.querySelectorAll('${section('next')} [data-quick-action]')].filter(b=>b.textContent==='Merge').length === 2`);
    assert.equal(await focusedRow(), review321, 'focus stays while rows arrive');
    await js('document.activeElement?.blur()');
    await capture('real-filled-1280-light');

    step = 'stale-sync';
    const before = (await js<boolean[]>('window.fixtureOverview.discoveries')).length;
    await js('window.fixtureOverview.setSync(2 * 3600000)');
    await wait(`window.fixtureOverview.discoveries.length > ${before}`);
    assert.equal(await js('window.fixtureOverview.discoveries.at(-1)'), false, 'a sync, not a forced refresh');
    await js("window.fixtureOverview.setSync(2 * 3600000, 'checking')");
    await wait(`document.querySelector('${P} [data-overview-syncing]')?.textContent === 'Updating…'`);
    await js('window.fixtureOverview.setSync(60000)');
    await wait(`document.querySelector('${P} .queue-freshness')?.textContent.startsWith('Checked')`);
    settle();

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (misses.length) console.error(`Mismatches:\n${misses.join('\n')}`);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
