import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { D2_EXAMPLES } from './fixtures/d2-examples';
import { STABLE_D2_SOURCE } from './fixtures/d2-stable';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = async <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (condition: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error(`Timed out: ${condition}`);
  };
  const click = async (label: string, scope = 'document') =>
    js(
      `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.click()})()`
    );
  const directory = path.resolve('.impeccable/review/d2-integration');
  fs.mkdirSync(directory, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await js(
      'Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))'
    );
    fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const dialog = 'document.querySelector(".d2-dialog")';
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);const diagram=${JSON.stringify(D2_EXAMPLES[0].diagram)};const h=review.slides[0].diffHunks[0];diagram.steps[0].evidence={filePath:h.filePath,startLine:parseInt(h.hunkHeader.split('+')[1])};return {...review,slides:[{...review.slides[0],title:'Architecture with annotations',d2Diagram:diagram,mermaidDiagram:null}]};};})()`
    );
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative .d2-preview svg')");
    assert.equal(await js("!!document.querySelector('.review-code .review-file-group')"), true);
    await capture('explanation-light');
    await js("document.querySelector('.review-narrative .d2-diagram').scrollIntoView({block:'center'})");
    await capture('explanation-light-scrolled');
    await click('Expand diagram');
    await wait("!!document.querySelector('.d2-dialog svg')");
    await capture('expanded-light');
    assert.equal(await js("document.querySelectorAll('.d2-additional-notes > div').length"), 3);
    const duplicateIDs = await js<string[]>(
      `(()=>{const ids=[...document.querySelectorAll('.d2-diagram [id],.d2-dialog [id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)})()`
    );
    assert.deepEqual(duplicateIDs, []);
    await click('Show supporting code', dialog);
    await wait("!document.querySelector('.d2-dialog')");
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      `(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);return {...review,slides:[{...review.slides[0],d2Diagram:undefined,mermaidDiagram:'flowchart LR\\n A[Saved Mermaid] --> B[Still readable]'}]};};})()`
    );
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.mermaid-preview svg')");
    assert.match(await js<string>("document.querySelector('.mermaid-preview').textContent"), /Saved Mermaid/);
    await click('Expand diagram');
    await wait("!!document.querySelector('.mermaid-fullscreen svg')");
    await capture('legacy-mermaid');
    await click('Close');
    const galleryURL = (process.env.GNOSIS_WORKBENCH_URL ?? '').replace('workbench.html', 'd2.html');
    await loadWorkbenchPage(win, galleryURL);
    await wait("!!document.querySelector('.d2-preview svg')");
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark',${dark})`);
      for (const name of ['Architecture', 'Sequence', 'Before & after']) {
        await click(name);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await wait("!!document.querySelector('.d2-preview svg')");
        assert.equal(
          await js(
            "(()=>{const p=document.querySelector('.d2-preview');return p.scrollHeight<=p.clientHeight+1&&p.scrollWidth<=p.clientWidth+1})()"
          ),
          true
        );
        assert.equal(
          await js(
            "[...document.querySelectorAll('.d2-preview image')].every(e=>e.getAttribute('href')?.startsWith('data:'))"
          ),
          true
        );
        await capture(`${dark ? 'dark' : 'light'}-${name.replace(/\s/g, '-')}`);
      }
    }
    await click('Sequence');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('Step 1 of 4')");
    await click('Auto-play steps');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('Step 2 of 4')");
    const geometry = await js(
      "[...document.querySelectorAll('.d2-preview [data-d2-entity] .shape rect')].map(e=>[e.getAttribute('x'),e.getAttribute('y'),e.getAttribute('width'),e.getAttribute('height')])"
    );
    await click('Next diagram step');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('Step 3 of 4')");
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.d2-preview [data-d2-entity] .shape rect')].map(e=>[e.getAttribute('x'),e.getAttribute('y'),e.getAttribute('width'),e.getAttribute('height')])"
      ),
      geometry
    );
    assert.equal(
      await js(
        "document.querySelector('.d2-preview [data-d2-entity=\"(app -> api)[0]\"]').getAttribute('data-d2-focus')"
      ),
      'active'
    );
    assert.equal(
      await js(
        "document.querySelector('.d2-preview [data-d2-entity=\"(reviewer -> app)[0]\"]').getAttribute('data-d2-focus')"
      ),
      'context'
    );
    assert.equal(await js("document.querySelector('.d2-diagram').dataset.motion"), 'false');
    await click('Expand diagram');
    await wait("!!document.querySelector('.d2-dialog svg')");
    await capture('sequence-expanded-dark');
    const point = await js<{ x: number; y: number }>(
      `(()=>{const r=${dialog}.querySelector('[data-d2-entity="app.pin"] .shape').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(`${dialog}.querySelector('.d2-step-count').textContent.includes('Step 2 of 4')`);
    const actorPoint = await js<{ x: number; y: number }>(
      `(()=>{const r=${dialog}.querySelector('[data-d2-entity="api"] .shape').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...actorPoint });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...actorPoint });
    await wait(`${dialog}.querySelector('.d2-step-count').textContent.includes('Step 3 of 4')`);
    await js(`${dialog}.querySelector('.d2-view-nav button').click()`);
    await click('Next diagram step', dialog);
    assert.match(await js<string>(`${dialog}.querySelector('.d2-caption').textContent`), /Pin the displayed revision/);
    await click('Auto-play steps', dialog);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(
      await js(
        "[...document.querySelectorAll('.d2-dialog svg *')].every(e=>getComputedStyle(e).animationName==='none')"
      ),
      true
    );
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    win.webContents.debugger.detach();
    await click('Close');
    for (const [width, height] of [
      [1024, 768],
      [640, 740],
    ]) {
      win.setSize(width, height);
      await capture(`sequence-${width}`);
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    }
    await click('Expand diagram');
    await capture('expanded-narrow');
    await click('Close');
    win.setSize(1280, 800);
    await click('Try your own D2');
    await js(
      `(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(STABLE_D2_SOURCE)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await click('Render with TALA');
    await wait("document.querySelector('.d2-preview svg')?.textContent.includes('Pending: A')");
    const frameGeometry = (scope: string) => `(()=>{
      const root=${scope};const svg=root.querySelector('svg[data-d2-version]');const origin=svg.getBoundingClientRect();
      return {bounds:[svg,...svg.querySelectorAll('svg')].map(s=>s.getAttribute('viewBox')),
        shapes:[...root.querySelectorAll('[data-d2-entity] .shape rect')].map(e=>{const r=e.getBoundingClientRect();return [r.x-origin.x,r.y-origin.y,r.width,r.height].map(v=>Math.round(v*100)/100)})};
    })()`;
    const previewGeometry = await js(frameGeometry("document.querySelector('.d2-preview')"));
    assert.equal(await js("document.querySelectorAll('.d2-preview [data-d2-entity] .shape rect').length"), 2);
    await click('Next diagram step');
    await wait("document.querySelector('.d2-preview svg')?.textContent.includes('Waiting for capacity')");
    assert.deepEqual(
      await js(frameGeometry("document.querySelector('.d2-preview')")),
      previewGeometry,
      'native label changes must not move or rescale the preview'
    );
    await click('Expand diagram');
    await wait("!!document.querySelector('.d2-dialog svg')");
    await click('Zoom in', dialog);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await js(
      `${dialog}.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})).reduce((p,a)=>p.then(()=>a),Promise.resolve())`
    );
    const expandedGeometry = await js(frameGeometry(dialog));
    const zoom = await js(`${dialog}.querySelector('[aria-label="Zoom level"]').textContent`);
    await click('Next diagram step', dialog);
    await wait(`${dialog}.querySelector('.mermaid-zoom-art svg')?.textContent.includes('Wake the next caller')`);
    assert.equal(await js(`${dialog}.querySelector('[aria-label="Zoom level"]').textContent`), zoom);
    assert.deepEqual(
      await js(frameGeometry(dialog)),
      expandedGeometry,
      'native state changes preserve expanded geometry and zoom'
    );
    await capture('stable-native-steps');
    await click('Close');
    const sqlSource = 'query: "WHERE id = $1"';
    await js(
      `(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(sqlSource)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await click('Render with TALA');
    await wait("document.querySelector('.d2-preview svg')?.textContent.includes('WHERE id = $1')");
    assert.equal(await js("!!document.querySelector('.d2-source [role=alert]')"), false);
    assert.equal(await js("document.querySelector('textarea').value"), sqlSource);
    await js(
      `(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'a: {');e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
    await click('Render with TALA');
    await wait("!!document.querySelector('.d2-source [role=alert]')");
    assert.match(await js<string>("document.querySelector('.d2-render-state').textContent"), /explanation and code/);
    await capture('invalid-source');
    await click('Architecture');
    await wait("!!document.querySelector('.d2-preview svg')");
    assert.equal(
      await js(
        `(async()=>{const {renderD2,cachedD2}=await import('/lib/d2.ts');const source='cache_test -> result';const a=renderD2(source,false),b=renderD2(source,false);if(a!==b)return false;const result=await a;return cachedD2(source,false)===result;})()`
      ),
      true
    );
    assert.equal(
      await js(
        `(async()=>{const {renderD2}=await import('/lib/d2.ts');try{await renderD2('a.icon: https://example.com/private.svg',false);return false}catch{return true}})()`
      ),
      true
    );
    await loadWorkbenchPage(win, `${galleryURL}?generated`);
    await wait("!!document.querySelector('.d2-preview svg')");
    for (const name of ['Architecture', 'Sequence', 'Algorithm']) {
      await click(name);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await wait("!!document.querySelector('.d2-preview svg')");
      await capture(`generated-${name}`);
      await click('Expand diagram');
      await wait("!!document.querySelector('.d2-dialog svg')");
      await click('Next diagram step', dialog);
      await capture(`generated-${name}-expanded`);
      await click('Close');
    }
    await loadWorkbenchPage(win, `${galleryURL}?variant=algorithm`);
    await wait("!!document.querySelector('.d2-preview svg')");
    await click('Next diagram step');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('2 of 3')");
    await click('Next diagram step');
    await wait("document.querySelector('.d2-caption > strong')?.textContent === 'Capacity is full: C must wait'");
    assert.deepEqual(
      await js(
        '[...document.querySelectorAll(\'.d2-preview [data-d2-entity="slots"] [data-d2-updated]\')].map(e=>e.textContent)'
      ),
      ['2']
    );
    assert.equal(await js("document.querySelector('.d2-differences').open"), false);
    assert.equal(await js("document.querySelectorAll('.d2-caption > p').length"), 1);
    assert.equal(
      await js("document.querySelector('.d2-preview [data-d2-entity=\"slots\"]').getAttribute('data-d2-focus')"),
      'active'
    );
    await js("document.querySelector('.d2-differences summary').click()");
    assert.ok(await js("document.querySelector('.d2-differences').textContent.includes('In flight: 1 / 2')"));
    await js("document.querySelector('.d2-differences summary').click()");
    for (const dark of [false, true]) {
      await js("document.querySelector('.d2-view-nav button').click()");
      await wait("document.querySelector('.d2-step-count')?.textContent.includes('1 of 3')");
      await js(`document.documentElement.classList.toggle('dark',${dark})`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      // A theme change recompiles and returns to the first step.
      await wait(
        "!!document.querySelector('.d2-preview svg') && document.querySelector('.d2-step-count')?.textContent.includes('1 of 3')"
      );
      await click('Next diagram step');
      await wait("document.querySelector('.d2-step-count')?.textContent.includes('2 of 3')");
      await click('Next diagram step');
      await wait("document.querySelector('.d2-step-count')?.textContent.includes('3 of 3')");
      await js("document.querySelector('.d2-diagram').scrollIntoView({block:'end'})");
      await capture(`step-insights-${dark ? 'dark' : 'light'}`);
      await click('Expand diagram');
      await wait("!!document.querySelector('.d2-dialog .mermaid-zoom-art svg')");
      await capture(`step-insights-expanded-${dark ? 'dark' : 'light'}`);
      if (dark) {
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await click('Previous diagram step', dialog);
        await click('Next diagram step', dialog);
        assert.equal(
          await js(
            `${dialog}.querySelector('[data-d2-updated]') && getComputedStyle(${dialog}.querySelector('[data-d2-updated]')).animationName`
          ),
          'none'
        );
        assert.ok(
          await js(
            `getComputedStyle(${dialog}.querySelector('[data-d2-updated]')).textDecorationLine.includes('underline')`
          )
        );
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
        win.webContents.debugger.detach();
        win.setSize(640, 740);
        await capture('step-insights-expanded-narrow');
        assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      }
      await click('Close');
    }
    console.log(
      'PASS: D2 in SlideView, both themes, frames/captions, playback, unique IDs, bounded-cache reuse, error isolation, local resources, reduced motion and laptop/narrow layouts.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(
      await js(
        `({views:[...document.querySelectorAll('.d2-step-count')].map(e=>e.textContent),labels:[...document.querySelectorAll('.d2-dialog svg text')].map(e=>e.textContent)})`
      ).catch(() => 'Diagram unavailable')
    );
    app.exit(1);
  }
});
