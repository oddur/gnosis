import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((e: unknown) => {
      throw Error(code + ': ' + String(e));
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(
      'Timed out: ' +
        code +
        '\n' +
        JSON.stringify(
          await js(
            `({focused:document.hasFocus(),active:document.activeElement?.outerHTML,viewport:[innerWidth,innerHeight],tooltip:document.querySelector('.pr-badge-tooltip')?.getBoundingClientRect().toJSON()})`
          )
        )
    );
  };
  const shots = path.resolve('.impeccable/review/pr-badge-previews');
  fs.mkdirSync(shots, { recursive: true });
  let focusedSelector = '.queue-meta .entity-badge-pr';
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    if (name !== 'failure') {
      if (!(await js("document.querySelector('.pr-badge-tooltip')?.checkVisibility({visibilityProperty:true})")))
        await focus(focusedSelector);
      await wait("document.querySelector('.pr-badge-tooltip')?.checkVisibility({visibilityProperty:true})");
      await new Promise((r) => setTimeout(r, 200));
    }
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const content = "document.querySelector('.pr-badge-tooltip')";
  const focus = async (selector = '.queue-meta .entity-badge-pr') => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await wait('document.hasFocus()');
    focusedSelector = selector;
    await js(
      `document.activeElement.blur();document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`
    );
    await new Promise((r) => setTimeout(r, 150));
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await wait(`!!${content}`);
  };
  const close = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await js('document.activeElement.blur()');
    await wait(`!${content}`);
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?entity-badges`);
    // Keep keyboard-focus behavior deterministic even if the desktop activates another window.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "window.previewReads=[];window.basePreview=window.electronAPI.getPrBadgePreview;window.electronAPI.getPrBadgePreview=async url=>{window.previewReads.push(url);return window.basePreview(url)};window.copies=[];Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:text=>{window.copies.push(text);return Promise.resolve()}});void 0"
    );
    assert.equal(await js('window.previewReads.length'), 0, 'No preview reads for idle badges');
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /Approved/);
    assert.match(await js<string>(`${content}.textContent`), /130\/130 checks/);
    assert.match(await js<string>(`${content}.textContent`), /Briefing/);
    assert.match(await js<string>(`${content}.textContent`), /Copy PR link/);
    assert.equal(await js('window.previewReads.length'), 1);
    assert.match(await js<string>(`${content}.textContent`), /Preserve pending messages/);
    await capture('desktop');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    await close();
    // A delayed local cache read must not show a small loading tooltip and resize it.
    await js(
      "window.electronAPI.getPrBadgePreview=url=>new Promise(resolve=>{window.releasePreview=async()=>resolve(await window.basePreview(url))});document.querySelector('.queue-meta .entity-badge-pr').focus();void 0"
    );
    await wait("typeof window.releasePreview==='function'");
    assert.equal(await js(`!!${content}`), false);
    await js('window.releasePreview()');
    await wait(`!!${content}`);
    const size = await js(`${content}.offsetHeight`);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await js(`${content}.offsetHeight`), size);
    await js("document.querySelector('.queue-meta .entity-badge-pr').click()");
    await wait('window.copies.length===1');
    assert.match(await js<string>('window.copies[0]'), /^https:\/\/github.com\//);
    await close();
    await js(
      "window.electronAPI.getPrBadgePreview=async url=>{const p=await window.basePreview(url);p.signals.checkedAt=Date.now()-3600000;p.signals.readiness.reviewDecision='CHANGES_REQUESTED';return p};void 0"
    );
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /Changes requested.*Out of date/s);
    await capture('stale');
    await close();
    await js(
      "window.electronAPI.getPrBadgePreview=async url=>{const p=await window.basePreview(url);p.signals.headSha='old-revision';p.briefing=undefined;return p};void 0"
    );
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /Review status not saved/);
    assert.doesNotMatch(await js<string>(`${content}.textContent`), /Approved|130\/130/);
    await capture('missing-status');
    await close();
    await js('window.electronAPI.getPrBadgePreview=()=>Promise.resolve(null);void 0');
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /No PR details saved yet/);
    await capture('missing');
    await close();
    await js("window.electronAPI.getPrBadgePreview=()=>Promise.reject(Error('Cache unavailable'));void 0");
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /Saved PR details are unavailable/);
    await close();
    await js(
      'window.electronAPI.getPrBadgePreview=window.basePreview;document.querySelector(\'[aria-label="Expand Introduce a bounded command queue"]\').click();void 0'
    );
    await focus('.queue-member .entity-badge-pr');
    assert.match(await js<string>(`${content}.textContent`), /Stack briefing · 3 PRs/);
    await capture('stack');
    await close();
    await js(
      "window.electronAPI.getPrBadgePreview=async url=>{const p=await window.basePreview(url);p.member.title='Preserve cancellation and retry boundaries across streaming command processing and connection recovery'.repeat(2);p.briefing.summary='Preserve pending work when transport reconnects. '.repeat(30);p.member.headBranch='feature/'+'long-branch-name-'.repeat(20);return p};void 0"
    );
    win.setContentSize(900, 600);
    await new Promise((r) => setTimeout(r, 300));
    await focus();
    assert.match(await js<string>(`${content}.textContent`), /Preserve cancellation/);
    await capture('laptop');
    for (const width of [900, 640]) {
      win.setContentSize(width, 600);
      // Resizing can scroll the queue and dismiss the tooltip. Reopen it once resized.
      await wait(`innerWidth === ${width} && innerHeight === 600`);
      await focus();
      await wait(
        `(()=>{const r=${content}?.getBoundingClientRect();return r && r.width > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight})()`
      );
      const rect = await js<{ x: number; y: number; right: number; bottom: number }>(
        `(()=>{const r=${content}.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`
      );
      assert.ok(
        rect.x >= 0 && rect.y >= 0 && rect.right <= width && rect.bottom <= 600,
        `Tooltip fits viewport: ${JSON.stringify({ width, rect })}`
      );
      if (width === 640) await capture('narrow');
    }
    console.log('PR badge preview browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await js('document.body.innerText'));
    await capture('failure');
    app.exit(1);
  }
});
