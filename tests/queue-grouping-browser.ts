/**
 * Group by in the review queue: None, Action and Repository. Action uses the Overview's lanes in its order, with
 * Parked and Other; Repository goes alphabetically. Group headings stick to the top of the list, collapse, and stay
 * collapsed per list. j/k move across groups and skip collapsed ones, the briefing panel follows the selection, a deep
 * link can set the grouping, and None restores the plain list. Covers both the plain and the virtualized list (more
 * than 30 lines). Synthetic data only (tests/fixtures/overview.ts).
 *
 * Screenshots go to .impeccable/review/overview-frontpage/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';

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
    await capture(`failure-grouping-${step}`).catch(() => undefined);
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
  const key = async (name: string) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const code = `Key${name.toUpperCase()}`;
    const vk = name.toUpperCase().charCodeAt(0);
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, text: name, windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 120));
  };
  const sidebar = (label: string) => `${P} [data-sidebar-destination][aria-label="${label}"]`;
  const labels = () => js<string[]>(`[...document.querySelectorAll('${P} .queue-group-label')].map(e=>e.textContent)`);
  const counts = () => js<number[]>(`[...document.querySelectorAll('${P} .queue-group-count')].map(e=>Number(e.textContent))`);
  const shownIds = () => js<string[]>(`[...document.querySelectorAll('${P} [data-queue-id]')].map(e=>e.dataset.queueId)`);
  const selectedId = () => js<string | undefined>(`(document.querySelector('${P} .queue-item.is-selected') ?? document.activeElement)?.closest('[data-queue-id]')?.dataset.queueId`);
  const groupOf = (id: string) => js<string | undefined>(`(()=>{let e=document.querySelector('${P} [data-queue-id="${id}"]');while(e&&!e.matches('[data-queue-group]'))e=e.previousElementSibling;return e?.dataset.queueGroup})()`);
  const chooseGroup = async (value: string) => {
    await js(`document.querySelector('${P} [data-queue-group-by]').click()`);
    await wait(`!!document.querySelector('.queue-group-popover input[value="${value}"]')`);
    await js(`document.querySelector('.queue-group-popover input[value="${value}"]').click()`);
    await wait(`document.querySelector('${P} [data-queue-group-by]')?.dataset.queueGroupBy === '${value}' && !document.querySelector('.queue-group-popover')`);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);
    await wait(`!!document.querySelector('${P} [data-overview-row]')`, 600);
    await js(`document.querySelector('${sidebar('Review queue')}').click()`);
    await wait(`document.querySelectorAll('${P} .queue-item').length === 19`);
    const total = 19;

    step = 'none';
    // The default is None: the list is as it was, with no group headings.
    assert.equal(await js(`document.querySelector('${P} [data-queue-group-by]').dataset.queueGroupBy`), 'none');
    assert.equal(await js(`document.querySelectorAll('${P} .queue-group-heading').length`), 0);
    const plain = await shownIds();

    step = 'repository';
    let started = Date.now();
    await chooseGroup('repository');
    await wait(`document.querySelectorAll('${P} .queue-group-heading').length === 3`);
    console.log(`Group by repository: ${Date.now() - started} ms`);
    // Alphabetical by owner/repo; the counts add up; grouping is not a filter.
    assert.deepEqual(await labels(), ['acme/web', 'klang/cli', 'klang/engine']);
    assert.equal((await counts()).reduce((a, b) => a + b, 0), total);
    assert.equal(await js(`document.querySelectorAll('${P} .queue-filter-chip').length`), 0);
    // The sort applies within each group: entries keep their relative order from the plain list.
    const byRepo = await shownIds();
    for (const label of await labels()) {
      const inGroup: string[] = [];
      for (const id of byRepo) if ((await groupOf(id)) === `repository:${label}`) inGroup.push(id);
      assert.deepEqual(inGroup, plain.filter((id) => inGroup.includes(id)), `sorted within ${label}`);
    }
    await js(`document.querySelector('${P} .queue-list').scrollTop = 0`);
    await both('grouped-repository-1280');

    step = 'collapse';
    // A heading collapses its group: the heading and count stay, the entries leave, and the choice is remembered.
    const cli = `${P} [data-queue-group="repository:klang/cli"] .queue-group-toggle`;
    const cliCount = await js<number>(`Number(document.querySelector('${cli} .queue-group-count').textContent)`);
    await js(`document.querySelector('${cli}').click()`);
    await wait(`document.querySelector('${cli}').getAttribute('aria-expanded') === 'false'`);
    assert.equal((await shownIds()).length, total - cliCount);
    assert.equal(await js(`Number(document.querySelector('${cli} .queue-group-count').textContent)`), cliCount);
    assert.deepEqual(JSON.parse(await js<string>("localStorage.getItem('gnosis-queue-collapsed-groups:v1')")), { 'section:all': ['repository:klang/cli'] });

    step = 'keyboard';
    // j moves across groups in the order shown and skips the collapsed one; the briefing panel follows.
    await js('document.activeElement?.blur()');
    const order = await shownIds();
    const visited: string[] = [];
    for (let i = 0; i < order.length; i++) {
      await key('j');
      visited.push((await selectedId()) ?? '');
    }
    assert.deepEqual(visited, order, 'j walks every shown entry, group by group');
    assert.ok(!visited.some((id) => id.includes('klang/cli')), 'collapsed entries are skipped');
    await key('k');
    assert.equal(await selectedId(), order.at(-2));
    await wait(`!!document.querySelector('${P} .briefing-panel')`);

    step = 'per-view';
    // Collapse state belongs to the list: Stacks has its own; the queue keeps its own when you come back.
    await js(`document.querySelector('${sidebar('Stacks')}').click()`);
    await wait(`document.querySelectorAll('${P} .queue-group-heading').length >= 1 && document.querySelectorAll('${P} .queue-item').length === 2`);
    assert.equal(await js(`document.querySelectorAll('${P} .queue-group-toggle[aria-expanded=false]').length`), 0);
    await js(`document.querySelector('${sidebar('Review queue')}').click()`);
    await wait(`document.querySelector('${cli}')?.getAttribute('aria-expanded') === 'false'`);
    await js(`document.querySelector('${cli}').click()`);
    await wait(`document.querySelectorAll('${P} .queue-item').length === ${total}`);

    step = 'action';
    // Action: the Overview's lanes, in its order, with empty groups hidden.
    started = Date.now();
    await chooseGroup('action');
    await wait(`document.querySelector('${P} .queue-group-label')?.textContent === 'Answer'`);
    console.log(`Group by action: ${Date.now() - started} ms`);
    assert.deepEqual(await labels(), ['Answer', 'Review', 'Merge', 'Fix', 'Waiting on others', 'Parked']);
    assert.equal((await counts()).reduce((a, b) => a + b, 0), total);
    await js(`document.querySelector('${P} .queue-list').scrollTop = 0`);
    await both('grouped-action-1280');

    step = 'virtual';
    // The heavy load: more than 30 lines, so only rows near the viewport mount. Headings still stick.
    await js('window.fixtureOverview.heavy()');
    await wait(`Number(document.querySelector('${P} [data-queue-total]')?.dataset.queueTotal) > 40`);
    const heavyTotal = await js<number>(`Number(document.querySelector('${P} [data-queue-total]').dataset.queueTotal)`);
    assert.ok((await shownIds()).length < heavyTotal, 'the list is virtualized');
    assert.deepEqual(await labels().then((all) => all.slice(0, 1)), ['Answer']);
    // The lanes stay live while the Overview is hidden: the heavy load's failures and parked merges find their groups.
    await wait(`Number(document.querySelector('${P} [data-queue-group="action:answer"]')?.parentElement.querySelector('[data-queue-group="action:answer"] .queue-group-count')?.textContent) === 2`);
    await js(`(()=>{const l=document.querySelector('${P} .queue-list');l.scrollTop=l.scrollHeight})()`);
    await wait(`[...document.querySelectorAll('${P} .queue-group-label')].some(e=>e.textContent==='Parked')`);
    assert.equal(await js(`[...document.querySelectorAll('${P} .queue-group-label')].some(e=>e.textContent==='Other')`), false, 'every PR of yours is in a lane');
    assert.equal(await js(`Number([...document.querySelectorAll('${P} .queue-group-heading')].find(h=>h.textContent.startsWith('Parked'))?.querySelector('.queue-group-count').textContent)`), 12);
    await js(`(()=>{const l=document.querySelector('${P} .queue-list');l.scrollTop=l.scrollHeight*0.55})()`);
    await wait(`!!document.querySelector('${P} .queue-group-heading[data-sticky]')`);
    await new Promise((r) => setTimeout(r, 300));
    const sticky = await js<{ group: string; offset: number }>(`(()=>{const h=document.querySelector('${P} .queue-group-heading[data-sticky]');const l=document.querySelector('${P} .queue-list');return {group:h.dataset.queueGroup,offset:Math.round(h.getBoundingClientRect().top-l.getBoundingClientRect().top)}})()`);
    assert.equal(sticky.offset, 0, `the current group's heading sticks to the top (${JSON.stringify(sticky)})`);
    // The stuck heading names the group of the first entry under it.
    const under = await js<string>(`(()=>{const l=document.querySelector('${P} .queue-list').getBoundingClientRect();const rows=[...document.querySelectorAll('${P} [data-queue-id]')].filter(r=>r.getBoundingClientRect().bottom>l.top+44).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);return rows[0].dataset.queueId})()`);
    const fixIds = await js<string[]>(`[...document.querySelectorAll('${P} [data-queue-id]')].map(e=>e.dataset.queueId)`);
    assert.ok(fixIds.includes(under));
    await both('grouped-action-heavy-1280');
    // j still crosses groups in the virtual list: from the last Answer entry into Review.
    await js(`document.querySelector('${P} .queue-list').scrollTop = 0`);
    await wait(`!!document.querySelector('${P} [data-queue-group="action:review"]')`);
    const answerCount = await js<number>(`Number(document.querySelector('${P} [data-queue-group="action:answer"] .queue-group-count').textContent)`);
    await js('document.activeElement?.blur()');
    await js(`document.querySelector('${P} [data-queue-group="action:answer"]').nextElementSibling?.querySelector('.queue-row-main')?.click()`);
    for (let i = 0; i < answerCount; i++) await key('j');
    assert.equal(await groupOf((await selectedId()) ?? ''), 'action:review');
    win.setSize(760, 800);
    await new Promise((r) => setTimeout(r, 400));
    await js(`document.querySelector('${P} .queue-list').scrollTop = 0`);
    await both('grouped-action-760');
    win.setSize(1280, 800);
    await new Promise((r) => setTimeout(r, 300));

    step = 'deep-link';
    // A queue link can set the grouping: gnosis://queue?group=repository.
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify({ source: 'notification', target: { kind: 'queue', filters: { group: 'repository' } } })}}))`);
    await wait(`document.querySelector('${P} [data-queue-group-by]')?.dataset.queueGroupBy === 'repository'`);
    await js(`document.querySelector('${P} .queue-list').scrollTop = 0`);
    await wait(`document.querySelector('${P} .queue-group-label')?.textContent === 'acme/web'`);
    await both('grouped-repository-heavy-1280');

    step = 'back-to-none';
    await chooseGroup('none');
    await wait(`document.querySelectorAll('${P} .queue-group-heading').length === 0`);
    assert.equal(await js(`document.querySelectorAll('${P} .queue-filter-chip').length`), 0);

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-grouping-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
