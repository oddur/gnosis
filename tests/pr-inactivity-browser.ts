import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import { menuAction } from './entry-menu-helpers';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 180; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    if (/^(Unstar|Star) PR #/.test(label)) {
      return menuAction(js, `Actions for PR #${label.split('#')[1]}`, label);
    }
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width&&(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.getAttribute('title')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 60));
  };
  const dir = path.resolve('.impeccable/review/pr-inactivity');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const setDays = async (value: string) => {
    await js(
      `(()=>{const input=document.querySelector('[aria-label="PR inactivity limit in days"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await js('document.querySelector(\'[aria-label="PR inactivity limit in days"]\').blur()');
  };
  const closeSettings = async () => {
    await wait("!document.querySelector('.settings-save-status')?.textContent.includes('Saving')");
    await js("document.querySelector('[data-slot=dialog-close]').click()");
    await wait("!document.querySelector('.settings-tabs')");
  };
  try {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?pr-summary&inactivity`);
    await wait("document.querySelectorAll('.queue-item').length===6");
    assert.equal(
      await js('!!document.querySelector(\'[aria-label="Actions for PR #150"]\')'),
      false,
      'Inactive standalone PR starts hidden'
    );
    await js("document.querySelector('.queue-disclosure').click()");
    assert.equal(await js("document.querySelectorAll('.queue-member').length"), 3, 'Recent stack retains old members');
    await click('Filters');
    await wait("!!document.querySelector('.queue-inactivity-link')");
    assert.match(
      await js<string>("document.querySelector('.queue-inactivity-link').textContent"),
      /Active within 30 days/
    );
    await capture('filters');
    await js("document.querySelector('.queue-inactivity-link').click()");
    await wait('!!document.querySelector(\'[aria-label="PR inactivity limit in days"]\')');
    assert.equal(await js('document.querySelector(\'[aria-label="PR inactivity limit in days"]\').value'), '30');
    await capture('settings');
    await setDays('');
    await wait("!!document.querySelector('.pr-inactivity-setting [role=alert]')");
    assert.equal(await js('window.electronAPI.loadPreferences().then(p=>p.prInactivityDays)'), 30);
    await capture('invalid');
    await setDays('120');
    await wait('window.electronAPI.loadPreferences().then(p=>p.prInactivityDays===120)');
    await closeSettings();
    await waitForWorkbenchQueue(win.webContents);
    await click('Star PR #150');
    await click('Settings');
    await wait("!!document.querySelector('.pr-inactivity-setting')");
    await setDays('30');
    await wait('window.electronAPI.loadPreferences().then(p=>p.prInactivityDays===30)');
    await closeSettings();
    await wait("document.querySelectorAll('.queue-item').length===7");
    await click('Unstar PR #150');
    await wait("document.querySelectorAll('.queue-item').length===6");
    await click('Settings');
    await wait("!!document.querySelector('.pr-inactivity-setting')");
    await js("document.querySelector('.pr-inactivity-setting input[type=checkbox]').click()");
    await wait('window.electronAPI.loadPreferences().then(p=>p.prInactivityDays===0)');
    assert.equal(await js('document.querySelector(\'[aria-label="PR inactivity limit in days"]\').disabled'), true);
    await capture('never');
    await closeSettings();
    await wait("document.querySelectorAll('.queue-item').length===7");
    win.reload();
    await wait("document.querySelectorAll('.queue-item').length===7");
    await click('Settings');
    await wait("!!document.querySelector('.pr-inactivity-setting')");
    assert.equal(await js("document.querySelector('.pr-inactivity-setting input[type=checkbox]').checked"), true);
    await js("document.querySelector('.pr-inactivity-setting input[type=checkbox]').click()");
    await wait('window.electronAPI.loadPreferences().then(p=>p.prInactivityDays===30)');
    await js("document.documentElement.classList.add('dark')");
    await capture('dark');
    win.setSize(640, 800);
    await capture('narrow');
    assert.ok(await js('document.documentElement.scrollWidth <= window.innerWidth'));
    console.log('PR inactivity browser checks passed');
  } catch (error) {
    console.error(error);
    console.error(
      await js(
        "window.electronAPI.loadPreferences().then(p=>({saved:p.prInactivityDays,field:document.querySelector('[aria-label=\"PR inactivity limit in days\"]')?.value,text:document.querySelector('[role=dialog]')?.textContent}))"
      )
    );
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
