import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { QUEUE_SCENE } from './fixtures/mechanism-examples';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = async <T = unknown>(code: string): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      console.error('Failed script:', code);
      throw error;
    }
  };
  const wait = async (condition: string) => {
    for (let i = 0; i < 100; i++) {
      if (await js(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timeout: ${condition}`);
  };
  const click = async (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`
    );
  const dir = path.resolve('.impeccable/review/animated-mechanisms');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const geometry = () =>
    js<string[]>(`(()=>{
    const errors=[];
    for(const node of document.querySelectorAll('.mechanism-node')){
      const body=node.querySelector('rect').getBoundingClientRect();
      for(const text of node.querySelectorAll('text')){const b=text.getBoundingClientRect();if(b.left<body.left-1||b.right>body.right+1||b.bottom>body.bottom+1)errors.push('Text escapes '+node.dataset.node+': '+text.textContent);}
    }
    const svg=document.querySelector('.mechanism-scene');
    if(svg){const b=svg.getBoundingClientRect();if(b.width>innerWidth)errors.push('Scene exceeds viewport');}
    return errors;
  })()`);
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL?.replace('workbench.html', 'mechanisms.html');
    assert.ok(url);
    await loadWorkbenchPage(win, `${url}?fixtures`);
    await wait("!!document.querySelector('.mechanism-scene')");
    // Exercise animation independently of the desktop's accessibility preference.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const initial = await js('document.querySelector(\'[data-node="pending"]\').textContent');
    const initialGeometry = await js(
      "[...document.querySelectorAll('[data-node]')].map(n=>n.getAttribute('transform'))"
    );
    await click('Next event');
    await wait("document.querySelector('.mechanism-event-count').textContent==='2 / 3'");
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-node]')].map(n=>n.getAttribute('transform'))"),
      initialGeometry
    );
    await click('Previous event');
    assert.equal(await js('document.querySelector(\'[data-node="pending"]\').textContent'), initial);
    await js(
      `(()=>{const slider=document.querySelector('[aria-label="Diagram timeline"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.8');slider.dispatchEvent(new Event('input',{bubbles:true}));})()`
    );
    await wait("document.querySelector('.mechanism-event-count').textContent==='2 / 3'");
    await click('Next event');
    await wait("document.querySelector('.mechanism-event-count').textContent==='3 / 3'");
    await click('Previous event');
    await wait("document.querySelector('.mechanism-event-count').textContent==='2 / 3'");
    await click('Restart animation');
    await click('Play animation');
    await wait("!!document.querySelector('.mechanism-payload')");
    await click('Pause animation');
    await capture('queue-moving');
    await click('Expand animation');
    await wait("!!document.querySelector('[role=dialog] svg')");
    assert.equal(await js("document.querySelectorAll('.mechanism-scene').length"), 1, 'one live scene when expanded');
    await click('Next event');
    await capture('expanded');
    await js(
      "document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"
    );
    await loadWorkbenchPage(win, `${url}?previous`);
    await wait("!!document.querySelector('.mechanism-scene')");
    for (const example of ['Ordered batching', 'Rejecting a stale write']) {
      await click(example);
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        for (const width of [1280, 1000, 760]) {
          win.setSize(width, 900);
          await new Promise((r) => setTimeout(r, 100));
          await capture(`${example === 'Ordered batching' ? 'queue' : 'version'}-${dark ? 'dark' : 'light'}-${width}`);
          assert.deepEqual(await geometry(), []);
        }
      }
      if (example === 'Rejecting a stale write') {
        win.setSize(1000, 900);
        await js(
          `(()=>{const slider=document.querySelector('[aria-label="Diagram timeline"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.33');slider.dispatchEvent(new Event('input',{bubbles:true}));})()`
        );
        await wait("!!document.querySelector('.mechanism-payload')");
        assert.equal(await js("document.querySelectorAll('.mechanism-payload text').length"), 0);
        assert.match(await js<string>("document.querySelector('.mechanism-caption').textContent"), /In transit:/);
        await capture('version-moving-1000');
        await click('Restart animation');
      }
      win.setSize(1280, 900);
      const count = await js<number>('document.querySelector(\'[aria-label="Diagram scenario"]\').options.length');
      for (let scenario = 0; scenario < count; scenario++) {
        await js(
          `(()=>{const s=document.querySelector('[aria-label="Diagram scenario"]');s.value=${scenario};s.dispatchEvent(new Event('change',{bubbles:true}));})()`
        );
        await click('Restart animation');
        const steps = await js<number>('Number(document.querySelector(\'[aria-label="Diagram timeline"]\').max)');
        for (let step = 0; step <= steps; step++) {
          assert.deepEqual(await geometry(), []);
          if (step < steps) await click('Next event');
        }
        await capture(`${example === 'Ordered batching' ? 'queue' : 'version'}-scenario-${scenario}-final`);
      }
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await new Promise((r) => setTimeout(r, 200));
    await click('Restart animation');
    await click('Play animation');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await js("document.querySelectorAll('.mechanism-payload').length"), 0);
    await click('Pause animation');
    await click('Next event');
    assert.deepEqual(await geometry(), []);
    win.webContents.debugger.detach();
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);const scene=${JSON.stringify(QUEUE_SCENE)};const h=review.slides[0].diffHunks[0];for(const scenario of scene.scenarios)for(const event of scenario.events)event.evidence={filePath:h.filePath,startLine:parseInt(h.hunkHeader.split('+')[1])};return {...review,slides:[{...review.slides[0],title:'Keep queue order',mechanism:scene,d2Diagram:null,mermaidDiagram:null}]};};})()`
    );
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative .mechanism-scene')");
    assert.equal(await js("!!document.querySelector('.review-code .review-file-group')"), true);
    await js("document.querySelector('.mechanism-diagram').scrollIntoView({block:'start'})");
    await capture('slide-integration');
    await click('Show supporting code');
    await wait(
      "[...document.querySelectorAll('diffs-container')].some(el=>!!el.shadowRoot?.querySelector('.check-highlight'))"
    );
    console.log(`Mechanism browser checks passed. Captures: ${dir}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode === 1 ? 1 : 0);
  }
});
