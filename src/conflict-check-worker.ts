import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { conflictChecker, type CheckRequest, type CheckResponse, type TreeSitterFiles } from './conflict-checks';
import javascriptTags from './assets/tree-sitter/javascript-tags.scm?raw';
import typescriptTags from './assets/tree-sitter/typescript-tags.scm?raw';
import rustTags from './assets/tree-sitter/rust-tags.scm?raw';
import goTags from './assets/tree-sitter/go-tags.scm?raw';
import pythonTags from './assets/tree-sitter/python-tags.scm?raw';
import javaTags from './assets/tree-sitter/java-tags.scm?raw';
import csharpTags from './assets/tree-sitter/csharp-tags.scm?raw';

/**
 * The conflict checks' worker thread (src/conflict-checks.ts). It reads the runtime and grammars the renderer ships
 * (vite.renderer.config.ts keeps their names), and bundles the tag queries as the renderer's syntax worker does.
 */
const port = parentPort;
if (!port) throw new Error('The conflict checks must run in a worker.');
const files = workerData as TreeSitterFiles;
const TAGS: Record<string, string> = {
  javascript: javascriptTags,
  typescript: typescriptTags,
  rust: rustTags,
  go: goTags,
  python: pythonTags,
  java: javaTags,
  csharp: csharpTags,
};
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(files.runtime)),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(files.grammars, `${language}.wasm`))),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
port.on('message', (message: CheckRequest) => {
  const check = conflictChecker(engine, message.disabled);
  check(message.file).then(
    (verdict) => port.postMessage({ id: message.id, verdict } satisfies CheckResponse),
    (error: unknown) =>
      port.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CheckResponse)
  );
});
