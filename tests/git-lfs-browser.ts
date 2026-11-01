import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(code + ': ' + String(error));
    }) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error('Timed out: ' + expression);
  };
  const click = async (text: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('.commit-stream-row[data-active=true] button'),...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const shots = path.resolve('.impeccable/review/git-lfs');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    assert.ok(url);
    await loadWorkbenchPage(win, url + '?pr-summary');
    win.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      const cache=await import('/lib/inspection-cache.ts'); await cache.inspectionData.flush();
      window.lfsCalls=[];window.lfsFailures=0;
      const original=window.electronAPI.getPrChangeFile;
      window.electronAPI.getPrChangeFile=async r=>{
        if (!r.path.endsWith('.svg') && !r.path.endsWith('/new.ts')) return original(r);
        const side={kind:'lfs',pointer:{oid:'a'.repeat(64),size:1024}};
        if (!r.downloadLfs) return {before:r.path.endsWith('/new.ts')?{kind:'absent'}:side,after:side,lfs:true};
        window.lfsCalls.push(r);
        if(r.path.endsWith('/new.ts')) {
          if(!window.lfsFailures++)throw Error('Download interrupted. Try again.');
          return {before:{kind:'absent'},after:{kind:'text',content:'const resource = "downloaded LFS contents";'},lfs:true};
        }
        await new Promise(resolve=>window.finishLfs=resolve);
        return {...await original(r),lfs:true};
      };
      cache.inspectionFiles.clear();
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];
      window.openFile=name=>{const row=window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);if(!row)throw Error('Missing '+name);row.click()};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Changes');
    await wait("document.querySelector('.changes-code') && document.body.textContent.includes('Git LFS resource')");
    assert.equal(await js('window.lfsCalls.length'), 0);
    assert.equal(await js("document.querySelectorAll('.review-image-stage img').length"), 0);
    await capture('changes-light');
    await click('Download');
    await wait("document.body.textContent.includes('Downloading the displayed revisions')");
    await capture('downloading-light');
    await js("window.openFile('worker.ts')");
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/worker.ts'"
    );
    await js('window.finishLfs()');
    await wait("!document.body.textContent.includes('Downloading the displayed revisions')");
    assert.equal(
      await js("document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2').textContent"),
      'src/worker.ts'
    );
    await js("window.openFile('flow.svg')");
    await wait(
      "document.querySelectorAll('.review-image-stage img').length===2 && [...document.querySelectorAll('.review-image-stage img')].every(i=>i.naturalWidth>0)"
    );
    assert.equal(await js('window.lfsCalls.length'), 1, 'Reopening uses downloaded contents');
    await js("document.documentElement.classList.add('dark')");
    await capture('downloaded-dark');
    await js("window.openFile('new.ts')");
    await wait(
      "document.querySelector('.commit-stream-row[data-active=true] .changes-file-header h2')?.textContent==='src/new.ts' && document.body.textContent.includes('Git LFS resource')"
    );
    await click('Download');
    await wait("document.body.textContent.includes('Download interrupted')");
    await capture('retry-dark');
    await click('Retry download');
    await wait("window.deepAll('[data-line]').some(e=>e.textContent.includes('downloaded LFS contents'))");
    assert.ok(await js("document.body.textContent.includes('GitHub line comments refer to the pointer file')"));
    assert.ok(await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Comment').disabled"));
    await capture('text-dark');
    await click('Summary');
    await click('Changes');
    assert.equal(await js('window.lfsCalls.length'), 3);
    // Explanation uses the same explicit interaction, preserving errors for retry.
    await loadWorkbenchPage(win, url + '?images');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(()=>{
      const original=window.electronAPI.loadReviewImages;
      window.imageDownloads=0;
      window.electronAPI.loadReviewImages=async(id,path,download)=>{
        const result=await original(id,path);
        if(!path.endsWith('mark.svg'))return result;
        if(download)window.imageDownloads++;
        if(window.imageDownloads>=2)return result;
        const lfs=side=>({...side,status:'lfs',pointer:{oid:'a'.repeat(64),size:2048},error:download?'Download interrupted. Try again.':undefined});
        return {before:lfs(result.before),after:lfs(result.after)};
      };
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await click('Continue review');
    await wait("document.body.textContent.includes('Git LFS resource')");
    assert.equal(await js('window.imageDownloads'), 0);
    await js("document.querySelector('.review-image-diff').scrollIntoView({block:'start'})");
    await capture('explanation-light');
    await click('Download');
    await wait("document.body.textContent.includes('Download interrupted')");
    await js("document.documentElement.classList.add('dark')");
    win.setContentSize(640, 800);
    await wait(
      "[...document.querySelectorAll('button')].some(b=>b.getBoundingClientRect().width && b.textContent.trim()==='Code')"
    );
    await click('Code');
    await js("document.querySelector('.review-image-diff').scrollIntoView({block:'start'})");
    await capture('explanation-narrow-dark');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    // The responsive pane remount can re-read the pointer and clear the transient error.
    await click(
      (await js<boolean>(
        "[...document.querySelectorAll('button')].some(b=>b.getBoundingClientRect().width && b.textContent.trim()==='Retry download')"
      ))
        ? 'Retry download'
        : 'Download'
    );
    await wait("document.querySelectorAll('.review-image-diff:first-of-type .review-image-stage img').length>=2");
    assert.equal(await js('window.imageDownloads'), 2);
    win.setContentSize(1280, 800);
    await loadWorkbenchPage(win, url + '?images&lfs-text');
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(async()=>{
      const review=await window.electronAPI.loadReview('workbench-review');
      const topic=review.slides[0], file=topic.affectedFiles[0], next=file.replace('mark.svg','resource.txt');
      topic.affectedFiles=topic.affectedFiles.map(p=>p===file?next:p);
      topic.diffHunks=topic.diffHunks.map(h=>({...h,filePath:next,content:'-version https://git-lfs.github.com/spec/v1\\n+version https://git-lfs.github.com/spec/v1'}));
      review.changedFiles=review.changedFiles.map(f=>f.filename===file?{...f,filename:next}:f);
      const original=window.electronAPI.loadReviewImages;
      window.textDownloads=0;
      window.electronAPI.loadReviewImages=async(id,path,download)=>{
        if(path!==next)return original(id,path,download);
        if(download)window.textDownloads++;
        const side=before=>window.textFailure===(before?'before':'after') ? {status:'error',message:(before?'Base':'Head')+' revision unavailable.'} : window.textDownloads ? {status:'text',content:before?'const delay = 1;':'const delay = 2;',path:next,revision:'a'.repeat(40)} : {status:'lfs',pointer:{oid:'a'.repeat(64),size:100},path:next,revision:'a'.repeat(40)};
        return {before:side(true),after:side(false)};
      };
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(selector,e.shadowRoot))];
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await click('Continue review');
    await wait("document.body.textContent.includes('Git LFS resource')");
    assert.equal(await js('window.textDownloads'), 0);
    await click('Download');
    await wait("window.deepAll('[data-line]').some(e=>e.textContent.includes('const delay = 2'))");
    await js("document.querySelector('.review-image-diff').scrollIntoView({block:'start'})");
    await capture('explanation-text-light');
    assert.equal(await js('window.textDownloads'), 1);
    for (const side of ['before', 'after']) {
      await js(`window.textFailure=${JSON.stringify(side)};document.querySelector('.review-file-expand').click()`);
      await js("document.querySelector('.review-file-expand').click()");
      await wait(
        `document.querySelector('.review-image-diff').textContent.includes(${JSON.stringify((side === 'before' ? 'Base' : 'Head') + ' revision unavailable.')})`
      );
      assert.equal(
        await js("document.querySelector('.review-image-diff').querySelectorAll('diffs-container').length"),
        0,
        'A failed revision must not appear as an added/deleted resource'
      );
      await js("document.querySelector('.review-image-diff').scrollIntoView({block:'start'})");
      await capture(`failed-${side}-light`);
      await js("window.textFailure=''");
      await click('Retry preview');
      await wait("document.querySelector('.review-image-diff diffs-container') !== null");
    }

    console.log(
      'LFS browser checks passed: opt-in, progress, retry, navigation during download, cache reuse, text comments, explanations, light/dark and narrow layout.'
    );
    app.exit(0);
  } catch (e) {
    console.error(e);
    await capture('failure');
    console.error(await js('document.body.innerText'));
    app.exit(1);
  }
});
