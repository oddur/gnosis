import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>;
  const wait = async (source: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${source}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    // Let theme, zoom, and finite dialog transitions reach their rendered frame.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const dir = path.resolve('.impeccable/review/loading-states');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const base = process.env.GNOSIS_WORKBENCH_URL ?? '';
    // Exercise an actual delayed Settings read, including closing it while it is pending.
    await loadWorkbenchPage(win, base);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{const read=window.electronAPI.loadPreferences;window.electronAPI.loadPreferences=()=>new Promise(resolve=>{window.releaseSettings=()=>read().then(resolve)})})()`
    );
    // Use the regular Settings entry point.
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait(`!!document.querySelector('[role=dialog] .loading-state')`);
    await capture('settings-light');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await js(`window.releaseSettings()`);
    await wait(`!document.querySelector('[role=dialog]')`);
    await loadWorkbenchPage(win, new URL('/tests/fixtures/loading-states.html', base).href);
    await wait(`document.querySelector('.loading-signal')?.getAnimations().length === 1`);
    await wait(`document.querySelector('#offscreen [data-loading-visible]')?.dataset.loadingVisible==='false'`);
    assert.equal(
      await js(`getComputedStyle(document.querySelector('#offscreen .loading-signal')).animationPlayState`),
      'paused'
    );
    assert.equal(
      await js(`document.querySelectorAll('[role=progressbar]').length`),
      0,
      'No simulated completion percentage'
    );
    await capture('laptop-light');
    await js(`document.documentElement.classList.add('dark')`);
    await capture('laptop-dark');
    win.setContentSize(760, 640);
    await capture('compact-dark');
    win.webContents.setZoomFactor(2);
    await wait(`innerWidth <= 380 && document.documentElement.scrollWidth <= innerWidth`);
    await capture('zoom-dark');
    win.webContents.setZoomFactor(1);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.ok(
      await js(
        `Array.from(document.querySelectorAll('.loading-signal,.loading-spinner')).every(el=>getComputedStyle(el).animationName==='none')`
      )
    );
    assert.ok(await js(`document.querySelector('[role=status]').textContent.includes('Loading changed files')`));
    await js(`document.querySelector('button').click()`);
    await wait(`document.body.innerText.includes('Changes are ready.')`);
    assert.equal(await js(`document.querySelectorAll('.workflow-graph-state .loading-state').length`), 0);
    win.webContents.debugger.detach();
    console.log(
      'Loading state browser checks passed: delayed settings and dismissal, shared motion, offscreen pause, light/dark, compact/zoom, reduced motion, and completion.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    win.destroy();
    app.exit(1);
  }
});
