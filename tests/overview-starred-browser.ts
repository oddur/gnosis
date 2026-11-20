/**
 * The Overview's Starred section (lib/overview-starred.ts): first on the page, above Next up, only when something is
 * starred. Covers its rows and their order (needs you, ready to merge, waiting on others, quiet, done), a starred
 * stack with its PRs under it in merge order, a merged PR as a quiet done row, the draft word, each PR listed once on
 * the whole page, j/k and Enter reaching the starred rows first, unstarring a PR and a stack from the row menus,
 * the cap with "Show all N", no section with no stars, and the layout in light, dark and narrow. Synthetic data only
 * (tests/fixtures/overview.ts, `overview-stars`).
 *
 * Screenshots go to $GNOSIS_OVERVIEW_STARRED_SHOTS, else .impeccable/review/overview-starred/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const section = (name: string) => `${P} .morning-section[data-section="${name}"]`;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const dir = path.resolve(process.env.GNOSIS_OVERVIEW_STARRED_SHOTS || '.impeccable/review/overview-starred');
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
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 3000)`)}`);
  };
  const both = async (name: string) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const resize = async (width: number, height = 900) => {
    win.setContentSize(width, height);
    await new Promise((r) => setTimeout(r, 400));
  };
  const cdp = win.webContents.debugger;
  const key = async (name: string, modifiers = 0) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const vk = name.length === 1 ? name.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, Tab: 9, F10: 121 } as Record<string, number>)[name];
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...(name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 80));
  };
  /** Shift+F10 on a row opens its menu: the items, in order. */
  const menuItems = async (selector: string) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await key('F10', 8);
    await wait("!!document.querySelector('[role=menuitem]')");
    const items = await js<string[]>("[...document.querySelectorAll('[role=menuitem]')].map(b=>b.textContent)");
    await key('Escape');
    await wait("!document.querySelector('[role=menuitem]')");
    return items;
  };
  /** Shift+F10 on a row opens its menu; runs the item named `action`. */
  const menu = async (selector: string, action: string) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await key('F10', 8);
    await wait("!!document.querySelector('[role=menuitem]')");
    const items = await js<string[]>("[...document.querySelectorAll('[role=menuitem]')].map(b=>b.textContent)");
    assert.ok(items.includes(action), `the menu offers "${action}": ${JSON.stringify(items)}`);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent===${JSON.stringify(action)}).click()`);
    await wait("!document.querySelector('[role=menuitem]')");
    return items;
  };
  const load = async (query: string) => {
    // Stars live in the fixture's session storage; each scenario starts from none.
    // A blank window has no storage to clear, so the first scenario loads the page once before.
    if (!win.webContents.getURL().startsWith('http')) await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);
    await js('sessionStorage.clear();localStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview${query}`);
    await wait(`!!document.querySelector('${P} .morning [data-overview-row]') && !document.querySelector('${P} [data-overview-check="unknown"]')`, 600);
  };
  // What each top-level starred row says: number, title, detail, check, status word and age.
  const parts = `r=>[r.querySelector('.morning-number')?.textContent, r.querySelector('.morning-title-text')?.textContent, r.querySelector('.morning-detail')?.textContent, r.querySelector('.morning-checks')?.textContent, r.querySelector('.morning-status')?.textContent].filter(Boolean).join(' | ')`;
  const starredRows = () => js<string[]>(`[...document.querySelectorAll('${section('starred')} .morning-rows > .morning-row, ${section('starred')} .morning-rows > .morning-stack > .morning-stack-head')].map(${parts})`);
  const headings = () => js<string[]>(`[...document.querySelectorAll('${P} section.morning-section')].map(s=>document.getElementById(s.getAttribute('aria-labelledby')).firstChild.textContent)`);
  const count = (name: string) => js<string | null>(`document.querySelector('${section(name)} [data-section-count]')?.textContent ?? null`);
  // Every PR listed outside stack chains, on the whole page: none twice.
  const noneTwice = async () => {
    const listed = await js<string[]>(`[...document.querySelectorAll('${P} [data-overview-prs]')].filter(r=>!r.closest('.morning-chain')).flatMap(r=>r.dataset.overviewPrs.split(' ').filter(Boolean))`);
    assert.deepEqual(listed.filter((value, i) => listed.indexOf(value) !== i), [], 'no PR twice on the page');
    const starred = await js<string[]>(`[...document.querySelectorAll('${section('starred')} [data-overview-prs]')].flatMap(r=>r.dataset.overviewPrs.split(' '))`);
    const elsewhere = await js<string[]>(`[...document.querySelectorAll('${P} .morning-section:not([data-section="starred"]) [data-overview-prs]')].filter(r=>!r.closest('.morning-chain')).flatMap(r=>r.dataset.overviewPrs.split(' '))`);
    assert.deepEqual(starred.filter((value) => elsewhere.includes(value)), [], 'a starred PR is in no other section');
  };
  const sideways = () => js<boolean>(`(()=>{const b=document.querySelector('${P} .overview-body');return b.scrollWidth > b.clientWidth})()`);
  try {
    step = 'no stars';
    await load('');
    assert.equal(await js(`!!document.querySelector('${section('starred')}')`), false, 'no Starred section without stars');
    assert.deepEqual(await headings(), ['Next up', 'Waiting on you', 'Waiting on others', 'Needs a decision']);
    assert.equal(await js(`document.querySelectorAll('${P} [data-overview-row][tabindex="0"]').length`), 4, 'one tab stop per section, as before');
    // Every row menu offers the queue's star toggle, so a PR can be starred from here.
    const first = await js<string>(`[...document.querySelectorAll('${section('next')} [data-overview-prs]')].find(r=>!r.dataset.overviewPrs.includes(' ')).dataset.overviewPrs`);
    assert.ok((await menuItems(`${section('next')} [data-overview-prs="${first}"] [data-overview-row]`)).includes(`Star PR #${first.split('/').at(-1)}`));

    step = 'day';
    await load('&overview-stars=day');
    await wait(`!!document.querySelector('${section('starred')} [data-overview-row]')`);
    assert.deepEqual(await headings(), ['Starred', 'Next up', 'Waiting on you', 'Waiting on others', 'Needs a decision'], 'Starred is first');
    assert.equal(await count('starred'), '7');
    const stackId = await js<string>(`document.querySelector('${section('starred')} [data-overview-stack]').dataset.overviewStack`);
    // Needs you (a review, then the failing stack), ready to merge, waiting on others, quiet (latest change first), done.
    assert.deepEqual(await starredRows(), [
      '#322 | Add a dry-run flag to the release script | Review requested | passing',
      'Split the scheduler into phases | 2 PRs · #331 failing checks | 2 failed',
      '#301 | Cache resolved module paths between builds | Ready to merge · approved by lena | passing',
      '#341 | Print a summary after install | Waits on review from lena | passing',
      '#351 | Sketch the new onboarding checklist | Review required | passing',
      '#352 | Try a streaming config parser | Draft | passing',
      '#350 | Pin the toolchain for release builds | Merged',
    ]);
    // The stack lists its PRs under it, base first, on the chain.
    assert.deepEqual(await js(`[...document.querySelectorAll('${P} [data-overview-stack="${stackId}"] .morning-chain > li')].map(${parts})`), [
      '#331 | Split the scheduler into phases | Failing checks | 2 failed',
      '#332 | Run phases on a worker pool | Conflicts | passing',
    ]);
    // Actions, in Next up's words; a merged row has none and no check state.
    assert.deepEqual(await js(`[...document.querySelectorAll('${section('starred')} .morning-rows > .morning-row [data-quick-action], ${section('starred')} .morning-stack-head [data-quick-action]')].map(b=>b.textContent.trim())`), ['Review', 'Rerun', 'Merge']);
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-row-item="starred|${url('klang/engine', 350)}"]').classList.contains('is-done')`), true, 'a merged starred PR is a quiet done row');
    assert.equal(await js(`!!document.querySelector('${section('starred')} [data-overview-row-item="starred|${url('klang/engine', 350)}"] [data-overview-check]')`), false);
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-row-item="starred|${url('klang/engine', 350)}"] [data-pr-state]')?.dataset.prState`), 'merged');
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-row-item="starred|${url('klang/cli', 352)}"] [data-pr-state]')?.dataset.prState`), 'draft');
    await noneTwice();
    // Next up and the sections below leave the starred PRs out, and still read correctly.
    assert.equal(await js(`[...document.querySelectorAll('${section('next')} [data-overview-prs]')].some(r=>r.dataset.overviewPrs.includes(${JSON.stringify(url('klang/cli', 322))}))`), false);
    assert.match(await js<string>(`document.querySelector('${section('you')} [data-overview-you-elsewhere]')?.textContent ?? ''`), /^Shown in Starred: 1 PR\. /, 'Waiting on you points at the starred review');
    // The starred row describes itself.
    assert.equal(await js(`document.querySelector('${P} [data-overview-row="starred|${url('klang/cli', 322)}"]').closest('[data-overview-row-item]').querySelector('[data-overview-description]').textContent`), 'Review requested, cli #322, checks passing, waiting 4 days');
    await js('document.activeElement?.blur()');
    await both('day-1280');
    await resize(1440, 1000);
    await both('day-1440');
    await resize(760, 1000);
    assert.equal(await sideways(), false, 'nothing scrolls sideways at 760');
    await both('day-760');
    await resize(520, 1000);
    assert.equal(await sideways(), false, 'nothing scrolls sideways at 520');
    await both('day-520');
    await resize(1280);

    step = 'keyboard';
    // j from nowhere starts at the first starred row; j walks Starred in its order, the stack's PRs after its header.
    await js('document.activeElement?.blur()');
    const order = await js<string[]>(`[...document.querySelectorAll('${section('starred')} [data-overview-row]')].map(b=>b.dataset.overviewRow)`);
    assert.equal(order[0], `starred|${url('klang/cli', 322)}`);
    assert.deepEqual(order.slice(1, 4), [stackId, `${stackId}|${url('klang/engine', 331)}`, `${stackId}|${url('klang/engine', 332)}`]);
    const walked: string[] = [];
    for (let i = 0; i < order.length; i++) {
      await key('j');
      walked.push(await js<string>('document.activeElement?.dataset.overviewRow ?? ""'));
    }
    assert.deepEqual(walked, order, 'j moves through the starred rows first, in order');
    await key('k');
    assert.equal(await js('document.activeElement?.dataset.overviewRow'), order.at(-2));
    // Tab leaves Starred for Next up.
    await key('Tab');
    assert.equal(await js(`document.activeElement?.closest('.morning-section')?.dataset.section`), 'next');
    // Enter on the stack's header collapses it, and again expands it.
    await js(`document.querySelector('${P} [data-overview-row="${stackId}"]').focus()`);
    await key('Enter');
    await wait(`!document.querySelector('${P} [data-overview-stack="${stackId}"] .morning-chain')`);
    assert.equal(await js(`document.querySelector('${P} [data-overview-row="${stackId}"]').getAttribute('aria-expanded')`), 'false');
    await key('Enter');
    await wait(`!!document.querySelector('${P} [data-overview-stack="${stackId}"] .morning-chain')`);

    step = 'unstar';
    // Unstar a PR with the queue's star toggle: the row leaves, and the PR goes back to its section.
    const items = await menu(`${P} [data-overview-row="starred|${url('klang/cli', 341)}"]`, 'Unstar PR #341');
    assert.deepEqual(items, ['Open', 'Snooze PR…', 'Mark as read', 'Unstar PR #341', 'Copy link', 'Copy repository', 'Copy PR number', 'Open on GitHub']);
    await wait(`!document.querySelector('${P} [data-overview-row="starred|${url('klang/cli', 341)}"]')`);
    assert.equal(await count('starred'), '6');
    await wait(`[...document.querySelectorAll('${section('others')} [data-overview-prs]')].some(r=>r.dataset.overviewPrs===${JSON.stringify(url('klang/cli', 341))})`);
    await noneTwice();
    // A merged PR has no snooze; unstarring it removes the done row.
    const done = await menu(`${P} [data-overview-row="starred|${url('klang/engine', 350)}"]`, 'Unstar PR #350');
    assert.ok(!done.includes('Snooze PR…'), 'a merged PR cannot be snoozed');
    await wait(`!document.querySelector('${P} [data-overview-row="starred|${url('klang/engine', 350)}"]')`);
    // Unstar the stack from its header: every PR of it is unstarred, and the stack goes back to Waiting on others.
    await menu(`${P} [data-overview-row="${stackId}"]`, 'Unstar PRs in this stack');
    await wait(`!document.querySelector('${P} [data-overview-stack="${stackId}"]')`);
    assert.equal(await count('starred'), '4');
    await noneTwice();
    // Star from another section: the PR moves up into Starred.
    const lane = await js<string>(`[...document.querySelectorAll('${section('next')} [data-overview-prs]')].find(r=>!r.dataset.overviewPrs.includes(' ')).dataset.overviewPrs`);
    const number = Number(lane.split('/').at(-1));
    await menu(`${section('next')} [data-overview-prs="${lane}"] [data-overview-row]`, `Star PR #${number}`);
    await wait(`[...document.querySelectorAll('${section('starred')} [data-overview-prs]')].some(r=>r.dataset.overviewPrs===${JSON.stringify(lane)})`);
    assert.equal(await count('starred'), '5');
    await noneTwice();
    // Unstar everything: the section leaves the page.
    for (const id of await js<string[]>(`[...document.querySelectorAll('${section('starred')} .morning-rows > .morning-row [data-overview-row]')].map(b=>b.dataset.overviewRow)`)) {
      const n = id.split('/').at(-1);
      await menu(`${P} [data-overview-row="${id}"]`, `Unstar PR #${n}`);
      await wait(`!document.querySelector('${P} [data-overview-row="${id}"]')`);
    }
    await wait(`!document.querySelector('${section('starred')}')`);
    assert.deepEqual(await headings(), ['Next up', 'Waiting on you', 'Waiting on others', 'Needs a decision']);

    step = 'many';
    await load('&overview-stars=many');
    await wait(`!!document.querySelector('${section('starred')} [data-overview-more="starred"]')`);
    assert.equal(await count('starred'), '13');
    const top = () => js<number>(`document.querySelectorAll('${section('starred')} .morning-rows > .morning-row, ${section('starred')} .morning-rows > .morning-stack').length`);
    assert.equal(await top(), 8, 'eight starred entries show');
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-more="starred"]').textContent`), 'Show all 13');
    await both('many-1280');
    await js(`document.querySelector('${section('starred')} [data-overview-more="starred"]').click()`);
    await wait(`document.querySelectorAll('${section('starred')} .morning-rows > .morning-row, ${section('starred')} .morning-rows > .morning-stack').length === 13`);
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-more="starred"]').getAttribute('aria-expanded')`), 'true');
    assert.equal(await js(`document.querySelector('${section('starred')} [data-overview-more="starred"]').textContent`), 'Show fewer');
    await noneTwice();
    // Every review request is starred: Next up says nothing else needs you, or lists only what is left.
    const nextEmpty = await js<string | null>(`document.querySelector('${section('next')} [data-overview-empty]')?.textContent ?? null`);
    if (nextEmpty !== null) assert.equal(nextEmpty, 'Nothing else needs you right now.');
    await js(`document.querySelector('${section('starred')} [data-overview-more="starred"]').click()`);
    await wait(`document.querySelectorAll('${section('starred')} .morning-rows > .morning-row, ${section('starred')} .morning-rows > .morning-stack').length === 8`);

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
