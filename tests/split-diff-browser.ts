import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const js = async <T = unknown>(code: string): Promise<T> => {
    try {
      return (await window.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      throw new Error(`Browser assertion failed: ${code}\n${String(error)}`);
    }
  };
  const wait = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw new Error('Missing fixture URL');
    await window.loadURL(url);
    await wait('!!document.querySelector("[data-case=added] [data-line-number]")');
    for (const name of ['metadata-added', 'metadata-deleted', 'added', 'deleted', 'added-plain']) {
      const dimensions = await js<{ offset: number; width: number; available: number }>(`(() => {
        const section = document.querySelector('[data-case=${name}]');
        const line = section.querySelector('[data-line-number], [data-base-line]');
        const box = line.getBoundingClientRect();
        const parent = (section.querySelector('.review-file-group') ?? section).getBoundingClientRect();
        return {offset: box.left - parent.left, width: box.width, available: parent.width};
      })()`);
      assert.ok(dimensions.offset < 100, `${name}: code starts ${dimensions.offset}px into the pane`);
      assert.ok(dimensions.width > dimensions.available * 0.8, `${name}: code should use the full pane`);
    }
    for (const name of ['insert', 'modify']) {
      assert.ok(
        await js(`!!document.querySelector('[data-case=${name}] .split-diff-separator')`),
        `${name} must stay split`
      );
    }
    for (const [name, side] of [
      ['added', 'RIGHT'],
      ['deleted', 'LEFT'],
    ]) {
      await js(`document.querySelector('[data-case=${name}] [title="Comment on line 1"]').click()`);
      await wait(`!!document.querySelector('[data-case=${name}] textarea')`);
      await js(`(() => {
        const field = document.querySelector('[data-case=${name}] textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Check this line');
        field.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      await wait(
        `Array.from(document.querySelectorAll('[data-case=${name}] button')).some(b=>b.textContent.includes('Add comment') && !b.disabled)`
      );
      await js(
        `Array.from(document.querySelectorAll('[data-case=${name}] button')).find(b=>b.textContent.includes('Add comment')).click()`
      );
      await wait(`JSON.parse(document.querySelector('#comments').textContent).some(c=>c.filePath==='${name}.ts')`);
      const comments = await js<{ filePath: string; side: string; line: number }[]>(
        'JSON.parse(document.querySelector("#comments").textContent)'
      );
      assert.ok(comments.some((c) => c.filePath === name + '.ts' && c.side === side && c.line === 1));
    }
    console.log('Split diff layout and comment checks passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-split-diff.png'), (await window.webContents.capturePage()).toPNG());
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
