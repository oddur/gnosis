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
    const capture = async (name: string) => {
      await new Promise((r) => setTimeout(r, 500));
      const dir = path.resolve('.impeccable/review/workflow-graph');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    const installRoutes = async () => {
      await wait('window.checksFixture.snapshots.size > 0');
      const routes: Record<string, Awaited<ReturnType<typeof layoutWorkflow>>> = {};
      for (const mode of ['collapsed', 'expanded']) {
        const graph = await js<WorkflowGraph>(
          `(async()=>{const snapshot=[...window.checksFixture.snapshots.values()][0];return window.electronAPI.getWorkflowGraph({...snapshot,runId:9,expanded:${mode === 'expanded' ? "['test']" : '[]'}})})()`
        );
        routes[mode] = await layoutWorkflow(graph.nodes, graph.edges);
      }
      await js(
        `(()=>{const routes=${JSON.stringify(routes)},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(input,options)=>{const graph=await read(input,options),route=routes[input.expanded?.includes('test')?'expanded':'collapsed'];return {...graph,nodes:graph.nodes.map(n=>({...n,...route.nodes.find(r=>r.id===n.id)})),edges:graph.edges.map(e=>({...e,points:route.edges.find(r=>r.id===e.id)?.points}))};};})()`
      );
    };
    try {
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?pr-summary&checks');
      await wait("document.querySelectorAll('.queue-item').length===7");
      await js(
        "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
      );
      await click('Open PR overview');
      await wait("document.querySelectorAll('.pr-check-summary li').length===3");
      await js(
        `window.graphWarmCalls=[];window.electronAPI.prepareWorkflowGraph=async(target)=>{window.graphWarmCalls.push(target)};undefined`
      );
      await js("document.querySelector('.pr-check-summary li button').click()");
      await wait("document.querySelectorAll('.check-row').length===6");
      assert.equal(await js('window.graphWarmCalls.filter(Boolean).length'), 1, 'Opening Checks warms one workflow');
      await installRoutes();
      await js(`(()=>{
        window.graphColdCalls=[];
        for(const method of ['getWorkflowRuns','getWorkflowGraph']) {
          const read=window.electronAPI[method];let cold=true;
          window.electronAPI[method]=async(input,options)=>{
            window.graphColdCalls.push({method,options});
            if(options?.cachedOnly && cold){cold=false;return undefined;}
            return read(input,options);
          };
        }
      })()`);
      await click('Graph');
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
      await capture('desktop-light');
      const positions = await js("[...document.querySelectorAll('.react-flow__node')].map(n=>n.style.transform)");
      const viewport = await js("document.querySelector('.react-flow__viewport').style.transform");
      await js('document.querySelector(\'[aria-label="Refresh checks"]\').click()');
      await wait("!document.querySelector('.workflow-updating').textContent.includes('Updating')");
      assert.deepEqual(
        await js("[...document.querySelectorAll('.react-flow__node')].map(n=>n.style.transform)"),
        positions
      );
      assert.equal(await js("document.querySelector('.react-flow__viewport').style.transform"), viewport);
      await click('Needs attention');
      assert.ok(await js("document.querySelectorAll('.workflow-job[data-dim]').length>0"));
      await wait("document.querySelectorAll('.react-flow__edge').length===4");
      assert.equal(
        await js("document.querySelectorAll('.react-flow__edge').length"),
        4,
        'Filters preserve dependency context'
      );
      await click('All checks');
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
      await js(`document.querySelector('[aria-label="Close job details"]').click()`);
      win.setContentSize(620, 760);
      await js(`document.querySelector('.workflow-job-open[aria-label="TypeScript: Failed"]').click()`);
      await wait(
        '(()=>{const close=document.querySelector(\'[aria-label="Close job details"]\').getBoundingClientRect();return close.height>0&&close.top>0&&close.bottom<innerHeight-34})()'
      );
      await capture('narrow-dark');
      assert.ok(await js('document.documentElement.scrollWidth <= innerWidth+1'));
      await js('document.querySelector(\'[aria-label="Close job details"]\').click()');
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
      await click('List');
      await wait("document.querySelectorAll('.check-row').length===6");
      win.setContentSize(1280, 800);
      await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL + '?checks');
      await waitForWorkbenchQueue(win.webContents);
      await js(
        "document.querySelector('.queue-stack-icon').closest('.queue-item').querySelector('.queue-checks').click()"
      );
      await wait("document.querySelectorAll('.checks-pr-group').length===3");
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
            checkId: 100 + i,
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
      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show skipped').querySelector('input').click()"
      );
      await wait("document.querySelectorAll('.workflow-job').length===6");
      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show completed').querySelector('input').click()"
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
      await capture('visibility-collapsed-dark');
      await js('document.querySelector(\'[aria-label$="Show skipped jobs"]\').click()');
      await wait("document.querySelectorAll('.workflow-job').length===23");
      assert.ok(
        await js(
          "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show skipped').querySelector('input').checked"
        )
      );

      await js(
        "[...document.querySelectorAll('.workflow-visibility label')].find(l=>l.textContent==='Show completed').querySelector('input').click()"
      );
      await wait("document.querySelectorAll('.workflow-job[data-collapsed]').length===0");
      const installStages = async (
        baseNodes: WorkflowGraph['nodes'],
        baseEdges: WorkflowGraph['edges'],
        focusId: string
      ) => {
        const overview = stageWorkflow(baseNodes, baseEdges, []);
        const groupIds = overview.groups.map((g) => g.id);
        const projections: Record<string, unknown> = {};
        for (const expand of [false, true])
          for (const focus of [undefined, focusId]) {
            const stage = stageWorkflow(baseNodes, baseEdges, expand ? groupIds : []);
            const focused = focusWorkflow(stage.nodes, stage.edges, focus);
            const layout = await layoutWorkflow(focused.nodes, focused.edges);
            projections[`${expand}:${focus ?? ''}`] = {
              ...focused,
              groups: stage.groups,
              totalJobs: baseNodes.flatMap((n) => n.jobs).length,
              nodes: focused.nodes.map((n) => ({ ...n, ...layout.nodes.find((r) => r.id === n.id) })),
              edges: focused.edges.map((e) => ({ ...e, points: layout.edges.find((r) => r.id === e.id)?.points })),
            };
          }
        await js(
          `(()=>{const projections=${JSON.stringify(projections)},groups=${JSON.stringify(groupIds)},read=window.electronAPI.getWorkflowGraph;window.electronAPI.getWorkflowGraph=async(input,options)=>{const original=await read(input,options),projected=projections[String(groups.some(id=>input.expanded?.includes(id)))+':'+(input.focusNodeId??'')];return {...original,focus:undefined,...projected};};document.querySelector('[aria-label="Refresh checks"]').click();})()`
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
      await click('Back to workflow');
      await wait("document.querySelectorAll('.workflow-job').length===23");
      await js("document.querySelector('.workflow-expanded-groups button').click()");
      await wait("document.querySelectorAll('.workflow-job').length===6");
      assert.equal(await js('window.graphNetworkCalls'), 0, 'Stage and dependency navigation must stay local');
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
