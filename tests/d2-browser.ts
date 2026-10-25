import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { D2_EXAMPLES } from './fixtures/d2-examples';

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
    fs.writeFileSync(path.join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const dialog = 'document.querySelector(".d2-dialog")';
  try {
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(
      `(()=>{const load=window.electronAPI.loadReview;window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);return {...review,slides:[{...review.slides[0],title:'Architecture with annotations',d2Diagram:${JSON.stringify(D2_EXAMPLES[0].diagram)},mermaidDiagram:null}]};};})()`
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
    assert.equal(await js("document.querySelectorAll('.d2-notes > div').length"), 3);
    const duplicateIDs = await js<string[]>(
      `(()=>{const ids=[...document.querySelectorAll('.d2-diagram [id],.d2-dialog [id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)})()`
    );
    assert.deepEqual(duplicateIDs, []);
    await click('Close');
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
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
    await win.loadURL(galleryURL);
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
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('1 / 4')");
    await click('Play');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('2 / 4')");
    await click('Next diagram step');
    await wait("document.querySelector('.d2-step-count')?.textContent.includes('3 / 4')");
    assert.equal(await js("document.querySelector('.d2-diagram').dataset.motion"), 'false');
    await click('Expand diagram');
    await wait("!!document.querySelector('.d2-dialog svg')");
    await capture('sequence-expanded-dark');
    await click('Reset diagram walkthrough', dialog);
    await click('Next diagram step', dialog);
    assert.match(await js<string>(`${dialog}.querySelector('.d2-caption').textContent`), /Pin what the reviewer saw/);
    await click('Animate flow', dialog);
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
    await win.loadURL(`${galleryURL}?generated`);
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
    console.log(
      'PASS: D2 in SlideView, both themes, frames/captions, playback, unique IDs, bounded-cache reuse, error isolation, local resources, reduced motion and laptop/narrow layouts.'
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
