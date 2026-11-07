import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false, partition: 'sidebar-layout-test' },
  });
  const js = async <T = unknown>(code: string): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      throw new Error(`Browser assertion failed: ${code}\n${String(error)}`);
    }
  };
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(code);
  };
  const click = async (selector: string) => {
    const desktopToggle =
      (selector.includes('Collapse sidebar') || selector.includes('Expand sidebar')) &&
      (await js("!matchMedia('(max-width:850px)').matches"));
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (desktopToggle)
      await wait(
        `document.querySelector('.workbench-sidebar').dataset.collapsed === '${selector.includes('Collapse') ? 'true' : 'false'}'`
      );
    await wait(
      "document.querySelector('.workbench-sidebar').getAnimations({subtree:true}).every(a=>a.playState==='finished')"
    );
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.mkdirSync('/tmp/gnosis-sidebar', { recursive: true });
    fs.writeFileSync('/tmp/gnosis-sidebar/' + name + '.png', (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url + '?polish&keep-progress');
    win.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(win.webContents);
    await capture('expanded-light');
    const shortcut = () =>
      js(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', metaKey: window.electronAPI.platform === 'darwin', ctrlKey: window.electronAPI.platform !== 'darwin', bubbles: true }))`
      );
    await shortcut();
    await wait("document.querySelector('.workbench-sidebar').dataset.collapsed==='true'");
    await wait(
      "document.querySelector('.workbench-sidebar').getAnimations({subtree:true}).every(a=>a.playState==='finished')"
    );
    await shortcut();
    await wait("document.querySelector('.workbench-sidebar').dataset.collapsed==='false'");
    await wait(
      "document.querySelector('.workbench-sidebar').getAnimations({subtree:true}).every(a=>a.playState==='finished')"
    );
    await click('.sidebar-group-reviews .sidebar-group-toggle');
    assert.equal(
      await js("document.querySelector('.sidebar-group-reviews [aria-expanded]').getAttribute('aria-expanded')"),
      'false'
    );
    assert.equal(
      await js("document.querySelector('.sidebar-group-reviews [aria-current=page]').checkVisibility()"),
      false
    );
    assert.equal(await js("document.querySelector('.sidebar-current').textContent"), 'Review queue');
    await click('[aria-label="Collapse sidebar"]');
    assert.equal(await js("document.querySelector('.workbench-sidebar').getBoundingClientRect().width"), 52);
    await js(`document.querySelector('.workbench-sidebar [aria-label="Starred"]').focus()`);
    await wait("Array.from(document.querySelectorAll('[role=tooltip]')).some(el=>el.textContent==='Starred')");
    await click('.workbench-sidebar [aria-label="Starred"]');
    await wait("document.querySelector('.queue-toolbar h1').textContent==='Starred'");
    await click('[aria-label="Expand sidebar"]');
    assert.equal(
      await js("document.querySelector('.sidebar-group-reviews [aria-expanded]').getAttribute('aria-expanded')"),
      'false'
    );
    await capture('folded');
    await js('setTimeout(() => location.reload(), 0)');
    await new Promise((r) => setTimeout(r, 300));
    await wait("!!document.querySelector('.sidebar-group-reviews [aria-expanded]')");
    assert.equal(
      await js("document.querySelector('.sidebar-group-reviews [aria-expanded]').getAttribute('aria-expanded')"),
      'false'
    );
    await click('.sidebar-group-reviews .sidebar-group-toggle');
    await click('.workbench-sidebar [aria-label="Review queue"]');
    // Create actual saved views through the fixture API, then refresh the shared queue.
    await js(
      `(async()=>{for(let i=0;i<24;i++)await window.electronAPI.workbenchViewAction({type:'create',name:i===0?'Release work needing my review':'Saved view '+(i+1)});document.querySelector('[aria-label="Refresh queue"]').click()})()`
    );
    await wait("document.querySelectorAll('.saved-view-row').length===24");
    await capture('many-views');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    await click('[aria-label="Collapse sidebar"]');
    await click('.sidebar-views-trigger');
    await wait("!!document.querySelector('.sidebar-views-popup .saved-view-link')");
    await wait("document.activeElement?.classList.contains('saved-view-link')");
    assert.equal(await js("document.activeElement.getAttribute('aria-current')"), 'page');
    await js("document.querySelector('.sidebar-views-popup .saved-view-link').focus()");
    await wait(
      "Array.from(document.querySelectorAll('[role=tooltip]')).some(el=>el.textContent.includes('Release work needing my review'))"
    );
    await capture('rail-picker');
    await click('.sidebar-views-popup .saved-view-link');
    await wait("!document.querySelector('.sidebar-views-popup')");
    await wait("document.querySelector('.queue-toolbar h1').textContent==='Release work needing my review'");
    await js("document.documentElement.classList.add('dark')");
    await capture('rail-dark');
    await click('[aria-label="Expand sidebar"]');
    await capture('expanded-dark');
    win.setSize(640, 740);
    await wait("document.querySelector('.workbench-sidebar').dataset.collapsed==='true'");
    await click('[aria-label="Expand sidebar"]');
    await wait('!!document.querySelector(\'.sidebar-popup[aria-label="Workspace navigation"]\')');
    await capture('narrow-navigation');
    await js('document.querySelector(\'.sidebar-popup [aria-label="Review queue"]\').focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('.sidebar-popup')");
    assert.equal(await js("document.activeElement.getAttribute('aria-label')"), 'Expand sidebar');
    win.setSize(1280, 800);
    await wait("document.querySelector('.workbench-sidebar').dataset.collapsed==='false'");
    win.webContents.setZoomFactor(2);
    await capture('zoom');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    console.log(
      'Sidebar passed: section and rail persistence, navigation, saved-view picker, large lists, themes, narrow layout, keyboard focus, zoom.'
    );
    win.webContents.setZoomFactor(1);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.webContents.setZoomFactor(1);
    app.exit(1);
  }
});
