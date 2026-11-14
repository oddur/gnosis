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
    throw Error(
      `Timed out: ${code}\nFocus: ${await js<string>('document.activeElement?.outerHTML.slice(0,300)')}\n${await js<string>('document.body.innerText')}`
    );
  };
  // Button names without their keyboard hints.
  const visibleButton = (label: string) =>
    `[...document.querySelectorAll('button,a[data-slot=button]')].find(b=>{if(!b.checkVisibility())return false;const c=b.cloneNode(true);c.querySelectorAll('kbd').forEach(k=>k.remove());return c.textContent.trim()===${JSON.stringify(label)};})`;
  const click = async (label: string) => {
    await wait(`(${visibleButton(label)}) && !(${visibleButton(label)}).disabled`);
    await js(`(${visibleButton(label)}).click()`);
  };
  const exists = (label: string) => js<boolean>(`!!(${visibleButton(label)})`);
  const key = async (value: string) => {
    const named: Record<string, [string, number]> = { Enter: ['Enter', 13], Escape: ['Escape', 27] };
    const [code, vk] = named[value] ?? [
      /\d/.test(value) ? `Digit${value}` : `Key${value.toUpperCase()}`,
      value.toUpperCase().charCodeAt(0),
    ];
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: value,
      code,
      windowsVirtualKeyCode: vk,
      ...(value === 'Enter' ? { text: '\r' } : value.length === 1 ? { text: value } : {}),
    });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code,
      windowsVirtualKeyCode: vk,
    });
    await new Promise((r) => setTimeout(r, 150));
  };
  const publishes = () => js<number>("window.conflictCalls.filter(r=>r.kind==='publish').length");
  const calls = (kind: string) => js<number>(`window.conflictCalls.filter(r=>r.kind===${JSON.stringify(kind)}).length`);
  const dir = path.resolve('.impeccable/review/conflict-resolution');
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const resize = async (width: number, height: number) => {
    win.setSize(width, height);
    await new Promise((r) => setTimeout(r, 300));
  };
  /** Light, dark and narrow captures of one state. The window returns to its size and theme. */
  const captureAll = async (name: string) => {
    const [width, height] = win.getSize();
    const dark = await js<boolean>("document.documentElement.classList.contains('dark')");
    const focused = await js<boolean>('(window.__focus=document.activeElement, true)');
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-light`);
    await js("document.documentElement.classList.add('dark')");
    await capture(`${name}-dark`);
    await resize(760, 800);
    await capture(`${name}-narrow-dark`);
    await js("document.documentElement.classList.remove('dark')");
    await capture(`${name}-narrow-light`);
    if (dark) await js("document.documentElement.classList.add('dark')");
    await resize(width, height);
    if (focused) await js('window.__focus?.focus?.({preventScroll:true})');
  };
  /** Every visible footer button sits inside the footer, the footer inside the dialog, and code above it. */
  const footerFits = () =>
    js<boolean>(`(()=>{
      const footer=document.querySelector('.conflict-footer');if(!footer)return false;
      const f=footer.getBoundingClientRect();const d=document.querySelector('.conflict-workspace').getBoundingClientRect();
      const scroll=document.querySelector('.conflict-scroll')?.getBoundingClientRect();
      const buttons=[...footer.querySelectorAll('button')].filter(b=>b.checkVisibility());
      return buttons.length>0&&f.bottom<=d.bottom+0.5&&f.top>=d.top&&(!scroll||scroll.bottom<=f.top+0.5)&&
        buttons.every(b=>{const r=b.getBoundingClientRect();return r.top>=f.top-0.5&&r.bottom<=f.bottom+0.5&&r.left>=d.left-0.5&&r.right<=d.right+0.5;});
    })()`);
  const stage = () => js<string>("document.querySelector('.conflict-file-title [data-stage]')?.dataset.stage");
  const primary = () => js<string>("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary");
  const block = (index: number) => `document.querySelector('.conflict-block[data-conflict-index="${index}"]')`;
  const activeBlock = () =>
    js<string | null>("document.activeElement?.closest('.conflict-block')?.dataset.conflictIndex ?? null");
  const open = () =>
    js("window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))");
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
    await js("localStorage.removeItem('gnosis-conflict-guide')");
    const patch =
      'diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const delay = 5000;\n+export const delay = 3000;\n' +
      'diff --git a/src/clock.ts b/src/clock.ts\n--- a/src/clock.ts\n+++ b/src/clock.ts\n@@ -1 +1 @@\n-export const tick = 10;\n+export const tick = 20;\n';
    await js(`window.conflictPreview=${JSON.stringify(parsePatchFiles(patch).flatMap((p) => p.files))}`);
    await js(`(()=>{
      const original='export function retryDelay(attempt: number) {\\n<<<<<<< feature/retry\\n  return Math.min(attempt * 200, 5000);\\n||||||| ancestor\\n  return attempt * 200;\\n=======\\n  return Math.max(100, attempt * 200);\\n>>>>>>> main\\n}\\n<<<<<<< feature/retry\\nexport const retries = 5;\\n=======\\nexport const retries = 3;\\n>>>>>>> main\\n';
      window.conflictFixture={id:'a'.repeat(64),account:'oddur',url:'https://github.com/klang/engine/pull/120',title:'Bound retry delays',headRepo:'klang/engine',baseRepo:'klang/engine',headBranch:'feature/retry',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),tree:'c'.repeat(40),version:1,status:'editing',files:[{path:'src/retry.ts',mode:'100644',base:'export function retryDelay(attempt: number) {\\n  return attempt * 200;\\n}\\nexport const retries = 4;\\n',ours:'export function retryDelay(attempt: number) {\\n  return Math.min(attempt * 200, 5000);\\n}\\nexport const retries = 5;\\n',theirs:'export function retryDelay(attempt: number) {\\n  return Math.max(100, attempt * 200);\\n}\\nexport const retries = 3;\\n',original,result:original,resolved:false,source:'manual'}]};
      window.conflictCalls=[];
      window.electronAPI.conflictResolution=async req=>{
        window.conflictCalls.push(req);const s=window.conflictFixture;
        if(req.kind==='open'){if(window.failOpen)throw Error(window.failOpen);if(window.slowOpen)await new Promise(r=>setTimeout(r,window.slowOpen));return {session:structuredClone(s)};}
        if(req.version!==s.version)throw Error('The saved resolution changed. Reopen the workspace before continuing.');
        if(req.kind==='save'){const f=s.files.find(f=>f.path===req.path);if(f.result!==req.contents){f.source='manual';f.explanation=undefined;}f.result=req.contents;f.resolved=req.resolved;}
        if(req.kind==='resolve'){s.files[0].result='export function retryDelay(attempt: number) {\\n  return Math.min(5000, Math.max(100, attempt * 200));\\n}\\nexport const retries = 5;\\n';s.files[0].explanation='Preserved the minimum delay from main and the cap from this PR. Tests have not been run.';s.files[0].resolved=false;s.files[0].source=req.engine;}
        if(req.kind==='preview')return {session:structuredClone(s),preview:{token:'reviewed',patch:'',validation:'',files:window.conflictPreview}};
        if(req.kind==='publish'){if(window.failPublish)throw Error("Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. To github.com:klang/engine.git\\n ! [rejected]        feature/retry (stale info)\\nerror: failed to push some refs");s.status='published';s.commitSha='d'.repeat(40);}
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
    await wait("document.querySelector('.conflict-block[data-state=open]')");
    assert.equal(await js('window.conflictCalls[0].url'), 'https://github.com/klang/engine/pull/120');

    // P0: the conflict view speaks Gnosis. Versions are labelled; Git's markers and words never show.
    await wait("document.activeElement?.closest('.conflict-block')");
    assert.equal(await activeBlock(), '0', 'Opening focuses the first unresolved conflict, not Close');
    assert.deepEqual(await js(`[...${block(0)}.querySelectorAll('.conflict-side-label')].map(e=>e.textContent)`), [
      'This PR · feature/retry',
      'main',
    ]);
    assert.equal(
      await js(`${block(0)}.querySelector('.conflict-ancestor summary').textContent`),
      'Before both changes'
    );
    assert.equal(
      await js(`${block(0)}.querySelector('.conflict-ancestor').open`),
      false,
      'The ancestor starts collapsed'
    );
    assert.equal(
      await js(`!!${block(1)}.querySelector('.conflict-ancestor')`),
      false,
      'A two-way conflict has no ancestor'
    );
    assert.doesNotMatch(
      await js<string>("document.querySelector('.conflict-view').innerText"),
      /<{7}|>{7}|={7}|\|{7}|Current Change|Incoming Change/
    );
    assert.deepEqual(
      await js(`[...${block(0)}.querySelectorAll('.conflict-block-actions button')].map(b=>b.firstChild.textContent)`),
      ['Keep PR change', 'Keep main’s change', 'Keep both']
    );
    assert.equal(await exists('Save draft'), false, 'Drafts save automatically');
    assert.ok(await js("document.querySelector('#conflict-help')"), 'The guide is open on first use');

    // A physical pointer click must dismiss the notification, not the conflict workspace.
    await js(
      `(async()=>{const {toast}=await import('/components/ui/toast.tsx');toast.add({title:'Conflict notification regression',description:'A background result is ready.',timeout:0});})()`
    );
    await wait('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\')');
    assert.ok(await js("document.querySelector('.conflict-workspace').contains(document.querySelector('.app-toast'))"));
    // In the modal host too, a toast is a grouped notification, never a second dialog.
    assert.equal(await js("document.querySelector('.app-toast').getAttribute('role')"), 'group');
    assert.ok(
      await js(
        "document.querySelector('.app-toast').getBoundingClientRect().bottom < document.querySelector('.conflict-footer').getBoundingClientRect().top"
      ),
      'Notification has reserved space above the controls'
    );
    await capture('notification');
    await js(
      "(document.querySelector('.activity-trigger')?.click() ?? window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',shiftKey:true,metaKey:window.electronAPI.platform==='darwin',ctrlKey:window.electronAPI.platform!=='darwin'})))"
    );
    await wait("document.querySelector('.activity-drawer')");
    assert.equal(await js("getComputedStyle(document.querySelector('.app-toasts')).top"), '0px');
    assert.equal(await js("getComputedStyle(document.querySelector('.app-toasts')).maxHeight"), '120px');
    await capture('notification-activity');
    await js('document.querySelector(\'[aria-label="Close activity"]\').click()');

    await resize(760, 800);
    await capture('notification-narrow');
    assert.ok(
      await js(
        "document.querySelector('.app-toast').getBoundingClientRect().bottom <= document.querySelector('.conflict-body').getBoundingClientRect().top"
      )
    );
    assert.ok(await footerFits(), 'The footer stays visible with a notification and the guide open');
    await resize(1280, 900);
    await js('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\').focus()');
    assert.ok(
      await js("document.activeElement?.getAttribute('aria-label')==='Dismiss notification'"),
      'The modal permits keyboard focus on notifications'
    );
    const toastPoint = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('.app-toast [aria-label="Dismiss notification"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
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

    // After first use the guide stays collapsed, and it can be reopened.
    await open();
    await wait("document.activeElement?.closest('.conflict-block')");
    assert.equal(
      await js("!!document.querySelector('#conflict-help')"),
      false,
      'The guide is collapsed after first use'
    );
    await captureAll('conflicts');
    await click('Guide');
    await wait(
      "document.querySelector('#conflict-help')?.textContent.includes('Suggestions never mark files reviewed')"
    );
    await captureAll('guide');
    await resize(760, 800);
    assert.ok(await footerFits(), 'The guide never pushes the footer out of view');
    await resize(1280, 900);
    await click('Hide guide');
    assert.equal(await js("!!document.querySelector('#conflict-help')"), false);

    // One plan, no counter pill: resolve (which includes review), then one confirmation.
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.conflict-workflow .step-list li')].map(li=>li.dataset.step+':'+li.dataset.status)"
      ),
      ['resolve:current', 'push:upcoming']
    );
    assert.equal(await js("!!document.querySelector('.conflict-workspace .step-card-count')"), false);
    assert.equal(
      await js("document.querySelector('.conflict-workspace').textContent.includes('Nothing pushed')"),
      false
    );

    // Keyboard: J/K move between conflicts, 1/2/3 keep a side, and each choice leaves a note with Undo.
    await js(`${block(0)}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '1');
    await key('k');
    assert.equal(await activeBlock(), '0');
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Kept PR change·Undo/);
    assert.equal(await activeBlock(), '1', 'A choice moves focus to the next open conflict');
    await key('2');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    assert.equal(await stage(), 'resolved');
    assert.equal(
      await js("document.querySelector('.conflict-file-title [data-stage]').textContent"),
      'Resolved · needs review'
    );
    await wait("document.activeElement?.dataset.conflictPrimary==='review-result'");
    // Undo one block; the other keeps its choice.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await js(`${block(1)}.dataset.state`), 'kept');
    assert.equal(await stage(), 'conflicted');
    assert.equal(await activeBlock(), '0', 'Undo returns focus to the reopened conflict');
    await key('3');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Kept both changes/);
    // Autosave stores the draft without marking the file reviewed.
    await wait(
      "window.conflictFixture.files[0].result.includes('Math.max') && window.conflictFixture.files[0].result.includes('retries = 3')"
    );
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    assert.equal(
      await js("document.querySelector('.conflict-workspace').textContent.includes('Unsaved changes')"),
      false
    );
    await captureAll('file-resolved');

    // Review before mark: Mark reviewed appears only after the result is shown next to the PR.
    assert.equal(await primary(), 'review-result');
    assert.equal(await exists('Mark reviewed'), false);
    await key('m');
    await wait("document.querySelector('.conflict-result-diff')");
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false, 'M first shows the result');
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.conflict-result-diff .conflict-diff-columns > span')].map(s=>s.lastChild.textContent)"
      ),
      ['This PR · feature/retry', 'Result after the merge']
    );
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    await captureAll('review-result');

    // One suggestion menu: a structural merge, Ask the model with instructions, and all files.
    await click('Suggest a resolution');
    await wait("document.querySelector('.conflict-suggest-menu')");
    const items = await js<string[]>(
      "[...document.querySelectorAll('.conflict-suggest-item strong')].map(s=>s.textContent)"
    );
    assert.equal(items[0], 'Structural merge');
    assert.match(items[1], /^Ask .+…$/);
    assert.equal(items.length, 2, 'A single file has no all-files option');
    await capture('suggest-menu');
    await js("document.querySelectorAll('.conflict-suggest-item')[1].click()");
    await wait("document.querySelector('.conflict-suggest-form textarea')");
    await js(
      `(()=>{const input=document.querySelector('.conflict-suggest-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep the minimum delay.');input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await capture('suggest-ask');
    await js("[...document.querySelectorAll('.conflict-suggest-form button')].at(-1).click()");
    await wait("document.querySelector('.conflict-proposal')?.textContent.includes('Preserved the minimum')");
    assert.equal(await js("window.conflictCalls.find(r=>r.kind==='resolve').instructions"), 'Keep the minimum delay.');
    assert.equal(await js("window.conflictCalls.find(r=>r.kind==='resolve').path"), 'src/retry.ts');
    assert.equal(
      await js('window.conflictFixture.files[0].resolved'),
      false,
      'Agent cannot mark its own proposal reviewed'
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /suggested a result/
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('.conflict-modes button')].find(b=>b.textContent==='Review result').getAttribute('aria-pressed')"
      ),
      'true'
    );
    await capture('proposal');

    // Manual edits save automatically and need a new review.
    await click('Edit result');
    await wait(
      "document.querySelector('.conflict-scroll diffs-container')?.shadowRoot?.querySelector('[contenteditable=true]')"
    );
    await js(
      "document.querySelector('.conflict-scroll diffs-container').shadowRoot.querySelector('[contenteditable=true]').focus()"
    );
    const point = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('.conflict-scroll diffs-container').shadowRoot.querySelector('[contenteditable=true]').getBoundingClientRect();return {x:r.x+50,y:r.y+10}})()`
    );
    for (const type of ['mousePressed', 'mouseReleased'])
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1,
      });
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    for (const type of ['keyDown', 'keyUp'])
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key: 'Home',
        code: 'Home',
        windowsVirtualKeyCode: 36,
      });
    // Let the native caret change reach Pierre's selection listener before typing.
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '// Manual review note\n' });
    await wait('/Manual review note/.test(window.conflictFixture.files[0].result)');
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    assert.equal(await stage(), 'resolved');
    assert.equal(await primary(), 'review-result', 'A changed result needs to be shown again');
    await captureAll('editor');
    await click('Review result');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");

    // Marking the last file reviewed goes straight to the confirmation, which shows the final update.
    await click('Mark reviewed');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.equal(await js('window.conflictFixture.files[0].resolved'), true);
    assert.equal(await publishes(), 0, 'Reviewing and previewing never publish');
    assert.equal(await js("document.querySelector('.conflict-workflow [aria-current=step]').dataset.step"), 'push');
    assert.equal(
      await js("!!document.querySelector('.conflict-confirm .step-list,.conflict-confirm .step-card-count')"),
      false
    );
    const confirmText = await js<string>("document.querySelector('.conflict-confirm').innerText");
    assert.match(confirmText, /Pushes to (@\S+’s|your|the author’s) branch/);
    assert.match(confirmText, /Approvals may be dismissed if the repository requires it\./);
    assert.match(confirmText, /Your resolutions · 1 file/);
    assert.match(confirmText, /Changes coming from main · 1 file/);
    assert.equal((confirmText.match(/Nothing is pushed/g) ?? []).length, 1, 'Say “nothing pushed” once');
    await wait("document.activeElement?.classList.contains('step-card-body')");
    await captureAll('confirm-push');
    await js("document.querySelector('.conflict-confirm .step-card-body').focus()");
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Enter alone never pushes');

    // A push rejected because the branch moved: plain copy, nothing resent, Load latest changes.
    await js('window.failPublish=true');
    await click('Push merge commit');
    await wait("document.querySelector('.conflict-confirm .conflict-error')");
    assert.equal(
      await js("document.querySelector('.conflict-error-title').textContent"),
      'Someone pushed to feature/retry after you started.'
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-error').textContent"),
      /Nothing was pushed\. Your resolutions are saved\./
    );
    assert.equal(await js("document.querySelector('.conflict-error-details').open"), false);
    assert.match(await js<string>("document.querySelector('.conflict-error-details pre').textContent"), /stale info/);
    assert.doesNotMatch(
      await js<string>("[...document.querySelectorAll('.conflict-error > div > p')].map(p=>p.textContent).join(' ')"),
      /rejected|Git could not|stale info/
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await publishes(), 1, 'A failed push is never replayed');
    assert.ok(await js(`(${visibleButton('Push merge commit')}).disabled`));
    await captureAll('push-failed');
    await js('window.failPublish=false');
    await click('Load latest changes');
    await wait("window.conflictCalls.at(-1).kind==='open' && window.conflictCalls.at(-1).restart===true");
    await wait("document.querySelector('.conflict-workflow [aria-current=step]')?.dataset.step==='resolve'");
    assert.equal(await publishes(), 1, 'Loading the latest changes only reads');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='confirm'");
    await click('Review and push…');
    await click('Back to files');
    await wait("document.querySelector('.conflict-files')");
    await click('Review and push…');
    await click('Push merge commit');

    // Outcome: the branch is updated, with the commit, what changed, checks, Done and an undo hint.
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");
    assert.equal(await publishes(), 2);
    const outcome = await js<string>("document.querySelector('.conflict-outcome').innerText");
    assert.match(outcome, /Merge commit\s+ddddddd/);
    assert.match(outcome, /1 file resolved by you/);
    assert.match(outcome, /main’s changes included/);
    assert.match(outcome, /Checks restarting/);
    assert.match(outcome, /To undo, reset feature\/retry to\s+aaaaaaa/);
    await wait("document.activeElement?.textContent.trim()==='Done'");
    assert.ok(await exists('Open PR on GitHub'));
    await captureAll('published');

    // Restacking is a separate, explicit preview-and-push flow after the root resolution.
    await js(`(()=>{
      window.conflictFixture.dependents=['https://github.com/klang/engine/pull/121','https://github.com/klang/engine/pull/122'];
      const original=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        const s=window.conflictFixture;
        if(req.kind==='restack-prepare'){
          window.conflictCalls.push(req);s.restack={token:'e'.repeat(64),status:'prepared',rootSha:s.commitSha,expected:[{url:s.dependents[0],headSha:'a'.repeat(40),baseSha:'b'.repeat(40),headBranch:'feature/retry-121',baseBranch:'feature/retry'}],branches:[121,122].map((n,i)=>({url:'https://github.com/klang/engine/pull/'+n,title:i?'Make retry metrics observable':'Apply bounded retry delays',repo:'klang/engine',branch:'feature/retry-'+n,baseBranch:i?'feature/retry-121':'feature/retry',baseRepo:'klang/engine',baseSha:'b'.repeat(40),oldSha:'a'.repeat(40),newSha:'f'.repeat(40),commits:2,reused:i?0:1,patch:'',files:window.conflictPreview}))};s.version++;return {session:structuredClone(s)};
        }
        if(req.kind==='restack-save'){window.conflictCalls.push(req);const f=s.restack.blocked.files.find(f=>f.path===req.path);f.result=req.contents;f.resolved=req.resolved;s.version++;return {session:structuredClone(s)};}
        if(req.kind==='restack-continue'){window.conflictCalls.push(req);s.restack.status='prepared';s.restack.blocked=undefined;s.version++;return {session:structuredClone(s)};}
        if(req.kind==='restack-publish'){window.conflictCalls.push(req);s.restack.status='published';s.version++;return {session:structuredClone(s)};}
        return original(req);
      };
    })()`);
    await click('Done');
    await wait("!document.querySelector('.conflict-workspace')");
    await open();
    await wait("document.querySelector('.restack-review [aria-current=step]')?.dataset.step==='rebase'");
    assert.deepEqual(
      await js("[...document.querySelectorAll('.restack-review .step-list li')].map(li=>li.dataset.step)"),
      ['rebase', 'review', 'push']
    );
    assert.ok(await exists('Skip'), 'Restacking is optional before it starts');
    await captureAll('restack-plan');
    await click('Prepare restack · 2 PRs');
    await wait("document.querySelectorAll('.restack-reviewed input').length===2");
    assert.equal(
      await js("document.querySelectorAll('.restack-branch-header .restack-reviewed input').length"),
      2,
      'Each update’s review control sits at its header'
    );
    assert.equal(await js("document.querySelector('.restack-review [aria-current=step]').dataset.step"), 'review');
    assert.equal(await exists('Skip'), false);
    assert.equal(await calls('restack-publish'), 0);
    assert.ok(
      await js("[...document.querySelectorAll('.restack-review [data-step-continue]')].every(b=>b.disabled)"),
      'Continue waits for every PR update to be reviewed'
    );
    assert.match(
      await js<string>("document.querySelector('.restack-review .step-card-status').textContent"),
      /Mark each update reviewed to continue/
    );
    await captureAll('restack-review');
    await js("document.querySelectorAll('.restack-reviewed input').forEach(input=>input.click())");
    await click('Continue');
    await wait("document.querySelector('.restack-review [aria-current=step]')?.dataset.step==='push'");
    assert.equal(await js("document.querySelectorAll('.restack-confirm li').length"), 2);
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await calls('restack-publish'), 0, 'Enter alone never pushes');
    await captureAll('restack-confirm');
    await click('Push 2 PR updates');
    await wait("document.querySelector('.restack-review h2').textContent==='Dependent PRs updated'");
    assert.deepEqual(await js("window.conflictCalls.find(r=>r.kind==='restack-publish').reviewed"), [
      'https://github.com/klang/engine/pull/121',
      'https://github.com/klang/engine/pull/122',
    ]);
    await captureAll('restack-published');
    await click('Close');
    // A paused restack uses the same conflict view as the main resolution.
    await js(`(()=>{
      const s=window.conflictFixture;s.restack.status='blocked';s.restack.blocked={url:s.dependents[0],title:'Apply bounded retry delays',reason:'The restack is paused on a new conflict. Choose what to keep in each file, mark it reviewed, then continue. No dependent branches have been pushed.',paths:['src/retry.ts'],reused:0,files:[{...s.files[0],result:s.files[0].original,resolved:false}]};
      window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:s.url}));
    })()`);
    await wait("document.querySelector('.restack-conflict-file .conflict-block[data-state=open]')");
    assert.equal(await js("!!document.querySelector('.restack-conflict-file textarea')"), false);
    assert.deepEqual(
      await js(
        "[...document.querySelector('.restack-conflict-file .conflict-block').querySelectorAll('.conflict-side-label')].map(e=>e.textContent)"
      ),
      ['Updated parent · feature/retry', 'This PR · feature/retry-121']
    );
    assert.ok(await js(`(${visibleButton('Continue restack')}).disabled`));
    assert.match(
      await js<string>("document.querySelector('.restack-review .step-card-status').textContent"),
      /Mark each file reviewed/
    );
    await captureAll('restack-paused');
    for (let n = 0; n < 2; n++) {
      await js(
        "document.querySelector('.restack-conflict-file .conflict-block[data-state=open] [data-choice=theirs]').click()"
      );
      await new Promise((r) => setTimeout(r, 150));
    }
    await wait("!document.querySelector('.restack-conflict-file .conflict-block[data-state=open]')");
    // Closing must save an unreviewed paused draft; it must not lose it or publish.
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    assert.doesNotMatch(await js<string>('window.conflictFixture.restack.blocked.files[0].result'), /<{7}/);
    assert.equal(await js('window.conflictFixture.restack.blocked.files[0].resolved'), false);
    await open();
    await click('Mark reviewed');
    await click('Continue restack');
    await wait("!document.querySelector('.restack-blocked')");
    await click('Close');

    // A stale draft cannot be published; starting over reads the latest code.
    await js(
      "window.conflictFixture.status='editing';window.conflictFixture.stale=true;window.conflictFixture.files[0].resolved=false;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}));"
    );
    await wait("document.querySelector('.conflict-footer')?.textContent.includes('changed since you started')");
    assert.equal(
      await js("!!document.querySelector('[data-conflict-primary]')"),
      false,
      'Only starting over continues'
    );
    assert.ok(await exists('Start over with latest code…'));
    await captureAll('stale');
    await resize(760, 800);
    await capture('narrow');
    assert.ok(await footerFits(), 'Footer buttons fit at 760 × 800');
    await click('Guide');
    await capture('narrow-guide');
    assert.ok(await footerFits(), 'The guide does not clip the footer');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await click('Hide guide');
    await click('Start over with latest code…');
    await wait("document.querySelector('.conflict-footer')?.textContent.includes('Cancel')");
    await capture('start-over-narrow');
    await click('Cancel');
    await resize(1280, 900);
    await click('Close');

    // Edge screens drop the resolve controls, guide and draft status, and name the state.
    const noResolveChrome = async () => {
      for (const selector of [
        '.conflict-files',
        '.conflict-footer',
        '#conflict-help',
        '.conflict-save-state',
        '.conflict-suggest-trigger',
      ])
        assert.equal(await js(`!!document.querySelector(${JSON.stringify(selector)})`), false, `${selector} is hidden`);
      assert.equal(await exists('Guide'), false);
      assert.doesNotMatch(
        await js<string>("document.querySelector('.conflict-workspace').innerText"),
        /Mergiraf|agents were not used|Local draft/
      );
    };
    await js(
      "window.conflictFixture.files=[];window.conflictFixture.stale=false;window.conflictFixture.preparation='clean-merge';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-state h2')?.textContent==='No conflicts to resolve'");
    await noResolveChrome();
    await captureAll('clean-merge');
    await click('Review and push…');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.match(
      await js<string>("document.querySelector('.conflict-confirm').innerText"),
      /Changes coming from main · 2 files/
    );
    await captureAll('clean-merge-confirm');
    await click('Close');
    await js(
      "window.conflictFixture.preparation='up-to-date';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-state h2')?.textContent==='feature/retry already includes main'");
    await noResolveChrome();
    assert.equal(await js("!!document.querySelector('.conflict-workflow,.conflict-confirm')"), false);
    await wait("document.activeElement?.textContent.trim()==='Done'");
    await captureAll('up-to-date');
    await click('Done');
    await js(
      "window.conflictFixture.preparation='clean-merge';window.conflictFixture.stale=true;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-state h2')?.textContent==='The branches changed'");
    await noResolveChrome();
    await captureAll('empty-stale');
    await click('Load latest changes');
    await wait('window.conflictCalls.at(-1).restart===true');
    await click('Close');

    // Preparation shows inline progress; Activity is mentioned only when it takes a while.
    await js('window.slowOpen=7000');
    await open();
    await wait("document.querySelector('.conflict-state .loading-indicator')");
    assert.equal(
      await js("document.querySelector('.conflict-state').textContent.includes('Activity')"),
      false,
      'Activity is mentioned only after about 5 s'
    );
    await capture('preparing');
    await wait("document.querySelector('.conflict-state')?.textContent.includes('continues in Activity')");
    await capture('preparing-slow');
    await wait("!document.querySelector('.conflict-state .loading-indicator')");
    await click('Close');
    // A failed preparation explains itself; the raw output is under Details.
    await js(
      "window.slowOpen=0;window.failOpen='Git could not complete this operation. fatal: unable to read tree cccccccc'"
    );
    await open();
    await wait("document.querySelector('.conflict-state[data-state=failed] .conflict-error')");
    assert.equal(
      await js("document.querySelector('.conflict-error-title').textContent"),
      'Gnosis couldn’t prepare this merge.'
    );
    assert.ok(await exists('Try again'));
    await capture('failure');
    await captureAll('prepare-failed');
    await js('window.failOpen=undefined');
    await click('Try again');
    await wait("document.querySelector('.conflict-state h2')");
    await click('Close');

    // Long script lines with commit IDs as Git labels: the view still shows branch names only.
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
    // The preview matches this session's files: both resolved files plus one clean change from main.
    const longPatch = files
      .map(
        (f) =>
          `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-${f.ours.split('\n')[0]}\n+${f.theirs.split('\n')[0]} \n`
      )
      .join('');
    await js(
      `window.conflictPreview=${JSON.stringify(
        parsePatchFiles(longPatch + patch.slice(patch.indexOf('diff --git a/src/clock.ts'))).flatMap((p) => p.files)
      )}`
    );
    await js(
      `window.conflictFixture.files=${JSON.stringify(files)};window.conflictFixture.stale=false;window.conflictFixture.preparation='conflicts';window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))`
    );
    await wait("document.querySelectorAll('.conflict-files button').length===2");
    await wait("document.activeElement?.closest('.conflict-block')");
    assert.equal(await js("document.querySelector('.conflict-file-title strong').textContent"), 'package.json');
    await key('n');
    await wait("document.querySelector('.conflict-file-title strong')?.textContent==='scripts/test-workbench.mjs'");
    await wait("document.activeElement?.closest('.conflict-block')");
    assert.doesNotMatch(
      await js<string>("document.querySelector('.conflict-file-pane').innerText"),
      /[0-9a-f]{40}/,
      'Commit IDs never label versions'
    );
    await wait("document.querySelector('.conflict-view diffs-container')?.shadowRoot?.querySelector('[data-line]')");
    await captureAll('long-script-conflict');
    await resize(760, 800);
    assert.ok(await footerFits(), 'Long lines never push the footer out of view');
    await resize(1280, 900);
    await key('p');
    await wait("document.querySelector('.conflict-file-title strong')?.textContent==='package.json'");
    await key('n');
    await wait("document.querySelector('.conflict-file-title strong')?.textContent==='scripts/test-workbench.mjs'");
    // Reviewing one file advances without publishing; each file keeps its own saved content.
    await wait("document.activeElement?.closest('.conflict-block')");
    await key('1');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='review-result'");
    await key('m');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.match(
      await js<string>("document.querySelector('[data-conflict-primary]').textContent"),
      /Mark reviewed & next file/
    );
    await key('m');
    await wait("document.querySelector('.conflict-file-title strong').textContent==='package.json'");
    assert.equal(await js('window.conflictFixture.files[1].resolved'), true);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    await wait("document.activeElement?.closest('.conflict-block')");
    await key('2');
    await key('m');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    await captureAll('files-reviewed');
    await key('m');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.equal(await js('window.conflictFixture.files.every(f=>f.resolved)'), true);
    assert.equal(await publishes(), 2, 'File review never publishes');
    assert.match(
      await js<string>("document.querySelector('.conflict-confirm').innerText"),
      /Your resolutions · 2 files/
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-confirm').innerText"),
      /Changes coming from main · 1 file/
    );
    // File shortcuts pause in the confirmation, and Enter never pushes.
    await key('m');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 2, 'Neither shortcuts nor Enter push');
    // Escape cancels the workspace without pushing; the draft stays saved locally.
    await key('Escape');
    await wait("!document.querySelector('.conflict-workspace')");
    assert.equal(await publishes(), 2);
    console.log(
      'Conflict workspace passed: labelled versions, per-block undo, shortcuts, review before mark, one confirmation, outcome and failure copy, edge screens, stale guard, themes and narrow layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('test-failure');
    app.exit(1);
  }
});
