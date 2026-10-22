import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = (code: string) => window.webContents.executeJavaScript(code);
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = async (text: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing button: '+${JSON.stringify(text)});b.click();})()`
    );
  };
  const shots = process.env.GNOSIS_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'gnosis-workbench-screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.env.GNOSIS_WORKBENCH_URL!);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js("getComputedStyle(document.querySelector('.queue-toolbar h1')).fontSize"), '22px');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("document.querySelector('.briefing-panel')?.textContent.includes('Cancellation must release')");
    await js('document.querySelector(\'.queue-disclosure[aria-label*="Introduce"]\').click()');
    assert.equal(await js("document.querySelectorAll('.queue-member').length"), 3);
    await capture('queue-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('queue-dark');
    await click('Continue review');
    await wait("!!document.querySelector('.workbench-overview')");
    await capture('overview-dark');
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    assert.equal(await js("document.querySelectorAll('.source-attribution').length"), 1);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await capture('review-dark');
    await click('Ask a question');
    await wait("!!document.querySelector('.review-tool-slot .chat-sheet')");
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 350"), true);
    await capture('chat-dark');
    await click('Close chat');
    await click('Explore');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js("document.querySelector('.review-narrative').getBoundingClientRect().width > 250"), true);
    await capture('exploration-dark');
    await click('Close exploration');
    await js("document.documentElement.classList.remove('dark')");
    await capture('review-light');
    window.setSize(1440, 900);
    await capture('review-large');
    window.setSize(800, 700);
    await wait('innerWidth <= 800');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await wait('!!document.querySelector(\'[aria-label="Review pane"]\')');
    await click('Code');
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 600"), true);
    await capture('review-narrow');
    await click('Explanation');
    await click('Explore');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(
      await js("document.querySelector('.review-tool-slot iframe').getBoundingClientRect().width > 600"),
      true
    );
    await capture('exploration-narrow');
    console.log('Workbench browser checks passed. Screenshots: ' + shots);
  } catch (error) {
    console.error(error);
    console.log(await js('document.body.innerText'));
    await capture('failure');
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
