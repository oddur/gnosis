import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + code);
  };
  const click = (text: string) =>
    js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click()})()`
    );
  const input = (selector: string, value: string) =>
    js(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  // Buttons by aria-label, with the mousedown Radix and the searchable selects listen for.
  const press = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const dir = path.resolve('.impeccable/review/explanation-options');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const open = async (query = '') => {
    await win.loadURL(process.env.GNOSIS_WORKBENCH_URL!.replace('workbench.html', 'explanation-options.html') + query);
    await js('sessionStorage.clear()');
    await wait("!!document.querySelector('.explanation-setup-dialog')");
  };
  const count = async (n: number) =>
    wait(`document.querySelector('.explanation-files-disclosure')?.textContent.includes('${n} of 4 included')`);
  try {
    await open();
    await count(3);
    assert.equal(await js("sessionStorage.getItem('attempts')"), null, 'Opening setup must not start a model');
    assert.equal(await js("!!document.querySelector('.explanation-file-tree')"), false);
    // Reduce noise: a segmented control beside the file rules, Conservative by default.
    const noise = "[...document.querySelectorAll('.explanation-noise-switch [role=radio]')]";
    assert.deepEqual(await js(`${noise}.map(b=>b.textContent)`), ['Off', 'Conservative', 'Aggressive']);
    assert.equal(await js(`${noise}.find(b=>b.getAttribute('aria-checked')==='true').textContent`), 'Conservative');
    assert.equal(await js("document.querySelector('.explanation-noise-switch').getAttribute('role')"), 'radiogroup');
    await js(`${noise}.find(b=>b.textContent==='Aggressive').click()`);
    await wait(`${noise}.find(b=>b.getAttribute('aria-checked')==='true')?.textContent==='Aggressive'`);
    assert.match(await js<string>("document.querySelector('.explanation-noise-description').textContent"), /small related edits/);
    // Arrow keys move the choice, as in any radio group.
    await js(`${noise}.find(b=>b.textContent==='Aggressive').focus()`);
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    await wait(`${noise}.find(b=>b.getAttribute('aria-checked')==='true')?.textContent==='Off'&&document.activeElement.textContent==='Off'`);
    await js(`${noise}.find(b=>b.textContent==='Aggressive').click()`);
    // Focused sections (#562): chosen per explanation here, off by default, sent with the options.
    const focused = "document.querySelector('.explanation-setup-dialog .explanation-focused-setting input')";
    assert.equal(await js(`${focused}?.checked`), false, 'Focused sections shows in the dialog, off by default');
    await js(`${focused}.click()`);
    await wait(`${focused}.checked===true`);
    // Model and reasoning effort (#573): Settings' review model by default, from every provider's models.
    const picker = `document.querySelector('.explanation-setup-dialog [aria-label="Explanation model"]')`;
    assert.match(await js<string>(`${picker}?.textContent`), /Opus 5\.5.*High/, 'The review model and effort are the default');
    await press('Explanation model');
    await wait("!!document.querySelector('.model-picker-popup')");
    await press('Explanation model selection');
    await wait("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('GPT-6.1 Terra'))");
    assert.equal(await js("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent.includes('Sonnet 5.5'))"), true);
    await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('GPT-6.1 Terra')).click()");
    await wait(`${picker}.textContent.includes('GPT-6.1 Terra')`);
    await js("document.querySelector('.model-picker-popup input[type=radio][value=low]').click()");
    await wait(`${picker}.textContent.includes('Low')`);
    await click('Done');
    await wait("!document.querySelector('.model-picker-popup')");
    await capture('compact');
    await js(
      "[...document.querySelectorAll('.explanation-file-rules label')].find(e=>e.textContent.includes('Test files')).querySelector('input').click()"
    );
    await count(2);
    await js("document.querySelector('.explanation-files-disclosure').click()");
    await click('.md');
    await count(1);
    await input('[aria-label="Find explanation files"]', 'generated');
    await wait('!!document.querySelector(\'[aria-label="Include generated/schema.ts"]\')');
    await js('document.querySelector(\'[aria-label="Include generated/schema.ts"]\').click()');
    await count(2);
    await input('[aria-label="Find explanation files"]', '');
    await capture('files');
    await click('Exclude all');
    await count(0);
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate explanation').disabled"),
      true
    );
    await click('Reset file choices');
    await count(1);
    await js("document.querySelector('input[value=custom]').click()");
    assert.equal(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Generate explanation').disabled"),
      true
    );
    await input('textarea', 'Focus on ownership and ordering.');
    await js("document.querySelector('.explanation-remember input').click()");
    await js("document.documentElement.classList.add('dark')");
    await capture('custom-dark');
    win.setSize(640, 800);
    await capture('narrow');
    assert.equal(
      await js("document.querySelector('.explanation-setup-footer').getBoundingClientRect().bottom < innerHeight"),
      true
    );
    win.setSize(480, 700);
    await capture('small');
    assert.equal(
      await js("document.querySelector('.explanation-setup-footer').getBoundingClientRect().bottom < innerHeight"),
      true
    );
    assert.equal(
      await js(
        "document.querySelector('.explanation-setup-dialog').scrollWidth<=document.querySelector('.explanation-setup-dialog').clientWidth"
      ),
      true
    );
    await click('Generate explanation');
    await wait("!!document.querySelector('[data-closed]')");
    const attempts = await js<GenerateRequest[]>("JSON.parse(sessionStorage.getItem('attempts'))");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].rememberExplanationOptions, true);
    assert.equal(attempts[0].explanationOptions.style, 'custom');
    assert.equal(attempts[0].explanationOptions.reduceNoise, 'aggressive', 'The level is part of the options');
    assert.equal(attempts[0].explanationOptions.focusedSections, true, 'Focused sections is part of the options');
    assert.deepEqual(attempts[0].explanationOptions.hiddenExtensions, ['.md']);
    assert.equal(attempts[0].explanationOptions.provider, 'codex', 'The chosen provider is part of the options');
    assert.equal(attempts[0].explanationModelChosen, true, 'Remember saves a model chosen here');
    assert.equal(attempts[0].explanationOptions.model, 'gpt-6.1-terra', 'The chosen model is part of the options');
    assert.equal(attempts[0].explanationOptions.effort, 'low', 'The chosen effort is part of the options');
    win.setSize(1280, 850);
    await open('?restore');
    await count(3);
    assert.equal(await js("document.querySelector('input[value=educational]').checked"), true);
    await click('Cancel');
    assert.equal(await js("sessionStorage.getItem('attempts')"), null);
    // Saved data answers at once: no loading state, then GitHub's update for a push replaces it in place.
    await open('?saved');
    await count(3);
    assert.equal(await js('document.documentElement.dataset.loadingSeen'), undefined, 'A saved answer never shows loading');
    assert.equal(await js("!!document.querySelector('.explanation-setup-updated')"), false);
    await js("document.querySelector('input[value=educational]').click()");
    await js("document.querySelector('.explanation-files-disclosure').click()");
    await js('document.querySelector(\'[aria-label="Include CHANGELOG.md"]\').click()');
    await input('[aria-label="Find explanation files"]', 'src/queue.ts');
    await wait('!!document.querySelector(\'[aria-label="Include src/queue.ts"]\')');
    await js('document.querySelector(\'[aria-label="Include src/queue.ts"]\').click()');
    await input('[aria-label="Find explanation files"]', '');
    await count(1);
    await js('window.simulatePush()');
    // Five files now: generated/schema.ts stays filtered and the excluded src/queue.ts stays excluded.
    await wait("document.querySelector('.explanation-files-disclosure')?.textContent.includes('3 of 5 included')");
    assert.equal(
      await js("document.querySelector('.explanation-setup-updated')?.textContent"),
      'Updated for the latest push.'
    );
    assert.equal(await js("document.querySelector('input[value=educational]').checked"), true, 'The style survives');
    assert.equal(await js('document.documentElement.dataset.loadingSeen'), undefined);
    await capture('updated');
    await click('Generate explanation');
    await wait("!!document.querySelector('[data-closed]')");
    const pushed = await js<{ explanationModelChosen?: boolean; explanationOptions: { style: string; fileOverrides: Record<string, boolean> } }[]>(
      "JSON.parse(sessionStorage.getItem('attempts'))"
    );
    assert.equal(pushed[0].explanationOptions.style, 'educational');
    assert.notEqual(pushed[0].explanationModelChosen, true, 'An untouched model is not pinned by Remember');
    assert.deepEqual(pushed[0].explanationOptions.fileOverrides, { 'src/queue.ts': false }, 'Choices for removed files drop');
    // A slow answer shows the loading state after a short delay.
    await open('?slow');
    await wait('document.documentElement.dataset.loadingSeen === "true"');
    await count(3);
    await click('Cancel');
    await open('?load-error');
    await wait("!!document.querySelector('[role=alert]')");
    await click('Retry loading files');
    await count(3);
    await click('Cancel');
    await open('?bulk&start-error');
    await count(3);
    await click('Generate 2 explanations');
    await wait("document.querySelector('[role=alert]')?.textContent.includes('Harness unavailable')");
    assert.equal(await js("sessionStorage.getItem('successful')"), '1');
    await capture('bulk-retry');
    await click('Retry remaining');
    await wait("!!document.querySelector('[data-closed]')");
    const urls = await js<string[]>("JSON.parse(sessionStorage.getItem('attempts')).map(r=>r.prUrl)");
    assert.deepEqual(
      urls.map((u) => u.split('/').pop()),
      ['1', '2', '2']
    );
    await open('?bulk');
    await count(3);
    await js("document.querySelector('.explanation-bulk-options input').click()");
    await js("document.querySelector('input[value=educational]').click()");
    await click('Generate 2 explanations');
    await wait("!!document.querySelector('[data-closed]')");
    assert.deepEqual(await js("JSON.parse(sessionStorage.getItem('attempts')).map(r=>r.explanationOptions.style)"), [
      'educational',
      'educational',
    ]);
    // A saved local explanation must reopen setup directly and preserve its identity.
    await win.loadURL(process.env.GNOSIS_WORKBENCH_URL + '?pr-summary');
    await wait("!!document.querySelector('.queue-row-main')");
    await js(`(async()=>{
      const guide = await window.electronAPI.loadReview('workbench-review');
      const local = {...guide,reviewId:'local-saved',prUrl:'local:/tmp/project#main',snapshot:undefined,slides:[]};
      window.electronAPI.listReviews = async()=>[{id:'local-saved',prTitle:'Local changes',prUrl:local.prUrl,author:'me',savedAt:new Date().toISOString(),status:'completed'}];
      window.electronAPI.loadReview = async()=>local;
      const setup=window.electronAPI.getExplanationSetup;
      window.electronAPI.getExplanationSetup = async request=>{window.setupRequest=request;return setup(request)};
    })()`);
    await js('document.querySelector(\'[aria-label="Saved reviews"]\').click()');
    await wait("document.querySelector('.saved-row .queue-row-main')?.textContent==='Local changes'");
    await js("document.querySelector('.saved-row .queue-row-main').click()");
    await wait("!!document.querySelector('.explanation-no-topics')");
    await click('Generate again');
    await wait("!!document.querySelector('.explanation-setup-footer')");
    assert.equal(await js('window.setupRequest.previousReviewId'), 'local-saved');
    assert.equal(await js('window.setupRequest.prUrl'), 'local:/tmp/project#main');
    await click('Cancel');
    // A level change in the repository's settings marks an explanation that followed the old level out of date.
    await win.loadURL(process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&noise-outdated');
    await wait("!!document.querySelector('.queue-row-main')");
    await js("[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Open AI explanation')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.explanation-noise-outdated')");
    assert.equal(
      await js("document.querySelector('.explanation-noise-outdated span').textContent"),
      'Reduce noise is now Aggressive for this repository. This explanation used Conservative.'
    );
    await capture('noise-outdated');
    await js(`(()=>{const setup=window.electronAPI.getExplanationSetup;window.electronAPI.getExplanationSetup=async r=>{window.setupRequest=r;return setup(r)}})()`);
    await click('Regenerate');
    await wait("!!document.querySelector('.explanation-setup-footer')");
    assert.equal(await js('window.setupRequest.previousReviewId'), 'workbench-review');
    assert.equal(
      await js("document.querySelector('.explanation-noise-switch [aria-checked=true]').textContent"),
      'Aggressive',
      'Regenerate offers the repository’s new level'
    );
    await click('Cancel');
    console.log(
      'Explanation setup passed: scope, styles, model and effort, Reduce noise, overrides, restore, saved answer and push update, cancel, errors, bulk retry, responsive layout.'
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
    await capture('failure');
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
interface GenerateRequest {
  rememberExplanationOptions: boolean;
  explanationModelChosen?: boolean;
  explanationOptions: {
    style: string;
    hiddenExtensions: string[];
    reduceNoise: string;
    focusedSections: boolean;
    provider?: string;
    model?: string;
    effort?: string;
  };
}
