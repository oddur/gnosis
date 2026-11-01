import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    show: true,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code).catch((error: unknown) => { throw Error(`${code}: ${String(error)}`); }) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw Error(`Timed out: ${expression}`);
  };
  try {
    await loadWorkbenchPage(window, (process.env.GNOSIS_WORKBENCH_URL ?? '').replace('workbench.html', 'inspection-scroll.html'));
    await wait("!!document.querySelector('.changes-file-tree')?.shadowRoot");
    await js(
      `window.deepAll=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?window.deepAll(selector,e.shadowRoot):[])];void 0;`
    );
    await wait("window.deepAll('[role=treeitem]').length>0");
    await js(
      `window.treeScroll=window.deepAll('*').find(e=>e.scrollHeight>e.clientHeight+100 && e.clientHeight>100 && getComputedStyle(e).overflowY.match(/auto|scroll/) && !e.classList.contains('commit-diff-stream'));if(!window.treeScroll)throw Error('Missing tree scroller');`
    );
    // Browse away from the active file, then let asynchronous comment metadata arrive.
    await js('window.treeScroll.scrollTop=1800');
    await wait('window.treeScroll.scrollTop>=1700');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await js<number>('window.treeScroll.scrollTop');
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Update comments').click()");
    await wait("window.deepAll('[title]').some(e=>e.title.includes('1 GitHub comment,'))");
    assert.equal(
      await js('window.treeScroll.scrollTop'),
      before,
      'Comment updates must not pull the file tree back to the active diff'
    );
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Add file').click()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await js('window.treeScroll.scrollTop'),
      before,
      'Inventory additions must not reveal an unchanged selection'
    );
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Select last file').click()");
    await wait('window.treeScroll.scrollTop>3000');
    await wait(
      "window.deepAll('[role=treeitem][aria-selected=true]').some(e=>e.getAttribute('data-item-path')==='file-159.ts')"
    );
    console.log('Inspection scroll checks passed');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
