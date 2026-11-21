import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { TAGS } from '../lib/syntax-tags';
import type { NoiseRequestMessage, NoiseResponseMessage } from './explanation-noise-client';
import type { TreeSitterFiles } from './conflict-checks';

/**
 * Reduce noise's syntax comparison (lib/explanation-noise.ts) off the main thread: each file's change blocks as
 * whitespace, formatting, comments or code, with the grammars the conflict checks use (src/conflict-check-worker.ts).
 * A file that fails answers null, and its hunks are kept.
 */
const port = parentPort;
if (!port) throw new Error('The noise comparison must run in a worker.');
const files = workerData as TreeSitterFiles;
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(files.runtime)),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(files.grammars, `${language}.wasm`))),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
port.on('message', (message: NoiseRequestMessage) => {
  void (async () => {
    const kinds: NoiseResponseMessage['kinds'] = [];
    for (const file of message.files) {
      try {
        const { blocks } = await engine.noise(file.language, file.after, file.hunks);
        kinds.push(blocks.map((block) => block.kind));
      } catch {
        kinds.push(null);
      }
    }
    port.postMessage({ id: message.id, kinds } satisfies NoiseResponseMessage);
  })();
});
