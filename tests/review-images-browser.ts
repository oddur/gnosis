import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(`${code}: ${String(error)}`);
    }) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = (label: string) =>
    js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw new Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?images');
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait(
      "document.querySelectorAll('.review-image-stage img').length===7 && [...document.querySelectorAll('.review-image-stage img')].every(i=>i.naturalWidth>0)"
    );
    assert.equal(await js('window.imageScriptRan'), undefined);
    assert.equal(await js("document.querySelectorAll('.review-image-pair[data-single=true]').length"), 2);
    assert.equal(await js("document.querySelector('.review-image-source').open"), false);
    await js("document.querySelector('.review-image-source summary').click()");
    await wait(
      "document.querySelector('.review-image-source').open && !!document.querySelector('.review-image-source diffs-container')"
    );
    await js("document.querySelector('.review-image-source summary').click()");
    await js("document.querySelector('.review-image-retry').click()");
    await wait(
      "document.querySelectorAll('.review-image-stage img').length===8 && !document.querySelector('.review-image-retry')"
    );
    await js("document.querySelector('.review-file-viewed input').click()");
    assert.equal(await js("document.querySelector('.review-file-content').hidden"), true);
    await js("document.querySelector('.review-file-expand').click()");
    await wait("!document.querySelector('.review-file-content').hidden");
    await js(
      "document.querySelector('.review-image-stage').focus();document.querySelector('.review-image-stage').click()"
    );
    await wait("!!document.querySelector('[role=dialog]')");
    await click('Actual size');
    assert.equal(await js("document.querySelector('.review-image-full').dataset.actualSize"), 'true');
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(await js("document.activeElement.classList.contains('review-image-stage')"), true);
    await js("document.querySelector('.review-file-viewed input').click()");
    const geometry = `(() => {const [a,b]=document.querySelectorAll('.review-image-stage');const x=a.getBoundingClientRect(),y=b.getBoundingClientRect(); return {aligned:Math.abs(x.top-y.top)<1, separated:x.right<y.left, width:x.width, overflow:document.documentElement.scrollWidth>innerWidth};})()`;
    for (const width of [1280, 900]) {
      win.setSize(width, 800);
      await new Promise((r) => setTimeout(r, 250));
      if (width < 1000) await click('Code');
      const g = await js<{ aligned: boolean; separated: boolean; width: number; overflow: boolean }>(geometry);
      assert.ok(g.aligned && g.separated && g.width > 80 && !g.overflow, JSON.stringify(g));
    }
    win.setSize(1280, 800);
    await new Promise((r) => setTimeout(r, 300));
    await wait("document.querySelectorAll('.review-image-stage img').length>=7");
    await js("document.querySelector('.review-image-diff').scrollIntoView({block:'start'})");
    await js('document.fonts.ready');
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-images-light.png'), (await win.webContents.capturePage()).toPNG());
    await js("document.documentElement.classList.add('dark')");
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-images-dark.png'), (await win.webContents.capturePage()).toPNG());
    console.log(
      'Image comparison browser checks passed: raster/SVG, two columns, added/deleted, source, safe SVG, retry, Viewed, zoom and focus.'
    );
  } catch (error) {
    console.error(error);
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-images-failure.png'),
      (await win.webContents.capturePage()).toPNG()
    );
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
