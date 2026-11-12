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
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('renderer:', event.message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const root = `document.querySelector('[data-workspace-active=true]')`;
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.mkdirSync('/tmp/gnosis-tabs-hardening', { recursive: true });
    fs.writeFileSync('/tmp/gnosis-tabs-hardening/' + name + '.png', (await win.webContents.capturePage()).toPNG());
  };
  try {
    const base = process.env.GNOSIS_WORKBENCH_URL;
    if (!base) throw Error('Missing fixture URL');
    const url = base + '?pr-summary&workspace-benchmark&keep-progress';
    await loadWorkbenchPage(win, url);
    await waitForWorkbenchQueue(win.webContents);
    if (process.env.GNOSIS_TABS_BENCH !== '1') {
      // The keep-open hint lives in New tab's tooltip, so the row stays free to move the window.
      await capture('first-tab');
      assert.match(await js<string>(`document.querySelector('[aria-label="New tab"]').title`), /click a PR to keep it open/);
      // With 12 tabs in a 1100px window, at least 120px of the row still moves the window.
      await js(
        `sessionStorage.setItem('fixture-workspace-tabs',JSON.stringify({version:1,active:'tab-0',tabs:Array.from({length:12},(_,i)=>({id:'tab-'+i,title:i?'Review title '+i+' '+'long words '.repeat(4):'Review queue',label:i?'#'+i:'Queue',detail:'team/repository',section:'queue'}))}));`
      );
      win.setSize(1100, 850);
      await win.loadURL(url);
      await wait('document.querySelectorAll(".workspace-tab").length===12');
      await waitForWorkbenchQueue(win.webContents);
      // The Activity capsule is in the row too, with its widest fixture label.
      await wait("document.querySelector('.app-titlebar .activity-capsule')?.getAttribute('aria-label')?.includes('2 ready')");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const drag = await js<{ region: string; gap: number; interactive: number; width: number; zone: boolean; capsule: boolean }>(`(()=>{
        const row=document.querySelector('.app-titlebar');
        const r=row.getBoundingClientRect();
        const region=el=>getComputedStyle(el).getPropertyValue('-webkit-app-region');
        const visible=[...row.querySelectorAll('*')].filter(el=>el.checkVisibility()&&el.getClientRects().length);
        // Any visible control must opt out of dragging, or clicks on it would move the window.
        const interactive=visible.filter(el=>el.matches('button,a,input,select,[role=tab]')&&region(el)!=='no-drag').length;
        // Electron applies regions in document order with unclipped boxes: drag adds, no-drag removes.
        const left=Math.floor(r.left),cells=new Array(Math.ceil(r.width)).fill(true);
        for(const el of visible){
          const value=region(el);
          if(value!=='drag'&&value!=='no-drag')continue;
          const b=el.getBoundingClientRect();
          if(!b.width||!b.height)continue;
          for(let x=Math.max(0,Math.floor(b.left)-left);x<Math.min(cells.length,Math.ceil(b.right)-left);x++)cells[x]=value==='drag';
        }
        let gap=0,run=0,end=0;
        for(let x=0;x<cells.length;x++){run=cells[x]?run+1:0;if(run>gap){gap=run;end=x+left;}}
        // The widest run sits between New tab and Search.
        const plus=document.querySelector('[aria-label="New tab"]').getBoundingClientRect();
        const search=[...row.querySelectorAll('.workspace-menu-search')].find(b=>b.checkVisibility()).getBoundingClientRect();
        const capsule=row.querySelector('.activity-capsule').getBoundingClientRect();
        return {region:region(row),gap,interactive,width:innerWidth,zone:end-gap+1>=plus.right&&end<=capsule.left,capsule:capsule.width>0&&capsule.right<=search.left};
      })()`);
      assert.equal(drag.region, 'drag', 'The title bar row is a drag region');
      assert.equal(drag.width, 1100);
      assert.equal(drag.interactive, 0, 'Every visible title bar control opts out of dragging');
      assert.ok(drag.gap >= 120, `At least 120px of contiguous drag area with 12 tabs, saw ${drag.gap}`);
      assert.ok(drag.capsule, 'The Activity capsule is visible, just before Search');
      assert.ok(drag.zone, 'The reserved drag area sits between New tab and the Activity capsule');
      await capture('drag-zone-12-tabs');
      win.setSize(1280, 850);
    }
    await js(
      `sessionStorage.setItem('fixture-workspace-tabs',JSON.stringify({version:1,active:'tab-0',tabs:Array.from({length:40},(_,i)=>({id:'tab-'+i,title:i?'修正 reconnect — مراجعة '+i+' '+('Long review title '.repeat(8)):'Review queue',label:i?'#'+i:'Queue',detail:'team/repository',section:'queue'}))}));`
    );
    await win.loadURL(url);
    await wait('document.querySelectorAll(".workspace-tab").length===40');
    await waitForWorkbenchQueue(win.webContents);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const metrics = await js(`(async()=>{
      window.tabProfile.commits=0;window.tabProfile.duration=0;
      const list=${root}.querySelector('.queue-list');
      const start=performance.now();
      for(let i=0;i<50;i++){list.scrollTop=i%2?20:80;list.dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(requestAnimationFrame);}
      return {...window.tabProfile,elapsed:performance.now()-start};
    })()`);
    console.log('40-tab scroll benchmark', metrics);
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false);
    if (process.env.GNOSIS_TABS_BENCH === '1') {
      app.exit(0);
      return;
    }
    await js(
      `window.tabDragTransfer=new DataTransfer();window.startTabDrag=id=>{const node=document.querySelector('[data-tab-id="'+id+'"] .workspace-tab-select');const r=node.getBoundingClientRect();node.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.tabDragTransfer,clientX:r.left+30,clientY:r.top+15}));};window.overTabDrag=(id,after=false)=>{const node=document.querySelector('[data-tab-id="'+id+'"]');const r=node.getBoundingClientRect();const list=document.querySelector('.workspace-tabs-list');window.tabDropX=r.left+(after?r.width-5:5);list.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.tabDragTransfer,clientX:window.tabDropX,clientY:r.top+15}));};window.dropTabDrag=()=>document.querySelector('.workspace-tabs-list').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.tabDragTransfer,clientX:window.tabDropX,clientY:20}));window.tabOrder=()=>[...document.querySelectorAll('.workspace-tab')].map(n=>n.dataset.tabId);true;`
    );
    await js(`${root}.dataset.dragRetention='kept';window.startTabDrag('tab-0');window.overTabDrag('tab-3');`);
    await wait(`!!document.querySelector('[data-drop-before=true]')`);
    await capture('drag-insertion');
    await js(`window.dropTabDrag()`);
    await wait(`window.tabOrder().slice(0,4).join(',')==='tab-1,tab-2,tab-0,tab-3'`);
    assert.equal(await js(`${root}.dataset.dragRetention`), 'kept', 'reordering retains the active workspace');
    await wait(`JSON.parse(localStorage.getItem('gnosis-workspace-tabs:v1:oddur')).tabs[0].id==='tab-1'`);
    await js(`window.startTabDrag('tab-0');window.overTabDrag('tab-1');window.dropTabDrag();`);
    await wait(`window.tabOrder()[0]==='tab-0'`);
    // Cancel, ignore external drops, then scroll overflowing tabs while holding near the edge.
    await js(
      `window.dragEscapeLeaks=0;window.dragEscapeListener=()=>window.dragEscapeLeaks++;window.addEventListener('keydown',window.dragEscapeListener);window.startTabDrag('tab-0');window.overTabDrag('tab-3');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));window.removeEventListener('keydown',window.dragEscapeListener);window.dropTabDrag();`
    );
    await wait(`!document.querySelector('[data-dragging=true],[data-drop-before=true]')`);
    assert.equal(await js('window.dragEscapeLeaks'), 0, 'Escape cancels dragging without reaching review shortcuts');
    assert.equal(await js(`window.tabOrder()[0]`), 'tab-0');
    await js(
      `{window.startTabDrag('tab-0');const list=document.querySelector('.workspace-tabs-list');const r=list.getBoundingClientRect();list.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.tabDragTransfer,clientX:r.right-5,clientY:r.top+15}));}`
    );
    await wait(`document.querySelector('.workspace-tabs-list').scrollLeft>200`);
    await js(
      `window.dispatchEvent(new Event('blur'));document.querySelector('.workspace-tabs-list').scrollLeft=0;window.dropTabDrag();`
    );
    await wait(`!document.querySelector('[data-dragging=true],[data-drop-before=true]')`);
    assert.equal(await js(`window.tabOrder()[0]`), 'tab-0');
    await js(
      `window.startTabDrag('tab-0');window.overTabDrag('tab-2',true);document.querySelector('[data-tab-id="tab-0"] .workspace-tab-select').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.tabDragTransfer}));`
    );
    await wait(`!document.querySelector('[data-dragging=true],[data-drop-before=true]')`);
    assert.equal(await js(`window.tabOrder()[0]`), 'tab-0');
    await capture('many-tabs');
    await js(`document.querySelector('[aria-label="Open tabs"]').click()`);
    await wait(`document.querySelector('.workspace-open-tabs-menu [role=menuitem]')!==null`);
    assert.ok(await js(`document.querySelector('.workspace-open-tabs-menu').textContent.includes('team/repository')`));
    await capture('overflow-menu');
    await js(`document.documentElement.classList.add('dark')`);
    await capture('overflow-dark');
    await js(`document.documentElement.classList.remove('dark')`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(`!document.querySelector('.workspace-open-tabs-menu')`);
    await js(
      `const tab=document.querySelector('.workspace-tab-select');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));`
    );
    await wait(`!![...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='Move tab right')`);
    await capture('keyboard-menu');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(`document.activeElement===document.querySelector('.workspace-tab-select')`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true}))`);
    await wait(`document.querySelectorAll('.workspace-tab').length===39`);
    await wait(`document.activeElement===document.querySelector('.workspace-tab-select[aria-selected=true]')`);
    await js(
      `const el=document.querySelectorAll('.workspace-tab')[3];const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+10,clientY:r.bottom}));`
    );
    await wait(`!![...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='Close other tabs')`);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='Close other tabs').click()`);
    await wait(`document.querySelectorAll('.workspace-tab').length===1`);
    await wait(`document.querySelector('.workspace-tab-select').id==='workspace-tab-tab-4'`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'T',metaKey:true,shiftKey:true,bubbles:true}))`);
    await wait(`document.querySelectorAll('.workspace-tab').length===2`);
    // A failed remote destination stays in its tab and can retry without reopening it.
    await js(
      `sessionStorage.setItem('fixture-workspace-tabs',JSON.stringify({version:1,active:'queue',tabs:[{id:'queue',title:'Review queue',label:'Queue',detail:'',section:'queue'},{id:'retry',title:'PR #999',label:'#999',detail:'klang/engine',section:'summary',destination:{kind:'home',url:'https://github.com/klang/engine/pull/999'}}]}));`
    );
    await win.loadURL(url);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `window.originalMetadata=window.electronAPI.getPrMetadata;window.retryCalls=0;window.electronAPI.getPrMetadata=async()=>{window.retryCalls++;throw Error('GitHub is offline')};document.querySelectorAll('.workspace-tab-select')[1].click();`
    );
    await wait(`${root}.querySelector('.workspace-open-error')!==null`);
    await wait(`document.querySelector('.workspace-tab-error')!==null`);
    await capture('retry');
    await js(
      `window.electronAPI.getPrMetadata=(...args)=>{window.retryCalls++;return window.originalMetadata(...args)};${root}.querySelector('.workspace-open-error button').click();`
    );
    await wait(`${root}.querySelector('.pr-summary-page')!==null && !${root}.querySelector('.workspace-open-error')`);
    assert.equal(await js('window.retryCalls'), 2);
    assert.equal(await js(`!!document.querySelector('.workspace-tab-error')`), false);
    // A tab with a renderer error must leave its neighbours usable.
    await js(
      `window.originalQueue=window.electronAPI.workbenchQueue;window.electronAPI.workbenchQueue=async(...args)=>{const q=structuredClone(await window.originalQueue(...args));q.items[0].subject.title={invalid:'render fixture'};return q;};window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}));`
    );
    await wait(`${root}.querySelector('.workspace-recovery')!==null`);
    assert.equal(await js(`document.querySelectorAll('.workspace-tab').length`), 3);
    await capture('tab-recovery');
    await js(
      `window.electronAPI.workbenchQueue=window.originalQueue;${root}.querySelector('.workspace-recovery button').click();`
    );
    await wait(`${root}.querySelector('.queue-list')!==null && !${root}.querySelector('.workspace-recovery')`);
    win.setSize(700, 740);
    win.webContents.setZoomFactor(1.5);
    await capture('narrow-zoom');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    win.webContents.setZoomFactor(1);

    console.log(
      'Tab hardening passed: overflow, keyboard menus/focus, close others, retry, renderer isolation and zoom'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    app.exit(1);
  }
});
