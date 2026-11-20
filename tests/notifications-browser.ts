import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import { menuAction } from './entry-menu-helpers';
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
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?notifications&threads`);
    await waitForWorkbenchQueue(win.webContents);
    win.focus();

    // A PR's row menu sets its repository's notification level (#385). The current level is marked and disabled.
    const menuLabels = async () => {
      await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&b.getAttribute('aria-label')==='Actions for PR #152');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()`);
      await wait("[...document.querySelectorAll('[role=menuitem]')].some(i=>i.textContent.startsWith('Notifications from'))");
      const labels = await js<{ label: string; disabled: boolean }[]>("[...document.querySelectorAll('[role=menuitem]')].filter(i=>i.textContent.startsWith('Notifications from')).map(i=>({label:i.textContent,disabled:i.hasAttribute('data-disabled')||i.getAttribute('aria-disabled')==='true'}))");
      await js("document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("!document.querySelector('[role=menuitem]')");
      return labels;
    };
    assert.deepEqual(await menuLabels(), [
      { label: 'Notifications from klang/engine: AllCurrent', disabled: true },
      { label: 'Notifications from klang/engine: On me', disabled: false },
      { label: 'Notifications from klang/engine: None', disabled: false },
    ]);
    await menuAction(js, 'Actions for PR #152', 'Notifications from klang/engine: On me');
    await wait("window.electronAPI.loadPreferences().then(p=>p.repositorySettings?.['klang/engine']?.notifications==='on-me')");
    assert.equal((await menuLabels()).find((item) => item.disabled)?.label, 'Notifications from klang/engine: On meCurrent');

    // One notification per PR: a newer toast for the same PR replaces the older one.
    await push({ type: 'show', delivery: delivery({ kind: 'reply', title: 'New reply', url: 'https://github.com/klang/engine/pull/123', keys: ['r1'], types: ['reply'] }) });
    await wait("!!document.querySelector('.app-toast[data-kind=reply]')");
    await push({ type: 'show', delivery: delivery({ kind: 'changes-requested', title: 'lena requested changes', url: 'https://github.com/klang/engine/pull/123', keys: ['c1'], types: ['changes-requested'] }) });
    await wait("!!document.querySelector('.app-toast[data-kind=changes-requested]') && !document.querySelector('.app-toast[data-kind=reply]')");
    await push({ type: 'close', urls: ['https://github.com/klang/engine/pull/123'] });
    await wait("!document.querySelector('.app-toast[data-kind=changes-requested]')");

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
    await wait("document.querySelector('.workspace-panel[data-workspace-active=true] [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Checks')");
    assert.ok((await js<string[]>('window.fixtureNotificationActions')).includes('checks-failed:clicked'));
    await wait("window.fixtureNotificationContext === 'https://github.com/klang/engine/pull/120'");

    // A desktop notification click arrives as a deep link: Feedback on another PR, in its own tab.
    const tabs = await js<number>('document.querySelectorAll(".workspace-tab").length');
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:121},tab:'feedback'}}))`);
    await wait("document.querySelector('.workspace-panel[data-workspace-active=true] [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Summary')");
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), tabs + 1);
    // The same PR again reuses its tab.
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:121},tab:'summary'}}))`);
    await wait("document.querySelector('.workspace-panel[data-workspace-active=true] [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent.startsWith('Summary')");
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), tabs + 1);

    // #385 part 2: a mention lands on its thread, in the tab that already shows the PR, and offers local actions.
    const pr121 = { host: 'github.com', owner: 'klang', repo: 'engine', number: 121 };
    const activeTab = "document.querySelector('.workspace-panel[data-workspace-active=true] [role=tab]:not(.workspace-tab-select)[aria-selected=true]')?.textContent";
    const selectedThread = "document.querySelector('.workspace-panel[data-workspace-active=true] [data-feedback-id][aria-current=true]')?.getAttribute('data-feedback-id')";
    await push({ type: 'show', delivery: delivery({
      kind: 'mention', title: 'Mentioned · Route worker commands', body: "maya: 'Should cancellation release the queue slot?'",
      subtitle: 'klang/engine #121', url: 'https://github.com/klang/engine/pull/121',
      target: { kind: 'pr', pr: pr121, tab: 'feedback', threadId: 'thread-left' },
      reply: { kind: 'thread', prUrl: 'https://github.com/klang/engine/pull/121', threadId: 'thread-left', to: 'maya' },
      keys: ['comment|121|left'], types: ['mention'],
    }) });
    await wait("!!document.querySelector('.app-toast[data-kind=mention]')");
    const mention = await js<{ title: string; icon: boolean; tone: string | null; actions: string[]; secondary: string[] }>(`(()=>{
      const t=document.querySelector('.app-toast[data-kind=mention]');
      return {title:t.querySelector('.app-toast-title').textContent,icon:!!t.querySelector('svg.app-toast-icon.lucide-at-sign'),tone:t.getAttribute('data-tone'),
        actions:[...t.querySelectorAll('.app-toast-action')].map(b=>b.textContent.trim()),secondary:[...t.querySelectorAll('.app-toast-secondary')].map(b=>b.textContent.trim())};
    })()`);
    assert.equal(mention.title, 'Mentioned · Route worker commands', 'the event first, in words');
    assert.equal(mention.icon, true, 'the mention icon');
    assert.equal(mention.tone, 'attention');
    assert.deepEqual(mention.actions, ['Open thread']);
    assert.deepEqual(mention.secondary, ['Snooze 1 h', 'Mark read']);
    await capture('mention-toast');
    const before = await js<number>('document.querySelectorAll(".workspace-tab").length');
    await clickText('.app-toast[data-kind=mention] .app-toast-action', 'Open thread');
    await wait(`${activeTab}?.startsWith('Summary')`);
    await wait(`${selectedThread} === 'thread-left'`);
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), before, 'the tab that shows the PR is reused');
    await capture('mention-thread');

    // A desktop click on a reply to a PR that is not open: a new tab, on that thread.
    await js(`window.dispatchEvent(new CustomEvent('fixture-deep-link',{detail:${JSON.stringify({ kind: 'pr', pr: { ...pr121, number: 122 }, tab: 'feedback', threadId: 'thread-right' })}}))`);
    await wait(`${activeTab}?.startsWith('Summary') && ${selectedThread} === 'thread-right'`);
    assert.equal(await js<number>('document.querySelectorAll(".workspace-tab").length'), before + 1);
    await wait("window.fixtureNotificationContext === 'https://github.com/klang/engine/pull/122'");

    // Mark read on the toast is local: main gets the PR URL only.
    await push({ type: 'show', delivery: delivery({ kind: 'reply', title: 'Reply · Route worker commands', url: 'https://github.com/klang/engine/pull/120', keys: ['comment|120|x'], types: ['reply'] }) });
    await wait("!!document.querySelector('.app-toast[data-kind=reply] .app-toast-secondary')");
    await clickText('.app-toast[data-kind=reply] .app-toast-secondary', 'Mark read');
    await wait("window.fixtureNotificationCalls.includes('quick:read:https://github.com/klang/engine/pull/120')");
    await wait("!document.querySelector('.app-toast[data-kind=reply]')");

    // A reply GitHub refused: an error toast with Retry, and the text kept as a draft on its thread.
    const failure = { id: 'f1', kind: 'mention', reply: { kind: 'thread', prUrl: 'https://github.com/klang/engine/pull/121', threadId: 'thread-left', to: 'maya' }, text: 'Yes, in the finally block.', message: 'GitHub refused the reply.', target: { kind: 'pr', pr: pr121, tab: 'feedback', threadId: 'thread-left' } };
    await push({ type: 'reply-failed', failure });
    const failedToast = "[...document.querySelectorAll('.app-toast')].find(t=>t.textContent.includes('Could not send your reply to maya'))";
    await wait(`!!${failedToast}`);
    await clickText('.app-toast .app-toast-action', 'Retry');
    await wait("window.fixtureNotificationCalls.includes('reply:thread-left:Yes, in the finally block.')");
    await wait(`!!${failedToast}`, 300);
    await js(`${failedToast}.querySelector('.app-toast-secondary').click()`);
    await wait(`${selectedThread} === 'thread-left'`);
    await wait("[...document.querySelectorAll('.workspace-panel[data-workspace-active=true] textarea')].some(t=>t.value==='Yes, in the finally block.')");
    await capture('reply-draft');
    await js('window.fixtureReplyOk = true');
    await push({ type: 'reply-failed', failure });
    await wait(`!!${failedToast}`);
    await clickText('.app-toast .app-toast-action', 'Retry');
    await wait("[...document.querySelectorAll('.app-toast')].some(t=>t.textContent.includes('Reply sent to maya'))");
    await wait("![...document.querySelectorAll('.workspace-panel[data-workspace-active=true] textarea')].some(t=>t.value==='Yes, in the finally block.')");

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
    for (const label of ['Mentions', 'Replies to you', 'Changes requested', 'Approved', 'Checks failed', 'Ready to merge', 'Explanation ready', 'Update ready']) assert.equal(switches[label], 'true', label);
    assert.equal(await js("[...document.querySelectorAll('.settings-panel [role=switch]')].some(s=>s.getAttribute('aria-label')==='Desktop notifications'&&!s.closest('[data-state=active]'))"), false, 'The desktop switch moved out of Integrations');
    // Team requests on, with a sign-in GitHub reports without read:org: one quiet note under the switch.
    const teamNote = ".settings-panel [data-team-requests-note='notifications']";
    await js("window.setFixtureGitHubScopes(['repo','workflow'])");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await js(`!!document.querySelector("${teamNote}")`), false, 'No note while team requests are off');
    await js("document.querySelector('[role=switch][aria-label=\"Requested from your team\"]').click()");
    await wait(`!!document.querySelector("${teamNote}")`);
    assert.equal(
      await js(`document.querySelector("${teamNote} p").textContent`),
      'Team review requests may be incomplete: Gnosis can’t read your organization’s teams. Sign in again to allow it.'
    );
    assert.equal(await js("document.querySelectorAll('.settings-panel [data-team-requests-note]').length"), 1);
    await capture('settings-team-note');
    await js(`[...document.querySelectorAll("${teamNote} button")].find(b=>b.textContent.trim()==='Not now').click()`);
    await wait(`!document.querySelector("${teamNote}")`);
    await js("document.querySelector('[role=switch][aria-label=\"Requested from your team\"]').click()");
    await js("window.setFixtureGitHubScopes(['repo','read:org','workflow'])");
    await js("document.querySelector('[role=switch][aria-label=\"Approved\"]').click()");
    await wait("window.electronAPI.loadPreferences().then(p=>p.notificationSettings?.events?.approved===false)");
    await clickText('.settings-panel button', 'Send test notification');
    await wait("[...document.querySelectorAll('.settings-panel [role=status]')].some(s=>s.textContent.includes('Sent a test notification'))");
    assert.equal(switches['Allow replies from notifications'], 'true', 'Replies from notifications are on by default');
    assert.equal(switches['New commits since your review'], 'true');
    assert.deepEqual(await js("[...document.querySelectorAll('.notification-pause-choices button')].map(b=>b.textContent.trim())"), ['Pause for 1 hour', 'Until tomorrow morning', 'Until Monday']);
    await clickText('.settings-panel button', 'Until Monday');
    await wait("[...document.querySelectorAll('.settings-panel .settings-row')].some(r=>/Paused until Mon /.test(r.textContent))");
    await clickText('.settings-panel button', 'Resume');
    await wait("[...document.querySelectorAll('.settings-panel button')].some(b=>b.textContent.trim()==='Pause for 1 hour')");
    await clickText('.settings-panel button', 'Pause for 1 hour');
    await wait("[...document.querySelectorAll('.settings-panel .settings-row')].some(r=>r.textContent.includes('Paused until'))");
    await capture('settings-paused');
    await clickText('.settings-panel button', 'Resume');
    await wait("[...document.querySelectorAll('.settings-panel button')].some(b=>b.textContent.trim()==='Pause for 1 hour')");
    assert.deepEqual(await js("window.fixtureNotificationCalls.filter(c=>!/^(quick|reply):/.test(c))"), ['introduce:true', 'test', 'pause:monday', 'pause:false', 'pause:hour', 'pause:false']);

    // Repositories: the "Other repositories" default, and the exception set from the row menu.
    const setInput = (selector: string, value: string) =>
      js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const exists = (selector: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
    assert.ok(await exists('#notifications-repositories-title'));
    assert.ok(await exists('.settings-panel [aria-label="Other repositories"]'));
    assert.deepEqual(await js("[...document.querySelectorAll('.notification-exceptions .notification-exception')].map(r=>r.textContent.includes('klang/engine'))"), [true]);
    assert.ok(await exists('.notification-exceptions [aria-label="Notifications from klang/engine"]'));
    await capture('settings-repositories');
    await js(`document.querySelector(${JSON.stringify('[aria-label="Remove the exception for klang/engine"]')}).click()`);
    await wait("!document.querySelector('.notification-exceptions .notification-exception')");
    await wait("window.electronAPI.loadPreferences().then(p=>p.repositorySettings?.['klang/engine']?.notifications===undefined)");

    // Bots: never by default; an allow list.
    await setInput('[aria-label="Bot login"]', 'not a login!');
    await clickText('.settings-panel button', 'Add bot');
    await wait("!!document.querySelector('.notification-bots [role=alert]')");
    await setInput('[aria-label="Bot login"]', 'CodeRabbitAI[bot]');
    await clickText('.settings-panel button', 'Add bot');
    await wait("window.electronAPI.loadPreferences().then(p=>(p.notificationSettings?.allowedBots??[]).join()==='coderabbitai[bot]')");
    const stop = '[aria-label="Stop notifications from coderabbitai[bot]"]';
    await wait(`!!document.querySelector(${JSON.stringify(stop)})`);
    await capture('settings-bots');
    await js(`document.querySelector(${JSON.stringify(stop)}).click()`);
    await wait("window.electronAPI.loadPreferences().then(p=>p.notificationSettings?.allowedBots?.length===0)");
    console.log('Notification checks passed: non-dialog toasts with kinds, introduction, keyboard dismiss, close on read, one toast per PR, repository levels from the row menu, reduced motion, click-through, deep links, Settings with repository exceptions and bots. Screenshots: ' + shots);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure').catch(() => {});
    app.exit(1);
  }
});
