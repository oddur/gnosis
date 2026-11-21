import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { TAGS } from '../lib/syntax-tags';
import { conflictChecker, type CheckRequest, type CheckResponse, type TreeSitterFiles } from './conflict-checks';

/**
 * The conflict checks' worker thread (src/conflict-checks.ts). It reads the runtime and grammars the renderer ships
 * (vite.renderer.config.ts keeps their names), and bundles the tag queries as the renderer's syntax worker does.
 */
const port = parentPort;
if (!port) throw new Error('The conflict checks must run in a worker.');
const files = workerData as TreeSitterFiles;
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
