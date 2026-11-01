import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
    await current('Keep the queue focused');
    await capture('filters-light');
    await click('Next');
    await current('Choose how AI helps');
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
    assert.equal(await js("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('GPT'))"), false);
    await js("document.querySelector('[aria-label=\"Search explanation model\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('[aria-label=\"Explanation model\"]')?.textContent.includes('GPT-6.1 Sol')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Briefing model\"]').textContent"), /GPT-6.1 Terra/);
    await capture('ai-codex');
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({claude:'error',codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('.setup-body')?.textContent.includes('Could not check Claude')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Explanation model\"]').textContent"), /GPT-6.1 Sol/);
    await js("sessionStorage.setItem('ftue-tools', JSON.stringify({claude:'found',codex:'found'}))");
    await click('Check again');
    await wait("document.querySelector('.setup-cli')?.textContent.includes('Claude Code and Codex found')");
    await click('Explanation model');
    await fill('[aria-label="Search explanation model"]', 'Opus');
    await wait("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('Opus 5.5'))");
    await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('Opus 5.5')).click()");
    await js("window.selectOption('[aria-label=\"Explanation model effort\"]', 'xhigh')");
    await js("window.selectOption('[aria-label=\"Briefing model effort\"]', 'medium')");
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
    await current('Choose how AI helps');
    await wait("document.querySelector('.setup-cli')?.textContent.includes('Claude Code and Codex found')");
    assert.match(await js<string>("document.querySelector('[aria-label=\"Explanation model\"]').textContent"), /Opus 5.5/);
    assert.match(await js<string>("document.querySelector('[aria-label=\"Briefing model\"]').textContent"), /GPT-6.1 Terra/);
    assert.equal(await js("document.querySelector('[aria-label=\"Explanation model effort\"]').value"), 'xhigh');
    assert.equal(await js("document.querySelector('[aria-label=\"Briefing model effort\"]').value"), 'medium');
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
    await current('Your queue');
    assert.equal(await js("document.querySelector('.setup-summary').textContent.includes('Explanations: Claude · Opus 5.5') && document.querySelector('.setup-summary').textContent.includes('Briefings: Codex · GPT-6.1 Terra')"), true);
    await capture('preview-light');
    assert.equal(await js("document.querySelector('.setup-body').getBoundingClientRect().bottom <= document.querySelector('.setup-actions').getBoundingClientRect().top"), true, 'preview scrolls above the footer');
    await click('Apply setup');
    await wait("document.querySelector('.setup-error')?.textContent.includes('Disk full')");
    await js("sessionStorage.setItem('ftue-retry','true')");
    await click('Apply setup');
    await wait("!document.querySelector('.setup-dialog')");
    assert.equal(await js("window.electronAPI.loadPreferences().then(p=>p.model==='claude-opus-5-5' && p.proactiveProvider==='codex' && p.proactiveModel==='gpt-6.1-terra' && p.proactiveReviewOverrides && p.effort==='xhigh' && p.proactiveEffort==='medium')"), true);
    await js("window.selectOption('[aria-label=\"Review model\"]', 'gpt-6.1-sol')");
    await wait("document.querySelector('[aria-label=\"Review model\"]')?.textContent.includes('GPT-6.1 Sol')");
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
    await js("document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',keyCode:27,bubbles:true,cancelable:true}))");
    await wait("!document.querySelector('.gnosis-tour')");
    await click('Help and terminology');
    await click('Run setup again');
    await current('What brings');
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
    await current('Choose how AI helps');
    await click('Set up AI later');
    await current('Ready for local');
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
    await wait("document.body.innerText.includes('Help') && !document.querySelector('.setup-dialog')");
    await click('Help and terminology');
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
