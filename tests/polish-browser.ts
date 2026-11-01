import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (text: string) =>
    js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click()})()`
    );
  const key = async (value: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: value });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: value });
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const fill = (value: string) =>
    js(
      `(()=>{const e=document.querySelector('.command-palette input[role=combobox]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
    );
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(
      path.join(os.tmpdir(), `gnosis-polish-${name}.png`),
      (await win.webContents.capturePage()).toPNG()
    );
  };
  const openPalette = async () => {
    await js(
      "document.querySelector('.review-toolbar button').focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))"
    );
    await wait("document.activeElement?.getAttribute('role')==='combobox'");
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url);
    win.webContents.setZoomFactor(1);
    await waitForWorkbenchQueue(win.webContents);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await click('Open AI explanation');
    await wait("!!document.querySelector('.workbench-overview')");
    await click('Continue review');
    await wait("!!document.querySelector('.review-narrative')");
    assert.ok(await js(`Array.from(document.querySelectorAll('.file-path-link')).every(el=>el.getBoundingClientRect().height>=24)`), 'File links have a 24px pointer target');
    const topic = await js("document.querySelector('.review-narrative h1,.review-narrative h2')?.textContent");
    await openPalette();
    await capture('commands-light');
    await js("document.documentElement.classList.add('dark')");
    await capture('commands-dark');
    const first = await js("document.querySelector('.command-palette input[role=combobox]').getAttribute('aria-activedescendant')");
    await key('Down');
    assert.notEqual(await js("document.querySelector('.command-palette input[role=combobox]').getAttribute('aria-activedescendant')"), first);
    await js(
      "document.querySelector('.command-palette input[role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))"
    );
    assert.ok(await js("!!document.querySelector('.command-palette')"), 'IME Enter must not execute a command');
    for (let i = 0; i < 4; i++) {
      await key('Tab');
      assert.ok(await js("!!document.activeElement.closest('[role=dialog]')"), 'Tab stays inside the palette');
    }
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await key('Escape');
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await key('Escape');
    await wait("!document.querySelector('[role=dialog]')");
    assert.ok(
      await js("document.activeElement===document.querySelector('.review-toolbar button')"),
      'Closing restores the opener'
    );
    await openPalette();
    await fill('zzzzzzzzzzzzzzzz');
    await wait("document.querySelector('.command-palette')?.textContent.includes('No local matches')");
    assert.equal(await js("document.querySelector('.command-palette input[role=combobox]').hasAttribute('aria-activedescendant')"), false);
    await fill('settings');
    await key('Enter');
    await wait("!!document.querySelector('.settings-tabs')");
    assert.equal(await js("document.querySelectorAll('[role=dialog][data-state=open]').length"), 1);
    await js("document.querySelector('[data-slot=dialog-close]').focus()");
    await key('r');
    assert.equal(
      await js("document.querySelector('.review-narrative h1,.review-narrative h2')?.textContent"),
      topic,
      'Dialog keys cannot mark a topic reviewed or advance'
    );
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await key('Escape');
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await key('Escape');
    await wait("!document.querySelector('[role=dialog]')");
    await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}))");
    await wait("!!document.querySelector('.shortcut-dialog')");
    await capture('shortcuts-dark');
    await key('Right');
    assert.equal(await js("document.querySelector('.review-narrative h1,.review-narrative h2')?.textContent"), topic);
    win.setSize(900, 680);
    win.webContents.setZoomFactor(2);
    await capture('shortcuts-zoom');
    assert.ok(
      await js(
        `(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1})()`
      )
    );
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await key('Escape');
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await key('Escape');
    await wait("!document.querySelector('[role=dialog]')");
    await openPalette();
    await capture('commands-zoom');
    assert.ok(
      await js(
        `(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1})()`
      )
    );
    if (await js("!!document.querySelector('[role=tooltip]')")) {
      await key('Escape');
      await wait("!document.querySelector('[role=tooltip]')");
    }
    await key('Escape');
    await wait("!document.querySelector('[role=dialog]')");
    await click('Diff appearance');
    await wait("!!document.querySelector('[role=dialog]')");
    await capture('appearance-zoom');
    assert.ok(
      await js(
        `(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0&&d.scrollWidth<=d.clientWidth+1})()`
      )
    );
    await key('Escape');
    win.webContents.setZoomFactor(1);
    // Emulate the OS preference in Chromium and verify useful feedback is retained.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await js(
      "document.querySelector('.review-narrative').classList.add('slide-enter');document.querySelector('.review-narrative h1,.review-narrative h2').classList.add('check-highlight')"
    );
    assert.equal(await js("getComputedStyle(document.querySelector('.review-narrative')).animationName"), 'none');
    assert.equal(await js("getComputedStyle(document.querySelector('.check-highlight'),'::after').opacity"), '1');
    await capture('reduced-motion');
    win.webContents.debugger.detach();
    console.log(
      'Polish checks passed: palette keyboard/IME/focus, modal shortcut isolation, zoomed dialogs/popover, reduced-motion feedback.'
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure');
    win.webContents.setZoomFactor(1);
    win.destroy();
    app.exit(1);
  }
});
