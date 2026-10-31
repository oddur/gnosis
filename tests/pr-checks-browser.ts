import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const rendererErrors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') rendererErrors.push(message);
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(
      'Timed out: ' +
        code +
        '\nRenderer errors: ' +
        rendererErrors.join('\n') +
        '\nScreen: ' +
        (await js<string>('document.body.innerText.slice(0, 4000)'))
    );
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  const capture = async (name: string) => {
    await new Promise((r) => setTimeout(r, 180));
    const dir = path.resolve('.impeccable/review/pr-checks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await win.loadURL(url + '?pr-summary&checks');
    await wait("document.querySelectorAll('.queue-item').length===7", 60_000);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("document.querySelectorAll('.pr-check-summary li').length===3");
    await capture('summary-light');
    await js("document.querySelector('.pr-check-summary li button').click()");
    await wait("!!document.querySelector('.check-steps')");
    assert.equal(
      await js("document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('data-state')"),
      'active'
    );
    assert.equal(await js("document.body.dataset.checkLogCalls ?? '0'"), '0');
    assert.equal(await js("document.querySelectorAll('.check-row').length"), 6);
    assert.ok(await js("document.querySelector('.check-detail-header')?.textContent.includes('Required')"));
    await capture('desktop-light');
    await click('Needs attention (3)');
    assert.equal(await js("document.querySelectorAll('.check-row').length"), 3);
    await click('Running (1)');
    assert.equal(await js("document.querySelectorAll('.check-row').length"), 1);
    await click('All checks');
    await js("document.querySelector('.check-annotations button').click()");
    await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent==='Changes'");
    await wait(
      "Array.from(document.querySelectorAll('[data-diff-host]')).some(n=>n.getAttribute('aria-label')==='Source at new line 35') || document.querySelector('[aria-label=\"Source at new line 35\"]') !== null"
    );
    await js(
      "(()=>{const b=[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.startsWith('Checks'));b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()"
    );
    await wait("document.querySelectorAll('.check-row').length===6");
    await js("[...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('Tests / macOS')).click()");
    await wait("!!document.querySelector('.check-steps')");
    await click('Load log');
    await wait('!!document.querySelector(\'[aria-label="Job log"]\')');
    assert.equal(await js('document.body.dataset.checkLogCalls'), '1');
    await click('Re-run failed jobs');
    await wait("document.body.dataset.rerunCalls==='1'");
    await wait("document.querySelector('.check-detail').textContent.includes('Rerun requested')");
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Re-run failed jobs').disabled")
    );
    // A refresh must preserve the old detail and log until the reader accepts newer results.
    await js('window.checksFixture.advance();document.querySelector(\'[aria-label="Refresh checks"]\').click()');
    await wait("!!document.querySelector('.checks-update')");
    assert.ok(await js("document.querySelector('[aria-label=\"Job log\"]').textContent.includes('check:1')"));
    await capture('updated-results');
    await click('View latest results');
    await wait("!document.querySelector('.checks-update') && !!document.querySelector('.check-steps')");
    // A slow log response must never appear in the next selected check.
    await js('void (window.electronAPI.getCheckLog=()=>new Promise(resolve=>window.finishCheckLog=resolve))');
    await click('Load log');
    await js("[...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('TypeScript')).click()");
    await wait("document.querySelector('.check-detail-header h2')?.textContent==='TypeScript'");
    await js("window.finishCheckLog({text:'WRONG JOB LOG',truncated:false})");
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!(await js("document.querySelector('.check-detail').textContent.includes('WRONG JOB LOG')")));
    assert.ok(
      await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Re-run failed jobs').disabled")
    );
    await js("[...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('Buildkite')).click()");
    await wait("document.querySelector('.check-detail').textContent.includes('Requirement unknown')");
    assert.ok(!(await js("!!document.querySelector('.check-logs')")));
    // Queue checks shortcut preserves the stack and its source groups.
    await win.loadURL(url + '?checks');
    await js("void Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })");
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      "document.querySelector('.queue-stack-icon').closest('.queue-item').querySelector('.queue-checks').click()"
    );
    await wait(
      "document.querySelectorAll('.checks-pr-group').length===3 && document.querySelectorAll('.check-row').length===18"
    );
    await js("[...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('Tests / macOS')).click()");
    await wait("!!document.querySelector('.check-steps')");
    await capture('stack-light');
    await js(
      "document.querySelector('.checks-list').scrollTop=10000;document.querySelector('.check-detail').scrollTop=10000"
    );
    await wait(
      "document.querySelector('.check-detail-header').getBoundingClientRect().top >= document.querySelector('.check-detail').getBoundingClientRect().top - 1"
    );
    assert.ok(await js("document.querySelector('.check-source').textContent.includes('#120')"));
    await capture('stack-scrolled');
    await js("document.querySelector('.checks-list').scrollTop=0;document.querySelector('.check-detail').scrollTop=0");
    await js("document.documentElement.classList.add('dark')");
    win.setContentSize(900, 760);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await capture('laptop-dark');
    win.setContentSize(620, 760);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await capture('narrow-dark');
    // A stale queued list entry must use fresh job state, with a local live clock.
    await js(`(()=>{
      const original=window.electronAPI.getCheckDetails;
      window.stepDetailCalls=0;
      const start=new Date(Date.now()-65_000).toISOString();
      window.electronAPI.getCheckDetails=async input=>{
        if(input.id!=='check:3')return original(input);
        window.stepDetailCalls++;
        const done=!!window.stepsFinished;
        return {...input,title:'Build / Linux',summary:'',text:'',annotations:[],
          state:{status:done?'completed':'in_progress',conclusion:done?'success':null,startedAt:start,completedAt:done?new Date(Date.parse(start)+70_000).toISOString():null},
          job:{id:3,runId:9,attempt:1,status:done?'completed':'in_progress',canRerun:true,steps:[
            {name:'Set up job',number:1,status:'completed',conclusion:'success',startedAt:start,completedAt:new Date(Date.parse(start)+3000).toISOString()},
            {name:'Install dependencies',number:2,status:done?'completed':'in_progress',conclusion:done?'success':null,startedAt:start,completedAt:done?new Date(Date.parse(start)+70_000).toISOString():null},
            {name:'Run unit tests',number:3,status:done?'completed':'pending',conclusion:done?'skipped':null}
          ]}};
      };
      for(const snapshot of window.checksFixture.snapshots.values())snapshot.checks.find(c=>c.id==='check:3').status='queued';
      [...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('Build / Linux')).click();
    })()`);
    await wait("document.querySelector('.check-steps [aria-current=step]')?.textContent.includes('Running')");
    assert.ok(await js("document.querySelector('.check-detail-header').textContent.includes('Running')"));
    assert.ok(await js("document.querySelector('.check-steps [data-state=passed]').textContent.includes('3s')"));
    assert.ok(
      await js("document.querySelector('.check-steps [data-state=pending]').textContent.includes('Not started')")
    );
    const initialTime = await js("document.querySelector('[aria-current=step] .check-step-duration').textContent");
    const initialCalls = await js('window.stepDetailCalls');
    await wait(
      `document.querySelector('[aria-current=step] .check-step-duration').textContent!==${JSON.stringify(initialTime)}`
    );
    assert.equal(await js('window.stepDetailCalls'), initialCalls, 'Timer must not request GitHub data');
    win.setContentSize(1280, 800);
    await capture('running-desktop');
    win.setContentSize(900, 760);
    await capture('running-laptop');
    win.setContentSize(620, 1000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await js("document.querySelector('.check-job-steps').scrollIntoView({block:'end'})");
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    await capture('running-narrow');
    await js('window.stepsFinished=true;document.querySelector(\'[aria-label="Refresh job steps"]\').click()');
    await wait(
      "!document.querySelector('.check-steps [aria-current=step]') && document.querySelector('.check-detail-header').textContent.includes('Passed')"
    );
    assert.ok(await js("document.querySelector('.check-steps').textContent.includes('1m 10s')"));
    assert.ok(await js("document.querySelector('.check-steps [data-state=skipped]').textContent.includes('Skipped')"));
    await capture('finished-narrow');
    console.log('PR Checks browser checks passed');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.destroy();
    app.exit(1);
  }
});
