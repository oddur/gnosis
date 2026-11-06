import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORATION_FIXTURE } from './fixtures/diagram-exploration';
import generated from './fixtures/architecture-generated.json';
import { normalizeSvgIllustration } from '../lib/svg-illustration';
import { validateSvgIllustrationInBrowser } from '../src/explainer-validation';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (condition: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(condition)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + condition);
  };
  const click = (label: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click();})()`
    );
  const dir = path.resolve('.impeccable/review/diagram-exploration');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 350));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const base = (process.env.GNOSIS_WORKBENCH_URL ?? '').replace('workbench.html', 'mechanisms.html');
  try {
    await validateSvgIllustrationInBrowser(EXPLORATION_FIXTURE);
    const tall = structuredClone(EXPLORATION_FIXTURE);
    tall.scenarios[0].frames[0].svg = tall.scenarios[0].frames[0].svg.replace('0 0 560 300', '0 0 560 470');
    await validateSvgIllustrationInBrowser(tall); // Must measure after the iframe's aspect-ratio resize.
    const moving = structuredClone(EXPLORATION_FIXTURE);
    moving.scenarios[0].frames.push({
      ...moving.scenarios[0].frames[0],
      svg: moving.scenarios[0].frames[0].svg.replace(
        'data-entity-id="review"',
        'data-entity-id="review" transform="translate(4 0)"'
      ),
    });
    await assert.rejects(() => validateSvgIllustrationInBrowser(moving), /Keep participant geometry stable/);
    const missing = structuredClone(EXPLORATION_FIXTURE);
    assert.ok(missing.exploration);
    missing.exploration.entities[0].id = 'absent';
    await assert.rejects(() => validateSvgIllustrationInBrowser(missing), /exactly one/);
    await win.loadURL(base + '?exploration-fixture');
    await wait("!!document.querySelector('.svg-illustration iframe')");
    await new Promise((r) => setTimeout(r, 600));
    const inner = win.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc');
    assert.ok(inner);
    await inner.executeJavaScript(
      `document.querySelector('[data-entity-id="cache"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    );
    await wait("document.querySelector('.diagram-inspector h3')?.textContent==='Revision cache'");
    await click('Explore diagram');
    await wait("document.querySelectorAll('.diagram-entity-target').length===3");
    await capture('fixture-expanded');
    const before = await js(
      "[...document.querySelectorAll('.react-flow__node-entity')].map(n=>[n.style.transform,n.style.width,n.style.height])"
    );
    const target = await js<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector('[aria-label="Inspect Review"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
    await wait("document.querySelector('.diagram-inspector h3')?.textContent==='Review'");
    await wait("[...document.querySelectorAll('.react-flow__node-entity')].every(n=>n.style.visibility==='visible')");
    await click('Inspect connection: Read file');
    await wait("document.querySelector('.diagram-inspector h3')?.textContent==='Read file'");
    assert.deepEqual(
      await js(
        "[...document.querySelectorAll('.react-flow__node-entity')].map(n=>[n.style.transform,n.style.width,n.style.height])"
      ),
      before
    );
    await click('Show code');
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(await js("document.querySelector('[data-source-line=\"3\"]')?.getAttribute('data-selected')"), 'true');
    await click('Explore diagram');
    await wait("document.querySelectorAll('.diagram-entity-target').length===3");
    win.focus();
    await new Promise((r) => setTimeout(r, 300));
    await js(`document.querySelector('[aria-label="Inspect Preloader"]').focus()`);
    assert.equal(await js("document.activeElement?.getAttribute('aria-label')"), 'Inspect Preloader');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait("document.querySelector('.diagram-inspector h3')?.textContent==='Preloader'");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    assert.equal(await js("document.querySelectorAll('.diagram-entity-target').length"), 3);
    await click('Zoom in');
    await click('Fit diagram');
    await click('Clear diagram selection');
    await capture('fixture-overview-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('fixture-overview-dark');
    win.setSize(620, 850);
    await new Promise((r) => setTimeout(r, 500));
    await capture('fixture-narrow');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 900);
    for (const result of generated as { id: string; title: string; slide: { svgIllustration?: unknown } }[]) {
      const scene = normalizeSvgIllustration(result.slide.svgIllustration);
      assert.ok(scene, `No illustration: ${result.id}`);
      await validateSvgIllustrationInBrowser(scene);
      await win.loadURL(base + '?architecture');
      await wait("!!document.querySelector('.svg-illustration iframe')");
      await click(result.title);
      await wait("document.querySelectorAll('.gallery-source-token').length>10");
      assert.ok(
        (await js<number>(
          "new Set([...document.querySelectorAll('.gallery-source-token')].map(n=>getComputedStyle(n).color)).size"
        )) >= 3,
        'Source uses syntax colors'
      );
      await new Promise((r) => setTimeout(r, 800));
      await capture(result.id + '-inline-light');
      await click(scene.exploration ? 'Explore diagram' : 'Expand illustration');
      await wait("!!document.querySelector('[role=dialog] iframe')");
      await new Promise((r) => setTimeout(r, 800));
      const drawingSize = await js<{ drawing: number; frame: number }>(
        `(()=>{const drawing=document.querySelector('.react-flow__node-drawing'),frame=document.querySelector('[role=dialog] iframe');return {drawing:drawing?.getBoundingClientRect().height??0,frame:frame.getBoundingClientRect().height};})()`
      );
      if (scene.exploration)
        assert.ok(
          Math.abs(drawingSize.drawing - drawingSize.frame) < 2,
          'SVG and selection overlays must share the same canvas extent'
        );
      await capture(result.id + '-expanded-light');
      if (scene.exploration) {
        assert.equal(
          await js(
            `(()=>{const viewport=document.querySelector('.diagram-explorer-viewport').getBoundingClientRect(),tools=document.querySelector('.diagram-explorer-tools').getBoundingClientRect();return tools.top>=viewport.bottom-1;})()`
          ),
          true,
          'Viewport controls must not cover the drawing'
        );
      }
      if (scene.exploration) {
        await click('Inspect ' + scene.exploration.entities[0].label);
        await capture(result.id + '-selected-light');
      }
      await js("document.documentElement.classList.add('dark')");
      await capture(result.id + '-expanded-dark');
    }
    console.log(
      'Diagram exploration: geometry, identities, inline selection, stable map, relationships, source navigation, keyboard and themes passed.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
