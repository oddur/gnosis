import type { IllustrationRender } from '../lib/illustration-review';
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

/** Validate every authored SVG frame in an isolated renderer at the inline pane size. */
export async function validateSvgIllustrationInBrowser(
  illustration: import('../lib/svg-illustration').SvgIllustration,
  signal?: AbortSignal
): Promise<IllustrationRender> {
  const { buildSvgIllustrationDocument } = await import('../lib/svg-illustration-document');
  signal?.throwIfAborted();
  const token = randomUUID();
  const window = new BrowserWindow({
    show: false,
    width: 500,
    height: 650,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `illustration-${token}`,
    },
  });
  protectExplainerFrames(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('data:') && !details.url.startsWith('about:') })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL('data:text/html,<html><body></body></html>');
        const html = buildSvgIllustrationDocument(illustration, token);
        const issues: unknown = await window.webContents.executeJavaScript(`new Promise(resolve=>{
          document.body.style='margin:0';
          const frame=document.createElement('iframe');frame.id='illustration';frame.setAttribute('sandbox','allow-scripts');frame.style='width:440px;height:300px;border:0';
          let theme=0;
          const send=(command,extra={})=>frame.contentWindow.postMessage({type:'gnosis-illustration-control',token:${JSON.stringify(token)},command,...extra},'*');
          addEventListener('message',event=>{
            if(event.source!==frame.contentWindow||event.data?.token!==${JSON.stringify(token)})return;
            const d=event.data;
            if(d.event==='error')resolve([d.message]);
            if(d.event==='ready'){frame.style.height=Math.min(480,440*d.height/d.width)+'px';send('validate');}
            if(d.event==='validated'){
              if(d.issues.length||theme++)resolve(d.issues);
              else{send('theme',{dark:true});send('validate');}
            }
          });
          frame.srcdoc=${JSON.stringify(html)};document.body.append(frame);
        })`);
        if (!Array.isArray(issues) || issues.length)
          throw new Error(
            'SVG illustration validation: ' +
              (Array.isArray(issues) ? issues.slice(0, 12).join('; ') : 'No validation result')
          );
        return await captureIllustrationSheets(window, illustration, token, signal);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SVG illustration rendering timed out')), 60000);
        abort = () => reject(new Error('Illustration generation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Capture every authored state plus every transition midpoint at the real inline size. */
async function captureIllustrationSheets(
  window: BrowserWindow,
  illustration: import('../lib/svg-illustration').SvgIllustration,
  token: string,
  signal?: AbortSignal
): Promise<IllustrationRender> {
  const tiles: { label: string; png: string; height: number }[] = [];
  const height = (await window.webContents.executeJavaScript(
    "Math.ceil(document.getElementById('illustration').getBoundingClientRect().height)"
  )) as number;
  for (const [scenario, value] of illustration.scenarios.entries()) {
    for (const [index, frame] of value.frames.entries()) {
      for (const transition of index > 0 ? [true, false] : [false]) {
        signal?.throwIfAborted();
        await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
          const frame=document.getElementById('illustration');
          const receive=event=>{
            if(event.source!==frame.contentWindow||event.data?.token!==${JSON.stringify(token)})return;
            if(event.data.event==='captured'){removeEventListener('message',receive);resolve();}
            if(event.data.event==='error'){removeEventListener('message',receive);reject(Error(event.data.message));}
          };
          addEventListener('message',receive);
          frame.contentWindow.postMessage({type:'gnosis-illustration-control',token:${JSON.stringify(token)},command:'theme',dark:false},'*');
          frame.contentWindow.postMessage(${JSON.stringify({ type: 'gnosis-illustration-control', token, command: 'capture', scenario, index, transition })},'*');
        })`);
        const screenshot = await window.webContents.capturePage({ x: 0, y: 0, width: 440, height });
        tiles.push({
          label: `Scenario ${scenario + 1}: ${value.title} · ${transition ? `Transition ${index} → ${index + 1} (midpoint)` : `Frame ${index + 1}: ${frame.title}`}`,
          png: screenshot.toDataURL(),
          height,
        });
      }
    }
  }
  const images: IllustrationRender['images'] = [];
  // Six full-size tiles per image keep text readable for multimodal providers.
  for (let offset = 0; offset < tiles.length; offset += 6) {
    signal?.throwIfAborted();
    const page = tiles.slice(offset, offset + 6);
    const pageHeight = Math.ceil(page.length / 2) * (height + 64);
    window.setContentSize(880, pageHeight);
    await window.webContents.executeJavaScript(`(async()=>{
      document.body.replaceChildren();document.body.style='margin:0;background:white;display:grid;grid-template-columns:440px 440px;color:#242a35;font:13px system-ui';
      for(const tile of ${JSON.stringify(page)}){
        const cell=document.createElement('div');cell.style='height:'+(tile.height+64)+'px';
        const label=document.createElement('div');label.textContent=tile.label;label.style='height:64px;padding:8px;box-sizing:border-box';
        const image=document.createElement('img');image.width=440;image.height=tile.height;image.src=tile.png;
        cell.append(label,image);document.body.append(cell);await image.decode();
      }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    })()`);
    const png = (await window.webContents.capturePage({ x: 0, y: 0, width: 880, height: pageHeight })).toPNG();
    if (png.length > 5_000_000) throw new Error('Illustration contact sheet exceeds image size limit');
    images.push({ mediaType: 'image/png', base64: png.toString('base64') });
  }
  return { images };
}
