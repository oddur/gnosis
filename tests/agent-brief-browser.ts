import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('renderer:', m));
  const js = <T = unknown>(code: string) =>
    (win.webContents.executeJavaScript(code) as Promise<T>).catch((error: unknown) => {
      throw new Error(`Failed: ${code.slice(0, 200)}`, { cause: error });
    });
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out: ${code}`);
  };
  const click = (text: string) =>
    js(
      `/* ${text} */(()=>{const b=[...document.querySelectorAll('.commit-stream-row[data-active=true] button'),...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const shots = path.resolve('.impeccable/review/agent-brief');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const hasButton = (text: string) =>
    js<boolean>(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)})`);
  const tabCount = () => js<string | null>("document.querySelector('.brief-tab-count')?.textContent ?? null");
  const openStack = async () => {
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('bounded command queue')).click()"
    );
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open stack overview')");
    await click('Open stack overview');
    await wait("!!document.querySelector('.pr-overview-tabs')");
  };
  const setup = () =>
    js(`(async()=>{
      const {inspectionData}=await import('/lib/inspection-cache.ts');inspectionData.stop();
      window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])];
      window.workerRow=()=>[...document.querySelectorAll('.commit-stream-row')].find(r=>r.dataset.file?.endsWith('src/worker.ts'))??document.createElement('div');
      window.commentButton=()=>[...window.workerRow().querySelectorAll('.changes-file-actions button')].find(b=>b.textContent.trim()==='Comment');
      window.lineNumber=(line,type='change-addition')=>window.deepAll('[data-column-number]',window.workerRow()).find(e=>e.getAttribute('data-column-number')===String(line)&&(!type||e.getAttribute('data-line-type')===type));
      window.openFile=name=>{const row=window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===name);if(!row)throw Error('Missing tree row '+name);row.click()};
      window.fill=(selector,value)=>{const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(e.constructor.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))};
      window.copied=[];window.clipboardFails=false;
      navigator.clipboard.writeText=async text=>{if(window.clipboardFails)throw Error('Denied');window.copied.push(text)};
      window.commentWrites=[];
      window.electronAPI.createReviewComment=async request=>{window.commentWrites.push(request)};
      const source=window.electronAPI.getPrChanges;
      window.electronAPI.getStackChanges=async subject=>{
        const snapshots=await Promise.all(subject.members.map(m=>source(m.url)));
        const root=snapshots[0],tip=snapshots.at(-1);
        return {version:1,url:tip.url,metadata:{...tip.metadata,baseSha:root.metadata.baseSha,baseBranch:root.metadata.baseBranch},comparisonBase:root.metadata.baseSha,fetchedAt:Date.now(),files:[root.files[0]],
          stackComparison:{key:'a'.repeat(64),subjectId:subject.id,members:snapshots.map(s=>({metadata:s.metadata,comparisonBase:s.comparisonBase})),fileSources:{[root.files[0].path]:subject.members.map(m=>m.url)}}};
      };
      const prefs=await window.electronAPI.loadPreferences();await window.electronAPI.savePreferences({...prefs,stackChangesMode:'combined'});
    })()`);
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(win.webContents);
    await setup();
    await openStack();

    // The empty brief says how to start.
    await js(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('Local notes'));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await wait("document.querySelector('.agent-brief-empty')?.textContent.includes('Add local note')");
    assert.equal(await tabCount(), null);
    await click('Open Changes');

    // Combined: a single line. GitHub has no such diff, so the brief is the only destination.
    await wait("!!document.querySelector('.stack-changes-switch')");
    await click('Combined');
    await wait("document.querySelector('.stack-changes-switch button[aria-pressed=true]')?.textContent==='Combined'");
    await wait('!!window.lineNumber(36)');
    await js('window.lineNumber(36).click()');
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    assert.match(await js<string>("document.querySelector('.changes-comment-composer label').textContent"), /new line 36 · Combined stack/);
    assert.equal(await hasButton('Post to GitHub now'), false);
    assert.equal(await hasButton('Add to review'), false);
    await js("window.fill('.changes-comment-composer textarea','This limit belongs in the first PR.')");
    await capture('composer-combined');
    await click('Add local note');
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('Local note')");
    assert.equal(await tabCount(), '1');

    // By PR: the combined comment has different line coordinates, so it stays out of this diff.
    await click('By PR');
    await wait("!!document.querySelector('.commit-stream-row[data-active=true]')");
    await js('window.openFile("worker.ts")');
    await wait('!!window.lineNumber(36)');
    assert.equal(await js("document.querySelectorAll('.changes-pending-comment').length"), 0);

    // A region, selected by dragging across line numbers. Both GitHub and the brief are offered here.
    const drag = async (start: [number, string], end: [number, string]) => {
      // Measure only after the stream settles; it may adjust its scroll position after a jump.
      await js(`window.lineNumber(...${JSON.stringify(start)}).scrollIntoView({block:'center',behavior:'instant'});null`);
      await new Promise((r) => setTimeout(r, 500));
      const points = await js<{ x: number; y: number }[]>(
        `[${JSON.stringify(start)},${JSON.stringify(end)}].map(p=>{const r=window.lineNumber(...p).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})`
      );
      const mouse = (type: string, { x, y }: { x: number; y: number }, extra = {}) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
      await mouse('mouseMoved', points[0], { button: 'none' });
      await mouse('mousePressed', points[0], { clickCount: 1, buttons: 1 });
      await mouse('mouseMoved', points[1], { buttons: 1 });
      await mouse('mouseReleased', points[1], { clickCount: 1 });
    };
    await drag([34, 'context'], [36, 'change-addition']);
    await wait('window.commentButton()?.disabled===false');
    await js('window.commentButton().click()');
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    assert.match(await js<string>("document.querySelector('.changes-comment-composer label').textContent"), /new lines 34–36 · PR #/);
    assert.equal(await hasButton('Post to GitHub now'), true);
    assert.equal(await js("document.querySelector('.changes-comment-destination input[value=local]').checked"), true, 'Local destination carries from Combined to By PR');
    await js("document.querySelector('.changes-comment-destination input[value=review]').click()");
    await wait("[...document.querySelectorAll('.changes-comment-composer button')].some(b=>b.textContent==='Add to review')");
    await js("document.querySelector('.changes-comment-destination input[value=local]').click()");
    await wait("[...document.querySelectorAll('.changes-comment-composer button')].some(b=>b.textContent==='Add local note')");
    await capture('composer-destination');
    await js("window.fill('.changes-comment-composer textarea','Rename these constants.')");
    await js("document.querySelector('.changes-comment-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}))");
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('Rename these constants.')");
    assert.equal(await tabCount(), '2');
    assert.equal(await js('window.commentWrites.length'), 0, 'A brief comment never reaches GitHub');

    // A region across a changed block is fine for the brief, but GitHub cannot hold it.
    await drag([36, 'change-deletion'], [36, 'change-addition']);
    await wait('window.commentButton()?.disabled===false');
    await js('window.commentButton().click()');
    await wait("document.querySelector('.changes-comment-composer label')?.textContent.includes('old line 36 to new line 36')");
    assert.equal(await hasButton('Post to GitHub now'), false);
    assert.match(await js<string>("document.querySelector('.changes-comment-help').textContent"), /one side of the diff/);
    await js("window.fill('.changes-comment-composer textarea','Keep the old value.')");
    await click('Add local note');
    await wait("document.querySelector('.brief-tab-count')?.textContent==='3'");

    // Reviewing the brief, including exactly what the agent receives.
    await click('Open local notes');
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    const headings = await js<string[]>("[...document.querySelectorAll('.agent-brief-group h3')].map(e=>e.textContent)");
    assert.equal(headings[0], 'Combined stack');
    assert.match(headings[1], /^By PR · #\d+/);
    assert.match(await js<string>("document.querySelector('.agent-brief-location').textContent"), /src\/worker\.ts new line 36/);
    await capture('brief');
    win.setSize(640, 800);
    await capture('brief-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await click('Preview');
    await click('Copy for agent');
    await wait('window.copied.length===1');
    const markdown = await js<string>('window.copied[0]');
    assert.match(markdown, /## How I reviewed this/);
    assert.match(markdown, /\*\*Combined stack\*\* \(1 comment\)/);
    assert.match(markdown, /\*\*By PR\*\* \(2 comments\)/);
    assert.match(markdown, /`src\/worker\.ts`, new line 36/);
    assert.match(markdown, /`src\/worker\.ts`, new lines 34–36/);
    assert.match(markdown, /`src\/worker\.ts`, old line 36 to new line 36/);
    assert.match(markdown, /old 36: const value35 = 35;\nnew 36: const value35 = 36;/);
    assert.match(markdown, /> This limit belongs in the first PR\./);
    assert.match(markdown, /const value35 = 36;/, 'The commented code travels with the comment');
    assert.equal(await js("document.querySelector('.agent-brief-preview pre').textContent"), markdown);
    assert.equal(await js("document.querySelectorAll('.agent-brief-comment').length"), 3, 'Copy keeps the brief');

    await click('Hide preview');

    // Jump to a comment in the view it was written in, then come back.
    await js("document.querySelectorAll('.agent-brief-location')[0].click()");
    await wait("document.querySelector('.stack-changes-switch button[aria-pressed=true]')?.textContent==='Combined'");
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('This limit belongs')");
    await click('Open local notes');
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    await js("[...document.querySelectorAll('.agent-brief-comment')].find(c=>c.textContent.includes('Rename these')).querySelector('.agent-brief-location').click()");
    await wait("document.querySelector('.stack-changes-switch button[aria-pressed=true]')?.textContent==='By PR'");
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('Rename these')");

    // Jumping to a viewed file opens it without changing the reviewer's progress.
    await js(`(()=>{const c=window.workerRow().querySelector('.changes-file-actions label input');if(!c.checked)c.click()})()`);
    await wait("window.workerRow().querySelector('.commit-stream-file-body')?.hidden===true");
    await js(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('Local notes'));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    await js("[...document.querySelectorAll('.agent-brief-comment')].find(c=>c.textContent.includes('Rename these')).querySelector('.agent-brief-location').click()");
    await wait("window.workerRow().querySelector('.commit-stream-file-body')?.hidden===false");
    await wait("document.querySelector('.changes-pending-comment')?.textContent.includes('Rename these')");
    assert.equal(await js("window.workerRow().querySelector('.changes-file-actions label input').checked"), true);
    await js("window.workerRow().querySelector('.changes-file-actions label input').click()");

    // Editing and removing one comment.
    await js(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('Local notes'));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    await js("[...document.querySelectorAll('.agent-brief-comment')].find(c=>c.textContent.includes('Rename these')).querySelector('.changes-draft-comment button').click()");
    await wait("!!document.querySelector('.agent-brief-comment textarea')");
    await js("window.fill('.agent-brief-comment textarea','Rename these constants and their tests.')");
    assert.equal(await js("[...document.querySelectorAll('.agent-brief-actions button')].find(b=>b.textContent==='Copy for agent').disabled"), true, 'Never export the older saved note while an edit is visible');
    assert.equal(await js("document.querySelector('[aria-label=\"Note actions\"]').disabled"), true);
    await capture('pending-edit');
    // Storage failure leaves the edit open and the original note saved.
    await js(`window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('gnosis-agent-brief:'))throw Error('Disk full');window.originalSetItem.call(this,key,value)};null`);
    await click('Save note');
    await wait("document.querySelector('.agent-brief-comment [role=alert]')?.textContent.includes('Your text is still here')");
    assert.equal(await js<string>("document.querySelector('.agent-brief-comment textarea').value"), 'Rename these constants and their tests.');
    await js('Storage.prototype.setItem=window.originalSetItem;null');
    await click('Save note');
    await wait("document.querySelector('.agent-brief').textContent.includes('and their tests')");
    await wait("document.activeElement?.textContent==='Edit note'");
    await click('Copy for agent');
    await wait('window.copied.length===2');
    assert.match(await js<string>('window.copied[1]'), /Rename these constants and their tests/);
    // Individual deletion is reversible and returns focus to its recovery action.
    await click('Remove note');
    await wait("document.querySelectorAll('.agent-brief-comment').length===2");
    await wait("document.activeElement?.textContent.includes('Undo deletion')");
    await click('Undo deletion');
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");

    // Everything survives leaving, and a full reload. The fixture clears storage unless told to keep it.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&keep-progress`);
    await waitForWorkbenchQueue(win.webContents);
    await setup();
    await openStack();
    await wait("document.querySelector('.brief-tab-count')?.textContent==='3'");
    await js(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('Local notes'));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");

    // A single PR has its own brief, separate from the stack it belongs to.
    await js("document.querySelector('.stack-scope-bar [role=combobox], .stack-scope-bar button').click()");
    await wait("!!document.querySelector('.stack-scope-popup [role=option]')");
    await js("[...document.querySelectorAll('.stack-scope-popup [role=option]')].find(o=>/#\\d+/.test(o.textContent)).click()");
    await wait("!!document.querySelector('.stack-back')");
    await wait("document.querySelector('.agent-brief-empty')?.textContent.includes('Add local note')");
    assert.equal(await tabCount(), null);
    assert.match(await js<string>("document.querySelector('.agent-brief-scope-link').textContent"), /View 3 notes saved for the stack/);
    await click('Open Changes');
    await wait("!!document.querySelector('.commit-stream-row[data-active=true]')");
    await js('window.openFile("worker.ts")');
    await wait('!!window.lineNumber(36)');
    await js('window.lineNumber(36).click()');
    await wait("!!document.querySelector('.changes-comment-composer textarea')");
    await js("document.querySelector('.changes-comment-destination input[value=local]').click()");
    await js("window.fill('.changes-comment-composer textarea','Only about this PR.')");
    await click('Add local note');
    await wait("document.querySelector('.brief-tab-count')?.textContent==='1'");
    await js(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.startsWith('Local notes'));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));t.click()})()`);
    await wait("document.querySelector('.agent-brief-group h3')?.textContent.startsWith('Single PR')");
    await click('Copy for agent');
    await wait('window.copied.length===1');
    assert.match(await js<string>('window.copied[0]'), /\*\*Single PR\*\* \(1 comment\)/);
    assert.doesNotMatch(await js<string>('window.copied[0]'), /Rename these constants/);
    await js("(()=>{const b=document.querySelector('[aria-label=\"Note actions\"]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})()");
    await wait("!!document.querySelector('[role=menuitem]')");
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Delete all notes')).click()");
    await wait("!!document.querySelector('.agent-brief-empty')");
    assert.equal(await tabCount(), null);
    await click('Back to stack');
    await wait("document.querySelector('.brief-tab-count')?.textContent==='3'");

    // Copy failure is persistent, announced, and never deletes anything.
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    await js('window.clipboardFails=true');
    await click('Copy for agent');
    await wait("document.querySelector('.agent-brief [role=alert]')?.textContent.includes('still saved here')");
    assert.equal(await js("document.querySelectorAll('.agent-brief-comment').length"), 3);
    await new Promise(r => setTimeout(r, 1700));
    assert.equal(await js("!!document.querySelector('.agent-brief [role=alert]')"), true);
    await js('window.clipboardFails=false');
    await click('Copy for agent');
    await wait("!document.querySelector('.agent-brief [role=alert]')");

    // Bulk deletion moves behind the menu and is recoverable independently of the clipboard.
    await js("(()=>{const b=document.querySelector('[aria-label=\"Note actions\"]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))})()");
    await wait("!!document.querySelector('[role=menuitem]')");
    await js("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Delete all notes')).click()");
    await wait("document.querySelector('.agent-brief-undo')?.textContent.includes('3 notes deleted')");
    await wait("document.activeElement?.textContent.includes('Undo deletion')");
    await capture('deleted-with-undo');
    assert.equal(await tabCount(), null);
    await click('Undo deletion');
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");

    // Recovery survives scope navigation, and cannot mix a PR notebook with stack notes.
    await js("document.querySelector('.stack-scope-bar [role=combobox], .stack-scope-bar button').click()");
    await wait("!!document.querySelector('.stack-scope-popup [role=option]')");
    await js("[...document.querySelectorAll('.stack-scope-popup [role=option]')].find(o=>/#\\d+/.test(o.textContent)).click()");
    await wait("document.querySelector('.agent-brief-undo')?.textContent.includes('1 note deleted')");
    await click('Undo deletion');
    await wait("document.querySelectorAll('.agent-brief-comment').length===1");
    assert.match(await js<string>("document.querySelector('.agent-brief-comment').textContent"), /Only about this PR/);
    await click('View 3 notes saved for the stack');
    await wait("document.querySelectorAll('.agent-brief-comment').length===3");
    assert.match(await js<string>("document.querySelector('.agent-brief-related').textContent"), /1 note in PR #/);
    // Current visual evidence in both themes, narrow windows, and 200% scaling.
    await js("document.querySelector('.agent-brief').scrollTop=0");
    await capture('brief');
    await js("document.documentElement.classList.add('dark')");
    await capture('brief-dark');
    await js("document.documentElement.classList.remove('dark')");
    win.setSize(640, 800);
    await capture('brief-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    win.webContents.setZoomFactor(2);
    await capture('brief-zoom');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.webContents.setZoomFactor(1);
    // Long paths, multiline code and non-ASCII notes must wrap without expanding the workspace.
    await js(`(async()=>{
      const {readAgentBrief,updateAgentBrief}=await import('/lib/agent-brief.ts');
      const key=Object.keys(localStorage).find(k=>k.startsWith('gnosis-agent-brief:')&&k.includes('stack:'));
      const subject=key.slice('gnosis-agent-brief:'.length);
      await updateAgentBrief(subject,current=>current.map((note,i)=>i===0?{...note,
        path:'src/'+('long-directory-name/'.repeat(12))+'worker.ts',
        body:'Check this boundary before retrying. '.repeat(12)+'中文 • العربية • 👩🏽‍💻',
        code:Array.from({length:40},(_,i)=>'const value'+i+' = '+i+';').join('\\n')}:note));
    })()`);
    await wait("!!document.querySelector('.agent-brief-code')");
    win.setSize(920, 800);
    await js("document.querySelector('.agent-brief').scrollTop=0");
    await capture('brief-long');
    win.setSize(640, 800);
    await js("document.querySelector('.agent-brief-code summary').click()");
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await js("document.querySelector('.agent-brief').scrollWidth<=document.querySelector('.agent-brief').clientWidth"), true);
    console.log('agent brief browser test passed');
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
