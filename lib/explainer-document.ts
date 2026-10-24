import type { InteractiveExplainer } from './types';
import { EXPLAINER_MOTION_RUNTIME } from './explainer-motion';

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
:root { color-scheme: ${theme}; --paper: ${theme === 'dark' ? '#171a20' : '#fcfcfd'}; --ink: ${theme === 'dark' ? '#e3e7ef' : '#242a35'}; --muted: ${theme === 'dark' ? '#a2adbf' : '#626b7b'}; --line: ${theme === 'dark' ? '#354255' : '#cbd5e1'}; --accent: ${theme === 'dark' ? '#9bb8ff' : '#345fc1'}; }
* { box-sizing: border-box; } body { margin: 0; padding: 12px; background: var(--paper); color: var(--ink); font: 14px/1.4 system-ui, sans-serif; }
#root { display: flow-root; min-width: 0; }
svg { display: block; max-width: 100%; height: auto; } svg text { fill: var(--ink); }
button, input, select { font: inherit; accent-color: var(--accent); } button, select { background: var(--paper); color: var(--ink); border: 1px solid var(--line); padding: 6px 12px; border-radius: 4px; }
button { cursor: pointer; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; } p { max-width: 75ch; } .muted { color: var(--muted); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style></head><body><main id="root"></main><script nonce="${token}">const config = ${data};${EXPLAINER_MOTION_RUNTIME}${RUNTIME}</script></body></html>`;
}

const RUNTIME = String.raw`
(() => {
  const root = document.getElementById('root');
  const notify = (event, extra = {}) => parent.postMessage({type: 'gnosis-explainer', token: config.token, event, ...extra}, '*');
  let playing = false, raf = 0, last = 0, failed = false;
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let motion = null;
  const reduced = motionPreference.matches;
  const stop = () => { playing = false; cancelAnimationFrame(raf); motion?.pause(); notify('state', {playing: false}); };
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
  // Bound the drawings, not the HTML controls or captions. Older artifacts
  // often use width:100% on tall SVGs, scaling their text far beyond 100%.
  let fit = true, layoutFrame = 0, lastLayout = '';
  const tallDrawing = [...root.querySelectorAll('svg')].filter(svg => !svg.ownerSVGElement);
  // A single tall diagram with sibling controls/captions can use the width
  // of a desktop window instead of stacking everything above and below it.
  let stage = null, notes = null;
  if (tallDrawing.length === 1) {
    const svg = tallDrawing[0], box = svg.viewBox.baseVal, parent = svg.parentElement;
    if (box.width >= 200 && box.height / box.width > 0.55 && parent.children.length > 1) {
      stage = parent;
      notes = document.createElement('div');
      notes.setAttribute('aria-label', 'Scenario controls and current step');
      notes.setAttribute('data-explainer-notes', '');
      for (const child of [...stage.children]) if (child !== svg) notes.append(child);
      stage.append(notes);
      const layoutStyle = document.createElement('style');
      layoutStyle.textContent = '[data-explainer-notes] {min-width:0;overflow:auto;padding:2px 8px 8px 2px;} ' +
        '[data-explainer-notes] * {min-width:0!important;} ' +
        '[data-explainer-notes] p {font-size:13px!important;line-height:1.4!important;margin-block:8px!important;} ' +
        '[data-explainer-notes] label {font-size:13px!important;gap:4px!important;} ' +
        '[data-explainer-notes] select, [data-explainer-notes] button {font-size:13px!important;padding:6px!important;} ' +
        '[data-explainer-notes] strong {font-size:14px!important;}';
      document.head.append(layoutStyle);
      for (const child of notes.children) {
        if (child.querySelector('input, select, button')) {
          child.style.setProperty('display', 'grid', 'important');
          child.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
          child.style.setProperty('gap', '8px', 'important');
        }
      }
    }
  }
  function layout() {
    layoutFrame = 0;
    const sideBySide = fit && stage && innerWidth >= 700;
    if (stage) {
      stage.style.setProperty('display', sideBySide ? 'grid' : 'block', 'important');
      stage.style.setProperty('grid-template-columns', 'minmax(0, 1fr) 280px', 'important');
      stage.style.setProperty('gap', '16px', 'important');
      stage.style.setProperty('align-items', 'start', 'important');
      notes.style.maxHeight = sideBySide ? Math.max(180, innerHeight - 48) + 'px' : 'none';
    }
    const drawings = [...root.querySelectorAll('svg')].filter(svg =>
      !svg.ownerSVGElement && svg.viewBox.baseVal.width >= 200 && svg.viewBox.baseVal.height >= 100);
    if (!drawings.length) return;
    const sizes = drawings.map(svg => {
      const box = svg.viewBox.baseVal;
      const columnWidth = sideBySide && svg.parentElement === stage ? stage.clientWidth - 296 : svg.parentElement.clientWidth;
      const width = Math.min(box.width, columnWidth);
      svg.style.setProperty('width', width + 'px', 'important');
      svg.style.setProperty('max-width', '100%', 'important');
      svg.style.setProperty('height', 'auto', 'important');
      svg.style.setProperty('min-height', '0', 'important');
      svg.style.setProperty('display', 'block', 'important');
      svg.style.setProperty('margin-inline', 'auto', 'important');
      // The default preserves geometry when height is constrained.
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      return { svg, naturalHeight: width * box.height / box.width };
    });
    const used = sizes.reduce((sum, {svg}) => sum + svg.getBoundingClientRect().height, 0);
    const bodyStyle = getComputedStyle(document.body);
    const padding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
    const otherContent = sideBySide ? 24 : root.getBoundingClientRect().height - used;
    const available = Math.max(0, innerHeight - padding - otherContent - 2);
    const total = sizes.reduce((sum, item) => sum + item.naturalHeight, 0);
    for (const {svg, naturalHeight} of sizes) {
      // Very small windows retain scrolling rather than clipping controls or
      // making the drawing disappear. 100% is available for inspecting detail.
      const height = Math.min(naturalHeight, Math.max(120, available * naturalHeight / total));
      svg.style.setProperty('max-height', fit ? height + 'px' : 'none', 'important');
    }
    const layoutKey = innerWidth + ':' + innerHeight + ':' + fit;
    if (layoutKey !== lastLayout) { lastLayout = layoutKey; motion?.sync(); }
  }
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(layout);
  }
  new ResizeObserver(scheduleLayout).observe(root);
  new MutationObserver(scheduleLayout).observe(root, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['viewBox']});
  addEventListener('resize', scheduleLayout);
  root.addEventListener('input', scheduleLayout);
  root.addEventListener('change', scheduleLayout);
  motion = createExplainerMotion(root, motionPreference);
  root.addEventListener('input', () => motion.sync());
  root.addEventListener('change', () => motion.sync());
  function run(command) {
    try {
      if (command === 'fit' || command === 'actual-size') { fit = command === 'fit'; scheduleLayout(); }
      if (command === 'pause') stop();
      if (command === 'reset') { stop(); motion.update(() => api.reset(), false); }
      if (command === 'step') { stop(); motion.update(() => api.step()); }
      if (command === 'play') {
        if (playing) return;
        playing = true; motion.resume(); last = performance.now(); notify('state', {playing: true});
        const frame = now => {
          if (!playing) return;
          try { motion.update(() => api.tick(Math.min(now - last, 100))); last = now; raf = requestAnimationFrame(frame); }
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
    layout();
    motion.sync();
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
