import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { chooseWorkspaceMenuItem } from './workspace-menu';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #341: the PR header and the queue say when Gnosis last read GitHub, the label ages and renews, and switching to a PR
 * or back to the window asks main to read it again at most every 30 s.
 * #340: a seeded drift shows in Settings › Diagnostics › Sync health, with Check now and Export diagnostics.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const dir = path.resolve('.impeccable/review/sync-health');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const rect = (selector: string) =>
    js<number[] | null>(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`
    );
  // The renderer's clock moves forward without waiting. Timers are unaffected.
  const advance = (ms: number) =>
    js(`(()=>{const now=Date.now;Date.now=()=>now()+${ms};window.dispatchEvent(new Event('focus'))})()`);
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&github-sync`);
    await waitForWorkbenchQueue(win.webContents);

    // ── Queue freshness: quiet, beside Refresh queue, and the button does not move. ──
    const refreshBefore = await rect('[aria-label="Refresh queue"]');
    await js(
      `{const queue=window.electronAPI.workbenchQueue;window.electronAPI.workbenchQueue=async(...args)=>({...await queue(...args),revision:undefined,sync:{status:'idle',checkedAt:Date.now()-120_000}});document.dispatchEvent(new Event('visibilitychange'))}`
    );
    await wait("document.querySelector('.queue-freshness')?.textContent==='Checked 2m ago'");
    assert.deepEqual(
      await rect('[aria-label="Refresh queue"]'),
      refreshBefore,
      'The queue label does not move the toolbar actions'
    );
    assert.match(
      await js<string>("document.querySelector('.queue-freshness').title"),
      /last checked GitHub for queue changes/
    );
    await capture('queue-freshness');

    // ── Open a PR: one refresh request for it. ──
    await js("document.querySelector('.queue-row-main').click()");
    await click('Open PR overview');
    await wait("!!document.querySelector('.pr-summary-context')");
    const url = await js<string>("document.querySelector('.pr-github-link').href");
    await wait('window.fixtureFocusRefreshes.length===1');
    assert.deepEqual(await js('window.fixtureFocusRefreshes'), [[url]]);

    // ── Returning to the window is main's wake alone (30 s floor): the renderer asks for nothing more. ──
    await js(
      "window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))"
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await js('window.fixtureFocusRefreshes.length'), 1, 'Window focus does not add a second refresh path');

    // ── Switching back to the PR within 30 s does not read again; after 30 s it does. ──
    const reopen = async () => {
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("!!document.querySelector('.queue-list') && !document.querySelector('.pr-summary-context')");
      await js("document.querySelector('.queue-row-main').click()");
      await click('Open PR overview');
      await wait("!!document.querySelector('.pr-summary-context')");
    };
    await reopen();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await js('window.fixtureFocusRefreshes.length'), 1, 'Throttled within 30 s');
    await advance(31_000);
    await reopen();
    await wait('window.fixtureFocusRefreshes.length===2');
    assert.deepEqual(await js('window.fixtureFocusRefreshes.at(-1)'), [url]);

    // ── The header label: in the metadata row, ages on the status clock, renews with new signals. ──
    await wait(
      "/^Checked (just now|\\d+m ago)$/.test(document.querySelector('.pr-summary-context .pr-freshness')?.textContent ?? '')"
    );
    const link = await rect('.pr-github-link');
    const row = await rect('.pr-summary-context');
    assert.equal(
      await js("getComputedStyle(document.querySelector('.pr-freshness')).fontVariantNumeric"),
      'tabular-nums'
    );
    await advance(5 * 60_000);
    await wait("document.querySelector('.pr-freshness')?.textContent==='Checked 5m ago'");
    assert.deepEqual(await rect('.pr-github-link'), link, 'The GitHub link does not move as the label ages');
    assert.deepEqual(await rect('.pr-summary-context'), row, 'The metadata row keeps its size');
    await capture('pr-header-aged');
    await js(
      `(()=>{const m=(window.syncFixture.subscriptions);for(const [,i] of m) if(i.kind==='signals'){const t=i.targets.find(t=>t.url===${JSON.stringify(url)});if(t){window.syncFixture.emit({kind:'signals',url:t.url,value:{url:t.url,headSha:t.headSha,checkedAt:Date.now(),comments:4,checks:{state:'success',passed:129,skipped:1,total:130}}});return}}throw Error('No signals subscription')})()`
    );
    await wait("document.querySelector('.pr-freshness')?.textContent==='Checked just now'");
    assert.deepEqual(await rect('.pr-github-link'), link);
    await capture('pr-header-fresh');

    // ── Sync health: a seeded drift appears in Settings › Diagnostics. ──
    await js(`window.fixtureSyncHealth={enabled:true,active:true,checking:false,nextAt:Date.now()+9*60_000,unconfirmed:1,
      drifts:[{url:'https://github.com/acme/app/pull/4821',field:'checks',source:'signals',gnosis:'failure',github:'success',ageMs:95_000,firstSeenAt:Date.now()-3_600_000,lastSeenAt:Date.now()-240_000,count:2},
        {url:'https://github.com/acme/app/pull/4790',field:'comments',source:'signals',gnosis:'4',github:'24',ageMs:40_000,firstSeenAt:Date.now()-600_000,lastSeenAt:Date.now()-600_000,count:1}],
      stale:[{url:'https://github.com/acme/app/pull/4777',at:Date.now()-120_000,fields:['review-decision','approvals'],ageMs:300_000,reason:'github-changed'}],
      runs:[{at:Date.now()-240_000,trigger:'background',sampled:3,cost:3,drift:1,stale:1,failed:0}]}`);
    await js(chooseWorkspaceMenuItem('[aria-label="Settings"]'));
    await wait("!!document.querySelector('[role=dialog] [role=tab]:not(.workspace-tab-select)')");
    await click('Diagnostics');
    await wait("!!document.querySelector('#sync-health-title')");
    await wait("document.querySelectorAll('.sync-health-table tbody tr').length===2");
    const first = await js<string[]>(
      "[...document.querySelectorAll('.sync-health-table tbody tr')][0].innerText.split('\\t').map(s=>s.trim())"
    );
    assert.deepEqual(first.slice(0, 4), ['acme/app#4821', 'Checks', 'failure', 'success']);
    assert.match(first[4], /^2m earlier$/);
    assert.match(first[5], /4m ago · 2×/);
    assert.match(
      await js<string>("document.querySelector('.sync-health-stale').innerText"),
      /acme\/app#4777 · Review decision, Approvals · 5m behind/
    );
    assert.match(
      await js<string>("document.querySelector('.sync-health-summary').textContent"),
      /Last check 4m ago: 3 PRs, 1 mismatch\. Cost 3 GraphQL points\. Next background check in about 9m\./
    );
    assert.equal(
      await js(
        "document.querySelector('[role=switch][aria-label=\"Background sync health checks\"]').getAttribute('aria-checked')"
      ),
      'true'
    );
    await capture('diagnostics-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('diagnostics-dark');
    await js("document.documentElement.classList.remove('dark')");

    // Check now, the toggle and the export.
    await click('Check now');
    await wait('window.fixtureSyncHealthChecks.length===1');
    await wait(
      "/^Last check just now: 3 PRs, 2 mismatches\\./.test(document.querySelector('.sync-health-summary').textContent)"
    );
    await click('Background sync health checks');
    await wait(
      "document.querySelector('[role=switch][aria-label=\"Background sync health checks\"]').getAttribute('aria-checked')==='false'"
    );
    assert.doesNotMatch(
      await js<string>("document.querySelector('.sync-health-summary').textContent"),
      /Next background check/
    );
    await click('Export diagnostics…');
    await wait("document.querySelector('.sync-health')?.textContent.includes('Saved to /tmp/gnosis-diagnostics.json')");
    win.setSize(720, 700);
    await new Promise((r) => setTimeout(r, 200));
    await capture('diagnostics-narrow');
    assert.equal(
      await js('document.documentElement.scrollWidth<=innerWidth'),
      true,
      'No horizontal page scroll at narrow widths'
    );
    await click('Clear');
    await wait(
      "!document.querySelector('.sync-health-table') && document.querySelector('.sync-health').textContent.includes('None yet.')"
    );
    console.log('Sync health browser checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(
      await js<string>(
        "document.querySelector('[role=dialog]')?.innerText.slice(0, 2000) ?? document.querySelector('.pr-summary-context')?.outerHTML ?? ''"
      ).catch(() => '')
    );
    app.exit(1);
  }
});
