import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { parsePatchFiles } from '@pierre/diffs';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
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
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
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
        if(req.kind==='save'){const f=s.files.find(f=>f.path===req.path);f.result=req.contents;f.resolved=req.resolved;}
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
    // A physical pointer click must dismiss the notification, not the conflict workspace.
    await js(
      `(async()=>{const {toast}=await import('/components/ui/toast.tsx');toast.add({title:'Conflict notification regression',description:'A background result is ready.',timeout:0});})()`
    );
    await wait('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\')');
    assert.ok(await js("document.querySelector('.conflict-workspace').contains(document.querySelector('.app-toast'))"));
    assert.ok(
      await js(
        "document.querySelector('.app-toast').getBoundingClientRect().bottom < document.querySelector('.conflict-footer').getBoundingClientRect().top"
      ),
      'Notification has reserved space above the controls'
    );
    await capture('notification');
    await js("document.querySelector('.activity-trigger').click()");
    await wait("document.querySelector('.activity-drawer')");
    assert.equal(await js("getComputedStyle(document.querySelector('.app-toasts')).top"), '0px');
    assert.equal(await js("getComputedStyle(document.querySelector('.app-toasts')).maxHeight"), '120px');
    await capture('notification-activity');
    await js('document.querySelector(\'[aria-label="Close activity"]\').click()');

    win.setSize(760, 800);
    await capture('notification-narrow');
    assert.ok(
      await js(
        "document.querySelector('.app-toast').getBoundingClientRect().bottom <= document.querySelector('.conflict-body').getBoundingClientRect().top"
      )
    );
    win.setSize(1280, 900);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await js('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\').focus()');
    assert.ok(
      await js("document.activeElement?.getAttribute('aria-label')==='Dismiss notification'"),
      'The modal permits keyboard focus on notifications'
    );

    const toastPoint = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('.app-toast [aria-label="Dismiss notification"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...toastPoint,
      button: 'left',
      clickCount: 1,
    });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...toastPoint,
      button: 'left',
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(
      await js("!!document.querySelector('.conflict-workspace')"),
      'Dismissing a notification must not close Resolve conflicts'
    );
    await wait("!document.querySelector('.app-toast')");
    // Moving back to the global viewport keeps pending notifications and their actions.
    await js(
      `(async()=>{const {toast}=await import('/components/ui/toast.tsx');toast.add({title:'Background result',timeout:0});})()`
    );
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace') && document.querySelector('.app-toast')");
    assert.equal(await js("!!document.querySelector('.app-toast-host .app-toast')"), false);
    await js('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\').click()');
    await wait("!document.querySelector('.app-toast')");
    await js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
    await wait("document.querySelector('.conflict-choice-actions button')");
    await capture('light');
    await click('How to resolve');
    await wait("document.querySelector('#conflict-help')?.textContent.includes('Neither runs project tests')");
    await capture('guide');
    await click('Hide guide');
    assert.equal(await js("!!document.querySelector('#conflict-help')"), false);
    await click('How to resolve');
    await click('Hide guide');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    await wait("document.querySelector('.conflict-file-pane > header [data-stage]')?.dataset.stage==='conflicted'");
    await click('Use PR version');
    await wait("document.querySelector('.conflict-file-pane > header [data-stage]')?.dataset.stage==='resolved'");
    assert.ok(
      await js("document.querySelector('.conflict-progress [data-stage=resolved]').textContent.includes('1 Resolved')")
    );
    await capture('file-resolved');
    await click('Mark as reviewed');
    await wait("document.querySelector('.conflict-file-pane > header [data-stage]')?.dataset.stage==='reviewed'");
    await capture('file-reviewed');
    assert.equal(await js('window.conflictFixture.files[0].resolved'), true);
    await click('Reset file');
    await wait("document.querySelector('.conflict-files [data-stage]')?.dataset.stage==='conflicted'");
    assert.ok(
      await js("document.querySelector('.conflict-progress [data-stage=reviewed]').textContent.trim()==='0 Reviewed'")
    );
    assert.ok(await js("!document.querySelector('.conflict-footer').textContent.includes('All files reviewed')"));
    await capture('edited-reviewed');
    await click('Ask agent');
    await wait("document.querySelector('.conflict-agent-context').textContent.includes('Preserved the minimum')");
    assert.equal(
      await js('window.conflictFixture.files[0].resolved'),
      false,
      'Agent cannot mark its own proposal reviewed'
    );
    assert.ok(
      await js(
        "document.querySelector('.conflict-notice[role=status]').textContent.includes('1 resolved, 0 conflicted')"
      )
    );
    assert.ok(
      await js(
        "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Compare with PR').getAttribute('aria-pressed')==='true'"
      )
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
    // Let the native caret change reach Pierre's selection listener before typing.
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '// Manual review note\n' });
    await wait(`document.querySelector('.conflict-file-pane > header').textContent.includes('Unsaved changes')`);
    assert.equal(
      await js("document.querySelector('.conflict-file-pane > header [data-stage]').dataset.stage"),
      'resolved'
    );
    await click('Save draft');
    assert.match(await js<string>('window.conflictFixture.files[0].result'), /Manual review note/);
    await capture('editor');
    await click('Compare with PR');
    await capture('proposal');
    await click('Mark as reviewed');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
    await wait(
      "document.querySelector('.conflict-footer') && ![...document.querySelectorAll('button')].find(b=>b.textContent==='Review branch update…')?.disabled"
    );
    await click('Review branch update…');
    await wait("document.querySelector('.conflict-publish')");
    await wait("document.querySelector('.conflict-preview diffs-container')");
    await capture('preview');
    assert.equal(await js("window.conflictCalls.filter(r=>r.kind==='publish').length"), 0, 'Preview never publishes');
    await click('Commit & push to PR branch');
    await wait("document.querySelector('.conflict-published').textContent.includes('PR branch updated')");
    assert.equal(await js("window.conflictCalls.filter(r=>r.kind==='publish').length"), 1);
    await capture('published');
    // Restacking is a separate, explicit preview-and-push flow after the root resolution.
    await js(`(()=>{
      window.conflictFixture.dependents=['https://github.com/klang/engine/pull/121','https://github.com/klang/engine/pull/122'];
      const original=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        const s=window.conflictFixture;
        if(req.kind==='restack-prepare'){
          window.conflictCalls.push(req);s.restack={token:'e'.repeat(64),status:'prepared',rootSha:s.commitSha,expected:[],branches:[121,122].map((n,i)=>({url:'https://github.com/klang/engine/pull/'+n,title:i?'Make retry metrics observable':'Apply bounded retry delays',repo:'klang/engine',branch:'feature/retry-'+n,baseBranch:i?'feature/retry-121':'feature/retry',baseRepo:'klang/engine',baseSha:'b'.repeat(40),oldSha:'a'.repeat(40),newSha:'f'.repeat(40),commits:2,reused:i?0:1,patch:'',files:window.conflictPreview}))};s.version++;return {session:structuredClone(s)};
        }
        if(req.kind==='restack-save'){window.conflictCalls.push(req);const f=s.restack.blocked.files.find(f=>f.path===req.path);f.result=req.contents;f.resolved=req.resolved;s.version++;return {session:structuredClone(s)};}
        if(req.kind==='restack-continue'){window.conflictCalls.push(req);s.restack.status='prepared';s.restack.blocked=undefined;s.version++;return {session:structuredClone(s)};}
        if(req.kind==='restack-publish'){window.conflictCalls.push(req);s.restack.status='published';s.version++;return {session:structuredClone(s)};}
        return original(req);
      };
    })()`);
    await click('Close');
    await js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
    await click('Prepare restack · 2 PRs');
    await wait("document.querySelectorAll('.restack-reviewed input').length===2");
    assert.equal(await js("window.conflictCalls.filter(r=>r.kind==='restack-publish').length"), 0);
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Push 2 PR updates').disabled")
    );
    await capture('restack-desktop');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(1000, 800);
    await capture('restack-laptop');
    await js("document.querySelectorAll('.restack-reviewed input').forEach(input=>input.click())");
    await click('Push 2 PR updates');
    await wait("document.querySelector('.restack-review h2').textContent==='Dependent PRs updated'");
    assert.deepEqual(await js("window.conflictCalls.find(r=>r.kind==='restack-publish').reviewed"), [
      'https://github.com/klang/engine/pull/121',
      'https://github.com/klang/engine/pull/122',
    ]);
    await capture('restack-published');
    await click('Close');
    await js(`(()=>{
      const s=window.conflictFixture;s.restack.status='blocked';s.restack.blocked={url:s.dependents[0],title:'Apply bounded retry delays',reason:'The restack is paused on a new conflict. Edit and review each result below, then continue. No dependent branches have been pushed.',paths:['src/retry.ts'],reused:0,files:[{...s.files[0],result:s.files[0].original,resolved:false}]};
      window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:s.url}));
    })()`);
    await wait("document.querySelector('.restack-conflict-file textarea')");
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Continue restack').disabled")
    );
    await capture('restack-paused');
    await js(
      `(()=>{const input=document.querySelector('.restack-conflict-file textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify('export const delay = 2500;\n')});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    // Closing must save an unreviewed paused draft; it must not lose it or publish.
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    assert.equal(await js('window.conflictFixture.restack.blocked.files[0].result'), 'export const delay = 2500;\n');
    assert.equal(await js('window.conflictFixture.restack.blocked.files[0].resolved'), false);
    await js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
    await click('Save & mark reviewed');
    await click('Continue restack');
    await wait("!document.querySelector('.restack-blocked')");

    await click('Close');
    await js(
      "window.conflictFixture.status='editing';window.conflictFixture.stale=true;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}));"
    );
    await wait("document.querySelector('.conflict-notice')?.textContent.includes('base branch changed')");
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Review branch update…').disabled")
    );
    win.setSize(760, 800);
    await capture('narrow');
    const codeHeight = () => js<number>("document.querySelector('.conflict-editor').getBoundingClientRect().height");
    assert.ok((await codeHeight()) >= 200, 'Code remains usable beside expanded proposal notes');
    await click('How to resolve');
    await capture('narrow-guide');
    assert.ok((await codeHeight()) >= 200, 'Help must not collapse the editor');
    assert.ok(
      await js(
        "document.querySelector('.conflict-workspace').scrollHeight <= document.querySelector('.conflict-workspace').clientHeight + 400"
      ),
      'Supporting content stays reachable'
    );
    await click('Hide guide');
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

    await click('Close');
    // Exercise lazy JSON/JavaScript grammars and the long script lines seen in real conflicts.
    const command = Array.from({ length: 180 }, (_, i) => `node scripts/check-${i}.mjs`).join(' && ');
    const files = ['package.json', 'scripts/test-workbench.mjs'].map((name) => {
      const wrap = (text: string) =>
        name.endsWith('.json')
          ? `{\n  "scripts": {\n    "test": "${text}"\n  }\n}\n`
          : `export const command = ${JSON.stringify(text)};\n`;
      const base = wrap(command),
        ours = wrap(command + ' --pr'),
        theirs = wrap(command + ' --main');
      const original = `<<<<<<< ${'a'.repeat(40)}\n${ours}||||||| ${'b'.repeat(40)}\n${base}=======\n${theirs}>>>>>>> ${'c'.repeat(40)}\n`;
      return {
        path: name,
        mode: '100644',
        base,
        ours,
        theirs,
        original,
        result: original,
        resolved: false,
        source: 'manual',
      };
    });
    await js(
      `window.conflictFixture.files=${JSON.stringify(files)};window.conflictFixture.stale=false;window.conflictFixture.preparation='conflicts';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))`
    );
    await wait("document.querySelectorAll('.conflict-files button').length===2");
    for (const file of files) {
      await js(`document.querySelectorAll('.conflict-files button')[${files.indexOf(file)}].click()`);
      await wait(
        `document.querySelector('.conflict-file-pane > header strong')?.textContent===${JSON.stringify(file.path)}`
      );
      await wait(
        "document.querySelector('.conflict-choice-actions button') && document.querySelector('.conflict-code diffs-container')?.shadowRoot?.querySelector('[data-line]')"
      );
    }
    await capture('long-script-conflict');
    // Reviewing one file advances without publishing; each file keeps its own saved content.
    await click('Use PR version');
    await click('Mark reviewed & next');
    await wait("document.querySelector('.conflict-file-pane > header strong').textContent==='package.json'");
    assert.equal(await js('window.conflictFixture.files[1].resolved'), true);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    await click('Use base version');
    await click('Mark as reviewed');
    assert.equal(await js('window.conflictFixture.files.every(f=>f.resolved)'), true);
    assert.equal(
      await js("window.conflictCalls.filter(r=>r.kind==='publish').length"),
      1,
      'File review never publishes'
    );
    await capture('files-reviewed');
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
