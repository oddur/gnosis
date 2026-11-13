import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

/** Window resize on a large, code-heavy Explanation: each step must lay out only what is on screen, while find,
 * deep links, sticky columns and the reading position keep working. */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  let lastFind: Electron.Result | undefined;
  const find = (text: string) =>
    new Promise<number>((resolve) => {
      const listener = (_event: unknown, result: Electron.Result) => {
        if (!result.finalUpdate) return;
        lastFind = result;
        win.webContents.off('found-in-page', listener);
        resolve(result.matches);
      };
      win.webContents.on('found-in-page', listener);
      win.webContents.findInPage(text);
    });
  const debug = win.webContents.debugger;
  /** Choose a topic and wait for its smooth scroll to land, then for content-visibility to update. */
  const goTo = async (section: number) => {
    await js(`window.selectOption('[aria-label="Explanation section"]','${section}')`);
    await wait(
      `(()=>{const c=document.querySelector('.explanation-document');const s=document.querySelector('[data-explanation-section="${section}"]');return Math.abs(s.getBoundingClientRect().top-c.getBoundingClientRect().top)<40})()`
    );
    await new Promise((r) => setTimeout(r, 300));
    await js(frames);
  };
  /** Grow, then shrink, a file far above the viewport in topic 9, as a skipped diff does when it renders at a
   * height other than its estimate. Topic 10 must not move: scroll anchoring keeps what the reader sees. */
  const keepsInPlace = async (label: string) => {
    const place = `Math.round(document.querySelector('[data-explanation-section="10"]').getBoundingClientRect().top)`;
    const file = `document.querySelector('[data-explanation-section="9"] .review-file-group')`;
    const before = await js<number>(place);
    assert.ok(before > 0 && before < (await js<number>('innerHeight')), `Topic 10 is in view ${label}: ${before}`);
    await js(`(()=>{const f=${file};const c=document.querySelector('.explanation-document');
      if(f.getBoundingClientRect().bottom>c.getBoundingClientRect().top)throw Error('The first file of topic 9 is not above the viewport');
      f.style.minHeight=(f.offsetHeight+40000)+'px'})()`);
    await js(frames);
    const grown = await js<number>(place);
    await js(`${file}.style.minHeight=''`);
    await js(frames);
    const shrunk = await js<number>(place);
    assert.ok(
      Math.abs(grown - before) <= 1 && Math.abs(shrunk - before) <= 1,
      `Topic 10 stays in place ${label} while content above it changes height: ${before}, then ${grown} and ${shrunk}`
    );
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    // Ten topics. Two hold 150 files each, one of them a 3,000-line added file. Stack members give every file a
    // PR badge, about 330 in all.
    await js(`(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{
      const review=await load(...args);
      const members=review.snapshot?.subject?.members??[];
      const prefix=i=>members.length>1?'PR-'+members[i%members.length].repo.replace(/\\//g,'~')+'-'+members[i%members.length].number+'/':'';
      const rows=(n,f)=>Array.from({length:n},(_,i)=>f(i)).join('\\n');
      const file=(path,i)=>({filePath:prefix(i)+path,hunkHeader:'@@ -1,40 +1,41 @@',content:rows(40,j=>j===20?'-old '+i+'\\n+new '+i+'\\n+extra '+i:' line '+j+' of file '+i),language:'typescript',renderedHtml:''});
      const huge={filePath:prefix(0)+'src/generated/huge.ts',hunkHeader:'@@ -0,0 +1,3000 @@',content:rows(3000,j=>'+export const value'+(j+1)+' = '+(j+1)+'; // marker'+(j+1)),language:'typescript',renderedHtml:''};
      const many=(slide)=>Array.from({length:150},(_,i)=>file('src/topic'+slide+'/module'+i+'.ts',slide*1000+i));
      const prose=(n,word)=>Array.from({length:n},(_,i)=>'Paragraph '+i+' explains how '+word+' moves through the layout service and why the wallet keeps its state.').join('\\n\\n');
      const topic=(n,hunks,narrative)=>({...review.slides[0],id:'resize-'+n,slideNumber:n,title:'Topic '+n,narrative,diffHunks:hunks,affectedFiles:[...new Set(hunks.map(h=>h.filePath))],mermaidDiagram:null,d2Diagram:null,mechanism:null,svgIllustration:null,explainer:undefined,explainerIdea:null,inlineExplanations:[],reviewChecks:[],fileSummaries:[],educationNotes:[]});
      const slides=Array.from({length:10},(_,i)=>{
        const n=i+1;
        if(n===8)return topic(n,many(8),prose(60,'the sticky column'));
        if(n===9)return topic(n,[...many(9).slice(0,149),huge],prose(3,'the large file'));
        if(n===10)return topic(n,[file('src/last.ts',10000)],'The last topic holds needleinlasttopic so find-in-page has to reach skipped content.');
        return topic(n,[file('src/small'+n+'a.ts',n*10),file('src/small'+n+'b.ts',n*10+1)],prose(2,'topic '+n));
      });
      const changedFiles=[...new Set(slides.flatMap(s=>s.diffHunks.map(h=>h.filePath)))].map(filename=>({filename,status:filename.endsWith('huge.ts')?'added':'modified',additions:filename.endsWith('huge.ts')?3000:2,deletions:filename.endsWith('huge.ts')?0:1}));
      return {...review,slides,changedFiles,totalFilesChanged:changedFiles.length};
    };})()`);
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("document.querySelectorAll('.explanation-section').length===10");
    await js(`window.selectOption('[aria-label="Explanation section"]','9')`);
    await wait(
      '!!document.querySelector(\'[data-explanation-section="9"] [data-file-path$="huge.ts"] diffs-container\')'
    );
    await new Promise((r) => setTimeout(r, 1500));
    const huge = 'document.querySelector(\'[data-explanation-section="9"] [data-file-path$="huge.ts"]\')';
    assert.ok(
      (await js<number>(`${huge}.querySelectorAll('diffs-container').length`)) >= 15,
      'A 3,000-line file renders as 200-line slices'
    );
    // Skipped blocks hold their place with estimates. One far too small made the document shrink by most of the
    // file for a frame when the block was skipped again, and the browser clamped scrollTop (#288).
    const estimates = await js<{ name: string; estimate: number; height: number }[]>(`(()=>{
      const estimate=e=>parseFloat(getComputedStyle(e).containIntrinsicBlockSize.replace('auto',''));
      const blocks=[['section',document.querySelector('[data-explanation-section="9"]')],['file',${huge}],['slices',${huge}.querySelector('.review-context-hunk')],['slice',${huge}.querySelector('diffs-container')]];
      return blocks.map(([name,e])=>({name,estimate:estimate(e),height:e.getBoundingClientRect().height}));
    })()`);
    console.log('Skipped-block estimates:', JSON.stringify(estimates));
    for (const { name, estimate, height } of estimates)
      assert.ok(
        Math.abs(estimate - height) <= height * 0.1,
        `The ${name} estimate is within 10% of its height: ${estimate} for ${height}`
      );
    // Read inside the large file, as on the real page.
    await js(
      `(()=>{const c=document.querySelector('.explanation-document');c.scrollTop+=${huge}.getBoundingClientRect().top-c.getBoundingClientRect().top+1500})()`
    );
    await new Promise((r) => setTimeout(r, 1000));
    await js(frames);

    const shape = await js<{ all: number; rendered: number; badges: number; svgs: number }>(`(()=>{
      const all=[...document.querySelectorAll('*')];
      return {all:all.length,rendered:all.filter(e=>e.checkVisibility({contentVisibilityAuto:true})).length,badges:document.querySelectorAll('.entity-badge').length,svgs:document.querySelectorAll('svg').length};
    })()`);
    console.log('Resize fixture:', JSON.stringify(shape));
    assert.ok(shape.all > 10_000, 'The fixture is large');
    assert.ok(shape.rendered < 4000, `Only chunks near the viewport render: ${shape.rendered} of ${shape.all}`);

    debug.attach('1.3');
    await debug.sendCommand('Performance.enable');
    const metrics = async () =>
      Object.fromEntries(
        (
          (await debug.sendCommand('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }
        ).metrics.map((m) => [m.name, m.value])
      );
    const height = await js<number>('innerHeight');
    // Emulate a wide window whatever the display allows (Xvfb caps it), and stay above the 1000px media query and
    // the reader's 850px single-column container query: crossing a breakpoint is a one-off relayout, checked below.
    const from = 1680;
    const emulate = (width: number) =>
      debug.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
    await emulate(from);
    await js(frames);
    await new Promise((r) => setTimeout(r, 500));
    const widths = [
      ...Array.from({ length: 16 }, (_, i) => from - (i + 1) * 40),
      ...Array.from({ length: 16 }, (_, i) => from - 600 + (i + 1) * 40),
    ];
    const steps: { width: number; ms: number; work: number; layouts: number; styles: number }[] = [];
    await debug.sendCommand('Profiler.enable');
    await debug.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    await debug.sendCommand('Profiler.start');
    try {
      let previous = await metrics();
      for (const width of widths) {
        const started = await js<number>('performance.now()');
        await emulate(width);
        const ended = await js<number>(`${frames}.then(()=>performance.now())`);
        const sample = await metrics();
        steps.push({
          width,
          ms: ended - started,
          work: (sample.TaskDuration - previous.TaskDuration) * 1000,
          layouts: sample.LayoutCount - previous.LayoutCount,
          styles: sample.RecalcStyleCount - previous.RecalcStyleCount,
        });
        previous = sample;
      }
    } finally {
      await debug.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
    // Where the main thread spent its time, so a failed budget names its cause.
    const { profile } = (await debug.sendCommand('Profiler.stop')) as {
      profile: {
        nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
        samples: number[];
        timeDeltas: number[];
      };
    };
    const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
    const self = new Map<string, number>();
    profile.samples.forEach((sample, i) => {
      const frame = byId.get(sample);
      if (!frame || frame.functionName === '(idle)' || frame.functionName === '(program)') return;
      const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.split('?')[0]}:${frame.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
    });
    console.log(
      'Resize sweep self time:',
      [...self]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([key, ms]) => `${ms.toFixed(1)} ms ${key}`)
        .join('; ')
    );
    console.log(
      'Resize sweep steps:',
      steps.map((s) => `${s.width}:${s.ms.toFixed(0)}ms/${s.work.toFixed(0)}w/${s.layouts}L/${s.styles}S`).join(' ')
    );
    const times = steps.map((s) => s.ms).sort((a, b) => a - b);
    const p90 = times[Math.floor(times.length * 0.9)];
    const work = steps.map((s) => s.work).sort((a, b) => a - b);
    const workP90 = work[Math.floor(work.length * 0.9)];
    const layouts = Math.max(...steps.map((s) => s.layouts));
    const styles = Math.max(...steps.map((s) => s.styles));
    console.log(
      `Resize sweep: ${steps.length} steps, p50 ${times[Math.floor(times.length / 2)].toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms; main-thread work p90 ${workP90.toFixed(1)} ms, max ${work[work.length - 1].toFixed(1)} ms; at most ${layouts} layouts and ${styles} style recalcs per step`
    );
    // Averages, not per-step maxima: one step can pick up an extra style recalc when an observer callback lands in
    // the next frame (seen as 6 on one step of an otherwise 2-4 sweep). Before the fix the sweep averaged about 5
    // layouts and 6 style recalcs per step (160 and 190 over 32 steps); after it, about 2.3 and 2.7.
    const meanLayouts = steps.reduce((sum, s) => sum + s.layouts, 0) / steps.length;
    const meanStyles = steps.reduce((sum, s) => sum + s.styles, 0) / steps.length;
    assert.ok(meanLayouts <= 3.5, `At most 3.5 layouts per step on average, saw ${meanLayouts.toFixed(2)}`);
    assert.ok(meanStyles <= 4.5, `At most 4.5 style recalcs per step on average, saw ${meanStyles.toFixed(2)}`);
    // The layout and style-recalc caps above are the regression guard: they do not depend on machine speed.
    // Wall-clock time is logged but not asserted. It depends on the rasterizer and on machine load: under Xvfb on a
    // CI runner, main-thread work reached about 80 ms at p90 with only 2-3 layouts per step, and on a busy laptop it
    // reached 182 ms (61 ms of that in GC) with the same counts. A timing cap that fails on load is noise, not a signal.

    // Crossing the 1000px media query must not re-render the Explanation's sections and their diffs.
    await js('window.__countRenders=true;window.__renderCounts={}');
    try {
      for (const width of [1040, 960, 1040]) {
        await emulate(width);
        await js(frames);
      }
    } finally {
      await debug.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
    assert.equal(
      await js('window.__renderCounts.SlideView??0'),
      0,
      'Explanation sections ignore the 1000px media query'
    );
    await js('window.__countRenders=false');

    // Mask icons keep the controls' names and focus.
    const icons = await js<{ svgs: number; masks: number; unnamed: number; badges: number; badgeSvgs: number }>(`(()=>{
      const controls=[...document.querySelectorAll('.diff-context-button,.review-file-expand')];
      return {svgs:controls.filter(c=>c.querySelector('svg')).length,masks:controls.filter(c=>c.querySelector('.icon-mask')).length,unnamed:controls.filter(c=>!c.getAttribute('aria-label')).length,badges:document.querySelectorAll('.entity-badge[aria-label]').length,badgeSvgs:document.querySelectorAll('.entity-badge:not(.entity-badge-repository) .entity-badge-icon svg').length};
    })()`);
    assert.equal(icons.svgs, 0, 'Context and expand buttons draw no SVG');
    assert.ok(icons.masks > 0, 'Context and expand buttons draw a mask icon');
    assert.equal(icons.unnamed, 0, 'Icon buttons keep their names');
    assert.equal(icons.badgeSvgs, 0, 'Entity badges draw their glyphs as masks');
    await js("document.querySelector('.review-file-expand').focus()");
    assert.equal(await js("document.activeElement?.classList.contains('review-file-expand')"), true);

    // Sticky columns: a narrative taller than the viewport, beside taller code, is pinned by its bottom once the
    // frame after the resize has run. The tallest column gets no inline offset.
    await js(`window.selectOption('[aria-label="Explanation section"]','8')`);
    await wait('!!document.querySelector(\'[data-explanation-section="8"] .review-file-group\')');
    await new Promise((r) => setTimeout(r, 800));
    await js(frames);
    const sticky = await js<{ top: string; expected: number; codeTop: string }>(`(()=>{
      const s=document.querySelector('[data-explanation-section="8"]');
      const text=s.querySelector('.explanation-section-text'),code=s.querySelector('.explanation-section-code');
      const viewport=document.querySelector('.explanation-document').clientHeight;
      return {top:text.style.top,expected:Math.min(16,Math.round(viewport-text.offsetHeight-16)),codeTop:code.style.top,text:text.offsetHeight,code:code.offsetHeight};
    })()`);
    // The controller uses the fractional border-box height; offsetHeight is rounded.
    assert.ok(
      sticky.top.endsWith('px') && Math.abs(parseFloat(sticky.top) - sticky.expected) <= 1,
      `The tall narrative is pinned by its bottom: ${sticky.top}, expected about ${sticky.expected}px`
    );
    assert.equal(sticky.codeTop, '', 'The tallest column keeps the stylesheet offset');

    // Find-in-page reaches text in skipped chunks, in the light DOM and inside a skipped diff slice.
    await goTo(1);
    assert.equal(
      await js<boolean>(
        'document.querySelector(\'[data-explanation-section="10"] .explanation-section-text\').checkVisibility({contentVisibilityAuto:true})'
      ),
      false,
      'The last topic is skipped before searching'
    );
    assert.ok((await find('needleinlasttopic')) >= 1, 'Find reaches a skipped topic');
    try {
      await wait(
        `(()=>{const r=document.querySelector('[data-explanation-section="10"]').getBoundingClientRect();return r.bottom>0&&r.top<innerHeight})()`
      );
    } catch (error) {
      // Name where find left the reader, so a failure says why.
      const state = await js<string>(
        `(()=>{const c=document.querySelector('.explanation-document');const box=n=>{const r=document.querySelector('[data-explanation-section="'+n+'"]').getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom)]};return JSON.stringify({scrollTop:c.scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,innerHeight,section9:box(9),section10:box(10),selection:String(getSelection()).slice(0,40)})})()`
      );
      throw new Error(`${(error as Error).message}\nfind: ${JSON.stringify(lastFind)}\npage: ${state}`);
    }
    // Late changes, such as a skipped block falling back to its estimate, show up within a second.
    await new Promise((r) => setTimeout(r, 1000));
    await js(frames);
    await keepsInPlace('after find');
    // The failure seen on CI: the large file's block of slices was skipped with no remembered size, so it fell back
    // to its estimate. Too small an estimate shrinks the document, the browser clamps scrollTop, and the match ends
    // up far below the viewport once the block renders again. A fresh copy of the block has no remembered size.
    {
      const place = `Math.round(document.querySelector('[data-explanation-section="10"]').getBoundingClientRect().top)`;
      const before = await js<number>(place);
      await js(`(()=>{const b=${huge}.querySelector('.review-context-hunk');const copy=b.cloneNode(false);
        copy.style.contentVisibility='hidden';window.__skippedBlock=[b,copy];b.replaceWith(copy)})()`);
      await js(frames);
      const skipped = await js<number>(place);
      await js(`(()=>{const [b,copy]=window.__skippedBlock;copy.replaceWith(b);delete window.__skippedBlock})()`);
      await js(frames);
      const after = await js<number>(place);
      // An estimate is close, not exact: a few pixels per slice. Before the fix the match moved about 60,000px.
      assert.ok(
        Math.abs(skipped - before) <= 100 && Math.abs(after - before) <= 100,
        `Topic 10 stays in place while the large file is skipped at its estimate: ${before}, then ${skipped} and ${after}`
      );
    }
    win.webContents.stopFindInPage('clearSelection');
    // The same after a jump to the topic. It is the last one, so the jump ends at the bottom of the document.
    await goTo(1);
    await js(`window.selectOption('[aria-label="Explanation section"]','10')`);
    await wait(
      `(()=>{const r=document.querySelector('[data-explanation-section="10"]').getBoundingClientRect();return r.bottom>0&&r.top<innerHeight})()`
    ).catch(async (error: unknown) => {
      throw new Error(
        `${(error as Error).message}\npage: ${await js<string>(`(()=>{const c=document.querySelector('.explanation-document');const box=n=>{const r=document.querySelector('[data-explanation-section="'+n+'"]').getBoundingClientRect();return [Math.round(r.top),Math.round(r.bottom)]};return JSON.stringify({scrollTop:c.scrollTop,scrollHeight:c.scrollHeight,clientHeight:c.clientHeight,innerHeight,section9:box(9),section10:box(10)})})()`)}`
      );
    });
    await new Promise((r) => setTimeout(r, 1000));
    await js(frames);
    await keepsInPlace('after a topic jump');
    assert.ok((await find('marker2950')) >= 1, 'Find reaches a line inside a skipped slice of the large file');
    win.webContents.stopFindInPage('clearSelection');

    // A deep link to a line in a skipped slice lands on that line.
    await goTo(1);
    await js(`(()=>{
      const host=[...${huge}.querySelectorAll('diffs-container')].find(h=>h.shadowRoot?.querySelector('[data-line-number="2600"]'));
      host.shadowRoot.querySelector('[data-line-number="2600"]').scrollIntoView({block:'center'});
    })()`);
    await wait(`(()=>{
      const host=[...${huge}.querySelectorAll('diffs-container')].find(h=>h.shadowRoot?.querySelector('[data-line-number="2600"]'));
      const r=host.shadowRoot.querySelector('[data-line-number="2600"]').getBoundingClientRect();
      const c=document.querySelector('.explanation-document').getBoundingClientRect();
      return r.height>0&&r.top>=c.top&&r.bottom<=c.bottom;
    })()`);

    // The reading position survives leaving the tab, anchored to the large file.
    await new Promise((r) => setTimeout(r, 500));
    const before = await js<{ top: number; offset: number }>(
      `(()=>{const c=document.querySelector('.explanation-document');return {top:c.scrollTop,offset:${huge}.getBoundingClientRect().top-c.getBoundingClientRect().top}})()`
    );
    const tab = (label: string) =>
      js(
        // Tabs switch on mousedown, as a pointer press does.
        `(()=>{const b=[...document.querySelectorAll('.pr-overview-tabs button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
      );
    await tab('Summary');
    await wait("document.querySelector('.explanation-document').clientHeight===0");
    await tab('Explanation');
    await wait(`Math.abs(document.querySelector('.explanation-document').scrollTop-${before.top})<2`);
    assert.ok(
      Math.abs(
        (await js<number>(
          `${huge}.getBoundingClientRect().top-document.querySelector('.explanation-document').getBoundingClientRect().top`
        )) - before.offset
      ) < 2,
      'The large file is where the reader left it'
    );
    console.log('Resize performance checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
