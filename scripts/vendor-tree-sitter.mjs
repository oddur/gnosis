/* global fetch */
/**
 * Copies the tree-sitter grammars Gnosis bundles (#393) from their official npm packages into src/assets/tree-sitter:
 * the prebuilt `.wasm` each package ships, its `queries/tags.scm` when it has one, and its licence. Run it by hand
 * after changing GRAMMARS; the output is committed, so installs, tests and packaging never reach the network.
 *
 * Each tarball is checked against the registry's `dist.integrity`, and manifest.json records the package, version,
 * integrity and the SHA-256 of every copied file. The grammar packages are not dependencies: their install scripts
 * build native Node bindings that Gnosis does not use.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/tree-sitter');
const licenses = path.join(root, 'public/licenses/tree-sitter');
/** Package, version, and the grammars it ships as [language id, wasm file]. */
const GRAMMARS = [
  {
    name: 'tree-sitter-typescript',
    version: '0.23.2',
    grammars: [
      ['typescript', 'tree-sitter-typescript.wasm'],
      ['tsx', 'tree-sitter-tsx.wasm'],
    ],
  },
  { name: 'tree-sitter-javascript', version: '0.25.0', grammars: [['javascript', 'tree-sitter-javascript.wasm']] },
  { name: 'tree-sitter-rust', version: '0.24.0', grammars: [['rust', 'tree-sitter-rust.wasm']] },
  { name: 'tree-sitter-go', version: '0.25.0', grammars: [['go', 'tree-sitter-go.wasm']] },
  { name: 'tree-sitter-python', version: '0.25.0', grammars: [['python', 'tree-sitter-python.wasm']] },
  { name: 'tree-sitter-java', version: '0.23.5', grammars: [['java', 'tree-sitter-java.wasm']] },
  { name: 'tree-sitter-c-sharp', version: '0.24.0', grammars: [['csharp', 'tree-sitter-c_sharp.wasm']] },
  { name: 'tree-sitter-json', version: '0.24.8', grammars: [['json', 'tree-sitter-json.wasm']] },
  { name: '@tree-sitter-grammars/tree-sitter-yaml', version: '0.7.1', grammars: [['yaml', 'tree-sitter-yaml.wasm']] },
];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-tree-sitter-'));
try {
  await fs.rm(out, { recursive: true, force: true });
  await fs.rm(licenses, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(licenses, { recursive: true });
  const manifest = { generatedBy: 'scripts/vendor-tree-sitter.mjs', packages: [] };
  for (const pkg of GRAMMARS) {
    const meta = await (
      await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/${pkg.version}`)
    ).json();
    const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
    const [algorithm, expected] = meta.dist.integrity.split('-');
    if (crypto.createHash(algorithm).update(tarball).digest('base64') !== expected)
      throw Error(`${pkg.name}: integrity mismatch`);
    const dir = path.join(tmp, pkg.name.replace('/', '__'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.tgz'), tarball);
    execFileSync('tar', ['xzf', 'package.tgz'], { cwd: dir });
    const source = path.join(dir, 'package');
    const license = (await fs.readFile(path.join(source, 'package.json'), 'utf8').then(JSON.parse)).license;
    const files = {};
    for (const [id, file] of pkg.grammars) {
      const bytes = await fs.readFile(path.join(source, file));
      await fs.writeFile(path.join(out, `${id}.wasm`), bytes);
      files[`${id}.wasm`] = { from: file, bytes: bytes.length, sha256: sha256(bytes) };
    }
    const tags = await fs.readFile(path.join(source, 'queries/tags.scm')).catch(() => undefined);
    if (tags) {
      const file = `${pkg.grammars[0][0]}-tags.scm`;
      await fs.writeFile(path.join(out, file), tags);
      files[file] = { from: 'queries/tags.scm', bytes: tags.length, sha256: sha256(tags) };
    }
    const licenseText = await fs.readFile(path.join(source, 'LICENSE'));
    await fs.writeFile(
      path.join(licenses, `${pkg.name.replace('@tree-sitter-grammars/', '')}-LICENSE.txt`),
      licenseText
    );
    manifest.packages.push({
      name: pkg.name,
      version: pkg.version,
      license,
      integrity: meta.dist.integrity,
      repository: meta.repository?.url,
      files,
    });
    console.log(`${pkg.name}@${pkg.version} (${license}): ${Object.keys(files).join(', ')}`);
  }
  // The runtime's own licence, from the installed dependency.
  await fs.copyFile(
    path.join(root, 'node_modules/web-tree-sitter/LICENSE'),
    path.join(licenses, 'web-tree-sitter-LICENSE.txt')
  );
  await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const runtime = JSON.parse(await fs.readFile(path.join(root, 'node_modules/web-tree-sitter/package.json'), 'utf8'));
  await fs.writeFile(
    path.join(licenses, 'SOURCE.txt'),
    [
      'Tree-sitter, for the enclosing function or class of each diff hunk (#393).',
      `web-tree-sitter ${runtime.version} (${runtime.license}): unmodified distribution from https://www.npmjs.com/package/web-tree-sitter/v/${runtime.version}`,
      '',
      'Grammars: the unmodified prebuilt .wasm file and queries/tags.scm of each official npm package.',
      ...manifest.packages.map(
        (pkg) =>
          `${pkg.name} ${pkg.version} (${pkg.license}): https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`
      ),
      '',
      'Each licence is in this directory. Checksums are in src/assets/tree-sitter/manifest.json in https://github.com/oddur/gnosis.',
      '',
    ].join('\n')
  );
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
