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
  window.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
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
      const getStatus = window.electronAPI.getPrStatus;
      window.electronAPI.getPrStatus = async (...args) => ({
        ...await getStatus(...args), ciConclusion:'success',
        ciChecks:[{name:'continuous-integration-'+'verylongcheckname'.repeat(25),status:'completed',conclusion:'success',url:'https://github.com/klang/engine/actions'}],
      });
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
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page .pr-description')");
    assert.equal(await js('window.generationCalls.length'), 0, 'Opening a summary never generates AI content');
    assert.equal(await js('window.metadataReads'), 0, 'Queued PR descriptions use shared cached metadata');
    assert.equal(await js('document.activeElement.tagName'), 'H1');
    assert.match(await js<string>("document.querySelector('.pr-description').textContent"), /outbox/);
    assert.match(await js<string>("document.querySelector('.pr-metadata').textContent"), /lena/);
    assert.equal(await js("document.querySelector('.pr-secondary-metadata').open"), false);
    assert.equal(
      await js("document.querySelector('.pr-readiness').getBoundingClientRect().bottom < 350"),
      true,
      'Readiness belongs in the first viewport'
    );
    assert.equal(
      await js(
        `(() => { const headings=[...document.querySelectorAll('.pr-summary-page h1,.pr-summary-page h2,.pr-summary-page h3,.pr-summary-page h4')].map(h=>Number(h.tagName[1])); return headings.every((level,i)=>i===0||level<=headings[i-1]+1); })()`
      ),
      true,
      'Author Markdown stays beneath the app heading hierarchy'
    );
    assert.equal(await js("document.querySelector('.pr-markdown').getBoundingClientRect().width <= 550"), true);
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
    await js("document.querySelector('.pr-checks').open = true");
    assert.equal(
      await js(
        "document.querySelector('.pr-summary-page').scrollWidth <= document.querySelector('.pr-summary-page').clientWidth"
      ),
      true,
      'Expanded long CI check names wrap without widening the summary'
    );
    await capture('pr-summary-narrow');
    await js("document.querySelector('.pr-checks').open = false");
    assert.equal(await js("document.querySelector('.pr-summary-page').scrollWidth <= innerWidth"), true);
    window.setSize(1280, 800);
    await js("document.querySelector('.pr-summary-page').scrollTop = 420");
    await js('document.querySelector(\'[aria-label="Next change"]\').click()');
    await wait("document.querySelector('.pr-summary-content h1')?.textContent.includes('Reduce allocations')");
    assert.match(await js<string>("document.querySelector('.pr-description').textContent"), /No description provided/);
    await js('document.querySelector(\'[aria-label="Previous change"]\').click()');
    await wait("document.querySelector('.pr-summary-content h1')?.textContent.includes('Fix reconnect')");
    await wait("document.querySelector('.pr-summary-page').scrollTop >= 400");
    await js("document.querySelector('.pr-summary-page').scrollTop = 0");
    await js(
      "document.querySelector('.pr-secondary-metadata summary').dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))"
    );
    assert.match(await js<string>("document.querySelector('.pr-summary-content h1').textContent"), /Fix reconnect/);
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
    await wait("document.querySelector('.pr-summary-content h1')?.textContent.includes('Reduce allocations')");
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}))");
    await wait("document.querySelector('.pr-summary-content h1')?.textContent.includes('Fix reconnect')");
    assert.equal(await js('window.metadataReads'), 0, 'Moving through cached summaries adds no metadata reads');
    await click('Generate AI explanation');
    await wait("document.querySelector('.pr-summary-actions button:last-child')?.textContent.includes('Generating')");
    assert.equal(await js('window.generationCalls.length'), 1);
    assert.equal(await js("document.querySelector('.pr-summary-actions button:last-child').disabled"), true);
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
    await click('Open PR overview');
    assert.match(await js<string>("document.querySelector('.pr-description').textContent"), /No description provided/);
    await click('Work queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Author description');
    await wait("document.querySelectorAll('.pr-summary-page .pr-details').length === 1");
    assert.equal(await js("document.querySelectorAll('.pr-stack-nav button').length"), 3);
    await js("document.querySelectorAll('.pr-stack-nav button')[2].click()");
    assert.match(await js<string>("document.querySelector('.pr-details-heading h2').textContent"), /#122/);
    assert.match(await js<string>("document.querySelector('.pr-member-relationship').textContent"), /Builds on #121/);
    await capture('pr-summary-stack');
    window.setSize(980, 700);
    assert.equal(await js("getComputedStyle(document.querySelector('.pr-stack-select')).display"), 'flex');
    await js(
      "(()=>{const s=document.querySelector('.pr-stack-select select');s.selectedIndex=1;s.dispatchEvent(new Event('change',{bubbles:true}));})()"
    );
    assert.match(await js<string>("document.querySelector('.pr-details-heading h2').textContent"), /#121/);
    await capture('pr-summary-stack-laptop');
    window.setSize(1280, 800);
    assert.equal(await js('window.generationCalls.length'), 1, 'Opening a stack does not generate a review');
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Author description');
    assert.equal(await js("document.querySelectorAll('.workbench-overview .pr-details').length"), 1);
    await click('AI explanation');
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
    assert.equal(
      await js('document.querySelector(\'[aria-label="Next change"]\').disabled'),
      true,
      'Unqueued PRs do not jump into an unrelated view'
    );
    await click('Work queue');
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue(); const item=q.items[0];
      const base=item.subject.members[0];
      for(let i=3;i<9;i++) {
        const m={...base,number:120+i,url:'https://github.com/klang/engine/pull/'+(120+i),title:'Stack step '+(i+1),description:('A distinct contribution to the stack.\\n\\n').repeat(35),headBranch:'queue-'+i,baseBranch:'queue-'+(i-1)};
        item.subject.edges.push({parent:item.subject.members.at(-1).url,child:m.url,evidence:'branch'});
        item.subject.members.push(m);
      }
      item.subject.warnings=['Check this stack grouping before generating its explanation.'];
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await wait("document.querySelectorAll('.pr-stack-nav button').length === 9");
    assert.equal(await js("document.querySelectorAll('.pr-summary-page .pr-details').length"), 1);
    assert.equal(
      await js(
        "document.querySelector('.pr-summary-content>.workbench-notice').getBoundingClientRect().top < document.querySelector('.pr-description').getBoundingClientRect().top"
      ),
      true
    );
    await js("document.querySelectorAll('.pr-stack-nav button')[8].click()");
    assert.match(await js<string>("document.querySelector('.pr-details-heading h2').textContent"), /#128/);
    assert.match(await js<string>("document.querySelector('.pr-member-relationship').textContent"), /Builds on #127/);
    await capture('pr-summary-nine-pr-stack');
    await js("document.querySelector('.pr-summary-page').scrollTop=350");
    await js("document.querySelectorAll('.pr-stack-nav button')[0].click()");
    await js("document.querySelectorAll('.pr-stack-nav button')[8].click()");
    await wait("document.querySelector('.pr-summary-page').scrollTop>=330");
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}))");
    await wait("!document.querySelector('.pr-stack-nav')");
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}))");
    await wait(
      "document.querySelector('.pr-details-heading h2')?.textContent.includes('#128') && document.querySelector('.pr-summary-page').scrollTop>=330"
    );
    window.setSize(540, 760);
    await js("document.querySelector('.pr-summary-page').scrollTop=0");
    await capture('pr-summary-nine-pr-stack-narrow');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.setSize(1280, 800);
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!!document.querySelector('.queue-list')");
    await js("window.electronAPI.workbenchSetFilters({author:'sam'})");
    await window.loadURL(fixtureUrl + '?pr-summary');
    await wait("document.querySelectorAll('.queue-item').length===2");
    await js("document.querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("document.querySelector('.pr-queue-navigation')?.textContent.includes('1 / 2')");
    await js('document.querySelector(\'[aria-label="Next change"]\').click()');
    await wait("document.querySelector('.pr-queue-navigation')?.textContent.includes('2 / 2')");
    assert.match(
      await js<string>("document.querySelector('.pr-summary-content h1').textContent"),
      /Handle empty batches/
    );
    assert.equal(await js('document.querySelector(\'[aria-label="Next change"]\').disabled'), true);
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
