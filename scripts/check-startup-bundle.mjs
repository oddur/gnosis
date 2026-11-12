// Fails if the renderer's startup bundle contains a library that should load only with a lazy screen.
// The startup bundle is the entry chunk and every chunk it imports statically.
//
//   node scripts/check-startup-bundle.mjs
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { build } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = ['@pierre/diffs', 'shiki', 'react-markdown', '@xyflow'];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-startup-bundle-'));
let startup;

try {
  await build({
    root,
    configFile: path.join(root, 'vite.renderer.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
    plugins: [
      {
        name: 'startup-bundle',
        generateBundle(_options, bundle) {
          const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
          const entry = chunks.find((chunk) => chunk.isEntry);
          if (!entry) throw new Error('The renderer build has no entry chunk.');
          const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
          const seen = new Set();
          const visit = (chunk) => {
            if (seen.has(chunk)) return;
            seen.add(chunk);
            for (const name of chunk.imports) if (byName.has(name)) visit(byName.get(name));
          };
          visit(entry);
          startup = {
            entry: entry.fileName,
            bytes: [...seen].reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
            chunks: [...seen].map((chunk) => chunk.fileName),
            modules: [...seen].flatMap((chunk) => Object.keys(chunk.modules)),
          };
        },
      },
    ],
  });
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

// The innermost package owns the module, including copies nested under another package.
const packageOf = (id) => [...id.replaceAll('\\', '/').matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1)?.[1];
const found = forbidden.filter((name) => startup.modules.some((id) => packageOf(id) === name));
console.log(
  `Startup bundle: ${startup.chunks.length} chunk(s), ${(startup.bytes / 1024).toFixed(0)} KB, entry ${startup.entry}`
);
if (found.length) {
  console.error(`The startup bundle must not contain: ${found.join(', ')}. Load them through a lazy screen.`);
  process.exit(1);
}
console.log(`None of ${forbidden.join(', ')} load at startup.`);
