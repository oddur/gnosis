import { contrastRatio } from '../lib/code-contrast';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = async <T = unknown>(code: string): Promise<T> => {
    try {
      return (await window.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      throw new Error(`Browser assertion failed: ${code}\n${String(error)}`);
    }
  };
  const match = (actual: unknown, pattern: RegExp) => assert.match(String(actual), pattern);
  const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
  if (!fixtureUrl) throw new Error('Missing workbench fixture URL');
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out: ' + expression);
  };
  const click = async (text: string) => {
    await wait(`[...document.querySelectorAll('button')].some(b=>b.checkVisibility({visibilityProperty:true})&&(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}))`);
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.checkVisibility({visibilityProperty:true})).find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b)throw new Error('Missing button: '+${JSON.stringify(text)});b.click();})()`
    );
  };
  const shots = process.env.GNOSIS_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'gnosis-workbench-screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(fixtureUrl);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("document.querySelectorAll('.queue-item').length === 7");
    assert.equal(await js(`document.fonts.load('650 22px "Plus Jakarta Sans"').then(f=>f.length)`), 1);
    assert.equal(await js(`document.fonts.load('400 13px "JetBrains Mono"').then(f=>f.length)`), 1);
    assert.equal(
      await js(`document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="cdn.jsdelivr"]').length`),
      0
    );

    await js(
      `window.selectOption('[aria-label="Review model"]', 'codex:gpt-6-astra')`
    );
    assert.equal(await js('window.electronAPI.loadPreferences().then(p => p.model)'), 'gpt-6-astra');
    assert.equal(
      await js('window.electronAPI.loadPreferences().then(p => p.proactiveReviewOverrides)'),
      true,
      'The explanation model must preserve the separate briefing selection'
    );
    await js(`document.querySelector('[aria-label="Settings"]').click()`);
    await wait(`!!document.querySelector('[aria-label="Ignore Dependabot PRs"]')`);
    assert.equal(
      await js(`document.querySelector('[aria-label="Ignore Dependabot PRs"]').getAttribute('aria-checked')`),
      'true'
    );
    await js(`document.querySelector('[aria-label="Ignore Dependabot PRs"]').click()`);
    assert.equal(await js(`window.electronAPI.loadPreferences().then(p=>p.ignoreDependabotPrs)`), false);
    await js(`document.querySelector('[data-slot="dialog-close"]').click()`);
    await js(`document.querySelector('[aria-label="Settings"]').click()`);
    await wait(
      `document.querySelector('[aria-label="Ignore Dependabot PRs"]')?.getAttribute('aria-checked') === 'false'`
    );
    await js(`document.querySelector('[aria-label="Ignore Dependabot PRs"]').click()`);
    await js(`document.querySelector('[data-slot="dialog-close"]').click()`);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js("getComputedStyle(document.querySelector('.queue-toolbar h1')).fontSize"), '22px');
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("document.querySelector('.briefing-panel')?.textContent.includes('Cancellation must release')");
    match(await js(`document.querySelector('[aria-label="Briefing model"]').textContent`), /Sonnet 5.5/);
    await js('document.querySelector(\'.queue-disclosure[aria-label*="Introduce"]\').click()');
    assert.equal(await js("document.querySelectorAll('.queue-member').length"), 3);
    await capture('queue-light');
    await click('Briefing settings');
    await wait("!!document.querySelector('#settings-briefing-limit')");
    assert.equal(await js("document.querySelector('#settings-briefing-limit').value"), '10');
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("!document.querySelector('[role=dialog]')");

    await wait("document.querySelector('.activity-summary')?.textContent.includes('2 running')");
    const toolbarY = await js("document.querySelector('.queue-toolbar').getBoundingClientRect().y");
    await js("document.querySelector('.activity-trigger').click()");
    await wait("document.querySelectorAll('.activity-task').length === 6");
    assert.equal(await js("document.querySelector('.queue-toolbar').getBoundingClientRect().y"), toolbarY);
    assert.equal(
      await js("document.querySelector('.activity-list [role=progressbar]').getAttribute('aria-valuenow')"),
      String((4 / 15) * 100)
    );
    assert.equal(
      await js("document.querySelectorAll('.activity-list [role=progressbar]:not([aria-valuenow])').length"),
      1
    );
    await capture('activity-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('activity-dark');
    await js(
      "document.querySelector('.activity-drawer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    assert.equal(await js("document.activeElement === document.querySelector('.activity-trigger')"), true);
    await js("document.querySelector('.activity-trigger').click()");
    await js(
      "[...document.querySelectorAll('.activity-task')].find(t=>t.textContent.includes('Improve worker recovery')).querySelector('.activity-actions button').click()"
    );
    await wait("document.querySelector('.activity-summary')?.textContent.includes('1 running')");
    await click('Retry');
    await wait("document.querySelector('.activity-summary')?.textContent.includes('2 running')");
    await js(`document.querySelector('[aria-label="Close activity"]').click()`);

    await js("document.documentElement.classList.add('dark')");
    await capture('queue-dark');
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await capture('overview-dark');
    assert.ok(await js("document.querySelector('.activity-summary')?.textContent.includes('2 running')"));
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    assert.equal(await js("document.querySelectorAll('.source-attribution').length"), 1);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js("document.querySelectorAll('.review-file-context').length"), 1);
    match(await js("document.querySelector('.review-file-summary').textContent"), /Limits pending commands/);
    match(await js("document.querySelector('.review-file-details').textContent"), /Modified/);
    match(
      await js("document.querySelector('.review-file-counts').getAttribute('aria-label')"),
      /6 added lines, 1 removed line/
    );
    await capture('review-dark');
    await click('Diff appearance');
    await wait("!!document.querySelector('[role=dialog] select')");
    await capture('diff-appearance-dark');
    await js(
      "[...document.querySelectorAll('label')].find(l=>l.textContent==='Wrap long lines').querySelector('input').click()"
    );
    await wait('window.electronAPI.loadPreferences().then(p=>p.diffAppearance?.wrap === true)');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
    await click('Diff appearance');
    assert.equal(
      await js(
        "[...document.querySelectorAll('label')].find(l=>l.textContent==='Wrap long lines').querySelector('input').checked"
      ),
      true
    );
    await click('Reset appearance');
    await wait('window.electronAPI.loadPreferences().then(p=>p.diffAppearance?.wrap === false)');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");

    await click('Ask a question');
    await wait("!!document.querySelector('.review-chat-workspace > .chat-sheet')");
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 350"), true);
    await capture('chat-dark');
    // Chat must preserve fenced code in both questions and answers, including fences without a language.
    await js(
      `void (window.electronAPI.sendSlideChat = async () => ${JSON.stringify('### Keep cleanup tied to completion\n\nAwaiting the worker keeps the queue slot occupied until the operation completes. Returning the promise directly would run cleanup too early.\n\n```ts\ntry {\n  return await worker.run(command);\n} finally {\n  slot.release();\n}\n```')})`
    );
    await js(`(() => {
      const field = document.querySelector('.chat-sheet textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify('Why must cleanup wait?\n\n```\nreturn worker.run(command);\n```')});
      field.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await js('document.querySelector(\'.chat-sheet [aria-label="Send question"]\').click()');
    await wait("document.querySelectorAll('.chat-sheet pre code').length === 2");
    assert.equal(
      await js("document.querySelector('.chat-sheet pre code').textContent"),
      'return worker.run(command);\n',
      'An unlabelled code fence remains a real code block in the question'
    );
    assert.ok(await js("document.querySelectorAll('.chat-sheet pre code')[1].textContent.includes('slot.release();')"));
    await capture('chat-reading-dark');
    await js("document.documentElement.classList.remove('dark')");
    await capture('chat-reading-light');
    await js("document.documentElement.classList.add('dark')");
    await click('Close chat');
    await click('Open interactive explanation');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js("document.querySelector('.review-narrative').getBoundingClientRect().width > 250"), true);
    assert.equal(
      await js('Number(document.body.dataset.explainerCalls ?? 0)'),
      0,
      'Opening a saved interactive explanation does not generate it again'
    );
    await capture('exploration-dark');
    await click('Close interactive explanation');
    await js("document.documentElement.classList.remove('dark')");
    await capture('review-light');
    // A stack's submission target is explicit and independent of the displayed source PR.
    await js(`window.selectOption('[aria-label="PR for review submission"]', 'https://github.com/klang/engine/pull/122')`);
    await click('Review PR #122');
    await wait("!!document.querySelector('.submission-destination')");
    assert.equal(
      await js("document.querySelector('.submission-destination a').textContent.trim()"),
      'klang/engine'
    );
    assert.match(await js<string>("document.querySelector('.review-submit-header').textContent"), /Review PR #122/);
    assert.equal(
      await js("document.querySelector('.submission-destination a').getAttribute('href')"),
      'https://github.com/klang/engine/pull/122'
    );
    assert.ok(await js("document.querySelector('.review-file-context').textContent.includes('#121')"));
    await capture('submission-target-light');
    await js("document.documentElement.classList.add('dark')");
    window.setSize(800, 700);
    await capture('submission-target-dark-narrow');
    assert.ok(
      await js(
        "document.querySelector('[role=dialog]').scrollWidth <= document.querySelector('[role=dialog]').clientWidth"
      )
    );
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    window.setSize(1280, 800);
    await js("document.documentElement.classList.remove('dark')");
    // Unsaved topics offer generation; saved topics offer reopening.
    await js(`window.selectOption('[aria-label="Review topic"]', '2')`);
    await wait(
      "document.querySelector('.interactive-explanation-prompt')?.textContent.includes('Create interactive explanation')"
    );
    await click('Create interactive explanation');
    assert.equal(await js("!!document.querySelector('.review-tool-slot iframe')"), false);
    assert.equal(await js('Number(document.body.dataset.explainerCalls)'), 1);
    await wait(
      "document.querySelector('.interactive-explanation-prompt')?.textContent.includes('Open interactive explanation')"
    );
    await click('Open interactive explanation');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js('Number(document.body.dataset.explainerCalls)'), 1);
    await click('Close interactive explanation');
    await js(`window.selectOption('[aria-label="Review topic"]', '1')`);

    window.setSize(1440, 900);
    await capture('review-large');
    window.setSize(800, 700);
    await wait('innerWidth <= 800');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await wait('!!document.querySelector(\'[aria-label="Review pane"]\')');
    await click('Code');
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 600"), true);
    assert.equal(
      await js("[...document.querySelectorAll('.review-file-context')].every(h=>h.scrollWidth <= h.clientWidth)"),
      true
    );
    await capture('review-narrow');
    await js("[...document.querySelectorAll('[aria-label=\"Review pane\"] button')].find(b=>b.textContent.trim()==='Explanation').click()");
    await click('Open interactive explanation');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(
      await js("document.querySelector('.review-tool-slot iframe').getBoundingClientRect().width > 600"),
      true
    );
    await capture('exploration-narrow');
    await js("document.querySelector('.activity-trigger').click()");
    await wait("!!document.querySelector('.activity-drawer')");
    assert.equal(
      await js("document.querySelector('.activity-drawer').getBoundingClientRect().right <= innerWidth"),
      true
    );
    await capture('activity-narrow');
    await click('Open guided review');
    await wait("!!document.querySelector('.workbench-review') && !document.querySelector('.activity-drawer')");

    await js("document.querySelector('.activity-trigger').click()");
    await js(
      "[...document.querySelectorAll('.activity-actions button')].find(b=>b.textContent.trim()==='Open interactive explanation').click()"
    );
    await wait("!!document.querySelector('.review-tool-slot iframe') && !document.querySelector('.activity-drawer')");
    // Critique regressions: use realistic unavailable states and long cross-PR code.
    window.setSize(1280, 800);
    await window.loadURL(fixtureUrl + '?polish');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("document.querySelector('.saved-briefing')?.textContent.includes('Cancellation must release')");
    match(await js("document.querySelector('.briefing-status').textContent"), /Daily briefing attempt limit reached/);
    match(await js("document.querySelector('.saved-briefing').textContent"), /latest changes are not verified/);
    assert.equal(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='Open saved')"), false);
    await wait("document.querySelectorAll('.member-status-error').length === 3");
    await click('Retry status');
    await wait("document.querySelectorAll('.member-status-error').length === 0");
    match(await js("document.querySelector('.stack-members').textContent"), /CI success/);
    await capture('fallback-light');

    await click('Manage briefings');
    await wait("!!document.querySelector('[role=tab][aria-selected=true]')");
    match(await js("document.querySelector('[role=tab][aria-selected=true]').textContent"), /Queue/);
    await js('document.querySelector(\'[aria-label="Automatic briefings"]\').click()');
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("document.querySelector('.briefing-status')?.textContent.includes('Automatic briefings are off')");
    await click('Manage briefings');
    await wait("!!document.querySelector('[role=tab][aria-selected=true]')");
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await js(
      "[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Appearance').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))"
    );
    await wait("document.querySelector('[role=tabpanel][data-state=active]')?.textContent.includes('Code font')");
    assert.deepEqual(
      await js("[...document.querySelectorAll('[role=tabpanel][data-state=active] [data-slot=combobox-trigger]')].map(control => control.getAttribute('aria-label'))"),
      ['Code font', 'Code theme', 'Syntax highlighting']
    );
    match(await js("document.querySelector('[role=tabpanel][data-state=active]').textContent"), /Light/);
    window.setSize(800, 700);
    await capture('settings-appearance-narrow');
    await js(
      "[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes('Queue')).dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))"
    );
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Queue')");
    await capture('settings-queue-narrow');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("!document.querySelector('[role=dialog]')");
    window.setSize(1280, 800);

    // Native keyboard events verify focus, selection, typing, and activation together.
    const press = async (keyCode: string) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await new Promise((r) => setTimeout(r, 80));
    };
    await js("document.querySelector('.queue-row-main[aria-pressed=true]').focus()");
    await press('Down');
    assert.equal(await js("document.activeElement?.getAttribute('aria-pressed')"), 'true');
    match(await js("document.querySelector('.briefing-panel h2').textContent"), /Add trace context/);
    await press('Up');
    match(await js("document.querySelector('.briefing-panel h2').textContent"), /Introduce a bounded/);
    await press('/');
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Search PRs and stacks');
    await window.webContents.insertText('queue');
    assert.equal(await js('document.querySelector(\'[aria-label="Search PRs and stacks"]\').value'), 'queue');
    await press('Down');
    assert.equal(await js("document.activeElement?.getAttribute('aria-pressed')"), 'true');
    await press('Enter');
    await wait("!!document.querySelector('.stack-overview')");
    await js("(()=>{const tab=[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Explanation');tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));tab.click()})()");
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("document.querySelectorAll('.review-file-context').length === 2");
    assert.equal(
      await js("document.querySelector('.staleBanner-unknown')"),
      null,
      'Embedded explanations use the PR workspace status instead of duplicating the standalone freshness banner'
    );
    await js("document.documentElement.classList.add('dark')");
    await wait("!!document.querySelector('.diff-context-gap')");
    await js(
      "[...document.querySelectorAll('.review-context-hunk button')].filter(b=>b.getAttribute('aria-label')?.startsWith('Show all')).forEach(b=>b.click())"
    );
    await wait("document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length > 60");
    await js("document.querySelector('.review-code').parentElement.scrollTop = 300");
    const sticky = await js<{ offset: number; text: string }>(`(() => {
      const pane = document.querySelector('.review-code').parentElement;
      const header = document.querySelector('.review-file-context');
      return { offset: header.getBoundingClientRect().top - pane.getBoundingClientRect().top, text: header.textContent };
    })()`);
    assert.ok(Math.abs(sticky.offset) < 2, 'Source header must stay pinned during diff scroll');
    assert.equal(await js("document.querySelector('.review-file-context .source-attribution .entity-badge')?.textContent"), '#121');
    assert.match(sticky.text, /command-queue.ts/);
    assert.match(sticky.text, /Limits pending commands/);
    assert.equal(
      await js("document.querySelectorAll('.review-file-context')[1].querySelector('.review-file-summary') === null"),
      true
    );
    const commentColors = await js<{ foreground: string; background: string }>(`(() => {
      const root=document.querySelector('diffs-container').shadowRoot;
      const comment=[...root.querySelectorAll('[data-code] span')].find(el=>el.childElementCount===0&&el.textContent.includes('Preserve producer'));
      if(!comment) throw Error('Missing highlighted comment');
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d');
      const hex=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return '#'+[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('')};
      return {foreground:hex(getComputedStyle(comment).color),background:hex(getComputedStyle(comment.closest('[data-line]')).backgroundColor)};
    })()`);
    assert.ok(contrastRatio(commentColors.foreground, commentColors.background) >= 4.5, 'Rendered code comments remain readable');
    await capture('sticky-source-dark');
    await js(`(() => {
      const pane = document.querySelector('.review-code').parentElement;
      const next = document.querySelectorAll('.review-file-context')[1];
      pane.scrollTop += next.getBoundingClientRect().top - pane.getBoundingClientRect().top + 100;
    })()`);
    assert.ok(
      await js(`(() => {
      const pane = document.querySelector('.review-code').parentElement;
      const header = document.querySelectorAll('.review-file-context')[1];
      return Math.abs(header.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 2 && header.querySelector('.source-attribution .entity-badge')?.textContent === '#122';
    })()`),
      'Pinned source must follow the next stack member'
    );
    await capture('sticky-next-source-dark');
    window.setSize(800, 700);
    await capture('review-polished-narrow');
    assert.ok(
      await js(`(() => {
      const [previous, center, next] = document.querySelector('.review-bottom-nav').children;
      return previous.getBoundingClientRect().right <= center.getBoundingClientRect().left && center.getBoundingClientRect().right <= next.getBoundingClientRect().left;
    })()`),
      'Long navigation labels must not overlap submission'
    );
    // First use: optional setup, terminology, recovery, and a real review entry point.
    window.setSize(1280, 800);
    await window.loadURL(fixtureUrl + '?onboarding');
    await wait("!!document.querySelector('.workbench-connect')");
    if (await js("!!document.querySelector('.github-auth-dialog')")) {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await click('Continue with local reviews');
      await wait("!document.querySelector('.github-auth-dialog')");
    }
    await wait("document.querySelector('.getting-started')?.textContent.includes('was not found')");
    assert.equal(await js("document.querySelectorAll('.queue-empty').length"), 0, 'First use has one starting point');
    await capture('onboarding-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('onboarding-dark');
    await js("document.querySelector('.getting-started-setup summary').click()");
    await click('AI setup');
    await wait("!!document.querySelector('#ai-setup-title')");
    assert.equal(await js("document.querySelector('[data-state=active][role=tab]').textContent"), 'Integrations');
    await js("void (window.electronAPI.checkCliInstalled = () => Promise.reject(new Error('fixture check failed')))");
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("document.querySelector('.getting-started')?.textContent.includes('Could not check')");
    await js(
      "void (window.electronAPI.checkCliInstalled = () => Promise.resolve({installed:true,resolvedPath:'/fixture/claude'}))"
    );
    await click('Check again');
    await wait("document.querySelector('.getting-started')?.textContent.includes('found. Make sure')");
    await js('document.querySelector(\'[aria-label="Dismiss getting started"]\').click()');
    await wait("!document.querySelector('.getting-started')");
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>p.firstRunSeen)'), true);
    await window.loadURL(fixtureUrl + '?onboarding');
    await wait("!!document.querySelector('.workbench-connect')");
    if (await js("!!document.querySelector('.github-auth-dialog')")) {
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await click('Continue with local reviews');
      await wait("!document.querySelector('.github-auth-dialog')");
    }
    await wait("!!document.querySelector('.workbench-connect')");
    assert.equal(await js("!!document.querySelector('.getting-started')"), false, 'Dismissal persists on reopening');
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await wait("!!document.querySelector('.workbench-help')");
    await js("[...document.querySelectorAll('.workbench-help summary')].find(s=>s.textContent === 'Stack').click()");
    await capture('help-light');
    assert.ok(
      await js("document.querySelector('.workbench-help').textContent.includes('Starting one does not submit')")
    );
    await js(
      "document.querySelector('.workbench-help button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await wait("!document.querySelector('.workbench-help')");
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Help and terminology');
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await click('Run setup again');
    await wait("!!document.querySelector('.setup-dialog') && !document.querySelector('.workbench-help')");
    await js("document.querySelector('.setup-choice input').click()");
    await click('Next');
    await click('Connect GitHub');
    await wait("!!document.querySelector('.github-auth-dialog')");
    await click('Sign in through browser');
    await wait("document.querySelector('.setup-connected')?.textContent.includes('oddur') && !document.querySelector('.github-auth-dialog')");
    await click('Finish later');
    await wait("!document.querySelector('.setup-dialog') && !document.querySelector('.workbench-connect')");
    await js(`(() => {
      const input = document.querySelector('[aria-label="Search PRs and stacks"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'absent');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await wait("document.body.textContent.includes('No PRs match these filters')");
    // Fail the debounced filter save too: retry must recover pending filters,
    // not leave every later queue response blocked by the unsaved change.
    await js('void (window.fixtureQueue = window.electronAPI.workbenchQueue)');
    await js("void (window.electronAPI.workbenchQueue = () => Promise.reject(new Error('Fixture network failure')))");
    await js('void (window.failedFilterSaves = 0)');
    await js('void (window.fixtureSetFilters = window.electronAPI.workbenchSetFilters)');
    await js('void (window.electronAPI.workbenchSetFilters = async (...args) => { try { return await window.fixtureSetFilters(...args); } catch (e) { window.failedFilterSaves++; throw e; } })');
    await click('Clear filters');
    await wait("document.querySelector('[aria-label=\"Search PRs and stacks\"]').value === ''");
    await wait("document.body.textContent.includes('Could not save queue filters')");
    await js('document.querySelector(\'[title="Saved reviews"]\').click()');
    await wait("document.body.textContent.includes('No saved reviews yet')");
    await js('void (window.previousFailedSaves = window.failedFilterSaves)');
    await js('document.querySelector(\'[title="Review queue"]\').click()');
    await wait('window.failedFilterSaves > window.previousFailedSaves');
    await js('document.querySelector(\'[aria-label="Refresh queue"]\').click()');
    await wait("document.body.textContent.includes('Queue could not be loaded')");
    await js('void (window.electronAPI.workbenchQueue = window.fixtureQueue)');
    await click('Retry queue');
    await wait("!document.body.textContent.includes('Queue could not be loaded')");
    await js('document.querySelector(\'[aria-label="Dismiss error"]\').click()');
    window.setSize(800, 700);
    await js("document.documentElement.classList.add('dark')");
    await capture('onboarding-narrow-dark');
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await wait("!!document.querySelector('.workbench-help')");
    await capture('help-narrow-dark');
    assert.ok(await js("document.querySelector('.workbench-help').getBoundingClientRect().right <= innerWidth"));
    assert.ok(await js("document.querySelector('.workbench-help').getBoundingClientRect().bottom <= innerHeight"));
    // At 200% zoom, help remains bounded and internally scrollable.
    window.webContents.setZoomFactor(2);
    await capture('help-zoom');
    assert.ok(await js("document.querySelector('.workbench-help').getBoundingClientRect().right <= innerWidth"));
    assert.ok(await js("document.querySelector('.workbench-help').getBoundingClientRect().bottom <= innerHeight"));
    window.webContents.setZoomFactor(1);
    await js('document.querySelector(\'[aria-label="Close help"]\').click()');
    await js(
      "void (window.electronAPI.checkCliInstalled = () => Promise.resolve({installed:true,resolvedPath:'/fixture/claude'}))"
    );
    await click('Open PR');
    await wait('!!document.querySelector(\'[aria-label="Pull request URL"]\')');
    await js(`(() => {
      const input = document.querySelector('[aria-label="Pull request URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://github.com/klang/engine/pull/120');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-page')");
    await js("(()=>{const tab=[...document.querySelectorAll('[role=tab]')].find(tab => tab.textContent === 'Explanation');tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));tab.click()})()");
    await wait("!!document.querySelector('.explanation-empty')");
    await click('Generate explanation');
    await wait('window.electronAPI.loadPreferences().then(p => p.firstRunSeen)');
    await click('Review queue');
    await wait("document.querySelectorAll('.queue-item').length === 7 && !document.querySelector('.getting-started')");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-review')");
    await js('document.querySelector(\'[aria-label="Help and terminology"]\').click()');
    await wait("!!document.querySelector('.workbench-help')");
    assert.ok(await js("document.querySelector('.workbench-help').textContent.includes('Source PR')"));
    await js('document.querySelector(\'[aria-label="Close help"]\').click()');
    await js(`(() => {
      window.githubTask = { id: 'github:fixture', kind: 'github', title: 'Updating GitHub information',
        detail: 'Updating pull request details', status: 'running',
        progress: {completed: 3, total: 8, unit: 'PRs'}, updatedAt: new Date().toISOString(), canCancel: false, canRetry: false };
      window.electronAPI.listActivity = () => Promise.resolve([window.githubTask]);
      window.githubActions = [];
      window.electronAPI.activityAction = (id, action) => {
        window.githubActions.push({id, action});
        return Promise.resolve();
      };
    })()`);
    await js("document.querySelector('.activity-trigger').click()");
    await wait("document.querySelector('.activity-task')?.textContent.includes('Updating GitHub information')");
    assert.equal(
      await js("document.querySelector('.activity-list [role=progressbar]').getAttribute('aria-valuetext')"),
      '3 of 8 PRs complete'
    );
    assert.equal(await js("document.querySelectorAll('.activity-actions button').length"), 0);
    await js("document.documentElement.classList.remove('dark')");
    await capture('github-activity-light');
    window.setSize(1024, 700);
    await js("document.documentElement.classList.add('dark')");
    await capture('github-activity-dark-narrow');
    await js(
      "void Object.assign(window.githubTask, {status: 'completed', detail: 'Updated with warnings — your queue may be incomplete', progress: undefined, warnings: ['Could not check which PRs depend on others in owner/repo. Showing saved relationships.'], canRetry: true})"
    );
    await wait("document.querySelector('.activity-summary')?.textContent.includes('1 with warnings')");
    assert.equal(await js("document.querySelector('.activity-summary').textContent.includes('ready')"), false);
    await js("document.querySelector('.activity-failure summary').click()");
    await capture('github-activity-warning-dark');
    await click('Retry');
    assert.deepEqual(await js('window.githubActions'), [{ id: 'github:fixture', action: 'retry' }]);
    await js(
      "void Object.assign(window.githubTask, {status: 'completed', detail: 'GitHub information updated', warnings: [], canRetry: false})"
    );
    await wait("document.querySelector('.activity-summary')?.textContent.includes('GitHub updated')");
    assert.equal(await js("document.querySelectorAll('.activity-actions button').length"), 0);
    assert.ok(await js("document.querySelector('.activity-task').textContent.includes('GitHub information updated')"));
    await js(
      "void Object.assign(window.githubTask, {status: 'paused', detail: 'GitHub’s API limit was reached. GitHub requests can resume after 11:17 PM. Updates will resume automatically while the queue is open.', canRetry: false, canCancel: false})"
    );
    await wait("document.querySelector('.activity-summary')?.textContent.includes('1 paused')");
    assert.equal(await js("document.querySelectorAll('.activity-actions button').length"), 0);
    assert.ok(
      await js("document.querySelector('.activity-task-status').textContent.includes('resume after 11:17 PM')")
    );
    assert.ok(await js("!!document.querySelector('.workbench-review')"));
    await capture('github-backoff-dark');
    await js("document.documentElement.classList.remove('dark')");
    await capture('github-backoff-light');
    await window.loadURL(fixtureUrl + '?filters');
    window.setSize(1280, 800);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js("document.querySelector('.queue-filter-toggle').click()");
    const selectFilter = async (label: string, value: string) => {
      await js(`(async () => {
        const label = [...document.querySelectorAll('.queue-filter-panel label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)}));
        const control = label.querySelector('select, [data-slot=combobox-trigger]');
        await window.selectOption('#' + CSS.escape(control.id), ${JSON.stringify(value)});
      })()`);
    };
    await selectFilter('PR status', 'draft');
    await wait("document.querySelectorAll('.queue-item').length === 1");
    await selectFilter('PR created', '30');
    await wait("document.body.textContent.includes('No PRs match these filters')");
    await selectFilter('PR created', '0');
    await selectFilter('PR last updated', '7');
    await wait("document.querySelectorAll('.queue-item').length === 1");
    await selectFilter('Author', 'sam');
    await wait("document.body.textContent.includes('No PRs match these filters')");
    await selectFilter('Author', 'lena');
    await js("window.selectLabels(['bug'])");
    await wait("document.querySelectorAll('.queue-item').length === 1");
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.author==='lena' && q.filters.labels.names.includes('bug'))");
    await capture('queue-filters-light');
    await js("document.querySelector('.queue-filter-help summary').focus()");
    assert.equal(await js("document.activeElement === document.querySelector('.queue-filter-help summary')"), true);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait("document.querySelector('.queue-filter-help').open");
    await capture('queue-filter-help');
    await js("document.querySelector('.queue-filter-help summary').click()");

    window.setSize(1024, 700);
    await js("document.documentElement.classList.add('dark')");
    await capture('queue-filters-dark-laptop');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.reload();
    await wait(
      "document.querySelectorAll('.queue-item').length === 1 && document.querySelector('.queue-filter-toggle').textContent.includes('(4)')"
    );
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Automatically brief', 'all');
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.briefingScope==='all')");
    await js('document.querySelector(\'[aria-label="Close filters"]\').click()');
    await click('Clear filters');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('PRs or stacks', 'stack');
    await selectFilter('Author', 'maya');
    await wait("document.querySelectorAll('.queue-item').length === 1");
    await js(
      "document.querySelector('.queue-filter-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))"
    );
    await wait("!document.querySelector('.queue-filter-popover')");
    assert.equal(await js("document.activeElement === document.querySelector('.queue-filter-toggle')"), true);
    await js("document.querySelector('.queue-disclosure').click()");
    assert.equal(await js("document.querySelectorAll('.queue-member').length"), 3);
    await capture('queue-filters-stack');
    await window.loadURL(fixtureUrl + '?mine');
    window.setSize(1280, 800);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Show', 'mine');
    await wait("document.querySelectorAll('.queue-item').length === 3");
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.involvement==='mine')");
    assert.equal(await js("document.querySelector('.queue-filter-chip').textContent.includes('Involving me')"), true);
    await capture('queue-mine-light');
    window.setSize(1024, 700);
    await js("document.documentElement.classList.add('dark')");
    await capture('queue-mine-dark-laptop');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.setSize(800, 700);
    await capture('queue-mine-dark-narrow');
    window.webContents.setZoomFactor(2);
    await capture('queue-filters-zoom');
    assert.equal(
      await js(
        "document.querySelector('.queue-filter-popover').scrollWidth <= document.querySelector('.queue-filter-popover').clientWidth + 1"
      ),
      true
    );
    window.webContents.setZoomFactor(1);
    assert.equal(
      await js(
        "document.querySelector('.queue-filter-popover').scrollWidth <= document.querySelector('.queue-filter-popover').clientWidth"
      ),
      true
    );
    window.reload();
    await wait("document.querySelectorAll('.queue-item').length === 3");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Show', 'all');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await window.loadURL(fixtureUrl + '?labels');
    window.setSize(1280, 800);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js("document.querySelector('.queue-disclosure:not(:disabled)').click()");
    await wait("document.querySelectorAll('.queue-member').length === 3");
    assert.equal(await js("document.querySelector('.pr-label-more [aria-hidden]').textContent"), '+2');
    assert.equal(
      await js(
        "Array.from(document.querySelectorAll('.queue-member')[0].querySelectorAll('.pr-label')).map(l=>l.textContent).join(',')"
      ),
      'bug,needs-review'
    );
    assert.equal(
      await js(
        "Array.from(document.querySelectorAll('.queue-member')[2].querySelectorAll('.pr-label')).map(l=>l.textContent).join(',')"
      ),
      'legacy-label'
    );
    assert.ok(
      await js(
        "document.querySelector('.queue-title-line .pr-label[title*=\"Something is not working\"]').title.includes('#120')"
      )
    );
    await js(
      "document.querySelector('.queue-disclosure:not(:disabled)').closest('.queue-item').querySelector('.queue-row-main').click()"
    );
    await wait("!!document.querySelector('.briefing-panel .pr-label')");
    const badgeContrast = async () => {
      assert.equal(
        await js(`Array.from(document.querySelectorAll('.pr-label')).every(label => {
        const style = getComputedStyle(label);
        const lum = color => color.match(/[0-9.]+/g).slice(0,3).map(Number).map(c => { c /= 255; return c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4; }).reduce((s,c,i) => s+c*[.2126,.7152,.0722][i],0);
        const a=lum(style.color), b=lum(style.backgroundColor);
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5;
      })`),
        true
      );
    };
    await badgeContrast();
    await capture('pr-labels-light');
    window.setSize(1024, 700);
    await js("document.documentElement.classList.add('dark')");
    await badgeContrast();
    await capture('pr-labels-dark-laptop');
    window.setSize(800, 700);
    await capture('pr-labels-dark-narrow');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await window.loadURL(fixtureUrl + '?views');
    window.setSize(1280, 800);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    const enterViewName = async (name: string) => {
      await js(`(() => { const input = document.querySelector('.view-name-form input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
      await js("document.querySelector('.view-name-form').requestSubmit()");
      await wait("!document.querySelector('.view-name-form')");
    };
    const pickView = async (name: string) => {
      await js(
        `Array.from(document.querySelectorAll('.saved-view-link')).find(b=>b.querySelector('.saved-view-name').textContent===${JSON.stringify(name)}).click()`
      );
      await wait(`document.querySelector('.queue-toolbar h1').textContent === ${JSON.stringify(name)}`);
    };
    const manageView = async (name: string, action: string) => {
      await js(
        `(() => { const trigger = document.querySelector('[aria-label="Manage '+${JSON.stringify(name)}+'"]'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); })()`
      );
      await wait("!!document.querySelector('[role=menu]')");
      await js(
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent===${JSON.stringify(action)}).click()`
      );
    };
    await click('Save view…');
    await enterViewName('All work');
    await wait("document.querySelector('.queue-toolbar h1').textContent === 'All work'");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Author', 'lena');
    await js('document.querySelector(\'[aria-label="Close filters"]\').click()');
    await wait("!!document.querySelector('.view-modified') && document.querySelectorAll('.queue-item').length === 2");
    assert.equal(await js("document.querySelector('.saved-view-count').textContent"), '7');
    await click('Save as new view…');
    await enterViewName('Lena');
    await pickView('All work');
    await wait("!!document.querySelector('.view-modified') && document.querySelectorAll('.queue-item').length === 2");
    await click('Restore saved filters');
    await wait("!document.querySelector('.view-modified') && document.querySelectorAll('.queue-item').length === 7");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Author', 'sam');
    await js('document.querySelector(\'[aria-label="Close filters"]\').click()');
    await click('Save changes');
    await wait(
      "!document.querySelector('.view-modified') && document.querySelector('.saved-view-count').textContent === '2'"
    );
    await manageView('Lena', 'Rename');
    await enterViewName('Lena PRs');
    await manageView('All work', 'Duplicate');
    await wait("document.querySelectorAll('.saved-view-row').length === 3");
    await wait("document.querySelector('.queue-toolbar h1').textContent === 'All work copy'");
    await js(`(() => { window.viewDragData = new DataTransfer();
      document.querySelectorAll('.saved-view-drag')[2].dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:window.viewDragData})); })()`);
    await js(
      "document.querySelectorAll('.saved-view-row')[0].dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:window.viewDragData}))"
    );
    await wait("document.querySelector('.saved-view-name').textContent === 'All work copy'");
    await manageView('All work copy', 'Move down');
    await wait("document.querySelectorAll('.saved-view-name')[1].textContent === 'All work copy'");
    await js("document.querySelector('.queue-filter-toggle').click()");
    await selectFilter('Author', 'owen');
    await js('document.querySelector(\'[aria-label="Close filters"]\').click()');
    await pickView('Lena PRs');
    await pickView('All work copy');
    await wait("!!document.querySelector('.view-modified')");
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.author==='owen')");
    window.reload();
    await wait(
      "document.querySelector('.queue-toolbar h1')?.textContent === 'All work copy' && !!document.querySelector('.view-modified')"
    );
    await capture('saved-views-light');
    window.setSize(1024, 700);
    await js("document.documentElement.classList.add('dark')");
    await capture('saved-views-dark-laptop');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.setSize(800, 700);
    await capture('saved-views-dark-narrow');
    assert.ok(await js("document.querySelector('.queue-search').getBoundingClientRect().width >= 160"));
    await manageView('Lena PRs', 'Rename');
    await wait("!!document.querySelector('.view-name-form input')");
    await capture('saved-views-rename-narrow');
    assert.equal(
      await js(
        '(() => { const r = document.querySelector(\'[aria-label="Rename saved view"]\').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()'
      ),
      true
    );
    await click('Cancel');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await manageView('All work copy', 'Delete view');
    await wait(
      "document.querySelectorAll('.saved-view-row').length === 2 && document.querySelectorAll('.queue-item').length === 7"
    );
    await window.loadURL(fixtureUrl + '?stacks');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    const navigate = async (name: string) => {
      await js(
        `Array.from(document.querySelectorAll('.workbench-sidebar button')).find(b=>b.querySelector('span')?.textContent===${JSON.stringify(name)}).click()`
      );
    };
    await navigate('Review requests');
    await navigate('Stacks');
    await wait("document.querySelectorAll('.queue-item').length === 3");
    assert.deepEqual(
      await js("Array.from(document.querySelectorAll('.queue-section-title')).map(h=>h.childNodes[0].textContent)"),
      ['Changed since AI explanation', 'Review requested', 'Other changes']
    );
    assert.equal(await js("document.body.textContent.includes('Other PRs depend on this')"), false);
    await wait("window.electronAPI.workbenchQueue().then(q=>q.filters.kind==='stack' && q.filters.attention==='all')");
    await capture('stacks-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('stacks-dark');
    window.reload();
    await wait(
      "document.querySelector('.queue-toolbar h1')?.textContent === 'Stacks' && document.querySelectorAll('.queue-item').length === 3"
    );
    await navigate('Review queue');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    window.webContents.setZoomFactor(1.25);
    await capture('typeset-zoom-light');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    window.webContents.setZoomFactor(1);
    // Background generation never replaces the current review. Completion toasts
    // remain actionable after navigation and open the exact saved topic.
    window.setSize(1280, 800);
    await window.loadURL(fixtureUrl + '?notifications');
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await wait("document.querySelector('.activity-summary')?.textContent.includes('2 running')");
    assert.equal(await js("document.querySelectorAll('[data-slot=toast]').length"), 0, 'No historical ready toasts');
    await js(`(async () => {
      const review = await window.electronAPI.loadReview('workbench-review');
      const artifact = review.slides[0].explainer;
      delete review.slides[0].explainer;
      const tasks = [];
      window.electronAPI.listActivity = async () => structuredClone(tasks);
      window.electronAPI.generateExplainer = (req) => {
        document.body.dataset.explainerCalls = String(Number(document.body.dataset.explainerCalls ?? 0) + 1);
        const task = {id:'exploration:notification',kind:'exploration',title:review.prTitle,detail:'Generating the example',reviewId:req.reviewId,slideId:req.slideId,status:'running',updatedAt:new Date().toISOString(),canCancel:true,canRetry:false};
        tasks.push(task);
        return new Promise(resolve => {
          window.finishExploration = () => {
            review.slides.find(s=>s.id===req.slideId).explainer = artifact;
            Object.assign(task,{status:'completed',detail:'Bound work before it reaches the worker',canCancel:false,updatedAt:new Date().toISOString()});
            resolve(artifact);
          };
        });
      };
      window.finishReview = () => tasks.push({id:'review:notification',kind:'review',title:'Completed background review',detail:'Ready',reviewId:'workbench-review',status:'completed',updatedAt:new Date().toISOString(),canCancel:false,canRetry:false});
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    await click('Create interactive explanation');
    await wait("document.querySelector('[data-slot=toast]')?.textContent.includes('Building interactive explanation')");
    assert.equal(await js("!!document.querySelector('.review-tool-slot iframe')"), false);
    assert.equal(await js("!!document.querySelector('.review-code .review-diff')"), true);
    await click('View activity');
    await wait("document.querySelector('.activity-task')?.textContent.includes('Generating the example')");
    assert.equal(await js("!!document.querySelector('.activity-task [role=progressbar]')"), true);
    await capture('exploration-background');
    await js('document.querySelector(\'[aria-label="Close activity"]\').click()');
    await click('Review queue');
    await wait("!!document.querySelector('.queue-list')");
    await js("document.querySelector('.queue-search input').focus()");
    await js('window.finishExploration()');
    await wait("document.querySelector('[data-slot=toast]')?.textContent.includes('Interactive explanation ready')");
    assert.equal(
      await js("document.activeElement === document.querySelector('.queue-search input')"),
      true,
      'Notification must not steal focus'
    );
    await capture('ready-notification-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('ready-notification-dark');
    window.setSize(800, 700);
    await capture('ready-notification-narrow');
    await js("document.documentElement.classList.remove('dark')");
    await capture('ready-notification-narrow-light');
    await js("document.documentElement.classList.add('dark')");
    assert.equal(
      await js(
        "document.querySelector('.app-toasts').getBoundingClientRect().bottom < document.querySelector('.activity-shell').getBoundingClientRect().top"
      ),
      true
    );
    await js("document.querySelector('[data-slot=toast] .app-toast-action').click()");
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js("document.querySelector('[aria-label=\"Review topic\"]').value"), '1');
    assert.equal(
      await js('Number(document.body.dataset.explainerCalls)'),
      1,
      'Opening a completed result uses its saved artifact'
    );
    await wait("!document.querySelector('[data-slot=toast]')");
    await js('window.finishReview()');
    await wait("document.querySelector('[data-slot=toast]')?.textContent.includes('Review ready')");
    await js("document.querySelector('[data-slot=toast] .app-toast-action').click()");
    await wait("!document.querySelector('.review-tool-slot iframe') && !!document.querySelector('.review-toolbar')");
    await wait("!document.querySelector('[data-slot=toast]')");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(
      await js("document.querySelectorAll('[data-slot=toast]').length"),
      0,
      'Repeated polling must not duplicate ready notifications'
    );

    console.log('Workbench browser checks passed. Screenshots: ' + shots);
  } catch (error) {
    console.error(error);
    console.log(await js('document.body.innerText'));
    await capture('failure');
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
