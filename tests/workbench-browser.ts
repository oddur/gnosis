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
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
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
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing button: '+${JSON.stringify(text)});b.click();})()`
    );
  };
  const shots = process.env.GNOSIS_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'gnosis-workbench-screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(shots, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(fixtureUrl);
    await wait("document.querySelectorAll('.queue-item').length === 7");
    await js(
      `(() => { const select = document.querySelector('[aria-label="Review model"]'); select.value = 'codex:gpt-6-astra'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`
    );
    assert.equal(await js('window.electronAPI.loadPreferences().then(p => p.model)'), 'gpt-6-astra');
    assert.equal(
      await js('window.electronAPI.loadPreferences().then(p => p.proactiveReviewOverrides)'),
      false,
      'The workbench model must apply to briefings too'
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
    match(await js(`document.querySelector('[aria-label="Briefing model"]').textContent`), /GPT-6 Astra/);
    await js('document.querySelector(\'.queue-disclosure[aria-label*="Introduce"]\').click()');
    assert.equal(await js("document.querySelectorAll('.queue-member').length"), 3);
    await capture('queue-light');
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
    await click('Continue review');
    await wait("!!document.querySelector('.workbench-overview')");
    await capture('overview-dark');
    assert.ok(await js("document.querySelector('.activity-summary')?.textContent.includes('2 running')"));
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    assert.equal(await js("document.querySelectorAll('.source-attribution').length"), 1);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await capture('review-dark');
    await click('Ask a question');
    await wait("!!document.querySelector('.review-tool-slot .chat-sheet')");
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 350"), true);
    await capture('chat-dark');
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
    await js(`(() => {
      const target = document.querySelector('[aria-label="PR for review submission"]');
      target.value = 'https://github.com/klang/engine/pull/122';
      target.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await click('Submit to GitHub');
    await wait("!!document.querySelector('.submission-destination')");
    assert.equal(
      await js("document.querySelector('.submission-destination a').textContent.trim()"),
      'klang/engine #122'
    );
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
    await js(`(() => {
      const topic = document.querySelector('[aria-label="Review topic"]');
      topic.value = '2'; topic.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await wait(
      "document.querySelector('.interactive-explanation-prompt')?.textContent.includes('Create interactive explanation')"
    );
    await click('Create interactive explanation');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js('Number(document.body.dataset.explainerCalls)'), 1);
    await click('Close interactive explanation');
    await wait(
      "document.querySelector('.interactive-explanation-prompt')?.textContent.includes('Open interactive explanation')"
    );
    await click('Open interactive explanation');
    await wait("!!document.querySelector('.review-tool-slot iframe')");
    assert.equal(await js('Number(document.body.dataset.explainerCalls)'), 1);
    await click('Close interactive explanation');
    await js(`(() => {
      const topic = document.querySelector('[aria-label="Review topic"]');
      topic.value = '1'; topic.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);

    window.setSize(1440, 900);
    await capture('review-large');
    window.setSize(800, 700);
    await wait('innerWidth <= 800');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await wait('!!document.querySelector(\'[aria-label="Review pane"]\')');
    await click('Code');
    assert.equal(await js("document.querySelector('.review-code').getBoundingClientRect().width > 600"), true);
    await capture('review-narrow');
    await click('Explanation');
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
    match(await js("document.querySelector('.briefing-status').textContent"), /Daily briefing limit reached/);
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
    await js("[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Appearance').focus()");
    await wait("document.querySelector('[role=tabpanel][data-state=active]')?.textContent.includes('Code font')");
    assert.equal(await js("document.querySelectorAll('[role=tabpanel][data-state=active] select').length"), 2);
    match(await js("document.querySelector('[role=tabpanel][data-state=active]').textContent"), /Light/);
    window.setSize(800, 700);
    await capture('settings-appearance-narrow');
    await js("[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes('Queue')).focus()");
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
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Search reviews');
    await window.webContents.insertText('queue');
    assert.equal(await js('document.querySelector(\'[aria-label="Search reviews"]\').value'), 'queue');
    await press('Down');
    assert.equal(await js("document.activeElement?.getAttribute('aria-pressed')"), 'true');
    await press('Enter');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("document.querySelectorAll('.review-file-context').length === 2");
    match(await js("document.querySelector('.staleBanner-unknown').textContent"), /API limit was reached/);
    assert.equal(await js("document.querySelector('.staleBanner-unknown details').open"), false);
    assert.ok(await js("document.querySelector('.staleBanner-unknown').getBoundingClientRect().height < 100"));
    await js("document.documentElement.classList.add('dark')");
    await js("document.querySelector('.review-code').parentElement.scrollTop = 300");
    const sticky = await js<{ offset: number; text: string }>(`(() => {
      const pane = document.querySelector('.review-code').parentElement;
      const header = document.querySelector('.review-file-context');
      return { offset: header.getBoundingClientRect().top - pane.getBoundingClientRect().top, text: header.textContent };
    })()`);
    assert.ok(Math.abs(sticky.offset) < 2, 'Source header must stay pinned during diff scroll');
    assert.match(sticky.text, /PR #121/);
    assert.match(sticky.text, /command-queue.ts/);
    assert.ok(
      await js(
        "document.querySelector('pre.aurora-x').innerHTML.includes('#91A7B2') || document.querySelector('pre.aurora-x').innerHTML.includes('#91a7b2')"
      )
    );
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
      return Math.abs(header.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 2 && header.textContent.includes('PR #122');
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
    await wait("document.querySelector('.getting-started')?.textContent.includes('was not found')");
    assert.ok(await js("document.body.textContent.includes('Your GitHub queue is not connected')"));
    await capture('onboarding-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('onboarding-dark');
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
    await click('Show getting started');
    await wait("!!document.querySelector('.getting-started') && !document.querySelector('.workbench-help')");
    await click('Sign in to GitHub');
    await wait("!document.querySelector('.workbench-connect')");
    assert.ok(await js("document.body.textContent.includes('No pull requests in your queue')"));
    await js(`(() => {
      const input = document.querySelector('[aria-label="Search reviews"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'absent');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await wait("document.body.textContent.includes('No matching changes')");
    await click('Clear filters');
    await wait("document.querySelector('[aria-label=\"Search reviews\"]').value === ''");
    await js('document.querySelector(\'[title="Saved reviews"]\').click()');
    await wait("document.body.textContent.includes('No saved reviews yet')");
    await js('document.querySelector(\'[title="Work queue"]\').click()');
    await js('void (window.fixtureQueue = window.electronAPI.workbenchQueue)');
    await js("void (window.electronAPI.workbenchQueue = () => Promise.reject(new Error('Fixture network failure')))");
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
    await click('Open a pull request');
    await wait('!!document.querySelector(\'[aria-label="Pull request URL"]\')');
    await js(`(() => {
      const input = document.querySelector('[aria-label="Pull request URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://github.com/klang/engine/pull/120');
      input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await click('Start guided review');
    await wait("document.querySelectorAll('.queue-item').length === 7 && !document.querySelector('.getting-started')");
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Continue review');
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
