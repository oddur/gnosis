import { stageWorkflow, focusWorkflow } from '../src/workflow-stages';
import { assembleWorkflow } from '../src/workflow-definition';
import { compactWorkflow } from '../src/workflow-visibility';
import { layoutWorkflow } from '../src/workflow-layout';
import type { WorkflowGraph } from '../lib/workflow-graph';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
app.disableHardwareAcceleration();
void app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false },
    });
    const errors: string[] = [];
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') errors.push(message);
    });
    const js = async <T = unknown>(code: string): Promise<T> => {
      try {
        return (await win.webContents.executeJavaScript(code)) as T;
      } catch (error) {
        throw Error(`${String(error)}\nScript: ${code.slice(0, 600)}\n${errors.join('\n')}`);
      }
    };
    const wait = async (code: string) => {
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        if (await js(code)) return;
        await new Promise((r) => setTimeout(r, 80));
      }
      await capture('failure').catch(() => {});
      console.log(
        await js(
          "[...document.querySelectorAll('.workflow-canvas,.react-flow,.react-flow__viewport,.react-flow__node')].map(n=>({class:n.className,bounds:n.getBoundingClientRect().toJSON(),style:n.getAttribute('style')}))"
        )
      );
      throw Error('Timed out: ' + code + '\n' + (await js('document.body.innerText')) + '\n' + errors.join('\n'));
    };
    const click = (text: string) =>
      js(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click()})()`
      );
    const openView = async () => {
      if (!(await js(`!!document.querySelector('.workflow-view-menu')`)))
        await js(`document.querySelector('[aria-label="Graph view options"]').click()`);
      await wait(`!!document.querySelector('.workflow-view-menu')`);
    };
    const closeView = async () => {
      if (await js(`!!document.querySelector('.workflow-view-menu')`)) {
        await js(`document.querySelector('[aria-label="Graph view options"]').click()`);
        await wait(`!document.querySelector('.workflow-view-menu')`);
      }
    };
    const capture = async (name: string) => {
      await new Promise((r) => setTimeout(r, 500));
      const dir = path.resolve('.impeccable/review/workflow-graph');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    const installRoutes = async () => {
      // Renderer inspection caches can restore the list without calling the new page's fixture API.
      await js(
        `(async()=>{const queue=await window.electronAPI.workbenchQueue();await Promise.all(queue.items.flatMap(item=>item.subject.members).map(member=>window.electronAPI.getPrChecks({url:member.url,headSha:member.headSha})));})()`
      );
      await wait('window.checksFixture.snapshots.size > 0');
      const routes: Record<string, Awaited<ReturnType<typeof layoutWorkflow>>> = {};
      for (const mode of ['collapsed', 'expanded', 'annotations', 'steps']) {
        const graph = await js<WorkflowGraph>(
          `(async()=>{const snapshot=[...window.checksFixture.snapshots.values()][0];return window.electronAPI.getWorkflowGraph({...snapshot,runId:9,expandedSteps:${mode === 'steps' ? "['lint']" : '[]'},expandedAnnotations:${mode === 'annotations' ? "['types']" : '[]'},expanded:${mode === 'expanded' ? "['test']" : '[]'}})})()`
        );
        routes[mode] = await layoutWorkflow(graph.nodes, graph.edges);
      }
      await js(
        `(()=>{const routes=${JSON.stringify(routes)},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(input,options)=>{const graph=await read(input,options),route=routes[input.expandedSteps?.includes('lint')?'steps':input.expandedAnnotations?.includes('types')?'annotations':input.expanded?.includes('test')?'expanded':'collapsed'];return {...graph,nodes:graph.nodes.map(n=>({...n,...route.nodes.find(r=>r.id===n.id)})),edges:graph.edges.map(e=>({...e,points:route.edges.find(r=>r.id===e.id)?.points}))};};})()`
      );
    };
    try {
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&checks');
      // CI desktops can prefer reduced motion; test each preference explicitly.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      await wait("document.querySelectorAll('.queue-item').length===7");
      await js(
        "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
      );
      await click('Open PR overview');
      await wait("document.querySelectorAll('.review-evidence-summary > button').length===3");
      await js(
        `window.graphWarmCalls=[];window.electronAPI.prepareWorkflowGraph=async(target)=>{window.graphWarmCalls.push(target)};undefined`
      );
      await js("document.querySelector('.review-evidence-summary > button').click()");
      await wait("document.querySelectorAll('.check-row').length===6");
      assert.equal(await js('window.graphWarmCalls.filter(Boolean).length'), 1, 'Opening Checks warms one workflow');
      await installRoutes();
      await js(`(async()=>{
        for(const snapshot of window.checksFixture.snapshots.values()){
          const value=await window.electronAPI.getCheckDetails({...snapshot,id:'check:2'});
          snapshot.details={'check:2':{...value,checkedAt:Date.now()}};
        }
      })()`);
      await js(`(()=>{
        window.graphColdCalls=[];
        for(const method of ['getWorkflowRuns','getWorkflowGraph']) {
          const read=window.electronAPI[method];let cold=true;
          window.electronAPI[method]=async(input,options)=>{
            window.graphColdCalls.push({method,options});
            if(options?.cachedOnly && cold){cold=false;return undefined;}
            if(method==='getWorkflowGraph' && !window.releaseGraphLoading)await new Promise(resolve=>{window.releaseGraphLoading=resolve});
            return read(input,options);
          };
        }
      })()`);
      await click('Graph');
      await wait(
        `typeof window.releaseGraphLoading==='function' && !!document.querySelector('.loading-motif')`
      );
      assert.ok(
        await js(
          `(()=>{const state=document.querySelector('.workflow-graph-state'),copy=document.querySelector('.loading-state-content'),a=state.getBoundingClientRect(),b=copy.getBoundingClientRect();return b.left-a.left>=24 && a.right-b.right>=24 && !document.querySelector('.workflow-viewport-actions')})()`
        )
      );
      assert.ok(await js(`document.querySelector('.loading-signal').getAnimations().length===1`));
      await capture('loading-light');
      await js(`document.documentElement.classList.add('dark')`);
      await capture('loading-dark');
      win.setContentSize(760, 640);
      await wait(`!!document.querySelector('.loading-elapsed')`);
      await capture('loading-compact-dark');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      assert.ok(
        await js(`getComputedStyle(document.querySelector('.loading-signal')).animationName==='none'`)
      );
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
      win.setContentSize(1280, 800);
      await js(`document.documentElement.classList.remove('dark');window.releaseGraphLoading()`);
      await wait("document.querySelectorAll('.workflow-job').length===4");
      await wait("!!document.querySelector('.react-flow__edge')");
      assert.equal(
        await js(`window.graphColdCalls.filter(c=>!c.options?.cachedOnly).every(c=>c.options?.background===false)`),
        true,
        'Cold graph requests must have interactive priority'
      );
      assert.equal(
        await js(
          'document.querySelector(\'.workflow-job-open[aria-label="TypeScript: Failed"] .workflow-job-context\') === null'
        ),
        true,
        'Do not repeat the definition ID'
      );
      assert.ok(
        await js(`document.querySelector('.workflow-canvas').getBoundingClientRect().height > 400`),
        'Checks should give the graph at least half the laptop height'
      );
      await wait(`document.querySelector('.workflow-inline-annotation p')?.textContent.includes('reconnect callback')`);
      assert.ok(await js(`!document.body.textContent.includes('View failure annotation')`));
      await js(`document.querySelector('.workflow-inline-annotation p').click()`);
      assert.ok(await js(`!!document.querySelector('.check-detail[hidden]')`), 'Annotation text does not open details');
      assert.equal(await js("document.querySelectorAll('[data-id=lint] .workflow-job-steps li').length"), 3);
      await js(
        "window.beforeStepRequests=window.graphColdCalls.filter(c=>!c.options?.cachedOnly).length;document.querySelector('[data-id=lint] .workflow-steps-toggle').click()"
      );
      await wait("document.querySelectorAll('[data-id=lint] .workflow-job-steps li').length===6");
      assert.equal(
        await js('window.graphColdCalls.filter(c=>!c.options?.cachedOnly).length'),
        await js('window.beforeStepRequests'),
        'Expanding steps only projects cached data'
      );
      assert.ok(
        await js(
          `(()=>{const card=document.querySelector('[data-id=lint] .workflow-job'), rows=[...card.querySelectorAll('.workflow-job-steps li')], last=rows.at(-1).getBoundingClientRect();return last.bottom<=card.getBoundingClientRect().bottom && rows.every(row=>row.textContent.includes('12s'))})()`
        ),
        'All rows and durations fit within the expanded node'
      );
      await capture('job-steps-expanded-light');
      await js("document.documentElement.classList.add('dark')");
      await capture('job-steps-expanded-dark');
      await js(
        "document.documentElement.classList.remove('dark');document.querySelector('[data-id=lint] .workflow-steps-toggle').click()"
      );
      await wait("document.querySelectorAll('[data-id=lint] .workflow-job-steps li').length===3");
      await capture('failure-annotation-light');
      await js(
        `(()=>{const card=document.querySelector('[data-id="types"] .workflow-job');const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:r.left+30,clientY:r.top+30}));})()`
      );
      await wait(`!!document.querySelector('[role="menu"]')`);
      assert.ok(
        await js(
          `[...document.querySelectorAll('[role="menuitem"]')].some(n=>n.textContent.includes('Re-run failed jobs in workflow') && n.getAttribute('aria-disabled')==='true')`
        )
      );
      await capture('job-context-menu-light');
      await js(
        `document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
      );
      await wait(`!document.querySelector('[role="menu"]')`);
      await capture('desktop-light');
      win.setContentSize(1920, 900);
      await wait(`document.querySelector('.checks-toolbar').getBoundingClientRect().height<=56`);
      await capture('wide-toolbar-light');
      win.setContentSize(1280, 800);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const positions = await js("[...document.querySelectorAll('.react-flow__node')].map(n=>n.style.transform)");
      const viewport = await js("document.querySelector('.react-flow__viewport').style.transform");
      await js('document.querySelector(\'[aria-label="Refresh checks"]\').click()');
      await wait("!document.querySelector('.workflow-updating').textContent.includes('Updating')");
      assert.deepEqual(
        await js("[...document.querySelectorAll('.react-flow__node')].map(n=>n.style.transform)"),
        positions
      );
      assert.equal(await js("document.querySelector('.react-flow__viewport').style.transform"), viewport);
      await click('Needs attention (2)');
      assert.ok(await js("document.querySelectorAll('.workflow-job[data-dim]').length>0"));
      await wait("document.querySelectorAll('.react-flow__edge').length===4");
      assert.equal(
        await js("document.querySelectorAll('.react-flow__edge').length"),
        4,
        'Filters preserve dependency context'
      );
      await click('All jobs');
      await js(
        `(()=>{const read=window.electronAPI.getWorkflowGraph;window.graphNetworkCalls=0;window.electronAPI.getWorkflowGraph=(input,options)=>{if(!options?.cachedOnly)window.graphNetworkCalls++;return read(input,options);};})()`
      );
      await js('document.querySelector(\'[aria-label="Expand Platform tests"]\').click()');
      await wait("document.querySelectorAll('.workflow-job').length===5");
      assert.equal(await js('window.graphNetworkCalls'), 0, 'Expanding must not revalidate GitHub data');
      await js(
        `(()=>{window.beforeRefreshRace=window.electronAPI.getWorkflowGraph;window.releaseGraphRefresh=[];window.freshGraphDelivered=false;window.electronAPI.getWorkflowGraph=async(input,options)=>{if(!options?.cachedOnly){await new Promise(resolve=>window.releaseGraphRefresh.push(resolve));window.freshGraphDelivered=true;}const graph=await window.beforeRefreshRace(input,options);return window.freshGraphDelivered?{...graph,nodes:graph.nodes.map((node,i)=>i===0?{...node,name:'Refreshed lint'}:node)}:graph;};document.querySelector('[aria-label="Refresh checks"]').click();})()`
      );
      await wait('window.releaseGraphRefresh.length > 0');
      await click('Collapse Platform tests');
      await wait("document.querySelectorAll('.workflow-job').length===4");
      await js('window.releaseGraphRefresh.splice(0).forEach(release=>release())');
      await wait("document.querySelector('.workflow-job-name')?.textContent==='Refreshed lint'");
      assert.equal(
        await js("document.querySelectorAll('.workflow-job').length"),
        4,
        'Refresh must retain the current expansion state'
      );
      await js(
        'window.electronAPI.getWorkflowGraph=window.beforeRefreshRace;document.querySelector(\'[aria-label="Refresh checks"]\').click()'
      );
      await wait(
        "document.querySelector('.workflow-job-name')?.textContent!=='Refreshed lint' && !document.querySelector('.workflow-updating').textContent.includes('Updating')"
      );
      await js('document.querySelector(\'[aria-label="Expand Platform tests"]\').click()');
      await wait("document.querySelectorAll('.workflow-job').length===5");

      await js('document.querySelector(\'.workflow-job-open[aria-label="Tests / macOS: Failed"]\').click()');
      await wait("document.querySelector('.check-detail:not([hidden]) h2')?.textContent.includes('Tests / macOS')");
      await wait("!!document.querySelector('.check-steps')");
      assert.ok(await js("document.querySelector('.check-detail:not([hidden])').textContent.includes('Load log')"));
      await capture('detail-light');
      await js('document.querySelector(\'[aria-label="Close job details"]\').click()');
      await click('Collapse Platform tests');
      await wait("document.querySelectorAll('.workflow-job').length===4");
      win.setContentSize(900, 700);
      await js("document.documentElement.classList.add('dark')");
      await capture('laptop-dark');
      // Job buttons remain usable by keyboard; no graph drag gesture is required.
      win.focus();
      win.webContents.focus();
      await js('document.querySelector(\'.workflow-job-open[aria-label="TypeScript: Failed"]\').focus()');
      await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await wait("document.querySelector('.check-detail:not([hidden]) h2')?.textContent.includes('TypeScript')");
      await wait(
        "(()=>{const canvas=document.querySelector('.workflow-canvas').getBoundingClientRect();const r=document.querySelector('.workflow-job[data-selected]').getBoundingClientRect();return r.left>=canvas.left-1 && r.right<=canvas.right+1 && r.top>=canvas.top-1 && r.bottom<=canvas.bottom+1 && document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')})()"
      );
      await capture('laptop-detail-dark');
      assert.equal(await js(`document.activeElement?.getAttribute('aria-label')`), 'Selected check details');
      assert.ok(
        await js(
          `(()=>{const next=document.querySelector('.workflow-issue-navigation [aria-label="Next issue"]');const r=next.getBoundingClientRect();return next.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        ),
        'Next issue must be reachable above the laptop detail overlay'
      );
      assert.ok(
        await js(`document.querySelector('.workflow-detail-relations').textContent.includes('Lint')`),
        'Details retain prerequisite context'
      );
      await js(`document.querySelector('.workflow-issue-navigation [aria-label="Next issue"]').click()`);
      await wait(`document.querySelector('.workflow-issue-navigation [role="status"]')?.textContent==='Issue 2 of 2'`);
      await js(`document.querySelector('.workflow-issue-navigation [aria-label="Previous issue"]').click()`);
      await wait(
        `document.querySelector('.check-detail h2')?.textContent.includes('TypeScript') && document.activeElement?.getAttribute('aria-label')==='Selected check details'`
      );
      await js(`document.querySelector('.check-detail').scrollTop=300`);
      assert.ok(
        await js(
          `(()=>{const next=document.querySelector('.workflow-issue-navigation [aria-label="Next issue"]');const r=next.getBoundingClientRect();return next.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        ),
        'Issue navigation stays visible while output scrolls'
      );
      await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await wait(`!!document.querySelector('.check-detail[hidden]')`);
      await wait(`document.activeElement?.getAttribute('aria-label')==='TypeScript: Failed'`);
      await js(`document.activeElement.click()`);
      await wait(`!!document.querySelector('.check-detail:not([hidden])')`);
      await js(`document.querySelector('[aria-label="Close job details"]').click()`);
      await js(`document.querySelector('.workflow-expanded-groups button')?.click()`);
      await wait(`document.querySelectorAll('.workflow-job').length===4`);
      win.setContentSize(620, 760);
      await capture('narrow-controls-dark');
      await js(`document.querySelector('.workflow-job-open[aria-label="TypeScript: Failed"]').click()`);
      await wait(
        '(()=>{const close=document.querySelector(\'[aria-label="Close job details"]\').getBoundingClientRect();return close.height>0&&close.top>0&&close.bottom<innerHeight-34})()'
      );
      await capture('narrow-dark');
      assert.ok(await js('document.documentElement.scrollWidth <= innerWidth+1'));
      await js(`document.querySelector('.workflow-issue-navigation [aria-label="Next issue"]').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait(
        `!!document.querySelector('.check-detail[hidden]') && document.activeElement?.getAttribute('aria-label')==='TypeScript: Failed'`
      );
      // Saved graph stays visible during API failure; Retry restores fresh data.
      await js(
        "window.graphRead=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(i,o)=>{if(o?.cachedOnly)return window.graphRead(i,o);throw Error('GitHub API limit reached. Retry after 12:30.');};document.querySelector('[aria-label=\"Refresh checks\"]').click()"
      );
      await wait("document.querySelector('.workflow-notice')?.textContent.includes('Showing saved workflow')");
      assert.equal(await js("document.querySelectorAll('.workflow-job').length"), 4);
      await capture('cached-error-dark');
      await js('void (window.electronAPI.getWorkflowGraph=window.graphRead)');
      await click('Retry workflow');
      await wait("!document.querySelector('.workflow-notice')");
      await js(`document.querySelector('.workflow-triage button:nth-child(1)')?.focus()`);
      await click('Next issue');
      await wait(`!!document.querySelector('.check-detail:not([hidden]) .check-attention')`);
      await js(`document.querySelector('[aria-label="Close job details"]').click()`);
      await js(`document.querySelector('[aria-label="Expand Platform tests"]')?.click()`);
      await wait(`document.querySelectorAll('.workflow-job').length===5`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rememberedViewport = await js(`document.querySelector('.react-flow__viewport').style.transform`);
      await click('List');
      await click('Graph');
      await wait(`document.querySelectorAll('.workflow-job').length===5`);
      assert.equal(
        await js(`document.querySelector('.react-flow__viewport').style.transform`),
        rememberedViewport,
        'List detour must retain the graph viewport'
      );
      await click('List');
      await wait("document.querySelectorAll('.check-row').length===6");
      win.setContentSize(1280, 800);
      await js(`sessionStorage.removeItem('fixture-checks-view')`);
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?checks');
      await waitForWorkbenchQueue(win.webContents);
      await js(
        "document.querySelector('.queue-stack-icon').closest('.queue-item').querySelector('.queue-checks').click()"
      );
      await wait(
        "document.querySelectorAll('.checks-pr-group').length===3 && document.querySelectorAll('.check-row').length===18"
      );
      await installRoutes();
      await click('Graph');
      await wait("document.querySelectorAll('.workflow-job').length===4");
      await js('document.querySelector(\'.workflow-job-open[aria-label="TypeScript: Failed"]\').click()');
      await wait("!!document.querySelector('.check-detail:not([hidden])')");
      await js('document.querySelector(\'[aria-label="PR for workflow graph"]\').click()');
      await wait("document.querySelectorAll('[role=option]').length===3");
      await js("document.querySelectorAll('[role=option]')[1].click()");
      await wait(
        "!!document.querySelector('.check-detail[hidden]') && document.querySelectorAll('.workflow-job').length===4"
      );
      await capture('stack-light');
      const exampleNodes = [
        'semantic-version',
        'define-release-channel',
        'build-macos',
        'build-windows',
        'publish',
      ].map((id, i) => ({
        id,
        name: id,
        definition: id,
        x: 0,
        y: 0,
        jobs: [
          {
            id: 100 + i,
            checkId: `check:${100 + i}`,
            name: id,
            status: 'completed',
            conclusion: i === 4 ? 'skipped' : 'success',
            startedAt: '2026-11-04T08:00:00Z',
            completedAt: '2026-11-04T08:00:29Z',
            url: '',
            steps: [],
          },
        ],
      }));
      const exampleEdges = [
        ['semantic-version', 'build-macos'],
        ['semantic-version', 'build-windows'],
        ['define-release-channel', 'build-macos'],
        ['define-release-channel', 'build-windows'],
        ['build-macos', 'publish'],
        ['build-windows', 'publish'],
      ].map(([source, target]) => ({ id: source + '->' + target, source, target }));
      const exampleLayout = await layoutWorkflow(exampleNodes, exampleEdges);
      await js(
        `(()=>{const nodes=${JSON.stringify(exampleNodes.map((n) => ({ ...n, ...exampleLayout.nodes.find((p) => p.id === n.id) })))},edges=${JSON.stringify(exampleEdges.map((e) => ({ ...e, points: exampleLayout.edges.find((r) => r.id === e.id)?.points })))},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(...args)=>({...await read(...args),nodes,edges,groups:[]});document.documentElement.classList.add('dark');document.querySelector('[aria-label="Refresh checks"]').click();})()`
      );
      await wait(
        "document.querySelectorAll('.workflow-job').length===5 && document.querySelectorAll('.react-flow__edge').length===6"
      );
      await capture('routing-fanin-dark');
      await js(`document.querySelector('.workflow-job-open[aria-label="build-macos: Passed"]').focus()`);
      await wait("[...document.querySelectorAll('.react-flow__edge-path')].some(e=>e.style.opacity==='0.18')");
      await js(
        `(()=>{const card=document.querySelector('.workflow-job-open[aria-label="build-macos: Passed"]').closest('.workflow-job');card.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}));card.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));})()`
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        await js("[...document.querySelectorAll('.react-flow__edge-path')].some(e=>e.style.opacity==='0.18')"),
        'Keyboard focus preserves tracing after the pointer leaves'
      );
      await capture('routing-focus-dark');
      // A wide fan-out with many skipped jobs must compact, while failed/running jobs remain full size.
      const busyNodes: WorkflowGraph['nodes'] = exampleNodes.map((n) => ({
        ...n,
        jobs: n.jobs.map((j) => ({
          ...j,
          checkId: `check:${j.id}`,
          status: n.id === 'build-macos' ? 'in_progress' : j.status,
          conclusion: n.id === 'build-macos' ? null : n.id === 'build-windows' ? 'failure' : j.conclusion,
        })),
      }));
      const busyEdges = [...exampleEdges];
      for (let i = 0; i < 18; i++) {
        const id = `skipped-${i}`;
        busyNodes.push({
          id,
          name: `Optional build ${i}`,
          x: 0,
          y: 0,
          jobs: [
            {
              ...busyNodes[0].jobs[0],
              id: 200 + i,
              checkId: `check:${200 + i}`,
              name: `Optional build ${i}`,
              conclusion: 'skipped',
            },
          ],
        });
        busyEdges.push(
          { id: `semantic-version->${id}`, source: 'semantic-version', target: id },
          { id: `${id}->publish`, source: id, target: 'publish' }
        );
      }
      const variants: Record<string, Pick<WorkflowGraph, 'nodes' | 'edges'>> = {};
      for (const showSkipped of [true, false])
        for (const showCompleted of [true, false]) {
          const compact = compactWorkflow(busyNodes, busyEdges, { showSkipped, showCompleted });
          const layout = await layoutWorkflow(compact.nodes, compact.edges);
          variants[`${showSkipped}:${showCompleted}`] = {
            nodes: compact.nodes.map((n) => ({ ...n, ...layout.nodes.find((r) => r.id === n.id) })),
            edges: compact.edges.map((e) => ({ ...e, points: layout.edges.find((r) => r.id === e.id)?.points })),
          };
        }
      await js(
        `(()=>{const variants=${JSON.stringify(variants)},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(input,options)=>({...await read(input,options),...variants[\`\${input.showSkipped!==false}:\${input.showCompleted!==false}\`]});document.querySelector('[aria-label="Refresh checks"]').click();})()`
      );
      await wait("document.querySelectorAll('.workflow-job').length===23");
      // A running job's elapsed time ticks every second; only its duration label re-renders, not the graph or cards.
      const runningDuration = `document.querySelector('[data-id="build-macos"] .workflow-job-duration')?.textContent ?? ''`;
      await wait(`!document.querySelector('.workflow-updating .animate-spin') && /\\d+s$/.test(${runningDuration})`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const durationBefore = await js<string>(runningDuration);
      await js('window.__renderCounts={};window.__countRenders=true');
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const tickRenders = await js<Partial<Record<string, number>>>(
        'window.__countRenders=false;window.__renderCounts'
      );
      console.log('Workflow graph renders over 3 s of a running job:', JSON.stringify(tickRenders));
      assert.notEqual(await js<string>(runningDuration), durationBefore, 'The running job duration keeps ticking');
      assert.ok((tickRenders.WorkflowDuration ?? 0) >= 2, 'The duration label re-renders each second');
      assert.equal(tickRenders.WorkflowGraphView ?? 0, 0, 'Clock ticks do not re-render the graph');
      assert.equal(tickRenders.WorkflowJobCard ?? 0, 0, 'Clock ticks do not re-render job cards');
      await openView();
      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show skipped').querySelector('input').click()"
      );
      await wait("document.querySelectorAll('.workflow-job').length===6");
      await openView();
      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show passed and neutral').querySelector('input').click()"
      );
      await wait("document.querySelectorAll('.workflow-job[data-collapsed]').length===4");
      assert.equal(
        await js("document.querySelectorAll('.workflow-job[data-outcome=attention]:not([data-collapsed])').length"),
        1
      );
      assert.equal(
        await js("document.querySelectorAll('.workflow-job[data-outcome=running]:not([data-collapsed])').length"),
        1
      );
      await wait("document.querySelectorAll('.react-flow__edge').length===8");
      await closeView();
      await capture('visibility-collapsed-dark');
      await js('document.querySelector(\'[aria-label$="Show skipped jobs"]\').click()');
      await wait("document.querySelectorAll('.workflow-job').length===23");
      await openView();
      assert.ok(
        await js(
          "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show skipped').querySelector('input').checked"
        )
      );

      await openView();
      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show passed and neutral').querySelector('input').click()"
      );
      await wait("document.querySelectorAll('.workflow-job[data-collapsed]').length===0");
      await closeView();
      const installStages = async (
        baseNodes: WorkflowGraph['nodes'],
        baseEdges: WorkflowGraph['edges'],
        focusId: string
      ) => {
        const overview = stageWorkflow(baseNodes, baseEdges, []);
        const groupIds = overview.groups.map((g) => g.id);
        const projections: Record<string, unknown> = {};
        for (const grouping of ['adaptive', 'compact', 'off'] as const)
          for (const expand of [false, true])
            for (const focus of [undefined, focusId]) {
              const stage = stageWorkflow(baseNodes, baseEdges, expand ? groupIds : [], grouping);
              const focused = focusWorkflow(stage.nodes, stage.edges, focus);
              const layout = await layoutWorkflow(focused.nodes, focused.edges);
              projections[`${grouping}:${expand}:${focus ?? ''}`] = {
                ...focused,
                groups: stage.groups,
                totalJobs: baseNodes.flatMap((n) => n.jobs).length,
                nodes: focused.nodes.map((n) => ({ ...n, ...layout.nodes.find((r) => r.id === n.id) })),
                edges: focused.edges.map((e) => ({ ...e, points: layout.edges.find((r) => r.id === e.id)?.points })),
              };
            }
        await js(
          `(()=>{const projections=${JSON.stringify(projections)},groups=${JSON.stringify(groupIds)},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(input,options)=>{const original=await read(input,options),projected=projections[(input.grouping??'adaptive')+':'+String(groups.some(id=>input.expanded?.includes(id)))+':'+(input.focusNodeId??'')];return {...original,focus:undefined,...projected};};document.querySelector('[aria-label="Refresh checks"]').click();})()`
        );
        return overview;
      };
      await installStages(busyNodes, busyEdges, 'build-macos');
      await wait(
        "document.querySelectorAll('.workflow-job').length===6 && !!document.querySelector('.workflow-job[data-stage]')"
      );
      await wait("document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')");
      assert.equal(
        await js("document.querySelector('.workflow-job-name').getBoundingClientRect().height > 15"),
        true,
        'Job text stays at readable size'
      );
      await capture('stages-dark');
      await js('window.graphNetworkCalls=0');
      const chooseGrouping = async (value: string) => {
        await openView();
        await js(`document.querySelector('.workflow-grouping input[value="${value}"]').click()`);
        await wait(`window.electronAPI.loadPreferences().then(p=>p.workflowGrouping==='${value}')`);
        await closeView();
      };
      await openView();
      await capture('grouping-menu-dark');
      await chooseGrouping('off');
      await wait("document.querySelectorAll('.workflow-job').length===23");
      await chooseGrouping('compact');
      await wait("document.querySelectorAll('.workflow-job').length===6");
      await chooseGrouping('adaptive');
      await wait("document.querySelectorAll('.workflow-job').length===6");
      assert.equal(await js('window.graphNetworkCalls'), 0, 'Grouping choices must use cached data');
      await js("document.querySelector('.workflow-job[data-stage] .workflow-job-open').click()");
      await wait("document.querySelectorAll('.workflow-job').length===23");
      await wait("document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')");
      await capture('stages-expanded-dark');
      await click('Fit entire workflow');
      await wait("!document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')");
      await click('Readable size');
      await wait("document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')");
      await js('document.querySelector(\'[aria-label="Show dependencies for build-macos"]\').click()');
      await wait("document.querySelectorAll('.workflow-job').length===4");
      assert.equal(
        await js('!!document.querySelector(\'[aria-label="build-windows: Failed"]\')'),
        false,
        'Focus excludes sibling branches'
      );
      await capture('dependencies-focus-dark');
      assert.ok(
        await js(
          `document.querySelector('.workflow-scope-status').textContent.includes('Failed prerequisites outside this view')`
        )
      );
      assert.ok(
        await js(
          `!!document.querySelector('[aria-label="Reveal failed prerequisite outside this view: build-windows"]')`
        )
      );
      assert.ok(
        await js(`[...document.querySelectorAll('.workflow-job')].every(n=>getComputedStyle(n).opacity==='1')`),
        'All job text remains readable during focus/highlight'
      );
      await js(
        `document.querySelector('[aria-label="Reveal failed prerequisite outside this view: build-windows"]').click()`
      );
      await wait("document.querySelectorAll('.workflow-job').length===23");
      await js("document.querySelector('.workflow-expanded-groups button').click()");
      await wait("document.querySelectorAll('.workflow-job').length===6");
      assert.equal(await js('window.graphNetworkCalls'), 0, 'Stage and dependency navigation must stay local');
      // Many workflows: readable full names, status/count evidence, and local search.
      await js(`sessionStorage.removeItem('fixture-checks-view')`);
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&checks');
      await waitForWorkbenchQueue(win.webContents);
      await js(
        `[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()`
      );
      await click('Open PR overview');
      await wait(`document.querySelectorAll('.review-evidence-summary > button').length===3`);
      await js(`document.querySelector('.review-evidence-summary > button').click()`);
      await wait(`document.querySelectorAll('.check-row').length===6`);
      await installRoutes();
      await js(`(()=>{
        const readRuns=window.electronAPI.getWorkflowRuns, readGraph=window.electronAPI.getWorkflowGraph;
        window.workflowSidebarRequests=0;
        window.electronAPI.getWorkflowRuns=async(input,options)=>{
          const value=await readRuns(input,options), base=value.runs[0];
          const names=['Build and test','Buf Checks (Gameplay)','Check LFS Issues','Publish Gameplay gRPC Client Packages','Seed Test Pipeline','One-Time Develop Merge'];
          return {...value,runs:names.map((name,i)=>({...base,id:9+i,url:'https://github.com/klang/engine/actions/runs/'+(9+i),name,path:'.github/workflows/ci-'+i+'.yml',jobCount:i===3?undefined:5+i,status:i===3?'queued':i===2?'completed':'in_progress',conclusion:i===2?'success':null}))};
        };
        window.electronAPI.getWorkflowGraph=async(input,options)=>{
          if(!options?.cachedOnly)window.workflowSidebarRequests++;
          const graph=await readGraph(input,options),runs=await window.electronAPI.getWorkflowRuns(input);
          return {...graph,run:runs.runs.find(r=>r.id===input.runId)};
        };
      })()`);
      await click('Graph');
      await wait(
        `document.querySelectorAll('.workflow-run-option').length===6 && document.querySelector('.workflow-sidebar').getBoundingClientRect().width>0 && !!document.querySelector('.workflow-job')`
      );
      assert.ok(
        await js(
          `document.querySelector('.workflow-sidebar').textContent.includes('5 jobs') && document.querySelector('.workflow-sidebar').textContent.includes('Jobs: —')`
        )
      );
      await capture('workflow-sidebar-light');
      const sidebarRequests = await js(`window.workflowSidebarRequests`);
      win.focus();
      win.webContents.focus();
      await js(`document.querySelector('.workflow-run-option').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
      await wait(`document.activeElement===document.querySelectorAll('.workflow-run-option')[1]`);
      assert.equal(
        await js(`window.workflowSidebarRequests`),
        sidebarRequests,
        'Arrow navigation must not load workflows'
      );
      await js(
        `(()=>{const input=document.querySelector('[aria-label="Find workflow"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Publish Gameplay');input.dispatchEvent(new Event('input',{bubbles:true}));})()`
      );
      await wait(`document.querySelectorAll('.workflow-run-option').length===1`);
      assert.equal(await js(`window.workflowSidebarRequests`), sidebarRequests, 'Workflow search stays local');
      await js(`(()=>{
        window.workflowSwitchFrames=[];window.workflowSwitchFlashes=0;window.samplingWorkflowSwitch=true;
        window.workflowSwitchObserver=new MutationObserver(()=>{if(document.querySelector('.workflow-canvas .checks-empty'))window.workflowSwitchFlashes++});
        window.workflowSwitchObserver.observe(document.querySelector('.workflow-canvas'),{childList:true,subtree:true});
        const sample=()=>{if(!window.samplingWorkflowSwitch)return; if(document.querySelector('.workflow-active-run')?.textContent==='Publish Gameplay gRPC Client Packages')window.workflowSwitchFrames.push(document.querySelector('.react-flow__viewport')?.style.transform??'missing');requestAnimationFrame(sample)};requestAnimationFrame(sample);
        document.querySelector('.workflow-run-option').click();
      })()`);
      await wait(
        `document.querySelector('.workflow-active-run').textContent==='Publish Gameplay gRPC Client Packages'`
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await js(`window.samplingWorkflowSwitch=false;window.workflowSwitchObserver.disconnect()`);
      assert.equal(
        await js(`window.workflowSwitchFlashes`),
        0,
        'Cached workflow switching must not replace the graph with a loading screen'
      );
      assert.equal(
        await js(`new Set(window.workflowSwitchFrames).size`),
        1,
        'The new graph must appear at its final viewport, without a later recenter'
      );
      assert.ok(await js(`window.workflowSwitchFrames.length>0 && !window.workflowSwitchFrames.includes('missing')`));
      await js(
        `document.querySelector('[aria-label="Clear workflow search"]').click();document.documentElement.classList.add('dark')`
      );
      // A visited workflow restores the user's framing instead of fitting again.
      await click('Fit entire workflow');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const savedWorkflowViewport = await js(`document.querySelector('.react-flow__viewport').style.transform`);
      await js(
        `[...document.querySelectorAll('.workflow-run-option')].find(n=>n.querySelector('strong').textContent==='Build and test').click()`
      );
      await wait(`document.querySelector('.workflow-active-run').textContent==='Build and test'`);
      await js(
        `[...document.querySelectorAll('.workflow-run-option')].find(n=>n.querySelector('strong').textContent==='Publish Gameplay gRPC Client Packages').click()`
      );
      await wait(
        `document.querySelector('.workflow-active-run').textContent==='Publish Gameplay gRPC Client Packages'`
      );
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await js(`document.querySelector('.react-flow__viewport').style.transform`), savedWorkflowViewport);
      // A slow selection keeps the current graph visible; a later selection wins.
      await js(`(()=>{
        const read=window.electronAPI.getWorkflowGraph;
        window.electronAPI.getWorkflowGraph=async(...args)=>{
          if(args[0].runId===11)await new Promise(resolve=>{window.releaseWorkflowSwitch=resolve});
          return read(...args);
        };
        [...document.querySelectorAll('.workflow-run-option')].find(n=>n.querySelector('strong').textContent==='Check LFS Issues').click();
      })()`);
      await wait(`typeof window.releaseWorkflowSwitch==='function'`);
      assert.equal(
        await js(`document.querySelector('.workflow-active-run').textContent`),
        'Publish Gameplay gRPC Client Packages'
      );
      assert.ok(
        await js(
          `!!document.querySelector('.workflow-job') && !document.querySelector('.workflow-canvas .checks-empty')`
        )
      );
      await js(
        `[...document.querySelectorAll('.workflow-run-option')].find(n=>n.querySelector('strong').textContent==='Seed Test Pipeline').click()`
      );
      await wait(`document.querySelector('.workflow-active-run').textContent==='Seed Test Pipeline'`);
      await js(`window.releaseWorkflowSwitch()`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await js(`document.querySelector('.workflow-active-run').textContent`), 'Seed Test Pipeline');
      await js(
        `[...document.querySelectorAll('.workflow-run-option')].find(n=>n.querySelector('strong').textContent==='Publish Gameplay gRPC Client Packages').click()`
      );
      await wait(
        `document.querySelector('.workflow-active-run').textContent==='Publish Gameplay gRPC Client Packages'`
      );
      await capture('workflow-sidebar-dark');
      win.setContentSize(900, 700);
      await wait(`document.querySelector('.workflow-sidebar').hidden`);
      await js(`document.querySelector('[aria-label="Show workflows"]').click()`);
      await wait(
        `document.activeElement?.getAttribute('aria-label')==='Find workflow' && document.querySelector('.workflow-content').inert`
      );
      await capture('workflow-sidebar-compact-dark');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait(
        `document.querySelector('.workflow-sidebar').hidden && document.activeElement?.getAttribute('aria-label')==='Show workflows'`
      );
      win.setContentSize(1280, 800);
      await js(`sessionStorage.removeItem('fixture-checks-view')`);
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&checks');
      await waitForWorkbenchQueue(win.webContents);
      await js(
        "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
      );
      await click('Open PR overview');
      await wait(`document.querySelectorAll('.review-evidence-summary > button').length===3`);
      await js(`document.querySelector('.review-evidence-summary > button').click()`);
      await wait(`document.querySelectorAll('.check-row').length===6`);
      await installRoutes();
      await js(`(async()=>{
        const readRuns=window.electronAPI.getWorkflowRuns,readGraph=window.electronAPI.getWorkflowGraph;
        window.electronAPI.getWorkflowRuns=async(...args)=>{const value=await readRuns(...args);return {...value,runs:value.runs.map(r=>({...r,status:'completed',conclusion:'failure'}))}};
        window.electronAPI.getWorkflowGraph=async(...args)=>{const value=await readGraph(...args);return {...value,run:{...value.run,status:'completed',conclusion:'failure'}}};
        for(const snapshot of window.checksFixture.snapshots.values()){
          const detail=await window.electronAPI.getCheckDetails({...snapshot,id:'check:2'});
          snapshot.details={'check:2':{...detail,annotations:[...detail.annotations,{...detail.annotations[0],title:'Runner unavailable',message:'The job was not acquired by a hosted runner after multiple attempts. '+ 'No runner was available for this platform. '.repeat(12)}],checkedAt:Date.now(),job:{...detail.job,canRerun:true}}};
        }
        document.documentElement.classList.add('dark');
      })()`);
      await click('Graph');
      await wait(`document.querySelector('.workflow-inline-annotation p')?.textContent.includes('reconnect callback')`);
      await click('Show all 2 annotations');
      await wait(`document.querySelector('[data-id="types"] .workflow-job').getBoundingClientRect().height>400`);
      assert.ok(await js(`document.querySelectorAll('[data-id="types"] .workflow-inline-annotation').length===2`));
      await capture('failure-annotation-dark');
      await click('Show less');
      await wait(`document.querySelector('[data-id="types"] .workflow-job').getBoundingClientRect().height<300`);
      await js(
        `(()=>{const card=document.querySelector('[data-id="types"] .workflow-job');const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:r.left+30,clientY:r.top+30}));})()`
      );
      await wait(`!!document.querySelector('[role="menu"]')`);
      await js(
        `[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.includes('Re-run failed jobs in workflow')).click()`
      );
      await wait(
        `document.body.dataset.rerunCalls==='1' && document.body.textContent.includes('Workflow rerun requested')`
      );
      win.setContentSize(900, 700);
      await capture('failure-annotation-compact-dark');
      await wait(`sessionStorage.getItem('fixture-checks-view')==='graph'`);
      for (const expected of ['graph', 'list']) {
        await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&checks');
        await waitForWorkbenchQueue(win.webContents);
        await js(
          "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
        );
        await click('Open PR overview');
        await wait(`document.querySelectorAll('.review-evidence-summary > button').length===3`);
        await js(
          `(()=>{const tab=[...document.querySelectorAll('[role="tab"]:not(.workspace-tab-select)')].find(b=>b.textContent.startsWith('Checks'));tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));tab.click()})()`
        );
        await wait(
          `document.querySelector('.checks-view-switch [aria-pressed="true"]')?.textContent.trim()===${JSON.stringify(expected === 'graph' ? 'Graph' : 'List')}`
        );
        if (expected === 'graph') {
          await wait(`!!document.querySelector('.workflow-job')`);
          await click('List');
          await wait(`sessionStorage.getItem('fixture-checks-view')==='list'`);
        }
      }
      if (process.env.GNOSIS_WORKFLOW_REPLAY) {
        const saved = JSON.parse(fs.readFileSync(process.env.GNOSIS_WORKFLOW_REPLAY, 'utf8'));
        const actual = assembleWorkflow(saved.definitions, saved.jobs, []);
        assert.equal(actual.unmatched, 0);
        const focus = actual.nodes.find((n) => !n.expandable && n.jobs.length)?.id ?? actual.nodes[0].id;
        const overview = await installStages(actual.nodes, actual.edges, focus);
        await wait(`document.querySelectorAll('.workflow-job').length===${overview.nodes.length}`);
        await wait("document.querySelector('.react-flow__viewport').style.transform.includes('scale(1)')");
        await capture('replayed-workflow-dark');
        win.setContentSize(1920, 1080);
        await capture('replayed-workflow-wide-dark');
      }
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log(
        'Workflow graph browser checks passed: graph/list, matrix expansion, details, keyboard, stable updates, filters, cached errors, laptop and narrow themes.'
      );
    } finally {
      win.destroy();
    }
  })
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
