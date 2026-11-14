import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

// Notifications in the app: routed toasts, the introduction, Settings › Notifications and click-through.
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const shots = path.resolve('.impeccable/review/notifications');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const url = 'https://github.com/klang/engine/pull/120';
  const delivery = (extra: Record<string, unknown> = {}) => ({
    id: `n-${Math.random()}`,
    kind: 'checks-failed',
    title: 'Checks failed',
    body: 'Introduce a bounded command queue',
    subtitle: 'klang/engine #120',
    url,
    target: { kind: 'pr', pr: { host: 'github.com', owner: 'klang', repo: 'engine', number: 120 }, tab: 'checks' },
    keys: ['checks-failed|x'],
    types: ['checks-failed'],
    ...extra,
  });
  const push = (message: unknown) =>
    js(`window.dispatchEvent(new CustomEvent('fixture-notification',{detail:${JSON.stringify(message)}}))`);
  const clickText = (selector: string, text: string) =>
    js(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?notifications`);
    await waitForWorkbenchQueue(win.webContents);
    win.focus();

    // A pushed PR event: a toast with an icon, a text status and one action. Not a dialog.
    await push({ type: 'show', delivery: delivery({ introduce: true }) });
    await wait("!!document.querySelector('.app-toast[data-kind=checks-failed]')");
    const shape = await js<{ role: string | null; description: string | null; modal: string | null; dialog: boolean; icon: boolean; title: string; subtitle: string; actions: string[] }>(`(()=>{
      const t=document.querySelector('.app-toast[data-kind=checks-failed]');
      return {role:t.getAttribute('role'),description:t.getAttribute('aria-roledescription'),modal:t.getAttribute('aria-modal'),
        dialog:t.matches('[role=dialog]')||!!document.querySelector('.app-toast[role=dialog]'),
        icon:!!t.querySelector('svg.app-toast-icon'),title:t.querySelector('.app-toast-title').textContent,
        subtitle:t.querySelector('.app-toast-subtitle')?.textContent??'',
        actions:[...t.querySelectorAll('.app-toast-action')].map(b=>b.textContent.trim())};
    })()`);
    assert.equal(shape.dialog, false, 'Toasts must not be role=dialog');
    assert.equal(shape.role, 'group');
    assert.equal(shape.description, 'notification');
    assert.equal(shape.modal, null);
    assert.equal(shape.icon, true);
    assert.equal(shape.title, 'Checks failed');
    assert.equal(shape.subtitle, 'klang/engine #120');
    assert.deepEqual(shape.actions, ['Open checks', 'Turn on']);
    assert.equal(await js("document.querySelector('.app-toasts').getAttribute('aria-live')"), 'polite');

    // The introduction appears on the first PR-event toast only, and Turn on asks main once.
    assert.match(await js<string>("document.querySelector('.app-toast-introduce').textContent"), /Get these on your desktop when Gnosis is in the background\?/);
    await capture('introduction-dark');
    await js("document.documentElement.classList.remove('dark')");
    await capture('introduction-light');
    await js("document.documentElement.classList.add('dark')");
    await clickText('.app-toast-introduce button', 'Turn on');
    await wait("!document.querySelector('.app-toast-introduce')");
    assert.deepEqual(await js('window.fixtureNotificationCalls'), ['introduce:true']);
    await push({ type: 'show', delivery: delivery({ kind: 'approved', title: 'maya approved', target: { kind: 'pr', pr: { host: 'github.com', owner: 'klang', repo: 'engine', number: 121 }, tab: 'summary' }, url: 'https://github.com/klang/engine/pull/121' }) });
    await wait("!!document.querySelector('.app-toast[data-kind=approved]')");
    assert.equal(await js("!!document.querySelector('.app-toast[data-kind=approved] .app-toast-introduce')"), false);

    // Keyboard: the action and the dismiss button are reachable; dismiss is counted locally.
    await js("document.querySelector('.app-toast[data-kind=approved] [aria-label=\"Dismiss notification\"]').focus()");
    assert.equal(await js("document.activeElement.getAttribute('aria-label')"), 'Dismiss notification');
    await js("document.activeElement.click()");
    await wait("!document.querySelector('.app-toast[data-kind=approved]')");
    assert.ok((await js<string[]>('window.fixtureNotificationActions')).includes('approved:dismissed'));

    // Marking a PR read closes its toasts.
    await push({ type: 'show', delivery: delivery({ kind: 'ready-to-merge', title: 'Ready to merge', url: 'https://github.com/klang/engine/pull/122' }) });
    await wait("!!document.querySelector('.app-toast[data-kind=ready-to-merge]')");
    await push({ type: 'close', urls: ['https://github.com/klang/engine/pull/122'] });
    await wait("!document.querySelector('.app-toast[data-kind=ready-to-merge]')");

    // Reduced motion: no toast transition.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js("getComputedStyle(document.querySelector('.app-toast')).transitionDuration"), '0s');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();

    // The action opens the PR on the right tab.
    await clickText('.app-toast[data-kind=checks-failed] .app-toast-action', 'Open checks');
    await wait("document.querySelector('[role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Checks')");
    assert.ok((await js<string[]>('window.fixtureNotificationActions')).includes('checks-failed:clicked'));
    await wait("window.fixtureNotificationContext === 'https://github.com/klang/engine/pull/120'");

    // A desktop notification click arrives as a deep link: Feedback on another PR, in its own tab.
    const tabs = await js<number>('document.querySelectorAll(".workspace-tab").length');
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:121},tab:'feedback'}}))`);
    await wait("document.querySelector('[role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Feedback')");
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), tabs + 1);
    // The same PR again reuses its tab.
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:121},tab:'summary'}}))`);
    await wait("document.querySelector('[role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Summary')");
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), tabs + 1);

    // Settings › Notifications.
    await wait("!!document.querySelector('.workspace-menu-trigger')");
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('.settings-tabs')");
    await js("[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(t=>t.textContent==='Notifications').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait("!!document.querySelector('#notifications-where-title')");
    const switches = await js<Record<string, string>>("Object.fromEntries([...document.querySelectorAll('.settings-panel [role=switch]')].filter(s=>s.offsetParent).map(s=>[s.getAttribute('aria-label'),s.getAttribute('aria-checked')]))");
    assert.equal(switches['Desktop notifications'], 'true');
    assert.equal(switches['In-app notifications'], 'true');
    assert.equal(switches['Review requested from you'], 'true');
    assert.equal(switches['Requested from your team'], 'false', 'Team requests are off by default');
    for (const label of ['Changes requested', 'Approved', 'Checks failed', 'Ready to merge', 'Explanation ready', 'Update ready']) assert.equal(switches[label], 'true', label);
    assert.equal(await js("[...document.querySelectorAll('.settings-panel [role=switch]')].some(s=>s.getAttribute('aria-label')==='Desktop notifications'&&!s.closest('[data-state=active]'))"), false, 'The desktop switch moved out of Integrations');
    await js("document.querySelector('[role=switch][aria-label=\"Approved\"]').click()");
    await wait("window.electronAPI.loadPreferences().then(p=>p.notificationSettings?.events?.approved===false)");
    await clickText('.settings-panel button', 'Send test notification');
    await wait("[...document.querySelectorAll('.settings-panel [role=status]')].some(s=>s.textContent.includes('Sent a test notification'))");
    await clickText('.settings-panel button', 'Pause for 1 hour');
    await wait("[...document.querySelectorAll('.settings-panel .settings-row')].some(r=>r.textContent.includes('Paused until'))");
    await capture('settings-paused');
    await clickText('.settings-panel button', 'Resume');
    await wait("[...document.querySelectorAll('.settings-panel button')].some(b=>b.textContent.trim()==='Pause for 1 hour')");
    assert.deepEqual(await js('window.fixtureNotificationCalls'), ['introduce:true', 'test', 'pause:true', 'pause:false']);
    console.log('Notification checks passed: non-dialog toasts with kinds, introduction, keyboard dismiss, close on read, reduced motion, click-through, deep links, Settings. Screenshots: ' + shots);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    app.exit(1);
  }
});
