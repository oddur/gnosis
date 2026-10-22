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
