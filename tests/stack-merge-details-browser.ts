import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw Error(`${code}: ${String(error)}`);
    }) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 300; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(`Timed out: ${code}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready.then(() => undefined)');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dir = path.resolve('.impeccable/review/stack-merge-details');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(async()=>{
      window.testStack=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>{
        const number=Number(value.url.split('/').pop());
        return {...value,checks:{state:number===122?'failure':'success',total:1,passed:number===122?0:1},readiness:number===121?undefined:{...value.readiness,mergeable:number===120?'CONFLICTING':'MERGEABLE',mergeState:number===120?'DIRTY':number===122&&window.optionalMode?'CLEAN':'BLOCKED',reviewDecision:number===122&&!window.optionalMode?'REVIEW_REQUIRED':'APPROVED'}};
      });
      const readChecks=window.electronAPI.getPrChecks;
      window.electronAPI.getPrChecks=async(...args)=>{
        const result=await readChecks(...args);
        return {...result,checks:result.checks.slice(0,1).map(c=>({...c,name:'Build and test',required:!result.url.endsWith('/122'),status:'completed',conclusion:result.url.endsWith('/122')?'cancelled':'failure'}))};
      };
      window.publishStatus=async()=>{const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(window.testStack.subject.members.map(({url,headSha})=>({url,headSha}))));};
      await window.publishStatus();
    })()`);
    await js(
      "document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"
    );
    await wait("document.querySelectorAll('.stack-merge-issue').length===3");
    await wait(
      "document.querySelector('.stack-merge-details').textContent.includes('Build and test — failed (required)')"
    );
    const text = await js<string>("document.querySelector('.stack-merge-details').textContent");
    assert.match(text, /#120Merge conflicts/);
    assert.match(text, /Rebase onto main, or merge main/);
    assert.match(text, /#122Approval required/);
    assert.match(text, /Required approvals are missing/);
    assert.match(text, /#121Merge status not checked/);
    assert.ok(text.indexOf('#122') < text.indexOf('#121'), 'Known requirements precede unknown status');
    const viewport = async (width: number, height: number) => {
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await wait(`innerWidth === ${width} && innerHeight === ${height}`);
    };
    const besideList = () => js<boolean>(`(()=>{
      const list=document.querySelector('.stack-overview').getBoundingClientRect();
      const issues=document.querySelector('.stack-merge-details').getBoundingClientRect();
      return issues.left >= list.right && Math.abs(issues.top-list.top)<2;
    })()`);
    await viewport(1100, 850);
    assert.ok(await besideList(), 'Merge details support the PR list in a separate column');
    await capture('light');
    await js("document.documentElement.classList.add('dark')");
    await viewport(1747, 1100);
    await capture('user-1747');
    await viewport(1100, 850);
    await capture('dark-laptop');
    await viewport(900, 1050);
    assert.ok(await js(`document.querySelector('.stack-merge-details').getBoundingClientRect().top >= document.querySelector('.stack-summary-main').getBoundingClientRect().bottom`), 'Narrow layout follows the DOM reading order');
    await capture('compact');
    await viewport(640, 1100);
    await capture('narrow');
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
    // Optional checks remain visible without being counted as merge blockers.
    await js('window.optionalMode=true;window.publishStatus()');
    await wait(`document.querySelector('[aria-label="Checks that do not block merging"]')?.textContent.includes('Optional checks did not pass')`);
    assert.match(await js<string>("document.querySelector('.pr-merge-status').textContent"), /Cannot merge stack · 1 PR is blocked/);
    await viewport(1100, 950);
    await capture('optional-checks');
    await js("document.documentElement.style.zoom='2'");
    await viewport(1100, 1200);
    assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'), 'Status text wraps at 200% zoom');
    await capture('zoom-200');
    await js("document.documentElement.style.zoom=''");
    await js('window.optionalMode=false;window.publishStatus()');
    await wait("document.querySelector('.stack-merge-details').textContent.includes('Approval required')");
    // Old status remains explicitly qualified, and old check names are not presented as current failures.
    await js(
      "window.realNow=Date.now;Date.now=()=>window.realNow()+6*60*1000;window.dispatchEvent(new Event('fixture-pr-read-change'));void 0"
    );
    await wait("document.querySelector('.stack-merge-details').textContent.includes('Last reported: Merge conflicts')");
    assert.ok(await js("!document.querySelector('.stack-merge-details').textContent.includes('Build and test')"));
    await js("Date.now=window.realNow;window.dispatchEvent(new Event('fixture-pr-read-change'));void 0");
    await wait("document.querySelector('.stack-merge-details').textContent.includes('Build and test')");
    // Large stacks keep the initial list short and disclose every additional cause.
    await js(`(async()=>{const s=window.testStack.subject;for(const number of [123,124])s.members.push({...s.members[0],number,url:'https://github.com/klang/engine/pull/'+number});await window.publishStatus();window.dispatchEvent(new Event('fixture-pr-read-change'));})()`);
    await wait("document.querySelector('.stack-merge-more summary')?.textContent==='Show 1 more PR'");
    await js("document.querySelector('.stack-merge-more summary').click()");
    await wait("document.querySelector('.stack-merge-more')?.open===true");
    assert.equal(await js("document.querySelectorAll('.stack-merge-issue').length"), 5);
    await js(`(async()=>{window.testStack.subject.members.splice(3);await window.publishStatus();window.dispatchEvent(new Event('fixture-pr-read-change'));})()`);
    await wait("!document.querySelector('.stack-merge-more')");
    // Check navigation preserves the exact PR scope.
    await js(
      "[...document.querySelectorAll('.stack-merge-issue')].find(e=>e.textContent.includes('#122')).querySelectorAll('button')[1].click()"
    );
    await wait(
      "document.querySelector('[role=tab][data-active]')?.textContent.includes('Checks') || document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('Checks')"
    );
    assert.ok(await js("document.querySelector('.pr-overview-heading').textContent.includes('Enable adaptive')"));
    console.log(
      'Stack merge details passed: exact PR causes, approval and check evidence, unknown state, action scope, light/dark and narrow layout.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      console.log(await js('document.body.innerText'));
    } catch {
      /* Renderer unavailable. */
    }
    app.exit(1);
  }
});
