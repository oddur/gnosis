import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { loadWorkbenchPage } from './workbench-ready';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 1000,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 240; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dir = path.resolve('.impeccable/review/typography');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
    if (!fixtureUrl) throw new Error('Missing fixture URL');
    const url = fixtureUrl.replace('workbench.html', 'typography.html');
    win.webContents.setZoomFactor(1);
    await loadWorkbenchPage(win, url);
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
      for (const surface of ['Explanation', 'PR description', 'Chat', 'Comment', 'Markdown preview']) {
        await js(
          `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(surface)}).click()`
        );
        await wait(
          `document.querySelector('[data-reading-surface]')?.getAttribute('data-reading-surface')===${JSON.stringify(surface)}`
        );
        await js('document.fonts.ready');
        const sizes = await js<number[]>(
          `[...document.querySelectorAll('[data-reading-surface] .markdown-heading')].map(e=>parseFloat(getComputedStyle(e).fontSize))`
        );
        assert.ok(sizes.length > 0);
        if (surface === 'PR description' || surface === 'Comment' || surface === 'Markdown preview') {
          assert.equal(sizes.length, 6);
          assert.ok(
            sizes.every((size, i) => !i || size < sizes[i - 1]),
            `${surface} heading levels must remain distinct: ${sizes.join(', ')}`
          );
        } else assert.ok(sizes[0] > sizes[1], 'Sections must be larger than subsections');
        if (surface === 'PR description')
          assert.deepEqual(
            await js("[...document.querySelectorAll('.markdown-heading')].map(e=>e.tagName)"),
            ['H4', 'H5', 'H6', 'H6', 'H6', 'H6'],
            'Visual hierarchy must not flatten semantic nesting'
          );
        const body = await js<number>(
          "parseFloat(getComputedStyle(document.querySelector('[data-reading-surface] p')).fontSize)"
        );
        assert.ok(body >= (surface === 'Comment' ? 15 : 16));
        assert.ok(await js('document.documentElement.scrollWidth<=window.innerWidth'), 'No document overflow');
        await capture(`${surface.replaceAll(' ', '-').toLowerCase()}-${theme}`);
      }
    }
    win.setContentSize(760, 900);
    win.webContents.setZoomFactor(2);
    for (const surface of ['Explanation', 'PR description', 'Comment', 'Markdown preview']) {
      await js(
        `[...document.querySelectorAll('nav button')].find(b=>b.textContent===${JSON.stringify(surface)}).click()`
      );
      await wait(
        `document.querySelector('[data-reading-surface]')?.getAttribute('data-reading-surface')===${JSON.stringify(surface)}`
      );
      assert.ok(
        await js('document.documentElement.scrollWidth<=window.innerWidth'),
        `${surface} must reflow at 200% zoom`
      );
      await capture(`${surface.replaceAll(' ', '-').toLowerCase()}-zoom`);
    }
    win.webContents.setZoomFactor(1);
    console.log(
      'Typography passed: six distinct heading levels, scoped semantics, reading size, light/dark and 200% zoom without page overflow.'
    );
    app.exit(0);
  } catch (error) {
    win.webContents.setZoomFactor(1);
    console.error(error);
    await capture('failure');
    app.exit(1);
  }
});
