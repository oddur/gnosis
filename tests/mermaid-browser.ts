import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((e: unknown) => {
      throw new Error(`${code}: ${String(e)}`);
    }) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 240; i++) {
      if (await js(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = async (name: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(name)} || b.getAttribute('aria-label')===${JSON.stringify(name)} || b.title===${JSON.stringify(name)}));if(!b)throw Error('Missing button');b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
  };
  const shots = path.resolve('.impeccable/review/mermaid');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 200));
    await js(
      "if (!document.querySelector('[role=dialog]')) document.querySelector('.mermaid-diagram')?.scrollIntoView({block:'center'})"
    );
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const previewFits = () =>
    js<boolean>(`(()=>{
    const preview=document.querySelector('.mermaid-preview'),svg=preview?.querySelector('svg'),canvas=preview?.querySelector('.mermaid-preview-canvas');
    if(!svg||!canvas)return false;
    const s=svg.getBoundingClientRect(),c=canvas.getBoundingClientRect();
    return s.height<=321 && s.width<=c.width+1 && preview.scrollHeight<=preview.clientHeight+1 && preview.scrollWidth<=preview.clientWidth+1 && getComputedStyle(preview).overflowY!=='auto';
  })()`);
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await js("document.title='Gnosis — automated Mermaid checks'");
    await waitForWorkbenchQueue(win.webContents);
    const tall = `flowchart TD
      A[Check migration state] --> B[Prepare tables online]
      B --> C[Stop gameplay and wait for pods]
      C --> D[Attach partitions in one transaction]
      D -->|Archive enabled| E[Run first archive]
      D -->|Archive disabled| F[Restore gameplay]
      E -->|Complete or incomplete| F
      F --> G[Validate constraints]`;
    const wide = `flowchart LR
      A[Accept producer request] --> B[Reserve queue capacity]
      B --> C[Store pending command]
      C --> D[Notify the waiting worker]
      D --> E[Dispatch the next batch]
      E --> F[Record command results]
      F --> G[Release reserved capacity]
      G --> H[Wake waiting producers]`;
    await js(`(()=>{const read=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{
      const review=await read(...args), first=review.slides[0];
      return {...review,slides:[${JSON.stringify(tall)},${JSON.stringify(wide)},'flowchart LR\\n A[broken'].map((chart,index)=>({...first,id:'diagram-topic-'+index,slideNumber:index+1,title:['Deployment conversion and first archive','Command processing pipeline','Invalid diagram fallback'][index],narrative:'Preparation runs while gameplay is online. The deployment then attaches the partitions and restores gameplay after the optional archive.\\n\\nThe diagram shows where the two archive paths rejoin.',mermaidDiagram:chart,explainer:null,explainerIdea:null}))};
    };})()`);
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative .mermaid-preview svg')");
    assert.equal(await js("!!document.querySelector('.review-code .mermaid-diagram')"), false);
    assert.equal(await js("!!document.querySelector('.review-code .review-file-group')"), true);
    assert.equal(await previewFits(), true);
    assert.equal(await js("getComputedStyle(document.querySelector('.mermaid-expand')).opacity"), '1');
    assert.match(await js<string>("document.querySelector('.mermaid-expand').textContent"), /Expand diagram/);
    for (const [width, height, name] of [
      [1280, 800, 'desktop'],
      [1760, 1440, 'user-1760'],
      [1024, 768, 'laptop'],
      [640, 740, 'mobile'],
    ] as const) {
      win.setSize(width, height);
      await js("document.querySelector('.mermaid-diagram').scrollIntoView({block:'center'})");
      await capture(name);
      assert.equal(await previewFits(), true, `${width}px preview contains the complete graph`);
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    }
    await click('Expand diagram');
    await wait("!!document.querySelector('.mermaid-fullscreen svg')");
    assert.equal(
      await js("document.querySelector('[role=dialog]').textContent.includes('Deployment conversion')"),
      true
    );
    assert.equal(
      await js(
        "(()=>{const el=document.querySelector('.mermaid-fullscreen');return el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1})()"
      ),
      true
    );
    await capture('expanded-mobile');
    win.setSize(1280, 800);
    await wait("!!document.querySelector('.mermaid-fullscreen svg')");
    await capture('expanded-fit');
    await click('100%');
    await wait("document.querySelector('.mermaid-controls output').textContent==='100%'");
    await wait(
      "document.querySelector('.mermaid-fullscreen').scrollHeight>document.querySelector('.mermaid-fullscreen').clientHeight"
    );
    assert.equal(
      await js("(()=>{const el=document.querySelector('[role=dialog]');return el.scrollHeight<=el.clientHeight+1})()"),
      true,
      'Only the canvas scrolls; controls stay visible'
    );
    await capture('expanded-readable');
    await click('Zoom in');
    await wait("document.querySelector('.mermaid-controls output').textContent==='125%'");
    // Real Electron pointer capture, release, and panning at readable scale.
    const point = await js<{ x: number; y: number }>(
      "(()=>{const e=document.querySelector('.mermaid-fullscreen'),r=e.getBoundingClientRect();e.scrollTop=0;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await wait("document.querySelector('.mermaid-fullscreen').dataset.dragging==='true'");
    win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftbuttondown'], x: point.x, y: point.y - 120 });
    await wait("document.querySelector('.mermaid-fullscreen').scrollTop>50");
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y - 120 });
    await wait("document.querySelector('.mermaid-fullscreen').dataset.dragging==='false'");
    await js(
      "document.querySelector('.mermaid-fullscreen').dispatchEvent(new KeyboardEvent('keydown',{key:'0',bubbles:true}))"
    );
    await wait("document.querySelector('.mermaid-fullscreen').scrollTop===0");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait("!document.querySelector('[role=dialog]')");
    await wait("document.activeElement===document.querySelector('.mermaid-preview')");
    await js("document.documentElement.classList.add('dark')");
    await wait("!!document.querySelector('.mermaid-diagram[data-theme=dark] svg')");
    await capture('dark');
    await click('Next (→)');
    await wait("document.querySelector('.mermaid-preview')?.textContent.includes('Wake waiting producers')");
    assert.equal(await previewFits(), true, 'A wide graph also fits without inner scrolling');
    await capture('wide');
    await click('Expand diagram');
    await wait("!!document.querySelector('.mermaid-fullscreen svg')");
    await click('100%');
    await wait(
      "document.querySelector('.mermaid-fullscreen').scrollWidth>document.querySelector('.mermaid-fullscreen').clientWidth"
    );
    await click('Fit');
    await wait(
      "document.querySelector('.mermaid-fullscreen').scrollWidth<=document.querySelector('.mermaid-fullscreen').clientWidth+1"
    );
    await capture('wide-expanded');
    await click('Close');
    await wait("!document.querySelector('[role=dialog]')");
    await click('Next (→)');
    await wait("document.querySelector('.mermaid-diagram')?.textContent.includes('Could not render this diagram')");
    assert.match(await js<string>("document.querySelector('.mermaid-diagram pre').textContent"), /A\[broken/);
    await capture('invalid');
    console.log(
      'Mermaid browser checks passed: placement, whole preview, tall/wide, fit/zoom/pan, resize, themes, keyboard/focus, source fallback.'
    );
  } catch (error) {
    console.error(error);
    await capture('failure');
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
