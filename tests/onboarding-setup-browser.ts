import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { chooseWorkspaceMenuItem } from './workspace-menu';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    show: true,
    webPreferences: { backgroundThrottling: false, partition: `ftue-${Date.now()}` },
  });
  const js = <T = unknown>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(`${code}\n${String(error)}`);
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let n = 0; n < 160; n++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const click = (
    label: string,
    scope = "(document.querySelector('.github-auth-dialog') ?? document.querySelector('.setup-dialog') ?? document)"
  ) =>
    js(
      `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>!b.hidden && b.getClientRects().length && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b) throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    const dir = path.resolve('.impeccable/review/onboarding');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const fill = async (selector: string, value: string) => {
    await js(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.focus();f.select()})()`);
    await win.webContents.insertText(value);
  };
  const current = (name: string) =>
    wait(
      `document.querySelector('.setup-body > fieldset:not([hidden])')?.getAttribute('name')===${JSON.stringify(name)} || document.querySelector('.setup-body > fieldset:not([hidden])')?.textContent.includes(${JSON.stringify(name)})`
    );
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL ?? ''}?ftue&ftue-fail`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("!!document.querySelector('.setup-dialog')");
    await capture('goals-light');
    await js("[...document.querySelectorAll('.setup-choice')].find(e=>e.textContent.includes('Track my own PRs')).querySelector('input').click()");
    await js(
      "[...document.querySelectorAll('.setup-choice')].find(e=>e.textContent.includes('Follow repository work')).querySelector('input').click()"
    );
    await click('Next');
    await current('Connect your GitHub');
    await click('Connect GitHub', "document.querySelector('.setup-dialog')");
    await click('Sign in through browser');
    await wait(
      "document.querySelector('.setup-connected')?.textContent.includes('oddur') && !document.querySelector('.github-auth-dialog')"
    );
    await new Promise((r) => setTimeout(r, 250));
    await click('Next');
    await current('Which repositories');
    await click('Next');
    await wait("document.querySelector('.setup-error')?.textContent.includes('Choose at least')");
    await click('Choose repositories');
    await fill('[aria-label="Search repositories"]', 'klang');
    await wait("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('klang/engine'))");
    await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('klang/engine')).click()");
    await fill('[aria-label="Search repositories"]', 'klang');
    await wait("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('klang/tools'))");
    await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('klang/tools')).click()");
    await js(
      "document.querySelector('[aria-label=\"Search repositories\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
    );
    await click('Configure klang/engine');
    await js("document.querySelector('[aria-label=\"Use global default for daily briefing count\"]').click()");
    await fill('[aria-label="Repository daily automatic briefings"]', '7');
    await click('blue repository color');
    await click('Save settings');
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    assert.equal(await js("JSON.parse(sessionStorage.getItem('fixture-onboarding')).draft.repositories.length"), 2);
    assert.equal(await js("JSON.parse(sessionStorage.getItem('fixture-onboarding')).draft.repositorySettings['klang/engine'].briefingDailyLimit"), 7);
    win.reload();
    await wait("document.body.innerText.includes('Resume setup')");
    await click('Resume setup');
    await current('Which repositories');
    await click('Next');
    await current('Queue filters');
    await capture('filters-light');
    await click('Next');
    // Notifications and the menu bar come after GitHub and repositories, and can be skipped.
    const calls = () => js<string[]>('window.fixtureNotificationCalls');
    const desktop = () => js<Record<string, string> | undefined>("JSON.parse(sessionStorage.getItem('fixture-onboarding')).desktop");
    await current('Get notified when a PR needs you');
    await capture('notifications-light');
    await click('Set up later');
    await current('See what needs you');
    assert.equal((await desktop())?.notifications, 'skipped');
    assert.deepEqual(await calls(), [], 'skipping sends nothing');
    await click('Back');
    await current('Get notified when a PR needs you');
    await click('Turn on notifications');
    await wait("document.querySelector('.setup-body')?.textContent.includes('Did you see it?')");
    assert.deepEqual(await calls(), ['introduce:true'], 'one click sends exactly one notification');
    await click('No');
    await wait("[...document.querySelectorAll('.setup-dialog button')].some(b=>b.textContent.trim()==='Open notification settings')");
    assert.match(await js<string>("document.querySelector('.setup-desktop-help').textContent"), /Focus or Do Not Disturb/);
    assert.equal((await desktop())?.notifications, 'not-seen');
    await capture('notifications-help-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('notifications-help-dark');
    await js("document.documentElement.classList.remove('dark')");
    await click('Open notification settings');
    await wait("window.fixtureNotificationCalls.includes('settings:notifications')");
    await click('Send again');
    await wait("document.querySelector('.setup-body')?.textContent.includes('Did you see it?')");
    assert.deepEqual(await calls(), ['introduce:true', 'settings:notifications', 'test']);
    await click('Yes');
    await wait("document.querySelector('.setup-body')?.textContent.includes('Notifications are on.')");
    assert.equal((await desktop())?.notifications, 'completed');
    await click('Next');
    await current('See what needs you');
    await capture('menubar-light');
    await click('Show me');
    // The fixture's icon is off: setup offers to turn it on, then opens the panel.
    await wait("[...document.querySelectorAll('.setup-dialog button')].some(b=>b.textContent.trim()==='Turn on the icon')");
    await click('Turn on the icon');
    await wait("document.querySelector('.setup-body')?.textContent.includes('The summary panel is open')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.trayEnabled)"), true);
    assert.deepEqual((await calls()).filter((call) => call === 'menubar-show').length, 2);
    await click('No');
    await wait("[...document.querySelectorAll('.setup-dialog button')].some(b=>b.textContent.trim()==='Open menu bar settings')");
    assert.match(await js<string>("document.querySelector('.setup-desktop-help').textContent"), /Allow in the Menu Bar/);
    await click('Open menu bar settings');
    await wait("window.fixtureNotificationCalls.includes('settings:menubar')");
    await js("[...document.querySelectorAll('.setup-badge label')].find(l=>l.textContent.includes('A dot only')).querySelector('input').click()");
    await wait("window.electronAPI.loadPreferences().then(p=>p.menubarSettings?.badge==='dot')");
    assert.equal(await js("!!document.querySelector('.setup-menubar-dot')"), true, 'the preview shows the chosen badge');
    await capture('menubar-help-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('menubar-help-dark');
    await js("document.documentElement.classList.remove('dark')");
    await click('Yes');
    await wait("document.querySelector('.setup-body')?.textContent.includes('The menu bar icon is ready.')");
    assert.equal((await desktop())?.menubar, 'completed');
    await click('Next');
    await current('Explanations and briefings');
    await wait("document.querySelector('.setup-cli')?.textContent.includes('No AI tool')");
    await capture('ai-missing');
    assert.equal(await js("[...document.querySelectorAll('.setup-actions button')].find(b=>b.textContent==='Next').disabled"), true);
    assert.equal(await js("!!document.querySelector('[aria-label=\"Explanation model\"]')"), false);
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({claude:'found'}))");
    await click('Check again');
    await wait("document.querySelector('[aria-label=\"Explanation model\"]')?.textContent.includes('Opus 5.5')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Briefing model\"]').textContent"), /Sonnet 5.5/);
    await capture('ai-claude');
    await click('Explanation model');
    await click('Explanation model selection');
    assert.equal(await js("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('GPT'))"), false);
    await js("document.querySelector('[aria-label=\"Search explanation model selection\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await wait("!document.querySelector('.model-picker-popup')");
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('[aria-label=\"Explanation model\"]')?.textContent.includes('GPT-6.2 Sol')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Briefing model\"]').textContent"), /GPT-6.1 Terra/);
    await capture('ai-codex');
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({claude:'error',codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('.setup-body')?.textContent.includes('Could not check Claude')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Explanation model\"]').textContent"), /GPT-6.2 Sol/);
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({claude:'found',codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('.setup-cli')?.textContent.includes('Claude Code and Codex found')");
    await click('Explanation model');
    await click('Explanation model selection');
    await fill('[aria-label="Search explanation model selection"]', 'Opus');
    await wait("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('Opus 5.5'))");
    await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('Opus 5.5')).click()");
    await click('Done');
    await js("window.selectEffort('Explanation model', 'xhigh')");
    await js("window.selectEffort('Briefing model', 'medium')");
    await capture('ai-light');
    assert.equal(
      await js("document.querySelector('.setup-body > fieldset:not([hidden]) input[type=checkbox]').checked"),
      false
    );
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    win.reload();
    await wait("document.body.innerText.includes('Resume setup')");
    await click('Resume setup');
    await current('Explanations and briefings');
    await wait("document.querySelector('.setup-cli')?.textContent.includes('Claude Code and Codex found')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Explanation model\"]').textContent"), /Opus 5.5/);
    assert.match(await js<string>("document.querySelector('[aria-label=\"Briefing model\"]').textContent"), /GPT-6.1 Terra/);
    assert.equal(await js("document.querySelector('[aria-label=\"Explanation model\"]').querySelector('.model-picker-effort').textContent"), 'Extra high');
    assert.equal(await js("document.querySelector('[aria-label=\"Briefing model\"]').querySelector('.model-picker-effort').textContent"), 'Medium');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(640, 700);
    await capture('ai-narrow-dark');
    assert.equal(await js("document.querySelector('.setup-dialog').scrollWidth<=document.querySelector('.setup-dialog').clientWidth"), true);
    win.setSize(560, 700);
    await capture('ai-stacked-dark');
    assert.equal(await js("document.querySelector('.setup-dialog').scrollWidth<=document.querySelector('.setup-dialog').clientWidth"), true);
    await js("document.documentElement.classList.remove('dark')");
    win.setSize(1280, 850);
    await click('Next');
    await current('Review setup');
    assert.equal(await js("document.querySelector('.setup-summary').textContent.includes('Explanations: Claude · Opus 5.5') && document.querySelector('.setup-summary').textContent.includes('Briefings: Codex · GPT-6.1 Terra')"), true);
    await capture('preview-light');
    assert.equal(await js("document.querySelector('.setup-body').getBoundingClientRect().bottom <= document.querySelector('.setup-actions').getBoundingClientRect().top"), true, 'preview scrolls above the footer');
    await click('Apply setup');
    await wait("document.querySelector('.setup-error')?.textContent.includes('Disk full')");
    await js("sessionStorage.setItem('ftue-retry','true')");
    await click('Apply setup');
    await wait("!document.querySelector('.setup-dialog')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.model==='claude-opus-5-5' && p.proactiveProvider==='codex' && p.proactiveModel==='gpt-6.1-terra' && p.proactiveReviewOverrides && p.effort==='xhigh' && p.proactiveEffort==='medium')"), true);
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6.2-sol')");
    await js('window.openModelMenu()');
    await wait("document.querySelector('.workspace-menu-popup [aria-label=\"Review model\"]')?.textContent.includes('GPT-6.2 Sol')");
    await js('window.closeModelMenu()');
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.proactiveReviewOverrides && p.proactiveModel==='gpt-6.1-terra')"), true, 'queue model changes preserve the briefing choice');
    assert.equal(
      await js("Object.values(JSON.parse(sessionStorage.getItem('fixture-views'+location.search))).length>0"),
      true
    );
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.repositorySettings['klang/engine'].color)"), 'blue');
    await click('Show walkthrough');
    await wait("!!document.querySelector('.gnosis-tour')");
    await capture('tour-queue');
    await click('Next', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('.driver-popover-title')?.textContent==='Understand the PR'");
    await capture('tour-summary');
    await js("const style=document.createElement('style');style.id='hide-tour-views';style.textContent='[data-tour=queue]{display:none!important}';document.head.append(style)");
    await click('Back', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('.driver-active-element')?.getAttribute('data-tour')==='queue-fallback'");
    await capture('tour-queue-fallback');
    await js("document.querySelector('#hide-tour-views').remove()");
    await click('Next', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('.driver-popover-title')?.textContent==='Understand the PR'");
    await click('Next', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('[data-tour=changes]')?.getAttribute('data-state')==='active'");
    await capture('tour-changes');
    await click('Next', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('[data-tour=explanation]')?.getAttribute('data-state')==='active'");
    await capture('tour-explanation');
    // Setup already showed this person the icon, so the walkthrough has no menu bar stop.
    assert.equal(await js("document.querySelector('.gnosis-tour-progress')?.textContent"), '4 of 4');
    await js("document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',keyCode:27,bubbles:true,cancelable:true}))");
    await wait("!document.querySelector('.gnosis-tour')");
    // Applying setup keeps the notifications and menu bar answers, so no prompt follows.
    assert.deepEqual(await desktop(), { notifications: 'completed', menubar: 'completed' });
    assert.equal(await js("!!document.querySelector('[aria-label=\"Notifications setup\"]')"), false);
    // Settings › Notifications: help for people who skipped, and the steps again on their own.
    await js("window.electronAPI.loadPreferences().then(p=>window.electronAPI.savePreferences({...p, trayEnabled: true}))");
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('.settings-tabs')");
    await js("[...document.querySelectorAll('[role=tab]:not(.workspace-tab-select)')].find(t=>t.textContent==='Notifications').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await wait("!!document.querySelector('#notifications-where-title')");
    // The fixture's preferences reset on reload, so desktop notifications are off again here.
    await js("[...document.querySelectorAll('.settings-panel [role=switch]')].find(s=>s.getAttribute('aria-label')==='Desktop notifications'&&s.getAttribute('aria-checked')==='false')?.click()");
    await wait("window.electronAPI.loadPreferences().then(p=>p.notifications===true)");
    await click('Send test notification', 'document.querySelector(".settings-panel[data-state=active]")');
    await wait("document.querySelector('.notification-settings-missed')?.textContent.includes('macOS may be blocking Gnosis')");
    await click('Open notification settings', 'document.querySelector(".notification-settings-missed")');
    await click('Open macOS notification settings', 'document.querySelector(".settings-panel[data-state=active]")');
    await wait("window.fixtureNotificationCalls.filter(c=>c==='settings:notifications').length===2");
    await js("document.querySelector('.settings-menubar-missing > summary').click()");
    await click('Open menu bar settings', 'document.querySelector(".settings-menubar-missing")');
    await wait("window.fixtureNotificationCalls.filter(c=>c==='settings:menubar').length===1");
    await capture('settings-notifications-light');
    await click('Set up notifications and menu bar…', 'document.querySelector(".settings-panel[data-state=active]")');
    await wait("!document.querySelector('.settings-tabs') && document.querySelector('.setup-dialog-desktop')?.textContent.includes('Notifications are on.')");
    await capture('desktop-rerun-light');
    await click('Close', "document.querySelector('.setup-dialog-desktop')");
    await wait("!document.querySelector('.setup-dialog-desktop')");
    assert.deepEqual(await desktop(), { notifications: 'completed', menubar: 'completed', prompt: 'started' }, 'closing a re-run keeps earlier answers');
    // People who finished setup before these steps existed get one dismissible prompt.
    await js("sessionStorage.setItem('fixture-onboarding', JSON.stringify({...JSON.parse(sessionStorage.getItem('fixture-onboarding')), desktop: undefined}))");
    win.reload();
    await wait("!!document.querySelector('[aria-label=\"Notifications setup\"]')");
    assert.equal(await js("!!document.querySelector('.setup-dialog')"), false, 'the prompt never opens a dialog by itself');
    await capture('desktop-prompt-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('desktop-prompt-dark');
    await js("document.documentElement.classList.remove('dark')");
    await click('Not now', 'document.querySelector("[aria-label=\\"Notifications setup\\"]")');
    await wait("!document.querySelector('[aria-label=\"Notifications setup\"]')");
    assert.deepEqual(await desktop(), { prompt: 'dismissed' });
    win.reload();
    await wait("!!document.querySelector('.workspace-menu-trigger')");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await js("!!document.querySelector('[aria-label=\"Notifications setup\"]')"), false, 'shown once');
    // macOS with the icon on in panel mode, and no menu bar answer from setup: the walkthrough ends in the menu bar.
    const tourTitle = () => js<string | undefined>("document.querySelector('.driver-popover-title')?.textContent");
    const tourProgress = () => js<string | undefined>("document.querySelector('.gnosis-tour-progress')?.textContent");
    const walkthrough = async () => {
      await js(chooseWorkspaceMenuItem('[aria-label="Help and terminology"]'));
      await click('Show walkthrough');
      await wait("!!document.querySelector('.gnosis-tour .gnosis-tour-progress')");
    };
    // Saved as Settings saves: the file, then the event the queue listens to.
    const savePrefs = (patch: string) =>
      js(`window.electronAPI.loadPreferences().then(async p=>{const next={...p,...${patch}};await window.electronAPI.savePreferences(next);window.dispatchEvent(new CustomEvent('gnosis-preferences-changed',{detail:next}))})`);
    const endTour = async () => {
      await js("document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',keyCode:27,bubbles:true,cancelable:true}))");
      await wait("!document.querySelector('.gnosis-tour')");
    };
    await savePrefs("{trayEnabled: true, menubarSettings: { click: 'panel', badge: 'new' }}");
    await walkthrough();
    // The walkthrough resumes where it was ended, on the explanation; the menu bar stop follows it.
    assert.equal(await tourProgress(), '4 of 5');
    assert.equal(await tourTitle(), 'Go deeper when needed', 'the existing steps are unchanged');
    await click('Next', "document.querySelector('.gnosis-tour')");
    await wait("document.querySelector('.driver-popover-title')?.textContent==='Gnosis is also in your menu bar'");
    assert.equal(await tourProgress(), '5 of 5');
    assert.equal(await js("document.querySelector('.driver-popover-description').textContent"), 'Click the icon to see what needs you and open a PR without switching windows.');
    assert.equal(await js("!!document.querySelector('[data-tour=queue]') && !document.querySelector('[data-tour=explanation]')"), true, 'the stop is on the queue');
    assert.deepEqual(await js("[...document.querySelectorAll('.gnosis-tour .driver-popover-navigation-btns button')].map(b=>b.textContent.trim())"), ['Back', 'Show me', 'Finish tour']);
    await capture('tour-menubar-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('tour-menubar-dark');
    await js("document.documentElement.classList.remove('dark')");
    const shows = () => js<number>("window.fixtureNotificationCalls.filter(c=>c==='menubar-show').length");
    const before = await shows();
    await click('Show me', "document.querySelector('.gnosis-tour')");
    await wait(`window.fixtureNotificationCalls.filter(c=>c==='menubar-show').length===${before + 1}`);
    assert.equal(await tourTitle(), 'Gnosis is also in your menu bar', 'Show me keeps the tour open');
    await click('Finish tour', "document.querySelector('.gnosis-tour')");
    await wait("!document.querySelector('.gnosis-tour')");
    assert.equal(await js("JSON.parse(sessionStorage.getItem('fixture-onboarding')).tourCompleted"), true);
    // The classic menu has no panel to show: four steps.
    await savePrefs("{menubarSettings: { click: 'menu', badge: 'new' }}");
    await walkthrough();
    assert.equal(await tourProgress(), '1 of 4');
    await endTour();
    // The icon off: four steps.
    await savePrefs("{trayEnabled: false, menubarSettings: { click: 'panel', badge: 'new' }}");
    await walkthrough();
    assert.equal(await tourProgress(), '1 of 4');
    await endTour();
    // Windows has no summary panel, even with the icon on.
    await js("sessionStorage.setItem('fixture-platform', 'win32')");
    win.reload();
    await wait("!!document.querySelector('.workspace-menu-trigger')");
    await savePrefs('{trayEnabled: true}');
    await walkthrough();
    assert.equal(await tourProgress(), '1 of 4');
    await endTour();
    await js("sessionStorage.removeItem('fixture-platform')");
    win.reload();
    await wait("!!document.querySelector('.workspace-menu-trigger')");
    // Help still offers the steps after the prompt is dismissed.
    await js(chooseWorkspaceMenuItem('[aria-label="Help and terminology"]'));
    await click('Set up notifications and menu bar…');
    await wait("!!document.querySelector('.setup-dialog-desktop')");
    await click('Close', "document.querySelector('.setup-dialog-desktop')");
    await wait("!document.querySelector('.setup-dialog-desktop')");
    await js(chooseWorkspaceMenuItem('[aria-label="Help and terminology"]'));
    await click('Run setup again');
    await current('Choose queue views');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(640, 700);
    await capture('goals-narrow-dark');
    assert.equal(await js("document.querySelector('.setup-dialog').getBoundingClientRect().bottom <= innerHeight && document.querySelector('.setup-dialog').getBoundingClientRect().top >= 0"), true);
    assert.equal(
      await js(
        "document.querySelector('.setup-dialog').scrollWidth<=document.querySelector('.setup-dialog').clientWidth"
      ),
      true
    );
    await click('Use local reviews without GitHub');
    await click('Next');
    await current('Explanations and briefings');
    await click('Set up AI later');
    await current('Review setup');
    await click('Apply setup');
    await wait("!document.querySelector('.setup-dialog')");
    assert.equal(
      await js("JSON.parse(sessionStorage.getItem('fixture-views'+location.search)).views.length"),
      3,
      'local replay keeps existing views'
    );
    await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))");
    await wait("!!document.querySelector('[aria-label=\"Search Gnosis\"]')");
    await fill('[aria-label="Search Gnosis"]', '> Run setup again');
    await wait("[...document.querySelectorAll('[cmdk-item]')].some(e=>e.textContent.includes('Run setup again'))");
    await js("[...document.querySelectorAll('[cmdk-item]')].find(e=>e.textContent.includes('Run setup again')).click()");
    await wait("!!document.querySelector('.setup-dialog')");
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog')");
    await js("sessionStorage.removeItem('ftue-auth')");
    win.reload();
    await wait("!!document.querySelector('.workspace-menu-trigger') && !document.querySelector('.setup-dialog')");
    await js(chooseWorkspaceMenuItem('[aria-label="Help and terminology"]'));
    await click('Show walkthrough');
    await wait("document.querySelector('.driver-popover-title')?.textContent==='Review local changes'");
    assert.equal(await js("document.querySelector('.driver-active-element')?.getAttribute('data-tour')"), 'local');
    assert.equal(await js("document.querySelector('.gnosis-tour-progress')?.textContent"), '1 of 1');
    await capture('tour-local-narrow-light');
    await click('Finish tour', "document.querySelector('.gnosis-tour')");
    await wait("!document.querySelector('.gnosis-tour')");
    console.log(
      'PASS: first run, auth, repository selection, resume, preview, failed apply/retry, saved views, real spotlight navigation, local replay, narrow/dark'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.log(await js('document.body.innerText'));
    await capture('failure');
    app.exit(1);
  }
});
