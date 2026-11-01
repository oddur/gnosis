import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { buildSvgIllustrationDocument } from '../lib/svg-illustration-document';
import { SVG_MOTION_FIXTURE } from './fixtures/svg-motion';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { validateSvgIllustrationInBrowser } from '../src/explainer-validation';
import { normalizeSvgIllustration } from '../lib/svg-illustration';
import generated from './fixtures/illustration-generated.json';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = async <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (condition: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(condition)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + condition);
  };
  const click = async (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click();})()`
    );
  const dir = path.resolve('.impeccable/review/svg-illustrations');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const inner = () => {
    const frame = win.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc');
    assert.ok(frame);
    return frame;
  };
  try {
    await loadWorkbenchPage(win,
      'data:text/html,' + encodeURIComponent(buildSvgIllustrationDocument(SVG_MOTION_FIXTURE, 'capture-test'))
    );
    await wait("!!document.querySelector('[data-motion-id]')");
    // CI desktops may disable animations. Exercise motion independently of the host preference.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await js('document.fonts.ready');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const sample = async (transition: boolean) =>
      js<number>(`new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Illustration capture timed out'));},10000);
      const receive=e=>{if(e.data?.token==='capture-test'&&e.data.event==='error'){
        clearTimeout(timer);removeEventListener('message',receive);reject(Error(e.data.message));return;
      }if(e.data?.token==='capture-test'&&e.data.event==='captured'){
        clearTimeout(timer);removeEventListener('message',receive);
        resolve(new DOMMatrix(getComputedStyle(document.querySelector('[data-motion-id]')).transform).e);
      }};
      addEventListener('message',receive);
      postMessage({type:'gnosis-illustration-control',token:'capture-test',command:'capture',scenario:0,index:1,transition:${transition}},'*');
    })`);
    const midpoint = await sample(true);
    assert.ok(midpoint > 60 && midpoint < 260, `Mid-transition must be between endpoints, got ${midpoint}`);
    assert.equal(await sample(false), 260);
    for (const result of generated) {
      const scene = normalizeSvgIllustration(result.slide.svgIllustration);
      assert.ok(scene);
      await validateSvgIllustrationInBrowser(scene);
    }
    const scene = normalizeSvgIllustration(generated[0]?.slide.svgIllustration);
    assert.ok(scene);
    const hostile = structuredClone(scene);
    hostile.scenarios[0].frames[0].svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 300"><script>parent.alert(1)</script></svg>';
    await assert.rejects(() => validateSvgIllustrationInBrowser(hostile), /Unsupported SVG element/);
    const clipped = structuredClone(scene);
    const viewBox = clipped.scenarios[0].frames[0].svg.match(/viewBox="([^"]+)"/)?.[1];
    assert.ok(viewBox);
    const width = Number(viewBox.split(/[\s,]+/)[2]);
    clipped.scenarios[0].frames[0].svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><text x="${width - 10}" y="30" font-size="18">This does not fit</text></svg>`;
    await assert.rejects(() => validateSvgIllustrationInBrowser(clipped), /outside canvas/);
    await loadWorkbenchPage(win, (process.env.GNOSIS_WORKBENCH_URL ?? '').replace('workbench.html', 'mechanisms.html'));
    await wait("!!document.querySelector('.svg-illustration iframe')");
    for (const result of generated) {
      await click(result.title);
      await wait("!!document.querySelector('.svg-illustration iframe')");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await js("document.querySelector('iframe').getAttribute('sandbox')"), 'allow-scripts');
      assert.equal(await js("document.querySelector('iframe').contentDocument"), null, 'opaque origin');
      for (const dark of [false, true]) {
        await js(`document.documentElement.classList.toggle('dark',${dark})`);
        for (const width of [1280, 1000]) {
          win.setSize(width, 900);
          await capture(`${result.id}-${dark ? 'dark' : 'light'}-${width}`);
          await js("document.querySelector('.svg-illustration').scrollIntoView({block:'start'})");
          await capture(`${result.id}-${dark ? 'dark' : 'light'}-${width}-figure`);
          await js('window.scrollTo(0,0)');
        }
      }
      await click('Expand illustration');
      await wait("!!document.querySelector('[role=dialog] iframe')");
      await capture(`${result.id}-expanded`);
      await click('Close');
      await wait("!!document.querySelector('.svg-illustration iframe')");
      assert.equal(await inner().executeJavaScript('typeof window.electronAPI'), 'undefined');
      const count = await js<number>(
        'Number(document.querySelector(\'[aria-label="Illustration timeline"]\')?.max??0)'
      );
      if (count) {
        await wait('!document.querySelector(\'[aria-label="Next illustration step"]\').disabled');
        const initial = await inner().executeJavaScript("document.querySelector('svg').outerHTML");
        await click('Next illustration step');
        await new Promise((r) => setTimeout(r, 550));
        await capture(`${result.id}-next`);
        assert.notEqual(await inner().executeJavaScript("document.querySelector('svg').outerHTML"), initial);
        await click('Previous illustration step');
        await new Promise((r) => setTimeout(r, 550));
        assert.equal(await inner().executeJavaScript("document.querySelector('svg').outerHTML"), initial);
        await click('Play illustration');
        await wait("document.querySelector('.svg-illustration .mechanism-event-count').textContent.startsWith('2 /')");
        await click('Pause illustration');
      }
      if (result.id !== 'rotation') {
        await click('Previous version');
        await wait("!!document.querySelector('.mechanism-scene')");
        await click('New version');
        await wait("!!document.querySelector('.svg-illustration iframe')");
      }
    }
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);const illustration=${JSON.stringify(generated[0].slide.svgIllustration)};const h=review.slides[0].diffHunks[0];for(const s of illustration.scenarios)for(const f of s.frames)f.evidence={filePath:h.filePath,startLine:parseInt(h.hunkHeader.split('+')[1])};return {...review,slides:[{...review.slides[0],title:'SVG integration fixture',narrative:'Check the illustration beside the code.',svgIllustration:illustration,d2Diagram:null,mermaidDiagram:null,mechanism:null}]};};})()`
    );
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative .svg-illustration iframe')");
    assert.equal(await js("!!document.querySelector('.review-code .review-file-group')"), true);
    await js("document.querySelector('.svg-illustration').scrollIntoView({block:'start'})");
    await capture('slide-integration');
    await click('Show supporting code');
    await wait(
      "[...document.querySelectorAll('diffs-container')].some(el=>!!el.shadowRoot?.querySelector('.check-highlight'))"
    );
    await loadWorkbenchPage(win,
      (process.env.GNOSIS_WORKBENCH_URL ?? '').replace('workbench.html', 'mechanisms.html') + '?motion-fixture'
    );
    await wait('!!document.querySelector(\'[aria-label="Next illustration step"]:not(:disabled)\')');
    const original = await inner().executeJavaScript("document.querySelector('svg').outerHTML");
    await click('Next illustration step');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await js("document.querySelector('.mechanism-event-count').textContent"), '2 / 3');
    assert.match(
      String(await inner().executeJavaScript("document.querySelector('[data-motion-id]').getAttribute('transform')")),
      /260/
    );
    await capture('motion-next');
    await click('Expand illustration');
    await wait("!!document.querySelector('[role=dialog] iframe')");
    await wait('!document.querySelector(\'[aria-label="Next illustration step"]\').disabled');
    assert.equal(await js("document.querySelector('.mechanism-event-count').textContent"), '2 / 3');
    await click('Previous illustration step');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await inner().executeJavaScript("document.querySelector('svg').outerHTML"), original);
    await click('Play illustration');
    await wait("document.querySelector('.mechanism-event-count').textContent==='2 / 3'");
    await click('Pause illustration');
    await js(
      `(()=>{const select=document.querySelector('[aria-label="Illustration scenario"]');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    assert.equal(await js("document.querySelector('.mechanism-event-count').textContent"), '1 / 3');
    assert.match(
      String(await inner().executeJavaScript("document.querySelector('[data-motion-id]').getAttribute('transform')")),
      /460/
    );

    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await new Promise((r) => setTimeout(r, 200));
    await click('Next illustration step');
    assert.equal(await inner().executeJavaScript('document.getAnimations().length'), 0);
    win.webContents.debugger.detach();
    console.log('SVG illustration browser checks passed. Captures: ' + dir);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode === 1 ? 1 : 0);
  }
});
