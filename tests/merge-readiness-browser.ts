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
    for (let i = 0; i < 200; i++) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width && (b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));b.click()})()`
    );
    await new Promise((r) => setTimeout(r, 50));
  };
  const shots = path.resolve('.impeccable/review/merge-readiness');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    if (process.platform === 'darwin') app.show();
    win.show();
    win.focus();
    await js('document.fonts.ready');
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadURL(`${process.env.GNOSIS_WORKBENCH_URL}?pr-summary`);
    await wait("document.querySelectorAll('.queue-item').length===7");
    await js(`(()=>{
      const signals=window.electronAPI.getQueueSignals, status=window.electronAPI.getPrStatus;
      window.mode='behind';window.forceReads=0;window.failStatus=false;
      window.electronAPI.getQueueSignals=async(requests,options)=>{
        const result=await signals(requests,options);
        return result.map(s=>({...s,readiness:{...s.readiness,mergeState:window.mode==='conflicts'?'DIRTY':window.mode==='behind'?'BEHIND':'CLEAN',mergeable:window.mode==='conflicts'?'CONFLICTING':'MERGEABLE',behindBy:3}}));
      };
      window.electronAPI.getPrStatus=async(url,force)=>{if(force)window.forceReads++;if(window.failStatus)throw Error('Network unavailable');return status(url,force)};
    })()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('Update required to merge')");
    await wait("!document.querySelector('.pr-merge-status button').disabled");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto main, or merge main/
    );
    assert.equal(
      await js("document.querySelector('.pr-merge-detail a').getAttribute('href')"),
      'https://github.com/klang/engine/pull/150'
    );
    await capture('desktop-update-required');
    for (const tab of ['Changes', 'Commits', 'Explanation', 'Summary']) {
      await click(tab);
      assert.match(
        await js<string>("document.querySelector('.pr-merge-status').textContent"),
        /Update required to merge/
      );
    }
    win.setSize(640, 800);
    await capture('narrow-update-required');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
    win.setSize(1280, 800);
    await js("document.documentElement.classList.add('dark')");
    await capture('dark-update-required');
    await js("document.documentElement.classList.remove('dark');window.mode='conflicts'");
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Merge conflicts') && !document.querySelector('.pr-merge-status button').disabled"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /resolve the conflicts/);
    await capture('conflicts');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Ready to merge') && !document.querySelector('.pr-merge-status button').disabled"
    );
    assert.match(await js<string>("document.querySelector('.pr-merge-detail').textContent"), /updating is optional/);
    await capture('optional-update');
    await js('window.failStatus=true;const realNow=Date.now;Date.now=()=>realNow()+6*60*1000;void 0');
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Readiness out of date') && !document.querySelector('.pr-merge-status button').disabled"
    );
    assert.equal(await js("!!document.querySelector('.pr-merge-status .is-success')"), false);
    await capture('stale');
    await js("window.failStatus=false;window.mode='behind'");
    await click('Refresh status');
    await wait(
      "document.querySelector('.pr-merge-status')?.textContent.includes('Update required to merge') && !document.querySelector('.pr-merge-status button').disabled"
    );
    assert.ok((await js<number>('window.forceReads')) >= 4);
    await click('Work queue');
    await wait(
      "[...document.querySelectorAll('.queue-item')].find(e=>e.textContent.includes('Fix reconnect'))?.textContent.includes('Update required to merge')"
    );
    await capture('queue');
    await js("document.querySelector('.queue-item:has(.queue-disclosure) .queue-row-main').click()");
    await click('Author description');
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('Stack has merge blockers')");
    await js("[...document.querySelectorAll('.pr-stack-nav button')].find(b=>b.textContent.includes('#121')).click()");
    assert.match(
      await js<string>("document.querySelector('.pr-merge-detail').textContent"),
      /Rebase onto queue-0, or merge queue-0/
    );
    await capture('stack');
    await js("window.mode='clean'");
    await click('Refresh status');
    await wait("document.querySelector('.pr-merge-status')?.textContent.includes('Next: #120 ready to merge')");
    await capture('stack-next');
    console.log(
      'Merge readiness browser checks passed: queue, persistent header, required/optional updates, conflicts, stale status, refresh, stack bases, narrow and dark views.'
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await capture('failure');
  } finally {
    win.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
});
