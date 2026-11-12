// Fails if the renderer's startup bundle contains a library that should load only with a lazy screen.
// The startup bundle is the entry chunk and every chunk it imports statically.
// Also prints the size of each lazy chunk with the chunks it imports statically, and fails if the
// review page loads a library that only one of its dialogs uses.
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
// Libraries that must load after the named lazy screen, with the part of it that uses them.
const lazyForbidden = { ReviewPage: ['@xyflow'] };
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-startup-bundle-'));
let startup;
let lazyChunks = [];

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
          // A chunk with every chunk it imports statically: what must load before it can run.
          const closure = (root, loaded = new Set()) => {
            const seen = new Set(loaded);
            const visit = (chunk) => {
              if (seen.has(chunk)) return;
              seen.add(chunk);
              for (const name of chunk.imports) if (byName.has(name)) visit(byName.get(name));
            };
            visit(root);
            const added = [...seen].filter((chunk) => !loaded.has(chunk));
            return {
              entry: root.fileName,
              bytes: added.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0),
              chunks: added,
              modules: added.flatMap((chunk) => Object.keys(chunk.modules)),
            };
          };
          startup = closure(entry);
          startup.chunks = startup.chunks.map((chunk) => chunk.fileName);
          // Only chunks with app code. Library entries such as Shiki grammars and Mermaid diagrams are not screens.
          const loaded = new Set(chunks.filter((chunk) => startup.chunks.includes(chunk.fileName)));
          const app = (id) => !id.startsWith('\0') && !id.includes('node_modules');
          lazyChunks = chunks
            .filter((chunk) => chunk.isDynamicEntry && Object.keys(chunk.modules).some(app))
            .map((chunk) => ({ name: chunk.name, ...closure(chunk, loaded) }))
            .sort((a, b) => b.bytes - a.bytes);
        },
      },
    ],
  });
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

// The innermost package owns the module, including copies nested under another package.
const packageOf = (id) => [...id.replaceAll('\\', '/').matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1)?.[1];
// A bare scope such as `@xyflow` names every package in it.
const within = (id, name) => {
  const owner = packageOf(id);
  return owner === name || (!!owner && name.startsWith('@') && !name.includes('/') && owner.startsWith(`${name}/`));
};
const found = forbidden.filter((name) => startup.modules.some((id) => within(id, name)));
console.log(
  `Startup bundle: ${startup.chunks.length} chunk(s), ${(startup.bytes / 1024).toFixed(0)} KB (${startup.bytes} bytes), entry ${startup.entry}`
);
if (found.length) {
  console.error(`The startup bundle must not contain: ${found.join(', ')}. Load them through a lazy screen.`);
  process.exit(1);
}
console.log(`None of ${forbidden.join(', ')} load at startup.`);
console.log('Lazy app chunks, with the chunks they import statically beyond the startup bundle:');
for (const chunk of lazyChunks)
  console.log(`  ${chunk.name}: ${(chunk.bytes / 1024).toFixed(0)} KB in ${chunk.chunks.length} chunk(s)`);
for (const [name, libraries] of Object.entries(lazyForbidden)) {
  const screen = lazyChunks.find((chunk) => chunk.name === name);
  if (!screen) {
    console.error(`No lazy chunk is named ${name}. Update lazyForbidden in this script.`);
    process.exit(1);
  }
  const loaded = libraries.filter((library) => screen.modules.some((id) => within(id, library)));
  if (loaded.length) {
    console.error(`The ${name} chunk must not load: ${loaded.join(', ')}. Load them where they are used.`);
    process.exit(1);
  }
  console.log(`None of ${libraries.join(', ')} load with ${name}.`);
}
