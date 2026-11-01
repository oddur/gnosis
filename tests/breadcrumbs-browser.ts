import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('.commit-stream-row[data-active=true] button'),...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 80));
  };
  const reveal = async (label: string) => {
    if (!(await js(`!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`)))
      await click('Show full review hierarchy');
  };
  const choose = async (label: string, value: string) => {
    await reveal(label);
    await js(`window.selectOption('[aria-label=${JSON.stringify(label)}]',${JSON.stringify(value)})`);
    await new Promise((r) => setTimeout(r, 100));
  };
  const shots = path.resolve('.impeccable/review/breadcrumbs');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js("(async()=>{await (await import('/lib/inspection-cache.ts')).inspectionData.flush()})()");
    await js(
      `window.starts=0;window.electronAPI.startReview=async()=>{window.starts++;throw Error('Unexpected generation')};void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait('!!document.querySelector(\'[aria-label="Review location"]\')');
    const rootLabel = () => js<string>("document.querySelector('[data-slot=breadcrumb-list] button').textContent");
    assert.equal(await rootLabel(), 'Review queue');
    const rowHeight = await js<number>(
      "document.querySelector('.pr-summary-toolbar-inner').getBoundingClientRect().height"
    );
    await capture('summary-light-1280');
    await choose('Review tab', 'changes');
    await wait('!!document.querySelector(\'[aria-label="File in comparison"]\')');
    // File choices are scoped to this PR; typing has no network or selection effects.
    await js(
      `window.calls=0;for(const name of ['getPrChanges','getPrChangeFile','getPrCommits','getCommitComparison']){const original=window.electronAPI[name];window.electronAPI[name]=(...args)=>{window.calls++;return original(...args)}}void 0;`
    );
    const currentFile = await js<string>('document.querySelector(\'[aria-label="File in comparison"]\').value');
    await click('File in comparison');
    await wait("!!document.querySelector('[data-slot=combobox-input]')");
    await js(
      `(()=>{const input=document.querySelector('[data-slot=combobox-input]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'worker');input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length===1");
    assert.equal(await js('document.querySelector(\'[aria-label="File in comparison"]\').value'), currentFile);
    assert.equal(await js('window.calls'), 0);
    await capture('file-search-1280');
    await js("document.querySelector('[data-slot=combobox-item]').click()");
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/worker.ts'"
    );
    assert.match(await js<string>("document.querySelector('[data-slot=breadcrumb-list]').textContent"), /worker.ts/);
    const worker = await js<string>('document.querySelector(\'[aria-label="File in comparison"]\').value');
    assert.equal(
      await js("document.querySelector('.pr-summary-toolbar-inner').getBoundingClientRect().height"),
      rowHeight
    );
    await capture('changes-light-1280');
    await js("document.documentElement.classList.add('dark')");
    await capture('changes-dark-1280');
    await js("document.documentElement.classList.remove('dark')");
    await choose('Review tab', 'commits');
    await wait("document.querySelectorAll('.commit-row').length===3");
    await choose('Commit', 'a'.repeat(40));
    await wait("document.querySelector('.commit-row[aria-pressed=true]')?.textContent.includes('aaaaaaa')");
    await capture('commits-1280');
    await click('Changes');
    await wait(`document.querySelector('[aria-label="File in comparison"]')?.value===${JSON.stringify(worker)}`);
    // Subject switch retains Changes; returning restores the selected file.
    const standalone = await js<string>(
      "(async()=>(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.title.includes('Fix reconnect')).subject.id)()"
    );
    const stack = await js<string>(
      "(async()=>(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack').subject.id)()"
    );
    await choose('PR or stack', stack);
    await wait(
      "!!document.querySelector('.changes-file-header') && !!document.querySelector('.pr-summary-page.is-stack')"
    );
    await choose('Source PR in stack changes', 'https://github.com/klang/engine/pull/121');
    await wait("document.querySelector('[aria-label=\"File in comparison\"]')?.value.includes('#121/')");
    await capture('stack-changes-1280');
    win.setSize(640, 800);
    await wait('!!document.querySelector(\'[aria-label="Show full review hierarchy"]\')');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(
      await js("document.querySelector('.pr-summary-toolbar-inner').getBoundingClientRect().height"),
      rowHeight
    );
    await capture('stack-changes-640');
    await click('Show full review hierarchy');
    await click('PR or stack');
    await wait("!!document.querySelector('[data-slot=combobox-input]')");
    await capture('nested-picker-640');
    await js(
      "document.querySelector('[data-slot=combobox-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
    );
    await wait("!document.querySelector('[data-slot=combobox-content]')");
    assert.equal(await js("!!document.querySelector('.breadcrumb-overflow-menu')"), true);
    await js(
      "document.querySelector('.breadcrumb-overflow-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
    );
    await wait("!document.querySelector('.breadcrumb-overflow-menu')");
    win.setSize(1280, 800);
    await click('Explanation');
    await wait('!!document.querySelector(\'[aria-label="Review topic"]\')');
    await choose('Review topic', '2');
    await wait("document.querySelector('[aria-label=\"Review topic\"]').value==='2'");
    assert.equal(await js('!!document.querySelector(\'.review-toolbar [aria-label="Review topic"]\')'), false);
    await capture('stack-explanation-1280');
    await click('Changes');
    await wait('!!document.querySelector(\'[aria-label="File in comparison"]\')');
    assert.equal(
      await js('!!document.querySelector(\'[aria-label="Review topic"]\')'),
      false,
      'Hidden explanation must not own Changes trail'
    );
    await choose('PR or stack', standalone);
    await wait(`document.querySelector('[aria-label="File in comparison"]')?.value===${JSON.stringify(worker)}`);
    await click('Review queue');
    await wait("!!document.querySelector('.queue-row-main')");
    // Origin names actual built-in view, preserving it on return.
    await js(
      "[...document.querySelectorAll('.workbench-sidebar button')].find(b=>b.textContent.startsWith('Stacks')).click()"
    );
    await wait("document.querySelectorAll('.queue-item').length===1");
    await js("document.querySelector('.queue-row-main').click()");
    await click('Open stack overview');
    assert.equal(await rootLabel(), 'Stacks');
    await click('Stacks');
    await wait("!!document.querySelector('.queue-row-main')");
    assert.equal(
      await js("document.querySelector('.workbench-sidebar [aria-current=page]')?.textContent.includes('Stacks')"),
      true
    );
    await js(
      "[...document.querySelectorAll('.workbench-sidebar button')].find(b=>b.textContent.startsWith('Saved reviews')).click()"
    );
    await wait("!!document.querySelector('.saved-row')");
    await js("document.querySelector('.saved-row .queue-row-main').click()");
    await wait('!!document.querySelector(\'[aria-label="Review topic"]\')');
    assert.equal(await rootLabel(), 'Saved reviews');
    await click('Saved reviews');
    await wait("!!document.querySelector('.saved-row')");
    // A local review uses its repository, not invented PR metadata, and returns to Saved reviews.
    await js(`(async()=>{
      const original=await window.electronAPI.loadReview('workbench-review');
      window.locals=['local-one','local-two'].map((id,index)=>({...original,reviewId:id,prUrl:'local:/Users/reviewer/projects/worker#main..HEAD',prTitle:'Local worker changes '+(index+1),snapshot:undefined}));
      window.electronAPI.loadReview=async id=>window.locals.find(r=>r.reviewId===id)??original;
      window.electronAPI.listReviews=async()=>window.locals.map(r=>({id:r.reviewId,prUrl:r.prUrl,prTitle:r.prTitle,author:'oddur',savedAt:new Date().toISOString(),status:'completed'}));
    })()`);
    await wait("document.querySelectorAll('.saved-row').length===2");
    await js("document.querySelector('.saved-row .queue-row-main').click()");
    await wait(
      "!!document.querySelector('[aria-label=\"Review topic\"]') && !document.querySelector('.pr-overview-tabs')"
    );
    assert.equal(await rootLabel(), 'Saved reviews');
    assert.match(await js<string>("document.querySelector('[data-slot=breadcrumb-list]').textContent"), /worker/);
    assert.doesNotMatch(
      await js<string>("document.querySelector('[data-slot=breadcrumb-list]').textContent"),
      /#120|#121|#122/
    );
    await choose('Saved review', 'local-two');
    await wait("document.querySelector('[aria-label=\"Saved review\"]')?.value==='local-two'");
    await capture('local-review-1280');
    await click('Saved reviews');
    await wait("document.querySelectorAll('.saved-row').length===2");
    assert.equal(
      await js(
        "document.querySelector('.workbench-sidebar [aria-current=page]')?.textContent.startsWith('Saved reviews')"
      ),
      true
    );
    assert.equal(await js('window.starts'), 0);
    console.log('Breadcrumb browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await js('document.body.innerText'));
    fs.writeFileSync(path.join(shots, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
