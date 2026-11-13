import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out: ${code}`);
  };
  /** A trusted key press through the DevTools protocol: Space, Enter or a digit. */
  const press = async (name: 'Space' | 'Enter' | `${number}`) => {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const key = name === 'Space' ? ' ' : name;
    const code = name === 'Space' ? 'Space' : name === 'Enter' ? 'Enter' : `Digit${name}`;
    const windowsVirtualKeyCode = name === 'Space' ? 32 : name === 'Enter' ? 13 : name.charCodeAt(0);
    const text = name === 'Enter' ? '\r' : key;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    await new Promise((r) => setTimeout(r, 50));
  };
  const saved = (check: string) => wait(`window.electronAPI.loadPreferences().then(p => ${check})`);
  const openIntegrations = async () => {
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog] [role=tab]:not(.workspace-tab-select)')");
    await click('Integrations');
    await wait("!!document.querySelector('#preloading-title')");
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await openIntegrations();
    await wait("!!document.querySelector('#github-cache-title')");
    // Preloading is its own group in Integrations, before the GitHub cache, with four controls at their defaults.
    const section = "document.querySelector('#preloading-title').parentElement";
    assert.equal(await js("document.querySelector('#preloading-title').textContent"), 'Preloading');
    assert.equal(
      await js("!!(document.querySelector('#preloading-title').compareDocumentPosition(document.querySelector('#github-cache-title')) & Node.DOCUMENT_POSITION_FOLLOWING)"),
      true
    );
    const toggle = "document.querySelector('[role=switch][aria-label=\"Preload likely next pages\"]')";
    const queueToggle = "document.querySelector('[role=switch][aria-label=\"Prepare the top of the queue\"]')";
    const chip = (label: string) => `[...${section}.querySelectorAll('[role=group] button')].find(b=>b.textContent==='${label}')`;
    assert.equal(await js(`${toggle}?.closest('section')===${section}`), true, 'The existing switch moved here');
    assert.equal(await js(`${toggle}?.getAttribute('aria-checked')`), 'true');
    assert.equal(await js(`${queueToggle}?.getAttribute('aria-checked')`), 'true');
    assert.match(await js<string>(`${toggle}.closest('.settings-row').textContent`), /Prepares the tabs of an opened PR and anything you point at/);
    assert.match(await js<string>(`${queueToggle}.closest('.settings-row').textContent`), /PRs near the top of the queue/);
    assert.deepEqual(await js(`[...${section}.querySelectorAll('[role=group] button')].map(b=>[b.textContent,b.getAttribute('aria-pressed')])`),
      [['Light', 'false'], ['Normal', 'true'], ['Eager', 'false']]);
    assert.equal(await js("document.querySelector('[role=group][aria-labelledby=preload-amount-label]').getAttribute('aria-describedby')"), 'preload-amount-description');
    assert.match(await js<string>("document.querySelector('#preload-amount-description').textContent"), /three files, the workflow graph and failing check details/);
    assert.match(await js<string>("document.querySelector('#preload-budget').textContent"), /6% of the hourly limit \(default\)/);
    await wait("document.querySelector('[data-testid=preload-spend]').textContent.includes('42 of 300 requests')");
    assert.match(await js<string>("document.querySelector('[data-testid=preload-spend]').textContent"), /^This hour: 42 of 300 requests · 7 of 300 GraphQL points$/);
    // Light and dark screenshots of the section.
    const shots = path.resolve('.impeccable/review/preloading');
    fs.mkdirSync(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
      await js(`${section}.scrollIntoView({block:'start'})`);
      await js('document.fonts.ready');
      // Let the chips' colour transitions finish after the theme change.
      await new Promise((r) => setTimeout(r, 800));
      const rect = await js<{ x: number; y: number; width: number; height: number }>(
        "(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),width:Math.ceil(Math.min(r.width,innerWidth)),height:Math.ceil(Math.min(r.height,innerHeight))}})()"
      );
      fs.writeFileSync(path.join(shots, `${theme}.png`), (await win.webContents.capturePage(rect)).toPNG());
    }
    await js("document.documentElement.classList.toggle('dark',false)");
    // Every control works from the keyboard.
    await js(`${queueToggle}.focus()`);
    await press('Space');
    await wait(`${queueToggle}.getAttribute('aria-checked')==='false'`);
    await saved('p.prepareQueue === false');
    await js(`${chip('Eager')}.focus()`);
    await press('Enter');
    await wait(`${chip('Eager')}.getAttribute('aria-pressed')==='true'`);
    assert.equal(await js(`${chip('Normal')}.getAttribute('aria-pressed')`), 'false');
    assert.match(await js<string>("document.querySelector('#preload-amount-description').textContent"), /six files, failing job logs/);
    await saved("p.preloadAmount === 'eager'");
    await js("document.querySelector('#preload-budget').focus()");
    await press('1');
    await press('0');
    await wait("[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.startsWith('10%'))");
    await press('Enter');
    await wait("document.querySelector('#preload-budget').textContent.includes('10% of the hourly limit')");
    await saved('p.preloadBudgetPercent === 10');
    await wait("document.querySelector('[data-testid=preload-spend]').textContent.includes('42 of 500 requests')");
    // Saved settings come back after a reload.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await openIntegrations();
    await wait(`${chip('Eager')}.getAttribute('aria-pressed')==='true'`);
    assert.equal(await js(`${queueToggle}.getAttribute('aria-checked')`), 'false');
    assert.match(await js<string>("document.querySelector('#preload-budget').textContent"), /10% of the hourly limit/);
    // Back to the defaults, by keyboard too.
    await js(`${chip('Normal')}.focus()`);
    await press('Space');
    await js(`${queueToggle}.focus()`);
    await press('Enter');
    await saved("p.preloadAmount === 'normal' && p.prepareQueue === true");
    await js(`${toggle}.focus()`);
    await press('Space');
    await wait(`${toggle}.getAttribute('aria-checked')==='false'`);
    await saved('p.predictNavigation === false');
    assert.match(await js<string>("document.querySelector('#github-cache-size').textContent"), /512 MB/);
    await js("window.selectOption('#github-cache-size','1024')");
    await wait("document.querySelector('#github-cache-size').textContent.includes('1 GB')");
    await wait("window.electronAPI.loadPreferences().then(p => p.githubCacheSizeMB === 1024)");
    assert.match(
      await js<string>("document.querySelector('#github-cache-title').parentElement.textContent"),
      /Saved reviews, briefings, bookmarks, settings, and sign-in stay/
    );
    await js(
      "window.clearCalls=0;window.electronAPI.clearGitHubCache=async()=>{window.clearCalls++;throw Error('Wait for active AI tasks to finish, then clear the cache again.')};void 0;"
    );
    await click('Clear cache & restart');
    await wait("document.querySelector('[role=alert]')?.textContent.includes('Wait for active AI tasks')");
    assert.equal(await js('window.clearCalls'), 1);
    const dir = path.resolve('.impeccable/review/cache-reset');
    fs.mkdirSync(dir, { recursive: true });
    for (const [width, theme] of [
      [1280, 'light'],
      [640, 'dark'],
    ] as const) {
      win.setSize(width, 800);
      await js(`document.documentElement.classList.toggle('dark',${theme === 'dark'})`);
      await js('document.fonts.ready');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.equal(
        await js(
          "(()=>{const r=document.querySelector('#github-cache-title').parentElement.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"
        ),
        true
      );
      fs.writeFileSync(path.join(dir, `${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await js('window.electronAPI.clearGitHubCache=async()=>{window.clearCalls++};void 0;');
    await click('Clear cache & restart');
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Restarting…'&&b.disabled)");
    assert.equal(await js('window.clearCalls'), 2);
    assert.equal(await js("!!document.querySelector('[role=alert]')"), false);

    // With "Preload likely next pages" off, opening a PR predicts nothing and resting on a queue row prepares nothing.
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length>0");
    await js(`(()=>{
      const hex=s=>{const h=Array.from(s,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');return h.length>=40?h.slice(-40):h.padEnd(40,'0')};
      const load=window.electronAPI.workbenchQueue;
      window.electronAPI.workbenchQueue=async(...args)=>{const q=await load(...args);return {...q,items:q.items.map(i=>({...i,subject:{...i.subject,members:i.subject.members.map(m=>({...m,headSha:hex(m.headSha),baseSha:hex(m.baseSha)}))}}))}};
      window.predicted=[];window.rowIntents=[];
      for(const name of ['getPrChanges','getPrCommits']){const read=window.electronAPI[name];window.electronAPI[name]=(url,refresh,options)=>{if(options?.predicted)window.predicted.push(name);return read(url,refresh,options)}}
      const file=window.electronAPI.getPrChangeFile;window.electronAPI.getPrChangeFile=(request,mode)=>{if(mode&&typeof mode==='object')window.predicted.push('file');return file(request,mode)};
      window.electronAPI.prOpenCommitted=()=>{window.predicted.push('open');return Promise.resolve()};
      window.electronAPI.prOpenIntent=targets=>{window.rowIntents.push(targets&&targets.map(t=>t.url))};
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-description')");
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(await js('window.predicted'), [], 'No prediction runs while the setting is off');
    assert.equal(await js('window.__gnosisPredict.summary().predictions'), 0);
    assert.ok((await js<number>('window.__gnosisPredict.records().length')) > 0, 'Navigation is still measured');
    await click('Review queue');
    const row = "[...document.querySelectorAll('[data-queue-id]')].find(r=>r.textContent.includes('Reduce allocations'))";
    await wait(`!!${row}`);
    await js(`(async()=>{const row=${row};row.querySelector('.queue-row-main').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await new Promise(r=>setTimeout(r,300));})()`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await js('window.rowIntents.some(urls=>urls&&urls.length>0)'), false, 'Queue-row hover is intent preloading too');
    assert.deepEqual(await js('window.predicted'), []);

    // "Prepare the top of the queue" off: the queue sends nothing to prepare; on again, it sends its rows.
    await js(`(()=>{window.queuePreloads=[];const send=window.electronAPI.prOpenPreload;window.electronAPI.prOpenPreload=targets=>{window.queuePreloads.push(targets.length);return send?.(targets)}})()`);
    await openIntegrations();
    await js(`${queueToggle}.click()`);
    await saved('p.prepareQueue === false');
    await wait('window.queuePreloads.at(-1)===0');
    await js("document.dispatchEvent(new Event('visibilitychange'))");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await js('window.queuePreloads.at(-1)'), 0, 'Nothing is prepared for queue position alone');
    await js(`${queueToggle}.click()`);
    await saved('p.prepareQueue === true');
    await wait('window.queuePreloads.at(-1)>0');
    // Leave the settings as they were.
    await js(`${toggle}.click()`);
    await saved('p.predictNavigation === true');
    console.log(
      'Cache reset Settings checks passed: Preloading controls, keyboard, persistence, intent and queue switches, clear scope, restart label, error recovery, disabled pending action, laptop/compact layouts.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
