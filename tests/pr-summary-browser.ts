import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const click = (label: string) =>
    js(`(()=>{
    const button = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});
    if(!button) throw Error('Missing button: '+${JSON.stringify(label)});
    button.click();
  })()`);
  const shots = path.join(os.tmpdir(), 'gnosis-workbench-screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    // Exercise the unavailable-image fallback without depending on an external service.
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['https://raw.githubusercontent.com/*', 'https://github.com/user-attachments/assets/*'] },
      (_details, callback) => callback({ cancel: true })
    );
    const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
    if (!fixtureUrl) throw new Error('Missing workbench fixture URL');
    await window.loadURL(fixtureUrl + '?pr-summary');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js(`(() => {
      window.metadataReads = 0; window.generationCalls = [];
      window.privateImageReads = 0;
      window.electronAPI.loadPrImage = async url => {
        if (!url.includes('/user-attachments/')) throw Error('Missing image');
        window.privateImageReads++;
        const svg = await (await fetch('/tests/fixtures/pr-description.svg')).text();
        return 'data:image/svg+xml;base64,' + btoa(svg);
      };
      const read = window.electronAPI.getPrMetadata;
      window.electronAPI.getPrMetadata = (...args) => { window.metadataReads++; return read(...args); };
      window.electronAPI.startReview = async request => {
        window.generationCalls.push(request);
        const queue = await window.electronAPI.workbenchQueue();
        const item = queue.items.find(i=>i.subject.id===request.subjectId);
        if(item) item.review = { id:'new-explanation', prUrl:request.prUrl, prTitle:item.subject.title, status:'generating', savedAt:new Date().toISOString(), snapshot:{subject:item.subject} };
        return {reviewId:'new-explanation'};
      };
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open summary');
    await wait("!!document.querySelector('.pr-summary-page .pr-description')");
    assert.equal(await js('window.generationCalls.length'), 0, 'Opening a summary never generates AI content');
    assert.equal(await js('window.metadataReads'), 0, 'Queued PR descriptions use shared cached metadata');
    assert.equal(await js('document.activeElement.tagName'), 'H1');
    assert.match(await js<string>("document.querySelector('.pr-description').textContent"), /outbox/);
    assert.match(await js<string>("document.querySelector('.pr-metadata').textContent"), /lena/);
    assert.equal(await js("document.querySelectorAll('.pr-description table').length"), 1);
    assert.equal(await js("document.querySelectorAll('.pr-description input[type=checkbox]').length"), 2);
    assert.match(await js<string>("document.querySelector('.pr-description pre').textContent"), /outbox.flush/);
    await wait('document.querySelector(\'img[alt="Reconnect flow"]\')?.naturalWidth === 600');
    await js("document.querySelector('.pr-description details').open = true");
    await wait('document.querySelector(\'img[alt="HTML reconnect screenshot"]\')?.naturalWidth === 600');
    assert.equal(
      await js("document.querySelector('img[alt=\"HTML reconnect screenshot\"]').hasAttribute('onerror')"),
      false
    );
    assert.equal(await js("document.querySelectorAll('.pr-description script, .pr-description iframe').length"), 0);
    assert.equal(await js('window.unsafeDescription === undefined'), true);
    assert.equal(await js("document.querySelectorAll('.pr-description a[href^=javascript]').length"), 0);
    assert.equal(
      await js("[...document.querySelectorAll('.pr-description a')].find(a=>a.textContent==='Source').href"),
      'https://github.com/klang/engine/blob/head-0/src/outbox.ts'
    );
    await wait("!!document.querySelector('.markdown-image-fallback')");
    await js('document.querySelector(\'img[alt="Private attachment"]\')?.scrollIntoView()');
    await wait('document.querySelector(\'img[alt="Private attachment"]\')?.naturalWidth === 600');
    await new Promise((resolve) => setTimeout(resolve, 4200));
    assert.equal(await js('window.privateImageReads'), 1, 'Background queue polls preserve authenticated images');
    await js("document.querySelector('.pr-summary-page').scrollTop = 0");
    await capture('pr-summary-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('pr-summary-dark');
    window.setSize(980, 700);
    await capture('pr-summary-laptop');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.setSize(540, 760);
    await capture('pr-summary-narrow');
    assert.equal(await js("document.querySelector('.pr-summary-page').scrollWidth <= innerWidth"), true);
    window.setSize(1280, 800);
    await click('Generate explanation');
    await wait("document.querySelector('.pr-summary-actions button')?.textContent.includes('Generating')");
    assert.equal(await js('window.generationCalls.length'), 1);
    assert.equal(await js("document.querySelector('.pr-summary-actions button').disabled"), true);
    assert.equal(
      await js("!!document.querySelector('.pr-description')"),
      true,
      'Description remains readable while generating'
    );
    await click('Work queue');
    await wait("!!document.querySelector('.queue-list')");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Reduce allocations')).click()"
    );
    await click('Open summary');
    assert.match(await js<string>("document.querySelector('.pr-description').textContent"), /No description provided/);
    await click('Work queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('PR description & details');
    await wait("document.querySelectorAll('.pr-summary-page .pr-details').length === 3");
    assert.equal(await js('window.generationCalls.length'), 1, 'Opening a stack does not generate a review');
    await click('Open explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('PR description & details');
    assert.equal(await js("document.querySelectorAll('.workbench-overview .pr-details').length"), 3);
    await click('Explanation');
    await wait("!!document.querySelector('.overview-topic')");
    await click('Back');
    await wait("!!document.querySelector('.queue-list')");
    await click('Open PR');
    await js(`(()=>{
      const input = document.querySelector('[aria-label="Pull request URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://github.com/klang/engine/pull/999');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await js("document.querySelector('.queue-url button[type=submit]').click()");
    await wait("document.querySelector('.pr-summary-content h1')?.textContent==='A PR outside the queue'");
    assert.equal(await js('window.metadataReads'), 1);
    assert.equal(await js('window.generationCalls.length'), 1, 'A pasted URL only fetches metadata');
    console.log('PR summary browser checks passed. Screenshots: ' + shots);
  } catch (error) {
    console.error(error);
    console.log(await js('document.body.innerText'));
    await capture('pr-summary-failure');
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
