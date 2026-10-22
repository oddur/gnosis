import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { buildExplainerDocument } from '../lib/explainer-document';
import type { InteractiveExplainer } from '../lib/types';

/** Generated subframes must never navigate out of their srcdoc sandbox. */
export function protectExplainerFrames(window: BrowserWindow): void {
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && event.url !== 'about:srcdoc' && event.url !== 'about:blank') event.preventDefault();
  });
}

/** Run in a separate renderer, with no preload, Node, network, or app session. */
export async function validateExplainerInBrowser(artifact: InteractiveExplainer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Explainer generation cancelled.');
  const token = randomUUID();
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `explainer-${token}` },
  });
  protectExplainerFrames(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:') && !details.url.startsWith('about:') });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      (async () => {
        await window.loadURL('data:text/html,<html><body></body></html>');
        const document = buildExplainerDocument(artifact, token, 'light', true);
        const result: unknown = await window.webContents.executeJavaScript(`new Promise(resolve => {
          addEventListener('message', event => {
            if (event.source !== frame.contentWindow || event.data?.token !== ${JSON.stringify(token)}) return;
            if (event.data.event === 'validated') resolve(null);
            if (event.data.event === 'error') resolve(event.data.message);
          });
          const frame = document.createElement('iframe');
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.style = 'width:100%;height:740px;border:0';
          frame.srcdoc = ${JSON.stringify(document)};
          document.body.append(frame);
        })`);
        if (result !== null) throw new Error(typeof result === 'string' ? result : 'Invalid validation result.');
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The explainer did not finish its browser checks within 10 seconds.')),
          10000
        );
        onAbort = () => reject(new Error('Explainer generation cancelled.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (!window.isDestroyed()) window.destroy();
  }
}
