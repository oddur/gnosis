import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
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
    await loadWorkbenchPage(win, (process.env.GNOSIS_WORKBENCH_URL ?? '') + '?markdown-review&keep-progress');
    await waitForWorkbenchQueue(win.webContents);
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
    await within(
      "const toggle=root.querySelector('.markdown-review-toolbar input'); if(!toggle.checked) toggle.click()"
    );
    await wait(`!!document.querySelector('${target} ins')`);
    assert.ok(
      await within("return root.querySelector('.markdown-block-content').textContent.includes('Retry failed requests')")
    );
    assert.ok(await within("return [...root.querySelectorAll('del')].some(n=>n.textContent==='three')"));
    assert.ok(await within("return [...root.querySelectorAll('ins')].some(n=>n.textContent==='five')"));
    assert.ok(await within("return root.querySelectorAll('.markdown-context-gap').length > 0"));
    assert.ok(
      await within("return !root.querySelector('.markdown-review-document').textContent.includes('Keep credentials')")
    );
    assert.ok(await within("return !root.querySelector('[id$=credentials]')"));
    await within("root.querySelector('a[href$=credentials]').click()");
    await wait("document.activeElement?.textContent === 'Credentials'");
    assert.ok(await within("return root.querySelector('.markdown-review-document').textContent.includes('Keep credentials')"));
    await within("root.querySelector('.markdown-context-gap').scrollIntoView({block:'center'})");
    await capture('folded');
    await within("root.querySelector('.markdown-context-gap button').click()");
    await wait(
      `document.querySelector('${target} .markdown-review-document')?.textContent.includes('Keep credentials')`
    );
    assert.ok(await within("return root.querySelector('.markdown-review-document').contains(document.activeElement)"));
    await capture('expanded');
    await within(
      "[...root.querySelectorAll('[data-md-block]')].find(b=>b.textContent.includes('Keep credentials')).querySelector('.markdown-source-link').click()"
    );
    await wait(`document.querySelector('${target} .changes-code')?.checkVisibility({visibilityProperty:true})`);
    await new Promise((r) => setTimeout(r, 300));
    await mode('Preview');
    await wait(
      `document.querySelector('${target} .markdown-review-document')?.textContent.includes('Keep credentials')`
    );
    await within("root.scrollIntoView({block:'start'})");
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
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='docs/new.md'"
    );
    await capture('added');
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='removed.md').click()");
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='docs/removed.md'"
    );
    await capture('deleted');
    await click('Commits');
    await wait("!!document.querySelector('.commit-stream-row .markdown-review')");
    await capture('commits');
    assert.ok(
      await js(
        "(()=>{const h=document.querySelector('.commit-stream-row .changes-file-header h2');const r=h.getBoundingClientRect();return r.width>=100 && r.height>=16})()"
      ),
      'Markdown commit header preserves file identity'
    );
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
    await loadWorkbenchPage(win, (process.env.GNOSIS_WORKBENCH_URL ?? '') + '?markdown-explanation');
    win.setSize(1280, 900);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      "window.electronAPI.getReviewThreads=async()=>({headSha:'head-1',baseSha:'base-1',threads:[{id:'explanation-thread',path:'docs/retry.md',line:22,startLine:null,diffSide:'RIGHT',isResolved:false,isOutdated:false,viewerCanResolve:true,viewerCanUnresolve:false,comments:[{id:'explanation-comment',body:'Does the limit include the first attempt?',createdAt:new Date().toISOString(),url:'https://github.com/klang/engine/pull/121#discussion_r1',author:{login:'maya',avatarUrl:''}}]}]});void 0"
    );
    await js("window.dispatchEvent(new CustomEvent('fixture-review-navigate',{detail:'workbench-review'}))");
    await wait("!!document.querySelector('.pr-overview-tabs') || !!document.querySelector('.review-workspace')");
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    await wait("!!document.querySelector('.review-file-group .markdown-review ins')");
    assert.ok(
      await js("document.querySelector('.review-file-group').textContent.includes('four retries')"),
      'Inline insights appear with the rendered section'
    );
    assert.ok(await js("document.querySelector('.review-file-group').textContent.includes('Between saved sections')"));
    await wait(
      "document.querySelector('.review-file-group .markdown-review-discussion')?.textContent.includes('four retries')"
    );
    assert.ok(
      await js(
        "document.querySelector('.review-file-group .markdown-review').textContent.includes('Does the limit include')"
      ),
      'GitHub threads stay attached to rendered sections'
    );
    await capture('explanation-desktop');
    await js("document.querySelector('.inline-code-explanation').scrollIntoView({block:'center'})");
    await capture('explanation-context');
    await js(
      "(()=>{const word=document.querySelector('.review-file-group del');const range=document.createRange();range.selectNodeContents(word);window.getSelection().removeAllRanges();window.getSelection().addRange(range);word.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})()"
    );
    await click('Comment in source');
    await wait('!!document.querySelector(\'diffs-container[aria-label="Source at old line 22"]\')');
    assert.ok(
      await js("document.activeElement?.getAttribute('aria-label')==='Source at old line 22'"),
      'Deleted text opens old source'
    );
    await capture('explanation-source');
    await click('Preview');
    await wait("!!document.querySelector('.review-file-group .markdown-review ins')");
    await js("document.querySelector('.review-file-group .markdown-review h1').closest('[data-md-block]').querySelector('.markdown-source-link').click()");
    await wait('!!document.querySelector(\'diffs-container[aria-label="Source at new line 10"]\')');
    // Wait through the post-scroll state update: the destination must remain expanded.
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await js("[...document.querySelectorAll('.review-file-group diffs-container')].some(host => host.shadowRoot?.querySelector('[data-line-number=\"10\"]'))"));
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Source at new line 10');
    await click('Preview');
    await wait("!!document.querySelector('.review-file-group .markdown-review ins')");
    await js("document.querySelector('.review-file-group .markdown-review-toolbar input').click()");
    await wait("document.querySelector('.review-file-group .markdown-review-mode')?.textContent==='Topic excerpts'");
    assert.ok(await js("!document.querySelector('.review-file-group del')"));
    win.setSize(900, 760);
    await js("document.documentElement.classList.add('dark')");
    // The Code tab appears only after the responsive layout processes the resize.
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Code'&&b.checkVisibility({visibilityProperty:true}))");
    await click('Code');
    await capture('explanation-laptop');
    await js("document.querySelector('.review-file-group .markdown-review h2').scrollIntoView({block:'center'})");
    await capture('explanation-laptop-content');
    await js("document.querySelector('.review-file-viewed input').click()");
    await wait("document.querySelector('.review-file-content')?.hidden === true");
    assert.ok(
      await js("!!document.querySelector('.review-files-complete')"),
      'Viewed collapse retains next-topic action'
    );
    assert.ok(renders > 0, 'Comparison runs through the real backend worker');
    console.log(
      'Markdown review passed: actual worker, Changes/Commits, explanation previews, inline insights, GitHub threads, deleted-text source focus, cached toggles, Viewed and laptop layouts.'
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
