// `npm run build:extension`: bundles the extension and writes
//   dist-extension/chrome/      unpacked Chrome and Edge extension
//   dist-extension/firefox/     unpacked Firefox extension
//   dist-extension/open-in-gnosis-chrome-<version>.zip
//   dist-extension/open-in-gnosis-firefox-<version>.xpi
// Set GNOSIS_SCHEME=gnosis-dev to build a developer variant that opens the dev app.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import { buildManifest, EXTENSION_VERSION, type TargetBrowser } from './manifest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const outRoot = path.join(repoRoot, 'dist-extension');
const scheme = process.env.GNOSIS_SCHEME ?? 'gnosis';
if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`Invalid GNOSIS_SCHEME: ${scheme}`);

const targets: Record<TargetBrowser, { esbuildTarget: string[]; archive: string }> = {
  chrome: { esbuildTarget: ['chrome120'], archive: `open-in-gnosis-chrome-${EXTENSION_VERSION}.zip` },
  firefox: { esbuildTarget: ['firefox140'], archive: `open-in-gnosis-firefox-${EXTENSION_VERSION}.xpi` },
};

async function main(): Promise<void> {
  rmSync(outRoot, { recursive: true, force: true });

  for (const [browser, target] of Object.entries(targets) as [TargetBrowser, (typeof targets)[TargetBrowser]][]) {
    const outDir = path.join(outRoot, browser);
    mkdirSync(outDir, { recursive: true });

    await build({
      entryPoints: {
        content: path.join(here, 'src/content.ts'),
        background: path.join(here, 'src/background.ts'),
      },
      outdir: outDir,
      bundle: true,
      format: 'iife',
      target: target.esbuildTarget,
      // Readable output keeps store review simple; the scripts are a few KB either way.
      minify: false,
      legalComments: 'none',
      define: { __GNOSIS_SCHEME__: JSON.stringify(scheme) },
      logLevel: 'warning',
    });

    cpSync(path.join(here, 'icons'), path.join(outDir, 'icons'), { recursive: true });
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(buildManifest(browser), null, 2)}\n`);

    const zip = new AdmZip();
    zip.addLocalFolder(outDir);
    const archivePath = path.join(outRoot, target.archive);
    zip.writeZip(archivePath);
    console.log(`${browser}: ${path.relative(repoRoot, outDir)}/ and ${path.relative(repoRoot, archivePath)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
