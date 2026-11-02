import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Run npm run build first.');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, GNOSIS_SITE_URL: `http://127.0.0.1:${server.address().port}`, GNOSIS_SITE_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(electron, [path.join(root, 'scripts/browser-check.mjs')], { env, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 180_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timeout);
  if (code !== 0) process.exitCode = 1;
} finally {
  server.close();
}
