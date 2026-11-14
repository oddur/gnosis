/**
 * The menu bar panel (#308) in a 360-pt window: the five states in light and dark, keyboard navigation and
 * opening, the opaque fill without vibrancy, reduced motion, and truncation. Screenshots go to
 * .impeccable/review/menubar/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const STATES = ['default', 'clear', 'loading', 'signed-out', 'offline'] as const;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 360,
    height: 560,
    show: true,
    resizable: true,
    webPreferences: { backgroundThrottling: false, partition: `menubar-${Date.now()}` },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const cdp = win.webContents.debugger;
  const media = (features: { name: string; value: string }[]) => cdp.sendCommand('Emulation.setEmulatedMedia', { features });
  const key = async (keyName: string, options: { code?: string; keyCode?: number; text?: string; meta?: boolean } = {}) => {
    const modifiers = options.meta ? 4 : 0;
    const base = { key: keyName, code: options.code ?? keyName, windowsVirtualKeyCode: options.keyCode ?? 0, modifiers };
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: options.text ? 'keyDown' : 'rawKeyDown', ...base, ...(options.text ? { text: options.text } : {}) });
    await cdp.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const calls = () => js<[string, ...unknown[]][]>('JSON.parse(JSON.stringify(window.menubarCalls))');
  const lastCall = async () => (await calls()).filter(([name]) => name !== 'resize').at(-1);
  const active = () => js<string | null>('document.activeElement?.dataset.rowId ?? null');
  const fit = async () => {
    // The panel window takes the height the view reports, as main does with setContentSize.
    const resize = (await calls()).filter(([name]) => name === 'resize').at(-1);
    win.setContentSize(360, Math.min(560, Math.ceil(Number(resize?.[1] ?? 560))));
    await new Promise((r) => setTimeout(r, 120));
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await fit();
    const dir = path.resolve('.impeccable/review/menubar');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, new URL('/tests/fixtures/menubar.html', process.env.GNOSIS_WORKBENCH_URL).href);
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait('document.querySelectorAll(".menubar-row").length === 8');

    // Light and dark follow the system appearance, never an app theme class.
    for (const scheme of ['light', 'dark'] as const) {
      await media([{ name: 'prefers-color-scheme', value: scheme }]);
      await wait(`document.documentElement.classList.contains('dark') === ${scheme === 'dark'}`);
      for (const state of STATES) {
        await js(`window.showMenubarState(${JSON.stringify(state)})`);
        await wait(`document.querySelector('.menubar-title') && ${state === 'loading' ? '!!document.querySelector(".menubar-skeleton")' : '!document.querySelector(".menubar-skeleton")'}`);
        await capture(`${state}-${scheme}`);
      }
    }
    await media([{ name: 'prefers-color-scheme', value: 'light' }]);
    await js('window.showMenubarState("default")');
    await wait('document.querySelectorAll(".menubar-row").length === 8');

    // The window fits the content: all clear is short, the full list is capped at 560 and scrolls.
    await js('window.showMenubarState("clear")');
    await fit();
    const clearHeight = win.getContentSize()[1];
    assert.ok(clearHeight < 250, `All clear fits its content (${clearHeight})`);
    await js('window.showMenubarState("default")');
    await fit();
    assert.equal(win.getContentSize()[1], 560);
    assert.equal(await js('(()=>{const b=document.querySelector(".menubar-body");return b.scrollHeight>b.clientHeight})()'), true, 'The list scrolls between the fixed header and footer');
    assert.equal(await js('document.querySelector(".menubar-footer").getBoundingClientRect().bottom <= innerHeight'), true);

    // Header, groups and accessible structure.
    assert.equal(await js('document.querySelector(".menubar-title").textContent'), '3 need you · 7 ready');
    assert.equal(await js('document.querySelector(".menubar-state-line").textContent'), 'Updated 1 min ago');
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-group-label > span:first-child")].map(e=>e.textContent)'), ['To review', 'To fix', 'Ready', 'In progress']);
    assert.equal(await js('document.querySelectorAll("[role=menu],[role=menuitem]").length'), 0, 'A list of buttons, not a menu');
    assert.equal(await js('[...document.querySelectorAll("section.menubar-group")].every(s=>document.getElementById(s.getAttribute("aria-labelledby")))'), true);
    assert.equal(await js('document.querySelector(".menubar-more").textContent'), '2 more in Gnosis');
    // Every status has visible text, not only an icon; icons are hidden from screen readers.
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-detail")].every(e=>e.innerText.trim().length>0)'), true);
    assert.match(await js<string>('document.querySelector("[data-row-id=pr407] .menubar-row-detail").textContent'), /Changes requested · Checks failed/);
    assert.match(await js<string>('document.querySelector("[data-row-id=pr91] .menubar-row-detail").textContent'), /Ready to merge · checked 3 min ago/);
    assert.match(await js<string>('document.querySelector("[data-row-id=pr388] .menubar-row-detail").textContent'), /^Stack · 3 PRs · jon/);
    assert.equal(await js('[...document.querySelectorAll(".menubar-row svg")].every(svg=>svg.getAttribute("aria-hidden")==="true")'), true);
    // The new dot has an accessible name.
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-row-dot[data-new]")].map(d=>d.textContent)'), ['New', 'New', 'New']);
    assert.match(await js<string>('document.querySelector("[data-row-id=pr412]").textContent'), /^New/);

    // Long titles truncate without growing the panel.
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js('(()=>{const t=document.querySelector("[data-row-id=pr407] .menubar-row-title");return t.scrollWidth>t.clientWidth})()'), true);
    assert.equal(await js('new Set([...document.querySelectorAll(".menubar-row")].map(r=>Math.round(r.getBoundingClientRect().height))).size'), 1, 'Rows keep one height');

    // On open the list takes focus with the first row current; one Tab stop for the list.
    await js('window.fireMenubarShown()');
    assert.equal(await active(), 'pr412');
    assert.equal(await js('document.querySelectorAll(".menubar-row[tabindex=\'0\']").length'), 1);
    // Arrows and j/k move across groups; Home and End jump.
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr388');
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr407', 'Down from the last review row enters To fix');
    await key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
    assert.equal(await active(), 'pr91');
    await key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
    assert.equal(await active(), 'pr407');
    await key('End', { keyCode: 35 });
    assert.equal(await active(), 'pr392');
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr392', 'The last row stays current');
    await key('Home', { keyCode: 36 });
    assert.equal(await active(), 'pr412');
    await key('ArrowDown', { keyCode: 40 });
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await js('document.activeElement.matches(":focus-visible")'), true, 'The ring shows with keyboard use');
    // Enter opens the current row by id; the renderer never sends a target.
    await key('Enter', { keyCode: 13, text: '\r' });
    assert.deepEqual(await lastCall(), ['open', 'pr407']);
    await key('Escape', { keyCode: 27 });
    assert.deepEqual(await lastCall(), ['close']);
    await key('o', { code: 'KeyO', keyCode: 79, meta: true });
    assert.deepEqual(await lastCall(), ['openApp']);
    await key(',', { code: 'Comma', keyCode: 188, meta: true });
    assert.deepEqual(await lastCall(), ['openSettings']);
    await key('r', { code: 'KeyR', keyCode: 82, meta: true });
    assert.deepEqual(await lastCall(), ['refresh']);
    await wait('document.querySelector("[aria-label=Refresh]").disabled');
    const refreshes = (await calls()).filter(([name]) => name === 'refresh').length;
    await key('r', { code: 'KeyR', keyCode: 82, meta: true });
    assert.equal((await calls()).filter(([name]) => name === 'refresh').length, refreshes, 'Refresh waits 10 s after the last one');
    // A click opens too.
    await js('document.querySelector("[data-row-id=pr399]").click()');
    assert.deepEqual(await lastCall(), ['open', 'pr399']);
    assert.equal((await calls()).some(([name, value]) => name === 'open' && typeof value !== 'string'), false);

    // States: all clear with the queue size; signed out offers Connect GitHub; offline keeps rows marked old.
    await js('window.showMenubarState("clear")');
    await wait('document.querySelector(".menubar-title").textContent === "All clear"');
    assert.match(await js<string>('document.querySelector(".menubar-clear").textContent'), /Nothing needs you\. 14 open PRs in your queue\./);
    await js('window.showMenubarState("signed-out")');
    await wait('document.querySelector(".menubar-title").textContent === "Not connected to GitHub"');
    assert.equal(await js('!!document.querySelector("[aria-label=Refresh]")'), false);
    await js('[...document.querySelectorAll("button")].find(b=>b.textContent==="Connect GitHub").click()');
    assert.deepEqual(await lastCall(), ['openApp']);
    await js('window.showMenubarState("offline")');
    await wait('document.querySelector(".menubar-state-line")?.textContent.startsWith("Offline")');
    assert.equal(await js('document.querySelectorAll(".menubar-row").length'), 8, 'Rows stay while offline');
    await js('window.showMenubarState("paused")');
    await wait('/GitHub updates paused until/.test(document.querySelector(".menubar-state-line")?.textContent)');
    await js('window.showMenubarState("error")');
    await wait('/Could not reach GitHub · Retry/.test(document.querySelector(".menubar-state-line")?.textContent)');

    // The opaque fill without vibrancy (the browser suite has none), and under reduced transparency.
    const fill = () => js<string>('getComputedStyle(document.querySelector(".menubar")).backgroundColor');
    assert.equal(await fill(), 'rgb(255, 255, 255)');
    await media([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await wait('document.documentElement.classList.contains("dark")');
    assert.equal(await fill(), 'rgb(34, 39, 49)');
    await js('document.documentElement.dataset.vibrancy=""');
    assert.notEqual(await fill(), 'rgb(34, 39, 49)', 'Over vibrancy the fill is translucent');
    await media([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-transparency', value: 'reduce' }]);
    await wait('getComputedStyle(document.querySelector(".menubar")).backgroundColor === "rgb(34, 39, 49)"');
    await js('delete document.documentElement.dataset.vibrancy');

    // No animation under reduced motion.
    await js('window.showMenubarState("loading")');
    await wait('!!document.querySelector(".menubar-skeleton-row span")');
    assert.notEqual(await js('getComputedStyle(document.querySelector(".menubar-skeleton-row span")).animationName'), 'none');
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await wait('getComputedStyle(document.querySelector(".menubar-skeleton-row span")).animationName === "none"');

    console.log('PASS: menu bar panel states in light and dark, groups, keyboard, open by id, opaque fill, reduced motion, truncation');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
