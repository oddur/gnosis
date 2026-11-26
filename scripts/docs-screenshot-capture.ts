// The Electron side of scripts/capture-docs-screenshots.mjs: opens each recipe's fixture page in a fresh window, in
// both themes, drives it to its scene, waits until the scene has rendered and stopped moving, and saves a PNG of the
// page content (no window chrome) at device scale factor 2. The host resizes the PNGs and writes the WebP files.
//
// Input (environment): GNOSIS_DOCS_RECIPES (JSON array of recipes), GNOSIS_DOCS_FIXTURES (the fixtures folder on the
// dev server), GNOSIS_DOCS_OUT (a folder for the PNGs and results.json).
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkbenchPage, waitSettled } from '../tests/workbench-ready';
import {
  DEFAULT_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  THEMES,
  fixtureUrl,
  parseCondition,
  parseStep,
  type Condition,
  type Recipe,
} from './docs-screenshot-recipes.mjs';
import { scenes, type Scene as SceneFunction, type SceneContext } from './docs-screenshot-steps';

type Theme = (typeof THEMES)[number];
interface CaptureResult {
  name: string;
  theme: Theme;
  png?: string;
  error?: string;
}

const recipes = JSON.parse(process.env.GNOSIS_DOCS_RECIPES ?? '[]') as Recipe[];
const fixtures = process.env.GNOSIS_DOCS_FIXTURES ?? '';
const out = process.env.GNOSIS_DOCS_OUT ?? '';
// The workbench fixture reports platform 'darwin' (tests/fixtures/workbench.tsx), so the app reads Cmd as Mod.
const mod = 'Meta';
const stepTimeoutMs = 20_000;
// A whole capture: the page load (up to 90s with its retry), the steps and the settle wait. Past this the capture is
// recorded as failed with the stage it was in, and the next scene starts, so one hung call cannot stall the run.
const captureTimeoutMs = 180_000;

/** Resolves with the promise, or rejects after ms naming what was being waited for. */
function within<T>(promise: Promise<T>, ms: number, what: string | (() => string)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${typeof what === 'function' ? what() : what} did not finish within ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Page helpers: deep (shadow DOM) queries, visibility, text matching and a pointer-like press. */
const helpers = `window.__docs ??= (() => {
  const all = (selector, root = document) => root ? [...root.querySelectorAll(selector), ...[...root.querySelectorAll('*')].filter(e => e.shadowRoot).flatMap(e => all(selector, e.shadowRoot))] : [];
  const visible = (e) => !!e && e.isConnected && e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const clickable = 'button,a,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=treeitem],[role=link],[role=switch],[role=checkbox],[role=radio],summary,label,input,select';
  const label = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent].map(t => (t ?? '').replace(/\\s+/g, ' ').trim());
  const byText = (text) => {
    const candidates = all(clickable).filter(visible);
    return candidates.find(e => label(e).some(t => t === text)) ?? candidates.find(e => label(e)[2].startsWith(text));
  };
  const hasText = (text) => all('body *').some(e => visible(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.replace(/\\s+/g, ' ').includes(text)));
  const point = (e) => {
    if (!e) throw new Error('nothing to click');
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    return { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  };
  // As the suites click: mousedown first (many controls act on it), then click().
  const press = (e) => { const at = point(e); e.dispatchEvent(new MouseEvent('mousedown', at)); e.dispatchEvent(new MouseEvent('mouseup', at)); e.click(); };
  const doubleClick = (e) => { const at = point(e); e.dispatchEvent(new MouseEvent('dblclick', { ...at, detail: 2 })); };
  // The app menu and Base UI menus open on pointerdown alone; a click after it would close them again.
  const pointerDown = (e) => { const at = point(e); e.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true })); };
  // A signature of what is on screen: when it stops changing between frames, the layout has settled.
  const signature = () => {
    const parts = [document.querySelectorAll('*').length, document.body.scrollHeight];
    let count = 0;
    for (const e of all('body *')) {
      if (++count > 4000) break;
      const r = e.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      parts.push(Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height));
    }
    parts.push(document.body.innerText.length);
    return parts.join(',');
  };
  // Images the screenshot shows that have not loaded: visible and inside the viewport. A lazy image below the fold
  // never loads, and it is not in the picture.
  const pendingImages = () => [...document.images].filter(i => !i.complete && visible(i) && (() => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; })()).map(i => i.currentSrc || i.src);
  return { all, visible, byText, hasText, press, doubleClick, pointerDown, signature, pendingImages };
})(); true`;

/** A condition as a page expression that is true when it holds. */
function conditionExpression(condition: Condition): string {
  switch (condition.kind) {
    case 'selector':
      return `window.__docs.all(${JSON.stringify(condition.selector)}).some(window.__docs.visible)`;
    case 'text':
      return `window.__docs.hasText(${JSON.stringify(condition.text)})`;
    case 'gone':
      return `!window.__docs.all(${JSON.stringify(condition.selector)}).some(window.__docs.visible)`;
    case 'js':
      return `Boolean(${condition.expression})`;
    case 'settled':
      throw new Error('settled conditions use waitSettled');
  }
}

/** KeyboardEvent.code for the keys recipes press. */
function keyCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  const named: Record<string, string> = { '?': 'Slash', '/': 'Slash', ',': 'Comma', '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '+': 'Equal', '=': 'Equal', ' ': 'Space', Space: 'Space' };
  return named[key] ?? key;
}

/** What a capture is doing now, so a capture that times out says where it stopped. */
interface Progress {
  stage: string;
  window?: BrowserWindow;
}

async function capture(recipe: Recipe, theme: Theme, progress: Progress): Promise<string> {
  const started = Date.now();
  const stage = (name: string) => {
    progress.stage = name;
    console.log(`  ${recipe.name} (${theme}) +${((Date.now() - started) / 1000).toFixed(1)}s ${name}`);
  };
  const viewport = recipe.viewport ?? DEFAULT_VIEWPORT;
  // A fresh profile state per capture: saved tabs, views and drafts from one scene must not leak into the next.
  stage('clearing storage');
  await within(
    session.defaultSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'] }),
    stepTimeoutMs,
    'clearing storage'
  );
  stage('opening the window');
  const window = new BrowserWindow({
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    show: true,
    backgroundColor: theme === 'dark' ? '#000000' : '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  progress.window = window;
  const contents = window.webContents;
  const errors: string[] = [];
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message.slice(0, 300));
  });
  const js = <T = unknown>(code: string) =>
    contents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(`${code.slice(0, 200)}: ${String(error)}`);
    }) as Promise<T>;
  const until = async (expression: string, what: string, timeoutMs = stepTimeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await js(`(()=>{${helpers};try{return Boolean(${expression})}catch{return false}})()`)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const page = await js<string>(`document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0,400) : ''`).catch(() => '');
    throw new Error(`${what} did not hold within ${timeoutMs / 1000}s. Page text: "${page}"${errors.length ? `. Console errors: ${errors.slice(-3).join(' | ')}` : ''}`);
  };
  const waitFor = async (condition: Condition, what: string) => {
    if (condition.kind === 'settled') await waitSettled(contents, condition.key, stepTimeoutMs);
    else await until(conditionExpression(condition), what);
  };
  const press = async (key: string, modifiers: string[]) => {
    const keys = modifiers.map((m) => (m === 'Mod' ? mod : m));
    // A letter reads as the browser reports it: upper case with Shift, lower case without.
    const letter = /^[a-z]$/i.test(key) ? (keys.includes('Shift') ? key.toUpperCase() : key.toLowerCase()) : key;
    const init = JSON.stringify({
      key: letter,
      code: keyCode(key),
      metaKey: keys.includes('Meta'),
      ctrlKey: keys.includes('Control'),
      shiftKey: keys.includes('Shift') || key === '?',
      altKey: keys.includes('Alt'),
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    // Dispatched to the focused element, as tests/polish-browser.ts does, so the app's window and element key handlers
    // see the key whatever the runner's keyboard layout is.
    await js(`(()=>{const t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',${init}));t.dispatchEvent(new KeyboardEvent('keyup',${init}));true})()`);
  };
  const step = async (source: string) => {
    const parsed = parseStep(source);
    await js(helpers);
    switch (parsed.type) {
      case 'click':
      case 'dblclick':
      case 'pointerdown': {
        const target = parsed.target;
        const find =
          target.kind === 'text'
            ? `window.__docs.byText(${JSON.stringify(target.text)})`
            : `window.__docs.all(${JSON.stringify(target.selector)}).find(window.__docs.visible)`;
        await until(find, `"${parsed.raw}": the element to click`);
        const action = parsed.type === 'click' ? 'press' : parsed.type === 'dblclick' ? 'doubleClick' : 'pointerDown';
        await js(`window.__docs.${action}(${find}); true`);
        return;
      }
      case 'js':
        // Awaited, so a step may return a promise; its value is ignored.
        await js(`(async()=>{await (${parsed.expression});return true})()`);
        return;
      case 'wait':
        return waitFor(parsed.condition, `"${parsed.raw}"`);
      case 'key':
        return press(parsed.key, parsed.modifiers);
      case 'scroll':
        await until(`window.__docs.all(${JSON.stringify(parsed.selector)}).find(window.__docs.visible)`, `"${parsed.raw}": the element to scroll to`);
        await js(`window.__docs.all(${JSON.stringify(parsed.selector)}).find(window.__docs.visible).scrollIntoView({block:'center'}); true`);
        return;
      case 'type':
        await contents.insertText(parsed.text);
        return;
    }
  };

  try {
    // A window that has never loaded a page does not answer CDP commands until it navigates (tests/workbench-ready.ts),
    // so the emulation below hung on every scene. A blank page first; the emulation then holds across the fixture load.
    stage('opening a blank page');
    await within(window.loadURL('about:blank'), stepTimeoutMs, 'loading about:blank');
    stage('emulating the theme and viewport');
    contents.debugger.attach('1.3');
    const cdp = (method: string, params: Record<string, unknown>) => within(contents.debugger.sendCommand(method, params), stepTimeoutMs, method);
    // Both themes are set the way the app sets them: the fixture reads ?theme= into the theme preference and applies
    // it (lib/theme.ts); fixtures that follow the system appearance, such as the menu bar panel, see the emulated
    // prefers-color-scheme. Reduced motion keeps transitions out of the captures.
    await cdp('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      mobile: false,
    });
    stage('loading the fixture');
    const url = fixtureUrl(fixtures, recipe.fixture ?? '', theme);
    // loadWorkbenchPage's render check reads #root, which a dialog-only fixture leaves empty (its dialog is a portal).
    // Those fixtures load as their suites load them; the recipe's own wait steps show they rendered.
    if ((recipe.fixture ?? '').startsWith('workbench.html')) await loadWorkbenchPage(window, url);
    else await within(window.loadURL(url), 60_000, `loading ${recipe.fixture}`);
    await until(`innerWidth===${viewport.width} && innerHeight===${viewport.height}`, `the ${viewport.width}×${viewport.height} viewport`);
    await contents.insertCSS(
      '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important}'
    );
    await js(helpers);
    for (const source of recipe.steps ?? []) {
      stage(`step ${source}`);
      await step(source);
    }
    if (recipe.scene) {
      stage(`scene ${recipe.scene}`);
      const scene = scenes[recipe.scene] as SceneFunction | undefined;
      if (!scene) throw new Error(`scripts/docs-screenshot-steps.ts has no scene "${recipe.scene}"`);
      const context: SceneContext = { recipe: recipe.name, theme, js, step, until };
      await scene(context);
    }
    stage(`waiting for ${recipe.ready ?? ''}`);
    const ready = parseCondition(recipe.ready ?? '');
    await waitFor(ready, `the scene's ready condition "${recipe.ready ?? ''}"`).catch((error: unknown) => {
      throw new Error(`the scene did not render: ${(error as Error).message}`);
    });
    // The theme the page shows must be the one asked for.
    const dark = await js<boolean>(`document.documentElement.classList.contains('dark')`);
    if (dark !== (theme === 'dark')) throw new Error(`the page did not show the ${theme} theme`);
    stage('waiting for fonts and images');
    await within(js(`document.fonts.ready.then(()=>true)`), stepTimeoutMs, 'document.fonts.ready');
    await until(`window.__docs.pendingImages().length===0`, 'images to finish loading').catch(async (error: unknown) => {
      const pending = await js<string[]>(`window.__docs.pendingImages().map(s=>s.slice(0,120))`).catch(() => []);
      throw new Error(`${(error as Error).message}. Still loading: ${pending.slice(0, 5).join(', ') || 'none'}`);
    });
    // Settled: the on-screen layout is the same five times in a row, 50ms apart, and no animation runs. A timer, not
    // requestAnimationFrame: a window the runner's desktop hides may get no frames, and this wait must still end.
    stage('waiting for the layout to settle');
    await within(
      js(
        `new Promise((resolve,reject)=>{let last='',same=0;const end=performance.now()+${stepTimeoutMs};const tick=()=>{const now=window.__docs.signature();const moving=document.getAnimations().some(a=>a.playState==='running');same=now===last&&!moving?same+1:0;last=now;if(same>=5)return resolve(true);if(performance.now()>end)return reject(new Error('the layout kept changing for ${stepTimeoutMs / 1000}s'));setTimeout(tick,50)};setTimeout(tick,50)})`
      ),
      stepTimeoutMs + 5_000,
      'the settle wait'
    );
    // The page content only, without window chrome, at the emulated device scale factor.
    stage('taking the screenshot');
    const shot = (await within(
      contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }),
      stepTimeoutMs,
      'Page.captureScreenshot'
    )) as { data: string };
    const file = path.join(out, `${recipe.name}-${theme}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  } finally {
    if (!window.isDestroyed()) {
      if (contents.debugger.isAttached()) contents.debugger.detach();
      window.destroy();
    }
  }
}

// The captures open and destroy one window at a time; between two of them there is no window, and the app must stay.
app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  console.log(`Electron ready: ${recipes.length} recipe(s)`);
  const results: CaptureResult[] = [];
  for (const recipe of recipes) {
    if (recipe.placeholder) continue;
    for (const theme of THEMES) {
      const started = Date.now();
      const progress: Progress = { stage: 'starting' };
      try {
        const png = await within(capture(recipe, theme, progress), captureTimeoutMs, () => `the capture (stopped while ${progress.stage})`).catch((error: unknown) => {
          // The timed-out capture may still hold its window; close it so the next scene starts clean.
          if (progress.window && !progress.window.isDestroyed()) progress.window.destroy();
          throw error;
        });
        results.push({ name: recipe.name, theme, png });
        console.log(`captured ${recipe.name} (${theme}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: recipe.name, theme, error: message });
        console.error(`FAILED ${recipe.name} (${theme}): ${message}`);
      }
      fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  app.exit(results.some((result) => result.error) ? 1 : 0);
});
