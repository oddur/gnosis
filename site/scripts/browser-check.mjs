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
      await js('document.activeElement?.blur(); scrollTo({top:0,left:0,behavior:"instant"})');
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
      assert.equal(
        await js("performance.getEntriesByType('resource').some(e=>e.name.endsWith('/onest-latin.woff2'))"),
        true
      );
      assert.equal(
        await js("performance.getEntriesByType('resource').some(e=>e.name.endsWith('/onest-extended.woff2'))"),
        false,
        'English page must not fetch the extended font'
      );
      await js("document.fonts.load('400 20px Onest', 'Český Привет')");
      assert.equal(
        await js("performance.getEntriesByType('resource').some(e=>e.name.endsWith('/onest-extended.woff2'))"),
        true,
        'Extended characters load their subset when requested'
      );
      assert.equal(await js("document.querySelectorAll('[data-pr][open]').length"), 1);
      assert.equal(await js("document.querySelector('[data-pr][open]').dataset.pr"), '1');
      assert.equal(await current(), '1 / 5');
      assert.equal(await js("document.querySelector('.source-line.is-removed .sr-only').textContent"), 'Removed: ');
      assert.equal(await js("document.querySelector('.source-line.is-added .sr-only').textContent"), 'Added: ');
      // Reproduce the actual JS semantics independently of the illustration state table.
      const executions = await js(`(async()=>{
        async function runCase(withAwait) {
          let occupied=false,active=0,peak=0;
          const waiting=[],finish={},released=[];
          const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
          const acquire=()=>new Promise(resolve=>{
            const grant=()=>{occupied=true;resolve({release(){occupied=false;waiting.shift()?.()}})};
            if(occupied)waiting.push(grant);else grant();
          });
          const run=command=>new Promise(resolve=>{
            active++;peak=Math.max(peak,active);
            finish[command]=()=>{active--;resolve(command)};
          });
          async function dispatch(command) {
            const slot=await acquire();
            try { if(withAwait)return await run(command);return run(command); }
            finally { released.push(command);slot.release(); }
          }
          const a=dispatch('A'),b=dispatch('B');
          await flush();
          const pending={active,peak,released:[...released]};
          finish.A();await flush();
          const afterA={active,peak,released:[...released]};
          finish.B();const result=await Promise.all([a,b]);
          return {pending,afterA,result,active};
        }
        return {before:await runCase(false),after:await runCase(true)};
      })()`);
      assert.deepEqual(executions.before.pending, { active: 2, peak: 2, released: ['A', 'B'] });
      assert.deepEqual(executions.after.pending, { active: 1, peak: 1, released: [] });
      assert.deepEqual(executions.after.afterA, { active: 1, peak: 1, released: ['A'] });
      assert.deepEqual(executions.before.result, ['A', 'B']);
      assert.deepEqual(executions.after.result, ['A', 'B']);
      assert.equal(executions.before.active, 0);
      assert.equal(executions.after.active, 0);
      for (const index of [0, 2, 1]) {
        await click(`[data-pr="${index}"] summary`);
        await pause(70);
        assert.equal(await js("document.querySelectorAll('[data-pr][open]').length"), 1);
        assert.ok(await js(`document.querySelector('[data-pr="${index}"] pre').textContent.length > 40`));
      }
      const captureExample = async (name) => {
        await js("document.querySelector('#example').scrollIntoView({behavior:'instant'})");
        await pause(750);
        const clip = await js(
          "(()=>{const r=document.querySelector('#example').getBoundingClientRect();return {x:r.left,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()"
        );
        const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip,
        });
        fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(shot.data, 'base64'));
      };
      const activeCounts = () => js("[...document.querySelectorAll('[data-active-count]')].map(n=>n.textContent)");
      const peaks = () => js("[...document.querySelectorAll('[data-peak]')].map(n=>n.textContent)");
      await click('[data-next]');
      assert.equal(await current(), '2 / 5');
      assert.equal(
        await js("document.querySelector('[data-lane=before] [data-slot]').textContent"),
        'Free while A runs'
      );
      await captureExample('await-early-release');
      await click('[data-next]');
      assert.deepEqual(await activeCounts(), ['2 active · limit exceeded', '1 active']);
      assert.deepEqual(await peaks(), ['2', '1']);
      await captureExample('await-overlap');
      await click('[data-prev]');
      assert.equal(await current(), '2 / 5');
      assert.deepEqual(await peaks(), ['1', '1']);
      await click('[data-next]');
      await click('[data-next]');
      await click('[data-next]');
      assert.equal(await current(), '5 / 5');
      assert.deepEqual(await activeCounts(), ['0 active', '0 active']);
      assert.deepEqual(await peaks(), ['2', '1']);
      assert.equal(await js("document.querySelector('[data-next]').disabled"), true);
      assert.equal(await js("document.querySelector('[data-play-label]').textContent"), 'Replay');
      await captureExample('await-complete');
      await click('[data-play]');
      assert.equal(await current(), '1 / 5');
      await pause(2550);
      assert.equal(await current(), '2 / 5');
      await click('[data-play]');
      await pause(4400);
      assert.equal(await current(), '2 / 5');
      await click('[data-reset]');
      assert.equal(await js("document.querySelector('[data-prev]').disabled"), true);
      await click('[data-play]');
      await click('[data-pr="0"] summary');
      await pause(2550);
      assert.equal(await js("document.querySelector('[data-count]').textContent"), '1 / 5');
      await click('[data-pr="1"] summary');
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
      await click('[data-reset]');
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
      const featureIds = ['stacks', 'changes', 'markdown', 'chat', 'checks', 'conflicts'];
      const captureTour = async (name) => {
        await js("document.querySelector('#features').scrollIntoView({behavior: 'instant'})");
        await pause(100);
        const clip = await js(
          "(()=>{const r=document.querySelector('#features').getBoundingClientRect();return {x:0,y:r.top+scrollY,width:innerWidth,height:r.height,scale:1}})()"
        );
        const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip,
        });
        fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(shot.data, 'base64'));
      };
      let firstPanelHeight;
      for (const id of featureIds) {
        await click(`[data-feature-tab="${id}"]`);
        assert.equal(
          await js(`document.querySelector('[data-feature-tab="${id}"]').getAttribute('aria-selected')`),
          'true'
        );
        assert.equal(await js("document.querySelectorAll('[data-feature-panel]:not([hidden])').length"), 1);
        assert.equal(await js(`document.querySelector('#feature-${id} img').naturalWidth > 0`), true);
        const panelHeight = await js("document.querySelector('#features').getBoundingClientRect().height");
        if (firstPanelHeight === undefined) firstPanelHeight = panelHeight;
        assert.ok(
          Math.abs(panelHeight - firstPanelHeight) < 2,
          'Desktop feature panels must not shift following sections'
        );
        await noOverflow();
        await audit('feature-' + id);
        await captureTour('feature-' + id);
      }
      await js("document.querySelector('[data-feature-tab=conflicts]').focus()");
      for (const [key, expected] of [
        ['ArrowRight', 'stacks'],
        ['End', 'conflicts'],
        ['Home', 'stacks'],
        ['ArrowLeft', 'conflicts'],
      ]) {
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
        assert.equal(await js('document.activeElement.dataset.featureTab'), expected);
        assert.equal(await js('document.activeElement.getAttribute("aria-selected")'), 'true');
      }
      await click('[data-feature-tab="stacks"]');
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
      for (const id of featureIds) {
        await click(`[data-feature-tab="${id}"]`);
        await noOverflow();
        await captureTour('feature-mobile-' + id);
      }
      await click('[data-feature-tab="stacks"]');
      await click('[data-next]');
      await click('[data-next]');
      await noOverflow();
      await capture('mobile-step');
      await captureExample('await-mobile-overlap');
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
        await js(
          "document.querySelector('[data-pr=\"1\"] pre').textContent.includes('return await worker.run(command)')"
        )
      );
      assert.equal(
        await js("document.querySelectorAll('[data-feature-panel]:not([hidden])').length"),
        6,
        'All features remain available without scripts'
      );
      await load('/changelog/');
      await load('/#feature-checks');
      assert.equal(
        await js("document.querySelector('[data-feature-tab=checks]').getAttribute('aria-selected')"),
        'true',
        'Deep links select their feature'
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
