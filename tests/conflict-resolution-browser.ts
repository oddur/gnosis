import { parsePatchFiles } from '@pierre/diffs';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (event) => {
    if (event.message.includes('Error')) console.error(event.message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let n = 0; n < 400; n++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const click = async (label: string) => {
    await wait(
      `[...document.querySelectorAll('button')].some(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
    );
    await js(
      `[...document.querySelectorAll('button')].find(b=>b.checkVisibility()&&b.textContent.trim()===${JSON.stringify(label)}).click()`
    );
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    const dir = path.resolve('.impeccable/review/conflict-resolution');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("document.querySelectorAll('.queue-item').length===7");
    const patch =
      'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const delay = 5000;\n+export const delay = 3000;\n';
    await js(`window.conflictPreview=${JSON.stringify(parsePatchFiles(patch).flatMap((p) => p.files))}`);
    await js(`(()=>{
      const original='export function retryDelay(attempt: number) {\\n<<<<<<< feature/retry\\n  return Math.min(attempt * 200, 5000);\\n||||||| ancestor\\n  return attempt * 200;\\n=======\\n  return Math.max(100, attempt * 200);\\n>>>>>>> main\\n}\\n';
      window.conflictFixture={id:'a'.repeat(64),account:'oddur',url:'https://github.com/klang/engine/pull/120',title:'Bound retry delays',headRepo:'klang/engine',baseRepo:'klang/engine',headBranch:'feature/retry',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),tree:'c'.repeat(40),version:1,status:'editing',files:[{path:'src/retry.ts',mode:'100644',base:'export const delay = 200;\\n',ours:'export const delay = 5000;\\n',theirs:'export const delay = 100;\\n',original,result:original,resolved:false,source:'manual'}]};
      window.conflictCalls=[];
      window.electronAPI.conflictResolution=async req=>{
        window.conflictCalls.push(req);const s=window.conflictFixture;
        if(req.kind==='open')return {session:structuredClone(s)};
        if(req.kind==='save'){s.files[0].result=req.contents;s.files[0].resolved=req.resolved;}
        if(req.kind==='resolve'){s.files[0].result='export function retryDelay(attempt: number) {\\n  return Math.min(5000, Math.max(100, attempt * 200));\\n}\\n';s.files[0].explanation='Preserved the minimum delay from main and the cap from this PR. Tests have not been run.';s.files[0].resolved=false;s.files[0].source=req.engine;}
        if(req.kind==='preview')return {session:structuredClone(s),preview:{token:'reviewed',patch:'',validation:'',files:window.conflictPreview}};
        if(req.kind==='publish'){s.status='published';s.commitSha='d'.repeat(40);}
        s.version++;return {session:structuredClone(s)};
      };
    })()`);
    await js(`(async()=>{
      const stack=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>value.url.endsWith('/120')?{...value,readiness:{...value.readiness,mergeable:'CONFLICTING',mergeState:'DIRTY'}}:value);
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
      publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(stack.subject.members.map(({url,headSha})=>({url,headSha}))));
    })()`);
    await js(
      "document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await click('Resolve conflicts…');
    await wait("document.querySelector('.conflict-choice-actions button')");
    assert.equal(await js('window.conflictCalls[0].url'), 'https://github.com/klang/engine/pull/120');
    await capture('light');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    await click('Keep feature/retry');
    await click('Mark reviewed');
    assert.equal(await js('window.conflictFixture.files[0].resolved'), true);
    await click('Ask agent');
    await wait("document.querySelector('.conflict-agent-context').textContent.includes('Preserved the minimum')");
    assert.equal(
      await js('window.conflictFixture.files[0].resolved'),
      false,
      'Agent cannot mark its own proposal reviewed'
    );
    await click('Edit result');
    await wait("document.querySelector('.conflict-editor diffs-container')");
    await wait(
      `document.querySelector('.conflict-editor diffs-container')?.shadowRoot?.querySelector('[contenteditable=true]')`
    );
    await js(
      `document.querySelector('.conflict-editor diffs-container').shadowRoot.querySelector('[contenteditable=true]').focus()`
    );
    const point = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('.conflict-editor diffs-container').shadowRoot.querySelector('[contenteditable=true]').getBoundingClientRect();return {x:r.x+50,y:r.y+10}})()`
    );
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    });
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '// Manual review note\n' });
    await wait(`document.querySelector('.conflict-file-pane > header').textContent.includes('Unsaved changes')`);
    await click('Save draft');
    assert.match(await js<string>('window.conflictFixture.files[0].result'), /Manual review note/);
    await capture('editor');
    await click('Compare with PR');
    await capture('proposal');
    await click('Mark reviewed');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
    await wait(
      "document.querySelector('.conflict-footer') && ![...document.querySelectorAll('button')].find(b=>b.textContent==='Review resolution…')?.disabled"
    );
    await click('Review resolution…');
    await wait("document.querySelector('.conflict-publish')");
    await wait("document.querySelector('.conflict-preview diffs-container')");
    await capture('preview');
    assert.equal(await js("window.conflictCalls.filter(r=>r.kind==='publish').length"), 0, 'Preview never publishes');
    await click('Commit resolution & update PR');
    await wait("document.querySelector('.conflict-empty').textContent.includes('PR branch updated')");
    assert.equal(await js("window.conflictCalls.filter(r=>r.kind==='publish').length"), 1);
    await capture('published');
    await click('Close');
    await js(
      "window.conflictFixture.status='editing';window.conflictFixture.stale=true;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}));"
    );
    await wait("document.querySelector('.conflict-notice')?.textContent.includes('base branch changed')");
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Review resolution…').disabled")
    );
    win.setSize(760, 800);
    await capture('narrow');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await click('Close');
    await js(
      "window.conflictFixture.files=[];window.conflictFixture.stale=false;window.conflictFixture.preparation='clean-merge';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait(
      "document.querySelector('.conflict-empty')?.textContent.includes('Git can merge these branches cleanly')"
    );
    assert.ok(
      await js("document.querySelector('.conflict-empty').textContent.includes('Nothing has been committed or pushed')")
    );
    assert.equal(await js("document.querySelector('.conflict-workspace').textContent.includes('0/0')"), false);
    await capture('clean-merge');
    await click('Review branch update…');
    await wait("document.querySelector('.conflict-publish')");
    await click('Close');
    await js(
      "window.conflictFixture.preparation='up-to-date';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-empty')?.textContent.includes('PR branch is already up to date')");
    assert.equal(await js("!!document.querySelector('.conflict-publish,.conflict-footer')"), false);
    await capture('up-to-date');
    await click('Close');
    await js(
      "window.conflictFixture.preparation='clean-merge';window.conflictFixture.stale=true;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-notice')?.textContent.includes('base branch changed')");
    await capture('empty-stale');
    await click('Check latest branches');
    assert.equal(await js('window.conflictCalls.at(-1).restart'), true);

    console.log(
      'Conflict workspace passed: Pierre choices, editable result, saved draft, explicit preview/publication, stale guard, themes and narrow layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    app.exit(1);
  }
});
