/**
 * The guided session (#596): Start on Overview's Next up walks Next up one PR at a time. Covers starting a session,
 * Approve with A (the approval is sent and the session moves on), a reply sent from the step's own reply box (sent,
 * and on to the next PR), and the session bar on a PR the session opened: its place in the run, Done here with a filled
 * Next PR after a review submitted there, and Next PR going back to the Overview on the following step. Synthetic data
 * only (tests/fixtures/overview.ts, `?overview&session`): every write is recorded by the fixture, never sent.
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
  const key = async (name: string, modifiers = 0) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    const code = name.length === 1 ? `Key${name.toUpperCase()}` : name;
    const vk = name.length === 1 ? name.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27 } as Record<string, number>)[name];
    const text = modifiers ? {} : name.length === 1 ? { text: name } : name === 'Enter' ? { text: '\r' } : {};
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...text, windowsVirtualKeyCode: vk });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers, windowsVirtualKeyCode: vk });
  };
  const type = async (text: string) => {
    if (!cdp.isAttached()) cdp.attach('1.3');
    await cdp.sendCommand('Input.insertText', { text });
  };
  const writes = () => js<{ kind: string; url: string; comment?: string }[]>('window.fixtureOverview.writes');
  const position = () => js<string | null>(`document.querySelector('${SESSION} [data-session-position]')?.textContent ?? null`);
  const current = () => js<string | null>(`document.querySelector('${STEP}')?.dataset.sessionStep ?? null`);
  const outcomes = () => js<string[]>(`[...document.querySelectorAll('${SESSION} .guided-session-progress li')].map((li) => li.dataset.outcome ?? '')`);
  const onStep = (n: number, pr: string) => wait(`document.querySelector('${SESSION} [data-session-position]')?.textContent === '${n} of 7' && document.querySelector('${STEP}')?.dataset.sessionStep.endsWith('${pr}')`);
  const clickIn = (scope: string, label: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return !!b; })()`);
  try {
    step = 'load';
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview`);
    await js('sessionStorage.clear();localStorage.clear()');
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?overview&session`);
    await wait(`!!document.querySelector('${P} [data-session-start]') && !document.querySelector('${P} [data-overview-check="unknown"]')`, 600);

    step = 'start';
    assert.match(await js<string>(`document.querySelector('${P} [data-session-start]').textContent`), /^Start · 7$/);
    await js(`document.querySelector('${P} [data-session-start]').click()`);
    await onStep(1, url('klang/engine', 321));
    assert.equal(await js(`!!document.querySelector('${P} .morning')`), false, 'The session takes the page while it runs');
    assert.match(await js<string>(`document.querySelector('${STEP} .guided-step-about').textContent`), /^BriefingStreams each build step/, 'The briefing shows under the title');
    assert.deepEqual(await outcomes(), ['', '', '', '', '', '', '']);
    await capture('step-review');

    step = 'approve with A';
    // The session holds the keyboard: A approves the PR in one press, then the session moves on by itself.
    await wait(`document.activeElement === document.querySelector('${SESSION}')`);
    await key('a');
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'review-approve' && w.url === '${url('klang/engine', 321)}')`);
    await onStep(2, url('klang/engine', 312));
    assert.equal((await outcomes())[0], 'done', 'The approved step reads as moved');
    assert.equal((await writes()).filter((w) => w.kind === 'review-approve').length, 1, 'One approval, sent once');

    step = 'reply inline';
    // A reply waits on you: its thread shows with a reply box, the step's primary action.
    await wait(`!!document.querySelector('${STEP} [data-session-thread] textarea')`);
    assert.match(await js<string>(`document.querySelector('${STEP} [data-session-thread]').textContent`), /is waiting on your reply/);
    await js(`document.querySelector('${STEP} [data-session-thread] textarea').focus()`);
    await type('Moved it up, thanks.');
    await wait(`document.querySelector('${STEP} [data-session-thread] textarea').value === 'Moved it up, thanks.'`);
    await key('Enter', process.platform === 'darwin' ? 4 : 2);
    await wait(`window.fixtureOverview.writes.some((w) => w.kind === 'thread-reply' && w.url === '${url('klang/engine', 312)}')`);
    await onStep(3, url('klang/cli', 322));
    assert.equal((await outcomes())[1], 'done', 'The answered step reads as moved');
    assert.deepEqual((await writes()).filter((w) => w.kind === 'thread-resolve'), [], 'Not resolved unless asked');

    step = 'open the PR';
    // O opens the full PR: it carries the session bar, at the PR's place in the run. The reply gave the keyboard back.
    await wait(`document.activeElement === document.querySelector('${SESSION}')`);
    await key('o');
    await wait(`!!document.querySelector('${BAR}')`);
    assert.equal(await js(`document.querySelector('${BAR} .session-bar-position').textContent`), '3 of 7');
    assert.match(await js<string>(`document.querySelector('${BAR} .session-bar-next').textContent`), /^Next#324 /);
    assert.equal(await js(`document.querySelector('${BAR}').dataset.finished ?? null`), null, 'Not done here yet');
    assert.equal(await js(`[...document.querySelectorAll('${BAR} button')].at(-1).dataset.variant`), 'outline');

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
    // Next PR goes back to the Overview, on the step after this PR's, with this one moved.
    assert.ok(await clickIn(BAR, 'Next PR'));
    await onStep(4, url('klang/engine', 324));
    assert.equal((await outcomes())[2], 'done', 'Finished on its page: moved');
    assert.equal(await current(), `next|review|${url('klang/engine', 324)}`);
    assert.equal(await position(), '4 of 7');
    await capture('after-next');

    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture(`failure-${step}`).catch(() => undefined);
    win.destroy();
    app.exit(1);
  }
});
