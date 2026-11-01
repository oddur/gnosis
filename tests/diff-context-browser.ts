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
  const js = async <T = unknown>(s: string): Promise<T> => {
    try { return await win.webContents.executeJavaScript(s) as T; }
    catch (error) { throw new Error(`${s}: ${String(error)}`); }
  };
  const wait = async (s: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(s)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error('Timed out: ' + s);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width&&(e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e)throw Error('Missing '+${JSON.stringify(label)});e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click()})()`
    );
    await new Promise((r) => setTimeout(r, 50));
  };
  const setContext = async (n: number) => {
    await click('Diff appearance');
    await js(
      `(()=>{const e=document.querySelector('[aria-label="Show surrounding lines"]');e.value='${n}';e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await wait(`window.electronAPI.loadPreferences().then(p=>p.diffAppearance?.contextLines===${n})`);
    await js(
      `document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
    );
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      `window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];window.contextCount=()=>window.deepAll('[data-line-type=context][data-column-number]',document.querySelector('[data-file*="src/worker.ts"] .changes-code')).length;void 0;`
    );
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Changes');
    await wait("window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')==='worker.ts')");
    await js("window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')==='worker.ts').click()");
    await wait('window.contextCount()===6');
    await setContext(1);
    await wait('window.contextCount()===2');
    await setContext(10);
    await wait('window.contextCount()===20');
    await setContext(5);
    await wait('window.contextCount()===10');
    await click('Summary');
    await click('Changes');
    await wait('window.contextCount()===10');
    await click('Commits');
    await wait("!!document.querySelector('.changes-file-header')");
    await click('Diff appearance');
    assert.equal(await js('document.querySelector(\'[aria-label="Show surrounding lines"]\').value'), '5');
    await js(
      `document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
    );
    await click('Review queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await click('Diff appearance');
    assert.equal(await js('document.querySelector(\'[aria-label="Show surrounding lines"]\').value'), '5');
    const dir = path.resolve('.impeccable/review/diff-context');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, 'appearance.png'), (await win.webContents.capturePage()).toPNG());
    await click('Reset appearance');
    await wait("document.querySelector('[aria-label=\"Show surrounding lines\"]').value==='3'");
    console.log(
      'Diff context browser checks passed: exact counts, persistence across tabs, Commits/Explanation, reset.'
    );
  } catch (e) {
    console.error(e);
    console.log(
      await js(
        `({count:window.contextCount?.(),lines:window.deepAll('[data-line-type]',document.querySelector('[data-file*="src/worker.ts"] .changes-code')).map(e=>[e.tagName,e.getAttribute('data-line-type'),e.getAttribute('data-column-number')]).slice(0,50),text:document.querySelector('[data-file*="src/worker.ts"] .changes-code')?.textContent})`
      )
    );
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
