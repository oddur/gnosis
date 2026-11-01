import type { WebContents } from 'electron';

/** Dev-page compilation is separate from interaction latency; queue rows are virtualized. */
export async function waitForWorkbenchQueue(contents: WebContents, expectedItems = 7): Promise<void> {
  const ready = `Boolean(document.querySelector('.queue-item')) && Boolean(window.electronAPI) && window.electronAPI.workbenchQueue().then(queue => queue.items.length === ${expectedItems})`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(ready)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const state = await contents.executeJavaScript(`({readyState:document.readyState,rows:document.querySelectorAll('.queue-item').length,api:!!window.electronAPI,text:document.body.innerText.slice(0,4000)})`);
  throw new Error(`Workbench queue did not become ready: ${JSON.stringify(state)}`);
}
