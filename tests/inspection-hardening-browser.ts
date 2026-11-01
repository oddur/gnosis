import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const fill = (selector: string, value: string) =>
    js(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  const shots = path.resolve('.impeccable/review/inspection-hardening');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const origin = process.env.GNOSIS_WORKBENCH_URL;
    assert.ok(origin);
    await loadWorkbenchPage(win, new URL('/tests/fixtures/inspection-hardening.html', origin).href);
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await wait("!!document.querySelector('#changes-question')");
    await fill('#changes-question', 'Why does cancellation keep this slot? 日本語 🧪');
    await click('Close chat');
    await click('Toggle file chat');
    await wait("document.querySelector('#changes-question')?.value.includes('cancellation')");
    await click('Switch file');
    await wait("document.querySelector('#changes-question')?.value===''");
    await fill('#changes-question', 'A different file question');
    await click('Switch file');
    await wait("document.querySelector('#changes-question')?.value.includes('cancellation')");
    await js("window.electronAPI.askPrFile=()=>Promise.reject(Error('Provider unavailable. Try again.'));void 0");
    await js("document.querySelector('.changes-chat form').requestSubmit()");
    await wait("document.querySelector('.changes-chat [role=alert]')?.textContent.includes('Provider unavailable')");
    await click('Close chat');
    await click('Toggle file chat');
    assert.equal(await js<string>("document.querySelector('#changes-question').value"), '', 'Failed question remains in the transcript, not duplicated in the composer');
    assert.match(await js<string>("document.querySelector('.changes-chat .chat-transcript').textContent"), /cancellation/);
    await wait("[...document.querySelectorAll('.changes-chat button')].some(b=>b.textContent.includes('Retry answer'))");
    // Composition confirmation must not save a partially composed GitHub comment.
    await fill('.changes-comment-composer textarea', '日本語のレビュー');
    await js(
      "document.querySelector('.changes-comment-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,isComposing:true,bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('#comment-count').textContent"), '0');
    await js(
      "document.querySelector('.changes-comment-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}))"
    );
    await wait("document.querySelector('#comment-count').textContent==='1'");
    // Source changes must remove old pixels while the new revision is pending.
    await wait("document.querySelector('.review-image-stage img')?.naturalWidth>0");
    await js(
      'window.readImage=window.electronAPI.loadReviewImages;window.electronAPI.loadReviewImages=(...args)=>new Promise(resolve=>{window.finishImage=()=>window.readImage(...args).then(resolve)});void 0'
    );
    await click('Next image revision');
    await wait('!!window.finishImage');
    assert.equal(await js("document.querySelectorAll('.review-image-stage img').length"), 0);
    await js('window.finishImage()');
    await wait("document.querySelector('.review-image-stage img')?.naturalWidth>0");
    await js("document.querySelector('.review-image-stage img').dispatchEvent(new Event('error'))");
    await wait("document.querySelector('.review-image-diff')?.textContent.includes('could not be decoded')");
    await js('window.electronAPI.loadReviewImages=window.readImage;void 0');
    await click('Next image revision');
    await wait("document.querySelector('.review-image-stage img')?.naturalWidth>0");
    assert.equal(
      await js("document.querySelector('.review-image-diff').textContent.includes('could not be decoded')"),
      false
    );
    // Real Electron pointer capture plus synthesized pointer cancellation/loss/blur.
    await js(
      "window.dragIds=[];document.addEventListener('pointerdown',e=>{if(e.isPrimary)window.dragIds.push(e.pointerId)})"
    );
    const beginDrag = async () => {
      await js("document.querySelector('.changes-resize').scrollIntoView({block:'center'})");
      const point = await js<{ x: number; y: number }>(
        "(()=>{const r=document.querySelector('.changes-resize').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+40)}})()"
      );
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      await wait("document.querySelector('.changes-resize').hasPointerCapture(window.dragIds.at(-1))");
      return point;
    };
    for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
      const point = await beginDrag();
      const width = await js("document.querySelector('#resize-value').textContent");
      await js(
        "document.querySelector('.changes-resize').dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,isPrimary:false,button:0,bubbles:true}));document.querySelector('.changes-resize').dispatchEvent(new PointerEvent('pointermove',{pointerId:99,isPrimary:false,clientX:499,bubbles:true}))"
      );
      assert.equal(
        await js("document.querySelector('#resize-value').textContent"),
        width,
        'A second pointer cannot take over the resize'
      );
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftbuttondown'], x: point.x + 30, y: point.y });
      await wait(`document.querySelector('#resize-value').textContent!==${JSON.stringify(width)}`);
      await js(
        reason === 'blur'
          ? "window.dispatchEvent(new Event('blur'))"
          : `document.querySelector('.changes-resize').dispatchEvent(new PointerEvent('${reason}',{pointerId:window.dragIds.at(-1),bubbles:true}))`
      );
      assert.equal(
        await js("document.querySelector('.changes-resize').hasPointerCapture(window.dragIds.at(-1))"),
        false
      );
      assert.equal(
        await js("document.querySelector('#resize-committed').textContent"),
        await js("document.querySelector('#resize-value').textContent")
      );
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 30, y: point.y });
    }
    await js(
      "document.querySelector('.changes-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('#resize-value').textContent"), '180');
    await js(
      "document.querySelector('.changes-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))"
    );
    assert.equal(await js("document.querySelector('#resize-value').textContent"), '500');
    // Failed signature writes keep intent and prevent posting with a different signature.
    await js(
      "window.signatureSaves=[];window.signatureFail=true;window.writePrefs=window.electronAPI.savePreferences;window.electronAPI.savePreferences=async prefs=>{window.signatureSaves.push(prefs);if(window.signatureFail)throw Error('Disk full');return window.writePrefs(prefs)};window.posts=[];window.electronAPI.submitReview=r=>{window.posts.push(r);return new Promise(resolve=>{window.finishPost=()=>resolve({reviewUrl:r.prUrl+'#review',droppedCommentCount:0})})};void 0"
    );
    await click('Submit review');
    await wait("!!document.querySelector('input[type=radio][value=APPROVE]')");
    await js("document.querySelector('input[type=radio][value=APPROVE]').click()");
    await wait("!!document.querySelector('[role=dialog] input[type=checkbox]:not(:disabled)')");
    await js("document.querySelector('[role=dialog] input[type=checkbox]').click()");
    await wait("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('Could not save')");
    await fill('#review-summary', 'Keep the queue boundary explicit.');
    assert.equal(
      await js("[...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review').disabled"),
      true
    );
    assert.equal(await js('window.posts.length'), 0);
    await capture('signature-error-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('signature-error-dark');
    win.setSize(800, 740);
    await capture('signature-error-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await js('window.signatureFail=false');
    await click('Retry signature setting');
    await wait("![...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review').disabled");
    assert.equal(await js('window.signatureSaves.at(-1).reviewSignature'), true);
    await js(
      "const approve=[...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review');approve.click();approve.click();void 0"
    );
    await wait('window.posts.length===1');
    assert.equal(await js("document.querySelector('#review-summary').disabled"), true);
    await js('window.finishPost()');
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('Feedback submitted')");
    await click('Done');
    // A failed read is recoverable and does not silently substitute the default.
    await js(
      "window.readPrefs=window.electronAPI.loadPreferences;window.electronAPI.loadPreferences=()=>Promise.reject(Error('Cannot read preferences'));void 0"
    );
    await click('Submit review');
    await wait("!!document.querySelector('input[type=radio][value=APPROVE]')");
    await js("document.querySelector('input[type=radio][value=APPROVE]').click()");
    await wait("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('Could not load')");
    await js('window.electronAPI.loadPreferences=window.readPrefs;void 0');
    await click('Retry signature setting');
    await wait("![...document.querySelectorAll('.review-submit-footer button')].find(b=>b.textContent.trim()==='Submit review').disabled");
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    // Full app: commit refresh must preserve navigation that happens while it is pending.
    win.setSize(1280, 850);
    await loadWorkbenchPage(win, origin + '?pr-summary');
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Commits');
    await wait(
      "document.querySelectorAll('.commit-row').length===3 && !!document.querySelector('.commit-detail-title')"
    );
    await js(
      'window.readCommits=window.electronAPI.getPrCommits;window.electronAPI.getPrCommits=(...args)=>args[1]===true?new Promise(resolve=>{window.finishCommits=()=>window.readCommits(...args).then(resolve)}):window.readCommits(...args);void 0'
    );
    await click('Update commits');
    await wait('!!window.finishCommits');
    await js("document.querySelectorAll('.commit-row')[2].click()");
    await wait("document.querySelector('.commit-detail-title')?.textContent.includes('Introduce the queue')");
    await js('window.finishCommits()');
    await wait(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Update commits'&&!b.disabled)"
    );
    assert.match(await js<string>("document.querySelector('.commit-detail-title').textContent"), /Introduce the queue/);
    await capture('commit-refresh-preserved');
    console.log('Inspection hardening checks passed');
  } catch (error) {
    console.error(error);
    await capture('failure');
    console.error(await js('document.body.innerText.slice(-3500)'));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
