import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildExplainerDocument } from '../lib/explainer-document';
import { validateExplainerInBrowser, protectExplainerFrames } from '../src/explainer-validation';
import { explainer } from './fixtures/explainer';

app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  try {
    await validateExplainerInBrowser(explainer);
    await assert.rejects(validateExplainerInBrowser({ ...explainer, javascript: 'not valid javascript !!!' }));
    await assert.rejects(
      validateExplainerInBrowser({ ...explainer, javascript: 'window.explainer = {};' }),
      /reset, step/
    );
    await assert.rejects(
      validateExplainerInBrowser({ ...explainer, javascript: 'while (true) {}' }),
      /within 10 seconds/
    );
    await assert.rejects(
      validateExplainerInBrowser({
        ...explainer,
        javascript:
          explainer.javascript +
          '\ncount.addEventListener("input", () => { if (count.value === "5") throw new Error("maximum input failed"); });',
      }),
      /maximum input failed/
    );
    await validateExplainerInBrowser({
      ...explainer,
      javascript:
        explainer.javascript +
        `
if (typeof window.electronAPI !== 'undefined' || typeof require !== 'undefined') throw new Error('Host API leaked');
let accessed = false; try { accessed = !!parent.document.body; } catch {}
if (accessed) throw new Error('Parent DOM leaked');`,
    });

    // Exercise the production iframe policy without the validator's extra
    // session-wide network block: fetches, images and navigation must fail.
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('unexpected');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/leak`;
    const preload = path.join(__dirname, 'probe-preload.cjs');
    fs.writeFileSync(
      preload,
      "require('electron').contextBridge.exposeInMainWorld('electronAPI', {hostMarker: true});"
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    protectExplainerFrames(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await window.loadURL('data:text/html,<html><body></body></html>');
      assert.equal(await window.webContents.executeJavaScript('window.electronAPI.hostMarker'), true);
      const html = buildExplainerDocument(
        {
          ...explainer,
          html:
            explainer.html +
            '<iframe src="' +
            url +
            '"></iframe><meta http-equiv="refresh" content="0;url=' +
            url +
            '">',
          javascript:
            explainer.javascript +
            `
if (typeof window.electronAPI !== 'undefined') throw new Error('App preload leaked into the generated frame');
fetch(${JSON.stringify(url)}).catch(() => {});
const image = new Image(); image.src = ${JSON.stringify(url)};
window.open(${JSON.stringify(url)});
setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 20);`,
        },
        'sandbox-test'
      );
      const ready: unknown = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
        addEventListener('message', e => { if (e.source === frame.contentWindow && e.data?.event === 'ready') resolve(true); });
        frame.srcdoc = ${JSON.stringify(html)}; document.body.append(frame);
        setTimeout(() => resolve(false), 2000);
      })`);
      assert.equal(ready, true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(requests, 0, 'the sandbox cannot send data or navigate to a network endpoint');
    } finally {
      window.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Tall saved diagrams fit beside their controls without scaling up text.
    const layoutWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    try {
      const tall = {
        ...explainer,
        html: '<section><div><label>Queue length <input id="count" type="range" min="1" max="5" value="3"></label></div><svg viewBox="0 0 900 650"><text id="state" x="30" y="100"></text></svg><p>Step through the queue to remove one item at a time.</p></section>',
        css: 'svg {width:100%} svg text {font-size:20px}',
      };
      const document = buildExplainerDocument(tall, 'layout-test');
      await layoutWindow.loadURL('data:text/html,<body style="margin:0"></body>');
      await layoutWindow.webContents.executeJavaScript(`{
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts'; frame.style = 'width:100vw;height:100vh;border:0;display:block';
        frame.srcdoc = ${JSON.stringify(document)}; document.body.append(frame);
      }`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const frame = layoutWindow.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc');
      assert.ok(frame);
      for (const [width, height] of [
        [1600, 700],
        [1050, 550],
        [800, 450],
      ]) {
        layoutWindow.setContentSize(width, height);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const metrics = (await frame.executeJavaScript(`({
          height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          svgWidth: document.querySelector('svg').getBoundingClientRect().width,
          textScale: document.querySelector('svg').getScreenCTM().a,
          controlFont: parseFloat(getComputedStyle(document.querySelector('input')).fontSize)
        })`)) as {
          height: number;
          scrollHeight: number;
          width: number;
          scrollWidth: number;
          svgWidth: number;
          textScale: number;
          controlFont: number;
        };
        assert.ok(metrics.scrollHeight <= metrics.height + 1, 'fitted diagram has no vertical scrolling');
        assert.ok(metrics.scrollWidth <= metrics.width + 1, 'fitted diagram has no horizontal scrolling');
        assert.ok(metrics.svgWidth <= 900, 'a wide window does not enlarge diagram labels');
        assert.ok(metrics.textScale >= 0.5, 'the diagram retains legible labels');
        assert.ok(metrics.controlFont >= 13, 'fitting does not shrink the input text');
      }
      const command = async (command: string) => {
        await layoutWindow.webContents.executeJavaScript(
          `document.querySelector('iframe').contentWindow.postMessage({type:'gnosis-explainer-control', token:'layout-test', command:${JSON.stringify(command)}}, '*')`
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      };
      await command('step');
      await command('actual-size');
      await command('fit');
      assert.equal(
        await frame.executeJavaScript('document.getElementById("state").textContent'),
        '2 items waiting',
        'changing layout retains the simulation state'
      );
      await frame.executeJavaScript(
        `{const input = document.getElementById('count'); input.value='5'; input.dispatchEvent(new Event('input', {bubbles:true}));}`
      );
      assert.equal(
        await frame.executeJavaScript('document.getElementById("state").textContent'),
        '5 items waiting',
        'moved controls retain their listeners'
      );
    } finally {
      layoutWindow.destroy();
    }
    const ui = new BrowserWindow({
      show: false,
      width: 1400,
      height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    protectExplainerFrames(ui);
    async function waitFor(expression: string) {
      for (let i = 0; i < 50; i++) {
        if (await ui.webContents.executeJavaScript(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('UI check timed out: ' + expression);
    }
    const button = (text: string) =>
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    try {
      await ui.loadFile(path.join(__dirname, 'ui.html'));
      await waitFor(`${button('Play')} && !${button('Play')}.disabled`);
      const frame = ui.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc');
      assert.ok(frame);
      assert.equal(await frame.executeJavaScript('document.getElementById("state").textContent'), '3 items waiting');
      await ui.webContents.executeJavaScript(`${button('Step')}.click()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await frame.executeJavaScript('document.getElementById("state").textContent'), '2 items waiting');
      await ui.webContents.executeJavaScript(`${button('Reset')}.click()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await frame.executeJavaScript('document.getElementById("state").textContent'), '3 items waiting');
      await ui.webContents.executeJavaScript(`${button('Play')}.click()`);
      await waitFor(`!!${button('Pause')}`);
      await ui.webContents.executeJavaScript(`${button('Pause')}.click()`);
      await waitFor(`!!${button('Play')}`);
      await ui.webContents.executeJavaScript(`${button('Details & refine')}.click()`);
      await ui.webContents.executeJavaScript(`${button('queue.ts')}.click()`);
      await waitFor(`document.querySelector('pre')?.textContent.includes('queue.shift()')`);
      for (const instruction of ['two requests', 'fail']) {
        await ui.webContents.executeJavaScript(`{
          const input = document.querySelector('textarea');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(instruction)});
          input.dispatchEvent(new Event('input', {bubbles: true}));
        }`);
        await waitFor(`!${button('Refine')}.disabled`);
        await ui.webContents.executeJavaScript(`${button('Refine')}.click()`);
        await waitFor(
          instruction === 'fail'
            ? `document.body.textContent.includes('Example generation failed.')`
            : `document.querySelector('h1').textContent === 'Refined queue'`
        );
      }
      assert.equal(
        await ui.webContents.executeJavaScript(`document.querySelector('h1').textContent`),
        'Refined queue',
        'failed refinement keeps the previous artifact'
      );
      await ui.webContents.executeJavaScript(`${button('Back to explanation')}.click()`);
      await waitFor(`document.body.textContent.includes('Returned to review')`);
    } finally {
      ui.destroy();
    }
    console.log(
      'Explainer browser checks passed: playback, input boundaries, errors, timeouts, host isolation, network, navigation, and React UI/refinement.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
