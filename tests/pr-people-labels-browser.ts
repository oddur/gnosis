import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/**
 * Reviewers, assignees, labels and the milestone, edited from the Summary details column. Each picker opens from its
 * edit button or the command palette, searches as the reader types (GitHub only past the first saved page), toggles
 * with arrows and Enter, and applies on close. The column shows the change before GitHub answers, rolls it back with
 * a Retry when GitHub refuses, and a read-only account sees the editors disabled with the reason. Writes wait until
 * the test answers them; all GitHub data is synthetic (tests/fixtures/pr-people.ts). With GNOSIS_PR_PEOPLE_SHOTS set,
 * screenshots print as `PPSHOT <name> <base64 PNG>` lines.
 */
app.disableHardwareAcceleration();
const shots = !!process.env.GNOSIS_PR_PEOPLE_SHOTS;
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver') && !message.includes('Failed to load resource')) errors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () =>
    js<string>(
      `JSON.stringify({open:document.querySelector('.pr-people-popup')?.dataset.field,query:document.querySelector('.pr-people-popup [data-slot=combobox-input]')?.value,items:[...document.querySelectorAll('.pr-people-popup [data-slot=combobox-item]')].map(e=>e.dataset.value+(e.hasAttribute('data-selected')?'*':'')+(e.hasAttribute('data-highlighted')?'^':'')).slice(0,12),sidebar:document.querySelector('.conversation-sidebar')?.innerText.slice(0,900),held:window.prPeopleFixture?.held(),errors:${JSON.stringify(errors)}})`
    );
  const wait = async (code: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await sleep(25);
    }
    throw Error(`Timed out: ${code}\n${await state()}`);
  };
  /** The change shows before GitHub answers. */
  const instantly = (code: string) => wait(code, 1_000);
  const key = async (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  };
  const press = (selector: string) =>
    js(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.focus();e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0}));e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));e.click()})()`
    );
  const fill = (value: string) =>
    js(
      `(()=>{const e=document.querySelector('.pr-people-popup [data-slot=combobox-input]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}))})()`
    );
  const edit = (field: string) => `.pr-people-section[data-field=${field}] .pr-people-edit`;
  const section = (field: string) => `document.querySelector('.pr-people-section[data-field=${field}]')`;
  const text = (field: string) => js<string>(`${section(field)}?.innerText ?? ''`);
  const items = () => js<string[]>("[...document.querySelectorAll('.pr-people-popup [data-slot=combobox-item]')].map(e=>e.dataset.value)");
  const open = async (field: string) => {
    await press(edit(field));
    await wait(`document.querySelector('.pr-people-popup')?.dataset.field===${JSON.stringify(field)} && document.activeElement?.matches('.pr-people-popup [data-slot=combobox-input]')`);
    await wait("!/Loading/.test(document.querySelector('.pr-people-popup')?.textContent ?? '') && document.querySelectorAll('.pr-people-popup [data-slot=combobox-item]').length>0");
  };
  const option = (value: string) => `.pr-people-popup [data-slot=combobox-item][data-value=${JSON.stringify(value)}]`;
  const highlighted = (value: string) => wait(`document.querySelector('.pr-people-popup [data-slot=combobox-item][data-highlighted]')?.dataset.value===${JSON.stringify(value)}`);
  const closed = () => wait("!document.querySelector('.pr-people-popup')");
  const held = () => js<string[]>('window.prPeopleFixture.held()');
  const settle = async (outcome = 'ok') => {
    await js(`window.prPeopleFixture.settle(${JSON.stringify(outcome)})`);
    await sleep(80);
  };
  const refresh = () => js('window.prPeopleFixture.refresh()');
  const shot = async (name: string) => {
    if (!shots) return;
    await js('document.fonts.ready');
    await sleep(350);
    console.log(`PPSHOT ${name} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
  };
  /** Opens the command palette with a command query; resolves with the results' text. */
  const palette = async (query: string) => {
    await key('k', ['meta']);
    await wait("!!document.querySelector('.global-command-dialog')");
    await js(
      `(()=>{const e=document.querySelector('.global-command-dialog input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(query)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await wait("document.querySelector('.global-command-results')?.getAttribute('aria-busy')!=='true'");
    await sleep(250);
    return js<string>("document.querySelector('.global-command-results')?.textContent ?? ''");
  };
  const openPr = async (query: string) => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?${query}`);
    win.focus();
    await waitForWorkbenchQueue(win.webContents);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait(`!!${section('reviewers')} && !!${section('labels')}`, 30_000);
  };
  setTimeout(() => {
    console.error('PR people checks stalled.');
    void state()
      .then((value) => console.error(value))
      .finally(() => app.exit(1));
  }, 170_000).unref();

  try {
    await openPr('pr-summary&github-sync&pr-people');
    // The editors are enabled once access is known: write access.
    await wait(`!document.querySelector('.pr-people-edit[aria-disabled]') && document.querySelectorAll('.pr-people-edit').length===4`);
    const listed = await text('reviewers');
    assert.match(listed, /maya\s*Approved/);
    assert.match(listed, /sam\s*Review requested/);
    assert.match(listed, /Platform reviewers[\s\S]*Review requested/);
    assert.ok(await js(`!!${section('reviewers')}.querySelector('.pr-people-team svg')`), 'A team shows as a team, with its icon');
    assert.match(await text('assignees'), /lena/);
    assert.match(await text('labels'), /bug/);
    assert.match(await text('milestone'), /No milestone/);
    // GitHub takes no review request from a bot: its row never offers one.
    assert.match(await text('reviewers'), /coverage-app\s*Commented/);
    assert.ok(await js<boolean>(`!document.querySelector('[aria-label="Request a review from coverage-app again"]')`), 'No re-request for a bot');
    assert.ok(await js<boolean>(`!!document.querySelector('[aria-label="Request a review from maya again"]')`));
    // A long team name reads in full beside its verdict.
    assert.ok(
      await js<boolean>(`(()=>{const e=${section('reviewers')}.querySelector('.pr-people-team > span');return e.scrollWidth<=e.clientWidth+1})()`),
      'The team name is not cut off'
    );

    // ── Reviewers: current first, then who reviewed and who GitHub suggests; never the author ──
    await open('reviewers');
    const first = await items();
    assert.deepEqual(first.slice(0, 4), ['user:sam', 'team:platform reviewers', 'user:maya', 'user:owen'], `Reviewer order: ${first.join()}`);
    assert.ok(!first.includes('user:lena'), 'The PR author is never offered as a reviewer');
    assert.ok(!first.includes('user:coverage-app'), 'A bot is never offered as a reviewer');
    assert.ok(first.includes('team:release crew'), 'Teams with access are offered');
    assert.match(await js<string>(`document.querySelector(${JSON.stringify(option('user:maya'))}).textContent`), /Approved · request again/);
    assert.match(await js<string>(`document.querySelector(${JSON.stringify(option('team:release crew'))}).textContent`), /Team/);
    assert.deepEqual(
      await js<string[]>("[...document.querySelectorAll('.pr-people-popup [data-slot=combobox-item][data-selected]')].map(e=>e.dataset.value)"),
      ['user:sam', 'team:platform reviewers']
    );
    await fill('len');
    await sleep(350);
    assert.ok(!(await items()).includes('user:lena'), 'Searching never brings the author back');
    // Past the first saved page, a typed query asks GitHub once the reader pauses.
    await fill('zel');
    await wait(`!!document.querySelector(${JSON.stringify(option('user:zelda-ops'))})`);
    assert.ok(
      await js<boolean>("window.prPeopleFixture.record.candidates.includes('reviewers:zel')"),
      'A query past the first page reads GitHub'
    );
    await highlighted('user:zelda-ops');
    await key('Enter');
    await wait(`document.querySelector(${JSON.stringify(option('user:zelda-ops'))})?.hasAttribute('data-selected')`);
    // A refused search says so, with Retry, instead of loading forever.
    await js("window.prPeopleFixture.failSearch('qq')");
    await fill('qq');
    await wait("/Couldn’t load the list\\. Search is temporarily unavailable/.test(document.querySelector('.pr-people-popup')?.textContent ?? '')");
    await js('window.prPeopleFixture.clearSearchFailures()');
    await press('.pr-people-load-error button');
    await js("document.querySelector('.pr-people-popup [data-slot=combobox-input]').focus()");
    await wait("/No matching people or teams/.test(document.querySelector('.pr-people-popup')?.textContent ?? '')");
    await fill('zel');
    await wait(`document.querySelector(${JSON.stringify(option('user:zelda-ops'))})?.hasAttribute('data-selected')`);
    await fill('');
    await wait(`!!document.querySelector(${JSON.stringify(option('user:sam'))})`);
    // Arrows move and Enter toggles: sam is first, so one Home and Enter removes him.
    await key('Home');
    await highlighted('user:sam');
    await key('Enter');
    await wait(`!document.querySelector(${JSON.stringify(option('user:sam'))})?.hasAttribute('data-selected')`);
    await key('Down');
    await key('Down');
    await key('Down');
    await highlighted('user:owen');
    await key('Enter');
    await shot('reviewers-light');
    await key('Escape');
    await closed();
    // Closing applies at once, before GitHub answers.
    await instantly(`/zelda-ops/.test(${section('reviewers')}.innerText) && /owen/.test(${section('reviewers')}.innerText) && !/\\bsam\\b/.test(${section('reviewers')}.innerText)`);
    assert.deepEqual(await held(), ['reviewers']);
    const sent = await js<{ add: string[]; remove: string[] }>('window.prPeopleFixture.record.edits.at(-1)');
    assert.deepEqual([sent.add, sent.remove], [['zelda-ops', 'owen'], ['sam']], 'One write with the whole change');
    await settle();
    await refresh();
    await wait(`/zelda-ops/.test(${section('reviewers')}.innerText) && !/\\bsam\\b/.test(${section('reviewers')}.innerText)`);
    await wait("window.prPeopleFixture.patches().length===0");

    // ── Re-request: maya approved earlier. A double click sends one request. ──
    const before = await js<number>('window.prPeopleFixture.record.edits.length');
    await js(`(()=>{const b=document.querySelector('[aria-label="Request a review from maya again"]');b.click();b.click()})()`);
    await instantly(`/maya\\s*Requested again/.test(${section('reviewers')}.innerText)`);
    assert.ok(!(await js<boolean>(`!!document.querySelector('[aria-label="Request a review from maya again"]')`)));
    const again = await js<{ add: string[] }>('window.prPeopleFixture.record.edits.at(-1)');
    assert.deepEqual(again.add, ['maya']);
    assert.equal(await js<number>('window.prPeopleFixture.record.edits.length'), before + 1, 'One request for a double click');
    await settle();
    await refresh();
    await wait(`/maya\\s*Requested again/.test(${section('reviewers')}.innerText)`);

    // ── Partial success: GitHub takes the addition and refuses the removal; Retry sends the removal only ──
    await open('reviewers');
    await press(option('user:zelda-ops'));
    await fill('dev-01');
    await highlighted('user:dev-01');
    await key('Enter');
    await key('Escape');
    await closed();
    await instantly(`/dev-01/.test(${section('reviewers')}.innerText) && !/zelda-ops/.test(${section('reviewers')}.innerText)`);
    await settle('partial');
    await wait(`/Some reviewer changes weren’t made\\./.test(${section('reviewers')}.innerText)`);
    await wait(`/dev-01/.test(${section('reviewers')}.innerText) && /zelda-ops/.test(${section('reviewers')}.innerText.split('Some reviewer')[0])`);
    await press('.pr-people-section[data-field=reviewers] .write-failure-actions button');
    const rest = await js<{ add: string[]; remove: string[] }>('window.prPeopleFixture.record.edits.at(-1)');
    assert.deepEqual([rest.add, rest.remove], [[], ['zelda-ops']], 'Retry sends only what did not happen');
    await settle();
    await refresh();
    await wait(`/dev-01/.test(${section('reviewers')}.innerText) && !/zelda-ops/.test(${section('reviewers')}.innerText)`);

    // ── Assignees: rolls back when GitHub refuses, then Retry ──
    await open('assignees');
    assert.deepEqual((await items()).slice(0, 2), ['user:lena', 'user:oddur'], 'The current assignee, then you');
    await fill('oddur');
    await highlighted('user:oddur');
    await key('Enter');
    await key('Escape');
    await closed();
    await instantly(`/oddur/.test(${section('assignees')}.innerText)`);
    await settle('Validation Failed: oddur could not be assigned');
    await wait(`!/oddur/.test(${section('assignees')}.innerText.split('Assignees weren')[0])`);
    await wait(`/Assignees weren’t changed\\./.test(${section('assignees')}.innerText) && /Validation Failed/.test(${section('assignees')}.innerText)`);
    await shot('rollback-light');
    await press('.pr-people-section[data-field=assignees] .write-failure-actions button');
    await instantly(`/oddur/.test(${section('assignees')}.innerText) && !${section('assignees')}.querySelector('.write-failure')`);
    await settle();
    await refresh();
    await wait(`/lena[\\s\\S]*oddur/.test(${section('assignees')}.innerText)`);

    // ── Labels: colors, add and remove in one close ──
    await open('labels');
    await fill('perf');
    await highlighted('label:performance');
    await key('Enter');
    await fill('');
    await press(option('label:bug'));
    await wait(`!document.querySelector(${JSON.stringify(option('label:bug'))})?.hasAttribute('data-selected')`);
    assert.match(await js<string>("document.querySelector('.pr-people-footer').textContent"), /1 selected/);
    await press('.pr-people-footer button');
    await closed();
    await instantly(`/performance/.test(${section('labels')}.innerText) && !/\\bbug\\b/.test(${section('labels')}.innerText)`);
    assert.equal(
      await js(`getComputedStyle(${section('labels')}.querySelector('.pr-label')).backgroundColor`),
      'rgb(0, 82, 204)',
      'A new label keeps its GitHub color'
    );
    await settle();
    await refresh();
    await wait(`/performance/.test(${section('labels')}.innerText) && !/\\bbug\\b/.test(${section('labels')}.innerText)`);

    // ── Milestone: one choice applies at once ──
    await open('milestone');
    assert.equal((await items())[0], 'milestone:none');
    await press(option('milestone:3'));
    await closed();
    await instantly(`/v0\\.42/.test(${section('milestone')}.innerText)`);
    await settle();
    await refresh();
    await wait(`/v0\\.42/.test(${section('milestone')}.innerText)`);

    // ── Command palette: Edit labels… opens the labels picker ──
    await key('k', ['meta']);
    await wait("!!document.querySelector('.global-command-dialog')");
    await js(
      `(()=>{const e=document.querySelector('.global-command-dialog input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'> edit labels');e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await wait("/Edit labels/.test(document.querySelector('.global-command-results')?.textContent ?? '')");
    await sleep(200);
    await key('Enter');
    await wait("document.querySelector('.pr-people-popup')?.dataset.field==='labels' && document.activeElement?.matches('.pr-people-popup [data-slot=combobox-input]')");
    await key('Escape');
    await closed();
    assert.deepEqual(await held(), [], 'Closing without a change writes nothing');

    // ── A command while the field's last change is saving opens the picker once it has saved ──
    await open('labels');
    await press(option('label:documentation'));
    await press('.pr-people-footer button');
    await closed();
    assert.deepEqual(await held(), ['labels']);
    assert.match(await palette('> edit labels'), /Edit labels/);
    await key('Enter');
    await sleep(400);
    assert.ok(await js<boolean>("!document.querySelector('.pr-people-popup')"), 'The picker waits for the save');
    await settle();
    await wait("document.querySelector('.pr-people-popup')?.dataset.field==='labels'");
    await wait(`document.querySelector(${JSON.stringify(option('label:documentation'))})?.hasAttribute('data-selected')`);
    await key('Escape');
    await closed();
    await refresh();
    assert.deepEqual(await held(), []);

    // ── A command is handled once: leaving Summary and coming back never reopens the picker ──
    const tab = (label: string) =>
      `[...document.querySelectorAll('.workspace-panel[data-workspace-active=true] .pr-overview-tabs [role=tab]')].find(t=>t.textContent.trim()===${JSON.stringify(label)})`;
    const toTab = async (label: string) => {
      await js(`(()=>{const t=${tab(label)};t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
      await wait(`${tab(label)}?.getAttribute('aria-selected')==='true'`);
    };
    await toTab('Changes');
    await toTab('Summary');
    await wait(`!!${section('labels')}`);
    await sleep(500);
    assert.ok(await js<boolean>("!document.querySelector('.pr-people-popup')"), 'No picker opens by itself on return');
    assert.ok(await js<boolean>("![...document.querySelectorAll('[aria-roledescription=notification]')].some(t=>/Edit labels/.test(t.textContent))"), 'No toast on return');

    // ── A waiting command is replaced by a newer one for another field ──
    await open('labels');
    await press(option('label:transport'));
    await press('.pr-people-footer button');
    await closed();
    assert.deepEqual(await held(), ['labels']);
    assert.match(await palette('> edit labels'), /Edit labels/);
    await key('Enter');
    await sleep(300);
    assert.match(await palette('> edit assignees'), /Edit assignees/);
    await key('Enter');
    await wait("document.querySelector('.pr-people-popup')?.dataset.field==='assignees'");
    await key('Escape');
    await closed();
    await settle();
    await sleep(500);
    assert.ok(await js<boolean>("!document.querySelector('.pr-people-popup')"), 'The replaced labels command does not open after the save');
    await refresh();

    // ── Screenshots: dark, then narrow ──
    await js("document.documentElement.classList.add('dark')");
    await open('reviewers');
    await shot('reviewers-dark');
    await key('Escape');
    await closed();
    await open('labels');
    await shot('labels-dark');
    await key('Escape');
    await closed();
    await js("document.documentElement.classList.remove('dark')");
    win.setContentSize(760, 800);
    await sleep(400);
    // The details become a strip above the timeline; the people sections share its rows and nothing overflows.
    const strip = await js<{ overflow: boolean; above: boolean }>(
      "(()=>{const s=document.querySelector('.conversation-side'),m=document.querySelector('.conversation-main');const p=document.querySelector('[data-feedback-scroller]');return {overflow:document.documentElement.scrollWidth>innerWidth||(!!p&&p.scrollWidth>p.clientWidth+1&&getComputedStyle(p).overflowX!=='hidden'),above:s.getBoundingClientRect().bottom<=m.getBoundingClientRect().top+1}})()"
    );
    assert.ok(strip.above && !strip.overflow, `Narrow strip: ${JSON.stringify(strip)}`);
    await js("document.querySelector('[data-feedback-scroller]').scrollTop=0");
    await open('assignees');
    const fits = await js<boolean>("(()=>{const r=document.querySelector('.pr-people-popup').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()");
    assert.ok(fits, 'The picker stays inside a narrow window');
    await shot('assignees-narrow');
    await key('Escape');
    await closed();
    await held().then((writes) => assert.deepEqual(writes, []));
    win.setContentSize(1280, 800);

    // ── Closed on GitHub: access is read again; reviews can't be requested, labels still can ──
    await js('window.prPeopleFixture.close()');
    await wait(`/open PR/.test(document.querySelector(${JSON.stringify(edit('reviewers'))})?.getAttribute('aria-description') ?? '')`);
    assert.ok(await js<boolean>(`!document.querySelector(${JSON.stringify(edit('labels'))}).hasAttribute('aria-disabled')`), 'Labels stay editable');
    assert.ok(!/Request reviewers/.test(await palette('> request reviewers')), 'No "Request reviewers…" command on a closed PR');
    await key('Escape');
    assert.match(await palette('> edit labels'), /Edit labels/);
    await key('Escape');
    await wait("!document.querySelector('.global-command-dialog')");

    // ── Read-only account: the editors are disabled and say why ──
    await openPr('pr-summary&github-sync&pr-people&pr-people-readonly');
    // Reviewers, assignees and labels; an empty milestone it can't set is left out.
    await wait("document.querySelectorAll('.pr-people-edit[aria-disabled=true]').length===3");
    assert.ok(await js<boolean>(`!${section('milestone')}`), 'No empty milestone for a read-only account');
    const reason = await js<string>("document.querySelector('.pr-people-edit').getAttribute('aria-description')");
    assert.match(reason, /triage or write access to klang\/engine/);
    await press(edit('labels'));
    await sleep(300);
    assert.ok(await js<boolean>("!document.querySelector('.pr-people-popup')"), 'A disabled editor does not open');
    assert.ok(await js<boolean>(`!document.querySelector('[aria-label="Request a review from maya again"]')`), 'No re-request without access');
    await js(`(()=>{const e=document.querySelector('.pr-people-section[data-field=labels] .pr-people-edit-wrap');e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:5,clientY:5}));e.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:7,clientY:6}));e.dispatchEvent(new FocusEvent('focus'))})()`);
    await js("document.querySelector('.pr-people-section[data-field=labels] .pr-people-edit').focus()");
    await sleep(400);
    await shot('read-only-light');
    assert.equal(await js('window.prPeopleFixture.record.edits.length'), 0, 'A read-only account sends nothing');
    assert.deepEqual(errors, [], errors.join('\n'));

    // ── A failed access read says so, retries, and offers Retry ──
    await openPr('pr-summary&github-sync&pr-people&pr-people-access-fail');
    await wait("/Couldn’t check whether you can edit this PR/.test(document.querySelector('.pr-people-access-error')?.textContent ?? '')");
    assert.ok(await js<boolean>("document.querySelectorAll('.pr-people-edit[aria-disabled=true]').length>0"));
    await press('.pr-people-access-error button');
    await wait(`!document.querySelector('.pr-people-access-error') && !document.querySelector('.pr-people-edit[aria-disabled]')`);
    assert.deepEqual(errors, [], errors.join('\n'));
    console.log('PR people and labels checks passed.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await state().catch(() => ''));
    app.exit(1);
  }
});
