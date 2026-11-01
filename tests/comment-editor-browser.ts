import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false, partition: `comment-editor-${Date.now()}` },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const field = '.changes-comment-composer textarea';
  const fill = async (text: string) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(field)});el.focus();el.select()})()`);
    await win.webContents.insertText(text);
    await wait(`document.querySelector(${JSON.stringify(field)}).value===${JSON.stringify(text)}`);
    await js(`document.querySelector(${JSON.stringify(field)}).select()`);
  };
  const click = (label: string, scope = '.changes-comment-composer') =>
    js(
      `(()=>{const root=document.querySelector(${JSON.stringify(scope)});const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const dir = path.resolve('.impeccable/review/comment-editor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, new URL('/tests/fixtures/comment-editor.html', process.env.GNOSIS_WORKBENCH_URL).href);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("!!document.querySelector('markdown-toolbar')");
    await fill('boundary');
    await js(
      "document.querySelector('[data-md-button=bold]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"
    );
    assert.equal(
      await js("document.activeElement.getAttribute('data-md-button')"),
      'italic',
      'Toolbar supports arrow navigation'
    );
    await click('Bold');
    await wait("document.querySelector('textarea').value==='**boundary**'");
    assert.equal(
      await js("document.querySelector('#other-draft').value"),
      'Separate draft',
      'Each toolbar targets its own editor'
    );
    await js("document.execCommand('undo')");
    await wait("document.querySelector('textarea').value==='boundary'");
    await js(
      "document.querySelector('textarea').setSelectionRange(0,8);document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'i',metaKey:true,bubbles:true}))"
    );
    await wait("document.querySelector('textarea').value==='_boundary_'");
    await fill('return retry();');
    await click('Suggested change');
    await wait(`document.querySelector('textarea').value===${JSON.stringify('```suggestion\nreturn retry();\n```\n')}`);
    const source =
      '# Review notes\n\nKeep **the boundary**.\n\n- [ ] Retry the command\n- [x] Preserve order\n\n| Case | Result |\n| --- | --- |\n| Cancel | Release |\n\n```suggestion\nreturn retry();\n```\n\n[Documentation](https://example.com)\n\n<script>window.unsafePreview=true</script>' +
      `\n\n![Architecture](${new URL('/tests/fixtures/pr-description.svg', process.env.GNOSIS_WORKBENCH_URL).href})`;
    await fill(source);
    await js("const f=document.querySelector('textarea');f.setSelectionRange(3,15);f.style.height='260px'");
    const before = await js<number>("document.querySelector('.comment-editor').getBoundingClientRect().height");
    await click('Preview');
    await wait("!!document.querySelector('.comment-editor-preview table')");
    assert.ok(
      Math.abs(
        (await js<number>("document.querySelector('.comment-editor').getBoundingClientRect().height")) - before
      ) < 2,
      'Preview keeps the editor height'
    );
    assert.equal(await js("document.querySelectorAll('.comment-editor-preview input[type=checkbox]').length"), 2);
    assert.equal(await js("document.querySelector('.comment-suggestion span').textContent"), 'Suggested change');
    assert.equal(await js("!!document.querySelector('.comment-editor-preview script')||!!window.unsafePreview"), false);
    await js("document.querySelector('.comment-editor-preview img').scrollIntoView({block:'nearest'})");
    await wait("document.querySelector('.comment-editor-preview img').naturalWidth>0");
    await js("document.querySelector('.comment-editor-preview').scrollTop=0");
    const preview = await js<string>(
      "document.querySelector('.comment-editor-preview .github-comment-body').innerHTML"
    );
    assert.equal(
      await js("document.querySelector('textarea').value"),
      source,
      'Preview keeps source mounted for unsaved-comment navigation guards'
    );
    await capture('preview-light');
    await click('Write');
    await wait('document.activeElement===document.querySelector("textarea")');
    assert.equal(await js("document.querySelector('textarea').value"), source);
    assert.deepEqual(
      await js("[document.querySelector('textarea').selectionStart,document.querySelector('textarea').selectionEnd]"),
      [3, 15]
    );
    // IME must never submit a comment.
    await js(
      "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,isComposing:true,bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('#saved-source').textContent"), '');
    await click('Preview');
    await click('Add to review');
    await wait("!!document.querySelector('#saved table')");
    assert.equal(await js("document.querySelector('#saved-source').textContent"), source);
    assert.equal(
      await js("document.querySelector('#saved .github-comment-body').innerHTML"),
      preview,
      'Saved comments and preview share rendering'
    );
    await click('Write');
    await wait('document.activeElement===document.querySelector("textarea")');
    await fill('next draft');
    await click('Code block');
    await wait(`document.querySelector('textarea').value.startsWith(${JSON.stringify('```\nnext draft')})`);
    await click('Toggle disabled', 'main');
    assert.equal(await js("document.querySelector('#other-draft').disabled"), true);
    assert.equal(
      await js(
        "[...document.querySelector('#other-draft').closest('.comment-editor').querySelectorAll('[data-md-button]')].every(b=>b.disabled)"
      ),
      true
    );
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await js("document.documentElement.classList.add('dark')");
    await capture('write-narrow-dark');
    assert.equal(
      await js('document.documentElement.scrollWidth<=innerWidth'),
      true,
      'Toolbar wraps without horizontal overflow'
    );
    const narrowHeight = await js<number>("document.querySelector('.comment-editor').getBoundingClientRect().height");
    await click('Preview');
    await capture('preview-narrow-dark');
    assert.ok(
      Math.abs(
        (await js<number>("document.querySelector('.comment-editor').getBoundingClientRect().height")) - narrowHeight
      ) < 2,
      'Preview keeps the height when the toolbar wraps'
    );
    console.log(
      'Comment editor passed: formatting, undo, keyboard/IME, source and cursor preservation, preview parity, disabled state, narrow dark layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    app.exit(1);
  }
});
