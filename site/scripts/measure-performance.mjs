import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers/promises';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-site-perf-')));
const output = process.env.GNOSIS_PERF_OUTPUT ?? '/tmp/gnosis-site-performance.json';
const runs = [];
app
  .whenReady()
  .then(async () => {
    console.log('Measuring production site performance.');
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.log('Renderer: ' + event.message);
    });
    const cdp = (method, args = {}) => win.webContents.debugger.sendCommand(method, args);
    try {
      await win.loadURL('about:blank');
      win.webContents.debugger.attach('1.3');
      await cdp('Network.enable');
      await cdp('Network.setCacheDisabled', { cacheDisabled: true });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*.aptabase.com/*'] }, (_request, callback) =>
        callback({ cancel: true })
      );
      const observe = `
    window.sitePerf={lcp:0,cls:0,longTasks:[],events:[]};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())window.sitePerf.lcp=entry.startTime}).observe({type:'largest-contentful-paint',buffered:true});
    new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput)window.sitePerf.cls+=entry.value}).observe({type:'layout-shift',buffered:true});
    new PerformanceObserver(list=>{window.sitePerf.longTasks.push(...list.getEntries().map(entry=>entry.duration))}).observe({type:'longtask',buffered:true});
    new PerformanceObserver(list=>{window.sitePerf.events.push(...list.getEntries().filter(entry=>entry.interactionId).map(entry=>entry.duration))}).observe({type:'event',buffered:true,durationThreshold:16});
  `;
      for (const profile of [
        { name: 'desktop', width: 1280, height: 800, rate: 1, throttled: false },
        { name: 'mobile-slow', width: 390, height: 844, rate: 4, throttled: true },
      ]) {
        console.log('Profile ' + profile.name);
        win.setContentSize(profile.width, profile.height);
        await cdp('Emulation.setCPUThrottlingRate', { rate: profile.rate });
        await cdp('Network.emulateNetworkConditions', {
          offline: false,
          latency: profile.throttled ? 150 : 0,
          downloadThroughput: profile.throttled ? 200000 : -1,
          uploadThroughput: profile.throttled ? 93750 : -1,
          connectionType: profile.throttled ? 'cellular4g' : 'ethernet',
        });
        for (let attempt = 1; attempt <= 3; attempt++) {
          await win.webContents.session.clearCache();
          await win.loadURL(process.env.GNOSIS_SITE_URL + '/');
          await js(observe);
          await setTimeout(3500);
          const initial = await js(
            `({ ...window.sitePerf, fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, resources:performance.getEntriesByType('resource').map(e=>({url:new URL(e.name).pathname,bytes:e.encodedBodySize,type:e.initiatorType,duration:e.duration})), documentBytes:performance.getEntriesByType('navigation')[0].encodedBodySize })`
          );
          // Actual pointer input gives Event Timing entries; programmatic click() does not.
          await js("document.querySelector('[data-next]').scrollIntoView({behavior:'instant',block:'center'})");
          await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
          for (let step = 0; step < 4; step++) {
            const point = await js(
              "(()=>{const r=document.querySelector('[data-next]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
            );
            await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
            await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
            await setTimeout(750);
          }
          await js("document.querySelector('#features').scrollIntoView({behavior:'instant'})");
          await setTimeout(2500);
          const tour = await js(
            "({images:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='img').map(e=>({url:new URL(e.name).pathname,bytes:e.encodedBodySize})),events:window.sitePerf.events,longTasks:window.sitePerf.longTasks})"
          );
          const result = {
            profile: profile.name,
            attempt,
            initial: {
              ...initial,
              bytes: initial.documentBytes + initial.resources.reduce((sum, e) => sum + e.bytes, 0),
            },
            tour,
          };
          runs.push(result);
          console.log(
            JSON.stringify({
              profile: profile.name,
              attempt,
              fcp: Math.round(initial.fcp),
              lcp: Math.round(initial.lcp),
              cls: initial.cls,
              initialBytes: result.initial.bytes,
              tourImages: tour.images.length,
              maxInteraction: Math.max(0, ...tour.events),
            })
          );
        }
      }
      fs.writeFileSync(
        output,
        JSON.stringify(
          {
            environment: {
              browser: process.versions.chrome,
              platform: process.platform,
              device: 'Desktop Electron, mobile viewport simulation',
              network:
                'Mobile: 1.6 Mbps down, 750 Kbps up, 150ms latency; gzip HTML/CSS/JS/SVG/TTF; cold cache; analytics blocked',
              cpu: 'Mobile 4x CPU slowdown',
              note: 'Lab observations, not field Core Web Vitals. Event Timing values below 16ms are not reported.',
            },
            runs,
          },
          null,
          2
        ) + '\n'
      );
      console.log('Performance report: ' + output);
      app.exit(0);
    } catch (error) {
      console.error(error);
      console.log('Failed at ' + win.webContents.getURL());
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
