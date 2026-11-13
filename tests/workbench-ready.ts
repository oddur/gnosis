import type { BrowserWindow, WebContents } from 'electron';

/** Dev-page compilation is separate from interaction latency; queue rows are virtualized. */
export async function waitForWorkbenchQueue(contents: WebContents, expectedItems = 7): Promise<void> {
  const ready = `Boolean(document.querySelector('.queue-item')) && Boolean(window.electronAPI) && window.electronAPI.workbenchQueue().then(queue => queue.items.length === ${expectedItems})`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await contents.executeJavaScript(ready)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state: unknown = await contents.executeJavaScript(
    `({readyState:document.readyState,rows:document.querySelectorAll('.queue-item').length,api:!!window.electronAPI,text:document.body.innerText.slice(0,4000)})`
  );
  throw new Error(`Workbench queue did not become ready: ${JSON.stringify(state)}`);
}

const loadTimeoutMs = 60_000;

/** loadURL did not settle: the page never reached its load event. */
class LoadStalled extends Error {}

/**
 * loadURL resolves before the fixture's top-level dynamic imports finish rendering.
 *
 * A page that never reaches its load event is loaded once more. On Windows CI the first load of a
 * suite once stalled for over a minute with no script error, while the same load normally takes a
 * few seconds. The stalled attempt's diagnostics are printed either way, so a stall that recovers
 * still shows which requests were pending.
 */
export async function loadWorkbenchPage(window: BrowserWindow, url: string): Promise<void> {
  const diagnostics = await watchPage(window);
  try {
    try {
      await loadAndRender(window, url);
    } catch (error) {
      if (!(error instanceof LoadStalled)) throw error;
      console.warn(`${error.message}; loading it once more.\n${await diagnostics.report()}`);
      diagnostics.mark('loading the page once more');
      await stopLoading(window.webContents);
      await loadAndRender(window, url);
    }
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await diagnostics.report()}`);
  } finally {
    diagnostics.stop();
  }
}

async function loadAndRender(window: BrowserWindow, url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loading = window.loadURL(url);
  // A stalled load is abandoned; its later rejection must not become an unhandled rejection.
  loading.catch(() => {});
  try {
    await Promise.race([
      loading,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LoadStalled(`Timed out loading ${url.slice(0, 200)} after ${loadTimeoutMs / 1000}s`)),
          loadTimeoutMs
        );
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

/** A new loadURL while the stalled one is still loading would see that load's abort as its own failure. */
async function stopLoading(contents: WebContents): Promise<void> {
  contents.stop();
  for (let i = 0; i < 50 && contents.isLoading(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
}

type CdpParams = {
  requestId?: string;
  type?: string;
  request?: { url: string };
  response?: { url: string; status: number };
  errorText?: string;
  canceled?: boolean;
  exceptionDetails?: { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } };
};

const pageStateScript = `(()=>{
  const nav = performance.getEntriesByType('navigation')[0];
  const done = performance.getEntriesByType('resource');
  return {
    href: location.href,
    readyState: document.readyState,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadMs: nav ? Math.round(nav.loadEventEnd) : null,
    resourcesDone: done.length,
    lastResources: done.slice(-3).map(entry => entry.name.replace(location.origin, '')),
    root: document.querySelector('#root')?.innerHTML.slice(0, 500) ?? null,
    text: document.body?.innerText.slice(0, 1000) ?? '',
  };
})()`;

/**
 * Records what a page reports while it loads, so a load or render timeout explains itself: console
 * errors, uncaught errors and unhandled rejections, failed and still-pending requests, frame load
 * failures, renderer crashes and hangs, and how far the document got.
 */
async function watchPage(window: BrowserWindow) {
  const contents = window.webContents;
  const started = Date.now();
  const events: string[] = [];
  const pending = new Map<string, { url: string; at: number }>();
  let ownsDebugger = false;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const mark = (line: string) => {
    events.push(`+${seconds(Date.now() - started)} ${line}`);
    if (events.length > 200) events.shift();
  };
  const onConsole = (details: { level: string; message: string; sourceId?: string; lineNumber?: number }) => {
    const { level, message } = details;
    if (level !== 'error' && level !== 'warning' && !message.includes('[vite]')) return;
    // With CDP, uncaught errors and rejections are recorded with their stack below.
    if (ownsDebugger && message.startsWith('Uncaught')) return;
    const source = level === 'error' && details.sourceId ? ` (${details.sourceId}:${details.lineNumber ?? 0})` : '';
    mark(`console ${level}: ${message.slice(0, 1000)}${source}`);
  };
  const onGone = (_: unknown, details: { reason: string }) => mark(`renderer gone: ${details.reason}`);
  const onFail = (_: unknown, code: number, description: string, failedUrl: string, isMainFrame: boolean) =>
    mark(`${isMainFrame ? 'page' : 'frame'} load failed: ${description} (${code}) ${failedUrl}`);
  const onUnresponsive = () => mark('renderer unresponsive');
  const onResponsive = () => mark('renderer responsive again');
  // CDP reports errors and rejections the page never logs itself, and the outcome of every request.
  const onCdp = (_: unknown, method: string, params: CdpParams) => {
    const id = params.requestId;
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      const where = details?.url ? ` at ${details.url}:${(details.lineNumber ?? 0) + 1}` : '';
      mark(`page error: ${(details?.exception?.description ?? details?.text ?? 'unknown').slice(0, 1000)}${where}`);
    } else if (method === 'Network.requestWillBeSent' && id && params.request && params.type !== 'Document') {
      // Documents are covered by the load state; an aborted navigation never reports them finished.
      pending.set(id, { url: params.request.url, at: Date.now() });
    } else if (method === 'Network.responseReceived' && params.response && params.response.status >= 400) {
      mark(`HTTP ${params.response.status} ${params.response.url}`);
    } else if (method === 'Network.loadingFinished' && id) {
      pending.delete(id);
    } else if (method === 'Network.loadingFailed' && id) {
      const request = pending.get(id);
      pending.delete(id);
      mark(
        `request failed: ${params.errorText ?? 'unknown'}${params.canceled ? ' (canceled)' : ''} ${request?.url ?? ''}`
      );
    }
  };
  contents.on('console-message', onConsole);
  contents.on('render-process-gone', onGone);
  contents.on('did-fail-load', onFail);
  window.on('unresponsive', onUnresponsive);
  window.on('responsive', onResponsive);
  contents.debugger.on('message', onCdp);
  // A suite that attached the debugger itself keeps its session; then only Electron's events are recorded.
  if (!contents.debugger.isAttached()) {
    try {
      contents.debugger.attach('1.3');
      ownsDebugger = true;
      // A window that has never loaded a page may not answer until it navigates; do not wait for it then.
      const enabled = Promise.all([
        contents.debugger.sendCommand('Runtime.enable'),
        contents.debugger.sendCommand('Network.enable'),
      ]).catch((error: unknown) => mark(`CDP diagnostics unavailable: ${String(error)}`));
      await Promise.race([enabled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    } catch (error) {
      mark(`CDP diagnostics unavailable: ${(error as Error).message}`);
    }
  }

  const report = async () => {
    // webContents.executeJavaScript waits until loading stops, which may be what timed out. The frame does not.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state: unknown = await Promise.race([
      contents.mainFrame.executeJavaScript(pageStateScript).catch((error: unknown) => `unreadable: ${String(error)}`),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('unreadable: the page did not answer within 5s'), 5_000);
      }),
    ]);
    clearTimeout(timer);
    const now = Date.now();
    const waiting = [...pending.values()]
      .sort((a, b) => a.at - b.at)
      .slice(0, 15)
      .map((request) => `  ${request.url} (pending ${seconds(now - request.at)})`);
    return [
      `Page state after ${seconds(now - started)}: ${JSON.stringify(state)}`,
      `Loading: ${contents.isLoading()}, main frame loading: ${contents.isLoadingMainFrame()}, crashed: ${contents.isCrashed()}`,
      ownsDebugger
        ? `Pending requests (${pending.size}):`
        : 'Pending requests: not tracked, the suite owns the debugger',
      ...(ownsDebugger ? (waiting.length ? waiting : ['  (none)']) : []),
      'Page log:',
      ...(events.length ? events.slice(-40) : ['  (none)']),
    ].join('\n');
  };

  const stop = () => {
    if (contents.isDestroyed()) return;
    contents.off('console-message', onConsole);
    contents.off('render-process-gone', onGone);
    contents.off('did-fail-load', onFail);
    window.off('unresponsive', onUnresponsive);
    window.off('responsive', onResponsive);
    contents.debugger.off('message', onCdp);
    if (ownsDebugger && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  };

  return { mark, report, stop };
}
