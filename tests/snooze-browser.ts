/**
 * Snooze (#324): snooze from the row menu and with Z, the PR leaves the queue and its counts, Tools › Snoozed,
 * Undo, a wake with its "Back" line, Unsnooze, a snoozed stack member, Mute's Undo, and the menu bar panel.
 * Screenshots in light and dark go to .impeccable/review/snooze/.
 */
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    await capture(`failure-${step}`).catch(() => undefined);
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>('document.body.innerText.slice(0, 600)')}`);
  };
  const dir = path.resolve('.impeccable/review/snooze');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const both = async (name: string) => {
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await js("document.documentElement.classList.remove('dark')");
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 80));
  };
  const rows = () => js<number>("document.querySelectorAll('.queue-item').length");
  const hasPr = (n: number) => js<boolean>(`!!document.querySelector('[aria-label="Actions for PR #${n}"]')`);
  const pickerOpen = "!!document.querySelector('.snooze-picker .snooze-option')";
  const choose = async (label: string) => {
    await wait(pickerOpen);
    await js(`(()=>{const b=[...document.querySelectorAll('.snooze-option')].find(b=>b.querySelector('.snooze-option-label')?.textContent===${JSON.stringify(label)});if(!b)throw Error('Missing option '+${JSON.stringify(label)});b.click()})()`);
    await wait("!document.querySelector('.snooze-picker')");
  };
  const toast = (text: string) => `[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes(${JSON.stringify(text)}))`;
  const key = async (name: string) => {
    const cdp = win.webContents.debugger;
    if (!cdp.isAttached()) cdp.attach('1.3');
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: `Key${name.toUpperCase()}`, text: name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) });
    await new Promise((r) => setTimeout(r, 80));
  };
  const snoozedCount = () => js<string>("document.querySelector('[aria-label=\"Snoozed\"] .nav-count')?.textContent ?? ''");
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    assert.equal(await snoozedCount(), '0');

    // The row menu offers Snooze directly above Mute.
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Actions for PR #152');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`);
    await wait("!!document.querySelector('[role=menuitem]')");
    const labels = await js<string[]>("[...document.querySelectorAll('[role=menuitem]')].map(item=>item.textContent)");
    assert.equal(labels.indexOf('Snooze PR…') + 1, labels.indexOf('Mute PR'), `Snooze sits above Mute: ${labels.join(', ')}`);
    await capture('row-menu-light');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=menuitem]')");

    // Snooze from the row menu: the picker, then the PR leaves the queue and focus moves to the next row.
    await menuAction(js, 'Actions for PR #152', 'Snooze PR…');
    await wait(pickerOpen);
    assert.equal(await js("document.activeElement?.classList.contains('snooze-option')"), true, 'The first option has focus');
    assert.ok(await js("document.querySelector('.snooze-picker').textContent.includes('Timed snoozes also end on a new review or review request.')"));
    await both('picker');
    // Custom date and time.
    await click('Custom…');
    await wait("!!document.querySelector('.snooze-custom input[type=date]')");
    await capture('picker-custom-light');
    await js("document.querySelector('.snooze-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('.snooze-picker')");
    assert.equal(await rows(), 7, 'Closing the picker changes nothing');

    await menuAction(js, 'Actions for PR #152', 'Snooze PR…');
    await choose('Tomorrow morning');
    await wait(`document.querySelectorAll('.queue-item').length===6 && ${toast('Snoozed #152 until tomorrow')}`);
    assert.equal(await hasPr(152), false);
    assert.equal(await snoozedCount(), '1');
    await wait("document.activeElement?.classList.contains('queue-row-main')");
    await capture('snoozed-toast-light');

    step = 'undo';
    // Undo brings it back.
    await js("[...document.querySelectorAll('.app-toast .app-toast-action')].find(b=>b.textContent==='Undo').click()");
    await wait("document.querySelectorAll('.queue-item').length===7");
    assert.equal(await snoozedCount(), '0');

    step = 'z';
    // Z snoozes the selected row.
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.closest('.queue-item').querySelector('[aria-label=\"Actions for PR #152\"]')).click()");
    await key('z');
    await choose('Until new activity');
    await wait("document.querySelectorAll('.queue-item').length===6");
    assert.equal(await hasPr(152), false);
    await both('queue-after-snooze');

    step = 'tools';
    // Tools › Snoozed lists it with when it wakes.
    await click('Snoozed');
    await wait("document.querySelectorAll('.snoozed-pr-list li').length===1");
    assert.match(await js<string>("document.querySelector('.snoozed-pr-wakes').textContent"), /^Wakes on new activity, or /);
    assert.ok(await js("!!document.querySelector('.snoozed-pr-list .pr-state-icon')"), 'PR names carry their state icon');
    await both('snoozed-view');

    step = 'wake';
    // A wake: the PR is back, unread, with its reason.
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-item').length===6");
    await js("window.fixtureSnoozeWake('https://github.com/klang/engine/pull/152', { kind: 'review', actor: 'lena' }, 2880)");
    await wait("document.querySelectorAll('.queue-item').length===7 && !!document.querySelector('.queue-snooze-back')");
    assert.equal(await js<string>("document.querySelector('.queue-snooze-back').textContent"), 'Back: new review from lena · snoozed 2 days');
    assert.ok(await js("document.querySelector('.queue-snooze-back').closest('.queue-item').classList.contains('is-unread')"), 'A PR that comes back is unread');
    assert.equal(await snoozedCount(), '0');
    await both('back');

    step = 'unsnooze';
    // Unsnooze from Tools › Snoozed.
    await menuAction(js, 'Actions for PR #152', 'Snooze PR…');
    await choose('Next week');
    await wait("document.querySelectorAll('.queue-item').length===6");
    await click('Snoozed');
    await wait("document.querySelectorAll('.snoozed-pr-list li').length===1");
    assert.match(await js<string>("document.querySelector('.snoozed-pr-wakes').textContent"), /, or on a new review or review request$/);
    await click('Unsnooze PR #152');
    await wait("document.querySelector('.snoozed-prs h2')?.textContent==='No snoozed PRs'");
    await both('snoozed-empty');
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-item').length===7");

    step = 'stack';
    // One PR inside a stack: the stack row stays and the PR is dimmed.
    await js("document.querySelector('.queue-disclosure').click()");
    await wait("document.querySelectorAll('.queue-member').length>1");
    const members = await js<number>("document.querySelectorAll('.queue-member').length");
    await menuAction(js, 'Actions for PR #121', 'Snooze PR…');
    await choose('Tomorrow morning');
    await wait("document.querySelectorAll('.queue-member.is-snoozed').length===1");
    assert.equal(await js<number>("document.querySelectorAll('.queue-member').length"), members);
    assert.equal(await rows(), 7);
    assert.ok(await js("[...document.querySelectorAll('.queue-stack-matches')].some(n=>/PRs snoozed$/.test(n.textContent))"));
    await js("document.querySelectorAll('.app-toast [aria-label=\"Dismiss notification\"]').forEach(b=>b.click()); document.querySelector('.queue-member.is-snoozed').scrollIntoView({ block: 'center' })");
    await both('stack-member');
    await click('Snoozed');
    await click('Unsnooze PR #121');
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-member.is-snoozed').length===0");

    step = 'mute';
    // Mute gets an Undo toast too.
    await menuAction(js, 'Actions for PR #152', 'Mute PR');
    await wait(`document.querySelectorAll('.queue-item').length===6 && ${toast('Muted #152')}`);
    await js("[...document.querySelectorAll('.app-toast .app-toast-action')].find(b=>b.textContent==='Undo').click()");
    await wait("document.querySelectorAll('.queue-item').length===7");

    step = 'deep-link';
    // gnosis://queue?section=snoozed, from a trusted source such as a notification, opens Tools › Snoozed.
    await menuAction(js, 'Actions for PR #152', 'Snooze PR…');
    await choose('Until new activity');
    await wait("document.querySelectorAll('.queue-item').length===6");
    assert.equal(await js('!!document.querySelector(".snoozed-prs")'), false);
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify({ source: 'notification', target: { kind: 'queue', section: 'snoozed' } })}}))`);
    await wait("document.querySelectorAll('.snoozed-pr-list li').length===1");
    win.setSize(640, 800);
    await capture('snoozed-narrow-light');
    assert.ok(await js('document.documentElement.scrollWidth <= window.innerWidth'));
    win.setSize(1280, 800);

    // The menu bar: "Back ·" before the status, and the snoozed count in the footer.
    const menubar = new BrowserWindow({ width: 360, height: 560, show: true, webPreferences: { backgroundThrottling: false, partition: `menubar-${Date.now()}` } });
    try {
      await loadWorkbenchPage(menubar, new URL('/tests/fixtures/menubar.html?state=back', process.env.GNOSIS_WORKBENCH_URL).href);
      const mjs = <T = unknown>(code: string) => menubar.webContents.executeJavaScript(code) as Promise<T>;
      for (let i = 0; i < 100 && !(await mjs('!!document.querySelector(".menubar-row")')); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(await mjs('document.querySelector(".menubar-row .menubar-row-reason")?.textContent'), 'Back');
      assert.equal(await mjs('document.querySelector(".menubar-footer-snoozed")?.textContent'), '3 snoozed');
      const cdp = menubar.webContents.debugger;
      cdp.attach('1.3');
      for (const scheme of ['light', 'dark']) {
        await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await new Promise((r) => setTimeout(r, 250));
        fs.writeFileSync(path.join(dir, `menubar-${scheme}.png`), (await menubar.webContents.capturePage()).toPNG());
      }
    } finally {
      menubar.destroy();
    }
    console.log('Snooze browser checks passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
