/**
 * The guided session (#596): Start on Overview's Next up walks Next up one PR at a time, then the quick wins Next up
 * had no room for, then the decisions. Covers the Start button's scope; the approve guard (A on a deep step not yet
 * opened opens the approval form, Esc closes it and the keyboard comes back to the session; one press on a
 * summary-depth step); the facts row; a reply sent from the step (its file and line shown); the session bar on a PR
 * the session opened, with its [ and ] keys; a ready stack's base merged from its step (Esc on the confirmation gives
 * the keyboard back, the confirmed merge moves on by itself, and the stack's next PR joins the run right after); the
 * progress strip's labels; and the end, whose focused "Go through the N still on your list" restarts with Enter.
 * Synthetic data only (tests/fixtures/overview.ts, `?overview&session`): every write is recorded, never sent.
 *
 * Screenshots go to $GNOSIS_GUIDED_SESSION_SHOTS, else .impeccable/review/guided-session/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const P = '.workspace-panel[data-workspace-active=true]';
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const SESSION = `${P} [data-guided-session]`;
const STEP = `${SESSION} [data-session-step]`;
const BAR = `${P} [data-session-bar]`;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  let step = 'start';
  const dir = path.resolve(process.env.GNOSIS_GUIDED_SESSION_SHOTS || '.impeccable/review/guided-session');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const wait = async (code: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    await capture(`failure-${step}`).catch(() => undefined);
    throw Error(`Timed out in "${step}": ${code}\n${await js<string>(`(document.querySelector('${P}')?.innerText ?? document.body.innerText).slice(0, 3000)`)}`);
  };
  const cdp = win.webContents.debugger;
  const CODES: Record<string, [string, number]> = { Enter: ['Enter', 13], Escape: ['Escape', 27], ArrowRight: ['ArrowRight', 39], ']': ['BracketRight', 221], '[': ['BracketLeft', 219] };
  const key = async (name: string, modifiers = 0) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const [code, vk] = CODES[name] ?? [`Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
    const text = modifiers ? {} : name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {};
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...text, windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: vk });
  };
  const type = async (text: string) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    await cdp.sendCommand('Input.insertText', { text });
  };
  const writes = () => js<{ kind: string; url: string; comment?: string }[]>('window.fixtureOverview.writes');
  const outcomes = () => js<string[]>(`[...document.querySelectorAll('${SESSION} .guided-session-progress li')].map((li) => li.dataset.outcome ?? '')`);
  let total = 11;
  const onStep = (n: number, pr: string) => wait(`document.querySelector('${SESSION} [data-session-position]')?.textContent === '${n} of ${total}' && document.querySelector('${STEP}')?.dataset.sessionStep.endsWith('|#${pr.split('/').at(-1)}')`);
  const home = () => wait(`document.activeElement === document.querySelector('${SESSION}')`);
  const clickIn = (scope: string, label: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return !!b; })()`);
  try {
    step = 'load';
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);
    await js('sessionStorage.clear();localStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview&session`);
    await wait(`!!document.querySelector('${P} [data-session-start]') && !document.querySelector('${P} [data-overview-check="unknown"]')`, 600);

    step = 'start';
    // Start says what the run holds: Next up's five, the quick wins it had no room for, and the decisions.
    assert.equal(await js<string>(`document.querySelector('${P} [data-session-start]').textContent`), 'Start · 5 + 4 quick + 2 decisions');
    await js(`document.querySelector('${P} [data-session-start]').click()`);
    await onStep(1, url('klang/engine', 321));
    assert.equal(await js(`!!document.querySelector('${P} .morning')`), false, 'The session takes the page while it runs');
    assert.match(await js<string>(`document.querySelector('${STEP} .guided-step-about').textContent`), /^BriefingStreams each build step/, 'The briefing shows under the title');
    await wait(`document.querySelector('${STEP} [data-session-facts] [data-fact=files]')?.textContent === 'src/build/log-stream.ts'`);
    assert.match(await js<string>(`document.querySelector('${STEP} [data-session-facts]').textContent`), /^Checks 10 passedWaiting \d+ daysyour review requested/, 'The facts row: checks, wait, reviewers');
    assert.deepEqual(await outcomes(), Array(11).fill(''));
    await capture('step-review');

    step = 'approve guard';
    // A deep step you have not opened: A opens the approval form instead of approving. Nothing is sent.
    await home();
    await key('a');
    await wait(`!!document.querySelector('${STEP} [data-session-approve] [data-session-unread]') && document.activeElement?.id?.startsWith('approve-')`);
    assert.equal((await writes()).filter((w) => w.kind.startsWith('review-')).length, 0, 'A on an unread deep step sends nothing');
    await capture('approve-guard');
    // Esc closes the form, and the keyboard is the session's again.
    await key('Escape');
    await wait(`!document.querySelector('${STEP} [data-session-approve]')`);
    await home();
    // The form approves on purpose: ⌘↵ sends it, with its comment, and the session moves on.
    await key('a');
    await wait(`document.activeElement?.id?.startsWith('approve-')`);
    await type('Read it on the branch.');
    await key('Enter', process.platform === 'darwin' ? 4 : 2);
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'review-approve' && w.url === '${url('klang/engine', 321)}')`);
    assert.equal((await writes()).find((w) => w.kind === 'review-approve')?.comment, 'Read it on the branch.');
    await onStep(2, url('klang/engine', 324));
    assert.equal((await outcomes())[0], 'done', 'The approved step reads as moved');

    step = 're-review';
    // A small update to code you reviewed: Review the update is the primary, with its size, and A approves at once.
    await wait(`document.querySelector('${STEP} [data-session-update]')?.textContent.includes('Review the update · 42 lines')`);
    await home();
    await key('a');
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'review-approve' && w.url === '${url('klang/engine', 324)}')`);
    await onStep(3, url('klang/engine', 312));

    step = 'reply inline';
    // A reply waits on you: its thread shows where it sits, with a reply box, the step's primary action.
    await wait(`!!document.querySelector('${STEP} [data-session-thread] textarea')`);
    assert.match(await js<string>(`document.querySelector('${STEP} [data-session-thread]').textContent`), /is waiting on your reply/);
    assert.equal(await js(`document.querySelector('${STEP} [data-session-where]')?.textContent`), 'src/loader.ts:12');
    assert.equal(await js(`!!document.querySelector('${STEP} .guided-step-depth')`), false, 'No depth line on a reply');
    await js(`document.querySelector('${STEP} [data-session-thread] textarea').focus()`);
    await type('Moved it up, thanks.');
    await wait(`document.querySelector('${STEP} [data-session-thread] textarea').value === 'Moved it up, thanks.'`);
    await key('Enter', process.platform === 'darwin' ? 4 : 2);
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'thread-reply' && w.url === '${url('klang/engine', 312)}')`);
    await onStep(4, url('klang/cli', 322));
    assert.equal((await outcomes())[2], 'done', 'The answered step reads as moved');
    assert.deepEqual((await writes()).filter((w) => w.kind === 'thread-resolve'), [], 'Not resolved unless asked');

    step = 'open the PR';
    // O opens the full PR: it carries the session bar, at the PR's place in the run, its keys on its buttons.
    await home();
    await key('o');
    await wait(`!!document.querySelector('${BAR}')`);
    assert.equal(await js(`document.querySelector('${BAR} .session-bar-position').textContent`), '4 of 11');
    assert.match(await js<string>(`document.querySelector('${BAR} .session-bar-next').textContent`), /^Next#323 /);
    assert.deepEqual(await js(`[...document.querySelectorAll('${BAR} button kbd')].map((k) => k.textContent)`), ['[', ']']);
    assert.equal(await js(`document.querySelector('${BAR}').dataset.finished ?? null`), null, 'Not done here yet');

    step = 'done here';
    // A review submitted on the PR finishes it here: Done here, and Next PR becomes the bar's one filled action.
    assert.ok(await clickIn(P, 'Review PR #322'), 'The PR offers its review');
    await wait(`!!document.querySelector('[role=dialog] input[value=APPROVE]')`);
    await js(`document.querySelector('[role=dialog] input[value=APPROVE]').click()`);
    await wait(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === 'Submit review' && !b.disabled)`);
    assert.ok(await clickIn('[role=dialog]', 'Submit review'));
    await wait(`document.querySelector('${BAR}')?.dataset.finished === 'true'`);
    assert.match(await js<string>(`document.querySelector('${BAR}').textContent`), /Done here/);
    assert.equal(await js(`[...document.querySelectorAll('${BAR} button')].at(-1).dataset.variant`), 'default', 'Next PR is the filled action');
    assert.ok(await clickIn('[role=dialog]', 'Done'));
    await wait(`!document.querySelector('[role=dialog]')`);
    await capture('session-bar-done');

    step = 'next from the PR';
    // ] goes back to the Overview, on the step after this PR's, with this one moved.
    await js(`document.activeElement?.blur()`);
    await key(']');
    await onStep(5, url('acme/web', 323));
    assert.equal((await outcomes())[3], 'done', 'Finished on its page: moved');
    await capture('after-next');

    step = 'merge a stack base';
    // The ready stack's base is a quick win. Esc on the merge confirmation gives the keyboard back to the session.
    await js(`document.querySelectorAll('${SESSION} .guided-session-progress button')[5].click()`);
    await onStep(6, url('klang/cli', 308));
    assert.equal(await js(`!!document.querySelector('${STEP} [data-session-mute]')`), false, 'No Mute on your own PR');
    await js(`document.querySelector('${STEP} [data-session-primary] button').click()`);
    await wait(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === 'Merge pull request')`);
    await key('Escape');
    await wait(`!document.querySelector('[role=dialog]')`);
    await home();
    // Confirmed: the session moves on by itself, and the stack's next PR is the step right after its base.
    await js(`document.querySelector('${STEP} [data-session-primary] button').click()`);
    await wait(`[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === 'Merge pull request')`);
    assert.ok(await clickIn('[role=dialog]', 'Merge pull request'));
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'merge' && w.url === '${url('klang/cli', 308)}')`);
    total = 12;
    await onStep(7, url('klang/cli', 309));
    assert.equal((await outcomes())[5], 'done');
    await home();
    await capture('stack-follow-on');

    step = 'progress strip';
    assert.deepEqual(
      (await js<string[]>(`[...document.querySelectorAll('${SESSION} .guided-session-progress button')].map((b) => b.getAttribute('aria-label'))`)).slice(0, 7),
      ['#321 Stream build logs to the dashboard: moved', '#324 Replace the legacy config parser: moved', '#312 Document the plugin loading order: moved',
        '#322 Add a dry-run flag to the release script: moved', '#323 Batch telemetry writes per request: open', '#308 Parse the lockfile once per run: moved',
        '#309 Reuse the parsed lockfile in the audit: open']
    );

    step = 'the end';
    // The last step, then on: the end focuses "Go through the N still on your list", and Enter starts that run.
    await js(`document.querySelectorAll('${SESSION} .guided-session-progress button')[11].click()`);
    await home();
    await key('ArrowRight');
    await wait(`!!document.querySelector('${SESSION} [data-session-end]')`);
    await wait(`document.activeElement === document.querySelector('${SESSION} [data-session-restart]')`);
    assert.match(await js<string>(`document.querySelector('${SESSION} .guided-end-lead').textContent`), /^5 of 12 moved forward\./);
    assert.match(await js<string>(`document.activeElement.textContent`), /^Go through the 7 still on your list/);
    await capture('run-end');
    await key('Enter');
    total = 7;
    await onStep(1, url('acme/web', 323));

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
