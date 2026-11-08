import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 400; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code + '\n' + (await js<string>('document.body.innerText.slice(0,4000)')));
  };
  const root = `document.querySelector('[data-workspace-active=true]')`;
  const click = async (label: string) =>
    js(
      `(()=>{const el=[...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!el)throw Error('Missing '+${JSON.stringify(label)});el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));el.click()})()`
    );
  const key = async (key: string, extra = {}) =>
    js(`window.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, ...extra })}))`);
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.mkdirSync('/tmp/gnosis-workspace-tabs', { recursive: true });
    fs.writeFileSync('/tmp/gnosis-workspace-tabs/' + name + '.png', (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?pr-summary&workspace-tabs&keep-progress');
    await waitForWorkbenchQueue(win.webContents);
    assert.equal(await js('document.querySelectorAll(".workspace-tab").length'), 1);
    // A menu action must dismiss its portal before the source workspace is hidden.
    for (const mode of ['context', 'overflow']) {
      await js(`(()=>{const row=${root}.querySelector('.queue-row');
        if (${JSON.stringify(mode)}==='context') { const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+40,clientY:r.top+20})); }
        else row.querySelector('.entry-menu-trigger').click();
      })()`);
      await wait(`!!document.querySelector('[role=menuitem][aria-label="Open in new tab"]')`);
      await js(`document.querySelector('[role=menuitem][aria-label="Open in new tab"]').click()`);
      await wait(
        `document.querySelectorAll('.workspace-tab').length===2 && !!${root}.querySelector('.pr-summary-page')`
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        await js(
          `[...document.querySelectorAll('[role=menu]')].some(menu=>menu.getClientRects().length>0 && getComputedStyle(menu).visibility!=='hidden')`
        ),
        false,
        `${mode} menu is not visible over the new tab`
      );
      assert.equal(
        await js(`document.querySelectorAll('[role=menu]').length`),
        0,
        `${mode} menu closes after opening a foreground tab`
      );
      await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
      await wait(`!!${root}.querySelector('.queue-list')`);
      assert.equal(
        await js(`document.querySelectorAll('[role=menu]').length`),
        0,
        `${mode} menu stays closed when returning to its tab`
      );
      await js(
        `(()=>{const trigger=${root}.querySelector('.queue-row .entry-menu-trigger');trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));})()`
      );
      await wait(`!!document.querySelector('[role=menuitem][aria-label="Open in new tab"]')`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait(`!document.querySelector('[role=menu]')`);
      await js(`document.querySelectorAll('.workspace-tab-close')[1].click()`);
      await wait(`document.querySelectorAll('.workspace-tab').length===1`);
    }
    await js(
      `window.tabReads=0;const mark=window.electronAPI.workbenchMarkPrRead;window.electronAPI.workbenchMarkPrRead=(...args)=>{window.tabReads++;return mark(...args)};window.tabRefreshes=0;window.inSnapshot=false;const snapshot=window.electronAPI.workbenchSnapshot;window.electronAPI.workbenchSnapshot=(...args)=>{window.inSnapshot=true;try{return snapshot(...args)}finally{window.inSnapshot=false}};const refresh=window.electronAPI.workbenchQueue;window.electronAPI.workbenchQueue=(...args)=>{if(!window.inSnapshot)window.tabRefreshes++;return refresh(...args)};true;`
    );
    await js(
      `${root}.querySelector('.queue-row-main').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
    );
    await wait('document.querySelectorAll(".workspace-tab").length===2');
    assert.equal(await js(`${root}.querySelector('.queue-list')!==null`), true, 'modified click leaves queue active');
    assert.equal(await js('window.tabReads'), 0, 'unopened background tab does not mark PR read');
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.pr-summary-page')!==null`);
    await click('Changes');
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    await wait(`document.querySelectorAll('.workspace-tab-select')[1].title.includes('Changes')`);
    await js(`${root}.dataset.marker='retained';window.beforeSwitch=window.tabRefreshes;`);
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait(`${root}.querySelector('.queue-list')!==null`);
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    assert.equal(await js(`${root}.dataset.marker`), 'retained');
    assert.equal(
      await js('window.tabRefreshes-window.beforeSwitch'),
      0,
      'resuming views uses local snapshot, not discovery'
    );
    assert.equal(await js('document.querySelectorAll(".activity-shell").length'), 1, 'one global Activity surface');
    // Browser history belongs to this PR tab; switching to the queue must not
    // make its Back command change the PR tab's position.
    await click('Summary');
    await key('[', { metaKey: true });
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait(`${root}.querySelector('.queue-list')!==null`);
    await key('[', { metaKey: true });
    assert.equal(await js(`${root}.querySelector('.queue-list')!==null`), true);
    await js(
      `${root}.querySelector('.queue-list').scrollTop=450;window.queueScroll=${root}.querySelector('.queue-list').scrollTop;`
    );
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait(`${root}.querySelector('.queue-list')!==null`);
    assert.equal(
      await js(`${root}.querySelector('.queue-list').scrollTop`),
      await js('window.queueScroll'),
      'queue scroll does not snap to the selected row'
    );
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    await capture('changes');
    await key('t', { metaKey: true });
    await wait('document.querySelectorAll(".workspace-tab").length===3');
    await wait(`${root}.querySelector('.queue-list')!==null`);
    // The former demo cap must not survive the production implementation.
    for (let i = 0; i < 3; i++) {
      await key('t', { metaKey: true });
      await wait(`document.querySelectorAll('.workspace-tab').length===${4 + i}`);
      await wait(`${root}.querySelector('.queue-list')!==null`);
    }
    assert.equal(await js('document.querySelectorAll(".workspace-tab").length'), 6);
    await key('2', { metaKey: true });
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    await key('w', { metaKey: true });
    await wait('document.querySelectorAll(".workspace-tab").length===5');
    await key('T', { metaKey: true, shiftKey: true });
    await wait('document.querySelectorAll(".workspace-tab").length===6');
    await wait(`${root}.querySelector('.pr-changes')!==null`);
    // The original tab remains independent from the reopened PR.
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait(`${root}.querySelector('.queue-list')!==null`);
    await key('Tab', { ctrlKey: true });
    await wait('document.querySelectorAll(".workspace-tab-select")[1].getAttribute("aria-selected")==="true"');
    await capture('desktop');
    win.setSize(1000, 800);
    await capture('laptop');
    await new Promise((r) => setTimeout(r, 700));
    const saved = await js<string | null>(`localStorage.getItem('gnosis-workspace-tabs:v1:oddur')`);
    assert.ok(saved?.includes('"version":1'), 'tabs saved through review-state storage');
    await win.loadURL(url + '?pr-summary&workspace-tabs&keep-progress');
    await wait('document.querySelectorAll(".workspace-tab").length===6');
    assert.equal(await js(`document.querySelectorAll('[data-workspace-active=true]').length`), 1);
    // Two tabs may inspect the same explanation without sharing unfinished input.
    await loadWorkbenchPage(win, url + '?pr-summary');
    await waitForWorkbenchQueue(win.webContents);
    for (let i = 0; i < 2; i++) {
      await js(
        `${root}.querySelector('.queue-item:has(.queue-disclosure:not(:disabled)) .queue-row-main').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
      );
      await wait(`document.querySelectorAll('.workspace-tab').length===${i + 2}`);
    }
    const fillChat = (value: string) =>
      js(
        `(()=>{const el=${root}.querySelector('.chat-sheet textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`
      );
    for (const index of [1, 2]) {
      await js(`document.querySelectorAll('.workspace-tab-select')[${index}].click()`);
      await wait(`${root}.querySelector('.pr-summary-page')!==null`);
      await click('Explanation');
      await wait(`${root}.querySelector('.explanation-document')!==null`);
      await js(
        `document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}))`
      );
      await wait(`${root}.querySelector('.chat-sheet textarea')!==null`);
      assert.equal(await js(`${root}.querySelector('.chat-sheet textarea').value`), '', 'new tab has its own composer');
      await fillChat(index === 1 ? 'First tab question' : 'Second tab question');
    }
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.chat-sheet textarea')?.value==='First tab question'`);
    await js(
      `${root}.querySelector('.explanation-document').scrollTop=350;window.readingPosition=${root}.querySelector('.explanation-document').scrollTop;`
    );
    await js(`document.querySelectorAll('.workspace-tab-select')[2].click()`);
    await wait(`${root}.querySelector('.chat-sheet textarea')?.value==='Second tab question'`);
    await js(`${root}.querySelector('.explanation-document').scrollTop=0;`);
    await js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await wait(`${root}.querySelector('.chat-sheet textarea')?.value==='First tab question'`);
    assert.equal(
      await js(`${root}.querySelector('.explanation-document').scrollTop`),
      await js('window.readingPosition'),
      'same explanation keeps independent reading positions'
    );
    await capture('explanation-tabs');
    await js(
      `const loadPrefs=window.electronAPI.loadPreferences;window.electronAPI.loadPreferences=async()=>({...await loadPrefs(),theme:'dark'});document.documentElement.classList.add('dark');true;`
    );
    await capture('dark-tabs');
    // Authentication changes discard the old account's mounted views and history.
    await js(`window.electronAPI.getAuthState=()=>Promise.resolve({authenticated:true,login:'someone-else'});true;`);
    await js(`document.querySelectorAll('.workspace-tab-select')[0].click()`);
    await wait('document.querySelectorAll(".workspace-tab").length===1');
    await wait(`${root}.querySelector('.queue-list')!==null`);
    assert.ok(await js(`localStorage.getItem('gnosis-workspace-tabs:v1:oddur')!==null`));
    console.log(
      'Workspace tabs: background opening, retained Changes, local resume, shared Activity, six tabs, shortcuts, reopen and restore passed'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    app.exit(1);
  }
});
