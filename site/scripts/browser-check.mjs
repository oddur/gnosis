import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = process.env.GNOSIS_SITE_ROOT;
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-site-test-')));
const shots = path.resolve(root, '../.impeccable/review/site');
fs.mkdirSync(shots, { recursive: true });
app
  .whenReady()
  .then(async () => {
    console.log('Checking built site in Electron.');
    const win = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: true,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*.aptabase.com/*'] }, (_details, cb) =>
      cb({ cancel: true })
    );
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(event.message);
    });
    await win.webContents.debugger.attach('1.3');
    const load = async (route = '/') => {
      await win.loadURL(process.env.GNOSIS_SITE_URL + route);
      console.log('Loaded ' + route);
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await js('document.fonts.ready');
      await js("Promise.all([...document.images].map(i=>{i.loading='eager';return i.decode().catch(()=>{})}))");
      await pause(100);
    };
    const capture = async (name, full = true) => {
      await js('scrollTo(0,0)');
      await pause(70);
      const dimensions = await js('({w:innerWidth,h:document.documentElement.scrollHeight})');
      const data = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: dimensions.w, height: full ? dimensions.h : 900, scale: 1 },
      });
      fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(data.data, 'base64'));
    };
    const noOverflow = async () =>
      assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'), 'Page must not scroll sideways');
    const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const current = () => js("document.querySelector('[data-pr][open] [data-count]').textContent.trim()");
    const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [root] }), 'utf8');
    const audit = async (name) => {
      await js(axeSource + ';void 0');
      const report = await js("axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})");
      fs.writeFileSync(path.join(shots, name + '-a11y.json'), JSON.stringify(report.violations, null, 2));
      assert.deepEqual(
        report.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
        [],
        name + ' accessibility'
      );
    };
    try {
      await load();
      assert.equal(await js("document.querySelectorAll('[data-pr][open]').length"), 1);
      assert.equal(await js("document.querySelector('[data-pr][open]').dataset.pr"), '1');
      assert.equal(await current(), '1 / 3');
      for (const index of [0, 2, 1]) {
        await click(`[data-pr="${index}"] summary`);
        await pause(70);
        assert.equal(await js("document.querySelectorAll('[data-pr][open]').length"), 1);
        await click(`[data-pr="${index}"] [data-next]`);
        assert.equal(await current(), '2 / 3');
        await click(`[data-pr="${index}"] [data-next]`);
        assert.equal(await current(), '3 / 3');
        assert.equal(await js(`document.querySelector('[data-pr="${index}"] [data-next]').disabled`), true);
        assert.equal(
          await js(`document.querySelector('[data-pr="${index}"] [data-play-label]').textContent`),
          'Replay'
        );
        await click(`[data-pr="${index}"] [data-reset]`);
        assert.equal(await current(), '1 / 3');
      }
      await click('[data-pr="1"] [data-play]');
      await pause(1750);
      assert.equal(await current(), '2 / 3');
      await click('[data-pr="1"] [data-play]');
      await pause(2400);
      assert.equal(await current(), '2 / 3');
      await click('[data-pr="1"] [data-reset]');
      // Switching PRs must cancel playback in the previous PR.
      await click('[data-pr="1"] [data-play]');
      await click('[data-pr="0"] summary');
      await pause(1800);
      assert.equal(await js('document.querySelector(\'[data-pr="1"] [data-count]\').textContent'), '1 / 3');
      await click('[data-pr="1"] summary');
      // Native Enter includes a character event, unlike React keydown handlers.
      win.show();
      win.focus();
      win.webContents.focus();
      await js('document.querySelector(\'[data-pr="2"] summary\').focus()');
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      });
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await pause(100);
      assert.equal(await js('document.querySelector(\'[data-pr="2"]\').open'), true);
      await click('[data-pr="1"] summary');
      await click('[data-pr="1"] [data-reset]');
      await js(
        "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text}}});void 0"
      );
      await click('#copy-brew');
      assert.equal(await js('window.copied'), 'brew tap oddur/gnosis && brew install --cask gnosis');
      assert.equal(await js("document.querySelector('#copy-status').textContent"), 'Install command copied.');
      await js("navigator.clipboard.writeText=async()=>{throw Error('Denied')};void 0");
      await click('#copy-brew');
      assert.match(await js("document.querySelector('#copy-status').textContent"), /copy it manually/);
      await load();
      await noOverflow();
      await audit('desktop');
      await capture('desktop');
      await capture('hero', false);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      assert.equal(
        await js("getComputedStyle(document.querySelector('[data-pr][open] [data-command]')).transitionDuration"),
        '0s'
      );
      await click('[data-pr="1"] [data-next]');
      await capture('reduced-motion', false);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.setContentSize(1280, 800);
      await load();
      await noOverflow();
      await capture('laptop');
      win.setContentSize(390, 844);
      await load();
      await noOverflow();
      await audit('mobile');
      await capture('mobile');
      await click('[data-pr="2"] summary');
      await click('[data-pr="2"] [data-next]');
      await noOverflow();
      await capture('mobile-step');
      win.setContentSize(320, 740);
      await load();
      await noOverflow();
      await capture('narrow');
      win.setContentSize(1440, 1000);
      await load('/changelog/');
      await noOverflow();
      await audit('changelog');
      await capture('changelog', false);
      assert.ok(
        await js("document.querySelectorAll('.release').length>0||!!document.querySelector('.release-unavailable')")
      );
      win.setContentSize(390, 844);
      await noOverflow();
      await capture('changelog-mobile', false);
      // Progressive enhancement: the initial selected PR remains useful without scripts.
      await win.webContents.debugger.sendCommand('Emulation.setScriptExecutionDisabled', { value: true });
      await win.loadURL(process.env.GNOSIS_SITE_URL + '/');
      await win.webContents.debugger.sendCommand('Emulation.setScriptExecutionDisabled', { value: false });
      assert.equal(await js('document.querySelector(\'[data-pr="1"]\').open'), true);
      assert.equal(await js('document.querySelector(\'[data-pr="1"] [data-controls]\').hidden'), true);
      assert.ok(
        await js("document.querySelector('[data-pr=\"1\"] .source-line').textContent.includes('queue.take(2)')")
      );
      assert.deepEqual(errors, [], 'No browser errors');
      console.log(
        'Site browser checks passed: all PRs, playback, replay/reset, keyboard, copy success/failure, reduced motion, no-JS, responsive layouts, changelog, WCAG A/AA. Captures: ' +
          shots
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      try {
        await capture('failure');
      } catch {
        /* The browser may already be closed when a capture fails. */
      }
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
