// Renders the browser store images for the "Open in Gnosis" extension into docs/store/images/:
//   screenshot-*.png   1280x800, the real extension on a synthetic GitHub-like page
//   promo-small-440x280.png, icon-*.png
//
//   npm run build:extension && npm run extension:store-assets
//
// It starts headless Chromium with the built extension (dist-extension/chrome) and serves the synthetic
// fixture (docs/store/fixture/github-page.html) for https://github.com/example-org/sample-app/... through
// the DevTools protocol. Every other request is blocked and DNS is disabled, so nothing leaves the machine
// and no real GitHub page or user data appears in the images.
//
// Needs Node 22 or later (global WebSocket) and a Chromium that can load unpacked extensions: set
// CHROMIUM_PATH, or install one with `npx playwright install chromium` (the script finds it there).
// Branded Google Chrome ignores --load-extension and does not work.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(repoRoot, 'dist-extension/chrome');
const fixture = readFileSync(path.join(repoRoot, 'docs/store/fixture/github-page.html'));
const outDir = path.join(repoRoot, 'docs/store/images');
const iconSource = path.join(repoRoot, 'Icon/web/icon-512.png');
const REPO_URL = 'https://github.com/example-org/sample-app';

const { WebSocket } = globalThis;
if (typeof WebSocket !== 'function') throw new Error('Node 22 or later is needed (global WebSocket).');
if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
  throw new Error('Build the extension first: npm run build:extension');
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const caches = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
  ];
  const binaries = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
  ];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const builds = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const binary of binaries) {
        const candidate = path.join(cache, build, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('No Chromium found. Set CHROMIUM_PATH or run: npx playwright install chromium');
}

/** A minimal DevTools protocol client over the browser WebSocket, with flattened target sessions. */
class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = [];

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#socket.addEventListener('open', resolve, { once: true });
      cdp.#socket.addEventListener('error', reject, { once: true });
    });
    cdp.#socket.addEventListener('message', (event) => cdp.#onMessage(JSON.parse(String(event.data))));
    return cdp;
  }

  #onMessage(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending?.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  on(listener) {
    this.#listeners.push(listener);
  }

  close() {
    this.#socket.close();
  }
}

async function launch() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'gnosis-store-assets-'));
  const child = spawn(
    findChromium(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // No DNS: requests the fixture server does not answer fail instead of reaching the network.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--window-size=1280,800',
    ],
    { stdio: 'ignore' }
  );
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await delay(100);
  if (!existsSync(portFile)) throw new Error('Chromium did not start.');
  const [port, browserPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${browserPath}`);
  return {
    cdp,
    async close() {
      cdp.close();
      child.kill();
      await delay(300);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function openPage(cdp, { width, height, scale = 1, dark = false, transparent = false }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);

  cdp.on((message) => {
    if (message.sessionId !== sessionId || message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    if (request.url.startsWith(`${REPO_URL}/`)) {
      void send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: fixture.toString('base64'),
      });
    } else {
      void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  return {
    evaluate,
    async goto(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        if ((await evaluate('document.readyState').catch(() => '')) === 'complete') break;
        await delay(50);
      }
      await evaluate('document.fonts.ready.then(() => true)');
    },
    async setContent(html) {
      const { frameTree } = await send('Page.getFrameTree');
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      await evaluate(
        'Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)'
      );
    },
    async waitFor(expression, what) {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${what}`);
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
}

const BUTTON = `document.querySelector('[data-gnosis-open]')?.shadowRoot?.querySelector('.open')`;
const HINT = `document.querySelector('[data-gnosis-open]')?.shadowRoot?.querySelector('.hint')`;

/** Captures the synthetic GitHub page with the extension's button. The image is 1280x800 device pixels. */
async function capturePage(cdp, { url, dark = false, hint = false }) {
  // 1024x640 CSS pixels at 1.25x: the GitHub page at a readable size inside the framed screenshot.
  const page = await openPage(cdp, { width: 1024, height: 640, scale: 1.25, dark });
  await page.goto(url);
  await page.waitFor(`Boolean(${BUTTON})`, 'the Open in Gnosis button (is the extension loaded?)');
  if (hint) {
    // A real click: the link goes nowhere in headless Chromium, the page keeps focus, and the extension
    // shows its "Gnosis didn't open" hint after 1.5 seconds.
    await page.evaluate(`${BUTTON}.click(), true`);
    await page.waitFor(`${HINT} && !${HINT}.hidden`, 'the "Gnosis didn\'t open" hint');
    await page.evaluate(`${BUTTON}.blur(), true`);
  }
  await delay(200);
  const image = await page.screenshot();
  await page.close();
  return image;
}

const iconDataUrl = `data:image/png;base64,${readFileSync(iconSource).toString('base64')}`;

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;

function frameHtml(caption, shot, dark) {
  const shotUrl = `data:image/png;base64,${shot.toString('base64')}`;
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { font-family: ${FONT}; background: ${dark ? '#0b0d12' : '#eef1f5'}; color: ${dark ? '#f0f3f7' : '#14171c'};
      display: flex; flex-direction: column; align-items: center; }
    header { display: flex; align-items: center; gap: 14px; height: 112px; }
    header img { width: 44px; height: 44px; border-radius: 50%; box-shadow: 0 0 0 1.5px ${dark ? '#3d444d' : 'transparent'}; }
    h1 { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
    .shot { width: 1100px; height: 688px; border-radius: 12px 12px 0 0; overflow: hidden;
      box-shadow: 0 0 0 1px ${dark ? '#2a2f38' : '#d4d9e0'}, 0 20px 50px ${dark ? '#00000080' : '#1b223026'}; }
    .shot img { display: block; width: 1100px; height: auto; }
  </style></head><body>
    <header><img src="${iconDataUrl}" alt=""><h1>${caption}</h1></header>
    <div class="shot"><img src="${shotUrl}" alt=""></div>
  </body></html>`;
}

function promoHtml() {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
    body { font-family: ${FONT}; background: #eef1f5; color: #14171c; display: flex; flex-direction: column;
      justify-content: center; padding: 0 36px; box-sizing: border-box; }
    .row { display: flex; align-items: center; gap: 16px; }
    img { width: 72px; height: 72px; }
    h1 { margin: 0; font-size: 34px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.1; }
    p { margin: 20px 0 0; font-size: 19px; line-height: 1.35; color: #4b5563; }
  </style></head><body>
    <div class="row"><img src="${iconDataUrl}" alt=""><h1>Open in<br>Gnosis</h1></div>
    <p>Open GitHub pull requests in the Gnosis review app.</p>
  </body></html>`;
}

function iconHtml(size, padding) {
  const art = size - padding * 2;
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
    img { display: block; margin: ${padding}px; width: ${art}px; height: ${art}px; }
  </style></head><body><img src="${iconDataUrl}" alt=""></body></html>`;
}

async function renderHtml(cdp, html, { width, height, transparent = false }) {
  const page = await openPage(cdp, { width, height, transparent });
  await page.goto('about:blank');
  await page.setContent(html);
  const image = await page.screenshot();
  await page.close();
  return image;
}

const screenshots = [
  {
    file: 'screenshot-1-pull-request-light.png',
    caption: 'Open any pull request in Gnosis with one click',
    url: `${REPO_URL}/pull/42`,
  },
  {
    file: 'screenshot-2-files-dark.png',
    caption: 'Opens on the same tab, file or thread',
    url: `${REPO_URL}/pull/42/files`,
    dark: true,
  },
  {
    file: 'screenshot-3-compare.png',
    caption: 'Also on commit and compare pages',
    url: `${REPO_URL}/compare/main...docs-sync`,
  },
  {
    file: 'screenshot-4-not-installed.png',
    caption: 'No Gnosis yet? A small hint links to the download',
    url: `${REPO_URL}/pull/42`,
    hint: true,
  },
];

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  try {
    for (const shot of screenshots) {
      const page = await capturePage(browser.cdp, shot);
      const framed = await renderHtml(browser.cdp, frameHtml(shot.caption, page, shot.dark), {
        width: 1280,
        height: 800,
      });
      writeFileSync(path.join(outDir, shot.file), framed);
      console.log(`docs/store/images/${shot.file}`);
    }
    writeFileSync(
      path.join(outDir, 'promo-small-440x280.png'),
      await renderHtml(browser.cdp, promoHtml(), { width: 440, height: 280 })
    );
    console.log('docs/store/images/promo-small-440x280.png');
    // Chrome Web Store: 128x128 with the artwork at 96x96 and 16 px of transparent padding.
    // Edge Add-ons logo: 300x300. AMO and the browsers use the manifest icons (48 and 96 for Firefox).
    for (const [file, size, padding] of [
      ['icon-128-store.png', 128, 16],
      ['icon-300-edge.png', 300, 0],
      ['icon-96.png', 96, 0],
      ['icon-48.png', 48, 0],
    ]) {
      writeFileSync(
        path.join(outDir, file),
        await renderHtml(browser.cdp, iconHtml(size, padding), { width: size, height: size, transparent: true })
      );
      console.log(`docs/store/images/${file}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
