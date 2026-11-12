import type { BrowserWindow, WebContents } from 'electron';

/** Dev-page compilation is separate from interaction latency; queue rows are virtualized. */
export async function waitForWorkbenchQueue(contents: WebContents, expectedItems = 7): Promise<void> {
  const ready = `Boolean(document.querySelector('.queue-item')) && Boolean(window.electronAPI) && window.electronAPI.workbenchQueue().then(queue => queue.items.length === ${expectedItems})`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(ready)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = await contents.executeJavaScript(
    `({readyState:document.readyState,rows:document.querySelectorAll('.queue-item').length,api:!!window.electronAPI,text:document.body.innerText.slice(0,4000)})`
  );
  throw new Error(`Workbench queue did not become ready: ${JSON.stringify(state)}`);
}

/** loadURL resolves before the fixture's top-level dynamic imports finish rendering. */
export async function loadWorkbenchPage(window: BrowserWindow, url: string): Promise<void> {
  // Keep what the page reported so a render timeout explains itself (script errors, Vite reloads).
  const log: string[] = [];
  const onConsole = ({ level, message }: { level: string; message: string }) => {
    if (level === 'error' || level === 'warning' || message.includes('[vite]')) log.push(`${level}: ${message}`);
  };
  const onGone = (_: unknown, details: { reason: string }) => log.push(`renderer gone: ${details.reason}`);
  window.webContents.on('console-message', onConsole);
  window.webContents.on('render-process-gone', onGone);
  try {
    await loadAndRender(window, url);
  } catch (error) {
    const state: unknown = await window.webContents
      .executeJavaScript(
        `({readyState:document.readyState,root:document.querySelector('#root')?.innerHTML.slice(0,500)??null,text:document.body?.innerText.slice(0,1000)??''})`
      )
      .catch((stateError: unknown) => String(stateError));
    throw new Error(
      `${(error as Error).message}\nPage state: ${JSON.stringify(state)}\nPage log:\n${log.slice(-30).join('\n') || '(none)'}`
    );
  } finally {
    window.webContents.off('console-message', onConsole);
    window.webContents.off('render-process-gone', onGone);
  }
}

async function loadAndRender(window: BrowserWindow, url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      window.loadURL(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out loading ${url.slice(0, 200)}`)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!new URL(url).pathname.startsWith('/tests/fixtures/')) return;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.firstElementChild)")) {
      // Screens load on first use. In production that is a local chunk; here the dev server compiles it,
      // which is separate from interaction latency. Fixtures without the app skip this.
      await window.webContents.executeJavaScript(
        `import('/src/lazy-screens.ts').then(m => Promise.all([m.PrSummary.preload(), m.ReviewPage.preload(), m.SettingsDialog.preload()])).then(() => true, () => false)`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture did not render after loading ${url}`);
}
