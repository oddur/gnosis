/* global fetch, AbortSignal, setTimeout */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'resources/mergiraf/manifest.json'), 'utf8'));
const platform = process.env.GNOSIS_TARGET_PLATFORM || process.platform;
const arch = process.env.GNOSIS_TARGET_ARCH || process.arch;
const asset = manifest.platforms[`${platform}-${arch}`];
if (!asset) throw Error(`Mergiraf is not available for ${platform}-${arch}.`);
const directory = path.join(root, 'resources/mergiraf/runtime');
await fs.mkdir(directory, { recursive: true });
const binary = path.join(directory, platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
const stamp = `${manifest.version}:${platform}:${arch}:${asset.sha256}`;
if (
  (await fs.readFile(path.join(directory, 'version'), 'utf8').catch(() => '')) === stamp &&
  (await fs.stat(binary).catch(() => false))
)
  process.exit(0);
async function fetchOnce(url, sha) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) {
    const error = Error(`Could not fetch Mergiraf: HTTP ${response.status}`);
    // Client errors other than rate limits will not change on a retry.
    error.permanent = response.status < 500 && response.status !== 429 && response.status !== 408;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) {
    const error = Error('Mergiraf checksum mismatch.');
    error.permanent = true;
    throw error;
  }
  return bytes;
}
// codeberg.org drops connections and returns 5xx often enough to fail CI, so retry with backoff.
async function download(url, sha, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(url, sha);
    } catch (error) {
      if (error.permanent || attempt >= attempts) throw error;
      const delay = 2000 * 2 ** (attempt - 1);
      console.warn(`Mergiraf download failed (${error.cause?.message ?? error.message}); retry ${attempt} of ${attempts - 1} in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
const bytes = await download(
  `https://codeberg.org/mergiraf/mergiraf/releases/download/v${manifest.version}/${asset.name}`,
  asset.sha256
);
const archive = path.join(directory, asset.name);
await fs.writeFile(archive, bytes);
if (asset.name.endsWith('.zip')) {
  const zip = new AdmZip(bytes);
  const entry = zip.getEntries().find((e) => e.entryName === 'mergiraf.exe');
  if (!entry) throw Error('Mergiraf archive has no executable.');
  await fs.writeFile(binary, entry.getData());
} else {
  execFileSync('tar', ['-xzf', archive, '-C', directory, 'mergiraf']);
  await fs.chmod(binary, 0o755);
}
await fs.rm(archive);
await fs.writeFile(
  path.join(directory, 'mergiraf-source.tar.gz'),
  await download(manifest.source.url, manifest.source.sha256)
);
await fs.copyFile(path.join(root, 'resources/mergiraf/COPYING'), path.join(directory, 'COPYING'));
await fs.copyFile(path.join(root, 'resources/mergiraf/NOTICE.md'), path.join(directory, 'NOTICE.md'));
await fs.writeFile(path.join(directory, 'version'), stamp);
console.log(`Prepared Mergiraf ${manifest.version} for ${platform}-${arch}`);
