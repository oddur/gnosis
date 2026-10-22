import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
import { buildExplainerDocument } from '../lib/explainer-document';
import { explainer } from './fixtures/explainer';

export async function testExplainerMotion() {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    window.webContents.debugger.attach('1.3');
    const sessions = new Map<string, string>();
    async function reducedMotion(value: string) {
      const params = { features: [{ name: 'prefers-reduced-motion', value }] };
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', params);
      // The opaque-origin iframe has its own Chromium target. Emulating only
      // the parent does not change its media preference.
      const { targetInfos } = (await window.webContents.debugger.sendCommand('Target.getTargets')) as {
        targetInfos: { type: string; targetId: string }[];
      };
      for (const target of targetInfos.filter((t) => t.type === 'iframe')) {
        let session = sessions.get(target.targetId);
        if (!session) {
          const result = (await window.webContents.debugger.sendCommand('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          })) as { sessionId: string };
          session = result.sessionId;
          sessions.set(target.targetId, session);
        }
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', params, session);
      }
    }
    await window.loadURL('data:text/html,<body style="margin:0"></body>');
    await reducedMotion('no-preference');
    const artifact = {
      ...explainer,
      html: '<svg viewBox="0 0 900 320"><g id="drawing"></g></svg>',
      css: 'text {font-size:14px}',
      javascript: `let state = 0, elapsed = 0;
const draw = () => document.getElementById('drawing').innerHTML = state === 2 ? '' :
  '<g data-motion-id="' + (state === 3 ? 'new-item' : 'request-1') + '" transform="translate(' + (state === 1 ? 260 : 40) + ', 80)"><rect width="80" height="40" fill="var(--accent)"/><text y="70">Request</text></g>';
window.explainer = {reset() {state=0;elapsed=0;draw();}, step() {state=Math.min(state+1,3);draw();}, tick(ms) {elapsed+=ms;if(elapsed>=1200){elapsed=0;this.step();}}};`,
    };
    async function load(html: string) {
      await window.webContents.executeJavaScript(`new Promise(resolve => {
        document.body.innerHTML = '';
        const frame = document.createElement('iframe'); frame.sandbox='allow-scripts';
        frame.style='width:100vw;height:100vh;border:0';
        addEventListener('message', e => {if(e.source===frame.contentWindow && e.data?.event==='ready')resolve(true);}, {once:true});
        frame.srcdoc=${JSON.stringify(html)};document.body.append(frame);
      })`);
      const frame = window.webContents.mainFrame.frames.find((f) => f.url === 'about:srcdoc');
      assert.ok(frame);
      return frame;
    }
    const command = async (command: string) => {
      await window.webContents.executeJavaScript(
        `document.querySelector('iframe').contentWindow.postMessage({type:'gnosis-explainer-control',token:'motion-test',command:${JSON.stringify(command)}},'*')`
      );
      await wait(30);
    };
    const frame = await load(buildExplainerDocument(artifact, 'motion-test'));
    assert.equal(await frame.executeJavaScript('document.getAnimations().length'), 0, 'opening a diagram starts still');
    const initialX = (await frame.executeJavaScript(
      'document.querySelector("[data-motion-id]").getBoundingClientRect().x'
    )) as number;
    await command('step');
    assert.equal(
      await frame.executeJavaScript('document.getAnimations().length'),
      1,
      'a keyed item moves rather than crossfading the whole scene'
    );
    await frame.executeJavaScript('document.getAnimations()[0].currentTime=150');
    const x = (await frame.executeJavaScript(
      'document.querySelector("[data-motion-id]").getBoundingClientRect().x'
    )) as number;
    assert.ok(x > initialX && x < initialX + 220, 'the item occupies an intermediate position during its transition');
    await command('pause');
    const pausedTime = (await frame.executeJavaScript('document.getAnimations()[0].currentTime')) as number;
    await wait(100);
    assert.equal(
      await frame.executeJavaScript('document.getAnimations()[0].currentTime'),
      pausedTime,
      'Pause freezes the transition'
    );
    await command('play');
    await wait(450);
    await command('pause');
    assert.equal(
      await frame.executeJavaScript('document.getAnimations().length'),
      0,
      'Play resumes and finishes the transition'
    );
    await command('step');
    assert.equal(
      await frame.executeJavaScript('document.querySelectorAll("svg > [aria-hidden=true]").length'),
      1,
      'removed items fade out as noninteractive ghosts'
    );
    assert.equal(
      await frame.executeJavaScript('document.querySelectorAll("[data-motion-id]").length'),
      0,
      'exit ghosts cannot duplicate semantic IDs'
    );
    await wait(300);
    assert.equal(
      await frame.executeJavaScript('document.querySelectorAll("svg > [aria-hidden=true]").length'),
      0,
      'exit ghosts are cleaned up'
    );
    await command('step');
    assert.ok(await frame.executeJavaScript('document.getAnimations().length > 0'), 'new items animate in');
    await command('reset');
    assert.equal(await frame.executeJavaScript('document.getAnimations().length'), 0, 'Reset is immediate');
    assert.equal(
      await frame.executeJavaScript('document.querySelector("[data-motion-id]").getAttribute("transform")'),
      'translate(40, 80)'
    );
    await command('step');
    await command('step');
    await command('reset');
    assert.equal(
      await frame.executeJavaScript('document.querySelectorAll("svg > [aria-hidden=true]").length'),
      0,
      'rapid stepping/reset does not leave ghost elements'
    );
    await command('step');
    await reducedMotion('reduce');
    await wait(50);
    assert.equal(
      await frame.executeJavaScript('document.getAnimations().length'),
      0,
      'enabling reduced motion settles an active transition'
    );
    await command('reset');
    await command('step');
    assert.equal(
      await frame.executeJavaScript('document.getAnimations().length'),
      0,
      'reduced motion shows the final state immediately'
    );
    assert.equal(
      await frame.executeJavaScript('document.querySelector("[data-motion-id]").getAttribute("transform")'),
      'translate(260, 80)'
    );
    await reducedMotion('no-preference');
    const legacy = await load(buildExplainerDocument(explainer, 'motion-test'));
    await command('step');
    assert.ok(
      await legacy.executeJavaScript('document.querySelector("svg").getAnimations().length > 0'),
      'saved unkeyed diagrams get a gentle change transition'
    );
    assert.equal(await legacy.executeJavaScript('document.getElementById("state").textContent'), '2 items waiting');
  } finally {
    window.destroy();
  }
}
