import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A twelve-PR stack like a real one: three merged PRs at the base, then open PRs that are mostly healthy
 * (the "healthy" scenario) or need different kinds of attention (the "mixed" scenario).
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string, attempts = 300) => {
    for (let i = 0; i < attempts; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 40)); }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const viewport = async (width: number, height: number) => {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await wait(`innerWidth===${width} && innerHeight===${height}`);
  };
  const shots = path.resolve(process.env.GNOSIS_CAPTURE_DIR || '.impeccable/review/stack-overview'); fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready.then(() => undefined)');
    await js("document.querySelectorAll('*').forEach(element=>{if(element.scrollTop)element.scrollTop=0});document.activeElement?.blur()");
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const theme = (dark: boolean) => js(`document.documentElement.classList.toggle('dark', ${dark})`);
  win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited:', details.reason));
  /** Loads the fixture with the twelve-PR stack open on its Summary tab. */
  const open = async (scenario: 'healthy' | 'mixed') => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&checks`);
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await viewport(1280, 800);
    await waitForWorkbenchQueue(win.webContents);
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();const item=q.items.find(i=>i.subject.kind==='stack');window.stackItem=item;
      const base=item.subject.members[0];
      const titles=['Add the MCP server skeleton','Register MCP tools from the plugin manifest','Stream tool output over MCP','Push GitHub events to MCP clients','Authenticate MCP clients with device codes','Cache resource listings per workspace','Expose review threads as MCP resources','Rate-limit tool calls per client','Report tool failures with structured errors','Document the MCP client setup','Add MCP integration tests','Ship the MCP settings page'];
      const branches=['feat/mcp-skeleton','feat/mcp-tool-registry','feat/mcp-streaming','feat/mcp-push-events','feat/mcp-device-auth','feat/mcp-resource-cache','feat/mcp-review-threads','feat/mcp-rate-limits','feat/mcp-errors','docs/mcp-setup','test/mcp-integration','feat/mcp-settings'];
      const files=[12,30,8,108,45,20,64,15,33,9,27,18];
      const viewed=[12,30,8,6,45,0,10,15,0,9,0,0];
      const members=titles.map((title,i)=>({...base,number:35380+i,url:'https://github.com/klang/engine/pull/'+(35380+i),title,author:i%4===2?'ivar':'lena',headBranch:branches[i],baseBranch:i?branches[i-1]:'main',baseSha:'b'.repeat(39)+i.toString(16),headSha:'c'.repeat(39)+i.toString(16),merged:i<3,state:i<3?'closed':'open',isDraft:false}));
      window.stackMembers=members;
      const check=(id,name,conclusion,required=true,extra={})=>({id:'check:'+id,databaseId:id,name,conclusion,status:conclusion?'completed':'in_progress',kind:'check',provider:'GitHub Actions',required,startedAt:'2026-11-16T10:00:00Z',completedAt:conclusion?'2026-11-16T10:02:03Z':null,url:'https://github.com/klang/engine/actions/runs/9/job/'+id,...extra});
      const healthyChecks=()=>[...Array.from({length:10},(_,n)=>check(n+1,'Build '+(n+1),'success')),...Array.from({length:74},(_,n)=>check(100+n,'Optional job '+(n+1),'skipped',false))];
      window.scenario='${scenario}';
      // Per-PR signal overrides for the mixed scenario, by stack position from the base.
      const mixed={3:{reviewDecision:'APPROVED',behindBy:40},4:{behindBy:40},5:{reviewDecision:'CHANGES_REQUESTED',mergeState:'BLOCKED'},6:{mergeState:'BLOCKED',checks:'failure'},7:{mergeable:'CONFLICTING',mergeState:'DIRTY'},9:{reviewDecision:'REVIEW_REQUIRED',mergeState:'BLOCKED'},10:{isDraft:true,mergeState:'BLOCKED'},11:{mergeState:'BLOCKED',checks:'pending'}};
      const override=i=>window.scenario==='mixed'?(mixed[i]??{}):{};
      window.electronAPI.getQueueSignals=async requests=>requests.map(request=>{const i=members.findIndex(m=>m.url===request.url);const o=override(i);return {...request,checkedAt:Date.now(),comments:0,checks:{state:o.checks??'success',total:84,passed:10,skipped:74},readiness:{state:i<3?'MERGED':'OPEN',isDraft:!!o.isDraft,mergeable:o.mergeable??'MERGEABLE',mergeState:o.mergeState??'CLEAN',reviewDecision:o.reviewDecision??null,baseBranch:members[i]?.baseBranch??'main',baseSha:'base',behindBy:o.behindBy??(window.scenario==='healthy'&&i>=3&&i%2===1?40:0),mergeQueue:false,queueState:null}};});
      window.electronAPI.getPrChecks=async r=>{const i=members.findIndex(m=>m.url===r.url);const o=override(i);let list=healthyChecks();
        if(o.checks==='failure')list=[check(1,'Server tests','failure'),check(2,'TypeScript','failure'),...list.slice(2)];
        if(o.checks==='pending')list=[check(1,'Server tests',null),check(2,'TypeScript',null),check(3,'Lint',null),...list.slice(3)];
        if(window.scenario==='mixed'&&i===4)list=[check(999,'Deploy preview','failure',false),...list];
        return {url:r.url,headSha:r.headSha,checkedAt:Date.now(),checks:list};};
      window.electronAPI.getPreparedInventories=async revisions=>({commits:[],changes:revisions.map(r=>{const i=members.findIndex(m=>m.url===r.url);return {version:1,url:r.url,metadata:{...members[i],changedFileCount:files[i]},comparisonBase:r.baseSha,fetchedAt:Date.now(),files:Array.from({length:files[i]},(_,n)=>({path:'src/mcp/file-'+n+'.ts',status:'modified',additions:1,deletions:1,changeId:'c'+i+'-'+n}))};})});
      const {markFilesViewed}=await import('/lib/file-view-progress.ts');const {fileRevisionKey}=await import('/lib/pr-changes.ts');
      markFilesViewed(members.flatMap((m,i)=>Array.from({length:viewed[i]},(_,n)=>fileRevisionKey(m.url,'src/mcp/file-'+n+'.ts',m.baseSha,m.headSha))),true);
      item.subject.members=members;
      item.subject.edges=members.slice(1).map((m,i)=>({parent:members[i].url,child:m.url,evidence:'branch'}));
      item.briefing={key:'test',status:'failed',error:'Provider unavailable',updatedAt:new Date().toISOString()};
      window.publishStatus=async()=>{const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(members.map(({url,headSha})=>({url,headSha}))));window.dispatchEvent(new Event('fixture-pr-read-change'));};
      await window.publishStatus();
    })()`);
    await js("document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await wait("document.querySelectorAll('.stack-overview-member').length===12");
    await wait("[...document.querySelectorAll('.stack-overview-member')].filter(row=>row.textContent.includes('10 passed')).length>=5 && document.querySelector('.stack-overview-member[data-pr-url$=\"/35383\"]').textContent.includes('6/108')");
    if (scenario === 'mixed') await wait("document.querySelector('.stack-overview').textContent.includes('Conflicts') && document.querySelector('.stack-overview').textContent.includes('2 failed')");
  };
  try {
    for (const scenario of ['healthy', 'mixed'] as const) {
      await open(scenario);
      const sizes = [[1920, 1080], [1280, 800], [760, 800]];
      for (const [width, height] of sizes) {
        await viewport(width, height);
        if (width >= 1280) {
          // Review, Checks and Branch form real columns: every open row starts each value at the same x, under its header.
          const columns = await js<{ header: number[]; rows: number[][] }>(`(()=>{
            const header=[...document.querySelectorAll('.stack-columns-header > span')].slice(2).map(e=>Math.round(e.getBoundingClientRect().left));
            const rows=[...document.querySelectorAll('.stack-overview-member:not(.is-finished)')].map(row=>[...row.querySelectorAll('.stack-member-signals > .stack-status-cell')].map(e=>Math.round(e.getBoundingClientRect().left)));
            return {header,rows};
          })()`);
          assert.equal(columns.rows.length, 9);
          for (const row of columns.rows) assert.deepEqual(row, columns.header, `Status columns line up with their headers at ${width}px: ${JSON.stringify(columns)}`);
          assert.ok(await js("document.querySelector('.stack-columns-header').checkVisibility()"), 'Column names show once above the rows');
          assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
        } else {
          // Narrow lists move the strip under each title, still in shared tracks.
          const rows = await js<number[][]>("[...document.querySelectorAll('.stack-overview-member:not(.is-finished)')].map(row=>[...row.querySelectorAll('.stack-member-signals > .stack-status-cell')].map(e=>Math.round(e.getBoundingClientRect().left)))");
          for (const row of rows) assert.deepEqual(row, rows[0], `Narrow status strips line up: ${JSON.stringify(rows)}`);
          assert.ok(await js("document.querySelector('.stack-overview-member .stack-cell-label').checkVisibility()"), 'Narrow strips label each value');
          assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
        }
      }
      if (scenario === 'healthy') {
        // Defaults are quiet: no repeated "No review required", "Up to date", skipped tallies or optional-update disclosures.
        const quiet = await js<Record<string, number>>(`(()=>{const list=document.querySelector('.stack-overview-members');return {
          quietReview:list.querySelectorAll('.pr-review-status.is-quiet').length,
          visibleNoDecision:[...list.querySelectorAll('.pr-review-status:not(.is-quiet)')].filter(e=>/No review (decision|required)|Not reviewed/.test(e.textContent)).length,
          quietBranch:list.querySelectorAll('.stack-status-quiet').length,
          skipped:[...list.querySelectorAll('.stack-check-result')].filter(e=>e.textContent.includes('skipped')).length,
          disclosures:list.querySelectorAll('.stack-member-disclosure').length,
          adjacentParents:list.querySelectorAll('.stack-parent-link').length,
          finished:list.querySelectorAll('.stack-overview-member.is-finished').length,
          finishedCells:list.querySelectorAll('.is-finished .stack-status-cell').length,
          visibleOptional:[...list.querySelectorAll('.stack-status-cell small')].filter(e=>e.textContent.includes('Update optional')).length,
        }})()`);
        assert.deepEqual(quiet, { quietReview: 9, visibleNoDecision: 0, quietBranch: 4, skipped: 0, disclosures: 0, adjacentParents: 0, finished: 3, finishedCells: 3, visibleOptional: 0 }, JSON.stringify(quiet));
        assert.equal(await js("[...document.querySelectorAll('.pr-review-status.is-quiet')].every(e=>['No review required','Not reviewed'].includes(e.textContent))"), true, 'Quiet cells keep their accessible text');
        assert.match(await js<string>("document.querySelector('.stack-progress-summary').textContent"), /3 of 12 merged.*No open PR needs attention.*/);
      } else {
        // States that need action keep their words and color.
        const row = (n: number) => `document.querySelector('.stack-overview-member[data-pr-url$="/${n}"]')`;
        assert.ok(await js(`${row(35385)}.querySelector('.pr-review-status.is-danger').textContent.includes('Changes requested')`));
        assert.ok(await js(`${row(35386)}.querySelector('.stack-check-result.is-danger').textContent.includes('2 failed')`));
        assert.ok(await js(`${row(35387)}.querySelector('.stack-member-status.is-danger').textContent.includes('Conflicts')`));
        assert.ok(await js(`${row(35383)}.querySelector('.stack-member-status').textContent.includes('40 behind')`));
        assert.match(await js<string>("document.querySelector('.stack-progress-summary').textContent"), /PRs need attention/);
      }
      for (const [width, height] of sizes) {
        await viewport(width, height);
        for (const dark of [false, true]) {
          await theme(dark);
          await capture(`${scenario}-${width}-${dark ? 'dark' : 'light'}`);
        }
        await theme(false);
      }
      // The whole list at desktop width, to judge the page as one reading path.
      await viewport(1920, 2400);
      await capture(`${scenario}-1920-full-light`);
    }
    console.log('Stack overview captures written to', shots);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
