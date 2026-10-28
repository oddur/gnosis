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
    await fill('How does the queue preserve order?');
    await click('Send question');
    await wait('!!document.querySelector(\'[aria-label="Stop answer"]\')');
    assert.match(await js<string>('window.chatFixture.requests[0].question'), /await queue.dispatch/);
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
    await js('window.chatFixture.fail()');
    await wait("!!document.querySelector('[role=alert]')");
    await capture('file-error-narrow-dark');
    await click('Retry answer');
    assert.equal(await js('window.chatFixture.requests.at(-1).selection'), 'return command.result;');
    await finish(
      'The caller receives the result only after **acknowledgment**. A failed command stays in the queue for retry.'
    );
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    await fill('Keep my draft');
    await click('Switch file');
    await wait("document.querySelector('textarea').value===''");
    await click('Switch file');
    await wait("document.querySelector('textarea').value==='Keep my draft'");
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await capture('file-answer-narrow-dark');
    await viewport(900, 760);
    await capture('file-answer-desktop-dark');
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
