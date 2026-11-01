import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    window.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw Error(code + ': ' + String(error));
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 80));
  };
  const pop = async () => {
    if (!(await js("!!document.querySelector('.raw-file-filter-popover')"))) await click('Filter files');
  };
  const close = async () => {
    // The nested extension picker must finish closing before Escape targets its parent.
    await wait("!document.querySelector('.file-extension-popup')");
    await js(
      "document.querySelector('.raw-file-filter-popover')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.raw-file-filter-popover')");
  };
  const toggle = async (kind: number) => {
    await pop();
    await js(`document.querySelectorAll('.raw-file-filter-popover input')[${kind}].click()`);
    await wait("![...document.querySelectorAll('.raw-file-filter-popover input')].some(e=>e.disabled)");
    await close();
  };
  const shots = path.resolve('.impeccable/review/file-filters');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    window.show();
    window.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  const visibleFiles = () =>
    js<string[]>(
      "[...document.querySelectorAll('.commit-stream-row')].filter(e=>e.checkVisibility({visibilityProperty:true})).map(e=>e.dataset.file)"
    );
  const openPr = async () => {
    await js(
      `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])];void 0`
    );
    await waitForWorkbenchQueue(window.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-header, .file-filter-hidden')");
  };
  try {
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters`);
    await openPr();
    // Tree internals are library-owned; assert its visible file labels as well as diff rows.
    await wait('window.deepAll(\'[data-item-path="tests/__snapshots__/worker.snap"]\').length>0');
    assert.match(await js<string>("document.querySelector('.changes-progress').textContent"), /0 \/ 5/);
    await pop();
    await capture('desktop');
    await close();
    await toggle(0);
    await wait('!window.deepAll(\'[data-item-path="package-lock.json"]\').length>0');
    assert.equal((await visibleFiles()).includes('package-lock.json'), false);
    assert.equal((await visibleFiles()).includes('tests/__snapshots__/worker.snap'), false);
    assert.ok((await visibleFiles()).includes('tests/worker.test.ts'));
    await toggle(1);
    await wait('!window.deepAll(\'[data-item-path="tests/worker.test.ts"]\').length>0');
    assert.deepEqual((await visibleFiles()).sort(), ['src/other.ts', 'src/worker.ts']);
    assert.match(
      await js<string>("document.querySelector('.changes-progress').textContent"),
      /0 \/ 5/,
      'Hidden is not Viewed'
    );
    await capture('filtered');
    // A completed visible subset must not claim the full comparison is reviewed.
    await js(
      "[...document.querySelectorAll('.commit-stream-row button')].find(b=>b.textContent.trim()==='Viewed & next').click()"
    );
    await wait("document.querySelector('.changes-progress')?.textContent.includes('1 / 5')");
    assert.equal(await js("!!document.querySelector('.commit-viewed-complete')"), false);
    await click('Commits');
    await wait("!!document.querySelector('.commit-row') && !!document.querySelector('.changes-file-header')");
    await wait('window.deepAll(\'[data-item-path="src/worker.ts"]\').length>0');
    assert.equal(
      await js('window.deepAll(\'[data-item-path="tests/worker.test.ts"]\').length>0'),
      false,
      'Filters shared across tabs'
    );
    await capture('commits');
    await click('Changes');
    await wait("!!document.querySelector('.changes-file-header')");
    await pop();
    await click('Show hidden files');
    await close();
    await wait('window.deepAll(\'[data-item-path="package-lock.json"]\').length>0');
    // Per-path false override keeps a known lockfile visible, with automatic reset.
    await js(
      "document.querySelector('.commit-diff-stream').scrollTop=0; document.querySelector('.commit-diff-stream').dispatchEvent(new WheelEvent('wheel',{bubbles:true}))"
    );
    await click('File classification for package-lock.json');
    await wait("!!document.querySelector('[role=menu]')");
    assert.match(await js<string>("document.querySelector('[role=menu]').getAttribute('aria-describedby')"), /.+/);
    assert.equal(await js("document.querySelector('.file-kind-reasons')?.closest('[aria-disabled=true]')"), null);
    await capture('classification');
    await click('Treat as not generated');
    await toggle(0);
    await wait('window.deepAll(\'[data-item-path="package-lock.json"]\').length>0');
    assert.equal(await js('window.deepAll(\'[data-item-path="tests/__snapshots__/worker.snap"]\').length>0'), false);
    await click('File classification for package-lock.json');
    await click('Use automatic classification');
    await wait('!window.deepAll(\'[data-item-path="package-lock.json"]\').length>0');
    assert.notEqual(
      await js("document.querySelector('.commit-stream-row[data-active=true]')?.dataset.file"),
      'package-lock.json'
    );
    // New repository evidence is explicit; reading does not make files disappear.
    await js(
      "(async()=>{const snapshot=await window.electronAPI.getPrChanges('https://github.com/klang/engine/pull/150');window.dispatchEvent(new CustomEvent('fixture-file-classifications',{detail:snapshot}));})()"
    );
    await wait("document.body.textContent.includes('Apply updated file filters')");
    assert.ok((await visibleFiles()).includes('src/worker.ts'));
    await capture('pending');
    await click('Apply updated file filters');
    await wait("!document.querySelector('.changes-file-tree')");
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Review PR #150')?.disabled"),
      false
    );
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Drafts')?.disabled"),
      false
    );
    assert.match(
      await js<string>(
        "document.getElementById(document.querySelector('[aria-label=\"Filter files\"]').getAttribute('aria-describedby')).textContent"
      ),
      /5 hidden/
    );
    await capture('empty');
    await click('Show hidden files');
    await wait("!!document.querySelector('.changes-file-tree')");
    // Recover a failed save without losing previous filters.
    await js("sessionStorage.setItem('fixture-fail-file-filters','yes')");
    await toggle(1);
    await wait("document.querySelector('[role=alert]')?.textContent.includes('Could not save file filters')");
    await js("sessionStorage.removeItem('fixture-fail-file-filters')");
    await click('Retry file filters');
    await wait("!document.querySelector('[role=alert]')");
    await wait('!window.deepAll(\'[data-item-path="tests/worker.test.ts"]\').length>0');
    // Reload is a fresh renderer/store instance, preserving only durable mock storage.
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters`);
    await openPr();
    await pop();
    assert.equal(await js("document.querySelectorAll('.raw-file-filter-popover input')[1].checked"), true);
    await capture('persisted');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    window.setContentSize(900, 740);
    await capture('laptop');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    window.setContentSize(640, 800);
    await capture('narrow');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    window.setContentSize(1280, 800);
    await close();
    await js("document.documentElement.classList.remove('dark')");
    // Entirely hidden stack members retain identity and a reveal action.
    await toggle(0);
    await click('Review queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open stack overview');
    await click('Changes');
    await wait("document.querySelector('.file-filter-group')?.textContent.includes('PR #120')");
    assert.match(await js<string>("document.querySelector('.file-filter-group').textContent"), /1 file hidden/);
    await capture('stack');
    // Extension exclusions are a persistent noise filter, combined with both category filters.
    await js(
      'window.electronAPI.updateFileFilters({filters:{hideGenerated:false,hideTests:false,hiddenExtensions:[]}})'
    );
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters&extension-files`);
    await openPr();
    await pop();
    await click('File extensions');
    await wait('!!document.querySelector(\'[data-slot=combobox-item][data-value=".ts"]\')');
    await capture('extensions-light');
    await js('document.querySelector(\'[data-slot=combobox-item][data-value=".ts"]\').click()');
    await wait("window.electronAPI.loadFileFilters().then(s=>s.hiddenExtensions.includes('.ts'))");
    if (await js("!!document.querySelector('.file-extension-popup')")) await click('Done');
    await close();
    await wait('!window.deepAll(\'[data-item-path="src/worker.ts"]\').length');
    assert.equal(await js('window.deepAll(\'[data-item-path="tests/worker.test.ts"]\').length'), 0);
    assert.match(await js<string>("document.querySelector('.changes-progress').textContent"), /0 \/ 7/);
    await pop();
    await click('File extensions');
    await js('document.querySelector(\'[data-slot=combobox-item][data-value=".snap"]\').click()');
    await wait("window.electronAPI.loadFileFilters().then(s=>s.hiddenExtensions.includes('.snap'))");
    if (await js("!!document.querySelector('.file-extension-popup')")) await click('Done');
    await close();
    await wait('!window.deepAll(\'[data-item-path="tests/__snapshots__/worker.snap"]\').length');
    await toggle(0);
    await wait('!window.deepAll(\'[data-item-path="package-lock.json"]\').length');
    await pop();
    await click('File extensions');
    await js("document.querySelector('[data-slot=combobox-item][data-value=no-extension]').click()");
    await wait("window.electronAPI.loadFileFilters().then(s=>s.hiddenExtensions.includes(''))");
    if (await js("!!document.querySelector('.file-extension-popup')")) await click('Done');
    await close();
    await wait("!document.querySelector('.changes-file-tree')");
    await capture('extensions-empty');
    await click('Commits');
    await wait("!!document.querySelector('.commit-row')");
    await wait("document.querySelector('[aria-label=\"Filter files\"]')?.textContent.includes('7 hidden')");
    await pop();
    await click('File extensions');
    assert.equal(await js("document.querySelector('[data-value=\".ts\"]').getAttribute('aria-selected')"), 'true');
    await click('Done');
    await close();
    // Choices persist across a new renderer; search and keyboard selection still work.
    await loadWorkbenchPage(window, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?pr-summary&file-filters&extension-files`);
    await openPr();
    await pop();
    await click('File extensions');
    assert.equal(await js("document.querySelector('[data-value=\".snap\"]').getAttribute('aria-selected')"), 'true');
    await js("document.documentElement.classList.add('dark')");
    await capture('extensions-dark');
    window.setContentSize(900, 740);
    await capture('extensions-laptop');
    window.setContentSize(640, 800);
    await capture('extensions-narrow');
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false);
    window.setContentSize(1280, 800);
    await click('Done');
    await click('Clear');
    await wait('window.electronAPI.loadFileFilters().then(s=>!s.hiddenExtensions.length)');
    await click('Show hidden files');
    await close();
    if (await js("!document.querySelector('.changes-tree-pane')")) await js("document.querySelector('.changes-toolbar button').click()");
    await wait("!!document.querySelector('.changes-file-tree')");
    await pop();
    await click('File extensions');
    await js('document.querySelector(\'[aria-label="Search file extensions"]\').focus()');
    await window.webContents.insertText('.ts');
    await wait("document.querySelectorAll('[data-slot=combobox-item]').length===1");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait("window.electronAPI.loadFileFilters().then(s=>s.hiddenExtensions.includes('.ts'))");
    if (await js("!!document.querySelector('.file-extension-popup')")) await click('Done');
    await close();
    await click('Review queue');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open stack overview');
    await click('Commits');
    await wait("!!document.querySelector('.commit-row')");
    await pop();
    await click('File extensions');
    await wait("document.querySelector('[data-value=\".ts\"]')?.textContent.includes('0')");
    await capture('extensions-absent');
    await click('Done');
    await click('Clear');
    console.log('File filters browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await js('document.body.innerText'));
    await capture('failure');
    app.exit(1);
  }
});
