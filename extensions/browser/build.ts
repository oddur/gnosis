// `npm run build:extension`: bundles the extension and writes
//   dist-extension/chrome/      unpacked Chrome and Edge extension
//   dist-extension/firefox/     unpacked Firefox extension
//   dist-extension/open-in-gnosis-chrome-<version>.zip    upload to the Chrome Web Store and Edge Add-ons
//   dist-extension/open-in-gnosis-firefox-<version>.zip   upload to addons.mozilla.org (AMO)
//   dist-extension/open-in-gnosis-source-<version>.zip    the source AMO asks for, with build steps
// The version is the `version` in package.json. The archives are reproducible: entries are sorted and
// carry a fixed timestamp, so the same source gives byte-identical files.
// Set GNOSIS_SCHEME=gnosis-dev to build a developer variant that opens the dev app.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import { buildManifest, extensionVersion, type TargetBrowser } from './manifest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const outRoot = path.join(repoRoot, 'dist-extension');
const scheme = process.env.GNOSIS_SCHEME ?? 'gnosis';
if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`Invalid GNOSIS_SCHEME: ${scheme}`);

const packageVersion = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string })
  .version;
const { version } = extensionVersion(packageVersion);

/** 1980-01-01 00:00 in MS-DOS date/time format, the earliest a zip can hold. Independent of time zone. */
const FIXED_DOS_TIME = 0x00210000;

const targets: Record<TargetBrowser, { esbuildTarget: string[]; archive: string }> = {
  chrome: { esbuildTarget: ['chrome120'], archive: `open-in-gnosis-chrome-${version}.zip` },
  firefox: { esbuildTarget: ['firefox140'], archive: `open-in-gnosis-firefox-${version}.zip` },
};

/** Files under `dir`, as sorted forward-slash paths relative to it. Skips dotfiles such as .DS_Store. */
function listFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function writeReproducibleZip(archivePath: string, files: Map<string, Buffer>): void {
  const zip = new AdmZip();
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = zip.addFile(name, data, '', 0o644);
    // adm-zip types the header without `timeval`; the setter exists and stores the DOS time as given.
    (entry.header as unknown as { timeval: number }).timeval = FIXED_DOS_TIME;
  }
  zip.writeZip(archivePath);
}

function zipFolder(dir: string, archivePath: string): void {
  writeReproducibleZip(archivePath, new Map(listFiles(dir).map((file) => [file, readFileSync(path.join(dir, file))])));
}

/**
 * The source archive for AMO review. It holds the extension's sources and a minimal package.json with
 * the exact build tool versions, so a reviewer can rebuild without installing the whole Gnosis app.
 */
function writeSourceArchive(archivePath: string): void {
  const files = new Map<string, Buffer>();
  for (const file of listFiles(here)) files.set(`extensions/browser/${file}`, readFileSync(path.join(here, file)));

  const installed = (name: string): string =>
    (JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as { version: string })
      .version;
  const sourcePackage = {
    name: 'open-in-gnosis-extension-source',
    version: packageVersion,
    private: true,
    description: 'Source of the Open in Gnosis browser extension, for store review. See SOURCE-BUILD.md.',
    license: 'MIT',
    scripts: { 'build:extension': 'tsx extensions/browser/build.ts' },
    devDependencies: { 'adm-zip': installed('adm-zip'), esbuild: installed('esbuild'), tsx: installed('tsx') },
  };
  files.set('package.json', Buffer.from(`${JSON.stringify(sourcePackage, null, 2)}\n`));
  files.set('LICENSE', readFileSync(path.join(repoRoot, 'LICENSE')));
  files.set('SOURCE-BUILD.md', readFileSync(path.join(here, 'SOURCE-BUILD.md')));
  writeReproducibleZip(archivePath, files);
}

async function main(): Promise<void> {
  rmSync(outRoot, { recursive: true, force: true });

  for (const [browser, target] of Object.entries(targets) as [TargetBrowser, (typeof targets)[TargetBrowser]][]) {
    const outDir = path.join(outRoot, browser);
    mkdirSync(path.join(outDir, 'icons'), { recursive: true });

    await build({
      entryPoints: {
        content: path.join(here, 'src/content.ts'),
        background: path.join(here, 'src/background.ts'),
      },
      // Fixed, so the path comments in the bundle are the same on every machine.
      absWorkingDir: repoRoot,
      // The TypeScript settings that affect output, given here so the build does not depend on the repo tsconfig.
      tsconfigRaw: { compilerOptions: { strict: true } },
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

    for (const icon of listFiles(path.join(here, 'icons'))) {
      writeFileSync(path.join(outDir, 'icons', icon), readFileSync(path.join(here, 'icons', icon)));
    }
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(buildManifest(browser, packageVersion), null, 2)}\n`
    );

    const archivePath = path.join(outRoot, target.archive);
    zipFolder(outDir, archivePath);
    console.log(`${browser}: ${path.relative(repoRoot, outDir)}/ and ${path.relative(repoRoot, archivePath)}`);
  }

  const sourcePath = path.join(outRoot, `open-in-gnosis-source-${version}.zip`);
  writeSourceArchive(sourcePath);
  console.log(`source: ${path.relative(repoRoot, sourcePath)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
