import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 600; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (text: string) =>
    js(
      `[...document.querySelectorAll('main button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`
    );
  const shots = path.resolve('.impeccable/review/moved-files');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("!!window.electronAPI && document.querySelectorAll('.queue-item').length>0");
    await js(`(async()=>{
      const cache=await import('/lib/inspection-cache.ts');cache.inspectionData.stop();cache.inspectionFiles.clear();
      const snapshot=await window.electronAPI.getPrChanges('https://github.com/klang/engine/pull/120');
      snapshot.metadata={...snapshot.metadata,state:'open',merged:false};window.electronAPI.getAuthState=async()=>({authenticated:true,login:'oddur'});
      snapshot.files=['src/moved.ts','src/edited.ts','art/changed.svg','docs/moved.md'].map((path,i)=>({path,previousPath:'old/'+path,status:'renamed',additions:i===1?1:0,deletions:i===1?1:0,changeId:path}));
      window.electronAPI.getPrChangeFile=async r=>r.path.endsWith('.svg')?{before:{kind:'image',dataUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>')},after:{kind:'image',dataUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="blue"/></svg>')}}:{before:{kind:'text',content:'export const first = 1;\\nexport const second = 2;\\n'},after:{kind:'text',content:r.path==='src/edited.ts'?'export const first = 3;\\nexport const second = 2;\\n':'export const first = 1;\\nexport const second = 2;\\n'}};
      const {mountMovedFiles}=await import('/tests/fixtures/moved-files.tsx');mountMovedFiles(await window.electronAPI.loadPreferences(),snapshot);
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])];
    })()`);
    for (const mode of ['Changes', 'Commits', 'Combined']) {
      await click(mode);
      await wait("document.querySelector('.changes-file-stats')?.textContent==='Moved · contents unchanged'");
      assert.equal(
        await js("document.querySelectorAll('.commit-stream-file diffs-container').length"),
        0,
        'Pure moves do not mount an empty diff'
      );
      if (mode !== 'Commits')
        assert.ok(
          await js("document.querySelector('.changes-other-threads')?.textContent.includes('Please keep')"),
          'Comments remain accessible while code is collapsed'
        );
      if (mode === 'Changes') {
        await capture('desktop-light');
        await js("document.documentElement.classList.add('dark')");
        await capture('desktop-dark');
        await js("document.documentElement.classList.remove('dark')");
        window.webContents.debugger.attach('1.3');
        await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 640,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await capture('narrow');
        assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
        await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }
      await click('Show file');
      await wait("window.deepAll('[data-line]').length>=2");
      if (mode === 'Changes') {
        await js("window.deepAll('[data-column-number]').find(e=>e.getAttribute('data-column-number')==='1').click()");
        await wait("window.deepAll('.changes-comment-composer').length>0");
        await js("window.deepAll('.changes-comment-composer button').find(b=>b.textContent.trim()==='Cancel').click()");
      }
    }
    await click('src/edited.ts');
    await wait("window.deepAll('[data-line]').length>=2");
    assert.equal(await js("document.querySelector('.changes-file-stats')?.textContent.includes('unchanged')"), false);
    await click('art/changed.svg');
    await wait("!!document.querySelector('.review-image-diff')");
    assert.equal(
      await js("document.querySelector('.changes-file-stats')?.textContent.includes('unchanged')"),
      false,
      'Zero-line image edits must not be hidden'
    );
    await click('docs/moved.md');
    await wait("document.querySelector('.changes-file-stats')?.textContent==='Moved · contents unchanged'");
    assert.equal(
      await js("!!document.querySelector('.markdown-preview-status')"),
      false,
      'Collapsed Markdown moves do not show preview preparation'
    );
    await js(`{
      window.electronAPI.renderMarkdownReview = async () => {
        const tree = {type:'root',children:[{type:'element',tagName:'p',properties:{},children:[{type:'text',value:'Unchanged document'}]}]};
        return {blocks:[{id:'one',change:'unchanged',tree,before:{side:'before',start:1,end:2},after:{side:'after',start:1,end:2}}],clean:tree,deleted:false,sourceOnly:false};
      };
    }; undefined`);
    const assertSingleDiscussion = async () => {
      assert.equal(
        await js(
          "document.querySelector('.commit-stream-file').textContent.split('Please keep this public import path compatible.').length-1"
        ),
        1,
        'Unchanged Markdown moves show each discussion once'
      );
      assert.ok(await js("document.querySelector('.changes-other-threads')?.textContent.includes('Please keep')"));
    };
    for (const mode of ['Changes', 'Combined']) {
      await click(mode);
      await wait("document.querySelector('.changes-file-stats')?.textContent==='Moved · contents unchanged'");
      await assertSingleDiscussion();
      await click('Show file');
      await wait("!!document.querySelector('.markdown-review')");
      await assertSingleDiscussion();
      await click('Source');
      await wait("!document.querySelector('.markdown-review') && window.deepAll('[data-line]').length>=2");
      await assertSingleDiscussion();
      await click('Preview');
      await wait("!!document.querySelector('.markdown-review')");
      await assertSingleDiscussion();
    }
    await click('src/moved.ts');
    await wait("[...document.querySelectorAll('main button')].some(b=>b.textContent.trim()==='Show file')");
    await click('Jump to line');
    await wait("window.deepAll('[data-line]').length>=2");
    await click('Viewed & next');
    await wait("document.querySelector('.commit-stream-file-body')?.hidden===true");
    assert.ok(await js("document.body.textContent.includes('Next file requested')"));
    console.log('Moved file browser checks passed');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    window.destroy();
    app.exit(1);
  }
});
