import { loadWorkbenchPage } from './workbench-ready';
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
  // Renderer errors explain a failure that only shows as a timeout.
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') console.error('[renderer]', message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, tries = 200) => {
    for (let i = 0; i < tries; i++) {
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
  // With GNOSIS_CHAT_SHOTS set, each shot also prints as a `CHATSHOT <name> <base64 PNG>` line, since Docker keeps no
  // files, and the first answer streams in two parts so a shot shows it mid-stream, inside its code fence.
  const printShots = !!process.env.GNOSIS_CHAT_SHOTS;
  const save = (name: string, png: Buffer) => {
    fs.writeFileSync(path.join(shots, name + '.png'), png);
    if (printShots) console.log(`CHATSHOT ${name} ${png.toString('base64')}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    if (!(await js("!!document.querySelector('#chat-surface')"))) {
      save(name, (await win.webContents.capturePage()).toPNG());
      return;
    }
    const rect = await js<{ x: number; y: number; width: number; height: number }>(
      "(()=>{const r=document.querySelector('#chat-surface').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()"
    );
    save(name, (await win.webContents.capturePage(rect)).toPNG());
  };
  const emit = (text: string) => js(`window.chatFixture.chunk(${JSON.stringify(text)})`);
  const center = (selector: string) =>
    js<{ x: number; y: number }>(
      `(()=>{const r=${selector}.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`
    );
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  /** A real click: press and release where the element is. */
  const pointerClick = async (selector: string, clickCount = 1) => {
    const { x, y } = await center(selector);
    await mouse('mouseMoved', x, y, { button: 'none' });
    for (let n = 1; n <= clickCount; n++) {
      await mouse('mousePressed', x, y, { clickCount: n });
      await mouse('mouseReleased', x, y, { clickCount: n });
    }
  };
  const press = (selector: string, key: string, shiftKey = false) =>
    js(
      `${selector}.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},shiftKey:${shiftKey},bubbles:true,cancelable:true}))`
    );
  /** Selects a diff row's code inside its shadow root, as a reader's drag would. */
  const selectDiffRow = (scope: string, row: string) =>
    js(`(()=>{const host=[...${scope}.querySelectorAll('diffs-container')].find(h=>h.shadowRoot?.querySelector(${JSON.stringify(row)}));
      const line=host.shadowRoot.querySelector(${JSON.stringify(row)});line.scrollIntoView({block:'center'});
      const range=document.createRange();range.selectNodeContents(line);const s=getSelection();s.removeAllRanges();s.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));return true})()`);
  const finish = (text: string) => js(`window.chatFixture.finish(${JSON.stringify(text)})`);
  try {
    await loadWorkbenchPage(win, new URL('/tests/fixtures/chat.html', process.env.GNOSIS_WORKBENCH_URL).href);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewport(900, 760);
    await wait("!!document.querySelector('textarea')");
    await capture('topic-empty-light');
    const composerHeight = await js<number>("document.querySelector('.chat-composer').getBoundingClientRect().height");
    console.log('Composer height with a selection chip:', composerHeight);
    assert.ok(composerHeight < 150, 'Composer including the selection chip stays compact');
    assert.equal(
      await js("document.querySelector('.chat-selection-chip [data-slot=attachment-title]').textContent"),
      'Selected code',
      'A selection without a location is a plain chip'
    );
    // The model selector lists every model the providers offer; the choice goes with the next question.
    const modelTrigger = "document.querySelector('.model-selector-trigger')";
    assert.equal(await js(`${modelTrigger}.getAttribute('aria-label')`), 'Model: Opus 5.5, Claude');
    await pointerClick(modelTrigger);
    await wait("document.querySelectorAll('[role=menuitemradio]').length===8");
    assert.deepEqual(await js("[...document.querySelectorAll('[role=menuitemradio]')].map(i=>i.textContent.trim())"), [
      'Fable 5.2',
      'Opus 5.5',
      'Sonnet 5.5',
      'Haiku 5.5',
      'GPT-6.2 Sol',
      'GPT-6.2 Astra',
      'GPT-6.1 Terra',
      'GPT-6 Luna',
    ]);
    assert.equal(
      await js("document.querySelector('[role=menuitemradio][aria-checked=true]').textContent.trim()"),
      'Opus 5.5',
      'The current chat model is checked'
    );
    await capture('model-selector-open-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('model-selector-open-dark');
    await js("document.documentElement.classList.remove('dark')");
    await pointerClick(
      "[...document.querySelectorAll('[role=menuitemradio]')].find(i=>i.textContent.trim()==='Haiku 5.5')"
    );
    await wait(`${modelTrigger}.getAttribute('aria-label')==='Model: Haiku 5.5, Claude'`);
    await wait("!document.querySelector('[role=menuitemradio]')");
    await wait("window.chatFixture.preferences().chatModels?.topic?.model==='claude-haiku-5-5'");
    await fill('How does the queue preserve order?');
    await click('Send question');
    await wait('!!document.querySelector(\'[aria-label="Stop answer"]\')');
    assert.match(await js<string>('window.chatFixture.requests[0].question'), /await queue.dispatch/);
    assert.deepEqual(
      await js('[window.chatFixture.requests[0].provider, window.chatFixture.requests[0].model]'),
      ['claude', 'claude-haiku-5-5'],
      'The next question goes to the chosen model'
    );
    // Before the first words the trace is live: open, with Thinking running.
    await wait(
      "!!document.querySelector('.chat-trace[data-streaming][data-expanded] .chat-trace-thinking [data-status=running]')"
    );
    await capture('trace-thinking-light');
    assert.equal(
      await js("document.querySelector('.chat-transcript .chat-quote').open"),
      false,
      'Sent quote stays collapsed'
    );
    assert.equal(
      await js("document.querySelector('.chat-message-body').textContent.trim()"),
      'How does the queue preserve order?'
    );
    await fill('What happens if a worker stops?');
    const answer =
      'The queue keeps one command in flight per worker [src/queue.ts:40-41], unlike the old path [src/legacy.ts:12].\n\n- **Before dispatch:** reserve the worker slot.\n- **On acknowledgment:** release the slot, then send the next command.\n- **On failure:** retry the same command before advancing.\n\n```ts\nawait queue.dispatch(command);\nawait worker.acknowledge(command.id);\n```\n\nSee [the queue notes](https://example.com/queue) for the retry rules. The change:\n\n```diff\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -40,2 +40,3 @@\n   await queue.dispatch(command);\n+  await worker.acknowledge(command.id);\n   return command.result;\n```';
    const body = "document.querySelectorAll('.chat-message-body')[1]";
    // The answer streams in two parts; the second ends past the bottom of the panel.
    const cut = answer.indexOf('await worker');
    await emit(answer.slice(0, cut));
    // Words renders the message once it has loaded (its plain text shows until then).
    await wait(
      `!!${body}?.querySelector('[data-markdown=p]') && ${body}.textContent.includes('queue.dispatch(command)')`
    );
    const firstLine = `Math.round(${body}.querySelector('[data-markdown=p]').getBoundingClientRect().top)`;
    const startTop = await js<number>(firstLine);
    if (printShots) {
      await capture('topic-midstream-light');
      await js("document.documentElement.classList.add('dark')");
      await capture('topic-midstream-dark');
      await js("document.documentElement.classList.remove('dark')");
    }
    await emit(answer.slice(cut));
    // The trace shows the context Gnosis assembled, live, before the answer settles.
    await wait("!!document.querySelector('.chat-trace[data-streaming][data-expanded]')");
    const rows = (trace = 0) =>
      js<string[]>(
        `[...document.querySelectorAll('.chat-trace')[${trace}].querySelectorAll('.chat-trace-steps .chat-trace-step')].map(r=>r.querySelector('.chat-trace-title').textContent+(r.querySelector('.chat-trace-range')?.textContent??''))`
      );
    assert.deepEqual(await rows(), [
      'Selected code',
      'Diff queue.tsL40–120',
      'Diff worker.tsL10–14',
      'Pull request PR description',
    ]);
    await wait("/^Thought\\d/.test(document.querySelector('.chat-trace-thinking').textContent)");
    await capture('topic-streaming-light');
    // Words renders the answer as it streams: the message is live, and its code is highlighted while it arrives.
    await wait(`${body}?.hasAttribute('data-streaming')`);
    await wait(`!!${body}.querySelector('[data-markdown=code-block][data-language=ts] code span[style*=color]')`);
    // The panel does not follow the text: the answer holds still while it grows below, past the panel's bottom.
    await wait(`!!${body}.querySelector('.chat-diff .changes-file-header')`);
    assert.ok(
      await js(
        "(()=>{const v=document.querySelector('[data-slot=message-scroller-viewport]');return v.scrollHeight>v.scrollTop+v.clientHeight+40})()"
      ),
      'The streamed answer runs past the bottom of the panel'
    );
    assert.equal(
      await js<number>(firstLine),
      startTop,
      'The first answer line stays where it was after the first chunk'
    );
    await finish(answer);
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    await wait("!document.querySelector('.chat-trace[data-streaming]')");
    await wait(`!${body}.hasAttribute('data-streaming') && !${body}.querySelector('[data-markdown=caret]')`);
    assert.deepEqual(
      await js(
        `[...${body}.querySelectorAll('[data-markdown=code-block] [data-code-action]')].map(b=>b.getAttribute('aria-label'))`
      ),
      ['Copy code', 'Download code'],
      'Code blocks carry Copy and Download'
    );
    // Links open in the browser, through the window's open handler; the page itself never navigates.
    assert.deepEqual(
      await js(`(()=>{const opened=[];const open=window.open;window.open=(...a)=>{opened.push(a);return null};
        const a=${body}.querySelector('[data-markdown=a]');const e=new MouseEvent('click',{bubbles:true,cancelable:true,button:0});
        a.dispatchEvent(e);window.open=open;return [opened,e.defaultPrevented]})()`),
      [[['https://example.com/queue', '_blank', 'noopener,noreferrer']], true],
      'Links open in the browser'
    );
    // A closed diff fence shows as a diff, with Changes' file header and diff (ReviewDiff), not as code.
    await wait(`!!${body}.querySelector('.chat-diff .changes-file-header h2[title="src/queue.ts"]')`);
    await wait(
      `window.deepAll?.('[data-line-type=change-addition]',${body}.querySelector('.chat-diff')).length===1 || [...${body}.querySelectorAll('.chat-diff diffs-container')].some(h=>h.shadowRoot?.querySelector('[data-code] [data-line][data-line-type=change-addition]'))`
    );
    assert.equal(
      await js(`${body}.querySelectorAll('[data-markdown=code-block][data-language=diff]').length`),
      0,
      'The diff is not also shown as code'
    );
    const toggle = "document.querySelector('.chat-trace-toggle')";
    await wait(`${toggle}.getAttribute('aria-expanded')==='false'`);
    assert.equal(await js(`${toggle}.getAttribute('aria-label')`), 'Context used, 4 sources');
    assert.match(
      await js<string>("document.querySelector('.chat-trace-count').textContent"),
      /^4 sources · \d+(\.\d)?s$/,
      'The summary counts the steps and times the answer'
    );
    // The rows fold away (a short height transition); the summary stays one line.
    await wait("document.querySelector('.chat-trace').getBoundingClientRect().height<30");
    await capture('topic-trace-collapsed-light');
    await click('Context used, 4 sources');
    await wait(`${toggle}.getAttribute('aria-expanded')==='true'`);
    assert.deepEqual(
      await js("[...document.querySelectorAll('.chat-trace-steps .chat-trace-verb')].map(v=>v.textContent)"),
      ['Selected code', 'Diff', 'Diff', 'Pull request']
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.chat-trace-steps .chat-trace-step')].map(r=>r.tagName)"),
      ['DIV', 'BUTTON', 'BUTTON', 'DIV'],
      'Steps without a location are labels, not controls'
    );
    await click('Open src/queue.ts lines 40 to 120 in Changes');
    assert.deepEqual(
      await js('window.chatFixture.opened.map(s=>[s.path,s.startLine,s.endLine,s.side])'),
      [['src/queue.ts', 40, 120, 'after']],
      'File steps open their line range'
    );
    await capture('topic-trace-expanded-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('topic-trace-expanded-dark');
    await click('Context used, 4 sources');
    await capture('topic-trace-collapsed-dark');
    await js("document.documentElement.classList.remove('dark')");
    // Citations: a PR file is an inline citation with a card and a jump; a file outside the PR stays plain text.
    const cite = `${body}.querySelector('.inline-citation-trigger[data-citation-path="src/queue.ts"]')`;
    await wait(`!!${cite}`);
    assert.equal(await js(`${cite}.textContent`), 'queue.ts:40–41');
    assert.equal(
      await js(`${body}.querySelector('[data-citation-unresolved]')?.textContent`),
      '[src/legacy.ts:12]',
      'A citation of a file outside the PR is plain text'
    );
    assert.equal(
      await js(`${body}.querySelectorAll('.inline-citation-trigger').length`),
      1,
      'Only the PR file is cited'
    );
    await js(`${cite}.scrollIntoView({block:'center'})`);
    const citeAt = await center(cite);
    await mouse('mouseMoved', citeAt.x, citeAt.y, { button: 'none' });
    await wait("!!document.querySelector('.inline-citation-card')?.checkVisibility()");
    assert.equal(
      await js("document.querySelector('.inline-citation-card .inline-citation-path').textContent"),
      'src/queue.ts'
    );
    assert.equal(
      await js("document.querySelector('.inline-citation-card .inline-citation-detail').textContent"),
      'Lines 40–41'
    );
    assert.equal(
      await js("document.querySelector('.inline-citation-card .inline-citation-quote').textContent"),
      'await queue.dispatch(command);\nawait worker.acknowledge(command.id);',
      'The card previews the cited lines'
    );
    await capture('citation-hover-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('citation-hover-dark');
    await js("document.documentElement.classList.remove('dark')");
    await pointerClick(cite);
    await wait("window.chatFixture.opened.at(-1)?.id==='citation'");
    assert.deepEqual(
      await js(
        '[window.chatFixture.opened.at(-1).path,window.chatFixture.opened.at(-1).startLine,window.chatFixture.opened.at(-1).endLine]'
      ),
      ['src/queue.ts', 40, 41],
      'A click opens the cited lines in Changes'
    );
    await mouse('mouseMoved', 5, 5, { button: 'none' });
    await wait("!document.querySelector('.inline-citation-card')?.checkVisibility()");
    // Selecting code in an answer's diff and asking about it puts the selection, with its file and line, in the prompt.
    await selectDiffRow(
      `${body}.querySelector('.chat-diff')`,
      '[data-code] [data-line][data-line-type=change-addition]'
    );
    await wait("document.querySelector('.review-selection-actions')?.style.visibility==='visible'");
    await js("document.querySelector('.review-selection-ask').click()");
    await wait(
      "document.querySelector('.chat-selection-chip [data-slot=attachment-title]')?.textContent==='queue.ts · L41'"
    );
    await wait("document.activeElement===document.querySelector('textarea')");
    await capture('selection-chip-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('selection-chip-dark');
    await js("document.documentElement.classList.remove('dark')");
    assert.equal(await js("document.querySelector('textarea').value"), 'What happens if a worker stops?');
    await click('Copy answer');
    await wait('!!document.querySelector(\'[aria-label="Answer copied"]\')');
    // Windows exposes native CRLF line endings through the system clipboard.
    assert.equal(clipboard.readText().replace(/\r\n/g, '\n'), answer);
    await click('Send question');
    assert.match(
      await js<string>('window.chatFixture.requests[1].question'),
      /^Regarding this code in src\/queue\.ts, new line 41:\n```\n\s*await worker\.acknowledge\(command\.id\);\n```/,
      'The question quotes the selection with its file and line'
    );
    await emit('The worker slot stays reserved until recovery.');
    // Tool calls replayed from a recorded Claude stream-json run join the trace live.
    for (const line of fs.readFileSync(path.resolve('tests/fixtures/claude-tool-stream.jsonl'), 'utf8').split('\n'))
      await js(`window.chatFixture.claudeLine(${JSON.stringify(line)})`);
    await wait(
      "document.querySelectorAll('.chat-trace')[1]?.querySelectorAll('.chat-trace-steps .chat-trace-step').length===8"
    );
    assert.equal(
      await js(
        "document.querySelectorAll('.chat-trace')[1].querySelector('.chat-trace-toggle').getAttribute('aria-label')"
      ),
      'What the AI looked at, 3 tool calls, 5 sources',
      'Context and the three reported tool calls appear while streaming'
    );
    const readStep = "document.querySelectorAll('.chat-trace')[1].querySelector('[data-step=\"agent:toolu_01Read\"]')";
    await wait(`${readStep}.querySelector('[data-slot=trace-line]').dataset.status===undefined`);
    await js(`${readStep}.querySelector('.chat-trace-step-toggle').click()`);
    await wait(
      `[...${readStep}.querySelectorAll('.chat-trace-io pre')].map(p=>p.textContent).join('|').includes('export async function retry')`
    );
    assert.match(
      await js<string>(`${readStep}.querySelector('.chat-trace-io pre').textContent`),
      /^file_path: /,
      'A tool row shows its input'
    );
    assert.ok(
      await js(
        "!!document.querySelectorAll('.chat-trace')[1].querySelector('.chat-trace-steps [data-status=running]')"
      ),
      'A call without a result yet is still running'
    );
    await js(`${readStep}.scrollIntoView({block:'center'})`);
    await capture('trace-live-tools-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('trace-live-tools-dark');
    await js("document.documentElement.classList.remove('dark')");
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
    // Diagrams in an answer render as Explanation renders them, once their fence closes; until then they are code.
    await fill('Draw the flow.');
    await click('Send question');
    const diagrams = "[...document.querySelectorAll('.chat-message-body')].at(-1)";
    const drawn =
      'The flow:\n\n```mermaid\nflowchart LR\n  Queue --> Worker\n```\n\nThe same as D2:\n\n```d2\nqueue -> worker: dispatch\n```';
    const open = drawn.indexOf('worker: dispatch');
    await emit(drawn.slice(0, open));
    await wait(`!!${diagrams}?.querySelector('.mermaid-diagram svg')`, 600);
    assert.equal(
      await js(`!!${diagrams}.querySelector('[data-markdown=code-block][data-language=d2]')`),
      true,
      'A diagram still streaming shows as code'
    );
    await emit(drawn.slice(open));
    await finish(drawn);
    await wait(
      `!!${diagrams}?.querySelector('.d2-diagram svg') && !!${diagrams}.querySelector('.mermaid-diagram svg')`,
      600
    );
    assert.equal(
      await js(`${diagrams}.querySelectorAll('[data-markdown=code-block]').length`),
      0,
      'Closed diagram fences are not also shown as code'
    );
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
    // The main process sends the file context it assembled for this request.
    await js(
      `window.chatFixture.trace(${JSON.stringify([
        {
          id: 'context:file',
          source: 'context',
          kind: 'file',
          label: 'queue.ts',
          detail: 'src/queue.ts · before and after',
          path: 'src/queue.ts',
        },
      ])})`
    );
    await wait("document.querySelector('.chat-trace-toggle')?.getAttribute('aria-label')==='Context used, 1 source'");
    await finish(
      'The caller receives the result only after **acknowledgment**. A failed command stays in the queue for retry.'
    );
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    assert.match(
      await js<string>(
        "Object.keys(localStorage).filter(k=>k.startsWith('gnosis-file-chat:v1:')).map(k=>localStorage.getItem(k)).join()"
      ),
      /"trace":\{"steps":\[\{"id":"context:file"/,
      'The trace is saved with the file conversation'
    );
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
      save(name, (await win.webContents.capturePage()).toPNG());
    };
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await viewport(1280, 720);
    await wait("!!document.querySelector('.queue-item .queue-disclosure:not(:disabled)')");
    await js("document.querySelector('.queue-item:has(.queue-disclosure:not(:disabled)) .queue-row-main').click()");
    await click('Open AI explanation');
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
    await js(
      "document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await wait("document.activeElement===document.querySelector('.chat-sheet textarea')");
    await js(`window.electronAPI.sendSlideChat=async()=>${JSON.stringify(answer)};void 0`);
    await fill('How does the queue preserve order?');
    await click('Send question');
    await wait('!!document.querySelector(\'[aria-label="Copy answer"]\')');
    const assertDock = async () => {
      // The dock slides in from the edge; measure where it settles.
      await js(
        "Promise.all([...document.querySelectorAll('.chat-panel-dock')].flatMap(el=>el.getAnimations()).map(a=>a.finished)).then(()=>true)"
      );
      const rect = await js<{ right: number; width: number; parentRight: number }>(
        "(()=>{const panel=[...document.querySelectorAll('.chat-panel-dock')].find(el=>el.checkVisibility());const r=panel.getBoundingClientRect();return{right:r.right,width:r.width,parentRight:panel.parentElement.getBoundingClientRect().right}})()"
      );
      assert.ok(Math.abs(rect.right - rect.parentRight) < 2, 'Chat docks to the right edge');
      assert.equal(Math.round(rect.width), 400, 'All chat surfaces use the same sidebar width');
      assert.equal(
        await js(`(()=>{
        const panel=[...document.querySelectorAll('.chat-panel-dock')].find(el=>el.checkVisibility());
        const r=panel.getBoundingClientRect();
        for(const x of [.1,.5,.9]) for(const y of [.1,.3,.5,.7,.9]) {
          if(!panel.contains(document.elementFromPoint(r.left+r.width*x,r.top+r.height*y))) return false;
        }
        return true;
      })()`),
        true,
        'Sticky diff headers must not cover chat'
      );
      assert.equal(
        await js("[...document.querySelectorAll('.chat-panel-header')].find(el=>el.checkVisibility()).textContent"),
        'Chat'
      );
    };
    await assertDock();
    const transcriptHeight = () =>
      js<number>("document.querySelector('.chat-conversation').getBoundingClientRect().height");
    console.log('Integrated topic height at1280×720:', await transcriptHeight());
    await fullCapture('integrated-topic-light');
    assert.ok((await transcriptHeight()) >= 240, 'Topic conversation needs240px of reading space at laptop size');
    await viewport(900, 720);
    await js("document.documentElement.classList.add('dark')");
    console.log('Integrated topic height at900×720:', await transcriptHeight());
    await fullCapture('integrated-topic-narrow-dark');
    await assertDock();
    assert.ok((await transcriptHeight()) >= 240, 'Narrow topic conversation needs240px of reading space');
    assert.equal(
      await js("document.querySelector('.chat-sheet textarea').checkVisibility()"),
      true,
      'Explanation stays available beside chat'
    );
    await js(
      "document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait(
      "document.querySelector('.chat-sheet textarea').checkVisibility() && document.activeElement===document.querySelector('.chat-sheet textarea')"
    );
    await viewport(600, 720);
    await fullCapture('integrated-topic-small-dark');
    await assertDock();
    await viewport(900, 720);
    await click('Summary');
    await wait("document.querySelector('.pr-summary-context').checkVisibility()");
    await click('Explanation');
    await wait("!!document.querySelector('.chat-sheet textarea')");
    await fill('Keep my topic draft');
    await js(
      "document.querySelector('.chat-sheet textarea').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.chat-sheet')");
    await js(
      "window.topicOrigin=document.querySelector('[data-explanation-section=\"1\"] h2');window.topicOrigin.focus();window.topicOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait("document.activeElement===document.querySelector('.chat-sheet textarea')");
    assert.equal(await js("document.querySelector('.chat-sheet textarea').value"), 'Keep my topic draft');
    await js(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}))"
    );
    assert.equal(await js("!!document.querySelector('.chat-sheet')"), true, 'IME Escape keeps chat open');
    await js(
      "document.querySelector('.chat-panel-context').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.chat-sheet') && document.activeElement===window.topicOrigin");
    await click('Changes');
    await viewport(1280, 720);
    await wait(
      "[...document.querySelectorAll('.changes-file-header button')].some(b=>b.getAttribute('aria-label')==='Ask about this')"
    );
    await js(
      "window.askOrigin=[...document.querySelectorAll('.changes-file-header button')].find(b=>b.getAttribute('aria-label')==='Ask about this');window.askOrigin.focus();window.askOrigin.click()"
    );
    await wait("document.activeElement?.id==='changes-question'");
    await fill('How does this file change?');
    await click('Send question');
    await wait('!!document.querySelector(\'.changes-chat [aria-label="Copy answer"]\')');
    console.log('Integrated file height:', await transcriptHeight());
    await fullCapture('integrated-file-dark');
    await assertDock();
    // The dock's edge resizes it, by keyboard and by drag; the file surface remembers its width, the topic keeps its own.
    const dock = "document.querySelector('.changes-chat')";
    const handle = `${dock}.querySelector('.chat-panel-resize')`;
    const dockWidth = `Math.round(${dock}.getBoundingClientRect().width)`;
    assert.equal(await js(`${handle}.getAttribute('role')`), 'separator');
    assert.equal(await js(`${handle}.tabIndex`), 0, 'The separator takes focus');
    await js(`${handle}.focus()`);
    await press(handle, 'ArrowLeft');
    await press(handle, 'ArrowLeft');
    await wait(`${dockWidth}===432 && ${handle}.getAttribute('aria-valuenow')==='432'`);
    await press(handle, 'ArrowRight');
    await wait(`${dockWidth}===416`);
    await wait('window.electronAPI.loadPreferences().then(p=>p.chatPanelWidths?.file===416)');
    const grip = await center(handle);
    await mouse('mouseMoved', grip.x, grip.y, { button: 'none' });
    await mouse('mousePressed', grip.x, grip.y, { clickCount: 1 });
    for (const dx of [-20, -40, -60]) await mouse('mouseMoved', grip.x + dx, grip.y, { buttons: 1 });
    await mouse('mouseReleased', grip.x - 60, grip.y, { clickCount: 1 });
    await wait(`${dockWidth}===476`);
    await wait(
      'window.electronAPI.loadPreferences().then(p=>p.chatPanelWidths?.file===476 && p.chatPanelWidths?.topic===undefined)'
    );
    await click('Close chat');
    await wait(`!${dock}`);
    await js("window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))");
    await wait(`!!${dock} && ${dockWidth}===476`);
    console.log('Chat panel resized by keyboard and drag; the width persists across close and reopen.');
    await js("document.documentElement.classList.remove('dark')");
    await viewport(1440, 900);
    await fullCapture('resized-file-1440-light');
    await js("document.documentElement.classList.add('dark')");
    await fullCapture('resized-file-1440-dark');
    await viewport(1024, 768);
    await fullCapture('resized-file-1024-dark');
    await js("document.documentElement.classList.remove('dark')");
    await fullCapture('resized-file-1024-light');
    await js("document.documentElement.classList.add('dark')");
    await viewport(1280, 720);
    // Selecting code in Changes and asking about it puts the selection, with its file and lines, in the prompt.
    const changedPath = await js<string>(
      `(()=>{const host=[...document.querySelectorAll('.changes-diff-pane diffs-container')].find(h=>h.shadowRoot?.querySelector('[data-code] [data-line][data-line-type=change-addition]'));
        const row=host?.closest('.commit-stream-row');row?.setAttribute('data-ask-test','');
        return row?.querySelector('.changes-file-header h2')?.getAttribute('title') ?? ''})()`
    );
    assert.ok(changedPath, 'Changes shows a file with an added line');
    await selectDiffRow(
      "document.querySelector('.commit-stream-row[data-ask-test]')",
      '[data-code] [data-line][data-line-type=change-addition]'
    );
    await wait("document.querySelector('.review-selection-actions')?.style.visibility==='visible'");
    await js("document.querySelector('.review-selection-ask').click()");
    await wait("!!document.querySelector('.changes-chat .chat-selection-chip')");
    assert.match(
      await js<string>(
        "document.querySelector('.changes-chat .chat-selection-chip [data-slot=attachment-title]').textContent"
      ),
      new RegExp(`^${(changedPath.split('/').at(-1) ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · L\\d+`),
      'The chip names the Changes file and line'
    );
    await wait("document.activeElement?.id==='changes-question'");
    await fullCapture('changes-selection-chip-dark');
    await js('document.querySelector(\'.changes-chat [aria-label="Remove selected code"]\').click()');
    await wait("!document.querySelector('.changes-chat .chat-selection-chip')");
    // Double-click resets the default width and forgets the saved one.
    // Two presses in quick succession, as a double-click sends them.
    await pointerClick(handle);
    await pointerClick(handle);
    await wait(`${dockWidth}===400`);
    await wait('window.electronAPI.loadPreferences().then(p=>p.chatPanelWidths?.file===undefined)');
    // Asking about another file's selection opened that file's conversation; return to the header's for the checks below.
    await click('Close chat');
    // The selection scrolled another file into place: bring the header's file back before reopening its chat.
    await js("window.askOrigin.closest('.commit-stream-row').scrollIntoView({block:'start'})");
    await wait("!!document.querySelector('.commit-stream-row[data-active=true]')?.contains(window.askOrigin)");
    await js(
      "window.askOrigin.focus();window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait("document.activeElement?.id==='changes-question'");
    if (printShots) {
      // Review shots of the chat UI beside Changes, light and dark, at 1440 and 1024: the resized dock, the model
      // selector, the trace live and folded, citations with a card, and a selection chip.
      const stream = `(()=>{const api=window.electronAPI;window.shotChat={progress:new Set(),trace:new Set()};
        api.onFileChatProgress=(cb)=>{shotChat.progress.add(cb);return()=>shotChat.progress.delete(cb)};
        api.onChatTrace=(cb)=>{shotChat.trace.add(cb);return()=>shotChat.trace.delete(cb)};
        api.askPrFile=(req)=>new Promise((yes)=>{shotChat.id=req.requestId;shotChat.finish=yes});return true})()`;
      const both = async (name: string) => {
        for (const theme of ['light', 'dark']) {
          await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
          await fullCapture(`${name}-${theme}`);
        }
      };
      for (const [w, h] of [
        [1440, 900],
        [1024, 768],
      ]) {
        await viewport(w, h);
        await js(`${handle}.focus()`);
        for (let i = 0; i < (w === 1440 ? 8 : 3); i++) await press(handle, 'ArrowLeft');
        await wait(`${dockWidth}===${w === 1440 ? 528 : 448}`);
        await both(`chat-panel-resized-${w}`);
        await pointerClick("document.querySelector('.changes-chat .model-selector-trigger')");
        await wait("document.querySelectorAll('[role=menuitemradio]').length===8");
        await both(`chat-model-selector-open-${w}`);
        await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await wait("!document.querySelector('[role=menuitemradio]')");
        await js(stream);
        await js("document.querySelector('#changes-question').focus()");
        await fill('What should I check first in this file?');
        await click('Send question');
        await wait('!!window.shotChat.finish');
        await js(`[...shotChat.trace].forEach(cb=>cb({requestId:shotChat.id,steps:[
          {id:'context:file',source:'context',kind:'file',label:'new.ts',detail:'src/new.ts · after only',path:'src/new.ts'},
          {id:'context:pr',source:'context',kind:'pr',label:'PR description',detail:'PR title and description'},
          {id:'agent:t1',source:'agent',kind:'search',label:'“value0”',detail:'Searched for “value0”',input:'pattern: value0\\npath: src',status:'running'},
          {id:'agent:t2',source:'agent',kind:'read',label:'worker.ts',detail:'Read src/worker.ts',path:'src/worker.ts',input:'file_path: src/worker.ts',status:'running'}]}))`);
        await js(
          `[...shotChat.trace].forEach(cb=>cb({requestId:shotChat.id,steps:[{id:'agent:t1',output:'src/new.ts:1:const value0 = 0;',status:'done'}]}))`
        );
        await wait("!!document.querySelector('.changes-chat .chat-trace[data-streaming][data-expanded]')");
        await js("document.querySelector('.changes-chat [data-step=\\'agent:t1\\'] .chat-trace-step-toggle')?.click()");
        await both(`chat-trace-live-${w}`);
        const cited =
          'Start with the constants: each one is exported on its own line [src/new.ts:1-3], so a rename touches every importer. The worker reads them at startup [src/worker.ts:1]. The old module [src/legacy.ts:4] is gone.';
        await js(
          `[...shotChat.progress].forEach(cb=>cb({requestId:shotChat.id,chunk:${JSON.stringify(cited.slice(0, 60))}}))`
        );
        await js(`shotChat.finish(${JSON.stringify(cited)})`);
        await wait("!document.querySelector('.changes-chat .chat-trace[data-streaming]')");
        await wait(
          '!!document.querySelector(\'.changes-chat .inline-citation-trigger[data-citation-path="src/new.ts"]\')'
        );
        await wait(
          "[...document.querySelectorAll('.changes-chat .chat-trace')].at(-1).getBoundingClientRect().height<30"
        );
        await both(`chat-trace-collapsed-${w}`);
        const lastCite =
          '[...document.querySelectorAll(\'.changes-chat .inline-citation-trigger[data-citation-path="src/new.ts"]\')].at(-1)';
        await js(`${lastCite}.scrollIntoView({block:'center',behavior:'instant'})`);
        // Each theme opens the card afresh from keyboard focus (the card also opens on hover; --chat checks that above).
        for (const theme of ['light', 'dark']) {
          await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
          await js("document.querySelector('#changes-question').focus()");
          await wait("!document.querySelector('.inline-citation-card')?.checkVisibility()");
          await js(`${lastCite}.scrollIntoView({block:'center',behavior:'instant'})`);
          await js(`${lastCite}.focus({focusVisible:true})`);
          await wait("!!document.querySelector('.inline-citation-card')?.checkVisibility()");
          await js(
            "Promise.all(document.querySelector('.inline-citation-card').getAnimations().map(a=>a.finished)).then(()=>true)"
          );
          await fullCapture(`chat-citation-hover-${w}-${theme}`);
        }
        await js("document.querySelector('#changes-question').focus()");
        await wait("!document.querySelector('.inline-citation-card')?.checkVisibility()");
        await selectDiffRow(
          "document.querySelector('.commit-stream-row[data-ask-test]')",
          '[data-code] [data-line][data-line-type=change-addition]'
        );
        await wait("document.querySelector('.review-selection-actions')?.style.visibility==='visible'");
        await both(`chat-selection-ask-${w}`);
        await js("document.querySelector('.review-selection-ask').click()");
        await wait("!!document.querySelector('.changes-chat .chat-selection-chip')");
        await both(`chat-selection-chip-${w}`);
        await js('document.querySelector(\'.changes-chat [aria-label="Remove selected code"]\').click()');
        await wait("!document.querySelector('.changes-chat .chat-selection-chip')");
        await click('Close chat');
        await js("window.askOrigin.closest('.commit-stream-row').scrollIntoView({block:'start'})");
        await wait("!!document.querySelector('.commit-stream-row[data-active=true]')?.contains(window.askOrigin)");
        await js(
          "window.askOrigin.focus();window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
        );
        await wait("document.activeElement?.id==='changes-question'");
        // The dock slides in; press its edge where it settles.
        await js(`Promise.all(${dock}.getAnimations().map(a=>a.finished)).then(()=>true)`);
        await pointerClick(handle);
        await pointerClick(handle);
        await wait(`${dockWidth}===400`);
      }
      await js("document.documentElement.classList.add('dark')");
      await viewport(1280, 720);
    }
    await viewport(600, 720);
    await fullCapture('integrated-file-small-dark');
    await assertDock();
    if (printShots) {
      // Review shots of the chat type tier: a long answer beside Changes at 1440px, dark and light.
      await viewport(1440, 900);
      const long =
        '## Review focus\n\nThe worker now **acknowledges before it advances**, so a crash between `dispatch` and `acknowledge` replays the command instead of losing it.\n\n### 5. What stays untouched\n\n- The queue order and its `retry` limit.\n- Commands that never reach a worker.\n\n```ts\nawait queue.dispatch(command);\nawait worker.acknowledge(command.id);\n```\n\nRead `advance()` next: it is the only caller that skips the acknowledgment.';
      await js(`window.electronAPI.askPrFile=async()=>${JSON.stringify(long)};void 0`);
      await fill('What should I review first?');
      await click('Send question');
      await wait(
        `[...document.querySelectorAll('.changes-chat .chat-message-body')].some(b=>b.textContent.includes('only caller that skips'))`
      );
      await wait(
        "document.querySelectorAll('.changes-chat [data-markdown=code-block] code span[style*=color]').length>0"
      );
      for (const theme of ['dark', 'light']) {
        await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
        // The suite's capture: the whole window here, after fonts and the theme's transitions settle.
        await capture(`typeset-changes-chat-1440-${theme}`);
      }
      await js("document.documentElement.classList.add('dark')");
    }
    await viewport(1280, 720);
    assert.ok((await transcriptHeight()) >= 240, 'File conversation needs240px of reading space');
    await click('Close chat');
    await wait('document.activeElement===window.askOrigin');
    // Capture reaches C even inside the diff workspace, which owns other keys.
    await js("window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))");
    await wait("document.activeElement?.id==='changes-question'");
    await fill('Preserve my draft');
    await js(
      "window.askOrigin.focus();window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait("document.activeElement?.id==='changes-question'");
    assert.equal(await js("document.querySelector('#changes-question').value"), 'Preserve my draft');
    await js(
      "window.askOrigin.focus();window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    assert.equal(await js("!!document.querySelector('.changes-chat')"), true, 'Escape outside chat leaves it open');
    await js(
      "document.querySelector('#changes-question').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.changes-chat') && document.activeElement===window.askOrigin");
    await js("window.askOrigin.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))");
    await wait("document.activeElement?.id==='changes-question'");
    assert.equal(
      await js("document.querySelector('#changes-question').value"),
      'Preserve my draft',
      'Escape preserves the draft'
    );
    await click('Close chat');
    // Typing, copy, IME, and modal controls must never open chat.
    for (const test of [
      "const el=document.createElement('textarea');document.body.append(el);el.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));el.remove()",
      "const host=document.createElement('div');document.body.append(host);const root=host.attachShadow({mode:'open'});const el=document.createElement('div');el.contentEditable='true';root.append(el);el.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true,composed:true}));host.remove()",
      "const el=document.createElement('div');el.setAttribute('role','dialog');document.body.append(el);el.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));el.remove()",
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',metaKey:true,bubbles:true}))",
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true}))",
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',isComposing:true,bubbles:true}))",
    ]) {
      await js(`(()=>{${test}})()`);
      assert.equal(await js("!!document.querySelector('.changes-chat')"), false, test);
    }
    await click('Summary');
    await js(
      "document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    assert.equal(
      await js("[...document.querySelectorAll('.chat-sheet,.changes-chat')].some(el=>el.checkVisibility())"),
      false,
      'Summary has no active chat context'
    );
    await click('Commits');
    await wait("!!document.querySelector('.commit-row') && !!document.querySelector('.changes-file-header')");
    await js(
      "const row=document.querySelector('.commit-row');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))"
    );
    await wait("document.activeElement?.id==='changes-question'");
    assert.ok(
      await js("document.querySelector('.chat-panel-context').textContent.includes('→')"),
      'Commit chat uses the selected comparison'
    );
    await assertDock();
    await fullCapture('integrated-commit-dark');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait(
      "!document.querySelector('.changes-chat') && document.activeElement===document.querySelector('.commit-row')"
    );
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
