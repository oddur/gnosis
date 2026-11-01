import { loadWorkbenchPage } from './workbench-ready';
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
    await loadWorkbenchPage(window, url);
    await js(
      `void (window.diffRoot = name => document.querySelector('[data-case=' + name + '] diffs-container')?.shadowRoot)`
    );
    await wait('!!window.diffRoot("added")?.querySelector("[data-line-number]")');
    for (const name of ['metadata-added', 'metadata-deleted', 'added', 'deleted', 'added-plain']) {
      const dimensions = await js<{ offset: number; width: number; available: number }>(`(() => {
        const section = document.querySelector('[data-case=${name}]');
        const line = window.diffRoot('${name}').querySelector('[data-line-number], [data-base-line]');
        const box = line.getBoundingClientRect();
        const parent = (section.querySelector('.review-file-group') ?? section).getBoundingClientRect();
        return {offset: box.left - parent.left, width: box.width, available: parent.width};
      })()`);
      assert.ok(dimensions.offset < 100, `${name}: code starts ${dimensions.offset}px into the pane`);
      assert.ok(dimensions.width > dimensions.available * 0.8, `${name}: code should use the full pane`);
    }
    for (const name of ['insert', 'modify']) {
      assert.ok(
        await js(`!!window.diffRoot('${name}').querySelector('[data-code][data-deletions]')`),
        `${name} must stay split`
      );
    }
    for (const side of ['deletions', 'additions']) {
      assert.equal(
        await js(`(() => {
        const slot = document.querySelector('[data-case=modify] [slot="annotation-${side}-1"]');
        return !!slot?.querySelector('.inline-code-explanation') && !!slot.assignedSlot?.closest('[data-${side}]');
      })()`),
        true,
        `Generated notes render on the ${side} side`
      );
    }
    assert.deepEqual(
      await js(
        `[...document.querySelectorAll('[data-case=modify] [slot="annotation-additions-1"] .inline-code-explanation')].map(note => note.textContent)`
      ),
      ['Callers can now proceed without waiting.', 'The flag is initialized before importers use the module.'],
      'Distinct insights anchored to the same statement both remain visible'
    );
    for (const [name, side] of [
      ['added', 'RIGHT'],
      ['deleted', 'LEFT'],
    ]) {
      await js(`window.diffRoot('${name}').querySelector('[data-column-number="1"]').click()`);
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
    // Fold saved context, preserving real source coordinates and pending comments.
    await js(
      `void (window.contextLines = () => Array.from(document.querySelectorAll('[data-case=context] diffs-container')).flatMap(h=>Array.from(h.shadowRoot.querySelectorAll('[data-line]'))))`
    );
    assert.equal(await js(`window.contextLines().filter(l=>l.dataset.lineType!=='context').length`), 4);
    assert.equal(await js(`window.contextLines().some(l=>l.textContent.includes('const context0 '))`), false);
    assert.equal(await js(`document.querySelectorAll('[data-case=context] .diff-context-gap').length`), 3);
    await js(`document.querySelector('[data-case=context]').scrollIntoView({block:'start'})`);
    if (process.platform === 'darwin') app.show();
    window.show();
    window.focus();
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-folded-context.png'),
      (await window.webContents.capturePage()).toPNG()
    );
    await js(`document.querySelector('[data-case=context] .diff-context-gap button').click()`);
    await wait(`window.contextLines().some(l=>l.dataset.lineNumber==='60')`);
    await js(
      `(() => { const line=window.contextLines().find(l=>l.dataset.lineNumber==='60'); line.closest('[data-code]').querySelector('[data-column-number="60"]').click(); })()`
    );
    await wait(`!!document.querySelector('[data-case=context] textarea')`);
    await js(`(() => {
      const field=document.querySelector('[data-case=context] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Keep this source context');
      field.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await js(
      `Array.from(document.querySelectorAll('[data-case=context] button')).find(b=>b.getAttribute('aria-label')==='Hide extra context').click()`
    );
    assert.equal(await js(`document.querySelector('[data-case=context] textarea').value`), 'Keep this source context');
    await js(
      `Array.from(document.querySelectorAll('[data-case=context] button')).find(b=>b.textContent==='Add comment').click()`
    );
    await wait(`JSON.parse(document.querySelector('#comments').textContent).some(c=>c.filePath==='context.ts')`);
    await js(
      `Array.from(document.querySelectorAll('[data-case=context] button')).find(b=>b.getAttribute('aria-label')==='Hide extra context').click()`
    );
    await wait(`window.contextLines().some(l=>l.dataset.lineNumber==='60')`);
    assert.ok(
      await js(`document.querySelector('[data-case=context]').textContent.includes('Keep this source context')`)
    );
    const savedComment = await js<{ line: number; side: string; hunkHeader: string }>(
      `JSON.parse(document.querySelector('#comments').textContent).find(c=>c.filePath==='context.ts')`
    );
    assert.equal(savedComment.line, 60);
    assert.equal(savedComment.side, 'RIGHT');
    assert.equal(savedComment.hunkHeader, '@@ -40,61 +60,61 @@');
    await js(
      `Array.from(document.querySelectorAll('[data-case=context] .diff-context-gap button')).filter(b=>b.getAttribute('aria-label')?.startsWith('Show all')).forEach(b=>b.click())`
    );
    await wait(`window.contextLines().some(l=>l.textContent.includes('const context60 '))`);
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Toggle fixture layout').click()`
    );
    await wait(
      `Array.from(document.querySelectorAll('[data-case=context] diffs-container')).every(h=>h.shadowRoot.querySelector('[data-code][data-unified]'))`
    );
    assert.ok(await js(`window.contextLines().some(l=>l.dataset.lineNumber==='120')`));
    // Review checks cross the renderer's shadow boundary and select exact code.
    await js("document.querySelector('[data-case=metadata-added] .review-file-expand').click()");
    assert.equal(await js("document.querySelector('[data-case=metadata-added] .review-file-content').hidden"), true);
    await js(
      `Array.from(document.querySelectorAll('[data-case=metadata-added] span')).find(b=>b.textContent==='Verify the ready flag' && b.className.includes('cursor-pointer')).click()`
    );
    await wait(`!!window.diffRoot('metadata-added').querySelector('[data-line-number="1"].check-highlight')`);
    assert.equal(
      await js("document.querySelector('[data-case=metadata-added] .review-file-content').hidden"),
      false,
      'A review check reveals its target inside a collapsed file'
    );
    await js('document.fonts.ready');
    await js(`(() => {
      const line = window.diffRoot('metadata-added').querySelector('[data-line-number="1"]');
      // Stop the check-link's smooth scroll before testing independent selection scrolling.
      line.scrollIntoView({behavior:'instant', block:'center'});
      const range = document.createRange(); range.selectNodeContents(line);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      line.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, composed:true}));
    })()`);
    await wait(
      `Array.from(document.querySelectorAll('.review-selection-actions button')).some(b=>b.textContent.includes('Ask about this'))`
    );
    await wait("document.querySelector('.review-selection-actions')?.style.visibility === 'visible'");
    const menuBounds = await js<{ left: number; right: number; top: number; bottom: number }>(
      "JSON.parse(JSON.stringify(document.querySelector('.review-selection-actions').getBoundingClientRect()))"
    );
    assert.ok(menuBounds.left >= 0 && menuBounds.right <= 1280 && menuBounds.top >= 0 && menuBounds.bottom <= 900);
    await js(
      "Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async(text)=>{window.copiedCode=text;}}})"
    );
    await js("document.querySelector('.review-selection-actions button:last-child').click()");
    await wait("document.querySelector('.review-selection-actions').textContent.includes('Copied')");
    assert.equal(await js('window.copiedCode'), 'export const ready = true;');
    await js("document.documentElement.classList.remove('dark')");
    const waitForAnchoredMenu = async () => {
      try {
        await wait(`(() => {
          const anchor = window.diffRoot('metadata-added').querySelector('[data-line-number="1"]').getBoundingClientRect();
          const menu = document.querySelector('.review-selection-actions').getBoundingClientRect();
          return Math.min(Math.abs(menu.top-anchor.bottom),Math.abs(menu.bottom-anchor.top)) < 12;
        })()`);
      } catch (error) {
        const geometry = await js(`(() => ({
          menu: document.querySelector('.review-selection-actions')?.getBoundingClientRect().toJSON(),
          anchor: window.diffRoot('metadata-added').querySelector('[data-line-number="1"]').getBoundingClientRect().toJSON(),
          styles: document.querySelector('.review-selection-actions')?.getAttribute('style'),
          scroll: window.scrollY,
        }))()`);
        throw new Error(`Selection menu detached from code: ${JSON.stringify(geometry)}\n${String(error)}`);
      }
    };
    await waitForAnchoredMenu();
    // The page can scroll independently of the nested diff pane.
    const previousScroll = await js<number>('window.scrollY');
    await js('window.scrollBy({top:40, behavior:"instant"})');
    await wait(`window.scrollY === ${previousScroll + 40}`);
    await waitForAnchoredMenu();
    await js(`window.scrollTo({top:${previousScroll}, behavior:"instant"})`);
    await wait(`window.scrollY === ${previousScroll}`);
    await waitForAnchoredMenu();
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-selection-actions-light.png'),
      (await window.webContents.capturePage()).toPNG()
    );
    await js("document.documentElement.classList.add('dark')");
    await waitForAnchoredMenu();
    fs.writeFileSync(
      path.join(os.tmpdir(), 'gnosis-selection-actions-dark.png'),
      (await window.webContents.capturePage()).toPNG()
    );
    await js("document.documentElement.classList.remove('dark')");
    await js(
      `Array.from(document.querySelectorAll('.review-selection-actions button')).find(b=>b.textContent.includes('Ask about this')).click()`
    );
    assert.equal(await js(`document.querySelector('#selected-code').textContent`), 'export const ready = true;');

    await wait("!document.querySelector('.review-selection-actions')");
    // Keyboard-driven selection changes preserve partial lines without gutter numbers.
    await js(`(() => {
      const line = window.diffRoot('metadata-added').querySelector('[data-line-number="2"]');
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const start = walker.nextNode(); const range = document.createRange();
      range.setStart(start, 2); range.setEnd(start, 5);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await wait("!!document.querySelector('.review-selection-actions')");
    await js("document.querySelector('.review-selection-actions button:first-child').click()");
    assert.equal(await js("document.querySelector('#selected-code').textContent"), 'por');
    // Selecting headings or discussion text must not attach it as code.
    await js(`(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('[data-case=metadata-added] h2'));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await js("!!document.querySelector('.review-selection-actions')"), false);
    // Deleted code uses the same read-only action and disappears when its file collapses.
    await js(`(() => {
      const line = window.diffRoot('metadata-deleted').querySelector('[data-base-line="1"]');
      line.scrollIntoView({block:'center'});
      const range = document.createRange(); range.selectNodeContents(line);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await wait("document.querySelector('.review-selection-actions')?.style.visibility === 'visible'");
    await js("document.querySelector('.review-selection-actions button:first-child').click()");
    assert.equal(await js("document.querySelector('#selected-code').textContent"), 'export const ready = true;');
    await js(`(() => {
      const line = window.diffRoot('metadata-deleted').querySelector('[data-base-line="2"]');
      const range = document.createRange(); range.selectNodeContents(line);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await wait("!!document.querySelector('.review-selection-actions')");
    await js("document.querySelector('[data-case=metadata-deleted] .review-file-expand').click()");
    await wait("!document.querySelector('.review-selection-actions')");
    assert.equal(await js("window.diffRoot('metadata-added').querySelector('[contenteditable=true]') !== null"), false);

    await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Diff appearance').click()`);
    await wait(`!!document.querySelector('[role=dialog] select')`);
    for (const [label, value, attribute, expected] of [
      ['Change indicators', 'bars', 'data-indicators', 'bars'],
      ['Change indicators', 'none', 'data-indicators', null],
    ]) {
      await js(
        `(() => { const select = Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('${label}')).querySelector('select'); select.value='${value}'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`
      );
      await wait(
        `window.diffRoot('modify').querySelector('pre').getAttribute('${attribute}') === ${JSON.stringify(expected)}`
      );
    }
    for (const [label, attribute, expected] of [
      ['Line backgrounds', 'data-background', false],
      ['Line numbers', 'data-disable-line-numbers', true],
      ['Wrap long lines', 'data-overflow', 'wrap'],
    ]) {
      await js(
        `Array.from(document.querySelectorAll('label')).find(l=>l.textContent==='${label}').querySelector('input').click()`
      );
      await wait(
        typeof expected === 'boolean'
          ? `window.diffRoot('modify').querySelector('pre').hasAttribute('${attribute}') === ${expected}`
          : `window.diffRoot('modify').querySelector('pre').getAttribute('${attribute}') === ${JSON.stringify(expected)}`
      );
    }
    for (const mode of ['word', 'word-line', 'char', 'none', 'word-alt']) {
      await js(
        `(() => { const select = Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Inline changes')).querySelector('select'); select.value='${mode}'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`
      );
      await wait(`!!window.diffRoot('modify').querySelector('[data-line-number="1"]')`);
    }
    await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Reset appearance').click()`);
    await wait(
      `window.diffRoot('modify').querySelector('pre').getAttribute('data-indicators') === 'classic' && !window.diffRoot('modify').querySelector('pre').hasAttribute('data-disable-line-numbers')`
    );
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    console.log('Diff layout, comments, check links, selection, and appearance checks passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-split-diff.png'), (await window.webContents.capturePage()).toPNG());
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
