/**
 * The menu bar panel (#308) in a 360-pt window: every state in light and dark, keyboard navigation and
 * opening, the opaque fill without vibrancy, reduced motion, and truncation. Screenshots go to
 * .impeccable/review/menubar/.
 */
import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const STATES = ['default', 'clear', 'loading', 'signed-out', 'offline', 'paused', 'error'] as const;

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
    await wait('document.querySelectorAll(".menubar-row").length === 15');

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
    await wait('document.querySelectorAll(".menubar-row").length === 15');

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

    // Header: the new count is the number on the icon, marked with the same dot as new rows.
    assert.equal(await js('document.querySelector(".menubar-title").textContent'), '15 need you · 9 new · 20 ready');
    assert.equal(await js('document.querySelector(".menubar-title .menubar-summary-new").textContent'), '9 new');
    assert.equal(await js('getComputedStyle(document.querySelector(".menubar-summary-dot")).backgroundColor === getComputedStyle(document.querySelector(".menubar-row-dot[data-new]")).backgroundColor'), true);
    assert.equal(await js('document.querySelector(".menubar-state-line").textContent'), 'Updated 1 min ago');
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-group-label > span:first-child")].map(e=>e.textContent)'), ['To review', 'To fix', 'Ready', 'In progress']);
    assert.equal(await js('document.querySelectorAll("[role=menu],[role=menuitem]").length'), 0, 'A list of buttons, not a menu');
    assert.equal(await js('[...document.querySelectorAll("section.menubar-group")].every(s=>document.getElementById(s.getAttribute("aria-labelledby")))'), true);
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-more")].map(e=>e.textContent)'), ['1 more in Gnosis', '4 more in Gnosis', '15 more in Gnosis']);
    // Every row has visible text under its title; icons are hidden from screen readers.
    const detail = (id: string) => js<string>(`document.querySelector("[data-row-id=${id}] .menubar-row-detail").textContent`);
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-detail")].every(e=>e.innerText.trim().length>0)'), true);
    assert.equal(await js('[...document.querySelectorAll(".menubar-row svg")].every(svg=>svg.getAttribute("aria-hidden")==="true")'), true);
    // The reason leads. The group's own kind is not repeated: no "Review requested" under To review, no
    // "Ready to merge" under Ready, and no eye icon on a plain review request.
    assert.equal(await detail('pr36144'), 'Changes requested · Checks failed\u00a0· seed #36144');
    assert.equal(await detail('pr377'), 'seed-launcher #377 · zsolt');
    assert.equal(await detail('pr36172'), 'Explanation ready\u00a0· #36172');
    assert.equal(await detail('pr91'), 'seed-web #91 · checked 3 min ago');
    assert.equal(await detail('pr399'), 'Explanation ready\u00a0· seed #399');
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-detail")].some(e=>/Review requested|Ready to merge/.test(e.textContent))'), false);
    assert.equal(await js('!!document.querySelector("[data-row-id=pr377] svg") || !!document.querySelector("[data-row-id=pr36170] svg")'), false);
    assert.equal(await js('!!document.querySelector("[data-row-id=pr36171] svg") && !!document.querySelector("[data-row-id=pr36144] svg")'), true);
    // A stack shows once, above its rows, which keep only their number.
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-stack-line")].map(e=>e.textContent)'), ['Stack · 9 PRs · ivaremilsson', 'Stack · 4 PRs']);
    assert.deepEqual(await js('[...document.querySelectorAll(".menubar-stack")].map(s=>[...s.querySelectorAll(".menubar-row")].map(r=>r.dataset.rowId))'), [['pr36170', 'pr36171', 'pr36172', 'pr36173'], ['pr36175', 'pr36176']]);
    assert.equal(await detail('pr36170'), '#36170');
    assert.equal(await detail('pr36171'), 'Updated since your review\u00a0· #36171');
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-detail")].some(e=>/Stack/.test(e.textContent))'), false);
    assert.equal(await js('[...document.querySelectorAll(".menubar-stack > ul")].every(u=>document.getElementById(u.getAttribute("aria-labelledby")))'), true);
    // The new dot has an accessible name; no "Open ↵" hint.
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-dot[data-new]")].every(d=>d.textContent==="New")'), true);
    assert.equal(await js('document.querySelectorAll(".menubar-row-dot[data-new]").length'), 6);
    assert.match(await js<string>('document.querySelector("[data-row-id=pr377]").textContent'), /^New/);
    assert.equal(await js('/Open ↵/.test(document.body.textContent)'), false);

    // Long titles truncate without growing the panel; the reason never does, and leads the line.
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await js('(()=>{const t=document.querySelector("[data-row-id=pr36144] .menubar-row-title");return t.scrollWidth>t.clientWidth})()'), true);
    assert.equal(await js('[...document.querySelectorAll(".menubar-row-reason")].every(r=>r.scrollWidth<=r.clientWidth && r.getBoundingClientRect().left===r.parentElement.getBoundingClientRect().left)'), true, 'Reasons are whole and first');
    assert.equal(await js('new Set([...document.querySelectorAll(".menubar-row")].map(r=>Math.round(r.getBoundingClientRect().height))).size'), 1, 'Rows keep one height');
    // One left edge for titles, the stack line and "N more"; one for the header, group labels and footer.
    const lefts = (selector: string) => js<number[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(e=>{const r=document.createRange();r.selectNodeContents(e);return Math.round(r.getBoundingClientRect().left)})`);
    assert.deepEqual([...new Set([...(await lefts('.menubar-row-title')), ...(await lefts('.menubar-stack-line > span')), ...(await lefts('.menubar-more'))])], [44]);
    assert.deepEqual([...new Set([...(await lefts('.menubar-title')), ...(await lefts('.menubar-group-label > span:first-child')), ...(await lefts('.menubar-footer-button > span'))])], [20]);

    // On open the list takes focus with the first row current; one Tab stop for the list.
    const selected = () => js<string[]>('[...document.querySelectorAll(".menubar-row")].filter(r=>getComputedStyle(r).backgroundColor!=="rgba(0, 0, 0, 0)").map(r=>r.dataset.rowId)');
    await js('window.fireMenubarShown()');
    assert.equal(await active(), 'pr377');
    assert.deepEqual(await selected(), ['pr377']);
    assert.equal(await js('document.querySelectorAll(".menubar-row[tabindex=\'0\']").length'), 1);
    // Arrows and j/k move across groups and stacks; Home and End jump.
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr36170', 'Down enters the stack');
    await key('End', { keyCode: 35 });
    assert.equal(await active(), 'pr392');
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr392', 'The last row stays current');
    await key('Home', { keyCode: 36 });
    assert.equal(await active(), 'pr377');
    for (let i = 0; i < 5; i++) await key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
    assert.equal(await active(), 'pr36160', 'Down from the last review row enters To fix');
    await key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
    assert.equal(await active(), 'pr36173');
    assert.equal(await js('document.activeElement.matches(":focus-visible")'), true, 'The ring shows with keyboard use');
    // The pointer moves the same selection: after keyboard use, hovering another row leaves exactly one active row.
    const point = async (id: string) => {
      const [x, y] = await js<[number, number]>(`(()=>{const r=document.querySelector("[data-row-id=${id}]");r.scrollIntoView({block:"nearest"});const b=r.getBoundingClientRect();return [b.left+b.width/2,b.top+b.height/2]})()`);
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 2, y });
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await new Promise((r) => setTimeout(r, 50));
    };
    await point('pr36144');
    assert.equal(await active(), 'pr36144', 'Hover selects');
    assert.deepEqual(await selected(), ['pr36144'], 'One active row while hovering after keyboard navigation');
    await capture('selected-light');
    // The keyboard carries on from the hovered row; the still pointer does not keep a second highlight.
    await key('ArrowDown', { keyCode: 40 });
    assert.equal(await active(), 'pr36175');
    assert.deepEqual(await selected(), ['pr36175']);
    assert.equal(await js('document.querySelectorAll(".menubar-row[tabindex=\'0\']").length'), 1);
    // Enter opens the current row by id; the renderer never sends a target.
    await key('Enter', { keyCode: 13, text: '\r' });
    assert.deepEqual(await lastCall(), ['open', 'pr36175']);
    await point('pr36160');
    await key('Enter', { keyCode: 13, text: '\r' });
    assert.deepEqual(await lastCall(), ['open', 'pr36160'], 'Enter opens the hovered row');
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
    assert.match(await js<string>('document.querySelector(".menubar-clear").textContent'), /Nothing needs you\. 41 open PRs in your queue\./);
    await js('window.showMenubarState("signed-out")');
    await wait('document.querySelector(".menubar-title").textContent === "Not connected to GitHub"');
    assert.equal(await js('!!document.querySelector("[aria-label=Refresh]")'), false);
    await js('[...document.querySelectorAll("button")].find(b=>b.textContent==="Connect GitHub").click()');
    assert.deepEqual(await lastCall(), ['openApp']);
    await js('window.showMenubarState("offline")');
    await wait('document.querySelector(".menubar-state-line")?.textContent.startsWith("Offline")');
    assert.equal(await js('document.querySelectorAll(".menubar-row").length'), 15, 'Rows stay while offline');
    await js('window.showMenubarState("paused")');
    await wait('/GitHub updates paused until/.test(document.querySelector(".menubar-state-line")?.textContent)');
    await js('window.showMenubarState("error")');
    await wait('/Could not reach GitHub · Retry/.test(document.querySelector(".menubar-state-line")?.textContent)');

    // The first open: a quiet footer tip names the keys and the icon's right-click menu, until it is dismissed
    // or a row is opened. Its line stays until the panel next opens, so the footer never moves under the pointer.
    const hint = () => js<{ text: string; visible: boolean } | null>('(()=>{const h=document.querySelector(".menubar-hint");return h&&{text:h.querySelector("[aria-hidden=true]").textContent,visible:getComputedStyle(h).visibility==="visible"}})()');
    const footerHeight = () => js<number>('document.querySelector(".menubar-footer").offsetHeight');
    const firstOpen = async () => {
      await js('window.resetMenubarHint(); window.showMenubarState("first-open")');
      await wait('!!document.querySelector(".menubar-hint")');
      await js('window.fireMenubarShown()');
      await wait('document.activeElement?.dataset.rowId === "pr377"');
    };
    await js('window.showMenubarState("default")');
    await wait('!document.querySelector(".menubar-hint")');
    const plainFooter = await footerHeight();
    await firstOpen();
    assert.deepEqual(await hint(), { text: '↑↓ move · ↵ open · right-click the icon to quit', visible: true });
    assert.equal(await js('document.querySelector(".menubar-hint").getAttribute("role")'), 'note');
    assert.equal(await js('document.querySelector(".menubar-hint").getAttribute("aria-label")'), 'Tip');
    assert.match(await js<string>('document.querySelector(".menubar-hint .sr-only").textContent'), /arrow keys to move and Return to open a PR\. Right-click the menu bar icon to quit Gnosis\./);
    assert.equal(await js('!!document.querySelector(".menubar-footer [aria-label=\'Dismiss tip\']")'), true);
    assert.equal(await js('(()=>{const t=document.querySelector(".menubar-hint-text");return t.scrollWidth<=t.clientWidth})()'), true, 'The tip fits one line');
    assert.deepEqual(await lefts('.menubar-hint-text > span[aria-hidden]'), [20], 'The tip sits on the footer text edge');
    assert.equal(await js('Math.round(document.querySelector(".menubar-hint-dismiss svg").getBoundingClientRect().right) === Math.round(document.querySelector(".menubar-footer-button kbd").getBoundingClientRect().right)'), true, 'Its close icon lines up with ⌘O');
    const hintFooter = await footerHeight();
    assert.ok(hintFooter > plainFooter, 'The tip adds one footer line');
    for (const scheme of ['light', 'dark'] as const) {
      await media([{ name: 'prefers-color-scheme', value: scheme }]);
      await wait(`document.documentElement.classList.contains('dark') === ${scheme === 'dark'}`);
      await capture(`first-open-${scheme}`);
    }
    await media([{ name: 'prefers-color-scheme', value: 'light' }]);
    await wait('!document.documentElement.classList.contains("dark")');
    // Keyboard: Tab reaches the close button after the list; Return dismisses and focus goes back to the list.
    for (let i = 0; i < 10 && !(await js('document.activeElement?.classList.contains("menubar-hint-dismiss")')); i++) await key('Tab', { keyCode: 9 });
    assert.equal(await js('document.activeElement?.getAttribute("aria-label")'), 'Dismiss tip');
    await capture('first-open-focus-light');
    const resizes = async () => (await calls()).filter(([name]) => name === 'resize').length;
    const resizesBefore = await resizes();
    await key('Enter', { keyCode: 13, text: '\r' });
    assert.deepEqual(await lastCall(), ['dismissHint']);
    await wait('getComputedStyle(document.querySelector(".menubar-hint")).visibility === "hidden"');
    assert.equal(await footerHeight(), hintFooter, 'No jump: the line stays while the panel is open');
    const heights = (await calls()).filter(([name]) => name === 'resize').map(([, height]) => height);
    assert.equal(new Set(heights.slice(resizesBefore - 1)).size, 1, 'The window keeps its height');
    assert.equal(await active(), 'pr377', 'Focus returns to the current row');
    await js('window.fireMenubarShown()');
    await wait('!document.querySelector(".menubar-hint")');
    assert.equal(await footerHeight(), plainFooter, 'The next open has no tip');
    // A click dismisses too.
    await firstOpen();
    await js('document.querySelector(".menubar-hint-dismiss").click()');
    assert.deepEqual(await lastCall(), ['dismissHint']);
    await wait('getComputedStyle(document.querySelector(".menubar-hint")).visibility === "hidden"');
    await js('window.fireMenubarShown()');
    await wait('!document.querySelector(".menubar-hint")');
    // Opening a row is a successful use: the tip is done, without a dismissal.
    await firstOpen();
    await key('Enter', { keyCode: 13, text: '\r' });
    assert.deepEqual(await lastCall(), ['open', 'pr377']);
    await wait('getComputedStyle(document.querySelector(".menubar-hint")).visibility === "hidden"');
    await js('window.fireMenubarShown()');
    await wait('!document.querySelector(".menubar-hint")');
    assert.equal((await calls()).filter(([name]) => name === 'dismissHint').length, 2);
    await js('window.showMenubarState("default")');

    // The opaque fill without vibrancy (the browser suite has none), and under reduced transparency.
    const fill = () => js<string>('getComputedStyle(document.querySelector(".menubar")).backgroundColor');
    assert.equal(await fill(), 'rgb(255, 255, 255)');
    // macOS and Windows CI desktops prefer reduced transparency and motion; state each preference explicitly.
    const settled = [
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ];
    await media([{ name: 'prefers-color-scheme', value: 'dark' }, ...settled]);
    await wait('document.documentElement.classList.contains("dark")');
    assert.equal(await fill(), 'rgb(34, 39, 49)');
    await js('document.documentElement.dataset.vibrancy=""');
    assert.notEqual(await fill(), 'rgb(34, 39, 49)', 'Over vibrancy the fill is translucent');
    await media([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-transparency', value: 'reduce' }]);
    await wait('getComputedStyle(document.querySelector(".menubar")).backgroundColor === "rgb(34, 39, 49)"');
    await js('delete document.documentElement.dataset.vibrancy');

    // No animation under reduced motion.
    await media([{ name: 'prefers-color-scheme', value: 'dark' }, ...settled]);
    await js('window.showMenubarState("loading")');
    await wait('!!document.querySelector(".menubar-skeleton-row span")');
    assert.notEqual(await js('getComputedStyle(document.querySelector(".menubar-skeleton-row span")).animationName'), 'none');
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await wait('getComputedStyle(document.querySelector(".menubar-skeleton-row span")).animationName === "none"');

    console.log('PASS: menu bar panel states in light and dark, groups, keyboard, open by id, first-open tip, opaque fill, reduced motion, truncation');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
