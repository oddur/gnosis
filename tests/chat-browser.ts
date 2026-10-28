import assert from 'node:assert/strict';
import { app, BrowserWindow, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    show: true,
    webPreferences: { backgroundThrottling: false, partition: `chat-fixture-${Date.now()}` },
  });
  const previousClipboard = clipboard.readText();
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const click = async (label: string) => {
    await wait(
      `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})`
    );
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  };
  const fill = (text: string) =>
    js(
      `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  const viewport = async (width: number, height: number) => {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(`innerWidth===${width}&&innerHeight===${height}`);
  };
  const shots = path.resolve('.impeccable/review/chat');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    if (!(await js("!!document.querySelector('#chat-surface')"))) {
      fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
      return;
    }
    const rect = await js<{ x: number; y: number; width: number; height: number }>(
      "(()=>{const r=document.querySelector('#chat-surface').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()"
    );
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage(rect)).toPNG());
  };
  const emit = (text: string) => js(`window.chatFixture.chunk(${JSON.stringify(text)})`);
  const finish = (text: string) => js(`window.chatFixture.finish(${JSON.stringify(text)})`);
  try {
    await win.loadURL(new URL('/tests/fixtures/chat.html', process.env.GNOSIS_WORKBENCH_URL).href);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewport(900, 760);
    await wait("!!document.querySelector('textarea')");
    await capture('topic-empty-light');
    assert.ok(
      (await js<number>("document.querySelector('.chat-composer').getBoundingClientRect().height")) < 120,
      'Composer including quote stays compact'
    );
    await fill('How does the queue preserve order?');
    await click('Send question');
    await wait('!!document.querySelector(\'[aria-label="Stop answer"]\')');
    assert.match(await js<string>('window.chatFixture.requests[0].question'), /await queue.dispatch/);
    assert.equal(
      await js("document.querySelector('.chat-transcript .chat-quote').open"),
      false,
      'Sent quote stays collapsed'
    );
    assert.equal(
      await js("document.querySelector('.chat-message-body').textContent"),
      'How does the queue preserve order?'
    );
    await fill('What happens if a worker stops?');
    const answer =
      'The queue keeps one command in flight per worker.\n\n- **Before dispatch:** reserve the worker slot.\n- **On acknowledgment:** release the slot, then send the next command.\n- **On failure:** retry the same command before advancing.\n\n```ts\nawait queue.dispatch(command);\nawait worker.acknowledge(command.id);\n```';
    await emit(answer);
    await capture('topic-streaming-light');
    await finish(answer);
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    assert.equal(await js("document.querySelector('textarea').value"), 'What happens if a worker stops?');
    await click('Copy answer');
    await wait('!!document.querySelector(\'[aria-label="Answer copied"]\')');
    assert.equal(clipboard.readText(), answer);
    await click('Send question');
    await emit('The worker slot stays reserved until recovery.');
    await wait("document.querySelectorAll('[data-slot=message-scroller-item]').length===4");
    await new Promise((r) => setTimeout(r, 300));
    const anchor = await js<number>(
      "(()=>{const v=document.querySelector('[data-slot=message-scroller-viewport]');const q=document.querySelectorAll('[data-slot=message-scroller-item]')[2];return q.getBoundingClientRect().top-v.getBoundingClientRect().top})()"
    );
    assert.ok(anchor >= 0 && anchor < 80, `Question anchors near top, got ${anchor}`);
    await emit(
      '\n\n' +
        Array.from(
          { length: 30 },
          (_, i) => `**Recovery step ${i + 1}.** The coordinator waits for the worker before dispatching more work.`
        ).join('\n\n')
    );
    await new Promise((r) => setTimeout(r, 350));
    await js(
      "(()=>{const v=document.querySelector('[data-slot=message-scroller-viewport]');v.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300}));v.scrollTop=0;v.dispatchEvent(new Event('scroll'))})()"
    );
    await new Promise((r) => setTimeout(r, 100));
    const top = await js<number>("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop");
    await emit('\n\nMore details arrive while you read.');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      Math.abs((await js<number>("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop")) - top) <
        5,
      'Streaming must not pull the reader down'
    );
    await wait("document.querySelector('[aria-label=\"Jump to latest\"]')?.dataset.active==='true'");
    await capture('reading-history-light');
    await click('Jump to latest');
    await click('Stop answer');
    await wait("document.body.textContent.includes('Answer stopped.')");
    await wait("document.querySelector('.chat-conversation + [role=status]')?.textContent==='Answer stopped'");
    await capture('topic-stopped-light');
    await click('Retry answer');
    await finish('The coordinator retries the command before it advances.');
    await wait("document.body.textContent.includes('The coordinator retries')");
    assert.equal(await js('window.chatFixture.requests.length'), 3);
    await click('Switch chat');
    await viewport(360, 600);
    await js("document.documentElement.classList.add('dark')");
    await capture('file-empty-narrow-dark');
    await fill('Why return the command result?');
    await click('Send question');
    await emit('The caller receives the result only after acknowledgment.');
    await fill('A follow-up for later');
    await js('window.chatFixture.fail()');
    await wait("!!document.querySelector('[role=alert]')");
    assert.equal(
      await js("document.querySelector('textarea').value"),
      'A follow-up for later',
      'Failure must preserve a new draft without restoring the sent question'
    );
    await wait(
      "document.querySelector('.chat-conversation + [role=status]')?.textContent.includes('Answer interrupted')"
    );
    await capture('file-error-narrow-dark');
    await click('Retry answer');
    assert.equal(await js('window.chatFixture.requests.at(-1).selection'), 'return command.result;');
    await finish(
      'The caller receives the result only after **acknowledgment**. A failed command stays in the queue for retry.'
    );
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    await fill('Keep my draft');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Switch file').focus()");
    await click('Switch file');
    await wait("document.querySelector('textarea').value===''");
    assert.equal(
      await js('document.activeElement?.textContent'),
      'Switch file',
      'Passive file changes must not steal focus'
    );
    await click('Switch file');
    await wait("document.querySelector('textarea').value==='Keep my draft'");
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await capture('file-answer-narrow-dark');
    await viewport(900, 760);
    await capture('file-answer-desktop-dark');
    // Measure the actual review composition, not just a standalone chat panel.
    const fullCapture = async (name: string) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await viewport(1280, 720);
    await wait("!!document.querySelector('.queue-item .queue-disclosure:not(:disabled)')");
    await js("document.querySelector('.queue-item:has(.queue-disclosure:not(:disabled)) .queue-row-main').click()");
    await click('Open AI explanation');
    await click('Continue review');
    await click('Ask a question');
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await js(`window.electronAPI.sendSlideChat=async()=>${JSON.stringify(answer)};void 0`);
    await fill('How does the queue preserve order?');
    await click('Send question');
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    const transcriptHeight = () =>
      js<number>("document.querySelector('.chat-conversation').getBoundingClientRect().height");
    console.log('Integrated topic height at1280×720:', await transcriptHeight());
    await fullCapture('integrated-topic-light');
    assert.ok((await transcriptHeight()) >= 240, 'Topic conversation needs240px of reading space at laptop size');
    await viewport(900, 720);
    await js("document.documentElement.classList.add('dark')");
    console.log('Integrated topic height at900×720:', await transcriptHeight());
    await fullCapture('integrated-topic-narrow-dark');
    assert.ok((await transcriptHeight()) >= 240, 'Narrow topic conversation needs240px of reading space');
    await click('Summary');
    await wait("document.querySelector('.pr-summary-context').checkVisibility()");
    await click('Explanation');
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await click('Close chat');
    await click('Changes');
    await viewport(1280, 720);
    await wait(
      "[...document.querySelectorAll('.changes-file-header button')].some(b=>b.textContent.trim()==='Ask about this')"
    );
    await js(
      "window.askOrigin=[...document.querySelectorAll('.changes-file-header button')].find(b=>b.textContent.trim()==='Ask about this');window.askOrigin.focus();window.askOrigin.click()"
    );
    await wait("document.activeElement?.id==='changes-question'");
    await fill('How does this file change?');
    await click('Send question');
    await wait('!!document.querySelector(\'.changes-chat [aria-label="Copy answer"]\')');
    console.log('Integrated file height:', await transcriptHeight());
    await fullCapture('integrated-file-dark');
    assert.ok((await transcriptHeight()) >= 240, 'File conversation needs240px of reading space');
    await click('Close file conversation');
    await wait('document.activeElement===window.askOrigin');
    console.log('Chat integration passed: laptop transcript budget, focus transfer and return.');
    console.log(
      'Chat passed: anchored turns, manual reading during streaming, jump to latest, copy, Stop/retry, quoted code, draft isolation, narrow dark layout.'
    );
    clipboard.writeText(previousClipboard);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    clipboard.writeText(previousClipboard);
    app.exit(1);
  }
});
