/**
 * Overview (#390), the morning page: the briefing and "Since yesterday", Next up (cheapest first, one action each),
 * Waiting on you and Waiting on others (people, blockers, stacks as chains, Nudge), and Needs a decision (Close PR,
 * Snooze). Covers the sections and their words, each PR listed once and every heading equal to its rows, check
 * states and the PR preview on every PR line, the layout full width at 1440 and 1920 and one column at 760, keyboard
 * movement (one tab stop per section, j/k, Enter, A, Z, Shift+F10), descriptions and the live region, Nudge and Close
 * through confirmations with their failures, renders on sync ticks, the tab count, status that starts unknown and
 * fills, a stale sync with one indicator, the sidebar's Overview going to the tab that shows it, the user's real
 * shapes (screenshots 32, 34, 36, 37 and 39), and a light day. Synthetic data only (tests/fixtures/overview.ts).
 *
 * Screenshot 39 at its real volume (real7, about 50 rows): every briefing number is a link to the rows it counts and
 * equals them; no merge nobody reviewed is a Next up row; stacks are one line each until expanded, a step Next up
 * lists is a pointer there, and chain rows say repo#number; one status line; no "green" or "restack"; the fixed row
 * columns are measured.
 *
 * Every PR line leads with its state icon and shows its check state and how long it has waited, in one column that
 * lines up down a section; comment counts show above 0; action buttons carry an icon by type (a write has one, an
 * open has none); a stack header's merge says what it goes ahead without. Every PR line and stack header has the same
 * "…" row menu in one column, and a stack chain shows every PR of its stack in full, linking to the section that also
 * lists one.
 *
 * Screenshots go to .impeccable/review/overview-typeset/, light and dark: the default day at 1280, 1440×1000 and 760, the screenshot-32 shape
 * at 1440×1000, 1920×1080 and 760 wide, its stacks at 1440×1000, the screenshot-34 chains at 1440 and 760, the screenshot-36 shape at
 * 1440×1000, the screenshot-37 shape at 1440×1000 and 760, the screenshot-39 volume at 1440×1000 and 760 with a stack
 * expanded, a light day, and the PR preview.
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
const BRIEFING = 'lena and owen are waiting on your replies, and 6 reviews and 1 re-review are waiting on you. 2 approved PRs can merge, 1 more can merge without review, 1 has failing checks, and 2 have conflicts. 2 PRs need a decision.';
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
  const dir = path.resolve('.impeccable/review/overview-typeset');
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
  // Number, title, repository, detail, comments, check, status, age and a header's count, as each row shows them.
  const parts = `r=>[r.querySelector('.morning-number')?.textContent, r.querySelector('.morning-title-text')?.textContent, r.querySelector('.morning-repo')?.textContent, r.querySelector('.morning-detail')?.textContent, r.querySelector('.morning-comments')?.textContent, r.querySelector('.morning-checks')?.textContent, r.querySelector('.morning-status')?.textContent, r.querySelector('.morning-age')?.textContent, r.querySelector('.morning-meta')?.textContent].filter(Boolean).join(' | ')`;
  const texts = (name: string) => js<string[]>(`[...document.querySelectorAll('${section(name)} .morning-row')].map(${parts})`);
  const rowText = (id: string) => js<string>(`(()=>{const r=document.querySelector('${P} [data-overview-row-item="${id}"]');return r?(${parts})(r):''})()`);
  // A section heading equals the sum of what its top rows say they hold: "2 PRs · …", "1 running", "4 PRs in 2 stacks", "1 failing check, 1 conflict".
  const rowSum = (name: string) => js<number>(`[...document.querySelectorAll('${section(name)} .morning-row:not(.is-nested) .morning-detail')].reduce((t,d)=>{const x=d.textContent;const why=[...x.matchAll(/([0-9]+) (failing check|conflict|needs? rebasing)/g)];return t+(why.length?why.reduce((n,m)=>n+Number(m[1]),0):Number(x.match(/^[0-9]+/)?.[0] ?? 1))},0)`);
  // Every PR the page lists outside stack chains, from each row's data-overview-prs: no PR twice. A chain shows its
  // whole stack, so its lines are exempt; each is a full line, and one another section lists links there.
  const listed = () => js<string[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].filter(r=>!r.closest('.morning-chain')).flatMap(r=>r.dataset.overviewPrs.split(' ').filter(Boolean))`);
  const noneTwice = async () => {
    const all = await listed();
    softOk(all.length > 0, 'PR lines carry data-overview-prs');
    soft(all.filter((value, i) => all.indexOf(value) !== i), [], 'no PR appears twice on the page outside chains');
    const chain = await js<{ id: string; title: string; prs: string; also: string | null; listed: string[] }[]>(`[...document.querySelectorAll('${P} .morning-chain > li:not(.is-gap)')].map(r=>{const a=r.querySelector('[data-overview-also]');const prs=r.dataset.overviewPrs ?? '';return {id:r.dataset.overviewRowItem ?? r.textContent,title:r.querySelector('.morning-title-text')?.textContent ?? (r === r.parentElement.firstElementChild ? r.closest('[data-overview-stack]').querySelector('.morning-stack-head .morning-title-text')?.textContent ?? '' : ''),prs,also:a?.dataset.overviewAlso ?? null,listed:a?[...document.querySelectorAll('${P} .morning-section[data-section="'+a.dataset.overviewAlso+'"] [data-overview-prs]')].map(e=>e.dataset.overviewPrs).filter(v=>v.split(' ').includes(prs)):[]}})`);
    for (const entry of chain) {
      // A base whose title names the stack shows its number alone: the header above it carries the title.
      softOk(entry.title.trim() && entry.prs, `${entry.id}: every chain line is a full line with a title, or the base of a stack its title names`);
      if (entry.also) softOk(entry.listed.length === 1, `${entry.id}: its "${entry.also}" link points at the row that lists it there`);
    }
    softOk(!(await js<boolean>(`!!document.querySelector('${P} [data-overview-chain-ref], ${P} .morning-chain-where') || [...document.querySelectorAll('${P} .morning-chain')].some(c=>/\bin (Next up|Needs a decision|Waiting on you|another section)\b/.test(c.textContent))`)), 'no "in Next up" placeholders in chains');
  };
  // Every PR line shows a check state, and says it in its description.
  const checksEverywhere = async () => {
    const rows = await js<{ id: string; check: string | null; description: string }[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].map(r=>({id:r.dataset.overviewRowItem,check:r.querySelector('[data-overview-check]')?.textContent ?? null,description:r.querySelector('[data-overview-description]')?.textContent ?? ''}))`);
    for (const entry of rows) {
      softOk(entry.check, `${entry.id} shows a check state`);
      softOk(/checks? (passing|running|failed|failing|not read yet)|no checks/.test(entry.description), `${entry.id} says its check state: ${entry.description}`);
    }
  };
  // Every PR line leads with its icon (its GitHub state; a row for several PRs of a stack, the stack icon) and shows its
  // check state and how long it has waited, with the source in the tooltip; its description says the wait.
  const linesComplete = async () => {
    const rows = await js<{ id: string; icon: string | null; state: string | null; prs: number; check: boolean; age: string | null; title: string; description: string }[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].map(r=>{const a=r.querySelector('[data-overview-age]');return {id:r.dataset.overviewRowItem,icon:r.querySelector('[data-overview-icon]')?.dataset.overviewIcon ?? null,state:r.querySelector('[data-pr-state]')?.dataset.prState ?? null,prs:r.dataset.overviewPrs.split(' ').length,check:!!r.querySelector('[data-overview-check]'),age:a?.textContent ?? null,title:a?.title ?? '',description:r.querySelector('[data-overview-description]')?.textContent ?? ''}})`);
    softOk(rows.length > 0, 'there are PR lines');
    for (const entry of rows) {
      softOk(entry.prs > 1 ? entry.icon === 'stack' : entry.icon === 'pr' && !!entry.state, `${entry.id} leads with its icon: ${entry.icon} ${entry.state}`);
      softOk(entry.check, `${entry.id} shows a check state`);
      softOk(entry.age && /^(now|\d+ [mhdw])$/.test(entry.age), `${entry.id} shows its age: ${entry.age}`);
      softOk(/^Waiting since /.test(entry.title), `${entry.id} names the age's source: ${entry.title}`);
      softOk(/waiting (just now|\d+ (minute|hour|day|week)s?)/.test(entry.description), `${entry.id} says its wait: ${entry.description}`);
    }
  };
  // Every PR line, chain lines and Needs a decision included, has the row menu's "…" trigger, and the triggers form
  // one column down the page. Stack headers have it too.
  const menusEverywhere = async (label: string) => {
    const rows = await js<{ id: string; right: number | null }[]>(`[...document.querySelectorAll('${P} [data-overview-prs], ${P} .morning-stack-head')].map(r=>{const t=r.querySelector('.morning-actions .entry-menu-trigger');return {id:r.dataset.overviewRowItem,right:t?Math.round(t.getBoundingClientRect().right):null}})`);
    softOk(rows.length > 0, `${label}: there are PR lines`);
    for (const entry of rows) softOk(entry.right !== null, `${label}: ${entry.id} has the row menu`);
    const rights = [...new Set(rows.map((entry) => entry.right).filter((value) => value !== null))];
    softOk(rights.length === 1, `${label}: the row menus form one column: ${JSON.stringify(rights)}`);
  };
  // Shift+F10 on a line opens its menu; the items, in order.
  const menuItems = async (selector: string) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await key('F10', 8);
    await wait("!!document.querySelector('[role=menuitem]')");
    const items = await js<string[]>("[...document.querySelectorAll('[role=menuitem]')].map(b=>b.textContent)");
    await key('Escape');
    await wait("!document.querySelector('[role=menuitem]')");
    return items;
  };
  // No time estimates anywhere on the page: no "~5 min" or "1 h+" on a row, no total in a heading, none in a tooltip,
  // label or description, and no effort column.
  const noEffort = async (label: string) => {
    const found = await js<string[]>(`(()=>{const o=document.querySelector('${P} .overview');const texts=[o.textContent,...[...o.querySelectorAll('[title],[aria-label],[aria-description]')].flatMap(e=>[e.getAttribute('title'),e.getAttribute('aria-label'),e.getAttribute('aria-description')])].filter(Boolean);return texts.filter(t=>/\\bmin\\b|\\d h\\+|estimated time|about \\d+ minutes?|an hour or more/i.test(t)).map(t=>t.slice(0,120))})()`);
    soft(found, [], `${label}: no effort text on the page`);
    softOk(!(await js<boolean>(`!!document.querySelector('${P} .morning-effort, ${P} .morning-section-summary, ${P} [data-overview-effort]')`)), `${label}: no effort column or total`);
  };
  // Ages line up: one right edge per section.
  const agesAligned = async (label: string) => {
    const edges = await js<[string, number[]][]>(`[...document.querySelectorAll('${P} .morning-section')].map(s=>[s.dataset.section,[...new Set([...s.querySelectorAll('[data-overview-age]')].filter(e=>e.getClientRects().length).map(e=>Math.round(e.getBoundingClientRect().right)))]])`);
    for (const [name, rights] of edges) softOk(rights.length <= 1, `${label}: ${name} ages share one right edge: ${JSON.stringify(rights)}`);
    const all = [...new Set(edges.flatMap(([, rights]) => rights))];
    softOk(all.length <= 1, `${label}: ages line up across sections: ${JSON.stringify(edges)}`);
  };
  // Action buttons carry an icon by type: a write (Merge, Rerun failed, Nudge, Close PR, Snooze) has its icon, an
  // action that only opens (Review, Re-review, Reply, Open, Open #N) has none.
  const WRITES = ['Merge', 'Rerun failed', 'Nudge', 'Close PR', 'Snooze'];
  const OPENS = ['Review', 'Re-review', 'Reply', 'Open'];
  const buttonIcons = async () => {
    const buttons = await js<{ label: string; icons: string[] }[]>(`[...document.querySelectorAll('${P} .morning-actions button')].filter(b=>!b.classList.contains('entry-menu-trigger')).map(b=>({label:(b.textContent.trim() || b.getAttribute('aria-label') || '').replace(/ #\\d+$/,''),icons:[...b.querySelectorAll('svg')].map(s=>[...s.classList].find(c=>c.startsWith('lucide-')) ?? '')}))`);
    const byType = new Map<string, Set<string>>();
    for (const { label, icons } of buttons) byType.set(label, (byType.get(label) ?? new Set()).add(icons.join(',')));
    for (const [label, shapes] of byType) {
      softOk(shapes.size === 1, `every ${label} button has the same icon: ${[...shapes].join(' / ')}`);
      if (WRITES.includes(label)) softOk([...shapes].every((shape) => shape.length > 0), `${label} carries its icon`);
      if (OPENS.includes(label)) softOk([...shapes].every((shape) => shape === ''), `${label} carries no icon`);
    }
    return byType;
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
  // Stacks are one line until expanded: open every stack shown, so its chain's lines are on the page.
  const expandStacks = async () => {
    await js(`[...document.querySelectorAll('${P} .morning-stack-head [data-overview-row][aria-expanded="false"]')].forEach(b=>b.click())`);
    await wait(`!document.querySelector('${P} .morning-stack-head [data-overview-row][aria-expanded="false"]')`);
  };
  const collapseStacks = async () => {
    await js(`[...document.querySelectorAll('${P} .morning-stack-head [data-overview-row][aria-expanded="true"]')].forEach(b=>b.click())`);
    await wait(`!document.querySelector('${P} .morning-stack-head [data-overview-row][aria-expanded="true"]')`);
  };
  // The fixed columns of a row: everything on its line but the title button (the title's room), in px.
  const fixedWidth = (selector: string) => js<{ fixed: number; number: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)});const i=r.querySelector('.morning-row-inner');const t=i.querySelector('.morning-title');const n=t.querySelector('.morning-number');return {fixed:Math.round(i.getBoundingClientRect().width - t.getBoundingClientRect().width), number:Math.round(n ? n.getBoundingClientRect().width + 8 : 0)}})()`);
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
    // Next up: people blocked on you first (the explained review, the re-review, the reply, then the larger reviews),
    // cheapest first; the approved merges and the one nobody reviewed wait on the quiet line.
    soft(await texts('next'), [
      '#321 | Stream build logs to the dashboard | engine | 25 lines · explanation ready | passing | 5 d',
      '#312 | Document the plugin loading order | engine | owen: “Could we keep the old loading order behind a flag until…” | 1 | passing | 3 h',
      '#322 | Add a dry-run flag to the release script | cli | 71 lines | passing | 4 d',
      // Its size since your review is not known (no compare read): it ranks as a mid-sized re-review.
      '#324 | Replace the legacy config parser | engine | updated since your review | passing | 3 d',
      '#323 | Batch telemetry writes per request | web | 117 lines | passing | 3 d',
    ], 'Next up');
    await noEffort('sample');
    soft(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].map(b=>b.textContent)`), ['Review', 'Reply', 'Review', 'Re-review', 'Review']);
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')?.textContent`), '1 ready to merge without review · 2 more approved and ready to merge', 'merges no row lists are counted on the quiet line');
    // Waiting on you: by person, oldest wait first; a few PRs are listed inline, number first. A PR in Next up is not here.
    soft(await texts('you'), [
      'lena | web | 1 PR · oldest 4 d | passing',
      '#311 | Move session refresh into the auth worker | passing | 4 d',
      'ivar | cli | 1 PR · oldest 2 d | passing',
      '#325 | Show lockfile drift in CI output | passing | 2 d',
      'maya | web | 1 PR · oldest 2 d | passing',
      '#326 | Tighten the retry budget for webhooks | passing | 2 d',
      'sam | engine | 1 PR · oldest 1 d | passing',
      '#327 | Index workspace symbols lazily | passing | 1 d',
    ], 'Waiting on you');
    soft(await count('you'), '4');
    soft(await rowSum('you'), 4, 'Waiting on you: heading = rows');
    // The PRs waiting on you that Next up lists, by name, as a link.
    soft(await js(`document.querySelector('${section('you')} [data-overview-you-elsewhere]')?.textContent`), '#321, #312 and 3 more are in Next up.');
    // Waiting on others: lena with Nudge, CI, the stacks as one line each, and you.
    soft(await texts('others'), [
      'lena | cli | 1 PR · 4 d | passing',
      '#341 | Print a summary after install | passing | 4 d',
      'CI | engine | 1 running',
      '#342 | Profile cold starts in CI | running | 6 h',
      'Waiting for earlier PRs in a stack to merge | 2 repos | 4 PRs in 2 stacks',
      'Split the scheduler into phases | engine | 2 PRs · #331 has failing checks',
      'Extract the billing form state | web | 2 PRs · #306 waits on review from lena',
      'You | web | 1 conflict',
      '#333 | Upgrade the router to v7 | Conflicts | passing | 9 h',
    ], 'Waiting on others');
    soft(await js(`document.querySelectorAll('${P} .morning-chain').length`), 0, 'stacks are one line until expanded');
    soft(await count('others'), '7');
    soft(await rowSum('others'), 7, 'Waiting on others: heading = rows');
    soft(await js(`[...document.querySelectorAll('${section('others')} [data-quick-action]')].map(b=>b.textContent)`), ['Nudge', 'Open #331', 'Nudge', 'All 1', 'Open']);
    soft(await texts('decide'), ['#305 | Inline the hot path in the resolver | engine | Idle | passing | 8 d', '#304 | Rename the config loader flags | cli | Idle | passing | 7 d']);
    softOk(await everyGroupHasRepo(), 'every group names its repository');
    await noneTwice();
    await checksEverywhere();
    await linesComplete();
    await agesAligned('1280');
    // The one PR with a comment shows the queue row's badge; PRs with none show nothing.
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-comments]')].map(e=>[e.closest('[data-overview-row-item]').dataset.overviewRowItem, e.textContent, e.title])`), [
      [`next|answer|${url('klang/engine', 312)}`, '1', '1 comment, including inline review comments'],
    ], 'comment counts above 0 only');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-age-source]')].find(e=>e.closest('[data-overview-row-item="next|review|${url('klang/engine', 321)}"]'))?.title.split(',')[0]`), 'Waiting since the PR was opened', 'the age names its source');
    // People lead with their avatar, stacks with the stack icon, CI with the Checks icon.
    soft(await js(`['others|person:lena','others|ci','others|stacks','others|stacks|stack:acme/web#306','others|you'].map(id=>document.querySelector('${P} [data-overview-row-item="'+id+'"] [data-overview-icon]')?.dataset.overviewIcon)`), ['person', 'ci', 'stack', 'stack', 'person']);
    // The tab title counts Next up and Waiting on you, each PR once: the 7 reviews and the 2 PRs waiting on your reply.
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(9)'");
    // One status line in the header; the section titles at the section step, with the count inline.
    softOk(/^Updated (just now|\d+m ago)$/.test(await js<string>(`document.querySelector('${P} [data-overview-status-line]')?.textContent ?? ''`)), 'one status line: Updated …');
    soft(await js(`getComputedStyle(document.querySelector('${section('next')} h2')).fontSize`), '18px', 'section titles use the 18px section step');
    soft(await js(`document.querySelector('${section('next')} h2').textContent`), 'Next up5', 'the count is inline in the heading');
    soft(await js(`document.querySelector('${P} [data-overview-briefing]').getAttribute('role')`), null, 'the briefing is not a status region');
    // Each briefing number is a link to the rows it counts.
    soft(await js(`[...document.querySelectorAll('${P} [data-briefing-count]')].map(b=>[b.dataset.briefingCount, b.textContent])`), [
      ['replies', 'your replies'], ['reviews', '6 reviews'], ['rereviews', '1 re-review'], ['approved', '2 approved PRs'], ['unreviewed', '1 more'], ['failing', '1'], ['conflicts', '2'], ['decide', '2 PRs'],
    ]);
    // The type ramp: 15px regular PR titles, 13px semibold group headers over them, and one 12px muted caption for a
    // line's number, repository, detail, check, comments and age, with tabular numerals; briefing links dotted at rest.
    const type = (selector: string) => js<string>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return 'missing';const s=getComputedStyle(e);return [s.fontSize,s.fontWeight,s.fontVariantNumeric].join(' ')})()`);
    const next321 = row(`next|review|${url('klang/engine', 321)}`);
    soft(await type(`${next321} .morning-title-text`), '15px 400 normal', 'PR titles: 15px regular');
    soft(await type(`${row('others|person:lena')} .morning-title-text`), '13px 600 normal', 'group headers: 13px semibold');
    for (const part of ['.morning-number', '.morning-repo', '.morning-detail'])
      soft(await type(`${next321} ${part}`), `12px 400 ${part === '.morning-repo' ? 'normal' : 'tabular-nums'}`, `${part} is the caption`);
    for (const part of ['.morning-checks', '.morning-age'])
      soft((await type(`${P} [data-overview-row-item="next|review|${url('klang/engine', 321)}"] ${part}`)).replace(/ \S+$/, ''), '12px 400', `${part} is the caption`);
    soft(await js(`getComputedStyle(document.querySelector('${P} [data-briefing-count]')).textDecorationStyle`), 'dotted', 'briefing links are dotted at rest');
    await js(`document.activeElement?.blur()`);
    await both('default-1280');
    await resize(1440, 1000);
    await both('default-1440x1000');
    await resize(760, 1000);
    await both('default-760');
    await resize(1280);
    settle();

    step = 'harden';
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} [aria-describedby="overview-keyboard-help"]')].map(e=>e.className)`), ['overview']);
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-row][tabindex="0"]').length`), 4, 'one roving tab stop per section');
    assert.equal(await js(`[...document.querySelectorAll('${P} .morning-actions button')].every(b=>b.tabIndex===-1)`), true, 'actions and menus are out of the tab order');
    soft(await description(row(`next|review|${url('klang/engine', 321)}`)), 'Review, 25 lines · explanation ready, engine #321, checks passing, waiting 5 days');
    soft(await description(row(`next|answer|${url('klang/engine', 312)}`)), 'Reply, owen: “Could we keep the old loading order behind a flag until…”, engine #312, checks passing, 1 comment, waiting 3 hours');
    soft(await description(row('others|person:lena')), 'lena, cli, 1 PR · 4 days, checks passing. A nudges');
    soft(await description(row('others|stacks|stack:acme/web#306')), 'Stack Extract the billing form state · web · 2 PRs · #306 waits on review from lena. Collapsed. A nudges');
    // Enter (or a click) expands a stack to its chain.
    await js(`document.querySelector('${row('others|stacks|stack:acme/web#306')}').focus()`);
    await key('Enter');
    await wait(`!!document.querySelector('${row(`others|stacks|stack:acme/web#306|${url('acme/web', 307)}`)}')`);
    soft(await description(row(`others|stacks|stack:acme/web#306|${url('acme/web', 307)}`)), '#307, waiting, after #306, checks passing, waiting 9 hours');
    soft(await description(row(`others|you|${url('acme/web', 333)}`)), '#333, conflicts, checks passing, waiting 9 hours');
    soft(await description(row('decide|merge|' + url('klang/engine', 305))), 'Idle, engine #305, checks passing, waiting 8 days. A closes, Z snoozes');
    soft(await js(`document.querySelector('${P} [data-overview-stack="stack:acme/web#306"] .morning-chain').getAttribute('aria-label')`), 'Stack Extract the billing form state · web · 2 PRs · #306 waits on review from lena');
    await js(`document.querySelector('${row('others|stacks|stack:acme/web#306')}').click()`);
    await wait(`!document.querySelector('${P} [data-overview-stack="stack:acme/web#306"] .morning-chain')`);
    // Waiting on others' tab stop goes back to its first row.
    await js(`document.querySelector('${row('others|person:lena')}').focus(); document.activeElement.blur()`);
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
    const first = row(`next|review|${url('klang/engine', 321)}`);
    await js(`document.querySelector('${first}').focus()`);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(await js(`!!${tooltip}`), false, 'focus waits before the preview opens');
    await wait(`${tooltip}?.textContent.includes('klang/engine #321') && !!${tooltip}.querySelector('.pr-badge-preview')`);
    assert.equal(await js(`document.querySelector('[role=tooltip]')?.textContent.includes('klang/engine #321')`), true, 'the same tooltip role as elsewhere');
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
    assert.equal(await focusedRow(), `you|person:lena|${url('acme/web', 311)}`, 'a person’s PRs follow it, inline');
    await key('Tab', 8);
    assert.equal(await focusedRow(), next.at(-1), 'Shift+Tab returns to the section’s last focused row');
    await key('Tab');
    await key('Tab');
    // Waiting on you's pointer to Next up is a link of its own, between the sections.
    assert.equal(await js(`document.activeElement?.dataset.overviewPointer ?? null`), 'next', 'the pointer is a link in the tab order');
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
    const line322 = row(`you|person:ivar|${url('klang/cli', 325)}`);
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
    await wait(`(document.querySelector('${P} [data-overview-row-item="next|review|${url('acme/web', 323)}"] .morning-title-text')?.textContent ?? '') === 'Batch every telemetry write per request'`);
    assert.equal(await focusedRow(), focused, 'focus stays on the row');
    await wait(`document.querySelector('${P} [data-overview-announcement]').textContent.includes('Waiting on others')`);

    step = 'light-day';
    await js('document.activeElement?.blur(); window.fixtureOverview.restore(); window.fixtureOverview.only([311, 321, 323, 302])');
    await wait(`document.querySelectorAll('${section('decide')} .morning-empty').length === 1 && document.querySelectorAll('${section('next')} .morning-row').length === 4`);
    assert.equal(await briefing(), 'lena is waiting on your reply, and 2 reviews are waiting on you. 1 approved PR can merge.');
    soft(await texts('next'), [
      '#321 | Stream build logs to the dashboard | engine | 25 lines · explanation ready | passing | 5 d',
      '#323 | Batch every telemetry write per request | web | 117 lines | passing | 3 d',
      '#311 | Move session refresh into the auth worker | web | lena requested changes | passing | 4 d',
      '#302 | Retry flaky uploads with jitter | cli | approved by sam and 1 other | passing | 5 h',
    ], 'light day');
    // Waiting on you is empty because Next up lists its three PRs, and says which, as a link.
    soft(await js(`document.querySelector('${section('you')} .morning-empty')?.textContent`), '#321, #323 and #311 are in Next up.');
    // A light day still says what changed since yesterday, or that nothing did.
    softOk((await js<string>(`document.querySelector('${P} [data-overview-since]')?.textContent ?? ''`)).length > 0, 'the Since line is always there once a visit is known');
    soft(await js(`document.querySelector('${section('decide')} .morning-empty')?.textContent`), 'Nothing to decide. None of your PRs has been stuck for over a week.');
    await dismissToasts();
    await new Promise((r) => setTimeout(r, 400));
    await both('light-day-1280');
    await resize(760);
    await both('light-day-760');
    await resize(1280);
    settle();

    step = 'real-4';
    // Screenshot 32: 7 review requests, 6 unreviewed merges all large or stacked, stacks whose base can merge without
    // review, and four decisions that also fail or conflict. Next up is full of the reviews; the merges wait on the
    // quiet line.
    await resize(1440, 1000);
    await js('document.activeElement?.blur(); window.fixtureOverview.real4()');
    await wait(`document.querySelector('${P} [data-overview-briefing]')?.textContent.startsWith('7 reviews (3 in one stack) are waiting on you.') && document.querySelectorAll('${section('next')} .morning-row').length === 5 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    await collapseStacks();
    soft((await texts('next')).map((text) => text.split(' | ')[0]), ['#36990', '#394', '#391', '#392', '#393'], 'Next up, screenshot 32: people blocked on you first');
    soft(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].map(b=>b.textContent)`), ['Review', 'Review', 'Review', 'Review', 'Review'], 'no merge nobody reviewed is a row');
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')?.textContent`), '6 ready to merge without review');
    await noEffort('screenshot 32');
    soft(await count('you'), '0');
    soft((await texts('decide')).map((text) => text.split(' | ')[0]).sort(), ['#36948', '#380', '#700', '#701']);
    soft(await count('decide'), '4');
    // Waiting on others: plucked, CI, the stacks one line each, and you; the decisions are not listed again.
    soft((await texts('others')).filter((text) => !text.startsWith('#')), [
      'plucked | seed | 1 PR · 10 d | passing',
      'CI | seed | 1 running',
      'Waiting for earlier PRs in a stack to merge | 3 repos | 15 PRs in 4 stacks',
      'STACK: EPIC | seed-launcher | 4 PRs · Merge #376 (not reviewed) to unblock 3 PRs',
      'feat: add the market and create its first listings | seed | 3 PRs · Merge #35392 (not reviewed) to unblock 2 PRs',
      'fix: keep Steam and Epic store orders in step | service-payment-bridge | 4 PRs · Merge #383 (not reviewed) to unblock 3 PRs',
      'Launcher i18n | seed-launcher | 5 PRs · #380 has conflicts',
      'You | 3 repos | 2 failing checks, 1 conflict, 1 needs rebasing',
    ], 'Waiting on others, screenshot 32');
    // A stack header whose base nobody reviewed opens it instead of merging.
    soft(await js(`[...document.querySelectorAll('${P} .morning-stack-head [data-quick-action]')].map(b=>b.textContent)`), ['Open #376', 'Open #35392', 'Open #383', 'Open #380']);
    soft(await rowSum('others'), Number(await count('others')), 'Waiting on others: heading = rows');
    // Expanded, a base Needs a decision lists is still a full line in its chain, and ends in a quiet link there.
    await expandStacks();
    soft(await js(`[...document.querySelectorAll('${P} .morning-chain [data-overview-also]')].map(a=>[a.closest('[data-overview-row-item]').querySelector('.morning-number').textContent, a.textContent, a.getAttribute('aria-label'), [...a.querySelector('svg').classList].find(c=>c.startsWith('lucide-'))])`), [
      ['seed-launcher#380', 'Needs a decision', 'Also listed in Needs a decision', 'lucide-arrow-down'],
    ], 'chain lines listed elsewhere link there');
    // A on a chain line follows its link: #380 goes down to Needs a decision.
    const i18n380 = `others|stacks|stack:klang/seed-launcher#380|${url('klang/seed-launcher', 380)}`;
    await js(`document.querySelector('${row(i18n380)}').focus()`);
    await key('a');
    await wait(`document.activeElement?.closest('${section('decide')}') !== null && document.activeElement?.closest('[data-overview-prs]')?.dataset.overviewPrs === '${url('klang/seed-launcher', 380)}'`);
    softOk(await js<boolean>(`(()=>{const r=document.activeElement.getBoundingClientRect();const b=document.querySelector('${P} .overview-body').getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom})()`), 'the row it links to is scrolled into view');
    // The same "…" menu on every PR line, in one column; Shift+F10 opens it on a chain line and a decision alike.
    await menusEverywhere('real4 1440');
    const PR_MENU = ['Open', 'Snooze PR…', 'Mark as read', 'Copy link', 'Copy repository', 'Copy PR number', 'Open on GitHub'];
    soft(await menuItems(row(`others|stacks|stack:klang/service-payment-bridge#383|${url('klang/service-payment-bridge', 384)}`)), PR_MENU, 'Shift+F10 on a chain line');
    soft(await menuItems(`${section('decide')} [data-overview-prs="${url('klang/seed-launcher', 380)}"] [data-overview-row]`), PR_MENU, 'Shift+F10 on a Needs a decision line');
    soft(await menuItems(row('others|stacks|stack:klang/service-payment-bridge#383')), ['Open', 'Snooze stack…', 'Mark as read'], 'Shift+F10 on a stack header');
    await noneTwice();
    await checksEverywhere();
    await linesComplete();
    await agesAligned('real4 1440');
    await stacked('1440');
    await uncut('1440');
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await dismissToasts();
    await both('real4-1440x1000');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-row="others|stacks"]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-60})()`);
    await both('stacks-real4-1440x1000');
    // A hovered chain line shows its "…" menu in the same column as every other line's. The pointer rests on its age,
    // away from the title's PR preview.
    const [hx, hy] = await js<[number, number]>(`(()=>{const r=document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/service-payment-bridge#383|${url('klang/service-payment-bridge', 384)}"] .morning-age').getBoundingClientRect();return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]})()`);
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
    await both('stacks-real4-menu-1440x1000');
    await unhover();
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
    await hover(`${row(`others|stacks|stack:klang/seed#35392|${url('klang/seed', 35392)}`)} .morning-number`);
    await wait(`${tooltip}?.textContent.includes('klang/seed #35392')`);
    await both('real4-preview-1440');
    await js(`document.querySelector('${P} .overview-body').scrollTop += 40`);
    await wait(`!${tooltip}`);
    await unhover();
    await collapseStacks();
    settle();

    step = 'stacks-5';
    // Screenshot 34: five stacks, one line each. The four most actionable first, then "1 more stack"; expanded, a
    // chain over five PRs shows its first three, "+2 more", and its last. Three repositories: chain rows say repo#number.
    await js('document.activeElement?.blur(); window.fixtureOverview.stacks5()');
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/seed-launcher#379"]') && document.querySelectorAll('${P} [data-overview-stack]').length === 4 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    await collapseStacks();
    soft(await js(`[...document.querySelectorAll('${P} .morning-stack-head')].map(${parts})`), [
      'feat: add the market and create its first listings | seed | 3 PRs · Merge #35392 (not reviewed) to unblock 2 PRs',
      'fix: keep Steam and Epic store orders in step | service-payment-bridge | 4 PRs · Merge #383 (not reviewed) to unblock 3 PRs',
      'STACK: EPIC | seed-launcher | 2 PRs · #376 has conflicts',
      'Launcher i18n | seed-launcher | 6 PRs · #379 waits on review from lena',
    ], 'stack headers, one line each, most actionable first');
    soft(await js(`document.querySelectorAll('${P} .morning-chain').length`), 0, 'no chain until a stack is expanded');
    soft(await js(`document.querySelector('${P} [data-overview-row="others|stacks|more"]')?.textContent`), '1 more stack');
    const i18n = 'others|stacks|stack:klang/seed-launcher#379';
    await click(row(i18n));
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/seed-launcher#379"] .morning-chain')`);
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-stack="stack:klang/seed-launcher#379"] .morning-chain > li')].map(${parts})`), [
      'seed-launcher#379 | feat: move the launcher’s text into translation keys (i18n 1/3) | passing | Next | 6 d',
      'seed-launcher#380 | feat: translate the settings page (i18n 2/3) | passing | Waiting | 5 h',
      'seed-launcher#381 | feat: translate the store page (i18n 3/3) | passing | Waiting | 4 h',
      '',
      'seed-launcher#384 | feat: pick the language from the system | passing | Waiting | 1 h',
    ], 'a long chain: three, +2 more, the last');
    soft(await js(`document.querySelector('${P} [data-overview-row="${i18n}|more"]')?.textContent`), '+2 more PRs in this stack', 'the name includes the visible words');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-row-item="${i18n}"] [data-quick-action]')].map(b=>b.textContent)`), ['Nudge']);
    soft(await description(row(`${i18n}|${url('klang/seed-launcher', 380)}`)), '#380, waiting, after #379, checks passing, waiting 5 hours');
    softOk(!(await js<boolean>(`[...document.querySelectorAll('${P} .morning-chain .morning-status')].some(e=>e.textContent==='Ready')`)), 'no chain says Ready');
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
    await expandStacks();
    soft(await rowText(`others|stacks|stack:klang/seed#36948|${url('klang/seed', 36948)}`), 'seed#36948 | running | Next | 1 m', 'an unnamed stack is called by its base: the base shows its number alone');
    soft(await js(`document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/seed#36948"] .morning-detail')?.textContent`), '2 PRs · #36948 is waiting on checks');
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
    await collapseStacks();
    await resize(1280);
    settle();

    step = 'real-5';
    // Screenshot 36: a stack whose base can merge without review and whose other PRs need your re-review, a lone
    // re-review, six large merges nobody reviewed, and every review in Next up. No merge nobody reviewed is a row.
    await resize(1440, 1000);
    await js('document.activeElement?.blur(); window.fixtureOverview.real5()');
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/seed-launcher#376"]') && document.querySelectorAll('${section('next')} .morning-row').length === 3 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    await collapseStacks();
    soft(await briefing(), '1 review and 7 re-reviews (6 in one stack) are waiting on you. 8 PRs can merge without review.');
    // The heading is the rows; the stack row says "6 PRs" and leads with its first PR's number.
    soft(await count('next'), '3', 'Next up: heading = rows');
    soft(await texts('next'), [
      '#37601 | feat: add the market and create_seedling mcp tools to seed-api | seed | 6 PRs · +42 lines since your review · then merge #35392 | passing | 5 h',
      '#377 | feat: block launches until the player accepts the terms in the launcher | seed-launcher | +42 lines since your review | passing | 5 h',
      '#36990 | feat: throttle the chat presence updates | seed | 117 lines | passing | 6 d',
    ], 'Next up, screenshot 36');
    soft(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].map(b=>b.textContent)`), ['Re-review', 'Re-review', 'Review'], 'no Merge row for a PR nobody reviewed');
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')?.textContent`), '8 ready to merge without review');
    // Waiting on you: empty because Next up lists all eight, and it says which rows hold them.
    soft(await count('you'), '0');
    soft(await js(`document.querySelector('${section('you')} .morning-empty')?.textContent`), '#37601’s stack (6 PRs), #377 and #36990 are in Next up.');
    // The stack's next step is its re-review, a Next up row: its line points there, with no action of its own.
    const market = 'others|stacks|stack:klang/seed#35392';
    soft(await rowText(market), 'feat: add the market and create_seedling mcp tools to seed-api | seed | 3 PRs');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-row-item="${market}"] [data-quick-action]')].map(b=>b.textContent)`), ['next step in Next up']);
    await click(`${P} [data-overview-row-item="${market}"] [data-overview-next-step]`);
    await wait(`document.activeElement?.closest('${section('next')}') !== null && document.activeElement?.closest('[data-overview-prs]')?.dataset.overviewPrs.split(' ').length === 6`);
    await expandStacks();
    // Two repositories on the page: chain rows say repo#number. The market stack is named by its base's title, so
    // the base's line shows its number alone.
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-stack="stack:klang/seed#35392"] .morning-chain > li')].map(${parts})`), [
      'seed#35392 | passing | Next | 1 h',
      'seed#37378 | chore: keep the small types of one responsibility in one file across seed-api | passing | Waiting | 1 h',
      'seed#37578 | feat: one seed-api event pipeline with pluggable kinds and a my_events pull tool | passing | Waiting | 1 h',
    ], 'the chain: Next, then Waiting');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-stack="stack:klang/seed-launcher#376"] .morning-chain > li')].map(${parts})`), [
      'seed-launcher#376 | refactor: model the store distribution channel instead of Steam-only flags | passing | Next | 2 h',
      'seed-launcher#382 | fix: quit a store-launched launcher when its last window closes | passing | Waiting | 2 h',
      'seed-launcher#378 | feat: log in with Epic on Epic Games Store launches (L3) | passing | Waiting | 2 h',
      'seed-launcher#385 | feat: import Epic purchases after an Epic login, before play (L3b) | passing | Waiting | 2 h',
    ], 'EPIC: its base a full line, the rest Waiting');
    soft(await description(row(`${market}|${url('klang/seed', 37378)}`)), '#37378, waiting, after #35392, checks passing, waiting 1 hour');
    soft(await rowSum('others'), Number(await count('others')), 'Waiting on others: heading = rows');
    await noneTwice();
    await checksEverywhere();
    await stacked('real5 1440');
    await uncut('real5 1440');
    // The tab counts the PRs in Next up and Waiting on you, each once: 6 + 1 + 1.
    await wait("document.querySelector('.workspace-tab .workspace-tab-count')?.textContent === '(8)'");
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await dismissToasts();
    await both('real5-1440x1000');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('real5-stacks-1440x1000');
    await collapseStacks();
    await resize(1280);
    settle();

    step = 'real-6';
    // Screenshot 37: icons, comments and ages on every PR line; a stack header's merge says what it lacks; conflicts
    // carry the conflict icon; the Next up detail stays readable at 1440 and the title gives way first.
    await resize(1440, 1000);
    await js('document.activeElement?.blur(); window.fixtureOverview.real6()');
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/seed-launcher#376"]') && document.querySelectorAll('${section('next')} .morning-row').length === 5 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    await collapseStacks();
    soft(await count('next'), '5', 'Next up: heading = rows');
    soft((await texts('next')).map((text) => text.split(' | ')[0]), ['#37286', '#377', '#35391', '#36990', '#385'], 'Next up, screenshot 37: re-reviews, then fixes; no merge nobody reviewed');
    // The draft rebase leads with the draft icon; the re-review of six PRs with the stack icon.
    soft(await js(`[...document.querySelectorAll('${section('next')} .morning-row')].map(r=>[r.querySelector('.morning-number')?.textContent, r.querySelector('[data-overview-icon]')?.dataset.overviewIcon, r.querySelector('[data-pr-state]')?.dataset.prState ?? null]).sort()`), [
      ['#35391', 'pr', 'draft'], ['#36990', 'pr', 'open'], ['#37286', 'stack', null], ['#377', 'pr', 'open'], ['#385', 'pr', 'open'],
    ], 'Next up icons: state, draft, stack');
    soft(await js(`[...document.querySelectorAll('${section('next')} .morning-detail')].map(e=>e.textContent)[2]`), 'needs rebasing after #35390 merged', 'rebasing in plain words');
    // The title takes the row's room at 1440: titles are whole, and a detail that does not fit truncates first.
    soft(await js<string[]>(`[...document.querySelectorAll('${section('next')} .morning-title-text')].filter(e=>e.scrollWidth > e.clientWidth + 1).map(e=>e.textContent)`), [], 'Next up titles are not cut at 1440');
    softOk(await js<boolean>(`[...document.querySelectorAll('${section('next')} .morning-detail')].some(e=>e.textContent.endsWith('then merge #35392'))`), 'the re-review says what follows it');
    // No effort column: the age, with the waiting icon, sits right before the actions.
    soft(await js(`(()=>{const r=document.querySelector('${section('next')} .morning-row');const a=r.querySelector('.morning-age');return [!!r.querySelector('.morning-effort'), !!a?.querySelector('svg.lucide-hourglass'), a?.nextElementSibling?.className]})()`), [false, true, 'morning-actions']);
    // Comments: the queue row's badge, above 0 only, and in the description.
    const comments = await js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('${P} [data-overview-comments]')].map(e=>[e.closest('[data-overview-row-item]').querySelector('.morning-number')?.textContent ?? e.closest('[data-overview-row-item]').dataset.overviewRowItem, e.textContent]))`);
    soft(comments['#377'], '12', 'the lone re-review has 12 comments');
    softOk(!(await js<boolean>(`[...document.querySelectorAll('${P} [data-overview-comments]')].some(e=>e.textContent==='0')`)), 'no badge reads 0');
    softOk(!(await js<boolean>(`[...document.querySelectorAll('${P} .morning-comments:not([data-overview-comments])')].some(e=>e.textContent.trim()||e.querySelector('svg'))`)), 'a PR with no comments shows nothing');
    soft(await description(row(`next|review|${url('klang/seed-launcher', 377)}`)), 'Re-review, +42 lines since your review, seed-launcher #377, checks passing, 12 comments, waiting 5 hours');
    // EPIC: no checks and nobody reviewed it; its header and its Merge button say so, as Next up words it.
    const epic = 'others|stacks|stack:klang/seed-launcher#376';
    soft(await js(`document.querySelector('${P} [data-overview-row-item="${epic}"] .morning-detail')?.textContent`), '4 PRs · Merge #376 (not reviewed, no checks) to unblock 3 PRs');
    // Its button opens #376: no Merge for a base nobody reviewed or without checks.
    soft(await js(`[document.querySelector('${P} [data-overview-row-item="${epic}"] [data-quick-action]')?.textContent, document.querySelector('${P} [data-overview-row-item="${epic}"] [data-quick-action]')?.title]`), ['Open #376', 'Open #376, refactor: model the store distribution channel instead of Steam-only checks (not reviewed, no checks) · A']);
    soft(await js(`document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/service-payment-bridge#383"] .morning-detail')?.textContent`), '4 PRs · Merge #383 (not reviewed) to unblock 3 PRs');
    await expandStacks();
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-comments]')].filter(e=>e.closest('.morning-chain')).map(e=>[e.closest('[data-overview-row-item]').querySelector('.morning-number').textContent, e.textContent]).find(([n])=>n==='service-payment-bridge#383')?.[1]`), '3', '#383 shows its 3 comments in its chain');
    soft(await js(`document.querySelector('${P} [data-overview-row-item="${epic}"] [data-overview-icon]')?.dataset.overviewIcon`), 'stack');
    // Conflicts: the later chain PR keeps its Conflicts status, with the app's conflict icon; so do the i18n header and
    // the decision for its base.
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-status="conflicts"]')].map(e=>[e.closest('[data-overview-row-item]').querySelector('.morning-number').textContent, e.textContent, !!e.querySelector('svg.lucide-git-merge-conflict')])`), [['service-payment-bridge#385', 'Conflicts', true]]);
    softOk(await js<boolean>(`!!document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/seed-launcher#379"] .morning-detail svg.lucide-git-merge-conflict')`), 'the i18n header names its conflicts with the icon');
    softOk(await js<boolean>(`[...document.querySelectorAll('${section('decide')} .morning-row')].some(r=>r.querySelector('.morning-number')?.textContent==='#379' && !!r.querySelector('.morning-detail svg.lucide-git-merge-conflict'))`), 'the decision for #379 shows its conflicts');
    softOk(!(await js<boolean>(`!!document.querySelector('${P} svg.lucide-triangle-alert')`)), 'no warning triangle stands for conflicts');
    // Needs a decision: the reason in words, the age in its column.
    soft((await texts('decide')).slice(0, 2), ['#371 | fix: build the Icon Composer app icon on the mac runner | seed-launcher | Failing checks | 2 failed | 13 d', '#35316 | perf: keep unity’s terrain heights as 16-bit integers in the polygon navmesh | seed | Idle | 2 | passing | 13 d']);
    await linesComplete();
    await agesAligned('real6 1440');
    await noneTwice();
    await checksEverywhere();
    await stacked('real6 1440');
    await uncut('real6 1440');
    // Button icons by type, over every row the page shows now.
    const icons = await buttonIcons();
    for (const label of ['Re-review', 'Open', 'Nudge', 'Close PR', 'Rerun']) softOk(icons.has(label), `the page shows a ${label} button`);
    soft(await js(`[...document.querySelectorAll('${P} .morning-actions button')].filter(b=>b.textContent.trim()==='Merge').length`), 0, 'nobody reviewed these merges: no Merge button anywhere');
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await dismissToasts();
    await both('real6-1440x1000');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('real6-stacks-1440x1000');
    await js(`(()=>{const e=document.querySelector('${section('decide')}');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-200})()`);
    await both('real6-decide-1440x1000');
    await resize(760, 1000);
    await stacked('real6 760');
    await uncut('real6 760');
    softOk(await noSideways(), 'no sideways scrolling at 760');
    await linesComplete();
    await js(`document.querySelector('${P} .overview-body').scrollTop = 0`);
    await both('real6-760');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-stack]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-80})()`);
    await both('real6-stacks-760');
    await collapseStacks();
    await resize(1280);
    settle();

    step = 'real-7';
    // Screenshot 39 at its real volume, about 50 rows. Every briefing number equals the rows it links to; no merge
    // nobody reviewed is a row; stacks are one line each; the dots mark real changes only.
    await resize(1440, 1000);
    await js('document.activeElement?.blur(); window.fixtureOverview.real7()');
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/service-payment-bridge#383"]') && document.querySelectorAll('${section('next')} .morning-row').length === 5 && !document.querySelector('${P} [data-overview-check="unknown"]')`);
    await collapseStacks();
    // The last visit sees this day: hide the Overview and show it again.
    await click(sidebar('Review queue'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display === 'none'`);
    await click(sidebar('Overview'));
    await wait(`getComputedStyle(document.querySelector('${P} .overview')).display !== 'none' && !!document.querySelector('${P} [data-overview-row]')`);
    soft(await briefing(), '7 re-reviews (6 in one stack) are waiting on you. 10 PRs can merge without review, 14 have failing checks, 4 have conflicts, and 1 needs rebasing. 7 PRs need a decision.');
    soft((await texts('next')).map((text) => text.split(' | ')[0]), ['#377', '#37286', '#35391', '#36100', '#36999'], 'Next up: the re-reviews, then fixes');
    soft(await js(`[...document.querySelectorAll('${section('next')} [data-quick-action]')].map(b=>b.textContent)`), ['Re-review', 'Re-review', 'Open', 'Rerun', 'Rerun'], 'no merge nobody reviewed is a row');
    soft(await js(`document.querySelector('${section('next')} [data-overview-more-unreviewed]')?.textContent`), '10 ready to merge without review');
    soft(await js(`document.querySelector('${section('you')} .morning-empty')?.textContent`), '#377 and #37286’s stack (6 PRs) are in Next up.');
    softOk(!(await js<boolean>(`/\\bgreen\\b|restack/i.test(document.querySelector('${P} .overview').textContent)`)), 'no "green" or "restack" on the page');
    // Each briefing number links to the rows it counts, and equals them: the PRs those rows list, or the quiet line's number.
    const counts = await js<{ key: string; count: number }[]>(`[...document.querySelectorAll('${P} [data-briefing-count]')].map(b=>({key:b.dataset.briefingCount,count:Number(b.dataset.count)}))`);
    soft(counts.map((entry) => `${entry.key} ${entry.count}`), ['rereviews 7', 'unreviewed 10', 'failing 14', 'conflicts 4', 'rebase 1', 'decide 7']);
    for (const { key: name, count: expected } of counts) {
      await js(`document.querySelectorAll('${P} [data-overview-highlight]').forEach(e=>e.removeAttribute('data-overview-highlight')); document.activeElement?.blur()`);
      await js(`document.querySelector('${P} [data-briefing-count="${name}"]').click()`);
      await wait(`document.querySelectorAll('${P} [data-overview-highlight]').length > 0 && !!document.activeElement?.closest('[data-overview-row-item]')`);
      await new Promise((r) => setTimeout(r, 200));
      const shown = await js<{ prs: number; line: number }>(`(()=>{const rows=[...document.querySelectorAll('${P} [data-overview-highlight]')];const prs=new Set(rows.flatMap(r=>(r.dataset.overviewPrs ?? '').split(' ').filter(Boolean)));const q=rows.find(r=>r.hasAttribute('data-overview-more-unreviewed'));return {prs:prs.size,line:q?Number(q.textContent.match(/^\\d+/)?.[0] ?? 0):0}})()`);
      soft(shown.prs + shown.line, expected, `briefing "${name}" = the rows it links to`);
    }
    await collapseStacks();
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    // The pointer under Waiting on you focuses the rows it names.
    await click(`${section('you')} [data-overview-pointer="next"]`);
    await wait(`document.activeElement?.closest('${section('next')}') !== null`);
    // Stacks: one line each, the step and one action; a base nobody reviewed opens rather than merges.
    soft(await js(`document.querySelectorAll('${P} .morning-chain').length`), 0, 'stacks are one line until expanded');
    // All six stacks (a briefing link may have shown the last two already).
    await js(`document.querySelector('${P} [data-overview-row="others|stacks|more"]')?.click()`);
    await wait(`document.querySelectorAll('${P} [data-overview-stack]').length === 6`);
    soft(await js(`[...document.querySelectorAll('${P} .morning-stack-head')].map(${parts})`), [
      'fix: keep a construction’s blocking objects when their recheck fails | seed | 2 PRs · Merge #36948 (not reviewed) to unblock 1 PR',
      'STACK: EPIC | seed-launcher | 4 PRs · Merge #376 (not reviewed, no checks) to unblock 3 PRs',
      'fix: keep Steam and Epic orders out of Adyen refunds and paid-order effects | service-payment-bridge | 4 PRs · Merge #383 (not reviewed) to unblock 3 PRs',
      'feat: move the launcher’s text into translation keys (i18n 1/3) | seed-launcher | 5 PRs · #379 has conflicts',
      'Wallet | seed | 2 PRs',
      'feat: show the player’s language in the account menu | web-seed-portal | 3 PRs · #1960 waits on review from lena',
    ]);
    // A base nobody reviewed opens rather than merges; Wallet's step is a Next up row, so it points there.
    soft(await js(`[...document.querySelectorAll('${P} .morning-stack-head [data-quick-action]')].map(b=>b.textContent)`), ['Open #36948', 'Open #376', 'Open #383', 'Open #379', 'next step in Next up', 'Nudge']);
    // Wallet's next step is a Next up row: the line points there, with no second action.
    const wallet = 'others|stacks|stack:klang/seed#36100';
    soft(await rowText(wallet), 'Wallet | seed | 2 PRs');
    soft(await js(`[...document.querySelectorAll('${P} [data-overview-row-item="${wallet}"] [data-quick-action]')].map(b=>b.textContent)`), ['next step in Next up']);
    // Expanded: chain rows say repo#number, so #384 and #385 in two repositories are never ambiguous; an unnamed
    // stack's base shows its number alone.
    await expandStacks();
    const numbers = await js<string[]>(`[...document.querySelectorAll('${P} .morning-chain .morning-number')].map(e=>e.textContent)`);
    softOk(numbers.includes('service-payment-bridge#384') && numbers.includes('seed-launcher#384'), `#384 names its repository: ${numbers.join(', ')}`);
    soft(await js(`document.querySelector('${P} [data-overview-row-item="others|stacks|stack:klang/seed-launcher#379|${url('klang/seed-launcher', 379)}"] .morning-title-text')`), null, 'the base of a stack named by its title shows its number alone');
    // The fixed columns, beside the title's room.
    const widths = {
      next: await fixedWidth(`${section('next')} .morning-row`),
      line: await fixedWidth(`${P} [data-overview-row-item^="others|person:plucked|"]`),
      chain: await fixedWidth(`${P} [data-overview-stack="stack:klang/service-payment-bridge#383"] .morning-chain > li:nth-child(2)`),
    };
    console.log(`overview fixed widths at 1440: ${JSON.stringify(widths)}`);
    softOk(widths.next.fixed <= 360 && widths.chain.fixed <= 460, `the fixed columns shrank: ${JSON.stringify(widths)}`);
    await agesAligned('real7 1440');
    await noneTwice();
    await checksEverywhere();
    await linesComplete();
    await menusEverywhere('real7 1440');
    await stacked('real7 1440');
    await uncut('real7 1440');
    // Dots: none for a day the last visit saw; a new review request is one.
    soft(await js(`document.querySelectorAll('${P} .overview .pr-unread-dot').length`), 0, 'no dots for a day the last visit saw');
    await js('window.fixtureOverview.requestReview()');
    await wait(`!!document.querySelector('${row(`next|review|${url('klang/seed', 36997)}`)}')`);
    soft(await js(`[...document.querySelectorAll('${P} .overview .pr-unread-dot')].map(d=>d.closest('[data-overview-row-item]').dataset.overviewRowItem)`), [`next|review|${url('klang/seed', 36997)}`], 'one dot: the new review request');
    softOk(await js<boolean>(`getComputedStyle(document.querySelector('${row(`next|review|${url('klang/seed', 36997)}`)} .morning-title-text')).fontWeight === '400'`), 'no bold for unread: the dot only');
    await collapseStacks();
    // A clean page for the screenshots: no marked rows, no PR preview left open by a focused row.
    await js(`document.querySelectorAll('${P} [data-overview-highlight]').forEach(e=>e.removeAttribute('data-overview-highlight'))`);
    await key('Escape');
    await js(`document.activeElement?.blur(); document.querySelector('${P} .overview-body').scrollTop = 0`);
    await unhover();
    await wait(`!document.querySelector('[data-slot=tooltip-content]')`);
    await dismissToasts();
    await both('real7-1440x1000');
    await js(`(()=>{const e=document.querySelector('${section('others')}');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-40})()`);
    await both('real7-others-1440x1000');
    await click(row('others|stacks|stack:klang/service-payment-bridge#383'));
    await wait(`!!document.querySelector('${P} [data-overview-stack="stack:klang/service-payment-bridge#383"] .morning-chain')`);
    await js(`document.activeElement?.blur(); (()=>{const e=document.querySelector('${P} [data-overview-stack="stack:klang/service-payment-bridge#383"]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-160})()`);
    await both('real7-stack-expanded-1440x1000');
    await js(`(()=>{const e=document.querySelector('${section('decide')}');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-120})()`);
    await both('real7-decide-1440x1000');
    await resize(760, 1000);
    await stacked('real7 760');
    await uncut('real7 760');
    softOk(await noSideways(), 'no sideways scrolling at 760');
    await js(`document.querySelector('${P} .overview-body').scrollTop = 0`);
    await both('real7-760');
    await js(`(()=>{const e=document.querySelector('${P} [data-overview-stack="stack:klang/service-payment-bridge#383"]');const b=e.closest('.overview-body');b.scrollTop+=e.getBoundingClientRect().top-b.getBoundingClientRect().top-120})()`);
    await both('real7-stack-expanded-760');
    await collapseStacks();
    await resize(1280);
    settle();

    step = 'one-overview';
    // The sidebar's Overview goes to the tab already showing it, rather than making a second one. Cmd-click still
    // opens a new tab, as it does for every sidebar entry.
    const tabsBefore = await tabCount();
    const selectedTab = `[...document.querySelectorAll('.workspace-tab')].findIndex(t=>t.querySelector('.workspace-tab-select[aria-selected=true]'))`;
    const overviewTab = await js<number>(selectedTab);
    await js(`document.querySelector('${sidebar('Review queue')}').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,metaKey:true,shiftKey:true}))`);
    await wait(`document.querySelectorAll('.workspace-tab').length === ${tabsBefore + 1} && ${selectedTab} !== ${overviewTab} && !!document.querySelector('${sidebar('Overview')}')`);
    const queueTab = await js<number>(selectedTab);
    await click(sidebar('Overview'));
    await wait(`${selectedTab} === ${overviewTab} && !!document.querySelector('${P} .overview [data-overview-row]')`);
    assert.equal(await tabCount(), tabsBefore + 1, 'no second Overview tab');
    await js(`document.querySelectorAll('.workspace-tab')[${queueTab}].querySelector('.workspace-tab-close').click()`);
    await wait(`document.querySelectorAll('.workspace-tab').length === ${tabsBefore} && ${selectedTab} >= 0 && !!document.querySelector('${P} .overview [data-overview-row]')`);

    step = 'status-arrives';
    // GitHub has not answered yet: no saved status, and status reads wait. The Overview asks for every lane candidate
    // itself and says it is checking; rows that need status arrive with the answers, and focus stays put.
    await js('sessionStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview&overview-status=held`);
    await wait(`!!document.querySelector('${P} [data-overview-checking]')`, 600);
    const own = [301, 302, 303, 304, 305, 306, 307, 311, 312, 331, 332, 333, 341, 342];
    const expected = [...own, ...Array.from({ length: 7 }, (_, i) => 321 + i)].map((n) => `/pull/${n}`);
    await wait(`(()=>{const r=window.fixtureOverview.requested();return ${JSON.stringify(expected)}.every(n=>r.some(u=>u.endsWith(n)))})()`);
    await wait(`document.querySelector('${P} [data-overview-checking]')?.textContent === 'checking ' + window.fixtureOverview.requested().length + ' PRs'`);
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
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-status-line]').length`), 1, 'one status line while updating');
    await js('window.fixtureOverview.setSync(60000)');
    await wait(`document.querySelector('${P} [data-overview-updated]')?.textContent.startsWith('Updated')`);
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
