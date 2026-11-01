import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 850,
    show: true,
    webPreferences: { backgroundThrottling: false, partition: `environment-${Date.now()}` },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error(`Timed out: ${code}\n${await js<string>('document.body.innerText')}`);
  };
  const click = (label: string, provider?: string) =>
    js(
      `(()=>{const root=${provider ? `document.querySelector('[data-environment-provider="${provider}"]')` : 'document'};const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing button');b.click()})()`
    );
  const fill = async (label: string, value: string) => {
    await js(
      `(()=>{const f=document.querySelector('input[aria-label=${JSON.stringify(label)}]');f.focus();f.select()})()`
    );
    await win.webContents.insertText(value);
    await wait(`document.querySelector('input[aria-label=${JSON.stringify(label)}]').value===${JSON.stringify(value)}`);
  };
  const capture = async (name: string) => {
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    const dir = path.resolve('.impeccable/review/harness-environment');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await loadWorkbenchPage(win, new URL('/tests/fixtures/harness-environment.html', process.env.GNOSIS_WORKBENCH_URL).href);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait('document.body.innerText.includes("No overrides")');
    await click('Add variable', 'claude');
    await fill('Claude variable 1 name', 'ANTHROPIC_BASE_URL');
    await fill('Claude variable 1 value', 'https://gateway.example.com');
    assert.equal(await js('document.querySelector(\'input[aria-label="Claude variable 1 value"]\').type'), 'password');
    await click('Show values', 'claude');
    assert.equal(await js('document.querySelector(\'input[aria-label="Claude variable 1 value"]\').type'), 'text');
    await click('Toggle settings');
    await click('Toggle settings');
    await wait('document.querySelector("input")?.value==="ANTHROPIC_BASE_URL"');
    assert.equal(await js('document.querySelector(\'input[aria-label="Claude variable 1 value"]\').type'), 'password');
    await click('Save Claude variables', 'claude');
    await wait('window.environmentFixture.saved.claude.length===1');
    await click('Add variable', 'codex');
    await fill('Codex variable 1 name', 'OPENAI_BASE_URL');
    await fill('Codex variable 1 value', '$HOME/literal');
    await js('window.environmentFixture.failSave=true');
    await click('Save Codex variables', 'codex');
    await wait('document.body.innerText.includes("Could not save")');
    assert.equal(await js('window.environmentFixture.saved.codex.length'), 0);
    assert.equal(
      await js('document.querySelector(\'input[aria-label="Codex variable 1 value"]\').value'),
      '$HOME/literal'
    );
    await js('window.environmentFixture.failSave=false');
    await click('Save Codex variables', 'codex');
    await wait('window.environmentFixture.saved.codex.length===1');
    assert.equal(await js('window.environmentFixture.saved.claude[0].name'), 'ANTHROPIC_BASE_URL');
    await capture('light');
    await click('Add variable', 'claude');
    await fill('Claude variable 2 name', 'ANTHROPIC_BASE_URL');
    await click('Save Claude variables', 'claude');
    await wait('document.body.innerText.includes("already in use")');
    await click('Remove Claude variable 2', 'claude');
    await fill('Claude variable 1 name', 'MAX_THINKING_TOKENS');
    await click('Save Claude variables', 'claude');
    await wait('document.body.innerText.includes("managed by Gnosis")');
    await fill('Claude variable 1 name', 'ANTHROPIC_BASE_URL');
    await click('Save Claude variables', 'claude');
    await wait('!document.querySelector("[role=alert]")');
    await js("document.documentElement.classList.add('dark')");
    win.setSize(460, 950);
    await capture('narrow-dark');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    await click('Remove Claude variable 1', 'claude');
    await click('Save Claude variables', 'claude');
    await wait('window.environmentFixture.saved.claude.length===0');
    await click('Toggle settings');
    await js('window.environmentFixture.failLoad=true');
    await click('Toggle settings');
    await wait('document.body.innerText.includes("Could not load")');
    await js('window.environmentFixture.failLoad=false');
    await click('Retry loading Claude variables', 'claude');
    await click('Retry loading Codex variables', 'codex');
    await wait('document.querySelectorAll("input").length===2');
    assert.equal(await js('Object.keys(localStorage).length'), 0, 'Values never enter localStorage');
    console.log('PASS: masks, draft retention, per-provider saves, validation, retry, removal, narrow/dark settings');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
