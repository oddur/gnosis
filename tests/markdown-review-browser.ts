import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createMarkdownReviewService } from '../src/markdown-review-service';
import type { MarkdownReviewRequest } from '../lib/markdown-review';
void app.whenReady().then(async () => {
  const service = createMarkdownReviewService(path.join(__dirname, 'markdown-review-worker.cjs'));
  let renders = 0;
  ipcMain.handle('fixture-markdown-review', (_event, request: MarkdownReviewRequest) => {
    renders++;
    return service.render(request);
  });
  const preload = path.join(__dirname, 'markdown-preload.cjs');
  fs.writeFileSync(
    preload,
    "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('markdownFixture',r=>ipcRenderer.invoke('fixture-markdown-review',r));"
  );
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { preload, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, message) => {
    if (message.includes('Error')) console.log(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 240; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code + '\n' + (await js<string>('document.body.innerText.slice(-3500)')));
  };
  const click = (label: string) =>
    js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.checkVisibility({visibilityProperty:true})&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e)throw Error('Missing button '+${JSON.stringify(label)});e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click()})()`
    );
  const target = 'section[aria-label="docs/retry.md"]';
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    const dir = path.resolve('.impeccable/review/markdown-review');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const within = (expression: string) =>
    js(`(()=>{const root=document.querySelector(${JSON.stringify(target)});${expression}})()`);
  const mode = (name: string) =>
    within(`[...root.querySelectorAll('.markdown-view-switch button')].find(b=>b.textContent==='${name}').click()`);
  try {
    await win.loadURL((process.env.GNOSIS_WORKBENCH_URL ?? '') + '?markdown-review&keep-progress');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      `window.fileReads=[];const read=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=r=>{window.fileReads.push(r);return read(r)};window.electronAPI.getReviewThreads=async()=>({headSha:'head-0',baseSha:'base-0',threads:[{id:'md-thread',path:'docs/retry.md',line:3,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{id:'md-comment',body:'Should cancellation also stop a pending retry?',createdAt:new Date().toISOString(),url:'https://github.com/klang/engine/pull/150#discussion_r1',author:{login:'maya',avatarUrl:''}}]}]});void 0`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await click('Changes');
    await wait(`!!document.querySelector('${target} .markdown-review')`);
    await js(
      `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='retry.md').click();void 0`
    );
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='docs/retry.md'"
    );
    await new Promise((r) => setTimeout(r, 1700));
    await within("root.scrollIntoView({block:'start'})");
    await wait(`!!document.querySelector('${target} ins')`);
    assert.ok(
      await within("return root.querySelector('.markdown-block-content').textContent.includes('Retry failed requests')")
    );
    assert.ok(await within("return [...root.querySelectorAll('del')].some(n=>n.textContent==='three')"));
    assert.ok(await within("return [...root.querySelectorAll('ins')].some(n=>n.textContent==='five')"));
    await capture('desktop');
    await wait(
      `document.querySelector('${target} .markdown-review-discussion')?.textContent.includes('Should cancellation')`
    );
    await within(
      `const paragraph=[...root.querySelectorAll('.markdown-block-content p')].find(p=>p.textContent.includes('The client retries'));const range=document.createRange();range.selectNodeContents(paragraph);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);paragraph.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));`
    );
    await wait(`!!document.querySelector('${target} .markdown-selection-actions')`);
    await capture('selection');
    await within(
      "[...root.querySelectorAll('.markdown-selection-actions button')].find(b=>b.textContent.includes('Comment in source')).click()"
    );
    await wait(`document.querySelector('${target} .changes-code')?.checkVisibility({visibilityProperty:true})`);
    await new Promise((r) => setTimeout(r, 300));
    await wait(
      `(()=>{const root=document.querySelector('${target}');return [...root.querySelectorAll('diffs-container')].some(host=>host.getAttribute('aria-label')==='Source at new line 3' && document.activeElement===host)})()`
    );
    await mode('Preview');
    const fileReads = await js<number>('window.fileReads.length');
    await within("root.querySelector('.markdown-review-toolbar input').click()");
    assert.equal(await within("return root.querySelectorAll('.markdown-review del').length"), 0);
    assert.equal(await within("return root.querySelectorAll('.markdown-review table').length"), 1);
    await capture('clean');
    await mode('Source');
    await wait(`document.querySelector('${target} .changes-code')?.checkVisibility({visibilityProperty:true})`);
    await capture('source');
    await mode('Preview');
    await within("root.querySelector('.markdown-review-toolbar input').click()");
    assert.equal(await js('window.fileReads.length'), fileReads, 'Switching modes reuses full-file cache');
    await within(
      'root.querySelector(\'.markdown-review-navigation button[aria-label="Next Markdown change"]\').click()'
    );
    await wait(`document.querySelector('${target} .markdown-review-navigation span')?.textContent.startsWith('1 of')`);
    await js("document.documentElement.classList.add('dark')");
    await within("root.scrollIntoView({block:'start'})");
    await capture('dark');
    await within("root.querySelector('table').scrollIntoView({block:'center'})");
    await capture('table-code');
    await within("root.querySelector('.markdown-source-link').click()");
    await wait(
      `document.querySelector('${target} .markdown-view-switch button[aria-pressed=true]')?.textContent==='Source'`
    );
    await mode('Preview');
    win.setSize(900, 760);
    await within("root.scrollIntoView({block:'start'})");
    await capture('laptop');
    assert.ok(
      await within("const e=root.querySelector('.markdown-review');return e.scrollWidth<=e.clientWidth"),
      'Rendered prose stays within the file pane'
    );
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='new.md').click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='docs/new.md'");
    await capture('added');
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='removed.md').click()");
    await wait("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='docs/removed.md'");
    await capture('deleted');
    await click('Commits');
    await wait("!!document.querySelector('.commit-stream-row .markdown-review')");
    await capture('commits');
    assert.ok(await js("(()=>{const h=document.querySelector('.commit-stream-row .changes-file-header h2');const r=h.getBoundingClientRect();return r.width>=100 && r.height>=16})()"), 'Markdown commit header preserves file identity');
    const first = "document.querySelector('.commit-stream-row .markdown-review')";
    await js(`${first}.querySelector('.markdown-review-toolbar input').click()`);
    await wait("localStorage.getItem('gnosis-markdown-view:v1')?.includes('false')");
    win.reload();
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await click('Changes');
    await wait("!!document.querySelector('.markdown-review')");
    assert.equal(
      await js("document.querySelector('.markdown-review-toolbar input').checked"),
      false,
      'Clean document choice survives reload'
    );
    assert.ok(renders > 0, 'Comparison runs through the real backend worker');
    console.log(
      'Markdown review passed: actual worker, word edits, clean/source modes, comments, cached switching, change navigation, Changes/Commits and laptop layouts.'
    );
    service.dispose();
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    service.dispose();
    win.destroy();
    app.exit(1);
  }
});
