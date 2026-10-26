import { createServer } from 'vite';
import process from 'node:process';
import console from 'node:console';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

// Isolated prototype window. No GitHub credentials, application data or AI calls.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-d2-prototype-'));
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/d2.html${process.argv.includes('--generated') ? '?generated' : ''}`;
const main = path.join(dir, 'main.cjs');
// 'electron' must resolve to Electron's builtin inside the child process.
fs.writeFileSync(
  main,
  `
const {app, BrowserWindow}=require('electron');
app.setPath('userData', ${JSON.stringify(path.join(dir, 'data'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:850,title:'Gnosis — D2/TALA gallery',webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('console-message',(event)=>{if(event.level==='error')console.error(event.message)});
 await win.loadURL(${JSON.stringify(url)});
});
app.on('window-all-closed',()=>app.quit());
`
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`D2/TALA gallery: ${url}`);
const child = spawn(electron, [main, '--remote-debugging-port=9336'], { env, stdio: 'inherit' });
const close = async () => {
  child.kill();
  await server.close();
};
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
child.on('exit', async (code) => {
  await server.close();
  process.exitCode = code ?? 0;
});
