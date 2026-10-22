import type { InteractiveExplainer } from './types';

// The document has an opaque origin (sandbox="allow-scripts", never
// allow-same-origin). No Electron preload, network, forms, popups or frames.
// Electron also rejects subframe navigation, including location assignments.
export function buildExplainerDocument(
  artifact: InteractiveExplainer,
  token: string,
  theme: 'light' | 'dark' = 'light',
  validate = false
): string {
  const data = JSON.stringify({ artifact, token, theme, validate }).replace(/</g, '\\u003c');
  // A fresh nonce per mount. The caller supplies a UUID, never model output.
  if (!/^[a-zA-Z0-9-]+$/.test(token)) throw new Error('Invalid explainer token');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: ${theme}; --paper: ${theme === 'dark' ? '#211f1c' : '#faf8f3'}; --ink: ${theme === 'dark' ? '#e9e4da' : '#2a2824'}; --muted: ${theme === 'dark' ? '#b4ada0' : '#655e54'}; --line: ${theme === 'dark' ? '#514b42' : '#d6cfc2'}; --accent: ${theme === 'dark' ? '#d8a16c' : '#91522c'}; }
* { box-sizing: border-box; } body { margin: 0; padding: 24px; background: var(--paper); color: var(--ink); font: 15px/1.6 system-ui, sans-serif; }
svg { display: block; max-width: 100%; height: auto; } svg text { fill: var(--ink); }
button, input, select { font: inherit; accent-color: var(--accent); } button, select { background: var(--paper); color: var(--ink); border: 1px solid var(--line); padding: 6px 12px; border-radius: 4px; }
button { cursor: pointer; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; } p { max-width: 75ch; } .muted { color: var(--muted); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style></head><body><main id="root"></main><script nonce="${token}">const config = ${data};${RUNTIME}</script></body></html>`;
}

const RUNTIME = String.raw`
(() => {
  const root = document.getElementById('root');
  const notify = (event, extra = {}) => parent.postMessage({type: 'gnosis-explainer', token: config.token, event, ...extra}, '*');
  let playing = false, raf = 0, last = 0, failed = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stop = () => { playing = false; cancelAnimationFrame(raf); notify('state', {playing: false}); };
  const fail = message => { failed = true; stop(); notify('error', {message: String(message).slice(0, 500)}); };
  addEventListener('error', e => fail(e.message));
  addEventListener('unhandledrejection', e => fail(e.reason));
  // Parse inert markup, then copy only drawing and control elements. Scripts
  // come exclusively from the separate JS field; links stay inside the SVG.
  const allowed = new Set('div span p section header footer h1 h2 h3 h4 ul ol li dl dt dd strong em b i small code pre br hr label button input select option output details summary table thead tbody tr th td caption fieldset legend svg g path rect circle ellipse line polyline polygon text tspan defs marker clippath mask pattern lineargradient radialgradient stop title desc use'.split(' '));
  const template = document.createElement('template');
  template.innerHTML = config.artifact.html;
  function clean(node) {
    for (const el of [...node.children]) {
      if (!allowed.has(el.localName.toLowerCase())) { el.remove(); continue; }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        if (n.startsWith('on') || ['src', 'srcset', 'srcdoc', 'action', 'formaction', 'target', 'nonce', 'is'].includes(n) ||
            ((n === 'href' || n === 'xlink:href') && !attr.value.startsWith('#'))) el.removeAttribute(attr.name);
      }
      if (el.localName === 'input' && ['file', 'image', 'password'].includes(el.type)) el.remove();
      else clean(el);
    }
  }
  clean(template.content);
  root.append(template.content);
  const style = document.createElement('style'); style.textContent = config.artifact.css; document.head.append(style);
  const script = document.createElement('script'); script.nonce = config.token; script.textContent = config.artifact.javascript; document.body.append(script);
  const api = window.explainer;
  if (!api || ['reset', 'step', 'tick'].some(k => typeof api[k] !== 'function')) { fail('The explainer must provide reset, step, and tick functions.'); return; }
  function run(command) {
    try {
      if (command === 'pause') stop();
      if (command === 'reset') { stop(); api.reset(); }
      if (command === 'step') { stop(); api.step(); }
      if (command === 'play') {
        if (playing) return;
        playing = true; last = performance.now(); notify('state', {playing: true});
        const frame = now => {
          if (!playing) return;
          try { api.tick(Math.min(now - last, 100)); last = now; raf = requestAnimationFrame(frame); }
          catch (e) { fail(e.message); }
        };
        raf = requestAnimationFrame(frame);
      }
    } catch (e) { fail(e.message); }
  }
  addEventListener('message', e => {
    if (e.source !== parent || e.data?.type !== 'gnosis-explainer-control' || e.data.token !== config.token) return;
    run(e.data.command);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  try {
    api.reset();
    if (!root.querySelector('svg')) throw new Error('The explainer must include an SVG visualization.');
    if (config.validate) {
      api.step(); api.tick(50); api.reset();
      // Exercise a bounded selection of controls, including input extremes.
      const controls = [...root.querySelectorAll('button, input, select')].slice(0, 20);
      for (const control of controls) {
        if (control.disabled) continue;
        if (control.tagName === 'BUTTON') control.click();
        else if (control.tagName === 'SELECT') {
          for (const index of [0, control.options.length - 1]) { control.selectedIndex = index; control.dispatchEvent(new Event('change', {bubbles: true})); }
        } else if (control.type === 'range' || control.type === 'number') {
          for (const value of [control.min || '0', control.max || '100']) {
            control.value = value; control.dispatchEvent(new Event('input', {bubbles: true})); control.dispatchEvent(new Event('change', {bubbles: true}));
          }
        } else if (control.type === 'checkbox' || control.type === 'radio') control.click();
        api.step(); api.reset();
      }
      setTimeout(() => { if (!failed) notify('validated'); }, 200);
    } else if (!failed) notify('ready', {reducedMotion: reduced});
  } catch (e) { fail(e.message); }
})();`;
